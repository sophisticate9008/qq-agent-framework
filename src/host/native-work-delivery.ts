import type { DeliveryReceipt, MessageContent, PersonaScope } from '../core/types.ts';
import { assert } from '../core/values.ts';
import type { NativeWorkResultDelivery } from './native-work.ts';
import type { createBridgeHost } from './bridge.ts';
import type { DurableStore } from './types.ts';
import { digest, json, object } from './data.ts';

/** Work completion is one explicit delegation's result, with a separate bounded send grant. */
export function createNativeWorkDelivery(options: {
  readonly host: ReturnType<typeof createBridgeHost>; readonly store: DurableStore; readonly persona: PersonaScope;
  readonly guard: (conversationId: string, signal: AbortSignal) => Promise<void>;
  readonly owner: () => string | null;
}) {
  return async (result: Readonly<NativeWorkResultDelivery>, signal: AbortSignal): Promise<DeliveryReceipt> => {
    const record = options.store.read('native-work.executions', result.id);
    const persisted = object(record?.value);
    assert(persisted.deliveryId === result.deliveryId && persisted.resultId === result.resultId && persisted.delivery === 'delivering'
      && persisted.ownerId === options.owner() && persisted.parentSessionId === result.parentSessionId
      && persisted.conversationId === result.conversationId && persisted.generation === result.generation,
    'NATIVE_WORK_DELIVERY_INVALID', 'Only a persisted result for the current delegation can be delivered.');
    const parts: MessageContent[][] = [];
    for (const content of result.output) {
      if (content.type === 'text') {
        for (let offset = 0; offset < content.text.length; offset += 3500) parts.push([{ type: 'text', text: content.text.slice(offset, offset + 3500) }]);
      } else parts.push([content]);
    }
    if (!parts.length) parts.push([{ type: 'text', text: result.stopReason === 'completed' ? '工作已结束，没有返回可展示的内容。' : '工作已停止，没有返回可展示的内容。' }]);
    assert(parts.length <= 80, 'NATIVE_WORK_OUTPUT_LIMIT', 'The result exceeds the bounded delivery limit.');
    const id = `work-delivery:${digest(result.deliveryId)}`;
    assert(!options.host.policy.describe().grants.some(grant => grant.id === id), 'NATIVE_WORK_DELIVERY_UNKNOWN', 'This result already has a delivery authorization.');
    await options.guard(result.conversationId, signal);
    options.host.policy.grant({ ...(options.host.accountScope ? { accountScope: options.host.accountScope } : {}), id, featureId: 'native-work-result', conversationId: result.conversationId,
      capabilities: ['messaging.send'], maxUses: { 'messaging.send': parts.length }, expiresAt: Date.now() + 30000 });
    let last: DeliveryReceipt = { status: 'rejected' };
    try {
      for (const [index, content] of parts.entries()) {
        await options.guard(result.conversationId, signal);
        const binding = options.host.sessions.get(result.conversationId);
        assert(binding?.sessionId === result.parentSessionId && binding.generation === result.generation
          && persisted.ownerId === options.owner(), 'WORK_PARENT_UNAVAILABLE', 'The original work parent changed.');
        signal.throwIfAborted();
        const reservation = options.host.policy.reserve({ ...(options.host.accountScope ? { accountScope: options.host.accountScope } : {}), featureId: 'native-work-result', conversationId: result.conversationId, capability: 'messaging.send' });
        options.host.policy.begin(reservation);
        last = await options.host.outbox.send({ conversationId: result.conversationId, content,
          idempotencyKey: `${result.deliveryId}:${index}`, signal,
          scope: { ...(options.host.accountScope ? { accountScope: options.host.accountScope } : {}), persona: options.persona, sessionId: result.parentSessionId, generation: result.generation } });
        options.store.write('native-work.deliveries', digest([result.deliveryId, index]), json({ schema: 1,
          deliveryId: result.deliveryId, workId: result.id, index, total: parts.length, receipt: last }), { expectedRevision: null });
        if (last.status !== 'confirmed') return last;
      }
      return last;
    } finally { options.host.policy.revoke(id); }
  };
}
