import { performance } from 'node:perf_hooks';
import { normalizeContent } from '../core/content.ts';
import { normalizeOutboundScope } from '../core/scope.ts';
import { assert, reference, snapshot } from '../core/values.ts';
import type { DeliveryReceipt, SendRequest, TransportAdapter } from '../core/types.ts';

interface PendingSend {
  request: SendRequest;
  controller: AbortController;
  resolve(receipt: DeliveryReceipt): void;
  detach(): void;
}

export function createThrottledTransport({ transport, minIntervalMs = 0, maxPending = 256 }:
  { transport: TransportAdapter; minIntervalMs?: number; maxPending?: number }) {
  assert(transport && typeof transport.send === 'function' && Number.isFinite(minIntervalMs)
    && minIntervalMs >= 0 && minIntervalMs <= 60000 && Number.isSafeInteger(maxPending)
    && maxPending > 0 && maxPending <= 10000, 'INVALID_THROTTLE', 'Finite transport limits are required.');
  const queued: PendingSend[] = [];
  let active: PendingSend | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextStart = 0;
  let stopped = false;
  let stopping: Promise<void> | null = null;
  let drained: (() => void) | undefined;

  function pump() {
    if (active || timer || stopped || queued.length === 0) return;
    const wait = nextStart - performance.now();
    if (wait > 0) {
      timer = setTimeout(() => { timer = null; pump(); }, wait);
      return;
    }
    const job = queued.shift()!;
    active = job;
    nextStart = performance.now() + minIntervalMs;
    void (async () => {
      let receipt: DeliveryReceipt;
      try {
        if (job.request.signal.aborted) receipt = { status: 'rejected' };
        else {
          const result = await transport.send(job.request);
          receipt = result?.status === 'confirmed' && reference(result.messageId)
            ? { status: 'confirmed', messageId: result.messageId }
            : result?.status === 'rejected' ? { status: 'rejected' } : { status: 'unknown' };
        }
      } catch { receipt = { status: 'unknown' }; }
      job.detach();
      active = null;
      job.resolve(snapshot(receipt));
      if (stopped) drained?.();
      else pump();
    })();
  }

  return Object.freeze({
    ...(transport.capabilities === undefined ? {} : { capabilities: () => snapshot(transport.capabilities!()) }),
    send(input: SendRequest): Promise<DeliveryReceipt> {
      assert(reference(input.conversationId) && reference(input.idempotencyKey) && input.signal instanceof AbortSignal,
        'INVALID_REQUEST', 'A scoped transport request is required.');
      const content = normalizeContent(input.content);
      if (stopped || input.signal.aborted || queued.length + Number(active !== null) >= maxPending) {
        return Promise.resolve(snapshot({ status: 'rejected' as const }));
      }
      const controller = new AbortController();
      return new Promise(resolve => {
        const aborted = () => {
          controller.abort();
          const index = queued.indexOf(job);
          if (index < 0) return;
          queued.splice(index, 1);
          job.detach();
          resolve(snapshot({ status: 'rejected' }));
          pump();
        };
        const job: PendingSend = {
          request: { conversationId: input.conversationId, idempotencyKey: input.idempotencyKey, content,
            ...(input.scope === undefined ? {} : { scope: normalizeOutboundScope(input.scope) }),
            signal: AbortSignal.any([input.signal, controller.signal]) },
          controller, resolve, detach: () => input.signal.removeEventListener('abort', aborted),
        };
        input.signal.addEventListener('abort', aborted, { once: true });
        queued.push(job);
        pump();
      });
    },
    metrics() { return snapshot({ queued: queued.length, active: Number(active !== null), maxPending, stopped }); },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      for (const job of queued.splice(0)) {
        job.detach();
        job.controller.abort();
        job.resolve(snapshot({ status: 'rejected' }));
      }
      stopping = new Promise<void>(resolve => {
        drained = resolve;
        if (active) active.controller.abort();
        else resolve();
      });
      return stopping;
    },
  });
}
