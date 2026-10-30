import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonValue } from '../src/core/types.ts';
import type { DurableStore, WriteOptions } from '../src/contracts/ports.ts';
import { FrameworkError } from '../src/core/values.ts';
import { parsePluginScheduleBusinessDetails } from '../src/contracts/plugin-schedules.ts';
import { createPluginSchedulerService, type PluginScheduleInput, type PluginScheduledOccurrence } from '../src/host/plugin-scheduler.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

const initial = Date.parse('2026-01-01T00:00:00Z');
const day = 86_400_000;

test('related business schedules are bounded same-plugin references without executable destinations', () => {
  const details = { stage: 'Planned', summary: 'One post is pending', sessionId: null, canSkip: false, result: null,
    relatedSchedules: [{ id: 'post-one', label: 'Publish one' }] };
  assert.deepEqual(parsePluginScheduleBusinessDetails(details)?.relatedSchedules, details.relatedSchedules);
  for (const relatedSchedules of [
    [{ id: 'post-one', label: 'Publish one', owner: 'another-plugin' }],
    [{ id: 'post-one', label: 'Publish one', url: '/api/unsafe' }],
    [{ id: 'post-one', label: '' }],
    [details.relatedSchedules[0], details.relatedSchedules[0]],
    Array.from({ length: 9 }, (_, index) => ({ id: `post-${index}`, label: 'Post' })),
  ]) assert.equal(parsePluginScheduleBusinessDetails({ ...details, relatedSchedules }), null);
});
function fixture(context: TestContext, options: { maxRules?: number; maxHistory?: number; callbackTimeoutMs?: number; intervalMs?: number } = {}) {
  let now = initial;
  const store = createSqliteStore({ filename: ':memory:', clock: () => now });
  const service = createPluginSchedulerService({ store, clock: () => now, intervalMs: 60_000, ...options });
  context.after(async () => { await service.stop(); store.close(); });
  return { service, store, setNow(value: number) { now = value; } };
}
function once(id: string, at: number, changes: Partial<PluginScheduleInput> = {}): PluginScheduleInput {
  return { id, handler: 'publish', payload: { businessId: id }, schedule: { kind: 'once', at }, ...changes };
}

test('manual execution consumes a pending once schedule atomically and survives caller cancellation', async context => {
  const { service, setNow } = fixture(context);
  const plugin = service.forPlugin('manual', new AbortController().signal);
  let calls = 0;
  let finish!: () => void;
  plugin.registerHandler('publish', () => { calls++; });
  plugin.registerDetailsProvider('publish', { read: () => null, canRunNow: () => true,
    async runNow(_rule, occurrence) { calls++; await new Promise<void>(resolve => { finish = resolve; }); occurrence.signal.throwIfAborted(); } });
  plugin.schedule(once('early', initial + 60_000)); service.start();
  const item = service.listManaged().items[0]!;
  assert.equal(item.actions.canRunNow, true);
  const caller = new AbortController();
  const accepted = await service.manage({ action: 'run-now', owner: 'manual', id: 'early', revision: item.revision }, caller.signal);
  caller.abort();
  assert.equal(accepted.managementState, 'running-now');
  await assert.rejects(service.manage({ action: 'run-now', owner: 'manual', id: 'early', revision: item.revision }, new AbortController().signal));
  finish();
  for (let turn = 0; turn < 10 && service.listManaged().items[0]!.managementState !== 'ready'; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  setNow(initial + 60_000); await service.tick();
  assert.equal(calls, 1, 'the original scheduled occurrence is not submitted after the manual run');
  assert.equal(plugin.history().length, 1);
  assert.equal(plugin.history()[0]!.status, 'completed');
});

test('manual execution remains unknown after interruption and is never automatically replayed', async context => {
  const { service, store } = fixture(context);
  const plugin = service.forPlugin('interrupted-manual', new AbortController().signal);
  let calls = 0;
  plugin.registerHandler('publish', () => {});
  plugin.registerDetailsProvider('publish', { read: () => null, canRunNow: () => true,
    async runNow(_rule, occurrence) { calls++; await new Promise<void>(resolve => occurrence.signal.addEventListener('abort', () => resolve(), { once: true })); } });
  plugin.schedule(once('one', initial + 60_000)); service.start();
  const item = service.listManaged().items[0]!;
  await service.manage({ action: 'run-now', owner: item.owner, id: item.id, revision: item.revision }, new AbortController().signal);
  await service.stop();
  const restarted = createPluginSchedulerService({ store, clock: () => initial, intervalMs: 60_000 });
  restarted.start(); await restarted.tick();
  assert.equal(restarted.listManaged().items[0]!.managementState, 'unknown');
  assert.equal(restarted.managedHistory().items[0]!.status, 'unknown');
  assert.equal(calls, 1);
  await restarted.stop();
});

test('registration has no activity before start, identities are isolated, and schedule changes use CAS', async context => {
  const { service, setNow } = fixture(context);
  const calls: string[] = [];
  const a = service.forPlugin('plugin-a', new AbortController().signal);
  const b = service.forPlugin('plugin-b', new AbortController().signal);
  a.registerHandler('publish', occurrence => { calls.push('a:' + occurrence.ruleId); });
  b.registerHandler('publish', occurrence => { calls.push('b:' + occurrence.ruleId); });
  const input = once('same', initial + 60_000);
  const first = a.schedule(input);
  assert.deepEqual(a.schedule(input), first);
  b.schedule(input);
  assert.throws(() => a.schedule({ ...input, payload: { changed: true } }), { code: 'PLUGIN_SCHEDULER_CONFLICT' });
  assert.throws(() => a.schedule(input, { expectedRevision: first.revision + 1 }), { code: 'PLUGIN_SCHEDULER_CONFLICT' });
  const changed = a.schedule({ ...input, payload: { changed: true } }, { expectedRevision: first.revision });
  assert.equal(changed.generation, 2);
  assert.equal(a.list().length, 1);
  assert.deepEqual(a.list()[0].payload, { changed: true });
  setNow(initial + 60_000);
  await service.tick();
  assert.deepEqual(calls, []);
  service.start();
  service.start();
  await service.tick();
  assert.deepEqual(calls.sort(), ['a:same', 'b:same']);
  assert.equal(a.list()[0].state, 'completed');
  assert.equal(a.history()[0].ruleId, 'same');
  assert.equal(b.history().length, 1);
  await service.tick();
  assert.equal(calls.length, 2);
});

test('the host timer runs registered rules after start and stops without polling or external services', async context => {
  const { service, setNow } = fixture(context, { intervalMs: 10 });
  const client = service.forPlugin('timer', new AbortController().signal);
  let calls = 0;
  let completed: (() => void) | undefined;
  client.registerHandler('publish', () => { calls++; completed?.(); });
  client.schedule(once('timer-once', initial + 60_000));
  setNow(initial + 60_000);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>(resolve => { completed = resolve; service.start(); service.start(); }),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Scheduler timer did not fire')), 1000); }),
    ]);
  } finally { clearTimeout(timeout); }
  assert.equal(calls, 1);
  await service.stop();
  client.schedule(once('while-stopped', initial + 120_000));
  setNow(initial + 120_000);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.equal(service.status().running, false);
});

test('unloaded callbacks preserve pending once work and hot reload cannot invoke stale handlers', async context => {
  const { service, setNow } = fixture(context);
  const oldLifetime = new AbortController();
  const old = service.forPlugin('reloadable', oldLifetime.signal);
  let stale = 0;
  const unregister = old.registerHandler('publish', () => { stale++; });
  old.schedule(once('reload-window', initial + 60_000));
  unregister();
  service.start();
  setNow(initial + 60_000);
  await service.tick();
  assert.equal(old.history().length, 0);
  oldLifetime.abort();
  const fresh = service.forPlugin('reloadable', new AbortController().signal);
  let current = 0;
  fresh.registerHandler('publish', () => { current++; });
  unregister();
  await service.tick();
  assert.equal(stale, 0);
  assert.equal(current, 1);
  assert.throws(() => old.list(), { name: 'AbortError' });
});

test('unregister aborts an active handler and an interrupted result is never retried after restart', async context => {
  const { service, setNow } = fixture(context);
  const plugin = service.forPlugin('active', new AbortController().signal);
  let started: (() => void) | undefined;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let signal: AbortSignal | undefined;
  const unregister = plugin.registerHandler('publish', occurrence => {
    signal = occurrence.signal;
    started?.();
    return new Promise<void>(resolve => occurrence.signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  plugin.schedule(once('active-once', initial + 60_000));
  service.start();
  setNow(initial + 60_000);
  const ticking = service.tick();
  await entered;
  unregister();
  await ticking;
  assert.equal(signal?.aborted, true);
  assert.equal(plugin.history()[0].status, 'unknown');
  await service.stop();
  plugin.registerHandler('publish', () => { assert.fail('Never retry an interrupted callback'); });
  service.start();
  await service.tick();
  assert.equal(plugin.history().length, 1);
});

test('explicit long callback deadlines stay bounded and stop aborts immediately with durable unknown evidence', async context => {
  const { service, store, setNow } = fixture(context, { callbackTimeoutMs: 30 * 60_000 });
  assert.throws(() => createPluginSchedulerService({ store, callbackTimeoutMs: 3_600_001 }), { code: 'INVALID_CALENDAR_OPTIONS' });
  const client = service.forPlugin('long-generation', new AbortController().signal);
  let entered: (() => void) | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | undefined;
  client.registerHandler('publish', occurrence => {
    signal = occurrence.signal;
    entered?.();
    return new Promise(() => {});
  });
  client.schedule(once('long', initial + 60_000, { windowMs: 3_600_000 }));
  service.start(); setNow(initial + 60_000);
  const ticking = service.tick();
  await started;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      service.stop(),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Stop waited for long callback')), 1000); }),
    ]);
  } finally { clearTimeout(timeout); }
  await ticking;
  assert.equal(signal?.aborted, true);
  assert.equal(client.history()[0].status, 'unknown');
  service.start(); await service.tick();
  assert.equal(client.history().length, 1);
});

test('persistent once and daily rules resume after storage reopens without replaying completed work', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'qbf-plugin-schedule-'));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const filename = join(directory, 'scheduler.sqlite');
  let now = initial;
  const firstStore = createSqliteStore({ filename, clock: () => now });
  const first = createPluginSchedulerService({ store: firstStore, clock: () => now, intervalMs: 60_000 });
  const firstClient = first.forPlugin('persisted', new AbortController().signal);
  firstClient.schedule(once('once', initial + 60_000));
  firstClient.schedule(once('daily', 0, { schedule: { kind: 'daily', hour: 8, minute: 1 }, timeZone: 'Asia/Shanghai' }));
  await first.stop(); firstStore.close();

  now += 61_000;
  const store = createSqliteStore({ filename, clock: () => now });
  const service = createPluginSchedulerService({ store, clock: () => now, intervalMs: 60_000 });
  context.after(async () => { await service.stop(); store.close(); });
  const client = service.forPlugin('persisted', new AbortController().signal);
  const calls: PluginScheduledOccurrence[] = [];
  client.registerHandler('publish', occurrence => { calls.push(occurrence); });
  service.start();
  await service.tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].scheduledAt, initial + 60_000);
  await service.stop(); service.start();
  await service.tick();
  assert.equal(calls.length, 2);
  now += day;
  await service.tick();
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1)?.ruleId, 'daily');
});

test('stored dispatch intents recover to unknown, retain beyond seven days, and respect history capacity', async context => {
  let now = initial;
  const base = createSqliteStore({ filename: ':memory:', clock: () => now });
  context.after(() => base.close());
  let interrupt = true;
  const store: DurableStore = { ...base,
    compareAndSetBatch(mutations) {
      const result = base.compareAndSetBatch!(mutations);
      if (interrupt && mutations.some(mutation => mutation.kind === 'write' && mutation.namespace === 'plugin-scheduler.calendar-trigger-occurrences')) {
        interrupt = false;
        throw new FrameworkError('SIMULATED_POWER_LOSS', 'Interrupted after durable claim.');
      }
      return result;
    },
    write(namespace: string, key: string, value: JsonValue, options?: WriteOptions) {
      const result = base.write(namespace, key, value, options);
      if (interrupt && namespace === 'plugin-scheduler.calendar-trigger-occurrences') {
        interrupt = false;
        throw new FrameworkError('SIMULATED_POWER_LOSS', 'Interrupted after durable claim.');
      }
      return result;
    } };
  const first = createPluginSchedulerService({ store, clock: () => now, intervalMs: 60_000 });
  const client = first.forPlugin('recover', new AbortController().signal);
  let calls = 0;
  client.registerHandler('publish', () => { calls++; });
  client.schedule(once('claimed', initial + 60_000));
  first.start(); now += 60_000;
  await assert.rejects(first.tick(), { code: 'SIMULATED_POWER_LOSS' });
  await first.stop();
  const restarted = createPluginSchedulerService({ store: base, clock: () => now, intervalMs: 60_000, maxHistory: 1 });
  context.after(() => restarted.stop());
  const current = restarted.forPlugin('recover', new AbortController().signal);
  current.registerHandler('publish', () => { calls++; });
  restarted.start();
  assert.equal(current.history()[0].status, 'unknown');
  await restarted.tick();
  assert.equal(calls, 0);
  now += 8 * day;
  base.purgeExpired();
  current.schedule(once('capacity-waiting', now));
  await restarted.tick();
  assert.equal(current.history()[0].status, 'unknown');
  assert.equal(current.list().find(rule => rule.id === 'claimed')?.state, 'unknown');
  assert.equal(calls, 0);
});

test('rules and completed histories expire with bounded capacity while cancelled work never fires', async context => {
  const { service, setNow } = fixture(context, { maxRules: 1, maxHistory: 1 });
  const client = service.forPlugin('capacity', new AbortController().signal);
  client.registerHandler('publish', () => {});
  const first = client.schedule(once('first', initial + 60_000));
  assert.throws(() => client.schedule(once('other', initial + 60_000)), { code: 'PLUGIN_SCHEDULER_RULE_CAPACITY' });
  assert.throws(() => client.cancel('first', { expectedRevision: first.revision + 1 }), { code: 'PLUGIN_SCHEDULER_CONFLICT' });
  assert.equal(client.cancel('first', { expectedRevision: first.revision }), true);
  service.start(); setNow(initial + 60_000); await service.tick();
  assert.equal(client.history().length, 0);
  setNow(initial + 8 * day);
  await service.tick();
  assert.equal(client.list().length, 0);
  client.schedule(once('new', initial + 8 * day));
  await service.tick();
  assert.equal(client.history().length, 1);
  setNow(initial + 16 * day);
  await service.tick();
  assert.equal(client.history().length, 0);
  assert.equal(client.list().length, 0);
});

test('idle background collection runs once a minute while registration immediately reclaims expired capacity', async context => {
  let now = initial;
  const base = createSqliteStore({ filename: ':memory:', clock: () => now });
  let historyReads = 0;
  const store: DurableStore = { ...base, list(namespace, query) {
    if (namespace === 'plugin-scheduler.calendar-trigger-occurrences') historyReads++;
    return base.list(namespace, query);
  } };
  const service = createPluginSchedulerService({ store, clock: () => now, intervalMs: 60_000, maxRules: 1 });
  context.after(async () => { await service.stop(); base.close(); });
  const client = service.forPlugin('maintenance', new AbortController().signal);
  client.schedule(once('old', initial, { enabled: false, windowMs: 60_000 }));
  service.start();
  historyReads = 0;
  await service.tick();
  now += 1_000;
  await service.tick();
  now += 58_999;
  await service.tick();
  assert.equal(historyReads, 1);
  now += 1;
  await service.tick();
  assert.equal(historyReads, 2);

  // Collect just before expiry, then register inside the normal maintenance interval.
  now = initial + 7 * day + 59_999;
  await service.tick();
  now += 1;
  assert.equal(client.schedule(once('new', now + 60_000)).id, 'new');
  assert.equal(client.list().length, 1);
});
