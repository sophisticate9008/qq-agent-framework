import assert from 'node:assert/strict';
import test from 'node:test';
import { createOneBotQzoneTools } from '../src/adapters/onebot-qzone-tools.ts';
import { createOneBotQzonePort } from '../src/adapters/onebot-qzone.ts';
import type { JsonObject } from '../src/contracts/data.ts';
const signal = () => new AbortController().signal;
const ok = (data: unknown) => Response.json({ status: 'ok', retcode: 0, data });
function fixture(data: unknown, actions?: readonly string[]) {
  const calls: { action: string; input: JsonObject }[] = [];
  const port = createOneBotQzoneTools({ endpoint: 'http://protocol.invalid/base', accessToken: 'fixture-token',
    ...(actions === undefined ? {} : { supportedActions: actions }),
    fetch: async (url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
      calls.push({ action: new URL(String(url)).pathname, input: JSON.parse(String(init?.body)) as JsonObject });
      return ok(data);
    } });
  return { port, calls };
}

test('capability discovery is read-only and recognizes only the NapCat version-backed extensions', async () => {
  const { port, calls } = fixture({ app_name: 'NapCat.Onebot', app_version: '4.18.41' });
  assert.equal(calls.length, 0);
  assert.equal(port.describe().state, 'unknown');
  const inventory = await port.inspect(signal());
  assert.equal(inventory.source, 'version-map');
  assert.deepEqual(inventory.tools.map(tool => tool.name), ['send_qzone_msg', 'delete_qzone_msg']);
  assert.deepEqual(calls.map(call => call.action), ['/base/get_version_info']);
  assert.equal((await port.execute({ name: 'comment_qzone', input: { tid: 't1', content: 'text' }, signal: signal() })).status, 'rejected');
  assert.equal(calls.length, 1);
});

test('brand name alone, older versions and other implementations do not enable undeclared actions', async () => {
  for (const data of [{ app_name: 'NapCat.Onebot', app_version: '4.18.13' }, { app_name: 'SnowLuma', app_version: '1.0.0' }, { app_name: 'Other', app_version: '99.0.0' }]) {
    const { port, calls } = fixture(data);
    assert.equal((await port.inspect(signal())).tools.length, 0);
    assert.equal((await port.execute({ name: 'send_qzone_msg', input: { content: 'hello', ugc_right: 4 }, signal: signal() })).status, 'rejected');
    assert.equal(calls.length, 1);
  }
});

test('exact protocol action inventories expose only supported Qzone operations and can be refreshed', async () => {
  let actions: readonly string[] = ['get_qzone_msg_list', 'comment_qzone', 'unrelated'];
  let reads = 0;
  const port = createOneBotQzoneTools({ endpoint: 'http://protocol.invalid', readSupportedActions: async () => actions,
    fetch: async () => { reads++; return ok({ total: 0, msglist: [] }); } });
  assert.deepEqual((await port.inspect(signal())).tools.map(tool => tool.name), ['get_qzone_msg_list', 'comment_qzone']);
  assert.equal(reads, 0);
  assert.deepEqual(await port.execute({ name: 'get_qzone_msg_list', input: { num: 10 }, signal: signal() }), { status: 'confirmed', data: { total: 0, msglist: [] } });
  actions = [];
  assert.equal((await port.inspect(signal())).state, 'unsupported');
  assert.equal((await port.execute({ name: 'get_qzone_msg_list', input: {}, signal: signal() })).status, 'rejected');
  assert.equal(reads, 1);
});

test('publishing requires explicit valid visibility and validates sources before making a request', async () => {
  const { port, calls } = fixture({ tid: 'server-post-id' }, ['send_qzone_msg']);
  const invalid: JsonObject[] = [{ content: 'hello' }, { content: 'hello', ugc_right: 16 }, { content: 'hello', ugc_right: 2 },
    { content: 'hello', ugc_right: 4, images: ['javascript:bad'] }, { content: 'hello', ugc_right: 4, extra: true }];
  for (const input of invalid) {
    assert.equal((await port.execute({ name: 'send_qzone_msg', input, signal: signal() })).status, 'rejected');
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await port.execute({ name: 'send_qzone_msg', input: { content: 'hello', ugc_right: 16, target_uins: ['10001'], images: ['file:///tmp/example.png'] }, signal: signal() }),
    { status: 'confirmed', data: { tid: 'server-post-id' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.ugc_right, 16);
});

test('a success envelope without a real publication identifier is unknown and never retried', async () => {
  const { port, calls } = fixture({}, ['send_qzone_msg']);
  assert.deepEqual(await port.execute({ name: 'send_qzone_msg', input: { content: 'hello', ugc_right: 4 }, signal: signal() }),
    { status: 'unknown', code: 'QZONE_INVALID_RESPONSE' });
  assert.equal(calls.length, 1);
});

test('comment replies preserve parent zero and reject incomplete identities or reply images', async () => {
  const { port, calls } = fixture({ comment_id: 'new-comment', parent_comment_id: '0' }, ['comment_qzone']);
  const invalid: JsonObject[] = [{ tid: 't1', content: 'hello', comment_id: '0' },
    { tid: 't1', content: 'hello', comment_id: '0', comment_uin: '10002', images: ['file:///tmp/example.png'] },
    { tid: 't1', content: 'hello', reply_uin: '10003', reply_name: 'name' }];
  for (const input of invalid) {
    assert.equal((await port.execute({ name: 'comment_qzone', input, signal: signal() })).status, 'rejected');
  }
  assert.equal(calls.length, 0);
  assert.equal((await port.execute({ name: 'comment_qzone', input: { tid: 't1', target_uin: '10001', content: 'hello', comment_id: '0', comment_uin: '10002' }, signal: signal() })).status, 'confirmed');
  assert.equal(calls[0].input.comment_id, '0');
  assert.equal(calls[0].input.target_uin, '10001');
});

test('detail must match the requested post and protocol null deletions remain distinct', async () => {
  const { port } = fixture({ tid: 'other', comments: [] }, ['get_qzone_msg_detail']);
  assert.equal((await port.execute({ name: 'get_qzone_msg_detail', input: { tid: 'wanted' }, signal: signal() })).status, 'unknown');
  const removed = fixture(null, ['delete_qzone_msg']);
  assert.deepEqual(await removed.port.execute({ name: 'delete_qzone_msg', input: { tid: 'wanted' }, signal: signal() }), { status: 'confirmed', data: null });
});

test('cancellation before dispatch makes no request; transport failures remain unknown without replay', async () => {
  let calls = 0;
  const port = createOneBotQzoneTools({ endpoint: 'http://protocol.invalid', supportedActions: ['send_qzone_msg'],
    fetch: async () => { calls++; throw new Error('fixture disconnected'); } });
  const controller = new AbortController(); controller.abort();
  assert.equal((await port.execute({ name: 'send_qzone_msg', input: { content: 'hello', ugc_right: 4 }, signal: controller.signal })).status, 'rejected');
  assert.equal(calls, 0);
  assert.equal((await port.execute({ name: 'send_qzone_msg', input: { content: 'hello', ugc_right: 4 }, signal: signal() })).status, 'unknown');
  assert.equal(calls, 1);
});

test('legacy typed publication port retains normalized receipts through the shared transport', async () => {
  const port = createOneBotQzonePort({ endpoint: 'http://protocol.invalid', supportedActions: ['publish'], fetch: async () => ok({ tid: 'real-post-id' }) });
  assert.deepEqual(await port.publish({ content: 'hello', visibility: { kind: 'friends' }, signal: signal() }),
    { status: 'confirmed', data: { postId: 'real-post-id', publishedAt: null } });
});


test('NapCat void handlers may omit data, while publishing still requires a real identifier', async () => {
  const port = createOneBotQzoneTools({ endpoint: 'http://protocol.invalid', supportedActions: ['delete_qzone_msg', 'send_qzone_msg'],
    fetch: async () => Response.json({ status: 'ok', retcode: 0 }) });
  assert.deepEqual(await port.execute({ name: 'delete_qzone_msg', input: { tid: 'real-post-id' }, signal: signal() }), { status: 'confirmed', data: null });
  assert.equal((await port.execute({ name: 'send_qzone_msg', input: { content: 'hello', ugc_right: 4 }, signal: signal() })).status, 'unknown');
});
