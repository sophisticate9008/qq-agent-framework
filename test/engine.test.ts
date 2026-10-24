import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/core/engine.ts';
import { createPolicy } from '../src/core/policy.ts';
import { createContextStore } from '../src/core/context.ts';
import type { EngineOptions } from '../src/core/engine.ts';
import type { DeliveryReceipt, EffectRequest, FeatureDefinition, FeatureExecution, FeatureHandler, JsonValue, SendRequest,
  TextContent, TransportAdapter } from '../src/core/types.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

function fixture(overrides: Partial<EngineOptions> = {}) {
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'demo', version: '1.0.0', name: 'Demo', identity: { role: 'example' }, style: { tone: 'brief' } });
  const policy = createPolicy();
  const sent: SendRequest[] = [];
  const transport: TransportAdapter = { async send(request) { sent.push(request); return { status: 'confirmed', messageId: `demo-${sent.length}` }; } };
  const engine = createEngine({ context, persona, policy, transport, ...overrides });
  const allow = (featureId = 'sample', conversationId = 'demo:room', capabilities = ['messaging.send'], budget = 10) => policy.grant({
    id: `${featureId}-${conversationId}`, featureId, conversationId, capabilities,
    maxUses: Object.fromEntries(capabilities.map(capability => [capability, budget])),
  });
  return { engine, context, policy, sent, allow };
}

function feature(handler: FeatureHandler, options: Partial<FeatureDefinition> = {}): FeatureDefinition {
  return { id: 'sample', version: '1.0.0', apiVersion: 1, capabilities: ['messaging.send'],
    subscriptions: ['message.received'], setup(context) { context.on('message.received', handler); }, ...options };
}

const event = (id = 'one', conversationId = 'demo:room', data = {}) => ({ id, conversationId, type: 'message.received', data });
const message: TextContent[] = [{ type: 'text', text: 'hello' }];

test('features use private state and detached immutable persona/context', async () => {
  const { engine, context, allow, sent } = fixture();
  context.setPreferences({ id: 'room', scope: { kind: 'conversation', id: 'demo:room' }, source: 'operator', values: { tone: 'quiet', authorized: true } });
  let captured!: FeatureExecution;
  engine.install(feature(async execution => {
    captured = execution;
    assert.equal(execution.context.preferences.tone, 'quiet');
    assert(Object.isFrozen(execution.context.persona.identity));
    const count = execution.state.get('count', 0);
    assert.equal(typeof count, 'number');
    execution.state.set('count', (count as number) + 1);
    await execution.send(message);
  }));
  const denied = await engine.emit(event());
  assert.equal(denied.outcomes[0].errorCode, 'POLICY_DENIED');
  assert.equal(sent.length, 0);
  allow();
  assert.equal((await engine.emit(event('two'))).outcomes[0].status, 'completed');
  assert.equal(sent.length, 1);
  assert.throws(() => captured.state.set('count', 100), { code: 'EXECUTION_CLOSED' });
  assert.throws(() => captured.send(message), { code: 'EXECUTION_CLOSED' });
  await engine.stop();
});

test('event replay shares one execution and changed data is rejected', async () => {
  const { engine, allow, sent } = fixture();
  allow();
  engine.install(feature(async execution => { await execution.send(message); }));
  const reports = await Promise.all([engine.emit(event()), engine.emit(event())]);
  assert.deepEqual(reports[0], reports[1]);
  assert.equal(sent.length, 1);
  await engine.emit(event());
  assert.equal(sent.length, 1);
  assert.throws(() => engine.emit(event('one', 'demo:room', { changed: true })), { code: 'EVENT_CONFLICT' });
  await engine.stop();
});

test('same conversation is ordered while another conversation can progress', async () => {
  const { engine } = fixture();
  const entered = deferred(); const release = deferred(); const seen: string[] = [];
  engine.install(feature(async (_execution, received) => {
    seen.push(received.id);
    if (received.id === 'first') { entered.resolve(); await release.promise; }
  }, { capabilities: [] }));
  const first = engine.emit(event('first'));
  await entered.promise;
  const second = engine.emit(event('second'));
  await engine.emit(event('other', 'demo:other'));
  assert.deepEqual(seen, ['first', 'other']);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(seen, ['first', 'other', 'second']);
  await engine.stop();
});

test('a failed feature cannot suppress another feature or leak its exception', async () => {
  const { engine } = fixture({ observer() { throw new Error('observer-secret'); } });
  let reached = false;
  engine.install(feature(() => { throw new Error('credential-secret-private-path'); }, { capabilities: [] }));
  engine.install(feature(() => { reached = true; }, { id: 'second', capabilities: [] }));
  const report = await engine.emit(event());
  assert.equal(report.outcomes[0].errorCode, 'FEATURE_FAILED');
  assert.equal(report.outcomes[1].status, 'completed');
  assert(reached);
  assert.doesNotMatch(JSON.stringify(engine.describe()), /secret|private-path/);
  await engine.stop();
});

test('setup publication is transactional and cleanup failures block replacement', async () => {
  const { engine } = fixture();
  const cleaned: string[] = [];
  assert.throws(() => engine.install(feature(() => {}, { setup(context) {
    context.defer(() => cleaned.push('first'));
    context.defer(() => cleaned.push('second'));
    context.on('message.received', () => {});
    throw new Error('setup-secret');
  } })), { code: 'SETUP_FAILED' });
  assert.deepEqual(cleaned, ['second', 'first']);
  assert.deepEqual((await engine.emit(event())).outcomes, []);
  engine.install(feature(() => {}, { setup(context) {
    context.on('message.received', () => {});
    return () => { throw new Error('cleanup-secret'); };
  } }));
  await assert.rejects(engine.uninstall('sample'), { code: 'CLEANUP_FAILED' });
  assert.throws(() => engine.install(feature(() => {})), { code: 'CLEANUP_REQUIRED' });
  await engine.stop();
});

test('uninstall aborts and drains active work without allowing a late send', async () => {
  const { engine, allow, sent } = fixture();
  allow();
  const entered = deferred(); const release = deferred();
  let signal!: AbortSignal;
  engine.install(feature(async execution => {
    signal = execution.signal;
    entered.resolve();
    await release.promise;
    await execution.send(message);
  }));
  const running = engine.emit(event());
  await entered.promise;
  const removal = engine.uninstall('sample');
  assert(signal.aborted);
  assert.equal(engine.describe().features[0].status, 'stopping');
  release.resolve();
  const report = await running;
  await removal;
  assert.equal(report.outcomes[0].errorCode, 'FEATURE_STOPPED');
  assert.equal(sent.length, 0);
  assert.equal(engine.describe().features[0].status, 'stopped');
  await engine.stop();
});

test('queued sends revalidate revocation before touching the adapter', async () => {
  const firstSend = deferred(); const release = deferred(); const calls: string[] = [];
  const { engine, policy, allow } = fixture({ transport: { async send(request) {
    calls.push(request.conversationId);
    if (calls.length === 1) { firstSend.resolve(); await release.promise; }
    return { status: 'confirmed', messageId: `receipt-${calls.length}` };
  } } });
  allow(); allow('sample', 'demo:other');
  engine.install(feature(async execution => { await execution.send(message); }));
  const first = engine.emit(event());
  await firstSend.promise;
  const second = engine.emit(event('two', 'demo:other'));
  await new Promise(resolve => setImmediate(resolve));
  policy.revoke('sample-demo:other');
  release.resolve();
  const reports = await Promise.all([first, second]);
  assert.deepEqual(calls, ['demo:room']);
  assert.equal(reports[1].outcomes[0].errorCode, 'POLICY_DENIED');
  await engine.stop();
});

test('uncertain delivery stays unknown and is not automatically repeated', async () => {
  let calls = 0;
  const { engine, allow } = fixture({ transport: { async send() { calls++; throw new Error('timeout-secret'); } } });
  allow();
  let receipt: DeliveryReceipt | undefined;
  engine.install(feature(async execution => { receipt = await execution.send(message); }));
  await engine.emit(event());
  await engine.emit(event());
  assert.equal(calls, 1);
  assert.deepEqual(receipt, { status: 'unknown' });
  assert.equal(engine.describe().outbox[0].status, 'unknown');
  assert.doesNotMatch(JSON.stringify(engine.describe()), /secret/);
  await engine.stop();
});

test('unawaited effects are drained and failed effects cannot be reported complete', async () => {
  const { engine } = fixture();
  engine.install(feature(execution => { execution.send(message); }));
  const report = await engine.emit(event());
  assert.equal(report.outcomes[0].errorCode, 'EFFECT_FAILED');
  assert.equal(engine.describe().outbox[0].status, 'denied');
  await engine.stop();
});

test('stop is shared, drains work, and blocks new events', async () => {
  const { engine } = fixture();
  const entered = deferred(); const release = deferred();
  engine.install(feature(async () => { entered.resolve(); await release.promise; }, { capabilities: [] }));
  const pending = engine.emit(event());
  await entered.promise;
  const first = engine.stop(); const second = engine.stop();
  assert.equal(first, second);
  assert.equal(engine.describe().status, 'stopping');
  assert.throws(() => engine.emit(event('late')), { code: 'ENGINE_STOPPED' });
  release.resolve();
  await Promise.all([pending, first, second]);
  assert.equal(engine.describe().status, 'stopped');
});

test('event backpressure preserves replay and releases capacity after settlement', async () => {
  const entered = deferred(); const release = deferred();
  const { engine } = fixture({ maxPendingEvents: 1 });
  engine.install(feature(async () => { entered.resolve(); await release.promise; }, { capabilities: [] }));
  const pending = engine.emit(event());
  await entered.promise;
  assert.equal(engine.emit(event()), pending);
  assert.throws(() => engine.emit(event('overflow')), { code: 'EVENT_BACKPRESSURE' });
  assert.equal(engine.describe().queues.pendingEvents, 1);
  release.resolve();
  await pending;
  await engine.emit(event('next'));
  assert.equal(engine.describe().queues.pendingEvents, 0);
  await engine.stop();
});

test('effect backpressure applies across conversations without consuming rejected work budgets', async () => {
  const entered = deferred(); const release = deferred();
  const { engine, policy, allow } = fixture({ maxPendingEffects: 1, transport: { async send() {
    entered.resolve(); await release.promise;
    return { status: 'confirmed', messageId: 'receipt' };
  } } });
  allow(); allow('sample', 'demo:other');
  engine.install(feature(async execution => { await execution.send(message); }));
  const first = engine.emit(event());
  await entered.promise;
  const overflow = await engine.emit(event('overflow', 'demo:other'));
  assert.equal(overflow.outcomes[0].errorCode, 'EFFECT_BACKPRESSURE');
  assert.equal(policy.describe().grants[1].used['messaging.send'], 0);
  release.resolve();
  await first;
  await engine.emit(event('next', 'demo:other'));
  assert.equal(engine.describe().queues.pendingEffects, 0);
  await engine.stop();
});

test('explicit transport rejection is distinct from an unknown delivery', async () => {
  const { engine, allow } = fixture({ transport: { async send() {
    return { status: 'rejected', reason: 'sensitive-adapter-detail' };
  } } });
  allow();
  let receipt: DeliveryReceipt | undefined;
  engine.install(feature(async execution => { receipt = await execution.send(message); }));
  await engine.emit(event());
  assert.deepEqual(receipt, { status: 'rejected' });
  assert.equal(engine.describe().outbox[0].status, 'rejected');
  assert.doesNotMatch(JSON.stringify(engine.describe()), /sensitive/);
  await engine.stop();
});

test('observer callbacks cannot interpose between final authorization and adapter invocation', async () => {
  const order: string[] = [];
  const { engine, allow, policy } = fixture({
    model: { async generate() { order.push('model.adapter'); return { text: 'answer' }; } },
    transport: { async send() { order.push('send.adapter'); return { status: 'confirmed', messageId: 'receipt' }; } },
    observer(entry) {
      if (entry.status !== 'started') return;
      order.push(`${entry.stage}.observer`);
      if (entry.stage === 'send') policy.setPaused(true);
    },
  });
  allow('sample', 'demo:room', ['messaging.send', 'model.respond']);
  engine.install(feature(async execution => {
    const result = await execution.generate({ text: 'input' });
    await execution.send([{ type: 'text', text: result.text }]);
  }, { capabilities: ['messaging.send', 'model.respond'] }));
  await engine.emit(event());
  assert.deepEqual(order, ['model.adapter', 'model.observer', 'send.adapter', 'send.observer']);
  assert.equal(engine.describe().outbox[0].status, 'confirmed');
  await engine.stop();
});

test('a synchronous handler lifecycle request still drains its registered execution', async () => {
  const entered = deferred(); const release = deferred();
  const { engine } = fixture();
  let cleaned = false;
  let removal: Promise<boolean> | undefined;
  engine.install(feature(() => {}, { capabilities: [], setup(context) {
    context.on('message.received', () => {
      removal = engine.uninstall('sample');
      entered.resolve();
      return release.promise;
    });
    return () => { cleaned = true; };
  } }));
  const pending = engine.emit(event());
  await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleaned, false);
  release.resolve();
  await Promise.all([pending, removal]);
  assert.equal(cleaned, true);
  await engine.stop();
});

test('host event and effect extensions reuse scoped authorization without changing the engine', async () => {
  const received: EffectRequest[] = [];
  let result: JsonValue | undefined;
  const { engine, allow } = fixture({
    eventValidators: { 'artifact.ready': data => typeof data.assetId === 'string' },
    effectAdapters: { 'artifact.inspect': { execute(request) {
      received.push(request);
      return { acceptable: true };
    } } },
  });
  const handler: FeatureHandler = async execution => { result = await execution.invoke('artifact.inspect', { assetId: 'fixture' }); };
  engine.install(feature(handler, { capabilities: ['artifact.inspect'], subscriptions: ['artifact.ready'],
    setup(context) { context.on('artifact.ready', handler); } }));
  const custom = { ...event('custom'), type: 'artifact.ready', data: { assetId: 'fixture' } };
  assert.throws(() => engine.emit({ ...custom, data: {} }), { code: 'INVALID_EVENT' });
  assert.equal((await engine.emit(custom)).outcomes[0].errorCode, 'POLICY_DENIED');
  assert.equal(received.length, 0);
  allow('sample', 'demo:room', ['artifact.inspect']);
  assert.equal((await engine.emit({ ...custom, id: 'allowed' })).outcomes[0].status, 'completed');
  assert.deepEqual(result, { acceptable: true });
  const captured = received[0];
  assert(captured);
  assert.equal(captured.scope.conversationId, 'demo:room');
  assert(Object.isFrozen(captured.input));
  assert(Object.isFrozen(captured.scope));
  assert(engine.describe().contracts.capabilities.includes('artifact.inspect'));
  assert.doesNotMatch(JSON.stringify(engine.describe().audit), /assetId|acceptable/);
  await engine.stop();
});

test('extension contracts cannot replace built-in safety paths or bypass declarations', async () => {
  assert.throws(() => fixture({ eventValidators: { 'message.received': () => true } }), { code: 'INVALID_EXTENSION' });
  assert.throws(() => fixture({ effectAdapters: { 'messaging.send': { execute: () => null } } }), { code: 'INVALID_EXTENSION' });
  let calls = 0;
  const { engine, allow } = fixture({ effectAdapters: { 'artifact.inspect': { execute() { calls++; return null; } } } });
  allow('sample', 'demo:room', ['artifact.inspect']);
  engine.install(feature(async execution => { await execution.invoke('artifact.inspect', null); }, { capabilities: [] }));
  assert.equal((await engine.emit(event())).outcomes[0].errorCode, 'UNDECLARED_CAPABILITY');
  assert.equal(calls, 0);
  await engine.stop();
});
