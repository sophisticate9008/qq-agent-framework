import assert from 'node:assert/strict';
import test from 'node:test';
import { createOneBotActionPort } from '../src/adapters/onebot-actions.ts';
import { createOneBotConversationPort } from '../src/adapters/onebot-conversation.ts';
import { createOneBotStickerPort } from '../src/adapters/onebot-stickers.ts';
import { normalizeOneBotContent } from '../src/adapters/onebot.ts';
import type { EffectRequest, EffectScope, JsonValue } from '../src/core/types.ts';
import { isRecord } from '../src/core/values.ts';
import { createNativeConversationService } from '../src/host/native-conversation-tools.ts';
import { createNativeMediaRegistry } from '../src/host/native-media.ts';
import { createNativeMessageSources } from '../src/host/native-message-sources.ts';
import { readScopedProtocolMessage } from '../src/host/native-protocol-message.ts';
import { createNativeStickerService } from '../src/host/native-sticker-tools.ts';
import { createDurableTransport } from '../src/host/outbox.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

const signal = () => new AbortController().signal;
const endpoint = 'http://127.0.0.1:1/onebot/';
function confirmed(data: unknown) { return new Response(JSON.stringify({ status: 'ok', retcode: 0, data })); }
function actionOf(input: string | URL | Request): string {
  return new URL(input instanceof Request ? input.url : input.toString()).pathname.split('/').at(-1)!;
}
function asObject(value: JsonValue) { assert(isRecord(value)); return value; }
function scope(eventId = 'source-message', conversationId = 'group:456'): EffectScope {
  return { featureId: 'framework-tools', version: '1.0.0', eventId, conversationId };
}
function sourceFixture() {
  const lifetime = new AbortController();
  const sources = createNativeMessageSources({ owner: '123', signal: lifetime.signal, async validate() {} });
  function request(userId: string, input: JsonValue, eventId = 'source-message'): EffectRequest {
    sources.capture({ id: eventId, userId, conversationId: 'group:456' }, {
      receivedAt: Date.now(), expiresAt: Date.now() + 30000, signal: lifetime.signal,
    });
    return { input, scope: scope(eventId), signal: lifetime.signal };
  }
  return { sources, lifetime, request };
}

test('NapCat face raw objects and nullable decorations survive history and get_msg while missing required IDs remain rejected', async () => {
  let face: Record<string, unknown> = { id: '178', raw: { faceType: 1, faceIndex: 178 }, resultId: null, chainCount: null };
  const fetch: typeof globalThis.fetch = async input => {
    const message = { message_type: 'group', message_id: -16, group_id: 456, user_id: 123,
      sender: { user_id: 123 }, message: [{ type: 'face', data: face }] };
    return confirmed(actionOf(input) === 'get_group_msg_history' ? { messages: [message] } : message);
  };
  const conversation = createOneBotConversationPort({ endpoint, fetch });
  const messages = createOneBotActionPort({ endpoint, fetch });
  const history = await conversation.groupHistory({ groupId: '456', limit: 10, signal: signal() });
  const message = await messages.getMessage({ messageId: '-16', conversationId: 'group:456', signal: signal() });
  assert.equal(history.status, 'confirmed'); assert.equal(message.status, 'confirmed');
  if (history.status !== 'confirmed' || message.status !== 'confirmed') assert.fail('Actual NapCat decorations must be accepted');
  assert.deepEqual(message.data.message, [{ type: 'face', data: { id: '178' } }]);
  assert.deepEqual(await normalizeOneBotContent(history.data[0]!.message, {
    messageId: '-16', conversationId: 'group:456', signal: signal(),
  }), [{ type: 'face', id: '178' }]);
  face = { raw: { faceIndex: 178 }, resultId: null, chainCount: null };
  assert.equal((await conversation.groupHistory({ groupId: '456', limit: 10, signal: signal() })).status, 'unknown');
  assert.equal((await messages.getMessage({ messageId: '-16', conversationId: 'group:456', signal: signal() })).status, 'unknown');
});

test('private self-authored messages recover their peer from confirmed scoped outbox receipts and reject other scopes or uncertain deliveries', async context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close());
  const transport = createDurableTransport({ store, transport: { send: () => ({ status: 'confirmed', messageId: '-16' }) } });
  await transport.send({ conversationId: 'private:123', idempotencyKey: 'actual-outgoing', signal: signal(), content: [{ type: 'text', text: 'Result' }] });
  let protocolReads = 0;
  const port = createOneBotActionPort({ endpoint, fetch: async () => {
    protocolReads++;
    return confirmed({ self_id: 999, user_id: 999, message_id: -16, message_type: 'private',
      sender: { user_id: 999 }, message: [{ type: 'text', data: { text: 'Result' } }] });
  } });
  const read = (conversationId: string) => readScopedProtocolMessage({ port, store, selfId: '999', messageId: '-16', conversationId,
    signal: signal(), requireOutboundEvidence: true });
  const correct = await read('private:123');
  assert.equal(correct.status, 'confirmed');
  if (correct.status === 'confirmed') { assert.equal(correct.data.conversationId, 'private:123'); assert.equal(correct.data.userId, '999'); }
  assert.equal(protocolReads, 1);
  const wrong = await read('private:124');
  assert.equal(wrong.status, 'rejected');
  assert.equal(wrong.code, 'PRIVATE_OUTBOUND_SCOPE_EVIDENCE_UNAVAILABLE');
  assert.equal(protocolReads, 1, 'Wrong-peer receipts must not trigger a private:self read');
  const uncertain = createDurableTransport({ store, transport: { send: () => ({ status: 'unknown' }) } });
  await uncertain.send({ conversationId: 'private:125', idempotencyKey: 'uncertain-outgoing', signal: signal(), content: [{ type: 'text', text: 'Uncertain' }] });
  assert.equal((await read('private:125')).status, 'rejected');
  assert.equal(protocolReads, 1, 'An unresolved send is not proof of outgoing ownership');
});

test('ordinary conversation queries remain available to non-owners while account directories require the real configured owner', async context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close());
  const setup = sourceFixture(); context.after(() => setup.lifetime.abort());
  const actions: string[] = [];
  const fetch: typeof globalThis.fetch = async input => {
    const action = actionOf(input); actions.push(action);
    if (action === 'get_group_info') return confirmed({ group_id: 456, group_name: 'Fixture group', member_count: 2 });
    if (action === 'get_friend_list') return confirmed([{ user_id: 124, nickname: 'Fixture friend' }]);
    throw new Error('Unexpected protocol operation');
  };
  const effects = createNativeConversationService({ port: createOneBotConversationPort({ endpoint, fetch }),
    messagePort: createOneBotActionPort({ endpoint, fetch }), store, selfId: '999', sources: () => setup.sources.reader,
    register: () => { throw new Error('This query has no media'); }, async authorize() {} });
  const nonOwner = setup.request('124', { kind: 'info' });
  assert.equal(asObject(await effects['native.conversation.query']!.execute(nonOwner)).status, 'confirmed');
  await assert.rejects(async () => effects['native.conversation.query']!.execute({ ...nonOwner, input: { kind: 'directories', directory: 'friends' } }),
    { code: 'NATIVE_MESSAGE_SOURCE_NOT_OWNER' });
  assert.deepEqual(actions, ['get_group_info'], 'Rejected operations must not inspect or mutate protocol data');
  const owner = setup.request('123', { kind: 'directories', directory: 'friends' }, 'actual-owner-message');
  assert.equal(asObject(await effects['native.conversation.query']!.execute(owner)).status, 'confirmed');
  assert.deepEqual(actions, ['get_group_info', 'get_friend_list']);
});

for (const outcome of ['confirmed', 'unknown'] as const) test(`autonomous recall of a verified bot message retains its ${outcome} receipt without repeating the write`, async context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close());
  const setup = sourceFixture(); context.after(() => setup.lifetime.abort());
  const actions: string[] = [];
  const fetch: typeof globalThis.fetch = async input => {
    const action = actionOf(input); actions.push(action);
    if (action === 'get_msg') return confirmed({ message_type: 'group', message_id: -16, group_id: 456, user_id: 999,
      sender: { user_id: 999 }, message: [{ type: 'text', data: { text: 'Bot message' } }] });
    assert.equal(action, 'delete_msg');
    if (outcome === 'unknown') throw new Error('Transport ended after dispatch');
    return confirmed(null);
  };
  const options = { port: createOneBotConversationPort({ endpoint, fetch }),
    messagePort: createOneBotActionPort({ endpoint, fetch }), store, selfId: '999', sources: () => setup.sources.reader,
    register: () => { throw new Error('Recall has no media'); }, async authorize() {} };
  const request = setup.request('124', { messageId: '-16' });
  const first = await createNativeConversationService(options)['native.conversation.recall']!.execute(request);
  assert.equal(asObject(first).status, outcome);
  const second = await createNativeConversationService(options)['native.conversation.recall']!.execute(request);
  assert.deepEqual(second, first);
  assert.deepEqual(actions, ['get_msg', 'delete_msg'], 'A retained receipt must prevent another read or recall after service recreation');
});

test('autonomous recall rejects another sender or conversation before deleting any message', async context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close());
  const setup = sourceFixture(); context.after(() => setup.lifetime.abort());
  const actions: string[] = [];
  let sender = 124;
  let group = 456;
  const fetch: typeof globalThis.fetch = async input => {
    const action = actionOf(input); actions.push(action);
    assert.equal(action, 'get_msg', 'Rejected recalls must never delete protocol data');
    return confirmed({ message_type: 'group', message_id: -16, group_id: group, user_id: sender,
      sender: { user_id: sender }, message: [{ type: 'text', data: { text: 'Scoped message' } }] });
  };
  const effects = createNativeConversationService({ port: createOneBotConversationPort({ endpoint, fetch }),
    messagePort: createOneBotActionPort({ endpoint, fetch }), store, selfId: '999', sources: () => setup.sources.reader,
    register: () => { throw new Error('Recall has no media'); }, async authorize() {} });
  const request = setup.request('124', { messageId: '-16' });
  await assert.rejects(async () => effects['native.conversation.recall']!.execute(request), { code: 'RECALL_MESSAGE_SCOPE_MISMATCH' });
  sender = 999; group = 457;
  const wrongConversation = asObject(await effects['native.conversation.recall']!.execute(request));
  assert.equal(wrongConversation.status, 'unknown');
  assert.equal(wrongConversation.code, 'ONEBOT_ACTION_INVALID_RESPONSE');
  assert.deepEqual(actions, ['get_msg', 'get_msg']);
  assert.equal(store.list('native-chat.protocol-writes').length, 0, 'Unverified messages must not produce recall dispatch records');
});

for (const outcome of ['confirmed', 'unknown'] as const) test(`protocol ${outcome} writes are durably observed and the same event never sends a second poke`, async context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close());
  const setup = sourceFixture(); context.after(() => setup.lifetime.abort());
  let writes = 0;
  const fetch: typeof globalThis.fetch = async input => {
    const action = actionOf(input);
    if (action === 'get_group_member_list') return confirmed([{ group_id: 456, user_id: 124, nickname: 'Fixture member' }]);
    assert.equal(action, 'group_poke'); writes++;
    if (outcome === 'unknown') throw new Error('Transport ended after dispatch');
    return confirmed(null);
  };
  const options = { port: createOneBotConversationPort({ endpoint, fetch }), messagePort: createOneBotActionPort({ endpoint, fetch }),
    store, selfId: '999', sources: () => setup.sources.reader,
    register: () => { throw new Error('Pokes have no media'); }, async authorize() {} };
  const request = setup.request('124', {});
  const first = await createNativeConversationService(options)['native.conversation.poke']!.execute(request);
  assert.equal(asObject(first).status, outcome);
  const second = await createNativeConversationService(options)['native.conversation.poke']!.execute(request);
  assert.deepEqual(second, first);
  assert.equal(writes, 1, 'Recreating the service must retain exactly-once dispatch evidence');
  const records = store.list('native-chat.protocol-writes');
  assert.equal(records.length, 1);
  assert.equal(asObject(records[0]!.value).conversationId, 'group:456');
  assert.equal(asObject(records[0]!.value).sourceMessageId, request.scope.eventId);
});

test('discovered stickers become scoped readable output assets without leaking source URLs and empty collections stay empty', async context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close());
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHd8AAAAASUVORK5CYII=', 'base64');
  let empty = false;
  const port = createOneBotStickerPort({ endpoint, fetch: async input => {
    assert.equal(actionOf(input), 'fetch_custom_face_detail');
    return confirmed(empty ? [] : [{ emoji_id: 'fixture-sticker', desc: 'Fixture sticker', url: 'https://media.example.test/private-sticker' }]);
  } });
  const registry = createNativeMediaRegistry({ store, accountId: '999', async authorize() {}, contentReader: { async read(request) {
    assert.equal(request.source.url, 'https://media.example.test/private-sticker');
    return { status: 'confirmed', data: image, mediaType: 'image/png' };
  } } });
  const service = createNativeStickerService({ port, register: registry.register, async authorize() {} });
  const request = { input: {}, scope: scope(), signal: signal() };
  const result = asObject(await service.list.execute(request));
  assert.equal(result.status, 'confirmed');
  assert.equal(JSON.stringify(result).includes('https://'), false);
  assert(Array.isArray(result.items)); assert.equal(result.items.length, 1);
  const item = asObject(result.items[0]!);
  assert.equal(typeof item.assetId, 'string');
  const assetId = String(item.assetId);
  assert.deepEqual(await registry.resolveOutgoing({ assetId, type: 'image', conversationId: 'group:456', signal: signal() }),
    { file: `base64://${image.toString('base64')}` });
  await assert.rejects(registry.resolveOutgoing({ assetId, type: 'image', conversationId: 'group:457', signal: signal() }), { code: 'NATIVE_MEDIA_UNAVAILABLE' });
  empty = true;
  const none = asObject(await service.list.execute(request));
  assert.deepEqual(none.items, []); assert.equal(none.empty, true);
});

test('unclassified sticker candidates can be visually annotated locally, then found by meaning after service recreation', async context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close());
  const setup = sourceFixture(); context.after(() => setup.lifetime.abort());
  let protocolWrites = 0;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHd8AAAAASUVORK5CYII=', 'base64');
  const port = createOneBotStickerPort({ endpoint, fetch: async input => {
    if (actionOf(input) !== 'fetch_custom_face_detail') { protocolWrites++; throw new Error('Annotations are local'); }
    return confirmed([{ resId: 'actual-id', emoji_id: '4', md5: 'a'.repeat(32), url: 'https://media.example.test/sticker' }]);
  } });
  const registry = createNativeMediaRegistry({ store, accountId: '999', async authorize() {},
    contentReader: { async read() { return { status: 'confirmed', data: image, mediaType: 'image/png' }; } } });
  const options = { store, selfId: '999', port, register: registry.register, sources: () => setup.sources.reader, async authorize() {} };
  const service = createNativeStickerService(options);
  const request = setup.request('124', { query: '抱抱' });
  const listed = asObject(await service.list.execute(request));
  assert.equal(listed.matched, false);
  assert(Array.isArray(listed.items)); const item = asObject(listed.items[0]!);
  assert.equal(item.matched, false); assert.equal(item.needsAnnotation, true);
  const annotate = setup.request('124', { action: 'annotate', stickerKey: item.stickerKey!, assetId: item.assetId!,
    description: '开心地伸手抱抱', tags: ['亲近', '贴贴'], avoid: '严肃争执' }, 'annotation-message');
  await assert.rejects(async () => service.manage.execute(annotate), { code: 'STICKER_IMAGE_NOT_READ' });
  await registry.read.execute({ ...request, input: { assetId: item.assetId! } });
  assert.equal(asObject(await service.manage.execute(annotate)).cached, true);
  const found = asObject(await createNativeStickerService(options).list.execute({ ...request, input: { query: 'hug' } }));
  assert.equal(found.matched, true); assert(Array.isArray(found.items));
  assert.equal(asObject(found.items[0]!).needsAnnotation, false);
  assert.equal(protocolWrites, 0);
  const incoming = await registry.register({ kind: 'image', conversationId: 'group:456', messageId: 'incoming-image',
    source: { url: 'https://media.example.test/sticker' } }, signal());
  await registry.read.execute({ ...request, input: { assetId: incoming } });
  assert.equal(asObject(await service.manage.execute({ ...annotate, input: { action: 'annotate', stickerKey: item.stickerKey!,
    assetId: incoming, description: '笑着张开手', tags: ['抱抱'] } })).cached, true);
  const other = await createNativeStickerService(options).list.execute({ ...request, scope: scope('other-message', 'group:457'), input: { query: 'hug' } });
  const otherItems = asObject(other).items;
  assert(Array.isArray(otherItems));
  assert.notEqual(asObject(otherItems[0]!).assetId, item.assetId);
});
