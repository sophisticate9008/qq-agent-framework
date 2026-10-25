import { NATIVE_CHAT_PROTOCOL_INSTRUCTIONS } from './native-chat-protocol.ts';
import type { NativeAppearanceContext } from '../contracts/native-appearance.ts';
import { normalizeContent } from '../core/content.ts';
import { assert } from '../core/values.ts';
import type { FrameworkEvent, MessageContent } from '../core/types.ts';
import type { HistoryMessage } from './history.ts';
import type { InboundMessage } from './types.ts';
import type { NativeMemoryContext } from '../contracts/native-memory.ts';

export type NativeParticipationReason = 'direct' | 'nickname' | 'reply' | 'continuation' | 'ambient';
export interface NativeParticipationOptions {
  readonly names: readonly string[];
  readonly continuationMs: number;
  readonly activeSender?: string;
  readonly wakeOnMention?: boolean;
  readonly wakeOnReply?: boolean;
  readonly quotedMessages?: readonly HistoryMessage[];
}

export function nativeParticipation(message: InboundMessage, history: readonly HistoryMessage[],
  options: NativeParticipationOptions, now: number): NativeParticipationReason {
  assert(Number.isFinite(now) && Number.isSafeInteger(options.continuationMs)
    && options.continuationMs >= 0 && options.continuationMs <= 300_000
    && options.names.length <= 16 && options.names.every(name => typeof name === 'string' && name.length > 0 && name.length <= 128),
  'INVALID_PARTICIPATION_OPTIONS', 'Participation needs bounded names and continuation time.');
  if (message.isSelf) return 'ambient';
  if (message.conversationId.startsWith('private:')) return 'direct';
  if (message.directed && options.wakeOnMention !== false) return 'direct';
  const replies = message.content.filter(part => part.type === 'reply');
  if (options.wakeOnReply !== false && replies.some(part => [...history, ...(options.quotedMessages ?? [])]
    .some(entry => entry.id === part.messageId && entry.actor === 'assistant'))) return 'reply';
  // An explicit reply to somebody else or mention takes precedence over ambient continuation.
  if (replies.length > 0 || message.content.some(part => part.type === 'mention')) return 'ambient';
  const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').toLocaleLowerCase();
  if (options.names.some(name => text.includes(name.toLocaleLowerCase()))) return 'nickname';
  if (options.continuationMs > 0 && options.activeSender === message.userId) return 'continuation';
  const latest = history.at(-1);
  const lastUser = history.findLast(entry => entry.actor !== 'assistant' && entry.actor !== 'system');
  const lastReply = history.findLast(entry => entry.actor === 'assistant');
  if (options.continuationMs > 0 && latest && lastUser?.actor === message.userId && lastReply
    && now >= lastReply.receivedAt && now - lastReply.receivedAt <= options.continuationMs) return 'continuation';
  return 'ambient';
}

function contentText(content: readonly MessageContent[]): string {
  return content.map(part => {
    if (part.type === 'text') return part.text;
    if (part.type === 'mention') return `[提及账号 ${part.userId}]`;
    if (part.type === 'reply') return `[引用消息 ${part.messageId}]`;
    if (part.type === 'forward-reference') return `[合并转发资源 ${part.assetId}：未展开读取内容]`;
    if (part.type === 'forward') return `[合并转发：${part.nodes.length}个已登记节点，需通过资源读取确认内容]`;
    return `[${part.type}资源 ${part.assetId}：未读取内容${part.type === 'file' ? `，文件名 ${part.name}` : ''}]`;
  }).join('\n');
}

export function prepareNativeChatInput(event: FrameworkEvent, history: readonly HistoryMessage[], options: {
  readonly owner: string | null;
  readonly partial: boolean;
  readonly maxHistoryCharacters?: number;
  readonly participation?: NativeParticipationReason;
  readonly quotedMessages?: readonly HistoryMessage[];
  readonly unread?: { readonly ids: readonly string[]; readonly readThrough: number; readonly through: number; readonly partial: boolean };
  readonly memory?: NativeMemoryContext;
  readonly appearance?: NativeAppearanceContext | null;
  readonly tools?: { readonly available: boolean; readonly tools: readonly { readonly name: string; readonly description: string }[]; readonly reason: string | null };
  readonly output?: { readonly protocol: 'qaf.output/1'; readonly forwardAuthorized?: boolean; readonly bubbles: boolean; readonly media: boolean; readonly longTextAsForward: boolean; readonly longTextThreshold: number; readonly maxDeliveries: number };
}): readonly MessageContent[] {
  const budget = options.maxHistoryCharacters ?? 5_000;
  assert(Number.isSafeInteger(budget) && budget >= 0 && budget <= 6_000,
    'INVALID_INPUT_BUDGET', 'Context budget must be bounded.');
  const original = normalizeContent(event.data.content);
  const text = contentText(original);
  const recent: { id: string; actor: string; text: string; truncated: boolean; unread: boolean }[] = [];
  let size = 0;
  let historyTruncated = options.partial;
  for (const entry of history.filter(entry => entry.id !== event.id).slice().reverse()) {
    const full = contentText(entry.content);
    const item = { id: entry.id, actor: entry.actor, text: full.slice(0, 800), truncated: full.length > 800,
      unread: options.unread?.ids.includes(entry.id) ?? false };
    const length = JSON.stringify(item).length;
    if (size + length > budget || recent.length >= 16) { historyTruncated = true; break; }
    recent.unshift(item); size += length;
  }
  const quoted = original.filter(part => part.type === 'reply').slice(0, 4).map(part => {
    const entry = history.find(candidate => candidate.id === part.messageId)
      ?? options.quotedMessages?.find(candidate => candidate.id === part.messageId);
    const full = entry ? contentText(entry.content) : '';
    return { id: part.messageId, available: entry !== undefined, actor: entry?.actor ?? null,
      text: full.slice(0, 300), truncated: full.length > 300 };
  });
  const envelope = (currentTruncated: boolean) => JSON.stringify({ schema: 1, conversationId: event.conversationId, messageId: event.id,
    senderId: event.userId ?? null, senderIsConfiguredOwner: options.owner !== null && event.userId === options.owner,
    participation: options.participation ?? (event.data.directed === true ? 'direct' : 'ambient'),
    unread: options.unread ? { readThrough: options.unread.readThrough, through: options.unread.through,
      count: options.unread.ids.length, included: recent.filter(item => item.unread).length + (options.unread.ids.includes(event.id) ? 1 : 0),
      partial: options.unread.partial || historyTruncated } : null,
    recent, quoted, memory: options.memory ?? null, appearance: options.appearance ?? null, tools: options.tools ?? { available: false, tools: [] }, output: options.output ?? null, historyTruncated, currentTruncated });

  function build(length: number): readonly MessageContent[] {
    const parts: MessageContent[] = [];
    const context = `${NATIVE_CHAT_PROTOCOL_INSTRUCTIONS}${envelope(length < text.length)}`;
    for (let offset = 0; offset < context.length; offset += 8_000) parts.push({ type: 'text', text: context.slice(offset, offset + 8_000) });
    const current = `当前消息：\n${text.slice(0, length)}${length < text.length ? '\n[当前消息超出输入预算，部分内容未提供]' : ''}`;
    for (let offset = 0; offset < current.length; offset += 8_000) parts.push({ type: 'text', text: current.slice(offset, offset + 8_000) });
    return parts;
  }
  let length = Math.min(text.length, 16_000);
  let parts = build(length);
  while (Buffer.byteLength(JSON.stringify(parts), 'utf8') > 60 * 1024 || parts.length > 8) {
    assert(length > 0, 'INVALID_INPUT_BUDGET', 'Context metadata exceeds the input budget.');
    length = Math.floor(length * 0.8);
    parts = build(length);
  }
  return normalizeContent(parts);
}
