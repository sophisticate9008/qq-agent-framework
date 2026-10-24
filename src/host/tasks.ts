import { setImmediate as nextTurn } from 'node:timers/promises';
import { assert, errorCode, identifier, reference, snapshot } from '../core/values.ts';
import type { Clock, JsonObject } from '../core/types.ts';
import type { DurableStore, StoredRecord } from './types.ts';
import { json, object } from './data.ts';
import { withDeadline } from './deadlines.ts';

export interface TaskInput {
  id: string;
  kind: string;
  scope: string;
  payload: JsonObject;
  dueAt: number;
  expiresAt?: number | null;
  maxAttempts?: number;
}
export interface TaskExecution { id: string; scope: string; payload: JsonObject; signal: AbortSignal }
export type TaskHandler = (task: TaskExecution) => void | Promise<void>;
export type TaskStatus = 'waiting' | 'running' | 'completed' | 'failed' | 'unknown' | 'cancelled' | 'expired';
export interface TaskMetadata {
  cursor: string;
  id: string;
  kind: string;
  scope: string;
  dueAt: number;
  expiresAt: number | null;
  attempts: number;
  maxAttempts: number;
  status: TaskStatus;
  errorCode: string | null;
}
const namespace = 'tasks';
const pendingNamespace = 'tasks.pending';
const indexNamespace = 'tasks.meta';
const indexKey = 'pending-index';

function task(record: StoredRecord) {
  const value = object(record.value);
  assert(reference(value.id) && identifier(value.kind) && reference(value.scope) && Number.isFinite(value.dueAt)
    && Number.isSafeInteger(value.attempts) && Number(value.attempts) >= 0
    && Number.isSafeInteger(value.maxAttempts) && Number(value.maxAttempts) >= 1 && Number(value.maxAttempts) <= 10
    && Number(value.attempts) <= Number(value.maxAttempts)
    && (value.expiresAt === null || typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt))
    && ['waiting', 'running', 'completed', 'failed', 'unknown', 'cancelled', 'expired'].includes(String(value.status)),
  'INVALID_STORED_DATA', 'Stored task data is invalid.');
  object(value.payload);
  return value;
}

export function createTaskQueue({ store, clock = Date.now, maxScan = 1000, handlerTimeoutMs = 30000 }:
  { store: DurableStore; clock?: Clock; maxScan?: number; handlerTimeoutMs?: number }) {
  assert(Number.isSafeInteger(maxScan) && maxScan > 0 && maxScan <= 10000, 'INVALID_TASK_OPTIONS', 'A finite scan limit is required.');
  assert(Number.isSafeInteger(handlerTimeoutMs) && handlerTimeoutMs >= 10 && handlerTimeoutMs <= 300000,
    'INVALID_TASK_OPTIONS', 'A finite task handler deadline is required.');
  const handlers = new Map<string, TaskHandler>();
  const active = new Map<string, AbortController>();
  let stopped = false;
  let cursor: string | undefined;
  let running: Promise<{ scanned: number; executed: number }> | null = null;

  function editable() { assert(!stopped, 'TASK_QUEUE_STOPPED', 'The task queue is stopped.'); }
  function pending(status: unknown) { return status === 'waiting' || status === 'running'; }
  function ensurePending(id: string) {
    if (store.read(pendingNamespace, id)) return;
    try { store.write(pendingNamespace, id, { id }, { expectedRevision: null }); }
    catch (error) {
      if (errorCode(error) !== 'STORE_CONFLICT' || !store.read(pendingNamespace, id)) throw error;
    }
  }
  function removePending(id: string) {
    const indexed = store.read(pendingNamespace, id);
    if (!indexed) return;
    try { store.delete(pendingNamespace, id, indexed.revision); }
    catch (error) { if (errorCode(error) !== 'STORE_CONFLICT') throw error; }
  }
  function prunePending(id: string) {
    const current = store.read(namespace, id);
    if (!current || !pending(task(current).status)) removePending(id);
  }
  function update(record: StoredRecord, changes: JsonObject) {
    const updated = store.write(namespace, record.key, json({ ...task(record), ...changes }), { expectedRevision: record.revision });
    if (!pending(task(updated).status)) removePending(record.key);
    return updated;
  }
  function repairPage(limit: number, after: string | undefined, interrupt: boolean) {
    const options = after === undefined ? { limit } : { limit, after };
    const tasks = store.list(namespace, options);
    const indexed = store.list(pendingNamespace, options);
    const entries = new Map(tasks.map(record => [record.key, record]));
    const keys = [...new Set([...entries.keys(), ...indexed.map(record => record.key)])]
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).slice(0, limit);
    let recovered = 0;
    for (const key of keys) {
      const record = entries.get(key) ?? store.read(namespace, key);
      if (!record) { removePending(key); continue; }
      const value = task(record);
      if (!pending(value.status)) { removePending(key); continue; }
      ensurePending(key);
      if (interrupt && value.status === 'running' && !active.has(key)) {
        try { update(record, { status: 'unknown', errorCode: 'TASK_INTERRUPTED' }); recovered++; }
        catch (error) { if (errorCode(error) !== 'STORE_CONFLICT') throw error; }
      }
    }
    return { recovered, next: keys.length === limit ? keys.at(-1)! : null };
  }
  function recover() {
    let recovered = 0;
    let after: string | undefined;
    do {
      const page = repairPage(1000, after, true);
      recovered += page.recovered;
      after = page.next ?? undefined;
    } while (after !== undefined);
    return recovered;
  }

  const version = store.read(indexNamespace, indexKey);
  if (!version) {
    let after: string | undefined;
    do {
      const page = repairPage(1000, after, false);
      after = page.next ?? undefined;
    } while (after !== undefined);
    store.write(indexNamespace, indexKey, { version: 1 }, { expectedRevision: null });
  } else {
    assert(object(version.value).version === 1, 'INVALID_STORED_DATA', 'Stored task index version is unsupported.');
  }

  async function run(limit: number) {
    await Promise.resolve();
    let scanned = 0;
    let executed = 0;
    while (!stopped && scanned < maxScan && executed < limit) {
      if (scanned > 0 && scanned % 64 === 0) {
        await nextTurn();
        if (stopped) break;
      }
      const batch = store.list(pendingNamespace, cursor === undefined ? { limit: 1 } : { limit: 1, after: cursor });
      if (!batch.length) { cursor = undefined; break; }
      const indexed = batch[0];
      cursor = indexed.key;
      scanned++;
      const record = store.read(namespace, indexed.key);
      if (!record) { removePending(indexed.key); continue; }
      const value = task(record);
      if (!pending(value.status)) { removePending(record.key); continue; }
      if (value.status !== 'waiting') continue;
      if (typeof value.expiresAt === 'number' && value.expiresAt <= clock()) {
        try { update(record, { status: 'expired' }); }
        catch (error) { if (errorCode(error) !== 'STORE_CONFLICT') throw error; }
        continue;
      }
      if (Number(value.dueAt) > clock()) continue;
      const handler = handlers.get(String(value.kind));
      if (!handler) continue;
      let claimed: StoredRecord;
      try { claimed = update(record, { status: 'running', attempts: Number(value.attempts) + 1 }); }
      catch (error) { if (errorCode(error) !== 'STORE_CONFLICT') throw error; else continue; }
      const controller = new AbortController();
      active.set(record.key, controller);
      executed++;
      let failure: string | null = null;
      const timeoutMs = typeof value.expiresAt === 'number'
        ? Math.max(1, Math.ceil(Math.min(handlerTimeoutMs, value.expiresAt - clock()))) : handlerTimeoutMs;
      try { await withDeadline({ signal: controller.signal, timeoutMs, code: 'TASK_TIMEOUT_UNKNOWN',
        run: signal => handler({ id: String(value.id), scope: String(value.scope), payload: snapshot(object(value.payload)), signal }) }); }
      catch (error) { failure = errorCode(error, 'TASK_FAILED'); }
      finally { active.delete(record.key); }
      try {
        update(claimed, controller.signal.aborted ? { status: 'unknown', errorCode: 'TASK_CANCEL_REQUESTED' }
          : failure ? { status: failure.includes('UNKNOWN') ? 'unknown' : 'failed', errorCode: failure } : { status: 'completed' });
      } catch (error) { if (errorCode(error) !== 'STORE_CONFLICT') throw error; }
    }
    return snapshot({ scanned, executed });
  }

  return Object.freeze({
    register(kind: string, handler: TaskHandler) {
      editable();
      assert(identifier(kind) && typeof handler === 'function' && !handlers.has(kind), 'INVALID_TASK_HANDLER', 'A unique task handler is required.');
      handlers.set(kind, handler);
      return () => { if (handlers.get(kind) === handler) handlers.delete(kind); };
    },
    schedule(input: TaskInput) {
      editable();
      const value = snapshot(input);
      const expiresAt = value.expiresAt ?? null;
      const maxAttempts = value.maxAttempts ?? 1;
      assert(reference(value.id) && identifier(value.kind) && reference(value.scope) && Number.isFinite(value.dueAt)
        && (expiresAt === null || Number.isFinite(expiresAt) && expiresAt > value.dueAt)
        && Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 10,
      'INVALID_TASK', 'A bounded, scoped task is required.');
      object(value.payload);
      assert(Buffer.byteLength(JSON.stringify(value.payload)) <= 64 * 1024, 'INVALID_TASK', 'Task payload is too large.');
      ensurePending(value.id);
      try {
        const stored = store.write(namespace, value.id, json({ ...value, expiresAt, maxAttempts, attempts: 0,
          status: expiresAt !== null && expiresAt <= clock() ? 'expired' : 'waiting' }), { expectedRevision: null });
        if (!pending(task(stored).status)) removePending(value.id);
      } catch (error) { prunePending(value.id); throw error; }
      return value.id;
    },
    runDue({ limit = 16 }: { limit?: number } = {}) {
      editable();
      assert(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'INVALID_TASK_LIMIT', 'A finite execution limit is required.');
      if (running) return running;
      running = run(limit);
      const settled = () => { running = null; };
      running.then(settled, settled);
      return running;
    },
    recover,
    recoverPage({ limit = 100, after }: { limit?: number; after?: string } = {}) {
      assert(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000, 'INVALID_TASK_LIMIT', 'A finite recovery limit is required.');
      return repairPage(limit, after, true);
    },
    cancel(id: string) {
      editable();
      const current = store.read(namespace, id);
      if (!current || !['waiting', 'running'].includes(String(task(current).status))) return false;
      const controller = active.get(id);
      try {
        update(current, controller || task(current).status === 'running' ? { status: 'unknown', errorCode: 'TASK_CANCEL_REQUESTED' }
          : { status: 'cancelled' });
      } finally { controller?.abort(); }
      return true;
    },
    retry(id: string) {
      editable();
      const current = store.read(namespace, id);
      assert(current && task(current).status === 'failed' && Number(task(current).attempts) < Number(task(current).maxAttempts),
        'TASK_RETRY_DENIED', 'Only failed tasks with remaining attempts can be retried.');
      ensurePending(id);
      try { update(current, { status: 'waiting' }); }
      catch (error) { prunePending(id); throw error; }
      cursor = undefined;
    },
    list({ limit = 100, after }: { limit?: number; after?: string } = {}): readonly TaskMetadata[] {
      return snapshot(store.list(namespace, after === undefined ? { limit } : { limit, after }).map(record => {
        const value = task(record);
        return { cursor: record.key, id: String(value.id), kind: String(value.kind), scope: String(value.scope), dueAt: Number(value.dueAt),
          expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : null,
          attempts: Number(value.attempts), maxAttempts: Number(value.maxAttempts), status: value.status as TaskStatus,
          errorCode: typeof value.errorCode === 'string' ? value.errorCode : null };
      }));
    },
    async stop() {
      stopped = true;
      for (const controller of active.values()) controller.abort();
      await running;
    },
  });
}
