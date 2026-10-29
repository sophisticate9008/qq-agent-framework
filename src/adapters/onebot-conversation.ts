import type { JsonObject } from '../core/types.ts';
import { isRecord } from '../core/values.ts';
import { decodeOneBotMessageSegments, type OneBotReadResult } from './onebot-actions.ts';
import { classifyOneBotResponse } from './onebot-response.ts';
import { normalizeSenderDisplayName } from '../contracts/sender-display-name.ts';

export interface OneBotConversationMember { readonly userId: string; readonly nickname: string | null; readonly card: string | null; readonly role: string | null }
export interface OneBotConversationGroup { readonly groupId: string; readonly name: string | null; readonly memberCount: number | null; readonly maxMemberCount: number | null }
export interface OneBotConversationMessage { readonly messageId: string; readonly userId: string; readonly displayName?: string; readonly conversationId: string; readonly time: number | null; readonly message: readonly JsonObject[] }
export interface OneBotConversationPort {
  avatar?(request: { readonly userId: string; readonly signal: AbortSignal }): Promise<OneBotReadResult<{ readonly userId: string; readonly url: string }>>;
  groupInfo(request: { readonly groupId: string; readonly signal: AbortSignal }): Promise<OneBotReadResult<OneBotConversationGroup>>;
  groupMembers(request: { readonly groupId: string; readonly signal: AbortSignal }): Promise<OneBotReadResult<readonly OneBotConversationMember[]>>;
  groupMember?(request: { readonly groupId: string; readonly userId: string; readonly signal: AbortSignal }): Promise<OneBotReadResult<OneBotConversationMember>>;
  setGroupCard?(request: { readonly groupId: string; readonly userId: string; readonly card: string; readonly signal: AbortSignal }): Promise<OneBotReadResult<{ readonly acknowledged: true }>>;
  groupHistory(request: { readonly groupId: string; readonly limit: number; readonly signal: AbortSignal }): Promise<OneBotReadResult<readonly OneBotConversationMessage[]>>;
  privateHistory(request: { readonly userId: string; readonly selfId: string; readonly limit: number; readonly signal: AbortSignal }): Promise<OneBotReadResult<readonly OneBotConversationMessage[]>>;
  groups(request: { readonly signal: AbortSignal }): Promise<OneBotReadResult<readonly OneBotConversationGroup[]>>;
  friends(request: { readonly signal: AbortSignal }): Promise<OneBotReadResult<readonly { readonly userId: string; readonly nickname: string | null; readonly remark: string | null }[]>>;
  poke(request: { readonly conversationId: string; readonly userId: string; readonly signal: AbortSignal }): Promise<OneBotReadResult<{ readonly acknowledged: true }>>;
  reaction?(request: { readonly messageId: string; readonly emojiId: string; readonly add: boolean; readonly signal: AbortSignal }): Promise<OneBotReadResult<{ readonly acknowledged: true }>>;
  recall(request: { readonly messageId: string; readonly signal: AbortSignal }): Promise<OneBotReadResult<{ readonly acknowledged: true }>>;
}

function text(value: unknown, max = 255): string | null {
  return typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}
function id(value: unknown, signed = false): string | null {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof result === 'string' && result.length <= 32 && (signed ? /^-?[1-9]\d*$/ : /^[1-9]\d*$/).test(result) ? result : null;
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** QQ's public avatar source; the host checks conversation membership before requesting it. */
export function qqAvatarUrl(userId: string): string {
  if (!id(userId)) throw new TypeError('Invalid QQ avatar account');
  return `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=640`;
}
function group(value: unknown, expected?: string): OneBotConversationGroup | null {
  if (!isRecord(value)) return null;
  const groupId = id(value.group_id);
  if (groupId === null || expected !== undefined && groupId !== expected) return null;
  return { groupId, name: text(value.group_name), memberCount: count(value.member_count), maxMemberCount: count(value.max_member_count) };
}
function list<Value>(value: unknown, decode: (item: unknown) => Value | null): readonly Value[] | null {
  if (!Array.isArray(value) || value.length > 10000) return null;
  const output: Value[] = [];
  for (const item of value) { const decoded = decode(item); if (decoded === null) return null; output.push(decoded); }
  return output;
}
function message(value: unknown, groupId: string): OneBotConversationMessage | null {
  if (!isRecord(value) || !isRecord(value.sender) || value.group_id !== undefined && id(value.group_id) !== groupId
    || value.message_type !== undefined && value.message_type !== 'group') return null;
  const messageId = id(value.message_id, true);
  const userId = id(value.sender.user_id ?? value.user_id);
  const content = decodeOneBotMessageSegments(value.message);
  if (!messageId || !userId || !content) return null;
  const displayName = normalizeSenderDisplayName(value.sender.card) ?? normalizeSenderDisplayName(value.sender.nickname);
  return { messageId, userId, conversationId: `group:${groupId}`, time: count(value.time), message: content,
    ...(displayName === undefined ? {} : { displayName }) };
}
function privateMessage(value: unknown, peerId: string, selfId: string): OneBotConversationMessage | null {
  if (!isRecord(value) || !isRecord(value.sender) || id(value.group_id) !== null
    || value.message_type !== undefined && value.message_type !== 'private'
    || value.self_id !== undefined && id(value.self_id) !== selfId
    || value.peer_id !== undefined && id(value.peer_id) !== peerId) return null;
  const messageId = id(value.message_id, true);
  const userId = id(value.sender.user_id);
  const content = decodeOneBotMessageSegments(value.message);
  if (!messageId || !userId || !content || userId !== peerId && userId !== selfId
    || [value.user_id, value.target_id].some(field => field !== undefined && id(field) !== peerId && id(field) !== selfId)) return null;
  // The fixed user_id history request supplies the peer for self-authored messages.
  // A general get_msg response has no such provenance and cannot use this rule.
  const displayName = normalizeSenderDisplayName(value.sender.nickname);
  return { messageId, userId, conversationId: `private:${peerId}`, time: count(value.time), message: content,
    ...(displayName === undefined ? {} : { displayName }) };
}

/** Fixed basic QQ actions shared by installed NapCat and SnowLuma. No model-controlled action names. */
export function createOneBotConversationPort(options: {
  readonly endpoint: string; readonly accessToken?: string; readonly timeoutMs?: number; readonly fetch?: typeof globalThis.fetch;
}): OneBotConversationPort {
  const base = new URL(options.endpoint.endsWith('/') ? options.endpoint : `${options.endpoint}/`);
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || /[\s\\?#]/.test(options.endpoint) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || options.accessToken !== undefined && !/^[\x21-\x7e]{1,4096}$/.test(options.accessToken)) throw new TypeError('Invalid conversation port configuration');
  async function invoke<Value>(action: string, parameters: JsonObject | null, signal: AbortSignal,
    decode: (value: unknown) => Value | null): Promise<OneBotReadResult<Value>> {
    if (!parameters) return { status: 'rejected', code: 'ONEBOT_CONVERSATION_INVALID_INPUT' };
    if (signal.aborted) return { status: 'rejected', code: 'ONEBOT_CONVERSATION_CANCELLED' };
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(new URL(action, base), { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}) },
        body: JSON.stringify(parameters), signal: combined });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown',
          code: response.status === 404 ? 'ONEBOT_CONVERSATION_UNSUPPORTED' : 'ONEBOT_CONVERSATION_HTTP_FAILED' };
      }
      const reader = response.body?.getReader();
      if (!reader) return { status: 'unknown', code: 'ONEBOT_CONVERSATION_INVALID_RESPONSE' };
      const chunks: Uint8Array[] = [];
      let size = 0;
      let body: unknown;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2 * 1024 * 1024) return { status: 'unknown', code: 'ONEBOT_CONVERSATION_RESPONSE_TOO_LARGE' };
          chunks.push(part.value);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const status = classifyOneBotResponse(body);
      if (status !== 'confirmed') return { status, code: 'ONEBOT_CONVERSATION_NOT_CONFIRMED' };
      const data = decode(isRecord(body) ? body.data : undefined);
      return data === null ? { status: 'unknown', code: 'ONEBOT_CONVERSATION_INVALID_RESPONSE' } : { status: 'confirmed', data };
    } catch { return { status: 'unknown', code: combined.aborted ? 'ONEBOT_CONVERSATION_ABORTED_UNKNOWN' : 'ONEBOT_CONVERSATION_TRANSPORT_UNKNOWN' }; }
  }
  return Object.freeze<OneBotConversationPort>({
    async avatar(request) {
      if (!id(request.userId)) return { status: 'rejected', code: 'ONEBOT_CONVERSATION_INVALID_INPUT' };
      if (request.signal.aborted) return { status: 'rejected', code: 'ONEBOT_CONVERSATION_CANCELLED' };
      // This resolves the source only. The host downloads and validates image bytes before returning a resource.
      return { status: 'confirmed', data: { userId: request.userId, url: qqAvatarUrl(request.userId) } };
    },
    groupInfo: request => invoke('get_group_info', id(request.groupId) ? { group_id: request.groupId, no_cache: true } : null,
      request.signal, value => group(value, request.groupId)),
    groupMember: request => invoke('get_group_member_info', id(request.groupId) && id(request.userId)
      ? { group_id: request.groupId, user_id: request.userId, no_cache: true } : null,
      request.signal, value => {
        if (!isRecord(value) || id(value.user_id) !== request.userId
          || value.group_id !== undefined && id(value.group_id) !== request.groupId) return null;
        return { userId: request.userId, nickname: text(value.nickname), card: text(value.card), role: text(value.role, 32) };
      }),
    setGroupCard: request => invoke('set_group_card', id(request.groupId) && id(request.userId)
      && typeof request.card === 'string' && [...request.card].length >= 1 && [...request.card].length <= 30
      && request.card.trim() === request.card && !/[\x00-\x1f\x7f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(request.card)
      ? { group_id: request.groupId, user_id: request.userId, card: request.card } : null,
      request.signal, () => ({ acknowledged: true as const })),
    groupMembers: request => invoke('get_group_member_list', id(request.groupId) ? { group_id: request.groupId, no_cache: true } : null,
      request.signal, value => list(value, entry => {
        if (!isRecord(entry) || entry.group_id !== undefined && id(entry.group_id) !== request.groupId) return null;
        const userId = id(entry.user_id);
        return userId ? { userId, nickname: text(entry.nickname), card: text(entry.card), role: text(entry.role, 32) } : null;
      })),
    groupHistory: request => invoke('get_group_msg_history', id(request.groupId) && Number.isSafeInteger(request.limit)
      && request.limit >= 1 && request.limit <= 10 ? { group_id: request.groupId, count: request.limit } : null,
      request.signal, value => {
        if (!isRecord(value) || !Array.isArray(value.messages) || value.messages.length > 100) return null;
        return list(value.messages.slice(-request.limit), entry => message(entry, request.groupId));
      }),
    privateHistory: request => invoke('get_friend_msg_history', id(request.userId) && id(request.selfId) && Number.isSafeInteger(request.limit)
      && request.limit >= 1 && request.limit <= 10 ? { user_id: request.userId, count: request.limit } : null,
      request.signal, value => {
        if (!isRecord(value) || !Array.isArray(value.messages) || value.messages.length > 100) return null;
        return list(value.messages.slice(-request.limit), entry => privateMessage(entry, request.userId, request.selfId));
      }),
    groups: request => invoke('get_group_list', {}, request.signal, value => list(value, entry => group(entry))),
    friends: request => invoke('get_friend_list', {}, request.signal, value => list(value, entry => {
      if (!isRecord(entry)) return null;
      const userId = id(entry.user_id);
      return userId ? { userId, nickname: text(entry.nickname), remark: text(entry.remark) } : null;
    })),
    poke: request => {
      const scope = /^(group|private):([1-9]\d{0,31})$/.exec(request.conversationId);
      const valid = scope && id(request.userId) && (scope[1] === 'group' || request.userId === scope[2]);
      return invoke(scope?.[1] === 'group' ? 'group_poke' : 'friend_poke', valid
        ? { user_id: request.userId, ...(scope[1] === 'group' ? { group_id: scope[2]! } : {}) } : null,
      request.signal, () => ({ acknowledged: true as const }));
    },
    reaction: request => invoke('set_msg_emoji_like', id(request.messageId, true)
      && typeof request.emojiId === 'string' && /^(0|[1-9]\d{0,31})$/.test(request.emojiId) && typeof request.add === 'boolean'
      ? { message_id: request.messageId, emoji_id: request.emojiId, set: request.add } : null,
      request.signal, value => value === false || isRecord(value) && (value.result === false
        || typeof value.result === 'number' && value.result !== 0) ? null : ({ acknowledged: true as const })),
    recall: request => invoke('delete_msg', id(request.messageId, true) ? { message_id: request.messageId } : null,
      request.signal, () => ({ acknowledged: true as const })),
  });
}
