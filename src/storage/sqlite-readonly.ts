import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { JsonValue } from '../core/types.ts';
import { assert, FrameworkError, snapshot } from '../core/values.ts';
import type { DurableStore, StoredRecord } from '../contracts/ports.ts';

export interface ReadonlySqliteStore extends DurableStore {
  withSnapshot<Result>(read: () => Result): Result;
  revision(): number;
}

function fail(code = 'STORE_READONLY_UNAVAILABLE'): never {
  throw new FrameworkError(code, 'Existing private history storage is unavailable.');
}

function privateMetadata(filename: string, directory = false): Stats {
  const metadata = lstatSync(filename);
  assert(!metadata.isSymbolicLink() && (directory ? metadata.isDirectory() : metadata.isFile() && metadata.nlink === 1)
    && (metadata.mode & 0o777) === (directory ? 0o700 : 0o600)
    && (typeof process.getuid !== 'function' || metadata.uid === process.getuid()),
  'STORE_READONLY_UNSAFE', 'History storage must remain private and non-linked.');
  return metadata;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function storeReference(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_024 && !/[\x00-\x1f\x7f]/.test(value);
}

function decode(row: Record<string, unknown>): StoredRecord {
  assert(storeReference(row.namespace) && storeReference(row.key) && typeof row.value === 'string'
    && Buffer.byteLength(row.value) <= 1_048_576
    && typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision > 0
    && typeof row.updatedAt === 'number' && Number.isSafeInteger(row.updatedAt)
    && (row.expiresAt === null || typeof row.expiresAt === 'number' && Number.isSafeInteger(row.expiresAt)),
  'STORE_CORRUPT', 'Stored history metadata is invalid.');
  return snapshot({ namespace: row.namespace, key: row.key, value: JSON.parse(row.value) as JsonValue,
    revision: row.revision, updatedAt: row.updatedAt, expiresAt: row.expiresAt });
}

/** Validate the existing framework tables without creating or repairing them. */
export function validateExistingSqliteSchema(database: DatabaseSync): void {
  const tables = database.prepare('PRAGMA table_list').all();
  for (const [table, expected] of [
    ['durable_meta', [['name', 'TEXT', 1, 1], ['value', 'INTEGER', 1, 0]]],
    ['durable_records', [['namespace', 'TEXT', 1, 1], ['key', 'TEXT', 1, 2], ['value', 'TEXT', 1, 0],
      ['revision', 'INTEGER', 1, 0], ['updated_at', 'INTEGER', 1, 0], ['expires_at', 'INTEGER', 0, 0]]]
  ] as const) {
    assert(tables.some(row => row.schema === 'main' && row.name === table && row.type === 'table' && row.strict === 1),
      'STORE_READONLY_SCHEMA', 'History requires the existing framework schema.');
    const columns = database.prepare(`PRAGMA table_info(${table})`).all()
      .map(row => [row.name, row.type, row.notnull, row.pk]);
    assert(JSON.stringify(columns) === JSON.stringify(expected), 'STORE_READONLY_SCHEMA', 'History schema is incompatible.');
  }
  const revision = database.prepare("SELECT value FROM durable_meta WHERE name = 'revision'").get()?.value;
  assert(typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0,
    'STORE_READONLY_SCHEMA', 'History revision metadata is missing.');
}

export function openReadonlySqliteStore(filename: string): ReadonlySqliteStore {
  assert(isAbsolute(filename) && filename === resolve(filename) && !filename.includes('\0'),
    'STORE_READONLY_UNSAFE', 'History requires a canonical absolute filename.');
  const directory = dirname(filename);
  let descriptor: number | undefined;
  let database: DatabaseSync | undefined;
  let closed = false;
  let inSnapshot = false;
  let snapshotTime: number | undefined;
  let directoryMetadata: Stats;

  function checkFiles() {
    assert(realpathSync(directory) === directory && sameFile(directoryMetadata, privateMetadata(directory, true))
      && descriptor !== undefined && sameFile(fstatSync(descriptor), privateMetadata(filename)),
    'STORE_READONLY_UNSAFE', 'History storage identity changed.');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { privateMetadata(filename + suffix); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
  }

  try {
    directoryMetadata = privateMetadata(directory, true);
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    checkFiles();
    database = new DatabaseSync(filename, { readOnly: true, allowExtension: false,
      enableDoubleQuotedStringLiterals: false, timeout: 250 });
    database.enableDefensive(true);
    database.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;');
    checkFiles();
    validateExistingSqliteSchema(database);
  } catch (error) {
    try { database?.close(); } finally { if (descriptor !== undefined) closeSync(descriptor); }
    if (error instanceof FrameworkError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') fail('STORE_NOT_FOUND');
    fail();
  }
  const connection = database;
  const select = 'SELECT namespace, key, value, revision, updated_at AS updatedAt, expires_at AS expiresAt FROM durable_records';

  function readOperation<Result>(read: () => Result): Result {
    assert(!closed, 'STORE_CLOSED', 'The history reader is closed.');
    try { checkFiles(); return read(); }
    catch (error) { if (error instanceof FrameworkError) throw error; fail(); }
  }

  function boundedReference(value: string) {
    assert(storeReference(value), 'STORE_INVALID_ARGUMENT', 'A bounded history reference is required.');
  }

  const denied = (): never => fail('STORE_READONLY');
  return Object.freeze({
    revision() {
      return readOperation(() => {
        const value = connection.prepare("SELECT value FROM durable_meta WHERE name = 'revision'").get()?.value;
        assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'STORE_CORRUPT', 'History revision metadata is invalid.');
        return value;
      });
    },
    read(namespace: string, key: string) {
      return readOperation(() => {
        boundedReference(namespace);
        boundedReference(key);
        const row = connection.prepare(`${select} WHERE namespace = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)`)
          .get(namespace, key, snapshotTime ?? Date.now());
        return row ? decode(row) : null;
      });
    },
    list(namespace: string, { limit = 100, after }: { limit?: number; after?: string } = {}) {
      return readOperation(() => {
        boundedReference(namespace);
        assert(Number.isSafeInteger(limit) && limit > 0 && limit <= 1_000,
          'STORE_INVALID_ARGUMENT', 'History pages must be bounded.');
        if (after !== undefined) boundedReference(after);
        const rows = after === undefined
          ? connection.prepare(`${select} WHERE namespace = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?`)
            .all(namespace, snapshotTime ?? Date.now(), limit)
          : connection.prepare(`${select} WHERE namespace = ? AND key > ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?`)
            .all(namespace, after, snapshotTime ?? Date.now(), limit);
        return snapshot(rows.map(decode));
      });
    },
    write: denied, delete: denied, purgeExpired: denied,
    withSnapshot<Result>(read: () => Result): Result {
      return readOperation(() => {
        assert(!inSnapshot, 'STORE_READONLY_TRANSACTION', 'Nested history snapshots are unavailable.');
        connection.exec('BEGIN');
        inSnapshot = true;
        snapshotTime = Date.now();
        try {
          const result = read();
          assert(!(result && (typeof result === 'object' || typeof result === 'function') && 'then' in result),
            'STORE_READONLY_ASYNC', 'History snapshots must finish synchronously.');
          checkFiles();
          return result;
        } finally {
          try { connection.exec('ROLLBACK'); } finally { inSnapshot = false; snapshotTime = undefined; }
        }
      });
    },
    close() {
      if (closed) return;
      assert(!inSnapshot, 'STORE_READONLY_TRANSACTION', 'Cannot close an active history snapshot.');
      closed = true;
      try { connection.close(); } finally { closeSync(descriptor!); }
    }
  });
}
