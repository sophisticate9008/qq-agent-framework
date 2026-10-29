import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createOneBotQzoneTools } from '../src/adapters/onebot-qzone-tools.ts';
import type { OneBotAssetResolutionRequest } from '../src/adapters/onebot.ts';
import type { EffectRequest, JsonObject } from '../src/core/types.ts';
import { createNativeMessageSources } from '../src/host/native-message-sources.ts';
import { availableNativeQzoneTools, createNativeQzoneEffects, NATIVE_QZONE_TOOLS } from '../src/host/native-qzone-tools.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

function fixture(context: TestContext, response: unknown = { tid: 'actual-post' }) {
  const store = createSqliteStore({ filename: ':memory:' });
  const controller = new AbortController();
  context.after(() => { controller.abort(); store.close(); });
  const signal = controller.signal;
  const sources = createNativeMessageSources({ owner: '999', signal, validate: async () => {} });
  sources.capture({ id: 'tool-call', conversationId: 'group:123', userId: '1234' },
    { receivedAt: Date.now(), expiresAt: Date.now() + 60000, signal });
  const calls: { action: string; input: JsonObject }[] = [];
  const assets: OneBotAssetResolutionRequest[] = [];
  let allowed = true;
  const port = createOneBotQzoneTools({ endpoint: 'http://protocol.invalid', supportedActions: ['send_qzone_msg', 'delete_qzone_msg'],
    fetch: async (url, init) => {
      calls.push({ action: new URL(String(url)).pathname, input: JSON.parse(String(init?.body)) as JsonObject });
      return Response.json({ status: 'ok', retcode: 0, data: response });
    } });
  function effects() {
    return createNativeQzoneEffects({ port, store, selfId: '10001', sources: () => sources.reader,
      authorize: async () => { assert.ok(allowed, 'access revoked'); },
      resolveAsset: async request => { assets.push(request); return { file: 'base64://b3JpZ2luYWw=' }; } });
  }
  const request: EffectRequest = { signal, input: { content: 'hello', visibility: 'friends' },
    scope: { eventId: 'tool-call', conversationId: 'group:123', featureId: 'framework-tools', version: '1.0.0', sessionId: 'session', generation: 1 } };
  return { store, signal, port, request, calls, assets, effects, revoke() { allowed = false; } };
}

test('model registration follows actual protocol capabilities and retains builtin provenance', context => {
  const runtime = fixture(context);
  const inventory = runtime.port.describe();
  assert.deepEqual(availableNativeQzoneTools(inventory).map(tool => tool.definition.name), ['qbf_qzone_publish', 'qbf_qzone_delete']);
  assert.deepEqual(availableNativeQzoneTools({ ...inventory, tools: inventory.tools.filter(tool => tool.name === 'delete_qzone_msg') })
    .map(tool => tool.definition.name), ['qbf_qzone_delete']);
  assert.deepEqual(availableNativeQzoneTools({ ...inventory, state: 'unknown' }), []);
  assert.ok(NATIVE_QZONE_TOOLS.every(tool => tool.definition.registrationSource?.origin === 'framework-builtin'));
  const publish = NATIVE_QZONE_TOOLS.find(tool => tool.definition.name === 'qbf_qzone_publish')!;
  for (const images of [['/tmp/private.png'], ['https://example.invalid/image.png']]) {
    assert.throws(() => publish.validate({ images, visibility: 'friends' }));
  }
});

test('publishing resolves original scoped assets and deduplicates across wrapper recreation', async context => {
  const runtime = fixture(context);
  const request = { ...runtime.request, input: { images: ['media-scoped'], visibility: 'friends' } };
  const result = await runtime.effects()['native.qzone.publish'].execute(request);
  assert.deepEqual(result, { status: 'confirmed', data: { postId: 'actual-post', publishedAt: null } });
  assert.deepEqual(runtime.calls, [{ action: '/send_qzone_msg', input: { content: '', images: ['base64://b3JpZ2luYWw='], ugc_right: 4 } }]);
  assert.equal(runtime.assets[0].conversationId, request.scope.conversationId);
  assert.equal(runtime.assets[0].sessionId, request.scope.sessionId);
  assert.equal(runtime.assets[0].generation, request.scope.generation);
  assert.deepEqual(await runtime.effects()['native.qzone.publish'].execute(request), result);
  assert.equal(runtime.calls.length, 1);
  await assert.rejects(async () => runtime.effects()['native.qzone.publish'].execute({ ...request, input: { content: 'changed', visibility: 'self' } }));
  runtime.revoke();
  await assert.rejects(async () => runtime.effects()['native.qzone.publish'].execute(request), /access revoked/);
  assert.equal(runtime.calls.length, 1);
});

test('a malformed publication receipt remains unknown without repeating the external write', async context => {
  const runtime = fixture(context, {});
  const result = await runtime.effects()['native.qzone.publish'].execute(runtime.request);
  assert.deepEqual(result, { status: 'unknown', code: 'QZONE_INVALID_RESPONSE', retry: false });
  assert.deepEqual(await runtime.effects()['native.qzone.publish'].execute(runtime.request), result);
  assert.equal(runtime.calls.length, 1);
});

test('deleting uses a real post ID and permits an ordinary whitelisted source', async context => {
  const runtime = fixture(context, null);
  const request = { ...runtime.request, input: { postId: 'actual-post' } };
  assert.deepEqual(await runtime.effects()['native.qzone.delete'].execute(request), { status: 'confirmed', data: null });
  assert.deepEqual(runtime.calls, [{ action: '/delete_qzone_msg', input: { tid: 'actual-post' } }]);
  assert.deepEqual(await runtime.effects()['native.qzone.delete'].execute(request), { status: 'confirmed', data: null });
  assert.equal(runtime.calls.length, 1);
});
