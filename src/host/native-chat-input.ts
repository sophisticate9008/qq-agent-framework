import { normalizeContent } from '../core/content.ts';
import { assert } from '../core/values.ts';
import type { FrameworkEvent, MessageContent } from '../core/types.ts';
import type { HistoryMessage } from './history.ts';
import type { InboundMessage } from './types.ts';
import type { NativeMemoryContext } from '../contracts/native-memory.ts';
import { normalizeSenderDisplayName } from '../contracts/sender-display-name.ts';

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
  // Only a real call activates the group. Our own replies cannot keep the entire
  // group awake indefinitely while people have moved on to another conversation.
  const activatedAt = options.activatedAt ?? -Infinity;
  if (options.continuationMs > 0 && now >= activatedAt && now - activatedAt <= options.continuationMs) return 'continuation';
  return 'ambient';
}

interface NativeMessageAddressing {
  readonly target: 'assistant' | 'others' | 'mixed' | 'unspecified' | 'unknown';
  readonly mentions: readonly string[];
  readonly replies: readonly { readonly id: string; readonly actor: string | null }[];
}
/** Recipient facts only; neither proximity nor the author of a previous message proves a conversational target. */
export function nativeMessageAddressing(content: readonly MessageContent[], history: readonly HistoryMessage[], options: {
  readonly selfId?: string; readonly addressed?: boolean; readonly quotedMessages?: readonly HistoryMessage[];
} = {}): NativeMessageAddressing {
  const mentions = [...new Set(content.flatMap(part => part.type === 'mention' ? [part.userId] : []))].slice(0, 32);
  const replies = content.filter(part => part.type === 'reply').slice(0, 4).map(part => ({ id: part.messageId,
    actor: history.find(entry => entry.id === part.messageId)?.actor
      ?? options.quotedMessages?.find(entry => entry.id === part.messageId)?.actor ?? null }));
  const assistant = options.addressed === true || mentions.some(id => id === options.selfId) || replies.some(reply => reply.actor === 'assistant');
  const others = mentions.some(id => id !== options.selfId) || replies.some(reply => reply.actor !== null && reply.actor !== 'assistant');
  return { target: assistant ? others ? 'mixed' : 'assistant' : others ? 'others' : replies.some(reply => reply.actor === null) ? 'unknown' : 'unspecified',
    mentions, replies };
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
  readonly selfId?: string;
  readonly partial: boolean;
  readonly attachImages?: boolean;
  readonly maxHistoryCharacters?: number;
  readonly participation?: NativeParticipationReason;
  readonly groupWake?: readonly { readonly messageId: string; readonly actor: string; readonly reason: NativeParticipationReason }[];
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
  const participation = options.participation ?? (event.data.directed === true ? 'direct' : 'ambient');
  const group = event.conversationId.startsWith('group:');
  const addressedMessageIds = [...new Set([
    ...(['direct', 'reply'].includes(participation) ? [event.id] : []),
    ...(options.groupWake ?? []).filter(item => item.reason === 'direct' || item.reason === 'reply').map(item => item.messageId),
  ])].slice(-16);
  const addressing = (content: readonly MessageContent[], id: string) => nativeMessageAddressing(content, history,
    { selfId: options.selfId, addressed: addressedMessageIds.includes(id), quotedMessages: options.quotedMessages });
  const currentAddressing = addressing(original, event.id);
  // Observation is not an instruction to analyze every picture posted by a third
  // party or another bot. Relevant images remain available through normal media tools.
  const observeOnly = group && (!['direct', 'reply', 'nickname'].includes(participation) || currentAddressing.target === 'others');
  const images = options.attachImages && !observeOnly
    ? [...new Set(original.filter(part => part.type === 'image').map(part => part.assetId))].slice(0, 4) : [];
  const text = contentText(original, new Set(images));
  const currentTime = history.find(message => message.id === event.id)?.receivedAt;
  const recentWindow = currentTime === undefined ? [] : history.filter(message => message.receivedAt <= currentTime
    && message.receivedAt > currentTime - 120_000);
  const groupParticipation = group ? {
    mode: participation === 'direct' || participation === 'reply'
      || options.groupWake?.some(item => item.reason === 'direct' || item.reason === 'reply') ? 'addressed' : 'observe-and-select',
    currentAddressing, addressedMessageIds,
    sentMessagesInTwoMinutes: recentWindow.filter(message => message.actor === 'assistant').length,
    receivedMessagesInTwoMinutes: recentWindow.filter(message => message.actor !== 'assistant' && message.actor !== 'system').length,
    speakersInTwoMinutes: new Set(recentWindow.filter(message => message.actor !== 'assistant' && message.actor !== 'system').map(message => message.actor)).size
  } : undefined;
  const recent: { id: string; actor: string; text: string; truncated: boolean; unread: boolean; addressing?: NativeMessageAddressing }[] = [];
  let size = 0;
  let historyTruncated = options.partial;
  // DSH owns the continuous conversation. Only forward messages it has not seen.
  const unreadIds = options.unread ? new Set(options.unread.ids) : null;
  for (const entry of history.filter(entry => entry.id !== event.id && entry.actor !== 'assistant'
    && entry.actor !== 'system' && (unreadIds === null || unreadIds.has(entry.id))).slice().reverse()) {
    const full = contentText(entry.content);
    const item = { id: entry.id, actor: entry.actor, text: full.slice(0, 800), truncated: full.length > 800,
      unread: options.unread?.ids.includes(entry.id) ?? false,
      ...(group && entry.content.some(part => part.type === 'reply' || part.type === 'mention') ? { addressing: addressing(entry.content, entry.id) } : {}) };
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
  // Names are scoped observations, never lookup keys or authorization facts. Include each relevant
  // account once instead of repeating its display text on every history and quote item.
  const displayNames = new Map<string, string>();
  for (const entry of [...(options.quotedMessages ?? []), ...history]) {
    const displayName = normalizeSenderDisplayName(entry.displayName);
    if (displayName !== undefined && entry.actor !== 'assistant' && entry.actor !== 'system') displayNames.set(entry.actor, displayName);
  }
  const currentDisplayName = normalizeSenderDisplayName(event.data.senderDisplayName);
  if (event.userId && currentDisplayName !== undefined) displayNames.set(event.userId, currentDisplayName);
  const relevantActors = [...new Set([event.userId, ...recent.slice().reverse().map(item => item.actor),
    ...quoted.map(item => item.actor),
    ...currentAddressing.mentions, ...currentAddressing.replies.map(item => item.actor),
    ...recent.flatMap(item => [...(item.addressing?.mentions ?? []), ...(item.addressing?.replies.map(reply => reply.actor) ?? [])]),
    ...history.filter(item => options.unsentReplyMessageIds?.includes(item.id)).slice(-4).map(item => item.actor),
    ...(options.groupWake?.map(item => item.actor) ?? [])])]
    .filter((actor): actor is string => typeof actor === 'string' && actor !== 'assistant' && actor !== 'system' && actor !== options.selfId);
  const participants = relevantActors.slice(0, 32).map(userId => ({ userId, displayName: displayNames.get(userId) ?? null }));
  const envelope = (currentTruncated: boolean) => JSON.stringify({ schema: 1, conversationId: event.conversationId, messageId: event.id,
    ...(options.sentWhileQueued?.length ? { replyTiming: {
      sentAfterCurrentMessage: options.sentWhileQueued.slice(-4).map(message => ({ id: message.id, text: contentText(message.content).slice(0, 200) })),
      note: '当前消息先到达，以上回复随后才发送。模型处理顺序不等于群聊发言顺序，不能把当前消息当成对这些回复的反馈。'
    } } : {}),
    ...(options.unsentReplyMessageIds?.length ? { replyDelivery: { unsentFor: options.unsentReplyMessageIds,
      requests: history.filter(item => options.unsentReplyMessageIds?.includes(item.id)).slice(-4)
        .map(item => ({ id: item.id, actor: item.actor, text: contentText(item.content).slice(0, 400) })),
      note: '这些旧消息的模型回复尚未发送，因为会话有新消息需要结合理解。先合并原请求与后续纠正，保留数量等未被修改的要求；其他人的顺嘴闲聊不是新的答复任务。此前模型回复未送达，不能把其中新编的玩笑、称呼、约定或事实当成双方共同语境，也不能把后续消息当作对这些草稿的回应。重新依据真实用户消息与已确认发送的内容判断；已执行的其他工具动作仍以真实结果为准，不重复执行。' } } : {}),
    senderId: event.userId ?? null, senderIsConfiguredOwner: options.owner !== null && event.userId === options.owner,
    participants, ...(relevantActors.length > participants.length ? { participantsLimited: true } : {}),
    participation, ...(groupParticipation ? { groupParticipation, groupWake: options.groupWake ?? [] } : {}),
    unread: options.unread ? { readThrough: options.unread.readThrough, through: options.unread.through,
      count: options.unread.ids.length, included: recent.filter(item => item.unread).length + (options.unread.ids.includes(event.id) ? 1 : 0),
      partial: options.unread.partial || historyTruncated } : null,
    recent, quoted, memory: options.memory ?? null, tools: options.tools ? { available: options.tools.available, tools: options.tools.tools.map(tool => ({ name: tool.name })), reason: options.tools.reason } : { available: false, tools: [] }, output: options.output ? { ...options.output, sendMode: 'explicit-tool', sendTool: 'qaf_reply' } : null, historyTruncated, currentTruncated });

  function build(length: number): readonly MessageContent[] {
    const parts: MessageContent[] = [];
    const context = `会话事实：\n${envelope(length < text.length)}`;
    for (let offset = 0; offset < context.length; offset += 8_000) parts.push({ type: 'text', text: context.slice(offset, offset + 8_000) });
    const groupMessage = event.conversationId.startsWith('group:');
    // Keep the current speaker beside their words as well as in the structured facts.
    // A shared DSH user role does not imply every group message is from the same person.
    const speaker = groupMessage ? `发言者：${JSON.stringify({ userId: event.userId ?? null,
      displayName: event.userId ? displayNames.get(event.userId) ?? null : null })}\n` : '';
    const current = `${groupMessage ? '本批最新消息（结合未读消息选择回应对象）' : '当前消息'}：\n${speaker}${text.slice(0, length)}${length < text.length ? '\n[当前消息超出输入预算，部分内容未提供]' : ''}`;
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
