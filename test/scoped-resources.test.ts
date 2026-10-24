import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneBotTransport } from '../src/adapters/onebot.ts';
import { createContextStore } from '../src/core/context.ts';
import { createEngine } from '../src/core/engine.ts';
import { createPolicy } from '../src/core/policy.ts';
import { normalizeOutboundScope } from '../src/core/scope.ts';
import type { DeliveryReceipt, EffectRequest } from '../src/core/types.ts';
import { createResourceRegistry } from '../src/host/resources.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

test('resources may pin asset version and session generation without forcing historical assets into a session', () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const resources = createResourceRegistry({ store });
  const selection = { assetId: 'sensitive', type: 'image' as const, conversationId: 'group:123', persona: 'fixture@1',
    expectedVersion: 'revision-1', sessionId: 'session-1', generation: 2 };
  try {
    resources.register({ id: 'sensitive', type: 'image', scope: 'group:123', persona: 'fixture@1', version: 'revision-1',
      sessionId: 'session-1', generation: 2, source: { kind: 'gateway', id: 'approved-image' } });
    resources.approve('sensitive');
    assert.equal(resources.resolve(selection), 'approved-image');
    for (const changed of [{ expectedVersion: 'revision-2' }, { persona: 'fixture@2' }, { generation: 3 },
      { conversationId: 'group:456' }, { sessionId: 'other-session' }]) {
      assert.throws(() => resources.resolve({ ...selection, ...changed }), { code: 'RESOURCE_UNAVAILABLE' });
    }
    resources.register({ id: 'history', type: 'image', scope: 'group:123', persona: 'fixture@1', version: 'revision-1',
      source: { kind: 'gateway', id: 'history-image' } });
    resources.approve('history');
    assert.equal(resources.resolve({ ...selection, assetId: 'history', sessionId: 'next-session', generation: 3 }), 'history-image');
  } finally { store.close(); }
});

test('engine supplies immutable persona and session scope to effects rather than trusting their input', async () => {
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'fixture', version: '1.0.0', name: 'Fixture', identity: {}, style: {} });
  const policy = createPolicy();
  const received: EffectRequest[] = [];
  const engine = createEngine({ context, persona, policy, transport: { send: () => ({ status: 'rejected' }) },
    effectAdapters: { 'fixture.inspect': { execute(request) { received.push(request); return null; } } } });
  policy.grant({ id: 'grant', featureId: 'scope', conversationId: 'group:123', capabilities: ['fixture.inspect'], maxUses: { 'fixture.inspect': 1 } });
  engine.install({ id: 'scope', version: '2.0.0', apiVersion: 1, capabilities: ['fixture.inspect'], subscriptions: ['trigger.fired'],
    setup(services) { services.on('trigger.fired', execution => execution.invoke('fixture.inspect', { persona: 'forged@9' })); } });
  try {
    await engine.emit({ id: 'scope', type: 'trigger.fired', conversationId: 'group:123', sessionId: 'session-1', data: { generation: 2 } });
    assert.deepEqual(received[0].scope, { eventId: 'scope', featureId: 'scope', version: '2.0.0', conversationId: 'group:123',
      persona: { id: 'fixture', version: '1.0.0' }, sessionId: 'session-1', generation: 2 });
    assert(Object.isFrozen(received[0].scope.persona));
  } finally { await engine.stop(); }
});

test('revoking an image while its send is queued prevents OneBot HTTP dispatch', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const resources = createResourceRegistry({ store });
  resources.register({ id: 'image', type: 'image', scope: 'group:456', persona: 'fixture@1.0.0', version: '1',
    source: { kind: 'gateway', id: 'image-location' } });
  resources.approve('image');
  let entered!: () => void;
  let release!: () => void;
  let queued!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { queued = resolve; });
  let calls = 0;
  let secondReceipt: DeliveryReceipt | undefined;
  const transport = createOneBotTransport({ endpoint: 'http://localhost.invalid', resolveAsset: request => resources.resolve(request),
    async fetch() { calls++; entered(); await blocked; return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } })); } });
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'fixture', version: '1.0.0', name: 'Fixture', identity: {}, style: {} });
  const policy = createPolicy();
  const engine = createEngine({ context, persona, policy, transport, eventTimeoutMs: 5000 });
  for (const conversationId of ['group:123', 'group:456']) policy.grant({ id: conversationId, conversationId, featureId: 'images',
    capabilities: ['messaging.send'], maxUses: { 'messaging.send': 1 } });
  engine.install({ id: 'images', version: '1.0.0', apiVersion: 1, capabilities: ['messaging.send'], subscriptions: ['trigger.fired'],
    setup(services) { services.on('trigger.fired', async (execution, event) => {
      if (event.id === 'first') await execution.send([{ type: 'text', text: 'first' }]);
      else { queued(); secondReceipt = await execution.send([{ type: 'image', assetId: 'image' }]); }
    }); } });
  try {
    const first = engine.emit({ id: 'first', type: 'trigger.fired', conversationId: 'group:123', data: {} });
    await active;
    const second = engine.emit({ id: 'second', type: 'trigger.fired', conversationId: 'group:456', data: {} });
    await waiting;
    resources.revoke('image');
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(secondReceipt?.status, 'rejected');
  } finally { release(); await engine.stop(); store.close(); }
});

test('outbound scope rejects hidden fields, unversioned identity and invalid generation', () => {
  for (const input of [{ persona: { id: 'fixture', version: '1', token: 'secret' } },
    { persona: { id: 'fixture' } }, { persona: { id: 'fixture', version: '1' }, generation: 2 },
    { persona: { id: 'fixture', version: '1' }, sessionId: 'session', generation: 0 }]) {
    assert.throws(() => normalizeOutboundScope(input), { code: 'INVALID_SCOPE' });
  }
});
