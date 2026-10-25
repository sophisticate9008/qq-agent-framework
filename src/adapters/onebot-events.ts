import { createHash } from 'node:crypto';
import type { FrameworkEvent, JsonObject } from '../core/types.ts';
import { isRecord, snapshot } from '../core/values.ts';

export const ONEBOT_PROTOCOL_EVENT_TYPES = Object.freeze([
  'protocol.message.recalled', 'protocol.group.member.changed', 'protocol.group.admin.changed',
  'protocol.group.ban.changed', 'protocol.group.file.uploaded', 'protocol.friend.added',
  'protocol.group.poked', 'protocol.request.received', 'protocol.connection.lifecycle', 'protocol.connection.heartbeat',
] as const);
export type OneBotProtocolEventType = typeof ONEBOT_PROTOCOL_EVENT_TYPES[number];
export interface OneBotProtocolEvent extends FrameworkEvent { readonly type: OneBotProtocolEventType }

function identifier(value: unknown, signed = false): string | null {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === 'string' && id.length <= 32 && (signed ? /^-?[1-9]\d*$/ : /^[1-9]\d*$/).test(id) ? id : null;
}
function boundedText(value: unknown, maximum: number, empty = false): string | null {
  return typeof value === 'string' && (empty || value.length > 0) && value.length <= maximum
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value : null;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/** Decode authenticated protocol facts. No field from the wire establishes owner identity or effect permission. */
export function normalizeOneBotProtocolEvent(value: unknown, context: {
  readonly selfId: string;
  readonly receivedAt: number;
  readonly accountId?: string;
}): Readonly<OneBotProtocolEvent> | null {
  if (!isRecord(value) || identifier(context.selfId) === null || identifier(value.self_id) !== context.selfId
    || !integer(context.receivedAt) || !integer(value.time, Math.floor(Number.MAX_SAFE_INTEGER / 1000))) return null;
  const accountId = context.accountId ?? context.selfId;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(accountId)) return null;
  const userId = identifier(value.user_id);
  const groupId = identifier(value.group_id);
  const operatorId = identifier(value.operator_id);
  let type: OneBotProtocolEventType;
  let conversationId: string;
  let details: JsonObject;
  if (value.post_type === 'notice') {
    if (value.notice_type === 'group_recall' || value.notice_type === 'friend_recall') {
      const messageId = identifier(value.message_id, true);
      if (userId === null || messageId === null || value.notice_type === 'group_recall' && (groupId === null || operatorId === null)) return null;
      type = 'protocol.message.recalled';
      conversationId = value.notice_type === 'group_recall' ? `group:${groupId}` : `private:${userId}`;
      details = { messageId, senderId: userId, ...(value.notice_type === 'group_recall' ? { operatorId: operatorId! } : {}) };
    } else if (value.notice_type === 'group_increase' || value.notice_type === 'group_decrease') {
      const allowed = value.notice_type === 'group_increase' ? ['approve', 'invite'] : ['leave', 'kick', 'kick_me'];
      if (userId === null || groupId === null || operatorId === null || !allowed.includes(String(value.sub_type))
        || value.sub_type === 'kick_me' && userId !== context.selfId) return null;
      type = 'protocol.group.member.changed'; conversationId = `group:${groupId}`;
      details = { change: value.notice_type === 'group_increase' ? 'joined' : 'left',
        reason: String(value.sub_type), memberId: userId, operatorId, affectsSelf: userId === context.selfId };
    } else if (value.notice_type === 'group_admin') {
      if (userId === null || groupId === null || !['set', 'unset'].includes(String(value.sub_type))) return null;
      type = 'protocol.group.admin.changed'; conversationId = `group:${groupId}`;
      details = { memberId: userId, enabled: value.sub_type === 'set' };
    } else if (value.notice_type === 'group_ban') {
      if (userId === null || groupId === null || operatorId === null || !integer(value.duration, 2_147_483_647)
        || !['ban', 'lift_ban'].includes(String(value.sub_type))) return null;
      type = 'protocol.group.ban.changed'; conversationId = `group:${groupId}`;
      details = { memberId: userId, operatorId, enabled: value.sub_type === 'ban', durationSeconds: value.duration };
    } else if (value.notice_type === 'friend_add') {
      if (userId === null) return null;
      type = 'protocol.friend.added'; conversationId = `private:${userId}`; details = { friendId: userId };
    } else if (value.notice_type === 'group_upload') {
      const file = isRecord(value.file) ? value.file : null;
      if (groupId === null || userId === null || file === null || boundedText(file.id, 512) === null
        || boundedText(file.name, 255) === null || !integer(file.size)) return null;
      type = 'protocol.group.file.uploaded'; conversationId = `group:${groupId}`;
      details = { file: { id: String(file.id), name: String(file.name), size: file.size }, senderId: userId };
    } else if (value.notice_type === 'notify' && value.sub_type === 'poke') {
      const targetId = identifier(value.target_id);
      if (groupId === null || userId === null || targetId === null || userId === context.selfId) return null;
      type = 'protocol.group.poked'; conversationId = `group:${groupId}`;
      details = { senderId: userId, targetId, directedToSelf: targetId === context.selfId };
    } else return null;
  } else if (value.post_type === 'request') {
    if (userId === null || boundedText(value.flag, 512) === null || boundedText(value.comment, 4096, true) === null) return null;
    if (value.request_type === 'group') {
      if (groupId === null || !['add', 'invite'].includes(String(value.sub_type))) return null;
      conversationId = `group:${groupId}`;
    } else if (value.request_type === 'friend') conversationId = `private:${userId}`;
    else return null;
    type = 'protocol.request.received';
    details = { kind: String(value.request_type), ...(value.request_type === 'group' ? { subType: String(value.sub_type) } : {}),
      requesterId: userId, flag: String(value.flag), comment: String(value.comment), authorizationGranted: false };
  } else if (value.post_type === 'meta_event') {
    conversationId = `protocol:onebot:${accountId}`;
    if (value.meta_event_type === 'lifecycle') {
      if (!['enable', 'disable', 'connect'].includes(String(value.sub_type))) return null;
      type = 'protocol.connection.lifecycle'; details = { phase: String(value.sub_type) };
    } else if (value.meta_event_type === 'heartbeat') {
      if (!integer(value.interval, 3_600_000) || value.interval === 0 || !isRecord(value.status)
        || typeof value.status.online !== 'boolean' || typeof value.status.good !== 'boolean') return null;
      type = 'protocol.connection.heartbeat'; details = { intervalMs: value.interval, online: value.status.online, good: value.status.good };
    } else return null;
  } else return null;
  const occurredAt = value.time * 1000;
  const id = `onebot:${createHash('sha256').update(JSON.stringify([accountId, context.selfId, type, occurredAt, conversationId, details])).digest('hex')}`;
  return snapshot({ id, type, conversationId, ...(userId === null ? {} : { userId }),
    data: { schemaVersion: 1, protocol: 'onebot.v11', accountId, selfId: context.selfId, conversationId,
      occurredAt, ...details } });
}

export function validateOneBotProtocolEventData(type: string, data: unknown): boolean {
  if (!isRecord(data) || data.schemaVersion !== 1 || data.protocol !== 'onebot.v11'
    || typeof data.selfId !== 'string' || typeof data.accountId !== 'string' || typeof data.conversationId !== 'string'
    || !integer(data.occurredAt) || data.occurredAt % 1000 !== 0) return false;
  const group = /^group:([1-9]\d{0,31})$/.exec(data.conversationId);
  const raw: Record<string, unknown> = { self_id: data.selfId, time: data.occurredAt / 1000,
    ...(group ? { group_id: group[1] } : {}) };
  if (type === 'protocol.message.recalled') Object.assign(raw, { post_type: 'notice', notice_type: group ? 'group_recall' : 'friend_recall',
    user_id: data.senderId, operator_id: data.operatorId, message_id: data.messageId });
  else if (type === 'protocol.group.member.changed') Object.assign(raw, { post_type: 'notice',
    notice_type: data.change === 'joined' ? 'group_increase' : 'group_decrease', sub_type: data.reason, user_id: data.memberId, operator_id: data.operatorId });
  else if (type === 'protocol.group.admin.changed') Object.assign(raw, { post_type: 'notice', notice_type: 'group_admin',
    sub_type: data.enabled === true ? 'set' : 'unset', user_id: data.memberId });
  else if (type === 'protocol.group.ban.changed') Object.assign(raw, { post_type: 'notice', notice_type: 'group_ban',
    sub_type: data.enabled === true ? 'ban' : 'lift_ban', user_id: data.memberId, operator_id: data.operatorId, duration: data.durationSeconds });
  else if (type === 'protocol.group.file.uploaded') Object.assign(raw, { post_type: 'notice', notice_type: 'group_upload', user_id: data.senderId, file: data.file });
  else if (type === 'protocol.friend.added') Object.assign(raw, { post_type: 'notice', notice_type: 'friend_add', user_id: data.friendId });
  else if (type === 'protocol.group.poked') Object.assign(raw, { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: data.senderId, target_id: data.targetId });
  else if (type === 'protocol.request.received') Object.assign(raw, { post_type: 'request', request_type: data.kind,
    sub_type: data.subType, user_id: data.requesterId, flag: data.flag, comment: data.comment });
  else if (type === 'protocol.connection.lifecycle') Object.assign(raw, { post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: data.phase });
  else if (type === 'protocol.connection.heartbeat') Object.assign(raw, { post_type: 'meta_event', meta_event_type: 'heartbeat',
    interval: data.intervalMs, status: { good: data.good, online: data.online } });
  else return false;
  const normalized = normalizeOneBotProtocolEvent(raw, { selfId: data.selfId, accountId: data.accountId, receivedAt: data.occurredAt });
  if (!normalized || normalized.type !== type) return false;
  function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, entry: unknown) => isRecord(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry);
  }
  try { const encoded = canonical(data); return encoded.length <= 64 * 1024 && encoded === canonical(normalized.data); }
  catch { return false; }
}

export function createOneBotProtocolEventValidators(scope: { readonly accountId: string; readonly selfId: string }):
Readonly<Record<OneBotProtocolEventType, (data: JsonObject) => boolean>> {
  const validators = Object.fromEntries(ONEBOT_PROTOCOL_EVENT_TYPES.map(type => [type, (data: JsonObject) =>
    data.accountId === scope.accountId && data.selfId === scope.selfId && validateOneBotProtocolEventData(type, data)])) as Record<OneBotProtocolEventType, (data: JsonObject) => boolean>;
  return Object.freeze(validators);
}
