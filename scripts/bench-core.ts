import assert from 'node:assert/strict';
import { cpus, availableParallelism, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { FeatureDefinition, TransportAdapter } from '../src/core/types.ts';

const root = process.env.BENCH_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const { createEngine } = await import(pathToFileURL(resolve(root, 'src/core/engine.ts')).href) as typeof import('../src/core/engine.ts');
const { createContextStore, createFeatureState } = await import(pathToFileURL(resolve(root, 'src/core/context.ts')).href) as typeof import('../src/core/context.ts');
const { createPolicy } = await import(pathToFileURL(resolve(root, 'src/core/policy.ts')).href) as typeof import('../src/core/policy.ts');
const iterations = Number(process.env.BENCH_ITERATIONS ?? 2000);
assert(Number.isSafeInteger(iterations) && iterations >= 100 && iterations <= 10000);

function quantile(samples: number[], fraction: number) {
  return samples[Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)] ?? 0;
}

function fixture(unrelated = 0) {
  const context = createContextStore();
  const state = createFeatureState();
  const policy = createPolicy();
  const persona = context.registerPersona({ id: 'benchmark', version: '1.0.0', name: 'Benchmark', identity: {}, style: {} });
  const transport: TransportAdapter = { send: () => ({ status: 'confirmed', messageId: 'mock-receipt' }) };
  const engine = createEngine({ context, state, policy, persona, transport });
  for (let ordinal = 0; ordinal < unrelated; ordinal++) {
    engine.install({ id: `idle-${ordinal}`, version: '1.0.0', apiVersion: 1, capabilities: [], subscriptions: ['trigger.fired'],
      setup(context) { context.on('trigger.fired', () => {}); } });
  }
  const feature: FeatureDefinition = { id: 'benchmark', version: '1.0.0', apiVersion: 1,
    capabilities: [], subscriptions: ['message.received'], setup(context) { context.on('message.received', () => {}); } };
  engine.install(feature);
  return { engine, state };
}

async function throughput(unrelated: number, freshConversations = false) {
  const { engine, state } = fixture(unrelated);
  const warmup = 200;
  for (let ordinal = 0; ordinal < warmup; ordinal++) {
    await engine.emit({ id: `warmup-${ordinal}`, type: 'message.received', conversationId: 'bench:room', data: { text: 'fixture' } });
  }
  global.gc?.();
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const samples: number[] = [];
  const started = performance.now();
  let timerTicks = 0;
  const timer = setInterval(() => timerTicks++, 5);
  try {
    for (let ordinal = 0; ordinal < iterations; ordinal++) {
      const acceptedAt = performance.now();
      const report = await engine.emit({ id: `event-${ordinal}`, type: 'message.received',
        conversationId: freshConversations ? `bench:${ordinal}` : 'bench:room', data: { text: 'fixture' } });
      assert.equal(report.outcomes.length, 1);
      assert.equal(report.outcomes[0].status, 'completed');
      samples.push(performance.now() - acceptedAt);
    }
  } finally { clearInterval(timer); }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  global.gc?.();
  const memoryAfter = process.memoryUsage();
  samples.sort((left, right) => left - right);
  const stateNamespaces = state.describe().namespaces.length;
  const retained = engine.describe();
  await engine.stop();
  await nextTurn();
  return { name: freshConversations ? 'fresh-conversations-without-state-access' : 'single-active-feature', unrelatedFeatures: unrelated,
    operations: iterations, warmup, elapsedMs, opsPerSecond: iterations * 1000 / elapsedMs,
    latencyMs: { p50: quantile(samples, 0.5), p95: quantile(samples, 0.95), p99: quantile(samples, 0.99) },
    cpuMs: (cpu.user + cpu.system) / 1000, timerTicks,
    heapDeltaBytesAfterGc: global.gc ? memoryAfter.heapUsed - memoryBefore.heapUsed : null,
    rssDeltaBytes: memoryAfter.rss - memoryBefore.rss, stateNamespaces,
    retained: { audit: retained.audit.length, outbox: retained.outbox.length } };
}

async function burst() {
  const { engine } = fixture();
  const requests = Array.from({ length: 300 }, (_, ordinal) => ({ id: `burst-${ordinal}`, type: 'message.received',
    conversationId: 'bench:room', data: {} }));
  let rejected = 0;
  const pending = [];
  const started = performance.now();
  for (const request of requests) {
    try { pending.push(engine.emit(request)); }
    catch (error) {
      assert(error instanceof Error && 'code' in error && error.code === 'EVENT_BACKPRESSURE');
      rejected++;
    }
  }
  const peak = engine.describe().queues.pendingEvents;
  await Promise.all(pending);
  const elapsedMs = performance.now() - started;
  await engine.stop();
  assert.equal(rejected, 44);
  return { name: 'bounded-burst', attempted: requests.length, accepted: pending.length, rejected, peakPendingEvents: peak, elapsedMs };
}

async function slowPeer() {
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'benchmark', version: '1.0.0', name: 'Benchmark', identity: {}, style: {} });
  const policy = createPolicy();
  let markStarted!: () => void;
  const entered = new Promise<void>(resolve => { markStarted = resolve; });
  const engine = createEngine({ context, persona, policy, transport: { async send(request) {
    if (request.conversationId === 'bench:slow') { markStarted(); await delay(80); }
    return { status: 'confirmed', messageId: 'receipt' };
  } }, maxConcurrentSends: Number(process.env.BENCH_SEND_CONCURRENCY ?? 1) });
  engine.install({ id: 'sender', version: '1.0.0', apiVersion: 1, capabilities: ['messaging.send'], subscriptions: ['message.received'],
    setup(context) { context.on('message.received', execution => execution.send([{ type: 'text', text: 'fixture' }])); } });
  for (const conversationId of ['bench:slow', 'bench:fast']) {
    policy.grant({ id: conversationId, featureId: 'sender', conversationId, capabilities: ['messaging.send'], maxUses: { 'messaging.send': 1 } });
  }
  const first = engine.emit({ id: 'slow', type: 'message.received', conversationId: 'bench:slow', data: {} });
  await entered;
  const started = performance.now();
  await engine.emit({ id: 'fast', type: 'message.received', conversationId: 'bench:fast', data: {} });
  const fastPeerLatencyMs = performance.now() - started;
  await first;
  await engine.stop();
  return { name: 'slow-peer-send-queue', configuredConcurrency: Number(process.env.BENCH_SEND_CONCURRENCY ?? 1),
    simulatedPeerDelayMs: 80, fastPeerLatencyMs };
}

async function observation() {
  const { engine } = fixture(1000);
  for (let ordinal = 0; ordinal < 300; ordinal++) await engine.emit({ id: `snapshot-${ordinal}`,
    type: 'message.received', conversationId: 'bench:snapshot', data: {} });
  const samples = [];
  for (const method of ['describe', 'metrics'] as const) {
    const callback = engine[method];
    if (typeof callback !== 'function') { samples.push({ method, supported: false }); continue; }
    for (let ordinal = 0; ordinal < 10; ordinal++) callback();
    const started = performance.now();
    for (let ordinal = 0; ordinal < 100; ordinal++) callback();
    const elapsedMs = performance.now() - started;
    samples.push({ method, supported: true, operations: 100, elapsedMs, opsPerSecond: 100000 / elapsedMs });
  }
  await engine.stop();
  return { name: 'observation-1000-feature-metadata', samples };
}

const scenarios = [];
if (process.env.BENCH_ONLY !== 'slow-peer') {
  for (const count of [0, 100, 1000]) scenarios.push(await throughput(count));
  scenarios.push(await throughput(0, true));
}
const output = { benchmark: 'core', node: process.version, platform: process.platform, architecture: process.arch,
  cpu: cpus()[0]?.model ?? 'unknown', availableParallelism: availableParallelism(), totalMemoryBytes: totalmem(),
  explicitGc: typeof global.gc === 'function', iterations, scenarios,
  burst: process.env.BENCH_ONLY === 'slow-peer' ? null : await burst(), slowPeer: await slowPeer(),
  observation: process.env.BENCH_ONLY === 'slow-peer' ? null : await observation() };
console.log(JSON.stringify(output, null, 2));
