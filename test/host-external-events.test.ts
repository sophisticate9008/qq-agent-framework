import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextStore } from '../src/core/context.ts';
import { createBridgeHost } from '../src/host/bridge.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

test('registered external events retain durable deduplication and policy without impersonating message ingress', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'fixture', version: '1', name: 'Fixture', identity: {}, style: {} });
  let effects = 0;
  const host = createBridgeHost({ store, context, persona, authorizeIncoming: () => false, eventValidators: { 'protocol.recalled': data => typeof data.messageId === 'string' },
    effectAdapters: { 'recall.audit': { execute() { effects++; return null; } } },
    agent: { async createSession() { assert.fail('Protocol notices are not prompts'); },
      async submit() { assert.fail('Protocol notices are not prompts'); }, async follow() { return () => {}; } },
    transport: { send() { assert.fail('No automatic protocol replies'); } } });
  host.engine.install({ id: 'recall-reader', version: '1.0.0', apiVersion: 1, capabilities: ['recall.audit'],
    subscriptions: ['protocol.recalled'], setup(services) {
      services.on('protocol.recalled', execution => execution.invoke('recall.audit', {}));
    } });
  const event = { id: 'recalled-1', type: 'protocol.recalled', conversationId: 'group:123', data: { messageId: '123' } };
  try {
    assert.equal((await host.dispatchEvent(event)).errorCode, 'POLICY_DENIED');
    assert.equal(effects, 0);
    host.policy.grant({ id: 'recall', featureId: 'recall-reader', conversationId: 'group:123',
      capabilities: ['recall.audit'], maxUses: { 'recall.audit': 1 } });
    assert.equal((await host.dispatchEvent({ ...event, id: 'recalled-2' })).status, 'accepted');
    assert.equal((await host.dispatchEvent({ ...event, id: 'recalled-2' })).status, 'accepted');
    assert.equal(effects, 1);
    assert.equal(host.history.snapshot('group:123').messages.length, 0);
    await assert.rejects(host.dispatchEvent({ ...event, type: 'message.received' }), { code: 'INVALID_EXTERNAL_EVENT' });
    await assert.rejects(host.dispatchEvent({ ...event, type: 'agent.message' }), { code: 'INVALID_EXTERNAL_EVENT' });
    await assert.rejects(host.dispatchEvent({ ...event, type: 'unknown.event' }), { code: 'INVALID_EXTERNAL_EVENT' });
  } finally { await host.stop(); store.close(); }
});
