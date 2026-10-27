import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeInbox, type NativeInboxEntry } from '../src/host/native-inbox.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

const entry = (id: string, userId = '123', admittedAt = 10): NativeInboxEntry => ({ admittedAt, deadlineAt: admittedAt + 100,
  message: { id, userId, conversationId: 'group:456', receivedAt: admittedAt, directed: true, isSelf: false,
    content: [{ type: 'text', text: `correction-${id}` }] } });

test('busy input persists and merges same-person corrections without merging identities or extending deadlines', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  let ready: 'busy' | 'ready' = 'busy';
  const delivered: (readonly NativeInboxEntry[])[] = [];
  const inbox = createNativeInbox({ store, clock: () => 20, readiness: () => ready,
    async deliver(entries) { delivered.push(entries); return { status: 'accepted' }; } });
  try {
    inbox.enqueue(entry('1')); inbox.enqueue(entry('2', '123', 12)); inbox.enqueue(entry('3', '789', 14));
    await inbox.tick(); assert.equal(delivered.length, 0);
    assert.equal(inbox.list()[0]?.entries.length, 3);
    ready = 'ready'; await inbox.tick();
    assert.deepEqual(delivered[0]?.map(item => item.message.id), ['1', '2']);
    assert.equal(delivered[0]?.[0]?.deadlineAt, 110);
    assert.equal(inbox.enqueue(entry('1')), 'duplicate');
    await inbox.tick(); assert.deepEqual(delivered[1]?.map(item => item.message.userId), ['789']);
    assert.equal(inbox.hasPending('group:456'), false);
  } finally { await inbox.stop(); store.close(); }
});

test('unconfirmed execution pauses pending input without permanently blocking subsequent messages', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  let calls = 0;
  const inbox = createNativeInbox({ store, clock: () => 20, readiness: () => 'blocked',
    async deliver() { calls++; return { status: 'accepted' }; } });
  inbox.enqueue(entry('1')); await inbox.tick();
  assert.equal(inbox.list()[0]?.phase, 'pending');
  inbox.enqueue(entry('2'));
  await inbox.tick(); assert.equal(calls, 0);
  await inbox.stop();
  const recovered = createNativeInbox({ store, clock: () => 20, readiness: () => 'ready',
    async deliver() { calls++; return { status: 'accepted' }; } });
  try {
    recovered.recover(); await recovered.tick(); assert.equal(calls, 1);
    assert.equal(recovered.list()[0]?.errorCode, null);
    assert.deepEqual(recovered.list()[0]?.receipts.map(receipt => receipt.id), ['1', '2']);
  } finally { await recovered.stop(); store.close(); }
});

test('expiry consumes no model call, capacity is bounded and changed duplicate content fails', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  let clock = 20;
  const inbox = createNativeInbox({ store, clock: () => clock, readiness: () => 'busy',
    async deliver() { assert.fail('Expired input must not submit'); } });
  try {
    inbox.enqueue(entry('0'));
    assert.throws(() => inbox.enqueue({ ...entry('0'), message: { ...entry('0').message,
      content: [{ type: 'text', text: 'changed' }] } }), { code: 'NATIVE_INBOX_CONFLICT' });
    for (let i = 1; i < 16; i++) inbox.enqueue(entry(String(i)));
    assert.throws(() => inbox.enqueue(entry('17')), { code: 'NATIVE_INBOX_BACKPRESSURE' });
    clock = 110; await inbox.tick();
    assert.equal(inbox.list()[0]?.entries.length, 0);
    assert(inbox.list()[0]?.receipts.every(item => item.outcome === 'expired'));
  } finally { await inbox.stop(); store.close(); }
});

test('concurrent arrival during dispatch survives while repeated ticks do not duplicate submission', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  let resolve: (() => void) | undefined;
  const pending = new Promise<void>(done => { resolve = done; });
  let calls = 0;
  const inbox = createNativeInbox({ store, clock: () => 20, readiness: () => 'ready',
    async deliver() { calls++; await pending; return { status: 'accepted' }; } });
  try {
    inbox.enqueue(entry('1')); const tick = inbox.tick();
    inbox.enqueue(entry('2')); const other = inbox.tick();
    resolve!(); await Promise.all([tick, other]);
    assert.equal(calls, 1);
    assert.deepEqual(inbox.list()[0]?.entries.map(item => item.message.id), ['2']);
    await inbox.tick(); assert.equal(calls, 2);
  } finally { await inbox.stop(); store.close(); }
});
