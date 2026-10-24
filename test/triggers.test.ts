import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { JsonValue } from '../src/core/types.ts';
import { FrameworkError } from '../src/core/values.ts';
import { createCalendarTriggerService, type CalendarTriggerInput,
  type CalendarTriggerOccurrence } from '../src/host/triggers.ts';
import type { DurableStore, WriteOptions } from '../src/host/types.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

function utc(value: string) {
  return Date.parse(value);
}

function storeFor(context: TestContext, clock: () => number) {
  const store = createSqliteStore({ filename: ':memory:', clock });
  context.after(() => store.close());
  return store;
}

function daily(id: string, changes: Partial<CalendarTriggerInput> = {}): CalendarTriggerInput {
  return {
    id,
    scope: 'room:1',
    timeZone: 'UTC',
    schedule: { kind: 'daily', hour: 10, minute: 0 },
    dst: { overlap: 'earlier', nonexistent: 'skip' },
    misfire: 'skip',
    windowMs: 60 * 60_000,
    payload: { kind: 'fixture', nested: { safe: true } },
    ...changes
  };
}

test('daily occurrences persist before callbacks and survive restart, rollback, and retention cleanup', async context => {
  let now = utc('2026-01-01T09:00:00Z');
  const store = storeFor(context, () => now);
  const calls: CalendarTriggerOccurrence[] = [];
  const first = createCalendarTriggerService({ store, clock: () => now, retentionMs: 60_000,
    callback(occurrence) { calls.push(occurrence); } });
  first.register(daily('daily-fixture'));
  now = utc('2026-01-01T10:05:00Z');
  assert.deepEqual(await first.tick(), {
    scanned: 1, attempted: 1, completed: 1, failed: 0, unknown: 0, skipped: 0, backpressured: 0
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scheduledAt, utc('2026-01-01T10:00:00Z'));
  assert.equal(calls[0].deadlineAt, utc('2026-01-01T10:05:30Z'));
  assert.equal(calls[0].signal.aborted, false);
  assert.deepEqual(calls[0].payload, { kind: 'fixture', nested: { safe: true } });
  assert.equal(first.listOccurrences()[0].id, calls[0].id);
  await first.stop();

  const restartedCalls: string[] = [];
  const restarted = createCalendarTriggerService({ store, clock: () => now, retentionMs: 60_000,
    callback(occurrence) { restartedCalls.push(occurrence.id); } });
  assert.equal(restarted.recoverInterrupted().recovered, 0);
  assert.equal((await restarted.tick()).attempted, 0);
  now = utc('2026-01-01T09:30:00Z');
  assert.equal((await restarted.tick()).attempted, 0);
  now = utc('2026-01-01T10:07:00Z');
  store.purgeExpired();
  assert.equal(restarted.listOccurrences().length, 0);
  assert.equal((await restarted.tick()).attempted, 0);
  assert.deepEqual(restartedCalls, []);
  await restarted.stop();
});

test('trusted host operations update generations and disable or cancel future occurrences', async context => {
  let now = utc('2026-01-04T09:00:00Z');
  const store = storeFor(context, () => now);
  const calls: CalendarTriggerOccurrence[] = [];
  const service = createCalendarTriggerService({ store, clock: () => now,
    callback(occurrence) { calls.push(occurrence); } });
  service.register(daily('managed', { enabled: false }));
  assert.equal(service.setEnabled('managed', true), true);
  assert.equal(service.update('managed', {
    schedule: { kind: 'weekly', dayOfWeek: 1, hour: 11, minute: 0 },
    payload: { revision: 2 }
  }), 3);
  now = utc('2026-01-05T11:05:00Z');
  assert.equal((await service.tick()).completed, 1);
  assert.equal(calls[0].generation, 3);
  assert.deepEqual(calls[0].payload, { revision: 2 });
  assert.equal(service.cancel('managed'), true);
  assert.equal(service.cancel('managed'), false);
  now = utc('2026-01-12T11:05:00Z');
  assert.equal((await service.tick()).attempted, 0);
  assert.equal(service.list()[0].cancelled, true);
  assert.throws(() => service.setEnabled('managed', true), { code: 'CALENDAR_TRIGGER_CANCELLED' });
  await service.stop();
});

test('skip discards older eligible occurrences while coalesce reports them on the latest stable occurrence', async context => {
  let now = utc('2026-01-01T00:00:00Z');
  const store = storeFor(context, () => now);
  const calls: CalendarTriggerOccurrence[] = [];
  const service = createCalendarTriggerService({ store, clock: () => now,
    callback(occurrence) { calls.push(occurrence); } });
  service.register(daily('skip-backlog', { windowMs: 8 * 86_400_000, misfire: 'skip' }));
  service.register(daily('coalesce-backlog', { windowMs: 8 * 86_400_000, misfire: 'coalesce' }));
  now = utc('2026-01-03T10:30:00Z');
  const report = await service.tick();
  assert.equal(report.completed, 2);
  assert.equal(report.skipped, 4);
  assert.equal(calls.length, 2);
  const skipped = calls.find(call => call.ruleId === 'skip-backlog')!;
  const coalesced = calls.find(call => call.ruleId === 'coalesce-backlog')!;
  assert.equal(skipped.scheduledAt, utc('2026-01-03T10:00:00Z'));
  assert.equal(skipped.coalescedCount, 0);
  assert.equal(coalesced.scheduledAt, utc('2026-01-03T10:00:00Z'));
  assert.equal(coalesced.coalescedCount, 2);
  assert.equal((await service.tick()).attempted, 0);
  await service.stop();
});

test('DST gaps are skipped and overlaps select exactly the configured instant', async context => {
  let now = utc('2024-03-09T08:00:00Z');
  const store = storeFor(context, () => now);
  const calls: CalendarTriggerOccurrence[] = [];
  const service = createCalendarTriggerService({ store, clock: () => now,
    callback(occurrence) { calls.push(occurrence); } });
  service.register(daily('spring-gap', {
    timeZone: 'America/New_York',
    schedule: { kind: 'daily', hour: 2, minute: 30 },
    windowMs: 6 * 60 * 60_000
  }));
  now = utc('2024-03-10T08:00:00Z');
  assert.equal((await service.tick()).attempted, 0);
  now = utc('2024-03-11T06:30:00Z');
  assert.equal((await service.tick()).completed, 1);
  assert.equal(calls[0].scheduledAt, utc('2024-03-11T06:30:00Z'));
  await service.stop();

  now = utc('2024-11-02T08:00:00Z');
  const overlapCalls: CalendarTriggerOccurrence[] = [];
  const overlap = createCalendarTriggerService({ store, clock: () => now,
    callback(occurrence) { overlapCalls.push(occurrence); } });
  overlap.register(daily('fall-earlier', {
    timeZone: 'America/New_York', schedule: { kind: 'daily', hour: 1, minute: 30 },
    dst: { overlap: 'earlier', nonexistent: 'skip' }
  }));
  overlap.register(daily('fall-later', {
    timeZone: 'America/New_York', schedule: { kind: 'daily', hour: 1, minute: 30 },
    dst: { overlap: 'later', nonexistent: 'skip' }
  }));
  now = utc('2024-11-03T05:30:00Z');
  assert.equal((await overlap.tick()).completed, 1);
  now = utc('2024-11-03T06:30:00Z');
  assert.equal((await overlap.tick()).completed, 1);
  assert.equal(overlapCalls.find(call => call.ruleId === 'fall-earlier')!.scheduledAt, utc('2024-11-03T05:30:00Z'));
  assert.equal(overlapCalls.find(call => call.ruleId === 'fall-later')!.scheduledAt, utc('2024-11-03T06:30:00Z'));
  assert.equal(overlap.listOccurrences().length, 2);
  await overlap.stop();
});

test('time zones and explicit DST policy are validated without accepting cron expressions', context => {
  let now = utc('2026-01-01T00:00:00Z');
  const store = storeFor(context, () => now);
  const service = createCalendarTriggerService({ store, clock: () => now, callback() {} });
  assert.throws(() => service.register(daily('bad-zone', { timeZone: 'Mars/Olympus_Mons' })),
    { code: 'INVALID_CALENDAR_TRIGGER' });
  assert.throws(() => service.register({ ...daily('bad-dst'), dst: undefined as never }),
    { code: 'INVALID_DATA' });
  assert.throws(() => service.register({ ...daily('cron'), schedule: { kind: 'cron', expression: '* * * * *' } as never }),
    { code: 'INVALID_CALENDAR_TRIGGER' });
  assert.throws(() => service.register(daily('non-json', { payload: { invalid: undefined } as never })),
    { code: 'INVALID_DATA' });
});

test('callback deadlines abort unknown work and unresolved callbacks apply lasting backpressure', async context => {
  let now = utc('2026-01-01T09:00:00Z');
  const store = storeFor(context, () => now);
  let calls = 0;
  let signal: AbortSignal | undefined;
  const service = createCalendarTriggerService({ store, clock: () => now, callbackTimeoutMs: 20, maxPendingCallbacks: 1,
    callback(occurrence) {
      calls++;
      signal = occurrence.signal;
      return new Promise(() => {});
    } });
  service.register(daily('aaa-stuck'));
  service.register(daily('bbb-blocked'));
  now = utc('2026-01-01T10:00:00Z');
  const report = await service.tick();
  assert.equal(report.attempted, 1);
  assert.equal(report.unknown, 1);
  assert.equal(report.backpressured, 1);
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(service.metrics(), { pendingCallbacks: 1, activeCallbacks: 0, stopped: false });
  assert.equal(service.listOccurrences()[0].status, 'unknown');
  assert.equal((await service.tick()).backpressured, 1);
  await service.stop();
});

test('interrupted persisted intents recover to unknown and never replay', async context => {
  let now = utc('2026-01-01T09:00:00Z');
  const base = storeFor(context, () => now);
  let interrupt = true;
  const store: DurableStore = {
    ...base,
    write(namespace: string, key: string, value: JsonValue, options?: WriteOptions) {
      const written = base.write(namespace, key, value, options);
      if (interrupt && namespace === 'calendar-trigger-occurrences') {
        interrupt = false;
        throw new FrameworkError('FIXTURE_INTERRUPTED', 'Simulated process interruption.');
      }
      return written;
    }
  };
  let calls = 0;
  const first = createCalendarTriggerService({ store, clock: () => now, callback() { calls++; } });
  first.register(daily('interrupted'));
  now = utc('2026-01-01T10:00:00Z');
  await assert.rejects(first.tick(), { code: 'FIXTURE_INTERRUPTED' });
  assert.equal(calls, 0);
  await first.stop();

  const restarted = createCalendarTriggerService({ store: base, clock: () => now, callback() { calls++; } });
  assert.deepEqual(restarted.recoverInterrupted(), { recovered: 1, next: null });
  assert.equal(restarted.listOccurrences()[0].status, 'unknown');
  assert.equal((await restarted.tick()).attempted, 0);
  assert.equal(calls, 0);
  await restarted.stop();
});
