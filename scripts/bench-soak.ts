import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.BENCH_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const { createEngine } = await import(pathToFileURL(resolve(root, 'src/core/engine.ts')).href) as typeof import('../src/core/engine.ts');
const { createContextStore, createFeatureState } = await import(pathToFileURL(resolve(root, 'src/core/context.ts')).href) as typeof import('../src/core/context.ts');
assert(typeof global.gc === 'function', 'Run with node --expose-gc for comparable heap samples.');
const context = createContextStore();
const state = createFeatureState();
const persona = context.registerPersona({ id: 'soak', version: '1.0.0', name: 'Soak fixture', identity: {}, style: {} });
const engine = createEngine({ context, state, persona, historyLimit: 128,
  transport: { send: () => ({ status: 'confirmed', messageId: 'fixture' }) } });
engine.install({ id: 'soak', version: '1.0.0', apiVersion: 1, capabilities: [], subscriptions: ['message.received'],
  setup(context) { context.on('message.received', () => {}); } });
const perWindow = Number(process.env.BENCH_WINDOW ?? 4000);
assert(Number.isSafeInteger(perWindow) && perWindow >= 100 && perWindow <= 10000);
for (let ordinal = 0; ordinal < 500; ordinal++) {
  await engine.emit({ id: `warmup-${ordinal}`, type: 'message.received', conversationId: 'soak:warmup', data: {} });
}
global.gc();
const initialMemory = process.memoryUsage();
const windows = [];
for (let window = 0; window < 3; window++) {
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  let timerTicks = 0;
  const timer = setInterval(() => timerTicks++, 5);
  try {
    for (let ordinal = 0; ordinal < perWindow; ordinal++) {
      const id = `${window}-${ordinal}`;
      const report = await engine.emit({ id, type: 'message.received', conversationId: `soak:${id}`, data: {} });
      assert.equal(report.outcomes[0].status, 'completed');
    }
  } finally { clearInterval(timer); }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  global.gc();
  const memory = process.memoryUsage();
  const metrics = typeof engine.metrics === 'function' ? engine.metrics() : null;
  if (metrics) {
    assert(metrics.retention.events <= 128 && metrics.retention.audit <= 128);
    assert.equal(metrics.queues.pendingEvents, 0);
    assert.equal(metrics.queues.pendingEffects, 0);
  }
  windows.push({ window: window + 1, completedEvents: (window + 1) * perWindow,
    elapsedMs, opsPerSecond: perWindow * 1000 / elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000,
    timerTicks, heapUsedBytes: memory.heapUsed, rssBytes: memory.rss,
    heapDeltaBytesFromWarmup: memory.heapUsed - initialMemory.heapUsed, stateNamespaces: state.describe().namespaces.length, metrics });
}
await engine.stop();
console.log(JSON.stringify({ benchmark: 'short-soak', node: process.version, warmup: 500, eventsPerWindow: perWindow,
  explicitGc: true, initialHeapUsedBytes: initialMemory.heapUsed, initialRssBytes: initialMemory.rss, windows,
  limitation: 'Three short offline windows, not an hours-long memory-leak proof or production workload.' }, null, 2));
