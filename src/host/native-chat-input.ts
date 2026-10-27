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
  readonly activatedAt?: number;
  readonly wakeOnMention?: boolean;
  readonly wakeOnReply?: boolean;
  readonly quotedMessages?: readonly HistoryMessage[];
}

export function nativeParticipation(message: InboundMessage, history: readonly HistoryMessage[],
  options: NativeParticipationOptions, now: number): NativeParticipationReason {
  assert(Number.isFinite(now) && Number.isSafeInteger(options.continuationMs)
    && options.continuationMs >= 0 && options.continuationMs <= 300_000
    && (options.activatedAt === undefined || Number.isFinite(options.activatedAt))
    && options.names.length <= 16 && options.names.every(name => typeof name === 'string' && name.length > 0 && name.length <= 128),
  'INVALID_PARTICIPATION_OPTIONS', 'Participation needs bounded names and continuation time.');
  if (message.isSelf) return 'ambient';
  if (message.conversationId.startsWith('private:')) return 'direct';
  if (message.directed) return 'direct';
  const replies = message.content.filter(part => part.type === 'reply');
  if (options.wakeOnReply !== false && replies.some(part => [...history, ...(options.quotedMessages ?? [])]
    .some(entry => entry.id === part.messageId && entry.actor === 'assistant'))) return 'reply';
  const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').toLocaleLowerCase();
  if (options.names.some(name => text.includes(name.toLocaleLowerCase()))) return 'nickname';
  // History contains assistant messages only after confirmed QQ delivery. Neither
  // ordinary incoming messages nor the start of another continuation renews the window.
  const lastReply = history.findLast(entry => entry.actor === 'assistant');
  const activatedAt = Math.max(options.activatedAt ?? -Infinity, lastReply?.receivedAt ?? -Infinity);
  if (options.continuationMs > 0 && now >= activatedAt && now - activatedAt <= options.continuationMs) return 'continuation';
  return 'ambient';
}

function contentText(content: readonly MessageContent[], attachedImages: ReadonlySet<string> = new Set()): string {
  return content.map(part => {
    if (part.type === 'text') return part.text;
    if (part.type === 'image' && attachedImages.has(part.assetId)) return `[图片资源 ${part.assetId}：宿主将按可用性附上图片，以实际附件为准]`;
    if (part.type === 'mention') return `[提及账号 ${part.userId}]`;
    if (part.type === 'reply') return `[引用消息 ${part.messageId}]`;
    if (part.type === 'face') return `[QQ表情 ${part.id}]`;
    if (part.type === 'forward-reference') return `[合并转发资源 ${part.assetId}：未展开读取内容]`;
    if (part.type === 'forward') return `[合并转发：${part.nodes.length}个已登记节点，需通过资源读取确认内容]`;
    return `[${part.type}资源 ${part.assetId}：未读取内容${part.type === 'file' ? `，文件名 ${part.name}` : ''}]`;
  }).join('\n');
}

export function prepareNativeChatInput(event: FrameworkEvent, history: readonly HistoryMessage[], options: {
  readonly owner: string | null;
  readonly partial: boolean;
  readonly attachImages?: boolean;
  readonly maxHistoryCharacters?: number;
  readonly participation?: NativeParticipationReason;
  readonly unsentReplyMessageIds?: readonly string[];
  readonly sentWhileQueued?: readonly HistoryMessage[];
  readonly quotedMessages?: readonly HistoryMessage[];
  readonly unread?: { readonly ids: readonly string[]; readonly readThrough: number; readonly through: number; readonly partial: boolean };
  readonly memory?: NativeMemoryContext;
  readonly tools?: { readonly available: boolean; readonly tools: readonly { readonly name: string; readonly description: string }[]; readonly reason: string | null };
  readonly output?: { readonly protocol: 'qaf.output/1'; readonly forwardAuthorized?: boolean; readonly bubbles: boolean; readonly longTextAsForward: boolean; readonly longTextThreshold: number; readonly maxDeliveries: number };
}): readonly MessageContent[] {
  const budget = options.maxHistoryCharacters ?? 5_000;
  assert(Number.isSafeInteger(budget) && budget >= 0 && budget <= 6_000,
    'INVALID_INPUT_BUDGET', 'Context budget must be bounded.');
  const original = normalizeContent(event.data.content);
  const images = options.attachImages ? [...new Set(original.filter(part => part.type === 'image').map(part => part.assetId))].slice(0, 4) : [];
  const text = contentText(original, new Set(images));
  const participation = options.participation ?? (event.data.directed === true ? 'direct' : 'ambient');
  const currentTime = history.find(message => message.id === event.id)?.receivedAt;
  const recentWindow = currentTime === undefined ? [] : history.filter(message => message.receivedAt <= currentTime
    && message.receivedAt > currentTime - 120_000);
  const groupParticipation = event.conversationId.startsWith('group:') ? {
    mode: participation === 'direct' || participation === 'reply' ? 'addressed' : 'observe-and-select',
    sentMessagesInTwoMinutes: recentWindow.filter(message => message.actor === 'assistant').length,
    receivedMessagesInTwoMinutes: recentWindow.filter(message => message.actor !== 'assistant' && message.actor !== 'system').length,
    speakersInTwoMinutes: new Set(recentWindow.filter(message => message.actor !== 'assistant' && message.actor !== 'system').map(message => message.actor)).size
  } : undefined;
  const recent: { id: string; actor: string; text: string; truncated: boolean; unread: boolean }[] = [];
  let size = 0;
  let historyTruncated = options.partial;
  // DSH owns the continuous conversation. Only forward messages it has not seen.
  const unreadIds = options.unread ? new Set(options.unread.ids) : null;
  for (const entry of history.filter(entry => entry.id !== event.id && entry.actor !== 'assistant'
    && entry.actor !== 'system' && (unreadIds === null || unreadIds.has(entry.id))).slice().reverse()) {
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
    ...(options.sentWhileQueued?.length ? { replyTiming: {
      sentAfterCurrentMessage: options.sentWhileQueued.slice(-4).map(message => ({ id: message.id, text: contentText(message.content).slice(0, 200) })),
      note: '当前消息先到达，以上回复随后才发送。模型处理顺序不等于群聊发言顺序，不能把当前消息当成对这些回复的反馈。'
    } } : {}),
    ...(options.unsentReplyMessageIds?.length ? { replyDelivery: { unsentFor: options.unsentReplyMessageIds,
      note: '这些旧消息的模型回复尚未发送，因为你收到同一人的后续补充。结合最新要求重新组织回复，不把此前模型输出当作用户已收到的答复；已执行的工具动作仍有效，不重复执行。' } } : {}),
    senderId: event.userId ?? null, senderIsConfiguredOwner: options.owner !== null && event.userId === options.owner,
    participation, ...(groupParticipation ? { groupParticipation } : {}),
    unread: options.unread ? { readThrough: options.unread.readThrough, through: options.unread.through,
      count: options.unread.ids.length, included: recent.filter(item => item.unread).length + (options.unread.ids.includes(event.id) ? 1 : 0),
      partial: options.unread.partial || historyTruncated } : null,
    recent, quoted, memory: options.memory ?? null, tools: options.tools ? { available: options.tools.available, tools: options.tools.tools.map(tool => ({ name: tool.name })), reason: options.tools.reason } : { available: false, tools: [] }, output: options.output ?? null, historyTruncated, currentTruncated });

  function build(length: number): readonly MessageContent[] {
    const parts: MessageContent[] = [];
    const context = `会话事实：\n${envelope(length < text.length)}`;
    for (let offset = 0; offset < context.length; offset += 8_000) parts.push({ type: 'text', text: context.slice(offset, offset + 8_000) });
    const current = `当前消息：\n${text.slice(0, length)}${length < text.length ? '\n[当前消息超出输入预算，部分内容未提供]' : ''}`;
    for (let offset = 0; offset < current.length; offset += 8_000) parts.push({ type: 'text', text: current.slice(offset, offset + 8_000) });
    return parts;
  }
  let length = Math.min(text.length, 16_000);
  let parts = build(length);
  const imageParts = images.map(assetId => ({ type: 'image' as const, assetId }));
  while (Buffer.byteLength(JSON.stringify([...parts, ...imageParts]), 'utf8') > 60 * 1024 || parts.length + imageParts.length > 8) {
    assert(length > 0, 'INVALID_INPUT_BUDGET', 'Context metadata exceeds the input budget.');
    length = Math.floor(length * 0.8);
    parts = build(length);
  }
  return normalizeContent([...parts, ...imageParts]);
}
