import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/core/engine.ts';
import { createContextStore, createFeatureState } from '../src/core/context.ts';
import { createPolicy } from '../src/core/policy.ts';
import type { EngineOptions } from '../src/core/engine.ts';
import type { FeatureDefinition, FeatureHandler } from '../src/core/types.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

function fixture(overrides: Partial<EngineOptions> = {}) {
  const context = createContextStore();
  const state = createFeatureState();
  const policy = createPolicy();
  const persona = context.registerPersona({ id: 'perf', version: '1.0.0', name: 'Performance fixture', identity: {}, style: {} });
  const engine = createEngine({ context, state, policy, persona,
    transport: { send: () => ({ status: 'confirmed', messageId: 'fixture' }) }, ...overrides });
  function install(handler: FeatureHandler, overrides: Partial<FeatureDefinition> = {}) {
    engine.install({ id: 'perf', version: '1.0.0', apiVersion: 1, capabilities: [], subscriptions: ['message.received'],
      setup(context) { context.on('message.received', handler); }, ...overrides });
  }
  function allow(conversationId: string) {
    policy.grant({ id: conversationId, featureId: 'perf', conversationId, capabilities: ['messaging.send'], maxUses: { 'messaging.send': 10 } });
  }
  return { engine, state, policy, install, allow };
}

const event = (id: string, conversationId = 'perf:room') => ({ id, conversationId, type: 'message.received', data: {} });
const message = [{ type: 'text' as const, text: 'fixture' }];

test('sustained immediate work yields to the event loop before completion', async () => {
  const { engine, install } = fixture({ yieldEvery: 8 });
  let handled = 0;
  let handledAtTurn = -1;
  install(() => { handled++; });
  const observed = new Promise<void>(resolve => setImmediate(() => { handledAtTurn = handled; resolve(); }));
  for (let ordinal = 0; ordinal < 200; ordinal++) await engine.emit(event(String(ordinal)));
  await observed;
  assert(handledAtTurn >= 0 && handledAtTurn < 200);
  assert.equal(handled, 200);
  await engine.stop();
});

test('unused state and completed histories stay bounded across fresh conversations', async () => {
  const { engine, state, install } = fixture({ historyLimit: 20 });
  install(() => {});
  for (let ordinal = 0; ordinal < 1000; ordinal++) await engine.emit(event(String(ordinal), `perf:${ordinal}`));
  assert.deepEqual(state.describe().namespaces, []);
  const metrics = engine.metrics();
  assert.equal(metrics.queues.pendingEvents, 0);
  assert.equal(metrics.queues.pendingEffects, 0);
  assert.equal(metrics.retention.events, 20);
  assert.equal(metrics.retention.audit, 20);
  assert.equal(metrics.retention.effects, 0);
  await engine.stop();
});

test('drained failures cannot be hidden after pending-effect tracking is released', async () => {
  const { engine, install } = fixture();
  install(async execution => { await execution.send(message).catch(() => {}); }, { capabilities: ['messaging.send'] });
  const report = await engine.emit(event('denied'));
  assert.equal(report.outcomes[0].errorCode, 'EFFECT_FAILED');
  assert.equal(engine.metrics().queues.pendingEffects, 0);
  await engine.stop();
});

test('event subscriptions publish transactionally and reinstall without stale handlers', async () => {
  const { engine, install } = fixture();
  let calls = 0;
  install(() => { calls++; });
  await engine.emit(event('first'));
  await engine.uninstall('perf');
  assert.deepEqual((await engine.emit(event('uninstalled'))).outcomes, []);
  install(() => { calls += 10; });
  await engine.emit(event('replacement'));
  assert.equal(calls, 11);
  await engine.stop();
});

test('parallel send slots avoid cross-conversation head-of-line blocking', async () => {
  const entered = deferred(); const release = deferred();
  const calls: string[] = [];
  const { engine, install, allow } = fixture({ maxConcurrentSends: 2, transport: { async send(request) {
    calls.push(request.conversationId);
    if (request.conversationId === 'perf:slow') { entered.resolve(); await release.promise; }
    return { status: 'confirmed', messageId: request.conversationId };
  } } });
  allow('perf:slow'); allow('perf:fast');
  install(execution => execution.send(message), { capabilities: ['messaging.send'] });
  const slow = engine.emit(event('slow', 'perf:slow'));
  await entered.promise;
  const fast = await engine.emit(event('fast', 'perf:fast'));
  assert.equal(fast.outcomes[0].status, 'completed');
  assert.equal(engine.metrics().scheduling.activeSends, 1);
  assert.deepEqual(calls, ['perf:slow', 'perf:fast']);
  release.resolve();
  await slow;
  await engine.stop();
});

test('parallel sends respect the concurrency ceiling and recheck revoked waiting work', async () => {
  const entered = deferred(); const release = deferred();
  let calls = 0;
  let active = 0;
  let peak = 0;
  const { engine, policy, install, allow } = fixture({ maxConcurrentSends: 2, transport: { async send() {
    calls++; active++; peak = Math.max(peak, active);
    if (calls === 2) entered.resolve();
    await release.promise;
    active--;
    return { status: 'confirmed', messageId: 'fixture' };
  } } });
  for (const conversationId of ['perf:first', 'perf:second', 'perf:third']) allow(conversationId);
  install(execution => execution.send(message), { capabilities: ['messaging.send'] });
  const first = engine.emit(event('first', 'perf:first'));
  const second = engine.emit(event('second', 'perf:second'));
  const third = engine.emit(event('third', 'perf:third'));
  await entered.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(engine.metrics().scheduling.waitingSends, 1);
  policy.revoke('perf:third');
  release.resolve();
  const reports = await Promise.all([first, second, third]);
  assert.equal(calls, 2);
  assert.equal(peak, 2);
  assert.equal(reports[2].outcomes[0].errorCode, 'POLICY_DENIED');
  assert.equal(engine.metrics().scheduling.activeSends, 0);
  await engine.stop();
});

test('parallel mode preserves same-conversation send order', async () => {
  const entered = deferred(); const release = deferred();
  const calls: string[] = [];
  const { engine, install, allow } = fixture({ maxConcurrentSends: 4, transport: { async send(request) {
    calls.push(request.content[0].text);
    if (request.content[0].text === 'first') { entered.resolve(); await release.promise; }
    return { status: 'confirmed', messageId: request.content[0].text };
  } } });
  allow('perf:room');
  install(async execution => {
    const first = execution.send([{ type: 'text', text: 'first' }]);
    const second = execution.send([{ type: 'text', text: 'second' }]);
    await Promise.all([first, second]);
  }, { capabilities: ['messaging.send'] });
  const pending = engine.emit(event('ordered'));
  await entered.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['first']);
  release.resolve();
  await pending;
  assert.deepEqual(calls, ['first', 'second']);
  await engine.stop();
});

test('stopping during a scheduler yield does not dispatch ghost work', async () => {
  const { engine, install } = fixture({ yieldEvery: 1 });
  let calls = 0;
  install(() => { calls++; });
  const pending = engine.emit(event('stopped'));
  const rejected = assert.rejects(pending, { code: 'ENGINE_STOPPED' });
  await engine.stop();
  await rejected;
  assert.equal(calls, 0);
  assert.equal(engine.metrics().queues.pendingEvents, 0);
});

test('scheduler and concurrency budgets reject invalid values without changing safety defaults', async () => {
  for (const options of [{ yieldAfterMs: 0 }, { yieldAfterMs: Infinity }, { yieldEvery: 0 }, { maxConcurrentSends: -1 }]) {
    assert.throws(() => fixture(options), { code: 'INVALID_ENGINE' });
  }
  const { engine } = fixture();
  assert.equal(engine.metrics().scheduling.maxConcurrentSends, 1);
  assert.equal(engine.metrics().scheduling.yieldEvery, 64);
  assert.equal(engine.metrics().scheduling.yieldAfterMs, 8);
  await engine.stop();
});
