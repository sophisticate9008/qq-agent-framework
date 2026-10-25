import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextStore } from '../src/core/context.ts';
import type { MessageContent } from '../src/core/types.ts';
import { createBridgeHost, type AgentInputPreparation } from '../src/host/bridge.ts';
import { composeAgentInputPreparation } from '../src/host/input-preparation.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

function fixture(preparation: AgentInputPreparation, authorize = true) {
  const store = createSqliteStore({ filename: ':memory:' });
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'fixture', version: '1', name: 'Fixture', identity: {}, style: {} });
  const prompts: { sessionId: string; content: readonly MessageContent[] }[] = [];
  let effects = 0;
  const host = createBridgeHost({ store, context, persona, agentInputPreparation: preparation,
    authorizeIncoming: () => authorize, effectAdapters: { 'memory.read': { execute() { effects++; return { text: 'memory' }; } } },
    agent: { async createSession() { return { sessionId: 'trusted-session' }; },
      async submit(request) { prompts.push({ sessionId: request.sessionId, content: request.content }); return { status: 'accepted' }; },
      async follow() { return () => {}; } },
    transport: { send() { assert.fail('Input preparation must not send'); } } });
  host.policy.grant({ id: 'relay', featureId: 'agent-relay', conversationId: 'group:123',
    capabilities: ['agent.submit'], maxUses: { 'agent.submit': 5 } });
  const message = { id: 'input', conversationId: 'group:123', userId: '42', receivedAt: 10,
    content: [{ type: 'text' as const, text: 'original' }], directed: true, isSelf: false };
  return { host, prompts, message, effects: () => effects,
    async close() { await host.stop(); store.close(); } };
}

test('ordered input providers enrich the original relay while retaining identity, history and reply tracking', async () => {
  const order: string[] = [];
  const prep = composeAgentInputPreparation([
    { id: 'context', order: 20, capabilities: [], prepare(_execution, event) {
      order.push('context');
      assert.equal(event.userId, '42');
      assert.equal(event.conversationId, 'group:123');
      assert.equal(event.data.text, 'speaker:42 original');
      assert(Object.isFrozen(event) && Object.isFrozen(event.data));
      assert.throws(() => { event.userId = 'forged'; }, TypeError);
      return [{ type: 'text', text: `${event.data.text} remembered fact` }];
    } },
    { id: 'speaker', order: 10, capabilities: [], prepare(_execution, event) {
      order.push('speaker'); return [{ type: 'text', text: `speaker:${event.userId} ${event.data.text}` }];
    } },
  ]);
  const f = fixture(prep);
  try {
    assert.equal((await f.host.receive(f.message)).status, 'accepted');
    assert.deepEqual(order, ['speaker', 'context']);
    assert.deepEqual(f.prompts, [{ sessionId: 'trusted-session', content: [{ type: 'text', text: 'speaker:42 original remembered fact' }] }]);
    assert.equal(f.host.history.snapshot('group:123').messages[0]?.content[0]?.type, 'text');
    assert.deepEqual(f.host.history.snapshot('group:123').messages[0]?.content, f.message.content);
    assert.equal(f.host.replies.get('group:123')?.requestId, 'input');
    await f.host.receive(f.message);
    assert.equal(f.prompts.length, 1);
  } finally { await f.close(); }
});

test('input preparation runs only after authorization and directed routing, and can explicitly skip submission', async () => {
  let prepared = 0;
  const preparation: AgentInputPreparation = { capabilities: [], prepare() { prepared++; return null; } };
  const denied = fixture(preparation, false);
  const allowed = fixture(preparation);
  try {
    assert.equal((await denied.host.receive(denied.message)).status, 'rejected');
    await allowed.host.receive({ ...allowed.message, directed: false });
    assert.equal(prepared, 0);
    assert.equal((await allowed.host.receive({ ...allowed.message, id: 'skip' })).status, 'accepted');
    assert.equal(prepared, 1);
    assert.equal(allowed.prompts.length, 0);
    assert.equal(allowed.host.replies.get('group:123'), null);
  } finally { await denied.close(); await allowed.close(); }
});

test('input provider capability declarations cannot bypass policy', async () => {
  const f = fixture({ capabilities: ['memory.read'], async prepare(execution) {
    await execution.invoke('memory.read', {}); return [{ type: 'text', text: 'enriched' }];
  } });
  try {
    assert.equal((await f.host.receive(f.message)).errorCode, 'POLICY_DENIED');
    assert.equal(f.effects(), 0);
    assert.equal(f.prompts.length, 0);
  } finally { await f.close(); }
});

test('input preparation cancellation prevents a late provider result from submitting', async () => {
  let entered: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let release: (() => void) | undefined;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ capabilities: [], async prepare() {
    entered!(); await wait; return [{ type: 'text', text: 'late' }];
  } });
  const controller = new AbortController();
  try {
    const receipt = f.host.receive(f.message, { signal: controller.signal });
    await ready;
    controller.abort();
    release!();
    await receipt;
    assert.equal(f.prompts.length, 0);
  } finally { release?.(); await f.close(); }
});
