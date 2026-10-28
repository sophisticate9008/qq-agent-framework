import type { OneBotActionPort } from '../adapters/onebot-actions.ts';
import { normalizeOneBotContent, type OneBotIncomingAssetRegistrar } from '../adapters/onebot.ts';
import { snapshot } from '../core/values.ts';
import type { HistoryMessage } from './history.ts';
import type { InboundMessage } from './types.ts';
import { withDeadline } from './deadlines.ts';
import type { NativeMediaDiagnostics } from '../contracts/native-media-diagnostics.ts';
import { mediaObservationCode } from './native-media-diagnostics.ts';
import { normalizeSenderDisplayName } from '../contracts/sender-display-name.ts';

/** Only an already received reply reference may request bounded context in the same verified QQ scope. */
export function createNativeQuotedContext(options: {
  readonly protocol: Pick<OneBotActionPort, 'getMessage'>;
  readonly selfId: string;
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>;
  readonly register: OneBotIncomingAssetRegistrar;
  readonly clock?: () => number;
  readonly observe?: (conversationId: string, result: NonNullable<NativeMediaDiagnostics['quote']>) => void;
}) {
  const cache = new Map<string, { readonly until: number; readonly message: HistoryMessage }>();
  const now = options.clock ?? Date.now;
  function observe(conversationId: string, messageId: string, status: 'confirmed' | 'rejected' | 'unknown', code: string | null) {
    try { options.observe?.(conversationId, { messageId, at: now(), status, code }); } catch {}
  }
  return Object.freeze({
    async read(message: Pick<InboundMessage, 'conversationId' | 'content'>,
      history: readonly HistoryMessage[], signal: AbortSignal): Promise<readonly HistoryMessage[]> {
      const ids = [...new Set(message.content.flatMap(part => part.type === 'reply' ? [part.messageId] : []))]
        .filter(id => !history.some(entry => entry.id === id)).slice(0, 4);
      if (ids.length === 0) return [];
      await options.authorize(message.conversationId, signal);
      const result: HistoryMessage[] = [];
      for (const id of ids) {
        signal.throwIfAborted();
        const key = `${message.conversationId}/${id}`;
        const cached = cache.get(key);
        if (cached && cached.until > now()) { result.push(cached.message); observe(message.conversationId, id, 'confirmed', null); continue; }
        cache.delete(key);
        const found = await withDeadline({ signal, timeoutMs: 1_000, code: 'QUOTED_CONTEXT_UNAVAILABLE',
          run: signal => options.protocol.getMessage({ messageId: id, conversationId: message.conversationId, signal }) }).catch(() => null);
        signal.throwIfAborted();
        if (found?.status !== 'confirmed') {
          observe(message.conversationId, id, found?.status ?? 'unknown', mediaObservationCode(found?.code) ?? 'QUOTED_CONTEXT_UNAVAILABLE'); continue;
        }
        if (found.data.messageId !== id || found.data.conversationId !== message.conversationId) {
          observe(message.conversationId, id, 'rejected', 'QUOTED_CONTEXT_SCOPE_MISMATCH'); continue;
        }
        await options.authorize(message.conversationId, signal);
        const content = await normalizeOneBotContent(found.data.message, { messageId: id, conversationId: message.conversationId,
          registerIncomingAsset: options.register, signal });
        if (!content || content.length === 0) { observe(message.conversationId, id, 'rejected', 'QUOTED_CONTENT_UNSUPPORTED'); continue; }
        const displayName = normalizeSenderDisplayName(found.data.displayName);
        const quoted: HistoryMessage = snapshot({ id, actor: found.data.userId === options.selfId ? 'assistant' : found.data.userId,
          ...(displayName === undefined ? {} : { displayName }),
          content, receivedAt: 0 });
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(key, { message: quoted, until: now() + 30_000 });
        result.push(quoted);
        observe(message.conversationId, id, 'confirmed', null);
      }
      await options.authorize(message.conversationId, signal);
      return snapshot(result);
    },
    clear() { cache.clear(); },
  });
}
