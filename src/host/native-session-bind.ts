import { FrameworkError, assert, isRecord } from '../core/values.ts';
import type { DurableCasMutation, DurableStore, StoredRecord } from './types.ts';
import { digest, json } from './data.ts';
import { assertNativeSessionIdle } from './native-session-actions.ts';
import { nativeSessionBindingRevision, validNativeSessionResetTarget, type NativeSessionResetTarget } from './native-session-management.ts';

export interface NativeSessionBindResult {
  readonly ok: true;
  readonly key: string;
  readonly previousSessionId: string;
  readonly previousGeneration: number;
  readonly sessionId: string;
  readonly generation: number;
  readonly nextGeneration: number;
  readonly bindingRevision: string;
  readonly bindingChanged: boolean;
  readonly historyPreserved: true;
  readonly contextReset: false;
}
function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
}
function ownerMatches(record: StoredRecord | null, conversationId: string, generation?: number): boolean {
  return record === null || isRecord(record.value) && record.value.schema === 1 && record.value.conversationId === conversationId
    && typeof record.value.generation === 'number' && Number.isSafeInteger(record.value.generation) && record.value.generation > 0
    && (generation === undefined || record.value.generation === generation);
}
function* boundedRecords(store: DurableStore, namespace: string): Generator<StoredRecord> {
  let after: string | undefined;
  let count = 0;
  for (;;) {
    const page = store.list(namespace, { limit: 1000, ...(after === undefined ? {} : { after }) });
    for (const row of page) {
      assert(++count <= 100_000, 'SESSION_MANAGEMENT_SCAN_LIMIT', 'Session management exceeded its record bound.');
      yield row;
    }
    if (page.length < 1000) return;
    const next = page.at(-1)!.key;
    assert(after === undefined || next > after, 'SESSION_MANAGEMENT_STORAGE_UNAVAILABLE', 'Session management pagination did not advance.');
    after = next;
  }
}
function assertTargetExecutionsSettled(store: DurableStore, sessionId: string): void {
  for (const row of boundedRecords(store, 'host.executions')) {
    const value = row.value;
    if (!isRecord(value) || !isRecord(value.binding) || value.binding.sessionId !== sessionId) continue;
    const settled = ['completed', 'failed', 'rejected', 'timed-out'].includes(String(value.status))
      || value.status === 'unknown' && ['completed', 'failed', 'rejected', 'cancelled'].includes(String(value.externalStatus));
    assert(value.isolated === false && settled
      && ['completed', 'failed', 'rejected', 'cancelled', 'not-started'].includes(String(value.externalStatus))
      && !['requesting', 'accepted', 'unknown'].includes(String(value.cancelStatus))
      && !['sending', 'unknown'].includes(String(value.noticeStatus)),
    'SESSION_MANAGEMENT_EXECUTION_UNSETTLED', 'The target session still has unfinished execution evidence.');
  }
}

/**
 * Synchronous storage transition. The caller first verifies the concrete backend session exists
 * and holds source/target model-session leases; no external operation runs inside this CAS.
 */
export function switchNativeSessionBinding(options: {
  readonly store: DurableStore;
  readonly target: NativeSessionResetTarget;
  readonly targetSessionId: string;
}): NativeSessionBindResult {
  const { store, target, targetSessionId } = options;
  assert(validNativeSessionResetTarget(target) && validSessionId(targetSessionId),
    'SESSION_MANAGEMENT_INVALID_TARGET', 'A current QQ binding and concrete target session are required.');
  assert(store.compareAndSetBatch, 'SESSION_MANAGEMENT_STORAGE_UNAVAILABLE', 'Atomic storage is required.');
  const mutations = new Map<string, DurableCasMutation>();
  const add = (mutation: DurableCasMutation) => mutations.set(JSON.stringify([mutation.namespace, mutation.key]), mutation);
  const check = (namespace: string, key: string): StoredRecord | null => {
    const row = store.read(namespace, key);
    add({ kind: 'check', namespace, key, expectedRevision: row?.revision ?? null });
    return row;
  };
  // Pin the durable dispatch gates through the atomic binding replacement.
  for (const namespace of ['host.execution-conversations', 'native-chat.inbox', 'host.replies']) check(namespace, digest(target.key));
  for (const sessionId of new Set([target.sessionId, targetSessionId])) {
    const execution = check('plugin-model.executions', sessionId);
    assert(!execution || isRecord(execution.value) && ['completed', 'failed', 'rejected'].includes(String(execution.value.state)),
      'SESSION_MANAGEMENT_EXECUTION_UNSETTLED', 'A plugin is using this model session or its execution remains unknown.');
  }
  assertNativeSessionIdle(store, target);
  const previous = store.read('host.sessions', target.key);
  assert(previous && isRecord(previous.value) && previous.value.state === 'ready'
    && previous.value.sessionId === target.sessionId && previous.value.generation === target.generation
    && nativeSessionBindingRevision({ ...previous.value, conversationId: target.key }) === target.bindingRevision,
  'SESSION_MANAGEMENT_CONFLICT', 'Source session binding changed.');
  const previousOwner = store.read('host.session-ids', target.sessionId);
  assert(ownerMatches(previousOwner, target.key, target.generation),
    'SESSION_MANAGEMENT_CONFLICT', 'Source session ownership changed.');
  const selectedOwner = targetSessionId === target.sessionId ? previousOwner : store.read('host.session-ids', targetSessionId);
  for (const row of boundedRecords(store, 'host.sessions')) {
    if (row.key === target.key || !isRecord(row.value) || row.value.sessionId !== targetSessionId) continue;
    assert(row.value.state === 'retired', 'SESSION_MANAGEMENT_TARGET_OCCUPIED', 'The target session is already attached to another QQ conversation.');
  }
  assert(ownerMatches(selectedOwner, target.key), 'SESSION_MANAGEMENT_TARGET_OWNED', 'The target session belongs to another QQ conversation.');
  if (selectedOwner && isRecord(selectedOwner.value)) assert(Number(selectedOwner.value.generation) <= target.generation,
    'SESSION_MANAGEMENT_CONFLICT', 'Target session ownership has an unexpected generation.');
  assertTargetExecutionsSettled(store, targetSessionId);
  const changed = targetSessionId !== target.sessionId;
  const generation = target.generation + (changed ? 1 : 0);
  assert(Number.isSafeInteger(generation), 'SESSION_MANAGEMENT_GENERATION_EXHAUSTED', 'Session generation is exhausted.');
  const at = changed ? Date.now() : Number(isRecord(previous.value) ? previous.value.updatedAt : 0);
  const binding = changed ? { schema: 1, state: 'ready', generation, requestId: null, sessionId: targetSessionId, updatedAt: at }
    : previous.value;
  if (changed) {
    const archiveId = digest([target.key, target.sessionId, target.generation, previous.revision]);
    add({ kind: 'write', namespace: 'host.session-archives', key: archiveId, expectedRevision: null,
      value: json({ schema: 1, conversationId: target.key, sessionId: target.sessionId, generation: target.generation,
        resetAt: at, previousRevision: previous.revision, previous: previous.value, reason: 'binding-switched', targetSessionId }) });
    add({ kind: 'write', namespace: 'host.sessions', key: target.key, expectedRevision: previous.revision, value: json(binding) });
    const history = check('history', digest(target.key));
    if (history) {
      assert(isRecord(history.value) && typeof history.value.sequence === 'number' && Number.isSafeInteger(history.value.sequence)
        && history.value.sequence >= 0 && typeof history.value.readThrough === 'number' && Number.isSafeInteger(history.value.readThrough)
        && history.value.readThrough >= 0 && history.value.readThrough <= history.value.sequence,
      'SESSION_MANAGEMENT_STORAGE_UNAVAILABLE', 'The retained history cursor is invalid.');
      add({ kind: 'write', namespace: 'history', key: history.key, expectedRevision: history.revision,
        value: json({ ...history.value, readThrough: history.value.sequence }) });
    }
  } else add({ kind: 'check', namespace: 'host.sessions', key: target.key, expectedRevision: previous.revision });
  if (previousOwner) add({ kind: 'check', namespace: 'host.session-ids', key: target.sessionId, expectedRevision: previousOwner.revision });
  else add({ kind: 'write', namespace: 'host.session-ids', key: target.sessionId, expectedRevision: null,
    value: { schema: 1, conversationId: target.key, generation: target.generation } });
  if (changed) add({ kind: 'write', namespace: 'host.session-ids', key: targetSessionId, expectedRevision: selectedOwner?.revision ?? null,
    value: { schema: 1, conversationId: target.key, generation } });
  const bindingRevision = nativeSessionBindingRevision({ ...(isRecord(binding) ? binding : {}), conversationId: target.key });
  try { store.compareAndSetBatch([...mutations.values()]); }
  catch (error) {
    if (error instanceof FrameworkError && ['STORE_CONFLICT', 'STORE_INDEX_CONFLICT', 'SESSION_ID_CONFLICT'].includes(error.code))
      throw new FrameworkError('SESSION_MANAGEMENT_CONFLICT', 'Session bindings changed before the atomic replacement.');
    throw error;
  }
  return { ok: true, key: target.key, previousSessionId: target.sessionId, previousGeneration: target.generation,
    sessionId: targetSessionId, generation, nextGeneration: generation, bindingRevision, bindingChanged: changed,
    historyPreserved: true, contextReset: false };
}
