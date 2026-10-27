import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOneBotProtocolEvent, projectOneBotNoticeForChat, validateOneBotProtocolEventData } from '../src/adapters/onebot-events.ts';
import { normalizeOneBotMessage, type OneBotIncomingAsset } from '../src/adapters/onebot.ts';
import { nativeParticipation } from '../src/host/native-chat-input.ts';

const selfId = '999';
const base = { self_id: 999, time: 1000, post_type: 'notice', user_id: 123 };

test('notice adapter preserves private and group poke senders, directs only bot-targeted pokes and ignores self echoes', async () => {
  for (const channel of [{}, { group_id: 456 }]) {
    const raw = { ...base, ...channel, notice_type: 'notify', sub_type: 'poke', target_id: 999, isOwner: true };
    const protocol = normalizeOneBotProtocolEvent(raw, { selfId, receivedAt: 1000001 });
    assert(protocol); assert.equal(validateOneBotProtocolEventData(protocol.type, protocol.data), true);
    assert.equal(protocol.type, 'group_id' in channel ? 'protocol.group.poked' : 'protocol.private.poked');
    const projected = projectOneBotNoticeForChat(protocol); assert(projected);
    const message = await normalizeOneBotMessage(projected, { selfId }); assert(message);
    assert.equal(message.userId, '123'); assert.equal(message.directed, true); assert.equal(message.isSelf, false);
    assert.match(message.id, /^onebot-notice:[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(message, 'isOwner'), false);
    const replay = await normalizeOneBotMessage(raw, { selfId, now: () => 2000000 });
    assert.equal(replay?.id, message.id, 'Reconnect or receive time cannot invent another notice identity');
    assert.equal(await normalizeOneBotMessage({ ...raw, target_id: 124 }, { selfId }), null);
    assert.equal(await normalizeOneBotMessage({ ...raw, user_id: 999 }, { selfId }), null);
    assert.equal(await normalizeOneBotMessage({ ...raw, self_id: 998 }, { selfId }), null);
  }
});

test('notice adapter registers group uploads with opaque file identity and bus ID while retaining ordinary wake rules', async () => {
  const registered: OneBotIncomingAsset[] = [];
  const raw = { ...base, group_id: 456, notice_type: 'group_upload', file: { id: 'opaque-group-file', name: 'notes.txt', size: 42, busid: 102 } };
  const protocol = normalizeOneBotProtocolEvent(raw, { selfId, receivedAt: 1000001 }); assert(protocol);
  assert.equal(validateOneBotProtocolEventData(protocol.type, protocol.data), true);
  const projection = projectOneBotNoticeForChat(protocol); assert(projection);
  const options = { selfId, registerIncomingAsset(asset: OneBotIncomingAsset) { registered.push(asset); return 'registered-group-file'; } };
  const message = await normalizeOneBotMessage(projection, options); assert(message);
  assert.equal(message.userId, '123'); assert.equal(message.conversationId, 'group:456'); assert.equal(message.directed, false);
  assert.deepEqual(registered[0], { kind: 'file', messageId: message.id, conversationId: 'group:456', name: 'notes.txt',
    source: { id: 'opaque-group-file', busId: 102 } });
  assert.deepEqual(message.content.at(-1), { type: 'file', assetId: 'registered-group-file', name: 'notes.txt' });
  assert.equal(nativeParticipation(message, [], { names: ['FixtureBot'], continuationMs: 0, wakeOnReply: true }, 1000001), 'ambient');
  assert.equal(nativeParticipation(message, [], { names: [], continuationMs: 90000, activatedAt: 1000000 }, 1000001), 'continuation');
  assert.equal((await normalizeOneBotMessage(raw, options))?.id, message.id);
  assert.equal(await normalizeOneBotMessage({ ...raw, user_id: 999 }, options), null);
});

test('notice adapter keeps management events outside chat and rejects invalid upload routing metadata', async () => {
  for (const fields of [{ notice_type: 'friend_add' }, { notice_type: 'group_ban', group_id: 456, operator_id: 123, duration: 30, sub_type: 'ban' },
    { notice_type: 'group_recall', group_id: 456, operator_id: 123, message_id: -10 }]) {
    const raw = { ...base, ...fields };
    const protocol = normalizeOneBotProtocolEvent(raw, { selfId, receivedAt: 1000001 }); assert(protocol);
    assert.equal(projectOneBotNoticeForChat(protocol), null);
    assert.equal(await normalizeOneBotMessage(raw, { selfId }), null);
  }
  const file = { id: 'opaque-group-file', name: 'notes.txt', size: 42 };
  assert.equal(await normalizeOneBotMessage({ ...base, group_id: 456, notice_type: 'group_upload', file: { ...file, busid: -1 } }, { selfId }), null);
  assert.equal(await normalizeOneBotMessage({ ...base, group_id: 'invalid', notice_type: 'notify', sub_type: 'poke', target_id: 999 }, { selfId }), null);
});
