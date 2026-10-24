import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { createContextStore } from '../src/core/context.ts';
import { createEngine } from '../src/core/engine.ts';
import { createPolicy } from '../src/core/policy.ts';
import type { DeliveryReceipt, EffectAdapter, FeatureDefinition, FeatureExecution, ModelAdapter,
  SendRequest, TransportAdapter } from '../src/core/types.ts';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function fixture(options: {
  eventTimeoutMs?: number;
  maxPendingEffects?: number;
  transport?: TransportAdapter;
  model?: ModelAdapter;
  effectAdapters?: Record<string, EffectAdapter>;
} = {}) {
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'deadline', version: '1.0.0', name: 'Deadline',
    identity: { role: 'test' }, style: { tone: 'brief' } });
  const policy = createPolicy();
  const transport = options.transport ?? { send() { return { status: 'confirmed' as const, messageId: 'sent' }; } };
  const engine = createEngine({ context, persona, policy, transport, model: options.model,
    effectAdapters: options.effectAdapters, eventTimeoutMs: options.eventTimeoutMs ?? 30,
    maxPendingEffects: options.maxPendingEffects });
  const grant = (capabilities: string[]) => policy.grant({ id: `grant-${capabilities.join('-')}`, featureId: 'deadline',
    conversationId: 'room', capabilities, maxUses: Object.fromEntries(capabilities.map(capability => [capability, 10])) });
  return { engine, policy, grant };
}

function feature(handler: (execution: FeatureExecution, event: { id: string }) => unknown,
  capabilities: string[] = []): FeatureDefinition {
  return { id: 'deadline', version: '1.0.0', apiVersion: 1, capabilities, subscriptions: ['message.received'],
    setup(context) { context.on('message.received', handler); } };
}

function event(id: string) {
  return { id, type: 'message.received', conversationId: 'room', data: {} };
}

async function within<Value>(promise: Promise<Value>, milliseconds = 250): Promise<Value> {
  return Promise.race([promise, delay(milliseconds).then(() => { throw new Error('operation did not settle'); })]);
}

test('event timeout options reject disabled and out-of-range deadlines', () => {
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'deadline', version: '1.0.0', name: 'Deadline',
    identity: {}, style: {} });
  const transport: TransportAdapter = { send() { return { status: 'unknown' }; } };
  for (const eventTimeoutMs of [0, 9, 300001, 20.5]) {
    assert.throws(() => createEngine({ context, persona, transport, eventTimeoutMs }), { code: 'INVALID_ENGINE' });
  }
});

test('per-event timeout is bounded by the engine limit and starts when emitted', async () => {
  const { engine } = fixture({ eventTimeoutMs: 50 });
  engine.install(feature(() => new Promise<void>(() => {})));
  assert.throws(() => engine.emit(event('disabled'), { timeoutMs: 0 }), { code: 'INVALID_EVENT_OPTIONS' });
  assert.throws(() => engine.emit(event('over-limit'), { timeoutMs: 51 }), { code: 'INVALID_EVENT_OPTIONS' });
  assert.throws(() => engine.emit(event('invalid-signal'), { signal: {} as AbortSignal }), { code: 'INVALID_EVENT_OPTIONS' });
  const startedAt = performance.now();
  const report = await within(engine.emit(event('short'), { timeoutMs: 15 }));
  assert.equal(report.outcomes[0].errorCode, 'EVENT_TIMEOUT');
  assert(performance.now() - startedAt < 45);
  await engine.stop();
});

test('hung handlers time out, abort their execution, release capacity, and let stop finish', async () => {
  const { engine } = fixture({ eventTimeoutMs: 25 });
  const entered = deferred<void>();
  let signal: AbortSignal | undefined;
  engine.install(feature(execution => {
    signal = execution.signal;
    entered.resolve();
    return new Promise<void>(() => {});
  }));
  const pending = engine.emit(event('hung-handler'));
  await entered.promise;
  const stopping = engine.stop();
  const report = await within(pending);
  await within(stopping);
  assert.equal(report.outcomes[0].errorCode, 'EVENT_TIMEOUT');
  assert.equal(signal?.aborted, true);
  assert.equal(engine.metrics().queues.pendingEvents, 0);
  assert.equal(engine.describe().status, 'stopped');
});

test('hung model and custom effects report unknown timeout without unhandled late rejection', async () => {
  const modelResult = deferred<{ text: string }>();
  const customResult = deferred<null>();
  const { engine, policy, grant } = fixture({ eventTimeoutMs: 25,
    model: { generate() { return modelResult.promise; } },
    effectAdapters: { 'artifact.inspect': { execute() { return customResult.promise; } } } });
  grant(['model.respond', 'artifact.inspect']);
  engine.install(feature(async (execution, received) => {
    if (received.id === 'model') await execution.generate({ prompt: 'hello' });
    else await execution.invoke('artifact.inspect', null);
  }, ['model.respond', 'artifact.inspect']));
  const modelReport = await within(engine.emit(event('model')));
  const customReport = await within(engine.emit(event('custom')));
  assert.equal(modelReport.outcomes[0].errorCode, 'EVENT_TIMEOUT_UNKNOWN');
  assert.equal(customReport.outcomes[0].errorCode, 'EVENT_TIMEOUT_UNKNOWN');
  const used = policy.describe().grants[0].used;
  assert.equal(used['model.respond'], 1);
  assert.equal(used['artifact.inspect'], 1);
  modelResult.reject(new Error('late model rejection'));
  customResult.reject(new Error('late custom rejection'));
  await nextTurn();
  await engine.stop();
});

test('raw provider promises stay bounded after event aborts and release capacity only when settled', async () => {
  const operations: Array<ReturnType<typeof deferred<{ text: string }>>> = [];
  const starts = Array.from({ length: 4 }, () => deferred<void>());
  let calls = 0;
  const { engine, policy, grant } = fixture({ eventTimeoutMs: 5_000, maxPendingEffects: 3,
    model: { generate() {
      const callIndex = calls++;
      const operation = deferred<{ text: string }>();
      operations.push(operation);
      starts[callIndex].resolve();
      return operation.promise;
    } } });
  grant(['model.respond']);
  engine.install(feature(async execution => {
    await execution.generate({ prompt: 'bounded' });
  }, ['model.respond']));
  const reports = [];
  for (let index = 0; index < 3; index += 1) {
    const controller = new AbortController();
    const pending = engine.emit(event(`raw-${index}`), { signal: controller.signal });
    await within(starts[index].promise, 1_000);
    controller.abort();
    reports.push(await within(pending, 1_000));
  }
  for (let index = 3; index < 8; index += 1) {
    reports.push(await within(engine.emit(event(`raw-${index}`)), 1_000));
  }
  assert.equal(calls, 3);
  assert.equal(engine.metrics().queues.pendingEffects, 0);
  assert.equal(engine.metrics().queues.rawPendingEffects, 3);
  assert.equal(policy.describe().grants[0].used['model.respond'], 3);
  assert.equal(reports[2].outcomes[0].errorCode, 'EVENT_ABORTED_UNKNOWN');
  assert.equal(reports[3].outcomes[0].errorCode, 'EFFECT_BACKPRESSURE');
  operations[0].resolve({ text: 'late' });
  await nextTurn();
  assert.equal(engine.metrics().queues.rawPendingEffects, 2);
  const recoveryController = new AbortController();
  const recoveryPending = engine.emit(event('raw-recovered'), { signal: recoveryController.signal });
  await within(starts[3].promise, 1_000);
  recoveryController.abort();
  const recovered = await within(recoveryPending, 1_000);
  assert.equal(calls, 4);
  assert.equal(recovered.outcomes[0].errorCode, 'EVENT_ABORTED_UNKNOWN');
  assert.equal(engine.metrics().queues.rawPendingEffects, 3);
  for (const operation of operations) operation.resolve({ text: 'settled' });
  await nextTurn();
  assert.equal(engine.metrics().queues.rawPendingEffects, 0);
  await engine.stop();
});

test('hung send becomes unknown and a timed-out execution rejects late effects', async () => {
  const delivery = deferred<DeliveryReceipt>();
  const entered = deferred<void>();
  const requests: SendRequest[] = [];
  const { engine, policy, grant } = fixture({ eventTimeoutMs: 500, transport: { send(request) {
    requests.push(request);
    entered.resolve();
    return delivery.promise;
  } } });
  grant(['messaging.send']);
  let captured: FeatureExecution | undefined;
  let receipt: DeliveryReceipt | undefined;
  engine.install(feature(async execution => {
    captured = execution;
    receipt = await execution.send([{ type: 'text', text: 'hello' }]);
  }, ['messaging.send']));
  const pending = engine.emit(event('send'));
  await within(entered.promise, 1_000);
  const report = await within(pending, 1_000);
  assert.equal(report.outcomes[0].errorCode, 'EVENT_TIMEOUT_UNKNOWN');
  assert.deepEqual(receipt, { status: 'unknown' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(policy.describe().grants[0].used['messaging.send'], 1);
  assert.throws(() => captured?.send([{ type: 'text', text: 'late' }]), { code: 'EVENT_TIMEOUT' });
  delivery.resolve({ status: 'confirmed', messageId: 'too-late' });
  await nextTurn();
  assert.equal(engine.describe().outbox[0].status, 'unknown');
  assert.equal(engine.metrics().queues.pendingEffects, 0);
  await engine.stop();
});

test('parent abort during send fences execution and reports an unknown side effect', async () => {
  const delivery = deferred<DeliveryReceipt>();
  const entered = deferred<void>();
  const controller = new AbortController();
  const { engine, policy, grant } = fixture({ eventTimeoutMs: 100, transport: { send() {
    entered.resolve();
    return delivery.promise;
  } } });
  grant(['messaging.send']);
  let captured: FeatureExecution | undefined;
  engine.install(feature(async execution => {
    captured = execution;
    await execution.send([{ type: 'text', text: 'cancel' }]);
  }, ['messaging.send']));
  const pending = engine.emit(event('abort-send'), { signal: controller.signal });
  await entered.promise;
  controller.abort();
  const report = await within(pending);
  assert.equal(report.outcomes[0].errorCode, 'EVENT_ABORTED_UNKNOWN');
  assert.equal(engine.describe().outbox[0].status, 'unknown');
  assert.equal(engine.describe().outbox[0].errorCode, 'EVENT_ABORTED_UNKNOWN');
  assert.equal(policy.describe().grants[0].used['messaging.send'], 1);
  assert.throws(() => captured?.send([{ type: 'text', text: 'late' }]), { code: 'EVENT_ABORTED' });
  delivery.reject(new Error('late delivery rejection'));
  await nextTurn();
  await engine.stop();
});

test('parent abort expires a queued event without bypassing the active conversation barrier', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const controller = new AbortController();
  let queuedCalls = 0;
  let nextCalls = 0;
  let transportCalls = 0;
  const { engine, policy, grant } = fixture({ eventTimeoutMs: 100, transport: { send() {
    transportCalls++;
    return { status: 'confirmed', messageId: `sent-${transportCalls}` };
  } } });
  grant(['messaging.send']);
  engine.install(feature(async (execution, received) => {
    if (received.id === 'block') {
      entered.resolve();
      await release.promise;
      return;
    }
    if (received.id === 'queued-abort') queuedCalls++;
    if (received.id === 'after-abort') nextCalls++;
    await execution.send([{ type: 'text', text: received.id }]);
  }, ['messaging.send']));
  const blocked = engine.emit(event('block'));
  await entered.promise;
  const queued = engine.emit(event('queued-abort'), { signal: controller.signal });
  const next = engine.emit(event('after-abort'));
  controller.abort();
  const queuedReport = await within(queued);
  assert.equal(queuedReport.outcomes[0].errorCode, 'EVENT_ABORTED');
  assert.equal(queuedCalls, 0);
  assert.equal(policy.describe().grants[0].used['messaging.send'], 0);
  await delay(10);
  assert.equal(nextCalls, 0);
  release.resolve();
  await within(blocked);
  const nextReport = await within(next);
  assert.equal(nextReport.outcomes[0].status, 'completed');
  assert.equal(nextCalls, 1);
  assert.equal(transportCalls, 1);
  await engine.stop();
});

test('an event expired in the conversation queue spends no budget and the next event runs', async () => {
  let queuedCalls = 0;
  let transportCalls = 0;
  const { engine, policy, grant } = fixture({ eventTimeoutMs: 20, transport: { send() {
    transportCalls++;
    return { status: 'confirmed', messageId: `sent-${transportCalls}` };
  } } });
  grant(['messaging.send']);
  engine.install(feature(async (execution, received) => {
    if (received.id === 'block') {
      const releaseAt = performance.now() + 35;
      while (performance.now() < releaseAt) {}
      return;
    }
    if (received.id === 'queued') queuedCalls++;
    await execution.send([{ type: 'text', text: received.id }]);
  }, ['messaging.send']));
  const blocked = engine.emit(event('block'));
  const queued = engine.emit(event('queued'));
  const [blockedReport, queuedReport] = await within(Promise.all([blocked, queued]));
  assert.equal(blockedReport.outcomes[0].errorCode, 'EVENT_TIMEOUT');
  assert.equal(queuedReport.outcomes[0].errorCode, 'EVENT_TIMEOUT');
  assert.equal(queuedCalls, 0);
  assert.equal(policy.describe().grants[0].used['messaging.send'], 0);
  assert.equal(transportCalls, 0);
  const nextReport = await within(engine.emit(event('next')));
  assert.equal(nextReport.outcomes[0].status, 'completed');
  assert.equal(transportCalls, 1);
  await engine.stop();
});
