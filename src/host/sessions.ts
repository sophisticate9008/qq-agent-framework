import type { AccountScope } from '../contracts/account-scope.ts';
import { normalizeAccountScope } from '../core/account-scope.ts';
import { bindAccountStore } from '../storage/account-scope.ts';
import { randomUUID } from 'node:crypto';

import type { Clock, JsonObject } from '../core/types.ts';
import { FrameworkError, isRecord, reference, snapshot } from '../core/values.ts';
import type { AgentAdapter, DurableStore, SessionBinding, StoredRecord } from './types.ts';

const SESSION_NAMESPACE = 'host.sessions';
const MAX_PAGE_SIZE = 1_000;
const SESSION_IDS = 'host.session-ids';
const sessionIndex = Object.freeze({ namespace: SESSION_NAMESPACE, field: 'sessionId', unique: true,
  where: Object.freeze({ field: 'state', equals: 'ready' }) });

export type SessionState = 'creating' | 'ready' | 'unknown' | 'retired';

export interface SessionMetadata {
  conversationId: string;
  state: SessionState;
  generation: number;
  requestId: string | null;
  sessionId: string | null;
  updatedAt: number;
}

export interface SessionRegistry {
  get(conversationId: string): SessionBinding | null;
  findBySessionId(sessionId: string, generation?: number): SessionBinding | null;
  resolve(conversationId: string, signal: AbortSignal): Promise<SessionBinding>;
  retire(conversationId: string): SessionMetadata;
  bind(conversationId: string, sessionId: string, generation?: number): SessionBinding;
  list(options?: { limit?: number; after?: string }): readonly SessionMetadata[];
}

export interface SessionRegistryOptions {
  accountScope?: AccountScope;
  store: DurableStore;
  agent: AgentAdapter;
  clock?: Clock;
  maxRecoveryRecords?: number;
}

interface PersistedSession {
  state: SessionState;
  generation: number;
  requestId: string | null;
  sessionId: string | null;
  updatedAt: number;
}

interface SessionEntry {
  record: StoredRecord;
  session: PersistedSession;
}

function fail(code: string, message: string): never {
  throw new FrameworkError(code, message);
}

function assertReference(value: string, label: string): void {
  if (!reference(value)) fail('SESSION_INVALID_ARGUMENT', `Expected a valid ${label}.`);
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof FrameworkError && error.code === 'STORE_CONFLICT';
}

function parseSession(record: StoredRecord): PersistedSession {
  const value = record.value;
  if (!isRecord(value)
    || value.schema !== 1
    || !['creating', 'ready', 'unknown', 'retired'].includes(String(value.state))
    || !Number.isSafeInteger(value.generation)
    || typeof value.generation !== 'number'
    || value.generation <= 0
    || !Number.isSafeInteger(value.updatedAt)
    || typeof value.updatedAt !== 'number'
    || (value.requestId !== null && !reference(value.requestId))
    || (value.sessionId !== null && !reference(value.sessionId))) {
    fail('SESSION_DATA_CORRUPT', 'Session registry contains invalid metadata.');
  }
  const state = value.state as SessionState;
  const requestId = value.requestId as string | null;
  const sessionId = value.sessionId as string | null;
  if ((state === 'creating' && (requestId === null || sessionId !== null))
    || (state === 'ready' && sessionId === null)
    || (state === 'unknown' && (requestId === null || sessionId !== null))
    || (state === 'retired' && (requestId !== null || sessionId !== null))) {
    fail('SESSION_DATA_CORRUPT', 'Session registry contains invalid metadata.');
  }
  return { state, generation: value.generation, requestId, sessionId, updatedAt: value.updatedAt };
}

function sessionValue(session: PersistedSession): JsonObject {
  return {
    schema: 1,
    state: session.state,
    generation: session.generation,
    requestId: session.requestId,
    sessionId: session.sessionId,
    updatedAt: session.updatedAt
  };
}

function metadata(conversationId: string, session: PersistedSession): SessionMetadata {
  return snapshot({ conversationId, ...session });
}

function binding(conversationId: string, session: PersistedSession): SessionBinding {
  if (session.state !== 'ready' || session.sessionId === null) {
    fail('SESSION_NOT_BOUND', 'Conversation does not have a bound session.');
  }
  return snapshot({ conversationId, sessionId: session.sessionId, generation: session.generation });
}

export function readSessionMetadata(store: Pick<DurableStore, 'list'>,
  options: { limit?: number; after?: string } = {}): readonly SessionMetadata[] {
  return snapshot(store.list(SESSION_NAMESPACE, options).map(record => metadata(record.key, parseSession(record))));
}

/** Permanent ownership protects retired external IDs from being attached to a new conversation or generation. */
export function reserveSessionId(store: DurableStore, conversationId: string, sessionId: string, generation: number): void {
  assertReference(conversationId, 'conversation id');
  assertReference(sessionId, 'session id');
  if (!Number.isSafeInteger(generation) || generation < 1) fail('SESSION_INVALID_ARGUMENT', 'Expected a valid session generation.');
  for (let attempt = 0; attempt < 4; attempt++) {
    const prior = store.read(SESSION_IDS, sessionId);
    if (prior) {
      if (!isRecord(prior.value) || prior.value.schema !== 1 || !reference(prior.value.conversationId)
        || !Number.isSafeInteger(prior.value.generation) || typeof prior.value.generation !== 'number' || prior.value.generation < 1) {
        fail('SESSION_DATA_CORRUPT', 'Session ID ownership metadata is invalid.');
      }
      if (prior.value.conversationId !== conversationId || prior.value.generation !== generation) {
        fail('SESSION_ID_REUSED', 'An external session ID belongs to another conversation or generation.');
      }
      return;
    }
    try {
      store.write(SESSION_IDS, sessionId, { schema: 1, conversationId, generation }, { expectedRevision: null });
      return;
    } catch (error) { if (!isRevisionConflict(error)) throw error; }
  }
  fail('SESSION_CONFLICT', 'Session ID ownership changed concurrently.');
}

export function createSessionRegistry(options: SessionRegistryOptions): SessionRegistry {
  if (!options || typeof options !== 'object'
    || !options.store || typeof options.store.read !== 'function' || typeof options.store.write !== 'function'
    || !options.agent || typeof options.agent.createSession !== 'function') {
    fail('SESSION_INVALID_OPTIONS', 'Expected valid session registry options.');
  }
  const { store, agent, clock = Date.now } = options;
  const accountScope = options.accountScope === undefined ? undefined : normalizeAccountScope(options.accountScope);
  bindAccountStore(store, accountScope);
  if (typeof clock !== 'function') fail('SESSION_INVALID_OPTIONS', 'Expected a clock function.');
  const inFlight = new Map<string, Promise<SessionBinding>>();
  const reverse = new Map<string, SessionBinding>();
  const indexed = typeof store.createIndex === 'function' && typeof store.lookup === 'function';
  const maxRecoveryRecords = options.maxRecoveryRecords ?? 100_000;
  if (!Number.isSafeInteger(maxRecoveryRecords) || maxRecoveryRecords < 1 || maxRecoveryRecords > 1_000_000) {
    fail('SESSION_INVALID_OPTIONS', 'Session recovery needs a finite record bound.');
  }
  if (indexed) {
    try { store.createIndex!(sessionIndex); }
    catch (error) {
      if (error instanceof FrameworkError && error.code === 'STORE_INDEX_CONFLICT') fail('SESSION_ID_CONFLICT', 'Persisted sessions contain duplicate external IDs.');
      throw error;
    }
  }

  function remember(conversationId: string, session: PersistedSession): SessionBinding {
    const result = snapshot({ ...binding(conversationId, session), ...(accountScope ? { accountScope } : {}) });
    reserveSessionId(store, conversationId, result.sessionId, result.generation);
    if (!indexed) reverse.set(result.sessionId, result);
    return result;
  }

  function now(): number {
    const value = clock();
    if (!Number.isSafeInteger(value)) fail('SESSION_CLOCK_INVALID', 'Session registry clock returned an invalid value.');
    return value;
  }

  function readEntry(conversationId: string): SessionEntry | null {
    const record = store.read(SESSION_NAMESPACE, conversationId);
    return record ? { record, session: parseSession(record) } : null;
  }

  function recoverCreating(): void {
    let after: string | undefined;
    let recovered = 0;
    do {
      const records = store.list(SESSION_NAMESPACE, { limit: MAX_PAGE_SIZE, ...(after === undefined ? {} : { after }) });
      for (const record of records) {
        if (++recovered > maxRecoveryRecords) fail('SESSION_RECOVERY_LIMIT', 'Session recovery exceeded its record bound.');
        const session = parseSession(record);
        if (session.state === 'ready') { remember(record.key, session); continue; }
        if (session.state !== 'creating') continue;
        const unknown: PersistedSession = { ...session, state: 'unknown', updatedAt: now() };
        try {
          store.write(SESSION_NAMESPACE, record.key, sessionValue(unknown), {
            expectedRevision: record.revision
          });
        } catch (error: unknown) {
          if (!isRevisionConflict(error)) throw error;
        }
      }
      after = records.at(-1)?.key;
      if (records.length < MAX_PAGE_SIZE) break;
    } while (after !== undefined);
  }

  recoverCreating();

  function get(conversationId: string): SessionBinding | null {
    assertReference(conversationId, 'conversation id');
    const entry = readEntry(conversationId);
    return entry?.session.state === 'ready' ? remember(conversationId, entry.session) : null;
  }

  function findBySessionId(sessionId: string, generation?: number): SessionBinding | null {
    assertReference(sessionId, 'session id');
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 1)) fail('SESSION_INVALID_ARGUMENT', 'Expected a valid session generation.');
    const candidates = indexed ? store.lookup!({ namespace: SESSION_NAMESPACE, field: 'sessionId', equals: sessionId,
      where: sessionIndex.where, limit: 2 }) : undefined;
    if (candidates && candidates.length > 1) fail('SESSION_ID_CONFLICT', 'An external session ID has multiple active owners.');
    const conversationId = candidates ? candidates[0]?.key : reverse.get(sessionId)?.conversationId;
    if (!conversationId) return null;
    const entry = readEntry(conversationId);
    if (!entry || entry.session.state !== 'ready' || entry.session.sessionId !== sessionId
      || generation !== undefined && entry.session.generation !== generation) return null;
    return remember(conversationId, entry.session);
  }

  function markUnknown(conversationId: string, entry: SessionEntry): void {
    const unknown: PersistedSession = {
      ...entry.session,
      state: 'unknown',
      sessionId: null,
      updatedAt: now()
    };
    try {
      store.write(SESSION_NAMESPACE, conversationId, sessionValue(unknown), {
        expectedRevision: entry.record.revision
      });
    } catch {
    }
  }

  async function createBinding(conversationId: string, intent: SessionEntry,
    signal: AbortSignal): Promise<SessionBinding> {
    let result: unknown;
    let removeAbortListener = (): void => {};
    const aborted = new Promise<never>((resolve, reject) => {
      const onAbort = (): void => reject(new FrameworkError('SESSION_ABORTED', 'Session creation was aborted.'));
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    });
    try {
      result = snapshot(await Promise.race([
        agent.createSession({
          conversationId,
          requestId: intent.session.requestId ?? fail('SESSION_DATA_CORRUPT', 'Session create intent is invalid.'),
          signal
        }),
        aborted
      ]));
    } catch {
      markUnknown(conversationId, intent);
      fail('SESSION_CREATE_UNKNOWN', 'Session creation outcome is unknown and requires reconciliation.');
    } finally {
      removeAbortListener();
    }
    if (!isRecord(result) || !reference(result.sessionId)) {
      markUnknown(conversationId, intent);
      fail('SESSION_CREATE_UNKNOWN', 'Session creation outcome is unknown and requires reconciliation.');
    }
    const bound: PersistedSession = {
      state: 'ready',
      generation: intent.session.generation,
      requestId: intent.session.requestId,
      sessionId: result.sessionId,
      updatedAt: now()
    };
    try {
      reserveSessionId(store, conversationId, bound.sessionId!, bound.generation);
      store.write(SESSION_NAMESPACE, conversationId, sessionValue(bound), {
        expectedRevision: intent.record.revision
      });
      return remember(conversationId, bound);
    } catch (error: unknown) {
      const latest = readEntry(conversationId);
      if (latest?.session.state === 'ready'
        && latest.session.generation === intent.session.generation) {
        return remember(conversationId, latest.session);
      }
      if (isRevisionConflict(error) && latest !== null
        && latest.session.generation !== intent.session.generation) {
        fail('SESSION_BINDING_CHANGED', 'Session binding changed while creation was in progress.');
      }
      markUnknown(conversationId, intent);
      fail('SESSION_CREATE_UNKNOWN', 'Session creation outcome is unknown and requires reconciliation.');
    }
  }

  function resolve(conversationId: string, signal: AbortSignal): Promise<SessionBinding> {
    assertReference(conversationId, 'conversation id');
    if (!signal || typeof signal.aborted !== 'boolean') {
      fail('SESSION_INVALID_ARGUMENT', 'Expected an abort signal.');
    }
    const pending = inFlight.get(conversationId);
    if (pending) return pending;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = readEntry(conversationId);
      if (current?.session.state === 'ready') return Promise.resolve(remember(conversationId, current.session));
      if (current?.session.state === 'unknown') {
        return Promise.reject(new FrameworkError('SESSION_RECONCILIATION_REQUIRED',
          'Session creation requires explicit reconciliation.'));
      }
      if (current?.session.state === 'creating') {
        const unknown: PersistedSession = { ...current.session, state: 'unknown', updatedAt: now() };
        try {
          store.write(SESSION_NAMESPACE, conversationId, sessionValue(unknown), {
            expectedRevision: current.record.revision
          });
          return Promise.reject(new FrameworkError('SESSION_RECONCILIATION_REQUIRED',
            'Session creation requires explicit reconciliation.'));
        } catch (error: unknown) {
          if (isRevisionConflict(error)) continue;
          throw error;
        }
      }
      if (signal.aborted) {
        return Promise.reject(new FrameworkError('SESSION_ABORTED', 'Session resolution was aborted.'));
      }
      const generation = current?.session.generation ?? 1;
      const creating: PersistedSession = {
        state: 'creating',
        generation,
        requestId: randomUUID(),
        sessionId: null,
        updatedAt: now()
      };
      let record: StoredRecord;
      try {
        record = store.write(SESSION_NAMESPACE, conversationId, sessionValue(creating), {
          expectedRevision: current?.record.revision ?? null
        });
      } catch (error: unknown) {
        if (isRevisionConflict(error)) continue;
        throw error;
      }
      const promise = createBinding(conversationId, { record, session: creating }, signal);
      inFlight.set(conversationId, promise);
      promise.then(
        () => { if (inFlight.get(conversationId) === promise) inFlight.delete(conversationId); },
        () => { if (inFlight.get(conversationId) === promise) inFlight.delete(conversationId); }
      );
      return promise;
    }
    return Promise.reject(new FrameworkError('SESSION_CONFLICT', 'Session binding changed concurrently.'));
  }

  function retire(conversationId: string): SessionMetadata {
    assertReference(conversationId, 'conversation id');
    inFlight.delete(conversationId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = readEntry(conversationId);
      const generation = current === null ? 1 : current.session.generation + 1;
      if (!Number.isSafeInteger(generation)) fail('SESSION_GENERATION_EXHAUSTED', 'Session generation limit was reached.');
      const retired: PersistedSession = {
        state: 'retired',
        generation,
        requestId: null,
        sessionId: null,
        updatedAt: now()
      };
      try {
        store.write(SESSION_NAMESPACE, conversationId, sessionValue(retired), {
          expectedRevision: current?.record.revision ?? null
        });
        if (!indexed && current?.session.sessionId) reverse.delete(current.session.sessionId);
        return metadata(conversationId, retired);
      } catch (error: unknown) {
        if (!isRevisionConflict(error)) throw error;
      }
    }
    fail('SESSION_CONFLICT', 'Session binding changed concurrently.');
  }

  function bind(conversationId: string, sessionId: string, expectedGeneration?: number): SessionBinding {
    assertReference(conversationId, 'conversation id');
    assertReference(sessionId, 'session id');
    if (expectedGeneration !== undefined
      && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration <= 0)) {
      fail('SESSION_INVALID_ARGUMENT', 'Expected a valid session generation.');
    }
    inFlight.delete(conversationId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = readEntry(conversationId);
      const generation = current?.session.generation ?? 1;
      if (expectedGeneration !== undefined && generation !== expectedGeneration) {
        fail('SESSION_GENERATION_CONFLICT', 'Session generation does not match.');
      }
      if (current?.session.state === 'ready' && current.session.sessionId === sessionId) {
        return remember(conversationId, current.session);
      }
      if (current?.session.state === 'ready') fail('SESSION_BINDING_CHANGED', 'Retire the current binding before assigning another external session.');
      const bound: PersistedSession = {
        state: 'ready',
        generation,
        requestId: current?.session.requestId ?? null,
        sessionId,
        updatedAt: now()
      };
      try {
        reserveSessionId(store, conversationId, sessionId, generation);
        store.write(SESSION_NAMESPACE, conversationId, sessionValue(bound), {
          expectedRevision: current?.record.revision ?? null
        });
        return remember(conversationId, bound);
      } catch (error: unknown) {
        if (!isRevisionConflict(error)) throw error;
      }
    }
    fail('SESSION_CONFLICT', 'Session binding changed concurrently.');
  }

  function list(listOptions: { limit?: number; after?: string } = {}): readonly SessionMetadata[] {
    if (!listOptions || typeof listOptions !== 'object') {
      fail('SESSION_INVALID_ARGUMENT', 'Expected valid list options.');
    }
    return readSessionMetadata(store, listOptions);
  }

  return { get, findBySessionId, resolve, retire, bind, list };
}
