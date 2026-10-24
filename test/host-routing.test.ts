import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextStore } from '../src/core/context.ts';
import { createBridgeHost } from '../src/host/bridge.ts';
import { createMessageRouter, withMessageRoute } from '../src/host/routing.ts';
import type { AgentAdapter, InboundMessage } from '../src/host/types.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

test('standard host routes a work request away from agent relay while preserving observers and triggers', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'fixture', version: '1.0.0', name: 'Fixture', identity: {}, style: {} });
  let prompts = 0;
  let observed = 0;
  let triggered = 0;
  let sent = 0;
  const agent: AgentAdapter = { async createSession() { return { sessionId: 'session' }; },
    async submit() { prompts++; return { status: 'accepted' }; }, async follow() { return () => {}; } };
  const routeIncoming = createMessageRouter({ rules: [{ id: 'work-intent', route: 'work', priority: 100, relayToAgent: false,
    selector: message => message.id === 'work' }], defaultRoute: { route: 'chat', relayToAgent: true } });
  const host = createBridgeHost({ context, persona, store, agent, routeIncoming, authorizeIncoming: () => true,
    transport: { send() { sent++; return { status: 'confirmed', messageId: `sent-${sent}` }; } } });
  host.policy.grant({ id: 'work-grant', featureId: 'work', conversationId: 'group:123', capabilities: ['messaging.send'], maxUses: { 'messaging.send': 1 } });
  host.policy.grant({ id: 'agent-grant', featureId: 'agent-relay', conversationId: 'group:123', capabilities: ['agent.submit'], maxUses: { 'agent.submit': 1 } });
  host.engine.install(withMessageRoute({ id: 'work', version: '1.0.0', apiVersion: 1, capabilities: ['messaging.send'],
    subscriptions: ['message.received', 'trigger.fired'], setup(services) {
      services.on('message.received', execution => execution.send([{ type: 'text', text: '已接收工作' }]));
      services.on('trigger.fired', () => { triggered++; });
    } }, 'work'));
  host.engine.install({ id: 'observer', version: '1.0.0', apiVersion: 1, capabilities: [], subscriptions: ['message.received'],
    setup(services) { services.on('message.received', () => { observed++; }); } });
  const message: InboundMessage = { id: 'work', conversationId: 'group:123', userId: '123', receivedAt: 1,
    content: [{ type: 'text', text: 'fixture work' }], directed: true, isSelf: false };
  try {
    assert.equal((await host.receive(message)).status, 'accepted');
    assert.equal(prompts, 0);
    assert.equal(sent, 1);
    assert.equal((await host.receive({ ...message, id: 'chat' })).status, 'accepted');
    assert.equal(prompts, 1);
    assert.equal(sent, 1);
    assert.equal(observed, 2);
    await host.engine.emit({ id: 'trigger', type: 'trigger.fired', conversationId: 'group:123', data: {} });
    assert.equal(triggered, 1);
  } finally { await host.stop(); store.close(); }
});

test('host routing conflicts fail closed after authorization without writing history or dispatching', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'fixture', version: '1.0.0', name: 'Fixture', identity: {}, style: {} });
  let authorizations = 0;
  const routeIncoming = createMessageRouter({ rules: ['a', 'b'].map(id => ({ id, priority: 1, route: id,
    relayToAgent: false, selector: () => true })), defaultRoute: { route: 'chat', relayToAgent: true } });
  const host = createBridgeHost({ store, context, persona, routeIncoming, authorizeIncoming() { authorizations++; return true; },
    agent: { async createSession() { assert.fail('not dispatched'); }, async submit() { assert.fail('not dispatched'); }, async follow() { return () => {}; } },
    transport: { send() { assert.fail('not dispatched'); } } });
  try {
    const result = await host.receive({ id: 'conflict', conversationId: 'group:123', userId: '123', receivedAt: 1,
      content: [{ type: 'text', text: 'conflict' }], directed: true, isSelf: false });
    assert.equal(result.errorCode, 'ROUTING_CONFLICT');
    assert.equal(authorizations, 1);
    assert.equal(host.history.snapshot('group:123').messages.length, 0);
  } finally { await host.stop(); store.close(); }
});
