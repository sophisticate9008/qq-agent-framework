import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneBotTransport } from '../src/adapters/onebot.ts';
import { createThrottledTransport } from '../src/adapters/throttle.ts';
import { normalizeContent } from '../src/core/content.ts';
import { createContextStore } from '../src/core/context.ts';
import { createEngine } from '../src/core/engine.ts';
import { createPolicy } from '../src/core/policy.ts';
import type { SendRequest } from '../src/core/types.ts';
import { createDurableTransport } from '../src/host/outbox.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

const content = normalizeContent([{ type: 'forward', nodes: [
  { content: [{ type: 'text', text: '整理结果' }] },
  { content: [{ type: 'image', assetId: 'document-image' }] },
] }]);
const scope = { persona: { id: 'fixture', version: '1.0.0' }, sessionId: 'session-1', generation: 2 };
function request(overrides: Partial<SendRequest> = {}): SendRequest {
  return { conversationId: 'group:123', idempotencyKey: 'forward-1', content, scope,
    signal: new AbortController().signal, ...overrides };
}

test('forward content is bounded, detached, standalone and cannot forge senders or nest', () => {
  assert(Object.isFrozen(content[0]) && content[0].type === 'forward' && Object.isFrozen(content[0].nodes[0].content));
  for (const input of [
    [{ type: 'forward', nodes: [] }],
    [{ type: 'forward', nodes: Array.from({ length: 33 }, () => ({ content: [{ type: 'text', text: 'x' }] })) }],
    [{ type: 'forward', nodes: [{ content: [{ type: 'forward', nodes: [] }] }] }],
    [{ type: 'forward', nodes: [{ senderId: '123', content: [{ type: 'text', text: 'x' }] }] }],
    [...content, { type: 'text', text: 'mixed' }],
  ]) assert.throws(() => normalizeContent(input), { code: 'INVALID_CONTENT' });
});

test('OneBot forwards both target kinds with a trusted sender, versioned resources and finite action paths', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const selections: unknown[] = [];
  const transport = createOneBotTransport({ endpoint: 'http://localhost.invalid/api/',
    forward: { senderId: '999', senderName: 'Assistant', group: true, private: true },
    resolveAsset(selection) { selections.push({ ...selection, signal: undefined }); return 'approved-image.png'; },
    async fetch(input, init) {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 17 } }));
    },
  });
  assert.equal((await transport.send(request())).status, 'confirmed');
  assert.equal((await transport.send(request({ conversationId: 'private:456' }))).status, 'confirmed');
  assert.equal(calls[0].url, 'http://localhost.invalid/api/send_group_forward_msg');
  assert.equal(calls[1].url, 'http://localhost.invalid/api/send_private_forward_msg');
  assert.deepEqual(calls[0].body, { group_id: 123, messages: [
    { type: 'node', data: { user_id: '999', nickname: 'Assistant', content: [{ type: 'text', data: { text: '整理结果' } }] } },
    { type: 'node', data: { user_id: '999', nickname: 'Assistant', content: [{ type: 'image', data: { file: 'approved-image.png' } }] } },
  ] });
  assert.deepEqual(selections[0], { assetId: 'document-image', type: 'image', conversationId: 'group:123',
    persona: 'fixture@1.0.0', sessionId: 'session-1', generation: 2, signal: undefined });
  assert(transport.capabilities?.().contentTypes.includes('forward'));
});

test('unsupported forwarding and mismatched persona fail before HTTP; unknown response never becomes a retry', async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; return new Response('not-json'); };
  const disabled = createOneBotTransport({ endpoint: 'http://localhost.invalid', fetch });
  assert.equal((await disabled.send(request())).status, 'rejected');
  const enabled = createOneBotTransport({ endpoint: 'http://localhost.invalid', fetch,
    forward: { senderId: '999', senderName: 'Assistant', group: true }, resolveAsset: () => 'image' });
  assert.equal((await enabled.send(request({ conversationId: 'private:456' }))).status, 'rejected');
  const wrongPersona = createOneBotTransport({ endpoint: 'http://localhost.invalid', fetch, persona: 'other@1', resolveAsset: () => 'image' });
  assert.equal((await wrongPersona.send(request({ content: [{ type: 'image', assetId: 'x' }] }))).status, 'rejected');
  assert.equal(calls, 0);
  assert.equal((await enabled.send(request())).status, 'unknown');
  assert.equal(calls, 1);
});

test('forward sending needs its own declaration and finite grant in addition to normal send', async () => {
  for (const granted of [false, true]) {
    const context = createContextStore();
    const persona = context.registerPersona({ id: 'fixture', version: '1.0.0', name: 'Fixture', identity: {}, style: {} });
    const policy = createPolicy();
    let calls = 0;
    const engine = createEngine({ context, persona, policy, transport: {
      send() { calls++; return { status: 'confirmed', messageId: 'forward-sent' }; },
    } });
    const capabilities = granted ? ['messaging.send', 'messaging.forward'] : ['messaging.send'];
    policy.grant({ id: 'grant', featureId: 'records', conversationId: 'group:123', capabilities,
      maxUses: Object.fromEntries(capabilities.map(capability => [capability, 1])) });
    engine.install({ id: 'records', version: '1.0.0', apiVersion: 1, capabilities: ['messaging.send', 'messaging.forward'],
      subscriptions: ['trigger.fired'], setup(services) { services.on('trigger.fired', execution => execution.send(content)); } });
    try {
      const result = await engine.emit({ id: 'records', type: 'trigger.fired', conversationId: 'group:123', data: {} });
      assert.equal(calls, Number(granted));
      assert.equal(result.outcomes[0].status, granted ? 'completed' : 'failed');
    } finally { await engine.stop(); }
  }
});

test('scope survives throttling and durable dedup includes identity, not just visible content', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const received: SendRequest[] = [];
  const throttled = createThrottledTransport({ transport: {
    send(input) { received.push(input); return { status: 'confirmed', messageId: 'sent' }; },
    capabilities: () => ({ contentTypes: ['text', 'forward'] }),
  }, minIntervalMs: 0 });
  const outbox = createDurableTransport({ store, transport: throttled });
  try {
    assert.equal((await outbox.send(request())).status, 'confirmed');
    assert.deepEqual(received[0].scope, scope);
    assert(outbox.capabilities?.().contentTypes.includes('forward'));
    assert.throws(() => outbox.send(request({ scope: { persona: { id: 'other', version: '1.0.0' } } })), { code: 'EFFECT_CONFLICT' });
    assert.equal(received.length, 1);
  } finally { await throttled.stop(); store.close(); }
});
