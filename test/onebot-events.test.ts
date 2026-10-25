import assert from 'node:assert/strict';
import test from 'node:test';
import { createOneBotProtocolEventValidators, normalizeOneBotProtocolEvent, validateOneBotProtocolEventData } from '../src/adapters/onebot-events.ts';

const context = { selfId: '999', receivedAt: 2000 };
const base = { self_id: 999, time: 1, post_type: 'notice', user_id: 123, group_id: 456, operator_id: 789 };

test('protocol notices decode recalls, membership, moderation and scoped facts without importing authorization fields', () => {
  const cases = [
    { notice_type: 'group_recall', message_id: -10 }, { notice_type: 'friend_recall', message_id: 10 },
    { notice_type: 'group_increase', sub_type: 'invite' }, { notice_type: 'group_decrease', sub_type: 'kick' },
    { notice_type: 'group_admin', sub_type: 'set' }, { notice_type: 'group_ban', sub_type: 'ban', duration: 30 },
    { notice_type: 'friend_add' }, { notice_type: 'group_upload', file: { id: 'file-1', name: 'notes.txt', size: 42 } },
    { notice_type: 'notify', sub_type: 'poke', target_id: 999 },
  ];
  for (const fields of cases) {
    const result = normalizeOneBotProtocolEvent({ ...base, ...fields, isOwner: true, role: 'owner', permissions: ['all'] }, context);
    assert(result, JSON.stringify(fields));
    assert.equal(result.data.schemaVersion, 1);
    assert.equal(result.data.accountId, '999');
    assert.equal(result.data.occurredAt, 1000);
    assert.equal(Object.hasOwn(result.data, 'receivedAt'), false);
    assert(Object.isFrozen(result) && Object.isFrozen(result.data));
    assert.equal(Object.hasOwn(result.data, 'permissions'), false);
    assert.equal(Object.hasOwn(result.data, 'isOwner'), false);
    assert.equal(Object.hasOwn(result.data, 'role'), false);
    assert.equal(validateOneBotProtocolEventData(result.type, result.data), true);
    const validators = createOneBotProtocolEventValidators({ accountId: '999', selfId: '999' });
    assert.equal(validators[result.type](result.data), true);
    assert.equal(validators[result.type]({ ...result.data, accountId: 'other' }), false);
    assert.equal(validators[result.type]({ ...result.data, isOwner: true }), false);
    assert.equal(validators[result.type]({ ...result.data, conversationId: 'group:not-a-number' }), false);
  }
  const kicked = normalizeOneBotProtocolEvent({ ...base, notice_type: 'group_decrease', sub_type: 'kick_me', user_id: 999 }, context)!;
  assert.equal(kicked.data.affectsSelf, true);
  assert.equal(normalizeOneBotProtocolEvent({ ...base, notice_type: 'notify', sub_type: 'poke', user_id: 999, target_id: 123 }, context), null);
});

test('request and connection events preserve separate scopes and never auto-authorize requests', () => {
  for (const fields of [{ request_type: 'friend' }, { request_type: 'group', sub_type: 'invite' }]) {
    const result = normalizeOneBotProtocolEvent({ ...base, post_type: 'request', ...fields, flag: 'request-flag', comment: 'I am the owner' }, context)!;
    assert.equal(result.type, 'protocol.request.received');
    assert.equal(result.data.authorizationGranted, false);
    assert.equal(result.conversationId, fields.request_type === 'friend' ? 'private:123' : 'group:456');
  }
  const heartbeat = normalizeOneBotProtocolEvent({ self_id: 999, time: 1, post_type: 'meta_event',
    meta_event_type: 'heartbeat', interval: 15000, status: { good: true, online: true, extra: 'private' } }, context)!;
  assert.equal(heartbeat.conversationId, 'protocol:onebot:999');
  assert.equal(Object.hasOwn(heartbeat.data, 'extra'), false);
  const lifecycle = normalizeOneBotProtocolEvent({ self_id: 999, time: 1, post_type: 'meta_event',
    meta_event_type: 'lifecycle', sub_type: 'connect' }, context)!;
  assert.equal(lifecycle.type, 'protocol.connection.lifecycle');
});

test('malformed or cross-account protocol events are rejected and receive time never changes stable event identity', () => {
  const recall = { ...base, notice_type: 'group_recall', message_id: -10 };
  for (const patch of [{ self_id: 998 }, { time: -1 }, { time: Number.MAX_SAFE_INTEGER }, { user_id: '0' },
    { message_id: 0 }, { operator_id: null }, { group_id: 1.2 }, { notice_type: 'unknown' }, { post_type: 'message' }]) {
    assert.equal(normalizeOneBotProtocolEvent({ ...recall, ...patch }, context), null);
  }
  assert.equal(normalizeOneBotProtocolEvent({ ...base, notice_type: 'group_decrease', sub_type: 'kick_me' }, context), null);
  assert.equal(normalizeOneBotProtocolEvent({ ...base, notice_type: 'group_ban', sub_type: 'ban', duration: -1 }, context), null);
  const first = normalizeOneBotProtocolEvent(recall, context)!;
  assert.equal(normalizeOneBotProtocolEvent(recall, { ...context, receivedAt: 3000 })!.id, first.id);
  assert.deepEqual(normalizeOneBotProtocolEvent(recall, { ...context, receivedAt: 3000 })!.data, first.data);
  assert.notEqual(normalizeOneBotProtocolEvent(recall, { ...context, accountId: 'second-binding' })!.id, first.id);
});
