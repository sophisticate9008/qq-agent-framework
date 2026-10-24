import { randomUUID } from 'node:crypto';

import type { Clock, JsonObject } from '../core/types.ts';
import { FrameworkError, isRecord, reference, snapshot } from '../core/values.ts';
import type { AgentAdapter, DurableStore, SessionBinding, StoredRecord } from './types.ts';

const SESSION_NAMESPACE = 'host.sessions';
const MAX_PAGE_SIZE = 1_000;

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
  resolve(conversationId: string, signal: AbortSignal): Promise<SessionBinding>;
  retire(conversationId: string): SessionMetadata;
  bind(conversationId: string, sessionId: string, generation?: number): SessionBinding;
  list(options?: { limit?: number; after?: string }): readonly SessionMetadata[];
}

export interface SessionRegistryOptions {
  store: DurableStore;
  agent: AgentAdapter;
  clock?: Clock;
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

export function createSessionRegistry(options: SessionRegistryOptions): SessionRegistry {
  if (!options || typeof options !== 'object'
    || !options.store || typeof options.store.read !== 'function' || typeof options.store.write !== 'function'
    || !options.agent || typeof options.agent.createSession !== 'function') {
    fail('SESSION_INVALID_OPTIONS', 'Expected valid session registry options.');
  }
  const { store, agent, clock = Date.now } = options;
  if (typeof clock !== 'function') fail('SESSION_INVALID_OPTIONS', 'Expected a clock function.');
  const inFlight = new Map<string, Promise<SessionBinding>>();

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
    do {
      const records = store.list(SESSION_NAMESPACE, { limit: MAX_PAGE_SIZE, ...(after === undefined ? {} : { after }) });
      for (const record of records) {
        const session = parseSession(record);
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
    return entry?.session.state === 'ready' ? binding(conversationId, entry.session) : null;
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
      store.write(SESSION_NAMESPACE, conversationId, sessionValue(bound), {
        expectedRevision: intent.record.revision
      });
      return binding(conversationId, bound);
    } catch (error: unknown) {
      const latest = readEntry(conversationId);
      if (latest?.session.state === 'ready'
        && latest.session.generation === intent.session.generation) {
        return binding(conversationId, latest.session);
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
      if (current?.session.state === 'ready') return Promise.resolve(binding(conversationId, current.session));
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
        return binding(conversationId, current.session);
      }
      const bound: PersistedSession = {
        state: 'ready',
        generation,
        requestId: current?.session.requestId ?? null,
        sessionId,
        updatedAt: now()
      };
      try {
        store.write(SESSION_NAMESPACE, conversationId, sessionValue(bound), {
          expectedRevision: current?.record.revision ?? null
        });
        return binding(conversationId, bound);
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
    const records = store.list(SESSION_NAMESPACE, listOptions);
    return snapshot(records.map((record) => metadata(record.key, parseSession(record))));
  }

  return { get, resolve, retire, bind, list };
}
