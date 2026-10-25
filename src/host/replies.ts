import { assert, errorCode, reference, snapshot } from '../core/values.ts';
import type { Clock } from '../core/types.ts';
import type { DurableStore, SessionBinding, StoredRecord } from './types.ts';
import { digest, json, object } from './data.ts';
import { withDeadline } from './deadlines.ts';

export interface ReplyTimeout {
  id: string;
  conversationId: string;
  sessionId: string;
  generation: number;
  requestId: string;
  deadlineAt: number;
}

const namespace = 'host.replies';

function entry(record: StoredRecord): ReplyTimeout {
  const value = object(record.value);
  assert(reference(value.id) && reference(value.conversationId) && reference(value.sessionId) && reference(value.requestId)
    && Number.isSafeInteger(value.generation) && Number(value.generation) > 0 && Number.isFinite(value.deadlineAt)
    && ['waiting', 'responded', 'responded-late', 'timed-out', 'suppressed'].includes(String(value.status)),
  'INVALID_STORED_DATA', 'Stored response deadline is invalid.');
  return snapshot({ id: String(value.id), conversationId: String(value.conversationId), sessionId: String(value.sessionId),
    generation: Number(value.generation), requestId: String(value.requestId), deadlineAt: Number(value.deadlineAt) });
}

export function createReplyWatchdog({ store, timeoutMs = 30000, clock = Date.now, maxPending = 1000, recovery = 'notify', onTimeout, onFault = () => {} }:
  { store: DurableStore; timeoutMs?: number; clock?: Clock; maxPending?: number; recovery?: 'notify' | 'record-only';
    onTimeout(notice: ReplyTimeout, signal: AbortSignal): void | Promise<void>; onFault?(code: string): void }) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 300000
    && Number.isSafeInteger(maxPending) && maxPending > 0 && maxPending <= 10000
    && (recovery === 'notify' || recovery === 'record-only'),
  'INVALID_REPLY_DEADLINE', 'Response deadlines and capacity must be finite.');
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<Promise<void>>();
  const controller = new AbortController();
  let expired = 0;
  const fault = (error: unknown) => { try { onFault(errorCode(error, 'REPLY_WATCHDOG_FAILED')); } catch {} };

  function expire(record: StoredRecord) {
    if (controller.signal.aborted) return false;
    const current = store.read(namespace, record.key);
    if (!current || current.revision !== record.revision || object(current.value).status !== 'waiting') return false;
    store.write(namespace, current.key, json({ ...object(current.value), status: 'timed-out' }), { expectedRevision: current.revision });
    expired++;
    return true;
  }

  function arm(record: StoredRecord, recordOnly = false) {
    const value = entry(record);
    if (controller.signal.aborted || timers.has(record.key) || object(record.value).status !== 'waiting') return;
    if (recordOnly && value.deadlineAt <= clock()) {
      expire(record);
      return;
    }
    assert(timers.size < maxPending, 'REPLY_BACKPRESSURE', 'Too many conversations await a reply.');
    const timer = setTimeout(() => {
      timers.delete(record.key);
      const operation = (async () => {
        if (!expire(record) || recordOnly) return;
        try { onFault('AGENT_REPLY_TIMEOUT'); } catch {}
        await withDeadline({ signal: controller.signal, timeoutMs: 10000, code: 'REPLY_NOTICE_TIMEOUT_UNKNOWN',
          run: signal => onTimeout(value, signal) });
      })().catch(fault);
      running.add(operation);
      void operation.then(() => running.delete(operation));
    }, Math.max(1, Math.ceil(value.deadlineAt - clock())));
    timers.set(record.key, timer);
  }

  return Object.freeze({
    watch(binding: SessionBinding, requestId: string) {
      assert(!controller.signal.aborted && reference(requestId), 'REPLY_WATCHDOG_STOPPED', 'The reply watchdog is unavailable.');
      const key = digest(binding.conversationId);
      const current = store.read(namespace, key);
      if (current && object(current.value).status === 'suppressed' && entry(current).requestId === requestId
        && entry(current).generation === binding.generation && entry(current).sessionId === binding.sessionId) return;
      if (current && object(current.value).status === 'waiting'
        && entry(current).generation === binding.generation && entry(current).sessionId === binding.sessionId) {
        arm(current);
        return;
      }
      assert(timers.size < maxPending || timers.has(key), 'REPLY_BACKPRESSURE', 'Too many conversations await a reply.');
      const previous = timers.get(key);
      if (previous) clearTimeout(previous);
      timers.delete(key);
      const record = store.write(namespace, key, json({ ...binding, requestId, id: digest([binding, requestId]),
        deadlineAt: clock() + timeoutMs, status: 'waiting' }), { expectedRevision: current?.revision ?? null });
      arm(record);
    },
    suppress(binding: SessionBinding, requestId: string) {
      assert(reference(requestId) && !controller.signal.aborted, 'REPLY_WATCHDOG_STOPPED', 'A live response decision is required.');
      const key = digest(binding.conversationId);
      const current = store.read(namespace, key);
      if (current && entry(current).generation > binding.generation) return;
      store.write(namespace, key, json({ ...binding, requestId, id: digest([binding, requestId]),
        deadlineAt: current && entry(current).requestId === requestId ? entry(current).deadlineAt : clock() + timeoutMs,
        status: 'suppressed' }), { expectedRevision: current?.revision ?? null });
      const timer = timers.get(key);
      if (timer) clearTimeout(timer);
      timers.delete(key);
    },
    responded(binding: SessionBinding) {
      const key = digest(binding.conversationId);
      const current = store.read(namespace, key);
      if (!current || !['waiting', 'timed-out'].includes(String(object(current.value).status)) || entry(current).generation !== binding.generation
        || entry(current).sessionId !== binding.sessionId) return;
      store.write(namespace, key, json({ ...object(current.value),
        status: object(current.value).status === 'timed-out' ? 'responded-late' : 'responded' }), { expectedRevision: current.revision });
      const timer = timers.get(key);
      if (timer) clearTimeout(timer);
      timers.delete(key);
    },
    restorePage({ limit = 100, after }: { limit?: number; after?: string } = {}) {
      const batch = store.list(namespace, after === undefined ? { limit } : { limit, after });
      for (const record of batch) arm(record, recovery === 'record-only');
      return { next: batch.length === limit ? batch.at(-1)!.key : null };
    },
    list({ limit = 100, after }: { limit?: number; after?: string } = {}) {
      return snapshot(store.list(namespace, after === undefined ? { limit } : { limit, after }).map(record => ({
        ...entry(record), cursor: record.key,
        status: object(record.value).status as 'waiting' | 'responded' | 'responded-late' | 'timed-out' | 'suppressed', updatedAt: record.updatedAt,
      })));
    },
    get(conversationId: string) {
      assert(reference(conversationId), 'INVALID_CONVERSATION', 'A conversation reference is required.');
      const record = store.read(namespace, digest(conversationId));
      return record ? snapshot({ ...entry(record), status: object(record.value).status as
        'waiting' | 'responded' | 'responded-late' | 'timed-out' | 'suppressed' }) : null;
    },
    metrics() { return snapshot({ pending: timers.size, activeNotices: running.size, expired, timeoutMs, stopped: controller.signal.aborted }); },
    async stop() {
      controller.abort();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled([...running]);
    },
  });
}
