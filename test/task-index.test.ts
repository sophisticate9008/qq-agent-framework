import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameworkError } from '../src/core/values.ts';
import type { JsonObject, JsonValue } from '../src/core/types.ts';
import { object } from '../src/host/data.ts';
import { createTaskQueue, type TaskStatus } from '../src/host/tasks.ts';
import type { DurableStore, WriteOptions } from '../src/host/types.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

function memoryStore(context: TestContext) {
  const store = createSqliteStore({ filename: ':memory:' });
  context.after(() => store.close());
  return store;
}

function instrumentStore(base: DurableStore) {
  const reads: { namespace: string; key: string }[] = [];
  const lists: { namespace: string; count: number; limit?: number }[] = [];
  const writes: { namespace: string; key: string }[] = [];
  const hooks: {
    beforeWrite?: (namespace: string, key: string, value: JsonValue, options?: WriteOptions) => void;
    beforeDelete?: (namespace: string, key: string) => void;
  } = {};
  const store: DurableStore = {
    ...base,
    read(namespace, key) { reads.push({ namespace, key }); return base.read(namespace, key); },
    write(namespace, key, value, options) {
      writes.push({ namespace, key });
      hooks.beforeWrite?.(namespace, key, value, options);
      return base.write(namespace, key, value, options);
    },
    delete(namespace, key, expectedRevision) {
      hooks.beforeDelete?.(namespace, key);
      return base.delete(namespace, key, expectedRevision);
    },
    list(namespace, options) {
      const batch = base.list(namespace, options);
      lists.push({ namespace, count: batch.length, limit: options?.limit });
      return batch;
    }
  };
  return { store, reads, lists, writes, hooks, reset() { reads.length = 0; lists.length = 0; writes.length = 0; } };
}

function seedTask(store: DurableStore, id: string, status: TaskStatus, changes: JsonObject = {}) {
  return store.write('tasks', id, { id, kind: 'test.handler', scope: 'room:1', payload: {}, dueAt: 0,
    expiresAt: null, attempts: status === 'waiting' ? 0 : 1, maxAttempts: 2, status, ...changes });
}

function input(id: string, dueAt = 0) {
  return { id, kind: 'test.handler', scope: 'room:1', payload: {}, dueAt, maxAttempts: 2 };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('runDue lists only pending keys and reads no terminal history as task IDs advance', async context => {
  const base = memoryStore(context);
  for (let index = 0; index < 1500; index++) seedTask(base, `history-${String(index).padStart(4, '0')}`, 'completed');
  const measured = instrumentStore(base);
  const queue = createTaskQueue({ store: measured.store });
  context.after(() => queue.stop());
  assert(measured.lists.some(entry => entry.namespace === 'tasks'));
  const called: string[] = [];
  queue.register('test.handler', execution => { called.push(execution.id); });
  queue.schedule(input('task-0002'));
  queue.schedule(input('task-0001'));
  measured.reset();
  assert.deepEqual(await queue.runDue(), { scanned: 2, executed: 2 });
  assert.deepEqual(called, ['task-0001', 'task-0002']);
  assert(measured.lists.every(entry => entry.namespace === 'tasks.pending'));
  assert.equal(measured.lists.reduce((total, entry) => total + entry.count, 0), 2);
  assert.deepEqual(measured.reads.filter(entry => entry.namespace === 'tasks').map(entry => entry.key), ['task-0001', 'task-0002']);
  queue.schedule(input('task-0003'));
  measured.reset();
  assert.deepEqual(await queue.runDue(), { scanned: 1, executed: 1 });
  assert.deepEqual(measured.reads.filter(entry => entry.namespace === 'tasks').map(entry => entry.key), ['task-0003']);
  assert(measured.lists.every(entry => entry.namespace === 'tasks.pending'));
  measured.reset();
  const restarted = createTaskQueue({ store: measured.store });
  context.after(() => restarted.stop());
  assert.equal(measured.lists.length, 0);
  assert.deepEqual(await restarted.runDue(), { scanned: 0, executed: 0 });
  assert.equal(base.list('tasks.pending').length, 0);
});

test('pending orphans and every terminal status are removed without executing their payloads', async context => {
  const base = memoryStore(context);
  const queue = createTaskQueue({ store: base, clock: () => 10 });
  context.after(() => queue.stop());
  queue.register('test.handler', () => { assert.fail('Terminal tasks must not execute.'); });
  for (const status of ['completed', 'failed', 'unknown', 'expired', 'cancelled'] as const) {
    seedTask(base, status, status);
    base.write('tasks.pending', status, { id: status });
  }
  base.write('tasks.pending', 'missing', { id: 'missing' });
  seedTask(base, 'waiting-expired', 'waiting', { expiresAt: 5 });
  base.write('tasks.pending', 'waiting-expired', { id: 'waiting-expired' });
  assert.deepEqual(await queue.runDue(), { scanned: 7, executed: 0 });
  assert.equal(base.list('tasks.pending').length, 0);
  assert.equal(object(base.read('tasks', 'waiting-expired')!.value).status, 'expired');
});

test('legacy index migration persists across reopen and running recovery remains conservative', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'task-index-'));
  const filename = join(directory, 'tasks.sqlite');
  const opened: DurableStore[] = [];
  context.after(() => { for (const store of opened) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const open = () => { const store = createSqliteStore({ filename }); opened.push(store); return store; };
  const initial = open();
  seedTask(initial, 'waiting', 'waiting');
  seedTask(initial, 'running', 'running');
  seedTask(initial, 'terminal', 'completed');
  initial.write('tasks.pending', 'orphan', {});
  initial.write('tasks.pending', 'terminal', {});
  initial.close();
  const restored = open();
  const queue = createTaskQueue({ store: restored });
  assert.deepEqual(restored.list('tasks.pending').map(record => record.key), ['running', 'waiting']);
  assert.equal(object(restored.read('tasks', 'running')!.value).status, 'running');
  assert.equal(queue.recover(), 1);
  assert.equal(queue.recover(), 0);
  assert.equal(object(restored.read('tasks', 'running')!.value).status, 'unknown');
  assert.throws(() => queue.retry('running'), { code: 'TASK_RETRY_DENIED' });
  let calls = 0;
  queue.register('test.handler', () => { calls++; });
  assert.equal((await queue.runDue()).executed, 1);
  assert.equal(calls, 1);
  await queue.stop();
  restored.close();
  const measured = instrumentStore(open());
  const reopened = createTaskQueue({ store: measured.store });
  assert.equal(measured.lists.length, 0);
  assert.equal((await reopened.runDue()).executed, 0);
  assert.equal(measured.reads.filter(entry => entry.namespace === 'tasks').length, 0);
  await reopened.stop();
});

test('recoverPage merges bounded key cursors to repair missing waiting indexes and trailing orphans', async context => {
  const base = memoryStore(context);
  const measured = instrumentStore(base);
  const queue = createTaskQueue({ store: measured.store });
  context.after(() => queue.stop());
  seedTask(base, 'bbb', 'waiting');
  seedTask(base, 'ddd', 'running');
  seedTask(base, 'fff', 'failed');
  for (const key of ['aaa', 'ccc', 'fff', 'zzz']) base.write('tasks.pending', key, {});
  measured.reset();
  const cursors: string[] = [];
  let after: string | undefined;
  let recovered = 0;
  do {
    const page = queue.recoverPage(after === undefined ? { limit: 1 } : { limit: 1, after });
    recovered += page.recovered;
    after = page.next ?? undefined;
    if (after !== undefined) cursors.push(after);
  } while (after !== undefined);
  assert.deepEqual(cursors, ['aaa', 'bbb', 'ccc', 'ddd', 'fff', 'zzz']);
  assert.equal(recovered, 1);
  assert(measured.lists.every(entry => entry.limit === 1 && entry.count <= 1));
  assert.deepEqual(base.list('tasks.pending').map(record => record.key), ['bbb']);
  assert.equal(object(base.read('tasks', 'ddd')!.value).errorCode, 'TASK_INTERRUPTED');
  assert.throws(() => queue.recoverPage({ limit: 1001 }), { code: 'INVALID_TASK_LIMIT' });
});

test('schedule writes the index before its task and write failures cannot publish executable work', async context => {
  const base = memoryStore(context);
  const measured = instrumentStore(base);
  const queue = createTaskQueue({ store: measured.store });
  context.after(() => queue.stop());
  let calls = 0;
  queue.register('test.handler', () => { calls++; });
  measured.reset();
  measured.hooks.beforeWrite = namespace => {
    if (namespace === 'tasks.pending') throw new FrameworkError('STORE_FULL', 'Injected index failure.');
  };
  assert.throws(() => queue.schedule(input('index-failure')), { code: 'STORE_FULL' });
  assert.equal(base.read('tasks', 'index-failure'), null);
  measured.hooks.beforeWrite = namespace => {
    if (namespace === 'tasks') throw new FrameworkError('STORE_FULL', 'Injected body failure.');
  };
  assert.throws(() => queue.schedule(input('body-failure')), { code: 'STORE_FULL' });
  assert.equal(base.read('tasks', 'body-failure'), null);
  assert.equal(base.read('tasks.pending', 'body-failure'), null);
  measured.hooks.beforeWrite = undefined;
  assert.deepEqual(await queue.runDue(), { scanned: 0, executed: 0 });
  assert.equal(calls, 0);
  measured.reset();
  queue.schedule(input('success'));
  assert.deepEqual(measured.writes.map(entry => entry.namespace), ['tasks.pending', 'tasks']);
  assert.throws(() => queue.schedule(input('success')), { code: 'STORE_CONFLICT' });
  assert(base.read('tasks.pending', 'success'));
  assert.equal((await queue.runDue()).executed, 1);
  assert.equal(calls, 1);
  assert.equal(base.read('tasks.pending', 'success'), null);
});

test('a failed schedule with failed cleanup leaves only a harmless recoverable index orphan', async context => {
  const base = memoryStore(context);
  const measured = instrumentStore(base);
  const queue = createTaskQueue({ store: measured.store });
  context.after(() => queue.stop());
  queue.register('test.handler', () => { assert.fail('Failed schedules must not execute.'); });
  measured.hooks.beforeWrite = namespace => {
    if (namespace === 'tasks') throw new FrameworkError('STORE_FULL', 'Injected body failure.');
  };
  measured.hooks.beforeDelete = () => { throw new FrameworkError('STORE_UNAVAILABLE', 'Injected cleanup failure.'); };
  assert.throws(() => queue.schedule(input('orphan')), { code: 'STORE_UNAVAILABLE' });
  assert.equal(base.read('tasks', 'orphan'), null);
  assert(base.read('tasks.pending', 'orphan'));
  measured.hooks.beforeWrite = undefined;
  measured.hooks.beforeDelete = undefined;
  assert.deepEqual(await queue.runDue(), { scanned: 1, executed: 0 });
  assert.equal(base.read('tasks.pending', 'orphan'), null);
});

test('retry is index-first and fail-closed for index failures, body failures and CAS conflicts', async context => {
  const base = memoryStore(context);
  const measured = instrumentStore(base);
  const queue = createTaskQueue({ store: measured.store });
  context.after(() => queue.stop());
  let calls = 0;
  queue.register('test.handler', () => {
    calls++;
    if (calls === 1) throw new FrameworkError('EXPECTED_FAILURE', 'Injected handler failure.');
  });
  queue.schedule(input('retry'));
  await queue.runDue();
  assert.equal(base.read('tasks.pending', 'retry'), null);
  measured.hooks.beforeWrite = namespace => {
    if (namespace === 'tasks.pending') throw new FrameworkError('STORE_FULL', 'Injected index failure.');
  };
  assert.throws(() => queue.retry('retry'), { code: 'STORE_FULL' });
  assert.equal(object(base.read('tasks', 'retry')!.value).status, 'failed');
  measured.hooks.beforeWrite = namespace => {
    if (namespace === 'tasks') throw new FrameworkError('STORE_FULL', 'Injected body failure.');
  };
  assert.throws(() => queue.retry('retry'), { code: 'STORE_FULL' });
  assert.equal(base.read('tasks.pending', 'retry'), null);
  measured.hooks.beforeWrite = undefined;
  assert.equal((await queue.runDue()).executed, 0);
  measured.reset();
  queue.retry('retry');
  assert.deepEqual(measured.writes.map(entry => entry.namespace), ['tasks.pending', 'tasks']);
  assert.equal((await queue.runDue()).executed, 1);
  assert.equal(calls, 2);
  assert.equal(base.read('tasks.pending', 'retry'), null);
  seedTask(base, 'conflict', 'failed');
  measured.hooks.beforeWrite = (namespace, key) => {
    if (namespace === 'tasks' && key === 'conflict') {
      const current = base.read(namespace, key)!;
      base.write(namespace, key, { ...object(current.value), status: 'unknown' }, { expectedRevision: current.revision });
    }
  };
  assert.throws(() => queue.retry('conflict'), { code: 'STORE_CONFLICT' });
  assert.equal(base.read('tasks.pending', 'conflict'), null);
  assert.throws(() => queue.retry('conflict'), { code: 'TASK_RETRY_DENIED' });
});

test('an interrupted index migration has no version marker and resumes on construction', async context => {
  const base = memoryStore(context);
  seedTask(base, 'aaa', 'waiting');
  seedTask(base, 'bbb', 'waiting');
  const measured = instrumentStore(base);
  measured.hooks.beforeWrite = (namespace, key) => {
    if (namespace === 'tasks.pending' && key === 'bbb') throw new FrameworkError('STORE_FULL', 'Injected migration failure.');
  };
  assert.throws(() => createTaskQueue({ store: measured.store }), { code: 'STORE_FULL' });
  assert.equal(base.read('tasks.meta', 'pending-index'), null);
  assert(base.read('tasks.pending', 'aaa'));
  assert.equal(base.read('tasks.pending', 'bbb'), null);
  measured.hooks.beforeWrite = undefined;
  const queue = createTaskQueue({ store: measured.store });
  context.after(() => queue.stop());
  assert.deepEqual(base.list('tasks.pending').map(record => record.key), ['aaa', 'bbb']);
  assert(base.read('tasks.meta', 'pending-index'));
  let calls = 0;
  queue.register('test.handler', () => { calls++; });
  assert.equal((await queue.runDue()).executed, 2);
  assert.equal(calls, 2);
});

test('terminal index deletion failure never replays a completed handler', async context => {
  const base = memoryStore(context);
  const measured = instrumentStore(base);
  const queue = createTaskQueue({ store: measured.store });
  context.after(() => queue.stop());
  let calls = 0;
  queue.register('test.handler', () => { calls++; });
  queue.schedule(input('completed'));
  measured.hooks.beforeDelete = () => { throw new FrameworkError('STORE_UNAVAILABLE', 'Injected cleanup failure.'); };
  await assert.rejects(queue.runDue(), { code: 'STORE_UNAVAILABLE' });
  assert.equal(object(base.read('tasks', 'completed')!.value).status, 'completed');
  assert(base.read('tasks.pending', 'completed'));
  measured.hooks.beforeDelete = undefined;
  queue.recoverPage();
  assert.equal(base.read('tasks.pending', 'completed'), null);
  assert.equal((await queue.runDue()).executed, 0);
  assert.equal(calls, 1);
});

test('pending key cursors preserve fairness past future tasks and monotonically scheduled IDs', async context => {
  const base = memoryStore(context);
  const queue = createTaskQueue({ store: base, maxScan: 1, clock: () => 10 });
  context.after(() => queue.stop());
  const called: string[] = [];
  queue.register('test.handler', execution => { called.push(execution.id); });
  queue.schedule(input('task-0001', 100));
  queue.schedule(input('task-0002'));
  assert.deepEqual(await queue.runDue(), { scanned: 1, executed: 0 });
  assert.deepEqual(await queue.runDue(), { scanned: 1, executed: 1 });
  queue.schedule(input('task-0003'));
  assert.deepEqual(await queue.runDue(), { scanned: 1, executed: 1 });
  assert.deepEqual(called, ['task-0002', 'task-0003']);
  assert.deepEqual(await queue.runDue(), { scanned: 0, executed: 0 });
  assert.deepEqual(await queue.runDue(), { scanned: 1, executed: 0 });
  assert.equal(queue.cancel('task-0001'), true);
  assert.equal(base.list('tasks.pending').length, 0);
});

test('pending scanning still yields and recovery does not interrupt a locally active task', async context => {
  const base = memoryStore(context);
  const queue = createTaskQueue({ store: base, clock: () => 10 });
  context.after(() => queue.stop());
  for (let index = 0; index < 130; index++) queue.schedule(input(`future-${String(index).padStart(3, '0')}`, 100));
  const entered = deferred();
  const release = deferred();
  let yielded = false;
  const immediate = setImmediate(() => { yielded = true; });
  context.after(() => { clearImmediate(immediate); release.resolve(); });
  queue.register('test.handler', async () => { assert.equal(yielded, true); entered.resolve(); await release.promise; });
  queue.schedule(input('zzz-active'));
  const running = queue.runDue();
  await entered.promise;
  assert.equal(queue.recover(), 0);
  assert.equal(object(base.read('tasks', 'zzz-active')!.value).status, 'running');
  assert(base.read('tasks.pending', 'zzz-active'));
  release.resolve();
  assert.deepEqual(await running, { scanned: 131, executed: 1 });
  assert.equal(base.read('tasks.pending', 'zzz-active'), null);
});
