import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeInbox, type NativeInboxEntry } from '../src/host/native-inbox.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

const entry = (id: string, userId = '123', admittedAt = 10): NativeInboxEntry => ({ admittedAt, deadlineAt: admittedAt + 100,
  message: { id, userId, conversationId: 'group:456', receivedAt: admittedAt, directed: true, isSelf: false,
    content: [{ type: 'text', text: `correction-${id}` }] } });

test('busy group input becomes one latest observation without merging identities or extending deadlines', async () => {
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
    assert.deepEqual(delivered[0]?.map(item => item.message.id), ['1', '2', '3']);
    assert.deepEqual(delivered[0]?.map(item => item.message.userId), ['123', '123', '789']);
    assert.equal(delivered[0]?.[0]?.deadlineAt, 110);
    assert.equal(inbox.enqueue(entry('1')), 'duplicate');
    await inbox.tick(); assert.equal(delivered.length, 1);
    assert.deepEqual(inbox.list()[0]?.receipts.map(receipt => receipt.outcome), ['coalesced', 'coalesced', 'accepted']);
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
    inbox.enqueue(entry('17'));
    assert.equal(inbox.list()[0]?.entries.length, 16);
    assert.deepEqual(inbox.list()[0]?.receipts.map(item => item.outcome), ['coalesced']);
    clock = 110; await inbox.tick();
    assert.equal(inbox.list()[0]?.entries.length, 0);
    assert.equal(inbox.list()[0]?.receipts.filter(item => item.outcome === 'expired').length, 16);
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

test('short coalescing is bounded and excludes dispatched or expired inputs from superseding replies', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  let clock = 1000;
  const batches: string[][] = [];
  let release: (() => void) | undefined;
  const inbox = createNativeInbox({ store, clock: () => clock, coalesceMs: 120, readiness: () => 'ready',
    async deliver(entries) {
      batches.push(entries.map(item => item.message.id));
      assert.equal(inbox.hasWaitingFrom('group:456', '123', 'old'), false);
      await new Promise<void>(resolve => { release = resolve; });
      return { status: 'accepted' };
    } });
  const add = (id: string, userId = '123') => inbox.enqueue({ ...entry(id, userId, clock), deadlineAt: clock + 5000 });
  try {
    add('a'); clock = 1100; add('b'); await inbox.tick(); assert.equal(batches.length, 0);
    clock = 1190; add('c'); clock = 1280; add('d'); clock = 1390; add('e'); clock = 1490; add('f');
    await inbox.tick(); assert.equal(batches.length, 0);
    clock = 1500;
    const running = inbox.tick();
    assert.deepEqual(batches, [['a', 'b', 'c', 'd', 'e', 'f']]);
    add('other', '789'); assert.equal(inbox.hasWaitingFrom('group:456', '123', 'f'), false);
    assert.equal(inbox.hasWaitingAfter('group:456', 'f'), true);
    assert.equal(inbox.hasWaitingAfter('group:456', 'never-admitted'), false);
    add('correction'); assert.equal(inbox.hasWaitingFrom('group:456', '123', 'f'), true);
    clock = 6500; assert.equal(inbox.hasWaitingFrom('group:456', '123', 'f'), false);
    assert.equal(inbox.hasWaitingAfter('group:456', 'f'), false);
    release!(); await running;
  } finally { await inbox.stop(); store.close(); }
});

test('group flood retains the newest observation and a real explicit call within bounded wake storage', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const batches: (readonly NativeInboxEntry[])[] = [];
  const inbox = createNativeInbox({ store, clock: () => 20, readiness: () => 'ready',
    async deliver(entries) { batches.push(entries); return { status: 'accepted' }; } });
  try {
    inbox.enqueue({ ...entry('call'), trigger: 'mention' });
    for (let index = 0; index < 20; index++) inbox.enqueue({ ...entry(`ambient-${index}`, '789'), trigger: 'observation' });
    const queued = inbox.list()[0]!;
    assert.equal(queued.entries.length, 16);
    assert.equal(queued.entries[0]?.message.id, 'call');
    assert.equal(queued.entries.at(-1)?.message.id, 'ambient-19');
    assert.equal(queued.receipts.length, 5);
    assert(queued.receipts.every(receipt => receipt.outcome === 'coalesced'));
    assert.equal(inbox.enqueue({ ...entry('ambient-0', '789'), trigger: 'observation' }), 'duplicate');
    await inbox.tick();
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.at(-1)?.message.userId, '789');
    assert.equal(inbox.hasPending('group:456'), false);
  } finally { await inbox.stop(); store.close(); }
});

test('a full submitted group snapshot leaves room for fresh arrivals without replaying its coalesced wakes', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  let release: (() => void) | undefined;
  const batches: string[][] = [];
  const inbox = createNativeInbox({ store, clock: () => 20, readiness: () => 'ready',
    async deliver(entries) {
      batches.push(entries.map(item => item.message.id));
      if (batches.length === 1) await new Promise<void>(resolve => { release = resolve; });
      return { status: 'accepted' };
    } });
  try {
    for (let index = 0; index < 16; index++) inbox.enqueue(entry(`old-${index}`));
    const dispatch = inbox.tick();
    assert.deepEqual(inbox.list()[0]?.dispatchingIds, ['old-15']);
    assert.equal(inbox.list()[0]?.entries.length, 1);
    inbox.enqueue({ ...entry('fresh', '789'), trigger: 'observation' });
    assert.equal(inbox.hasWaitingAfter('group:456', 'old-15'), true);
    release!(); await dispatch;
    assert.deepEqual(inbox.list()[0]?.entries.map(item => item.message.id), ['fresh']);
    await inbox.tick();
    assert.deepEqual(batches.map(batch => batch.at(-1)), ['old-15', 'fresh']);
    assert.equal(batches[0]?.length, 16);
  } finally { await inbox.stop(); store.close(); }
});

test('private corrections retain sender boundaries and reject excess pending input', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const batches: string[][] = [];
  const inbox = createNativeInbox({ store, clock: () => 20, readiness: () => 'ready',
    async deliver(entries) { batches.push(entries.map(item => item.message.id)); return { status: 'accepted' }; } });
  const add = (id: string, userId = '123') => {
    const pending = entry(id, userId);
    inbox.enqueue({ ...pending, message: { ...pending.message, conversationId: 'private:456' }, trigger: 'private' });
  };
  try {
    add('a'); add('b'); add('c', '789');
    await inbox.tick(); await inbox.tick();
    assert.deepEqual(batches, [['a', 'b'], ['c']]);
    for (let index = 0; index < 16; index++) add(`full-${index}`);
    assert.throws(() => add('overflow'), { code: 'NATIVE_INBOX_BACKPRESSURE' });
  } finally { await inbox.stop(); store.close(); }
});

test('interrupted group dispatch recovers one uncertain source and never replays coalesced wakes', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const restoredStore = createSqliteStore({ filename: ':memory:' });
  let release: (() => void) | undefined;
  const inbox = createNativeInbox({ store, clock: () => 20, readiness: () => 'ready',
    async deliver() { await new Promise<void>(resolve => { release = resolve; }); return { status: 'accepted' }; } });
  const restoredBatches: string[][] = [];
  const restored = createNativeInbox({ store: restoredStore, clock: () => 20, readiness: () => 'ready',
    async deliver(entries) { restoredBatches.push(entries.map(item => item.message.id)); return { status: 'accepted' }; } });
  try {
    inbox.enqueue(entry('first')); inbox.enqueue(entry('last', '789'));
    const dispatch = inbox.tick();
    const evidence = store.list('native-chat.inbox')[0]!;
    restoredStore.write(evidence.namespace, evidence.key, evidence.value, { expectedRevision: null });
    release!(); await dispatch;
    restored.recover();
    assert.equal(restored.hasPending('group:456'), false);
    assert.deepEqual(restored.list()[0]?.receipts.map(receipt => [receipt.id, receipt.outcome]),
      [['first', 'coalesced'], ['last', 'unknown']]);
    restored.enqueue({ ...entry('fresh'), trigger: 'observation' });
    await restored.tick();
    assert.deepEqual(restoredBatches, [['fresh']]);
  } finally { await inbox.stop(); await restored.stop(); store.close(); restoredStore.close(); }
});

test('group wake compaction also keeps the serialized queue below its existing byte budget', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const inbox = createNativeInbox({ store, clock: () => 20, readiness: () => 'busy',
    async deliver() { assert.fail('Busy observations must not submit'); } });
  try {
    for (let index = 0; index < 8; index++) {
      const pending = entry(`large-${index}`);
      inbox.enqueue({ ...pending, trigger: 'observation', message: { ...pending.message,
        content: [{ type: 'text', text: '中'.repeat(6000) }, { type: 'text', text: '中'.repeat(6000) },
          { type: 'text', text: '中'.repeat(6000) }] } });
    }
    const evidence = store.list('native-chat.inbox')[0]!;
    assert(Buffer.byteLength(JSON.stringify(evidence.value)) <= 192 * 1024);
    assert.equal(inbox.list()[0]?.entries.at(-1)?.message.id, 'large-7');
    assert.equal(inbox.list()[0]?.entries.length, 3);
    assert.equal(inbox.list()[0]?.receipts.length, 5);
  } finally { await inbox.stop(); store.close(); }
});

test('queued history boundaries survive persistence and reject invalid original sequence values', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const delivered: (readonly NativeInboxEntry[])[] = [];
  const inbox = createNativeInbox({ store, clock: () => 20, readiness: () => 'ready',
    async deliver(entries) { delivered.push(entries); return { status: 'accepted' }; } });
  try {
    assert.throws(() => inbox.enqueue({ ...entry('invalid'), historySequence: 0 }), { code: 'NATIVE_INBOX_CORRUPT' });
    inbox.enqueue({ ...entry('source'), historySequence: 7 });
    assert.equal(inbox.list()[0]?.entries[0]?.historySequence, 7);
    await inbox.tick();
    assert.equal(delivered[0]?.[0]?.historySequence, 7);
  } finally { await inbox.stop(); store.close(); }
});

test('queued account identity survives persistence and recovery and cannot change on duplicate delivery', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const accountScope = { protocolId: 'onebot', accountId: '999' };
  const original = { ...entry('account-message'), message: { ...entry('account-message').message, accountScope } };
  const first = createNativeInbox({ store, clock: () => 20, readiness: () => 'busy',
    async deliver() { assert.fail('Busy input must stay queued'); } });
  first.enqueue(original);
  assert.equal(first.enqueue(original), 'duplicate');
  assert.throws(() => first.enqueue({ ...original, message: { ...original.message,
    accountScope: { protocolId: 'onebot', accountId: '1000' } } }), { code: 'NATIVE_INBOX_CONFLICT' });
  await first.stop();
  let delivered = false;
  const restored = createNativeInbox({ store, clock: () => 20, readiness: () => 'ready',
    async deliver(entries) { assert.deepEqual(entries[0]?.message.accountScope, accountScope); delivered = true; return { status: 'accepted' }; } });
  try { restored.recover(); await restored.tick(); assert.equal(delivered, true); }
  finally { await restored.stop(); store.close(); }
});

test('a corrupt queued account identity is rejected before dispatch', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const inbox = createNativeInbox({ store, clock: () => 20, readiness: () => 'busy',
    async deliver() { assert.fail('Corrupt identity must not dispatch'); } });
  try {
    inbox.enqueue(entry('corrupt-account'));
    const row = store.list('native-chat.inbox')[0]!;
    assert(row);
    const data = structuredClone(row.value) as { entries: { message: Record<string, unknown> }[] };
    data.entries[0]!.message.accountScope = { protocolId: 'onebot', accountId: '' };
    store.write(row.namespace, row.key, data);
    assert.throws(() => inbox.list(), { code: 'NATIVE_INBOX_CORRUPT' });
  } finally { await inbox.stop(); store.close(); }
});
