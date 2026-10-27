import type { OneBotActionPort, OneBotMessageInfo, OneBotReadResult } from '../adapters/onebot-actions.ts';
import type { AccountScope } from '../contracts/account-scope.ts';
import { isRecord } from '../core/values.ts';
import { digest, object } from './data.ts';
import type { DurableStore } from './types.ts';

export interface PrivateOutboundEvidence {
  readonly confirmed: boolean; readonly scanned: number; readonly limited: boolean; readonly conflict: boolean;
}
export type ScopedProtocolMessageResult = OneBotReadResult<OneBotMessageInfo>
  | { readonly status: 'rejected'; readonly code: 'PRIVATE_OUTBOUND_SCOPE_EVIDENCE_UNAVAILABLE'; readonly evidence: PrivateOutboundEvidence };

/** Same-account outbox only. A bounded scan miss is not proof that a message does not exist. */
function outboundEvidence(options: {
  readonly store: DurableStore; readonly messageId: string; readonly conversationId: string; readonly signal: AbortSignal;
  readonly accountScope?: AccountScope;
}): PrivateOutboundEvidence {
  let after: string | undefined;
  let scanned = 0;
  let matched = false;
  let conflict = false;
  let limited = false;
  while (scanned < 1000) {
    options.signal.throwIfAborted();
    const batch = options.store.list('outbox', after === undefined ? { limit: 100 } : { limit: 100, after });
    for (const record of batch) {
      scanned++;
      const value = object(record.value);
      if (value.status !== 'confirmed' || value.messageId !== options.messageId) continue;
      const deliveryScope = isRecord(value.scope) ? value.scope : null;
      const deliveryAccount = deliveryScope && isRecord(deliveryScope.accountScope) ? deliveryScope.accountScope : null;
      if (deliveryAccount && options.accountScope && digest(deliveryAccount) !== digest(options.accountScope)) continue;
      if (value.conversationId === options.conversationId) matched = true;
      else conflict = true;
    }
    if (batch.length < 100) break;
    after = batch.at(-1)!.key;
    if (scanned === 1000) limited = options.store.list('outbox', { limit: 1, after }).length > 0;
  }
  return { confirmed: matched && !conflict, scanned, limited, conflict };
}

/** Recover a private outgoing peer only from confirmed local delivery evidence, never from caller claims. */
export async function readScopedProtocolMessage(options: {
  readonly port: Pick<OneBotActionPort, 'getMessage'>; readonly store: DurableStore; readonly selfId: string;
  readonly messageId: string; readonly conversationId: string; readonly signal: AbortSignal;
  readonly accountScope?: AccountScope;
  readonly requireOutboundEvidence?: boolean;
}): Promise<ScopedProtocolMessageResult> {
  if (!/^(group|private):[1-9]\d{0,31}$/.test(options.conversationId)
    || !/^[1-9]\d{0,31}$/.test(options.selfId) || !/^-?[1-9]\d{0,31}$/.test(options.messageId))
    return { status: 'rejected', code: 'PROTOCOL_MESSAGE_SCOPE_INVALID' };
  const privateConversation = options.conversationId.startsWith('private:');
  if (!options.requireOutboundEvidence || !privateConversation) {
    const direct = await options.port.getMessage({ messageId: options.messageId,
      conversationId: options.conversationId, signal: options.signal });
    if (direct.status === 'confirmed') {
      if (direct.data.messageId !== options.messageId || direct.data.conversationId !== options.conversationId)
        return { status: 'rejected', code: 'PROTOCOL_MESSAGE_SCOPE_MISMATCH' };
      return direct;
    }
    if (!privateConversation) return direct;
  }
  const evidence = outboundEvidence(options);
  if (!evidence.confirmed) return { status: 'rejected', code: 'PRIVATE_OUTBOUND_SCOPE_EVIDENCE_UNAVAILABLE', evidence };
  options.signal.throwIfAborted();
  // get_msg may identify only the bot's sender. The outbox receipt supplies
  // the peer; asking the decoder for private:self does not confer that scope.
  const own = await options.port.getMessage({ messageId: options.messageId,
    conversationId: `private:${options.selfId}`, signal: options.signal });
  options.signal.throwIfAborted();
  if (own.status !== 'confirmed') return own;
  if (own.data.userId !== options.selfId || own.data.messageId !== options.messageId
    || own.data.conversationId !== `private:${options.selfId}`)
    return { status: 'rejected', code: 'PRIVATE_OUTBOUND_SENDER_MISMATCH' };
  const current = outboundEvidence(options);
  if (!current.confirmed) return { status: 'rejected', code: 'PRIVATE_OUTBOUND_SCOPE_EVIDENCE_UNAVAILABLE', evidence: current };
  return { status: 'confirmed', data: { ...own.data, conversationId: options.conversationId } };
}
