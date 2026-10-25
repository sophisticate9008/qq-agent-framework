import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createOneBotActionPort } from '../src/adapters/onebot-actions.ts';

test('typed read actions use fixed authenticated URLs and bounded protocol results without following source URLs', async context => {
  const calls: Array<{ path: string; body: unknown }> = [];
  let data: unknown = { file: '/private/local-image', url: 'https://media.example.test/image', size: 20 };
  let status = 'ok';
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-action-only');
    let body = '';
    for await (const part of request) body += String(part);
    calls.push({ path: request.url!, body: JSON.parse(body) });
    response.end(JSON.stringify({ status, retcode: status === 'ok' ? 0 : status === 'failed' ? 100 : 1, data }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const port = createOneBotActionPort({ endpoint: `http://127.0.0.1:${address.port}/onebot`, accessToken: 'fixture-action-only' });
  const signal = new AbortController().signal;
  assert.equal((await port.getImage({ file: 'image-handle', signal })).status, 'confirmed');
  assert.equal((await port.getRecord({ file: 'record-handle', signal })).status, 'confirmed');
  assert.deepEqual(calls, [{ path: '/onebot/get_image', body: { file: 'image-handle' } },
    { path: '/onebot/get_record', body: { file: 'record-handle', out_format: 'mp3' } }]);
  assert.equal((await port.getFile({ fileId: 'file-handle', signal })).status, 'rejected');
  assert.equal(calls.length, 2);
  assert.equal((await port.getImage({ file: '', signal })).status, 'rejected');
  assert.equal(calls.length, 2);
  status = 'async';
  assert.equal((await port.getImage({ file: 'image-handle', signal })).status, 'unknown');
  status = 'failed';
  assert.equal((await port.getImage({ file: 'image-handle', signal })).status, 'rejected');
  status = 'ok';
  data = { file: '/private/file', url: 'file:///private/other' };
  assert.equal((await port.getImage({ file: 'image-handle', signal })).status, 'unknown');
  const extended = createOneBotActionPort({ endpoint: `http://127.0.0.1:${address.port}/onebot`, accessToken: 'fixture-action-only', allowedActions: ['get_file'] });
  data = { file: '/private/file' };
  assert.equal((await extended.getFile({ fileId: 'registered-file', signal })).status, 'confirmed');
  assert.equal(calls.at(-1)?.path, '/onebot/get_file');
});

test('protocol message reads require exact message and conversation identity and reject conflicting senders', async () => {
  let data: unknown = { message_type: 'group', message_id: -1, group_id: 456, user_id: 123,
    sender: { user_id: 123, isOwner: true }, message: [{ type: 'text', data: { text: 'Read actual message' } }] };
  const port = createOneBotActionPort({ endpoint: 'http://127.0.0.1:1', fetch: async () =>
    new Response(JSON.stringify({ status: 'ok', retcode: 0, data })) });
  const request = { messageId: '-1', conversationId: 'group:456', signal: new AbortController().signal };
  const result = await port.getMessage(request);
  assert.equal(result.status, 'confirmed');
  if (result.status === 'confirmed') {
    assert.equal(result.data.userId, '123');
    assert.equal(Object.hasOwn(result.data, 'isOwner'), false);
  }
  assert.equal((await port.getMessage({ ...request, messageId: '-2' })).status, 'unknown');
  assert.equal((await port.getMessage({ ...request, conversationId: 'group:457' })).status, 'unknown');
  const original = data as Record<string, unknown>;
  for (const patch of [{ group_id: undefined }, { sender: { user_id: 456 } }, { sender: { user_id: null } },
    { message: [{ type: 'text', data: { text: { forged: true } } }] }]) {
    data = { ...original, ...patch };
    assert.equal((await port.getMessage(request)).status, 'unknown');
  }
});

test('forward reads decode bounded nodes as quoted identities without promoting sender claims', async () => {
  let data: unknown = { message: [{ type: 'node', data: { uin: '123', name: 'Owner', content: [
    { type: 'text', data: { text: 'Quoted user content' } }, { type: 'image', data: { file: 'nested-image' } },
  ], isOwner: true } }] };
  const port = createOneBotActionPort({ endpoint: 'http://127.0.0.1:1', fetch: async () =>
    new Response(JSON.stringify({ status: 'ok', retcode: 0, data })) });
  const request = { id: 'forward-handle', signal: new AbortController().signal };
  const result = await port.getForward(request);
  assert.equal(result.status, 'confirmed');
  if (result.status === 'confirmed') {
    assert.equal(result.data.messages[0]!.senderId, '123');
    assert.equal(result.data.messages[0]!.time, null);
    assert.equal(Object.hasOwn(result.data.messages[0]!, 'isOwner'), false);
    assert(Object.isFrozen(result.data.messages[0]!));
  }
  for (const node of [{ sender: { user_id: 123 }, content: [] },
    { uin: '123', sender: { user_id: 456 }, content: [{ type: 'text', data: { text: 'bad' } }] },
    { sender: { user_id: null }, content: [{ type: 'text', data: { text: 'bad' } }] }]) {
    data = { messages: [node] };
    assert.equal((await port.getForward(request)).status, 'unknown');
  }
});

test('read deadlines bound even a custom transport that ignores cancellation without retrying', async () => {
  let calls = 0;
  const port = createOneBotActionPort({ endpoint: 'http://127.0.0.1:1', timeoutMs: 20,
    fetch: () => { calls++; return new Promise<Response>(() => {}); } });
  // Keep the test event loop live while AbortSignal.timeout uses an unref'd timer.
  const pending = setInterval(() => {}, 1000);
  try {
    assert.deepEqual(await port.getImage({ file: 'registered-image', signal: new AbortController().signal }),
      { status: 'unknown', code: 'ONEBOT_ACTION_ABORTED_UNKNOWN' });
    assert.equal(calls, 1);
  } finally { clearInterval(pending); }
});
