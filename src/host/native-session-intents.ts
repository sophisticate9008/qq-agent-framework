import type { JsonValue } from '../contracts/data.ts';
import type { DurableCasMutation, DurableStore, StoredRecord } from './types.ts';
import { assert, FrameworkError, isRecord } from '../core/values.ts';
import { digest, json } from './data.ts';
import { nativeSessionBindingRevision, validNativeSessionResetTarget, type NativeSessionResetTarget } from './native-session-management.ts';

const INTENTS = 'native-chat.session-intents';
const QUEUE = 'native-chat.session-intent-queue';
const QUEUE_KEY = 'pending';
const MAX_PENDING = 64;
const TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
type IntentState = 'pending' | 'dispatching' | 'confirmed' | 'rejected' | 'conflict' | 'unknown';
interface SessionIntent {
  readonly schema: 1;
  readonly operationId: string;
  readonly fingerprint: string;
  readonly target: NativeSessionResetTarget;
  readonly targetSessionId: string | null;
  readonly ownerId: string;
  readonly state: IntentState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly code?: string;
  readonly result?: JsonValue;
}
export interface NativeSessionIntentReceipt {
  readonly operationId: string;
  readonly status: Exclude<IntentState, 'dispatching'>;
  readonly retry: false;
  readonly code?: string;
  readonly result?: JsonValue;
}
export interface NativeSessionIntentDrainSummary {
  readonly processed: number;
  readonly pending: number;
  readonly confirmed: number;
  readonly rejected: number;
  readonly conflicts: number;
  readonly unknown: number;
}
export interface NativeSessionIntentOptions {
  readonly store: DurableStore;
  readonly currentOwner: () => string | null;
  readonly isReady: (key: string) => boolean | Promise<boolean>;
  readonly bind: (target: NativeSessionResetTarget, targetSessionId: string, signal: AbortSignal) => unknown | Promise<unknown>;
  readonly unbind: (target: NativeSessionResetTarget) => unknown | Promise<unknown>;
  readonly signal?: AbortSignal;
}
function parseIntent(row: StoredRecord): SessionIntent {
  const value = row.value;
  assert(isRecord(value) && value.schema === 1 && value.operationId === row.key && /^[a-f0-9]{64}$/.test(row.key)
    && typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint) && validNativeSessionResetTarget(value.target)
    && (value.targetSessionId === null || typeof value.targetSessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value.targetSessionId))
    && typeof value.ownerId === 'string' && /^[1-9]\d{0,31}$/.test(value.ownerId)
    && ['pending', 'dispatching', 'confirmed', 'rejected', 'conflict', 'unknown'].includes(String(value.state))
    && typeof value.createdAt === 'number' && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && typeof value.updatedAt === 'number' && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0
    && (value.code === undefined || typeof value.code === 'string' && value.code.length <= 256),
  'SESSION_INTENT_INVALID_STATE', 'A persisted session operation is invalid.');
  const intent: SessionIntent = { schema: 1, operationId: row.key, fingerprint: value.fingerprint, target: value.target,
    targetSessionId: value.targetSessionId as string | null, ownerId: value.ownerId, state: value.state as IntentState,
    createdAt: value.createdAt, updatedAt: value.updatedAt, ...(value.code === undefined ? {} : { code: value.code as string }),
    ...(value.result === undefined ? {} : { result: value.result as JsonValue }) };
  assert(intent.operationId === digest([intent.target.key, intent.target.bindingRevision])
    && intent.fingerprint === digest([intent.target, intent.targetSessionId, intent.ownerId]),
  'SESSION_INTENT_INVALID_STATE', 'The persisted session intent identity changed.');
  return intent;
}
function receipt(intent: SessionIntent): NativeSessionIntentReceipt {
  return { operationId: intent.operationId, status: intent.state === 'dispatching' ? 'unknown' : intent.state, retry: false,
    ...(intent.state === 'dispatching' ? { code: 'SESSION_INTENT_ALREADY_DISPATCHED' } : intent.code === undefined ? {} : { code: intent.code }),
    ...(intent.result === undefined ? {} : { result: intent.result }) };
}

/** Owner-authenticated requests wait for the originating QQ turn to finish. No QQ messages are sent here. */
export function createNativeSessionIntents(options: NativeSessionIntentOptions) {
  const { store } = options;
  assert(store.compareAndSetBatch, 'SESSION_INTENT_STORAGE_UNAVAILABLE', 'Session intent scheduling requires atomic storage.');
  const compareAndSet = store.compareAndSetBatch.bind(store);
  let draining: Promise<NativeSessionIntentDrainSummary> | null = null;
  function queue() {
    const row = store.read(QUEUE, QUEUE_KEY);
    if (!row) return { row, ids: [] as string[] };
    assert(isRecord(row.value) && row.value.schema === 1 && Array.isArray(row.value.ids) && row.value.ids.length <= MAX_PENDING
      && row.value.ids.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))
      && new Set(row.value.ids).size === row.value.ids.length, 'SESSION_INTENT_INVALID_STATE', 'The session intent queue is invalid.');
    return { row, ids: row.value.ids as string[] };
  }
  function current(target: NativeSessionResetTarget): StoredRecord | null {
    const row = store.read('host.sessions', target.key);
    if (!row || !isRecord(row.value) || row.value.state !== 'ready' || row.value.sessionId !== target.sessionId
      || row.value.generation !== target.generation) return null;
    try { return nativeSessionBindingRevision({ ...row.value, conversationId: target.key }) === target.bindingRevision ? row : null; }
    catch { return null; }
  }
  function finish(row: StoredRecord, state: Exclude<IntentState, 'dispatching'>, code?: string, result?: JsonValue): void {
    const intent = parseIntent(row), index = queue();
    const { code: _previousCode, result: _previousResult, ...base } = intent;
    const next: SessionIntent = { ...base, state, updatedAt: Date.now(), ...(code === undefined ? {} : { code }),
      ...(result === undefined ? {} : { result }) };
    const terminal = state !== 'pending' && state !== 'unknown';
    compareAndSet([
      { kind: 'write', namespace: INTENTS, key: row.key, expectedRevision: row.revision, value: json(next),
        ...(terminal ? { expiresAt: Date.now() + TERMINAL_TTL_MS } : {}) },
      { kind: 'write', namespace: QUEUE, key: QUEUE_KEY, expectedRevision: index.row?.revision ?? null,
        value: { schema: 1, ids: state === 'pending' ? index.ids : index.ids.filter(id => id !== row.key) } },
    ]);
  }
  async function runDrain(signal: AbortSignal): Promise<NativeSessionIntentDrainSummary> {
    const active = AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]);
    const totals = { processed: 0, pending: 0, confirmed: 0, rejected: 0, conflicts: 0, unknown: 0 };
    for (const id of queue().ids) {
      active.throwIfAborted();
      const row = store.read(INTENTS, id);
      assert(row, 'SESSION_INTENT_INVALID_STATE', 'A queued session operation is missing.');
      const intent = parseIntent(row);
      if (intent.state !== 'pending') {
        // A process could stop after the binding CAS but before the receipt CAS. Never replay it.
        if (intent.state === 'dispatching') { finish(row, 'unknown', 'SESSION_INTENT_INTERRUPTED'); totals.unknown++; }
        else finish(row, intent.state, intent.code, intent.result);
        continue;
      }
      if (options.currentOwner() !== intent.ownerId) {
        finish(row, 'rejected', 'SESSION_INTENT_OWNER_CHANGED'); totals.rejected++; continue;
      }
      if (!current(intent.target)) { finish(row, 'conflict', 'SESSION_MANAGEMENT_CONFLICT'); totals.conflicts++; continue; }
      if (!await options.isReady(intent.target.key)) continue;
      active.throwIfAborted();
      if (options.currentOwner() !== intent.ownerId) {
        finish(row, 'rejected', 'SESSION_INTENT_OWNER_CHANGED'); totals.rejected++; continue;
      }
      const source = current(intent.target);
      if (!source) { finish(row, 'conflict', 'SESSION_MANAGEMENT_CONFLICT'); totals.conflicts++; continue; }
      const claimed: SessionIntent = { ...intent, state: 'dispatching', updatedAt: Date.now() };
      const mutations: DurableCasMutation[] = [
        { kind: 'check', namespace: 'host.sessions', key: intent.target.key, expectedRevision: source.revision },
        { kind: 'write', namespace: INTENTS, key: id, expectedRevision: row.revision, value: json(claimed) },
      ];
      let dispatch: StoredRecord;
      try {
        const saved = compareAndSet(mutations)[1];
        assert(saved, 'SESSION_INTENT_STORAGE_UNAVAILABLE', 'Session dispatch evidence was not saved.');
        dispatch = saved;
      } catch (error) {
        if (error instanceof FrameworkError && error.code === 'STORE_CONFLICT') continue;
        throw error;
      }
      totals.processed++;
      let state: 'confirmed' | 'rejected' | 'conflict' | 'unknown' | 'pending' = 'unknown';
      let code: string | undefined;
      let result: JsonValue | undefined;
      try {
        active.throwIfAborted();
        const value: unknown = intent.targetSessionId === null ? await options.unbind(intent.target)
          : await options.bind(intent.target, intent.targetSessionId, active);
        result = json(value);
        if (Buffer.byteLength(JSON.stringify(result)) > 65536) result = { resultOmitted: true };
        if (isRecord(value) && (value.ok === true || value.status === 'confirmed')) state = 'confirmed';
        else if (isRecord(value) && value.status === 'rejected') state = 'rejected';
        else code = 'SESSION_INTENT_RESULT_UNKNOWN';
      } catch (error) {
        code = error instanceof FrameworkError ? error.code.slice(0, 256) : 'SESSION_INTENT_RESULT_UNKNOWN';
        if (['SESSION_MANAGEMENT_BUSY', 'SESSION_MANAGEMENT_EXECUTION_UNSETTLED', 'SESSION_MANAGEMENT_NOT_RUNNING'].includes(code)
          && current(intent.target)) {
          // The unchanged original CAS proves no binding mutation happened. A readiness race can wait again.
          state = 'pending';
        } else if (['SESSION_MANAGEMENT_CONFLICT', 'STORE_CONFLICT', 'PLUGIN_MODEL_BINDING_CONFLICT'].includes(code)) state = 'conflict';
        else if (['SESSION_MANAGEMENT_INVALID_TARGET', 'SESSION_MANAGEMENT_TARGET_OCCUPIED', 'SESSION_MANAGEMENT_TARGET_OWNED',
          'SESSION_MANAGEMENT_TARGET_NOT_FOUND', 'SESSION_MANAGEMENT_GENERATION_EXHAUSTED'].includes(code)) state = 'rejected';
      }
      finish(dispatch, state, code, result);
      if (state === 'confirmed') totals.confirmed++;
      else if (state === 'rejected') totals.rejected++;
      else if (state === 'conflict') totals.conflicts++;
      else if (state === 'unknown') totals.unknown++;
    }
    totals.pending = queue().ids.length;
    return totals;
  }
  return Object.freeze({
    schedule(input: { readonly target: NativeSessionResetTarget; readonly targetSessionId?: string; readonly ownerId: string }): NativeSessionIntentReceipt {
      options.signal?.throwIfAborted();
      assert(validNativeSessionResetTarget(input.target) && typeof input.ownerId === 'string' && /^[1-9]\d{0,31}$/.test(input.ownerId)
        && (input.targetSessionId === undefined || typeof input.targetSessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(input.targetSessionId)),
      'SESSION_MANAGEMENT_INVALID_TARGET', 'Deferred session management requires an authenticated owner and exact target.');
      assert(options.currentOwner() === input.ownerId, 'SESSION_INTENT_OWNER_CHANGED', 'The configured owner changed.');
      const operationId = digest([input.target.key, input.target.bindingRevision]);
      const fingerprint = digest([input.target, input.targetSessionId ?? null, input.ownerId]);
      const previous = store.read(INTENTS, operationId);
      if (previous) {
        const intent = parseIntent(previous);
        assert(intent.fingerprint === fingerprint, 'SESSION_INTENT_CONFLICT', 'A pending operation for this binding has different parameters.');
        return receipt(intent);
      }
      const source = current(input.target), index = queue();
      assert(source, 'SESSION_MANAGEMENT_CONFLICT', 'The selected QQ binding changed.');
      assert(index.ids.length < MAX_PENDING, 'SESSION_INTENT_CAPACITY', 'The deferred session queue is full.');
      const at = Date.now();
      const intent: SessionIntent = { schema: 1, operationId, fingerprint, target: input.target,
        targetSessionId: input.targetSessionId ?? null, ownerId: input.ownerId, state: 'pending', createdAt: at, updatedAt: at };
      compareAndSet([
        { kind: 'check', namespace: 'host.sessions', key: input.target.key, expectedRevision: source.revision },
        { kind: 'write', namespace: INTENTS, key: operationId, expectedRevision: null, value: json(intent) },
        { kind: 'write', namespace: QUEUE, key: QUEUE_KEY, expectedRevision: index.row?.revision ?? null,
          value: { schema: 1, ids: [...index.ids, operationId] } },
      ]);
      return receipt(intent);
    },
    drain(signal: AbortSignal): Promise<NativeSessionIntentDrainSummary> {
      if (draining) return draining;
      const task = runDrain(signal);
      draining = task;
      void task.finally(() => { if (draining === task) draining = null; }).catch(() => {});
      return task;
    },
    read(operationId: string): NativeSessionIntentReceipt | null {
      assert(/^[a-f0-9]{64}$/.test(operationId), 'SESSION_INTENT_INVALID_ID', 'A concrete operation ID is required.');
      const row = store.read(INTENTS, operationId);
      return row ? receipt(parseIntent(row)) : null;
    },
  });
}
export type NativeSessionIntents = ReturnType<typeof createNativeSessionIntents>;
