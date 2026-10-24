import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createTaskQueue } from '../src/host/tasks.ts';

test('a never-ending task expires as unknown and cannot monopolize the scheduler', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-deadline-'));
  const store = createSqliteStore({ filename: join(directory, 'state.sqlite') });
  const queue = createTaskQueue({ store, handlerTimeoutMs: 30 });
  let stuckCalls = 0;
  let healthyCalls = 0;
  let signal: AbortSignal | undefined;
  try {
    queue.register('fixture.stuck', execution => {
      stuckCalls++;
      signal = execution.signal;
      return new Promise(() => {});
    });
    queue.register('fixture.healthy', () => { healthyCalls++; });
    queue.schedule({ id: 'aaa', kind: 'fixture.stuck', scope: 'room:1', dueAt: 0, payload: {}, maxAttempts: 2 });
    queue.schedule({ id: 'bbb', kind: 'fixture.healthy', scope: 'room:2', dueAt: 0, payload: {} });
    const started = performance.now();
    assert.equal((await queue.runDue()).executed, 2);
    assert(performance.now() - started < 1500);
    assert.equal(signal?.aborted, true);
    assert.equal(healthyCalls, 1);
    assert.equal(queue.list()[0].status, 'unknown');
    assert.equal(queue.list()[0].errorCode, 'TASK_TIMEOUT_UNKNOWN');
    assert.throws(() => queue.retry('aaa'), { code: 'TASK_RETRY_DENIED' });
    await queue.runDue();
    assert.equal(stuckCalls, 1);
  } finally { await queue.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('task expiry includes queue age and shortens the active handler budget', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-expiry-'));
  const store = createSqliteStore({ filename: join(directory, 'state.sqlite') });
  const queue = createTaskQueue({ store, handlerTimeoutMs: 1000 });
  let calls = 0;
  try {
    queue.register('fixture.stuck', () => { calls++; return new Promise(() => {}); });
    queue.schedule({ id: 'already-expired', kind: 'fixture.stuck', scope: 'room:1', dueAt: 0, expiresAt: 1, payload: {} });
    assert.equal(queue.list()[0].status, 'expired');
    const now = Date.now();
    queue.schedule({ id: 'short-budget', kind: 'fixture.stuck', scope: 'room:1', dueAt: now - 1, expiresAt: now + 100, payload: {} });
    const started = performance.now();
    await queue.runDue();
    assert(performance.now() - started < 750);
    assert(calls <= 1);
    assert(['unknown', 'expired'].includes(queue.list()[1].status));
  } finally { await queue.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
