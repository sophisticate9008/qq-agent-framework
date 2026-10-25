import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextStore } from '../src/core/context.ts';
import { createEngine } from '../src/core/engine.ts';
import { assertRequiredEventOutcomes } from '../src/core/event-reports.ts';
import { createPolicy } from '../src/core/policy.ts';
import type { EventReport } from '../src/core/types.ts';
import { FrameworkError } from '../src/core/values.ts';
import { createCalendarTriggerService } from '../src/host/triggers.ts';
import { createTaskQueue } from '../src/host/tasks.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

test('required event outcomes distinguish absent consumers, known failure and uncertainty without failing unrelated subscribers', () => {
  const report: EventReport = { eventId: 'event', conversationId: 'room:1', outcomes: [
    { featureId: 'notice', status: 'completed' }, { featureId: 'observer', status: 'failed', errorCode: 'POLICY_DENIED' }
  ] };
  assert.doesNotThrow(() => assertRequiredEventOutcomes(report, ['notice']));
  assert.throws(() => assertRequiredEventOutcomes(report, ['missing']), { code: 'EVENT_REQUIRED_CONSUMER_MISSING' });
  assert.throws(() => assertRequiredEventOutcomes(report, ['observer']), { code: 'POLICY_DENIED' });
  assert.throws(() => assertRequiredEventOutcomes(report, []), { code: 'INVALID_REQUIRED_CONSUMERS' });
  assert.throws(() => assertRequiredEventOutcomes(report, ['notice', 'notice']), { code: 'INVALID_REQUIRED_CONSUMERS' });
  for (const errorCode of ['DELIVERY_UNKNOWN', 'EVENT_TIMEOUT', 'EVENT_ABORTED', undefined]) {
    assert.throws(() => assertRequiredEventOutcomes({ ...report, outcomes: [{ featureId: 'notice', status: 'failed', errorCode }] }, ['notice']),
      { code: 'EVENT_REQUIRED_OUTCOME_UNKNOWN' });
  }
  assert.throws(() => assertRequiredEventOutcomes({ ...report, outcomes: [report.outcomes[0], report.outcomes[0]] }, ['notice']),
    { code: 'EVENT_REPORT_UNKNOWN' });
  assert.throws(() => assertRequiredEventOutcomes({ ...report, outcomes: [{ featureId: 'notice', status: 'completed', errorCode: 'DELIVERY_UNKNOWN' }] }, ['notice']),
    { code: 'EVENT_REPORT_UNKNOWN' });
});

test('calendar callbacks cannot turn failed or uncertain required deliveries into completed occurrences', async context => {
  let now = Date.parse('2026-01-01T09:00:00Z');
  const store = createSqliteStore({ filename: ':memory:', clock: () => now });
  context.after(() => store.close());
  const contexts = createContextStore();
  const persona = contexts.registerPersona({ id: 'notice', version: '1', name: 'Notice', identity: {}, style: {} });
  const policy = createPolicy({ clock: () => now });
  let sends = 0;
  const engine = createEngine({ context: contexts, persona, policy, transport: { send() {
    sends++; return { status: 'unknown' };
  } } });
  engine.install({ id: 'notice', version: '1.0.0', apiVersion: 1, capabilities: ['messaging.send'], subscriptions: ['trigger.fired'],
    setup(services) { services.on('trigger.fired', async execution => {
      const receipt = await execution.send([{ type: 'text', text: 'Synthetic notice' }]);
      if (receipt.status !== 'confirmed') throw new FrameworkError(receipt.status === 'unknown' ? 'DELIVERY_UNKNOWN' : 'DELIVERY_REJECTED', 'Delivery did not confirm.');
    }); } });
  const calendar = createCalendarTriggerService({ store, clock: () => now, async callback(occurrence) {
    const report = await engine.emit({ id: occurrence.id, type: 'trigger.fired', conversationId: occurrence.scope, data: {} }, { signal: occurrence.signal });
    assertRequiredEventOutcomes(report, ['notice']);
  } });
  context.after(async () => { await calendar.stop(); await engine.stop(); });
  calendar.register({ id: 'notice', scope: 'room:1', timeZone: 'UTC', schedule: { kind: 'daily', hour: 10, minute: 0 },
    dst: { overlap: 'earlier', nonexistent: 'skip' }, misfire: 'skip', windowMs: 3_600_000, payload: {} });
  now = Date.parse('2026-01-01T10:05:00Z');
  const denied = await calendar.tick();
  assert.equal(denied.completed, 0);
  assert.equal(denied.failed, 1);
  assert.equal(sends, 0);
  policy.grant({ id: 'explicit-notice', featureId: 'notice', conversationId: 'room:1', capabilities: ['messaging.send'], maxUses: { 'messaging.send': 2 } });
  now = Date.parse('2026-01-02T10:05:00Z');
  const uncertain = await calendar.tick();
  assert.equal(uncertain.completed, 0);
  assert.equal(uncertain.unknown, 1);
  assert.equal(sends, 1);
  assert.equal((await calendar.tick()).attempted, 0);
  assert.equal(sends, 1);
});

test('task completion respects uncertain required consumer outcomes and does not become retryable success', async context => {
  const store = createSqliteStore({ filename: ':memory:' });
  context.after(() => store.close());
  const tasks = createTaskQueue({ store });
  context.after(() => tasks.stop());
  tasks.register('report', async () => assertRequiredEventOutcomes({ eventId: 'work-completed', conversationId: 'room:1',
    outcomes: [{ featureId: 'notice', status: 'failed', errorCode: 'DELIVERY_UNKNOWN' }] }, ['notice']));
  tasks.schedule({ id: 'work', kind: 'report', scope: 'room:1', payload: {}, dueAt: Date.now(), maxAttempts: 2 });
  await tasks.runDue();
  assert.equal(tasks.list()[0].status, 'unknown');
  assert.throws(() => tasks.retry('work'), { code: 'TASK_RETRY_DENIED' });
});
