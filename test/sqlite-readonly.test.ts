import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { readNativeHistory } from '../src/host/native-history.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { openReadonlySqliteStore } from '../src/storage/sqlite-readonly.ts';

function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'framework-readonly-'));
  const filename = join(directory, 'native-chat.sqlite');
  const writer = createSqliteStore({ filename });
  const readers: ReturnType<typeof openReadonlySqliteStore>[] = [];
  context.after(() => {
    for (const reader of readers) reader.close();
    writer.close();
    rmSync(directory, { force: true, recursive: true });
  });
  return { directory, filename, writer, reader() {
    const reader = openReadonlySqliteStore(filename);
    readers.push(reader);
    return reader;
  } };
}

test('readonly SQLite preserves a WAL snapshot across a concurrent committed writer and never exposes writes', context => {
  const fake = fixture(context);
  fake.writer.write('probe', 'key', { count: 1 });
  const reader = fake.reader();
  reader.withSnapshot(() => {
    assert.deepEqual(reader.read('probe', 'key')?.value, { count: 1 });
    fake.writer.write('probe', 'key', { count: 2 });
    assert.deepEqual(reader.read('probe', 'key')?.value, { count: 1 });
    assert.throws(() => reader.write('probe', 'key', null), { code: 'STORE_READONLY' });
    assert.throws(() => reader.delete('probe', 'key'), { code: 'STORE_READONLY' });
    assert.throws(() => reader.purgeExpired(), { code: 'STORE_READONLY' });
  });
  assert.deepEqual(reader.withSnapshot(() => reader.read('probe', 'key')?.value), { count: 2 });
  reader.close();
  reader.close();
  assert.throws(() => reader.list('probe'), { code: 'STORE_CLOSED' });
});

test('readonly database mode itself rejects SQL writes, while cold reads leave main database bytes unchanged', context => {
  const fake = fixture(context);
  fake.writer.write('probe', 'key', { count: 1 });
  fake.writer.close();
  const before = readFileSync(fake.filename);
  const connection = new DatabaseSync(fake.filename, { readOnly: true });
  try { assert.throws(() => connection.exec("INSERT INTO durable_meta VALUES ('forbidden', 1)"), /readonly database/); }
  finally { connection.close(); }
  assert.equal(fake.reader().read('probe', 'key')?.revision, 1);
  assert.deepEqual(readFileSync(fake.filename), before);
});

test('missing history never creates a directory or empty database', context => {
  const fake = fixture(context);
  const before = readdirSync(fake.directory);
  assert.throws(() => openReadonlySqliteStore(join(fake.directory, 'absent.sqlite')), { code: 'STORE_NOT_FOUND' });
  assert.throws(() => openReadonlySqliteStore(join(fake.directory, 'missing', 'absent.sqlite')), { code: 'STORE_NOT_FOUND' });
  assert.deepEqual(readdirSync(fake.directory), before);
});

test('readonly history rejects non-private permissions, symlinked ancestors/files/sidecars and hardlinks', context => {
  const fake = fixture(context);
  fake.writer.close();
  chmodSync(fake.filename, 0o644);
  assert.throws(() => fake.reader(), { code: 'STORE_READONLY_UNSAFE' });
  chmodSync(fake.filename, 0o600);
  chmodSync(fake.directory, 0o755);
  assert.throws(() => fake.reader(), { code: 'STORE_READONLY_UNSAFE' });
  chmodSync(fake.directory, 0o700);
  symlinkSync(fake.filename, join(fake.directory, 'linked.sqlite'));
  assert.throws(() => openReadonlySqliteStore(join(fake.directory, 'linked.sqlite')));
  linkSync(fake.filename, join(fake.directory, 'hard.sqlite'));
  assert.throws(() => fake.reader(), { code: 'STORE_READONLY_UNSAFE' });
  rmSync(join(fake.directory, 'hard.sqlite'));
  symlinkSync(fake.directory, join(fake.directory, 'linked-directory'));
  assert.throws(() => openReadonlySqliteStore(join(fake.directory, 'linked-directory', 'native-chat.sqlite')),
    { code: 'STORE_READONLY_UNSAFE' });
  const sentinel = join(fake.directory, 'sentinel');
  writeFileSync(sentinel, 'unchanged', { mode: 0o600 });
  symlinkSync(sentinel, fake.filename + '-wal');
  assert.throws(() => fake.reader(), { code: 'STORE_READONLY_UNSAFE' });
  assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
});

test('incompatible schema and corrupt files fail without migration or rewriting', context => {
  const fake = fixture(context);
  fake.writer.close();
  const other = join(fake.directory, 'incompatible.sqlite');
  const database = new DatabaseSync(other);
  database.exec('CREATE TABLE durable_records (key TEXT)');
  database.close();
  chmodSync(other, 0o600);
  const before = readFileSync(other);
  assert.throws(() => openReadonlySqliteStore(other), { code: 'STORE_READONLY_SCHEMA' });
  assert.deepEqual(readFileSync(other), before);
  writeFileSync(fake.filename, 'not a sqlite database');
  const corrupt = readFileSync(fake.filename);
  assert.throws(() => fake.reader(), { code: 'STORE_READONLY_UNAVAILABLE' });
  assert.deepEqual(readFileSync(fake.filename), corrupt);
});

test('native reader requires its own identity and does not run session recovery or expose mutators', context => {
  const fake = fixture(context);
  assert.throws(() => readNativeHistory(fake.directory, history => history.sessions.list()),
    { code: 'NATIVE_HISTORY_IDENTITY_MISSING' });
  fake.writer.write('native-chat.meta', 'session-definition', { identity: 'a'.repeat(64) });
  const record = fake.writer.write('host.sessions', 'private:123', { schema: 1, state: 'creating',
    generation: 1, requestId: 'interrupted-create', sessionId: null, updatedAt: 1 });
  let captured: (() => unknown) | undefined;
  readNativeHistory(fake.directory, history => {
    assert.equal(history.sessions.list()[0]?.state, 'creating');
    assert.equal('append' in history.usage, false);
    assert.equal('setPricing' in history.usage, false);
    assert.equal('start' in history.executions, false);
    assert.equal('cancel' in history.executions, false);
    captured = history.usage.summary;
  });
  assert.deepEqual(fake.writer.read('host.sessions', 'private:123'), record);
  assert(captured);
  assert.throws(captured, { code: 'STORE_CLOSED' });
});

test('readonly pagination and TTL match storage, and callback errors always close the snapshot', context => {
  const fake = fixture(context);
  fake.writer.write('probe', 'a', null, { expiresAt: Date.now() - 1 });
  fake.writer.write('probe', 'b', { value: 2 });
  fake.writer.write('probe', 'c', { value: 3 });
  const reader = fake.reader();
  assert.equal(reader.read('probe', 'a'), null);
  assert.deepEqual(reader.list('probe', { limit: 1 }).map(row => row.key), ['b']);
  assert.deepEqual(reader.list('probe', { after: 'b', limit: 1 }).map(row => row.key), ['c']);
  assert.throws(() => reader.withSnapshot(() => { throw new Error('synthetic reader failure'); }),
    { code: 'STORE_READONLY_UNAVAILABLE' });
  assert.equal(reader.withSnapshot(() => reader.list('probe')).length, 2);
  assert.throws(() => reader.withSnapshot(() => Promise.resolve()), { code: 'STORE_READONLY_ASYNC' });
});

test('locked history fails within its busy bound and permissions are rechecked on retained readers', context => {
  const fake = fixture(context);
  fake.writer.write('probe', 'key', { count: 1 });
  const reader = fake.reader();
  chmodSync(fake.filename, 0o644);
  assert.throws(() => reader.list('probe'), { code: 'STORE_READONLY_UNSAFE' });
  chmodSync(fake.filename, 0o600);
  reader.close();
  fake.writer.close();
  const blocker = new DatabaseSync(fake.filename);
  try {
    blocker.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;');
    const before = performance.now();
    assert.throws(() => fake.reader(), { code: 'STORE_READONLY_UNAVAILABLE' });
    assert(performance.now() - before < 2_000);
  } finally { blocker.exec('ROLLBACK'); blocker.close(); }
  assert.equal(fake.reader().list('probe').length, 1);
});

test('public history callbacks reject async functions before invoking them and reject returned thenables', context => {
  const fake = fixture(context);
  fake.writer.write('native-chat.meta', 'session-definition', { identity: 'a'.repeat(64) });
  let called = false;
  assert.throws(() => readNativeHistory(fake.directory, async history => {
    called = true;
    await Promise.resolve();
    return history.sessions.list();
  }), { code: 'NATIVE_HISTORY_SYNC_REQUIRED' });
  assert.equal(called, false);
  assert.throws(() => readNativeHistory(fake.directory, () => Promise.resolve(1)), { code: 'STORE_READONLY_ASYNC' });
  const thenable = Object.assign(() => undefined, { then() {} });
  assert.throws(() => readNativeHistory(fake.directory, () => thenable), { code: 'STORE_READONLY_ASYNC' });
  assert.deepEqual(readNativeHistory(fake.directory, history => history.sessions.list()), []);
});
