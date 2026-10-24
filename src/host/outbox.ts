import { normalizeContent } from '../core/content.ts';
import { FrameworkError, assert, errorCode, reference, snapshot } from '../core/values.ts';
import type { Clock, DeliveryReceipt, SendRequest, TransportAdapter } from '../core/types.ts';
import type { DurableStore, StoredRecord } from './types.ts';
import { digest, json, object, records } from './data.ts';

type OutboxStatus = 'prepared' | 'sending' | 'confirmed' | 'rejected' | 'unknown';
const namespace = 'outbox';

function entry(record: StoredRecord) {
  const value = object(record.value);
  assert(reference(value.id) && reference(value.conversationId) && typeof value.fingerprint === 'string'
    && ['prepared', 'sending', 'confirmed', 'rejected', 'unknown'].includes(String(value.status)),
  'INVALID_STORED_DATA', 'Stored outbox data is invalid.');
  if (value.status === 'confirmed') assert(reference(value.messageId), 'INVALID_STORED_DATA', 'Stored receipt is invalid.');
  return value;
}

function receipt(record: StoredRecord): DeliveryReceipt {
  const value = entry(record);
  return value.status === 'confirmed' ? snapshot({ status: 'confirmed', messageId: String(value.messageId) })
    : value.status === 'rejected' ? snapshot({ status: 'rejected' }) : snapshot({ status: 'unknown' });
}

export function createDurableTransport({ store, transport, clock = Date.now }:
  { store: DurableStore; transport: TransportAdapter; clock?: Clock }) {
  const inflight = new Map<string, { fingerprint: string; promise: Promise<DeliveryReceipt> }>();

  function recoverEntries(entries: Iterable<StoredRecord>) {
    let recovered = 0;
    for (const record of entries) {
      const value = entry(record);
      if (inflight.has(String(value.id)) || !['prepared', 'sending'].includes(String(value.status))) continue;
      try {
        store.write(namespace, record.key, json({ ...value, status: 'unknown', at: clock(), errorCode: 'DISPATCH_INTERRUPTED' }),
          { expectedRevision: record.revision });
        recovered++;
      } catch (error) { if (errorCode(error) !== 'STORE_CONFLICT') throw error; }
    }
    return recovered;
  }

  async function dispatch(request: SendRequest, fingerprint: string): Promise<DeliveryReceipt> {
    const key = digest(request.idempotencyKey);
    let current: StoredRecord;
    try {
      current = store.write(namespace, key, json({ id: request.idempotencyKey, conversationId: request.conversationId,
        content: request.content, fingerprint, status: 'prepared', at: clock() }), { expectedRevision: null });
    } catch (error) {
      if (!(error instanceof FrameworkError && error.code === 'STORE_CONFLICT')) throw error;
      const prior = store.read(namespace, key);
      assert(prior && entry(prior).fingerprint === fingerprint, 'EFFECT_CONFLICT', 'The stored effect has different content.');
      return receipt(prior);
    }
    current = store.write(namespace, key, json({ ...entry(current), status: 'sending', at: clock() }),
      { expectedRevision: current.revision });
    let result: DeliveryReceipt;
    try {
      if (request.signal.aborted) result = { status: 'rejected' };
      else {
        const response = await transport.send(request);
        result = response?.status === 'confirmed' && reference(response.messageId) ? { status: 'confirmed', messageId: response.messageId }
          : response?.status === 'rejected' ? { status: 'rejected' } : { status: 'unknown' };
      }
    } catch { result = { status: 'unknown' }; }
    try {
      store.write(namespace, key, json({ ...entry(current), ...result, at: clock() }), { expectedRevision: current.revision });
    } catch (error) {
      if (!(error instanceof FrameworkError && error.code === 'STORE_CONFLICT')) return snapshot({ status: 'unknown' });
      const latest = store.read(namespace, key);
      return latest ? receipt(latest) : snapshot({ status: 'unknown' });
    }
    return snapshot(result);
  }

  return Object.freeze({
    send(input: SendRequest): Promise<DeliveryReceipt> {
      assert(reference(input.conversationId) && reference(input.idempotencyKey) && input.signal instanceof AbortSignal,
        'INVALID_REQUEST', 'A scoped message and idempotency key are required.');
      const request = { ...input, content: normalizeContent(input.content) };
      const fingerprint = digest({ conversationId: request.conversationId, content: request.content });
      const pending = inflight.get(input.idempotencyKey);
      if (pending) {
        assert(pending.fingerprint === fingerprint, 'EFFECT_CONFLICT', 'The effect has different content.');
        return pending.promise;
      }
      const prior = store.read(namespace, digest(input.idempotencyKey));
      if (prior) {
        assert(entry(prior).fingerprint === fingerprint, 'EFFECT_CONFLICT', 'The stored effect has different content.');
        return Promise.resolve(receipt(prior));
      }
      const promise = dispatch(request, fingerprint);
      inflight.set(input.idempotencyKey, { fingerprint, promise });
      const settled = () => inflight.delete(input.idempotencyKey);
      promise.then(settled, settled);
      return promise;
    },
    recover() {
      return recoverEntries(records(store, namespace));
    },
    recoverPage({ limit = 100, after }: { limit?: number; after?: string } = {}) {
      const batch = store.list(namespace, after === undefined ? { limit } : { limit, after });
      return { recovered: recoverEntries(batch), next: batch.length === limit ? batch.at(-1)!.key : null };
    },
    reconcile(id: string, result: Exclude<DeliveryReceipt, { status: 'unknown' }>) {
      assert(reference(id) && !inflight.has(id), 'OUTBOX_BUSY', 'An active delivery cannot be reconciled.');
      assert(result.status === 'rejected' || result.status === 'confirmed' && reference(result.messageId),
        'INVALID_RECEIPT', 'An explicit terminal receipt is required.');
      const current = store.read(namespace, digest(id));
      assert(current && ['unknown', 'prepared'].includes(String(entry(current).status)),
        'OUTBOX_TERMINAL', 'Only unresolved deliveries can be reconciled.');
      store.write(namespace, current.key, json({ ...entry(current), ...result, at: clock() }), { expectedRevision: current.revision });
    },
    list({ limit = 100, after }: { limit?: number; after?: string } = {}) {
      return snapshot(store.list(namespace, after === undefined ? { limit } : { limit, after }).map(record => {
        const value = entry(record);
        return { cursor: record.key, id: String(value.id), conversationId: String(value.conversationId),
          status: value.status as OutboxStatus, updatedAt: record.updatedAt };
      }));
    },
    metrics() { return snapshot({ active: inflight.size }); },
  });
}
