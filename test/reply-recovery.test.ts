import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FrameworkError } from '../src/core/values.ts';
import { createReplyWatchdog } from '../src/host/replies.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

const binding = { conversationId: 'private:reply-recovery', sessionId: 'reply-session', generation: 1 };

function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'reply-recovery-'));
  const filename = join(directory, 'replies.sqlite');
  const store = createSqliteStore({ filename });
  const watchdogs: ReturnType<typeof createReplyWatchdog>[] = [];
  const faults: string[] = [];
  let now = 1_000;
  let notices = 0;
  const watchdog = (recovery: 'notify' | 'record-only' = 'record-only', failNotice = false) => {
    const value = createReplyWatchdog({ store, clock: () => now, timeoutMs: 50, recovery,
      onFault: code => faults.push(code), onTimeout() {
        notices++;
        if (failNotice) throw new FrameworkError('TEST_NOTICE_FAILED', 'Synthetic notice failed.');
      } });
    watchdogs.push(value);
    return value;
  };
  context.after(async () => {
    await Promise.all(watchdogs.map(value => value.stop()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { watchdog, store, faults, notices: () => notices, setNow(value: number) { now = value; },
    blockWrites() {
      const database = new DatabaseSync(filename);
      try {
        database.exec(`CREATE TRIGGER reject_reply_update BEFORE UPDATE ON durable_records
          WHEN OLD.namespace = 'host.replies' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`);
      } finally { database.close(); }
    } };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Reply recovery did not settle within its bound.');
}

test('record-only recovery synchronously expires an overdue waiter once without fault or notice', async context => {
  const fake = fixture(context);
  const first = fake.watchdog();
  first.watch(binding, 'original-request');
  const before = first.get(binding.conversationId)!;
  await first.stop();
  fake.setNow(before.deadlineAt);
  const recovered = fake.watchdog();
  recovered.restorePage();
  assert.deepEqual(recovered.get(binding.conversationId), { ...before, status: 'timed-out' });
  assert.equal(recovered.metrics().pending, 0);
  assert.equal(recovered.metrics().expired, 1);
  recovered.restorePage();
  assert.equal(recovered.metrics().expired, 1);
  assert.deepEqual(fake.faults, []);
  assert.equal(fake.notices(), 0);
  recovered.responded({ ...binding, generation: 2 });
  assert.equal(recovered.get(binding.conversationId)?.status, 'timed-out');
  recovered.responded(binding);
  assert.equal(recovered.get(binding.conversationId)?.status, 'responded-late');
});

test('record-only recovery before the deadline keeps the original deadline and suppresses only recovered effects', async context => {
  const fake = fixture(context);
  const first = fake.watchdog();
  first.watch(binding, 'original-request');
  await first.stop();
  fake.setNow(1_020);
  const recovered = fake.watchdog();
  recovered.restorePage();
  assert.equal(recovered.get(binding.conversationId)?.deadlineAt, 1_050);
  assert.equal(recovered.metrics().pending, 1);
  await until(() => recovered.get(binding.conversationId)?.status === 'timed-out');
  assert.equal(recovered.metrics().expired, 1);
  assert.deepEqual(fake.faults, []);
  assert.equal(fake.notices(), 0);
  recovered.watch({ ...binding, conversationId: 'private:fresh' }, 'fresh-request');
  await until(() => fake.notices() === 1);
  assert.deepEqual(fake.faults, ['AGENT_REPLY_TIMEOUT']);
});

test('record-only recovered timer cannot overwrite an already responded waiter', async context => {
  const fake = fixture(context);
  const first = fake.watchdog();
  first.watch(binding, 'original-request');
  await first.stop();
  const recovered = fake.watchdog();
  recovered.restorePage();
  recovered.responded(binding);
  await delay(70);
  assert.equal(recovered.get(binding.conversationId)?.status, 'responded');
  assert.equal(recovered.metrics().expired, 0);
  assert.deepEqual(fake.faults, []);
  assert.equal(fake.notices(), 0);
});

test('overdue record-only recovery does not swallow a real SQLite write failure', async context => {
  const fake = fixture(context);
  const first = fake.watchdog();
  first.watch(binding, 'original-request');
  await first.stop();
  fake.setNow(1_100);
  fake.blockWrites();
  const recovered = fake.watchdog();
  assert.throws(() => recovered.restorePage(), { code: 'STORE_IO_ERROR' });
  assert.equal(recovered.get(binding.conversationId)?.status, 'waiting');
  assert.equal(recovered.metrics().expired, 0);
  assert.equal(fake.notices(), 0);
});

test('a real SQLite write failure after restoring an unexpired timer still faults', async context => {
  const fake = fixture(context);
  const first = fake.watchdog();
  first.watch(binding, 'original-request');
  await first.stop();
  const recovered = fake.watchdog();
  recovered.restorePage();
  fake.blockWrites();
  await until(() => fake.faults.length > 0);
  assert.deepEqual(fake.faults, ['STORE_IO_ERROR']);
  assert.equal(recovered.get(binding.conversationId)?.status, 'waiting');
  assert.equal(recovered.metrics().expired, 0);
  assert.equal(fake.notices(), 0);
});

test('legacy notify recovery and real notice failures retain their diagnostics', async context => {
  const fake = fixture(context);
  const first = fake.watchdog();
  first.watch(binding, 'original-request');
  await first.stop();
  fake.setNow(1_100);
  const recovered = fake.watchdog('notify', true);
  recovered.restorePage();
  await until(() => fake.faults.includes('TEST_NOTICE_FAILED'));
  assert.equal(recovered.get(binding.conversationId)?.status, 'timed-out');
  assert.deepEqual(fake.faults, ['AGENT_REPLY_TIMEOUT', 'TEST_NOTICE_FAILED']);
  assert.equal(fake.notices(), 1);
});
