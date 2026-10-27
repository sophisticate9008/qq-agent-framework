import type { NativeInboxSummary } from '../contracts/native-inbox.ts';
import { normalizeContent } from '../core/content.ts';
import { assert, errorCode, isRecord, reference, snapshot } from '../core/values.ts';
import { digest, json, object } from './data.ts';
import type { DurableStore, InboundMessage, StoredRecord } from './types.ts';

export interface NativeInboxEntry {
  readonly message: InboundMessage;
  readonly admittedAt: number;
  readonly deadlineAt: number;
  readonly trigger?: 'private' | 'mention' | 'nickname' | 'reply' | 'continuation';
}
type Outcome = 'accepted' | 'rejected' | 'unknown' | 'expired';
interface Receipt { readonly id: string; readonly outcome: Outcome; readonly requestMessageId: string | null }
interface Queue {
  readonly schema: 1;
  readonly conversationId: string;
  readonly phase: 'pending' | 'dispatching' | 'blocked';
  readonly entries: readonly NativeInboxEntry[];
  readonly receipts: readonly Receipt[];
  readonly errorCode: string | null;
  readonly dispatchingIds?: readonly string[];
}
const namespace = 'native-chat.inbox';

function decode(record: StoredRecord): Queue {
  const value = object(record.value);
  assert(value.schema === 1 && reference(value.conversationId)
    && ['pending', 'dispatching', 'blocked'].includes(String(value.phase))
    && Array.isArray(value.entries) && value.entries.length <= 16
    && Array.isArray(value.receipts) && value.receipts.length <= 64
    && (value.errorCode === null || typeof value.errorCode === 'string'), 'NATIVE_INBOX_CORRUPT', 'Invalid pending input queue.');
  const conversationId = value.conversationId;
  const entries = value.entries.map(item => {
    assert(isRecord(item) && isRecord(item.message) && reference(item.message.id)
      && item.message.conversationId === value.conversationId && reference(item.message.userId)
      && Number.isFinite(item.message.receivedAt) && typeof item.message.directed === 'boolean'
      && typeof item.message.isSelf === 'boolean' && Number.isFinite(item.admittedAt)
      && Number.isFinite(item.deadlineAt) && Number(item.deadlineAt) > Number(item.admittedAt),
    'NATIVE_INBOX_CORRUPT', 'Invalid queued message.');
    assert(item.trigger === undefined || ['private', 'mention', 'nickname', 'reply', 'continuation'].includes(String(item.trigger)),
      'NATIVE_INBOX_CORRUPT', 'Invalid input trigger.');
    return { ...(item.trigger === undefined ? {} : { trigger: item.trigger as NativeInboxEntry['trigger'] }),
      message: { id: item.message.id, conversationId, userId: item.message.userId,
      receivedAt: Number(item.message.receivedAt), directed: item.message.directed, isSelf: item.message.isSelf,
      content: normalizeContent(item.message.content) }, admittedAt: Number(item.admittedAt), deadlineAt: Number(item.deadlineAt) };
  });
  const receipts = value.receipts.map(item => {
    assert(isRecord(item) && reference(item.id) && ['accepted', 'rejected', 'unknown', 'expired'].includes(String(item.outcome))
      && (item.requestMessageId === null || reference(item.requestMessageId)), 'NATIVE_INBOX_CORRUPT', 'Invalid input receipt.');
    return { id: item.id, outcome: item.outcome as Outcome, requestMessageId: item.requestMessageId };
  });
  const dispatchingIds = value.dispatchingIds;
  assert(dispatchingIds === undefined || Array.isArray(dispatchingIds) && dispatchingIds.length <= 16
    && dispatchingIds.every(id => typeof id === 'string' && entries.some(entry => entry.message.id === id))
    && new Set(dispatchingIds).size === dispatchingIds.length, 'NATIVE_INBOX_CORRUPT', 'Invalid dispatch batch.');
  return { ...(dispatchingIds === undefined ? {} : { dispatchingIds: dispatchingIds as string[] }), schema: 1, conversationId: value.conversationId, phase: value.phase as Queue['phase'], entries, receipts,
    errorCode: value.errorCode as string | null };
}

export function readNativeInboxSummary(store: DurableStore): NativeInboxSummary {
  const items = store.list(namespace, { limit: 256 }).map(record => {
    const queue = decode(record);
    return { conversationId: queue.conversationId, state: queue.entries.length ? queue.phase : 'idle' as const,
      pending: queue.entries.length, oldestReceivedAt: queue.entries.length ? Math.min(...queue.entries.map(entry => entry.admittedAt)) : null,
      deadlineAt: queue.entries.length ? Math.min(...queue.entries.map(entry => entry.deadlineAt)) : null,
      lastError: queue.errorCode, expired: queue.receipts.filter(receipt => receipt.outcome === 'expired').length,
      automaticReplayAvailable: false as const };
  });
  return snapshot({ schema: 1 as const, items, pending: items.reduce((sum, item) => sum + item.pending, 0),
    blockedConversations: items.filter(item => item.state === 'blocked').length,
    limitPerConversation: 16 as const, limitTotal: 256 as const });
}

/** Pending corrections retain their arrival deadline. Interrupted dispatch is never replayed. */
export function createNativeInbox(options: {
  readonly store: DurableStore;
  readonly clock?: () => number;
  readonly readiness: (conversationId: string) => 'ready' | 'busy' | 'blocked';
  readonly deliver: (entries: readonly NativeInboxEntry[]) => Promise<{ readonly status: 'accepted' | 'rejected' | 'unknown'; readonly errorCode?: string | null }>;
  readonly onFault?: (code: string) => void;
}) {
  const now = options.clock ?? Date.now;
  const running = new Map<string, Promise<void>>();
  let stopped = false;
  const read = (id: string) => options.store.read(namespace, digest(id));
  function write(prior: StoredRecord | null, queue: Queue) {
    assert(Buffer.byteLength(JSON.stringify(queue)) <= 192 * 1024, 'NATIVE_INBOX_BACKPRESSURE', 'Pending input storage is full.');
    return options.store.write(namespace, digest(queue.conversationId), json(queue), { expectedRevision: prior?.revision ?? null });
  }
  function receipts(queue: Queue, entries: readonly NativeInboxEntry[], outcome: Outcome, requestMessageId: string | null) {
    return [...queue.receipts, ...entries.map(entry => ({ id: entry.message.id, outcome, requestMessageId }))].slice(-64);
  }
  // Only an interrupted submitted batch is uncertain. Waiting inputs retain their original deadline.
  function resume(record: StoredRecord): StoredRecord {
    const queue = decode(record);
    let next = queue;
    if (queue.phase !== 'pending') {
      const uncertain = queue.phase === 'blocked' && queue.errorCode === 'NATIVE_INBOX_EXECUTION_UNCONFIRMED'
        ? [] : queue.phase === 'dispatching' ? queue.dispatchingIds ?? queue.entries.map(entry => entry.message.id)
        : queue.receipts.some(receipt => receipt.outcome === 'unknown' && queue.entries.some(entry => entry.message.id === receipt.id))
          ? queue.receipts.filter(receipt => receipt.outcome === 'unknown').map(receipt => receipt.id)
          : queue.entries.map(entry => entry.message.id);
      const ids = new Set(uncertain);
      const unrecorded = queue.entries.filter(entry => ids.has(entry.message.id) && !queue.receipts.some(receipt => receipt.id === entry.message.id));
      next = { ...queue, phase: 'pending', dispatchingIds: [], entries: queue.entries.filter(entry => !ids.has(entry.message.id)),
        receipts: receipts(queue, unrecorded, 'unknown', null), errorCode: null };
    }
    const expired = next.entries.filter(entry => entry.deadlineAt <= now());
    if (expired.length) next = { ...next, entries: next.entries.filter(entry => entry.deadlineAt > now()),
      receipts: receipts(next, expired, 'expired', null), errorCode: 'NATIVE_CHAT_DEADLINE_EXPIRED' };
    return next === queue ? record : write(record, next);
  }
  async function process(conversationId: string) {
    if (stopped) return;
    let record = read(conversationId);
    if (!record) return;
    let queue = decode(record);
    if (queue.phase !== 'pending' || !queue.entries.length) return;
    const expired = queue.entries.filter(entry => entry.deadlineAt <= now());
    if (expired.length) {
      queue = { ...queue, entries: queue.entries.filter(entry => entry.deadlineAt > now()),
        receipts: receipts(queue, expired, 'expired', null), errorCode: 'NATIVE_CHAT_DEADLINE_EXPIRED' };
      record = write(record, queue);
    }
    if (!queue.entries.length) return;
    const ready = options.readiness(conversationId);
    if (ready === 'busy') return;
    if (ready === 'blocked') return; // Recheck on the next tick; never freeze unrelated future input.
    // Merge consecutive messages from one person; never promote somebody else's text to their identity.
    const first = queue.entries[0]!;
    const end = queue.entries.findIndex(entry => entry.message.userId !== first.message.userId);
    const batch = queue.entries.slice(0, end === -1 ? queue.entries.length : end);
    write(record, { ...queue, phase: 'dispatching', dispatchingIds: batch.map(entry => entry.message.id), errorCode: null });
    let result: { readonly status: 'accepted' | 'rejected' | 'unknown'; readonly errorCode?: string | null };
    try { result = await options.deliver(snapshot(batch)); }
    catch (error) { result = { status: 'unknown', errorCode: errorCode(error, 'NATIVE_INBOX_DISPATCH_UNKNOWN') }; }
    const latest = read(conversationId);
    assert(latest, 'NATIVE_INBOX_CORRUPT', 'Pending dispatch evidence disappeared.');
    const current = decode(latest);
    const ids = new Set(batch.map(entry => entry.message.id));
    write(latest, { ...current, phase: 'pending', dispatchingIds: [],
      entries: current.entries.filter(entry => !ids.has(entry.message.id)),
      receipts: receipts(current, batch, result.status, batch.at(-1)!.message.id), errorCode: result.errorCode ?? null });
  }
  function tick() {
    if (stopped) return Promise.resolve();
    const pending: Promise<void>[] = [];
    for (const record of options.store.list(namespace, { limit: 256 })) {
      const queue = decode(record);
      if (!queue.entries.length) continue;
      const previous = running.get(queue.conversationId);
      if (previous) { pending.push(previous); continue; }
      if (queue.phase !== 'pending') resume(record);
      const work = process(queue.conversationId).catch(error => options.onFault?.(errorCode(error, 'NATIVE_INBOX_FAILED')))
        .finally(() => { running.delete(queue.conversationId); });
      running.set(queue.conversationId, work); pending.push(work);
    }
    return Promise.all(pending).then(() => undefined);
  }
  return Object.freeze({
    recover() {
      for (const record of options.store.list(namespace, { limit: 256 })) {
        resume(record);
      }
    },
    enqueue(entry: NativeInboxEntry) {
      assert(!stopped && !entry.message.isSelf && entry.message.directed, 'NATIVE_INBOX_UNAVAILABLE', 'Only admitted directed messages may queue.');
      let prior = read(entry.message.conversationId);
      if (prior && decode(prior).phase === 'blocked') prior = resume(prior);
      const queue: Queue = prior ? decode(prior) : { schema: 1, conversationId: entry.message.conversationId,
        phase: 'pending', entries: [], receipts: [], errorCode: null };
      const duplicate = queue.entries.find(item => item.message.id === entry.message.id);
      if (duplicate) {
        assert(digest({ ...duplicate.message, receivedAt: 0 }) === digest({ ...entry.message, receivedAt: 0 }), 'NATIVE_INBOX_CONFLICT', 'Queued message identity changed.');
        return 'duplicate' as const;
      }
      if (queue.receipts.some(item => item.id === entry.message.id)) return 'duplicate' as const;
      const all = options.store.list(namespace, { limit: 256 });
      assert((prior !== null || all.length < 256) && all.reduce((sum, record) => sum + decode(record).entries.length, 0) < 256
        && queue.entries.length < 16, 'NATIVE_INBOX_BACKPRESSURE', 'Pending input queue is full.');
      const value = { ...queue, entries: [...queue.entries, snapshot(entry)] };
      // Validate all trusted fields before persisting, using the same decoder as recovery.
      decode({ namespace, key: digest(queue.conversationId), revision: 0, updatedAt: now(), expiresAt: null, value: json(value) });
      write(prior, value);
      return 'queued' as const;
    },
    contains(conversationId: string, messageId: string) {
      const record = read(conversationId);
      if (!record) return false;
      const queue = decode(record);
      return queue.entries.some(entry => entry.message.id === messageId) || queue.receipts.some(receipt => receipt.id === messageId);
    },
    hasPending(conversationId: string) { const record = read(conversationId); return record !== null && decode(record).entries.length > 0; },
    summary() { return readNativeInboxSummary(options.store); },
    list() { return snapshot(options.store.list(namespace, { limit: 256 }).map(record => decode(record))); },
    tick,
    async stop() { stopped = true; await Promise.allSettled([...running.values()]); },
  });
}
