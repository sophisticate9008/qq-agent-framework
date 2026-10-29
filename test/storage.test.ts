import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonValue } from '../src/core/types.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

function temporaryDatabase(): { directory: string; filename: string } {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-store-'));
  return { directory, filename: join(directory, 'store.sqlite') };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

test('sqlite store persists frozen JSON records privately and pages keys in order', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  let now = 100;
  const first = createSqliteStore({ filename: temporary.filename, clock: () => now });
  const prototypeValue = JSON.parse('{"safe":true,"__proto__":{"polluted":true}}') as JsonValue;
  const firstRecord = first.write('sessions', 'beta', prototypeValue, { expectedRevision: null });
  now = 101;
  first.write('sessions', 'alpha', { order: 1 }, { expectedRevision: null });
  assert.equal(statSync(temporary.filename).mode & 0o777, 0o600);
  assert(Object.isFrozen(firstRecord));
  assert(Object.isFrozen(firstRecord.value));
  first.close();

  const reopened = createSqliteStore({ filename: temporary.filename, clock: () => now });
  const restored = reopened.read('sessions', 'beta');
  assert(restored);
  assert.equal(restored.revision, firstRecord.revision);
  assert(Object.hasOwn(restored.value as object, '__proto__'));
  assert.equal((Object.prototype as { polluted?: unknown }).polluted, undefined);
  assert.deepEqual(reopened.list('sessions', { limit: 1 }).map((record) => record.key), ['alpha']);
  assert.deepEqual(reopened.list('sessions', { limit: 10, after: 'alpha' }).map((record) => record.key), ['beta']);
  assert.throws(() => reopened.list('sessions', { limit: 1_001 }),
    (error: unknown) => hasCode(error, 'STORE_INVALID_ARGUMENT'));
  reopened.close();
  assert.throws(() => reopened.read('sessions', 'alpha'),
    (error: unknown) => hasCode(error, 'STORE_CLOSED'));
  reopened.close();
});

test('CAS rejects stale writers and global revisions prevent ABA across deletion and reopen', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const first = createSqliteStore({ filename: temporary.filename });
  const second = createSqliteStore({ filename: temporary.filename });
  context.after(() => first.close());
  context.after(() => second.close());

  const original = first.write('state', 'shared', { value: 'original' }, { expectedRevision: null });
  const stale = second.read('state', 'shared');
  assert(stale);
  const updated = first.write('state', 'shared', { value: 'updated' }, { expectedRevision: original.revision });
  assert.throws(() => second.write('state', 'shared', { value: 'stale' }, {
    expectedRevision: stale.revision
  }), (error: unknown) => hasCode(error, 'STORE_CONFLICT'));
  assert.deepEqual(first.read('state', 'shared')?.value, { value: 'updated' });
  assert.equal(first.delete('state', 'shared', updated.revision), true);
  const recreated = second.write('state', 'shared', { value: 'recreated' }, { expectedRevision: null });
  assert(recreated.revision > updated.revision);
  assert.throws(() => first.write('state', 'shared', { value: 'aba' }, {
    expectedRevision: updated.revision
  }), (error: unknown) => hasCode(error, 'STORE_CONFLICT'));
  assert.throws(() => first.write('state', 'shared', { value: 'duplicate' }, {
    expectedRevision: null
  }), (error: unknown) => hasCode(error, 'STORE_CONFLICT'));
  assert.throws(() => first.write('state', 'missing', { value: 'missing' }, {
    expectedRevision: recreated.revision
  }), (error: unknown) => hasCode(error, 'STORE_CONFLICT'));

  second.close();
  const reopened = createSqliteStore({ filename: temporary.filename });
  context.after(() => reopened.close());
  const afterRestart = reopened.write('state', 'other', true, { expectedRevision: null });
  assert(afterRestart.revision > recreated.revision);
});

test('invalid and oversized writes preserve old records while capacity remains bounded', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({
    filename: temporary.filename,
    maxRecords: 2,
    maxValueBytes: 48
  });
  context.after(() => store.close());
  const original = store.write('limits', 'first', { safe: 'value' }, { expectedRevision: null });
  const invalid = { secret: () => 'not-json' } as unknown as JsonValue;
  assert.throws(() => store.write('limits', 'first', invalid, {
    expectedRevision: original.revision
  }), (error: unknown) => hasCode(error, 'INVALID_DATA'));
  assert.throws(() => store.write('limits', 'first', { text: 'x'.repeat(100) }, {
    expectedRevision: original.revision
  }), (error: unknown) => hasCode(error, 'STORE_VALUE_TOO_LARGE'));
  assert.equal(store.read('limits', 'first')?.revision, original.revision);
  assert.deepEqual(store.read('limits', 'first')?.value, { safe: 'value' });
  store.write('limits', 'second', null, { expectedRevision: null });
  assert.throws(() => store.write('limits', 'third', null, { expectedRevision: null }),
    (error: unknown) => hasCode(error, 'STORE_CAPACITY_EXCEEDED'));
  const updated = store.write('limits', 'first', { safe: 'new' }, { expectedRevision: original.revision });
  assert(updated.revision > original.revision);
});

test('TTL visibility is non-destructive and explicit purge is bounded', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  let now = 10;
  const store = createSqliteStore({ filename: temporary.filename, clock: () => now, maxRecords: 2 });
  context.after(() => store.close());
  const first = store.write('ttl', 'first', 1, { expectedRevision: null, expiresAt: 20 });
  store.write('ttl', 'second', 2, { expectedRevision: null, expiresAt: 20 });
  now = 20;
  assert.equal(store.read('ttl', 'first'), null);
  assert.deepEqual(store.list('ttl'), []);
  assert.throws(() => store.write('ttl', 'third', 3, { expectedRevision: null }),
    (error: unknown) => hasCode(error, 'STORE_CAPACITY_EXCEEDED'));
  assert.equal(store.delete('ttl', 'first', first.revision + 1), false);
  assert.equal(store.purgeExpired(1), 1);
  assert.equal(store.purgeExpired(1), 1);
  assert.equal(store.purgeExpired(1), 0);
  const third = store.write('ttl', 'third', 3, { expectedRevision: null });
  assert(third.revision > first.revision);
});

test('namespace tokens track committed writes, deletes, batches, purge and other connections', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  let now = 10;
  const store = createSqliteStore({ filename: temporary.filename, clock: () => now });
  const other = createSqliteStore({ filename: temporary.filename, clock: () => now });
  context.after(() => store.close()); context.after(() => other.close());
  const token = () => store.changeToken!('inbox');
  const empty = token();
  store.write('unrelated', 'event', true);
  assert.equal(token(), empty);
  const record = store.write('inbox', 'first', { nested: [{ value: 1 }] });
  const written = token(); assert.notEqual(written, empty);
  assert.throws(() => store.write('inbox', 'first', {}, { expectedRevision: record.revision + 1 }), { code: 'STORE_CONFLICT' });
  assert.equal(token(), written);
  store.compareAndSetBatch!([{ kind: 'check', namespace: 'inbox', key: 'first', expectedRevision: record.revision }]);
  assert.equal(token(), written);
  store.compareAndSetBatch!([{ kind: 'write', namespace: 'inbox', key: 'second', expectedRevision: null, value: true }]);
  const batched = token(); assert.notEqual(batched, written);
  assert.equal(store.delete('inbox', 'first', record.revision + 1), false);
  assert.equal(token(), batched);
  assert.equal(store.delete('inbox', 'first', record.revision), true);
  const deleted = token(); assert.notEqual(deleted, batched);
  other.write('inbox', 'external', true);
  const external = token(); assert.notEqual(external, deleted);
  const externalRecord = other.read('inbox', 'external')!;
  other.delete('inbox', 'external', externalRecord.revision);
  assert.notEqual(token(), external);
  store.write('inbox', 'expiring', true, { expiresAt: 20 });
  const beforeExpiry = token(); now = 20;
  assert.equal(token(), beforeExpiry); // Tokens describe mutations, not TTL visibility.
  assert.equal(store.read('inbox', 'expiring'), null);
  assert.equal(store.purgeExpired(), 1);
  assert.notEqual(token(), beforeExpiry);
  store.close();
  assert.throws(token, { code: 'STORE_CLOSED' });
});

test('read and list preserve deeply frozen detached records after a later write', () => {
  const store = createSqliteStore({ filename: ':memory:' });
  try {
    store.write('inbox', 'queue', { entries: [{ message: { text: 'original' } }] });
    const read = store.read('inbox', 'queue')!;
    const listed = store.list('inbox');
    assert(Object.isFrozen(read)); assert(Object.isFrozen(listed)); assert(Object.isFrozen(listed[0]));
    const value = listed[0]!.value as { entries: { message: { text: string } }[] };
    assert(Object.isFrozen(value)); assert(Object.isFrozen(value.entries)); assert(Object.isFrozen(value.entries[0]!.message));
    assert.throws(() => { value.entries[0]!.message.text = 'changed'; }, TypeError);
    store.write('inbox', 'queue', { entries: [] });
    assert.deepEqual(read.value, { entries: [{ message: { text: 'original' } }] });
    assert.deepEqual(listed[0]!.value, read.value);
  } finally { store.close(); }
});

test('clock rollback invalidates namespace tokens using all existing storage clock samples', () => {
  let clock = 10;
  const store = createSqliteStore({ filename: ':memory:', clock: () => clock });
  try {
    store.write('inbox', 'expiring', true, { expiresAt: 28 });
    const beforeScan = store.changeToken!('inbox');
    const unrelatedBeforeScan = store.changeToken!('unrelated');
    clock = 30; assert.deepEqual(store.list('inbox'), []);
    // The new token time remains later than the previous token time, but is
    // earlier than the list's clock sample that hid this still-persisted row.
    clock = 25;
    const restored = store.changeToken!('inbox');
    assert.notEqual(restored, beforeScan);
    assert.notEqual(store.changeToken!('unrelated'), unrelatedBeforeScan);
    assert.equal(store.list('inbox').length, 1);
    assert.equal(store.changeToken!('inbox'), restored);
    clock = 24; assert(store.read('inbox', 'expiring'));
    assert.notEqual(store.changeToken!('inbox'), restored);
  } finally { store.close(); }
});

test('bounded token tracking invalidates evicted namespace observations safely', () => {
  const store = createSqliteStore({ filename: ':memory:' });
  try {
    const original = store.changeToken!('inbox');
    for (let index = 0; index < 1_024; index++) store.changeToken!(`temporary.${index}`);
    store.write('inbox', 'after-eviction', true);
    const restored = store.changeToken!('inbox');
    assert.notEqual(restored, original);
    store.write('inbox', 'after-registration', true);
    assert.notEqual(store.changeToken!('inbox'), restored);
  } finally { store.close(); }
});

test('token clock observation leaves CAS with one pretransaction expiry sample', () => {
  let clock = 10;
  let samples = 0;
  const store = createSqliteStore({ filename: ':memory:', clock: () => { samples++; return clock; } });
  try {
    const record = store.write('inbox', 'expiring', true, { expiresAt: 20 });
    store.changeToken!('inbox');
    clock = 19; samples = 0;
    assert(store.compareAndSetBatch!([{ kind: 'check', namespace: 'inbox', key: 'expiring', expectedRevision: record.revision }])[0]);
    assert.equal(samples, 1);
    clock = 20; samples = 0;
    assert.equal(store.compareAndSetBatch!([{ kind: 'check', namespace: 'inbox', key: 'expiring', expectedRevision: null }])[0], null);
    assert.equal(samples, 1);
  } finally { store.close(); }
});
