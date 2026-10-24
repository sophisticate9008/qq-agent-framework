import { closeSync, fchmodSync, openSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { Buffer } from 'node:buffer';

import type { Clock, JsonValue } from '../core/types.ts';
import { FrameworkError, snapshot } from '../core/values.ts';
import type { DurableStore, StoredRecord, WriteOptions } from '../host/types.ts';

const DEFAULT_MAX_RECORDS = 100_000;
const DEFAULT_MAX_VALUE_BYTES = 1_048_576;
const MAX_PAGE_SIZE = 1_000;
const MAX_REFERENCE_LENGTH = 1_024;
const MAX_SQLITE_INTEGER = Number.MAX_SAFE_INTEGER;

export interface SqliteStoreOptions {
  filename: string;
  clock?: Clock;
  maxRecords?: number;
  maxValueBytes?: number;
}

interface StoreStatements {
  selectRecord: StatementSync;
  selectRevision: StatementSync;
  countRecords: StatementSync;
  updateRevision: StatementSync;
  insertRecord: StatementSync;
  updateRecord: StatementSync;
  deleteRecord: StatementSync;
  deleteRecordAtRevision: StatementSync;
  listRecords: StatementSync;
  listRecordsAfter: StatementSync;
  purgeExpired: StatementSync;
}

interface ExistingRow {
  revision: number;
  expiresAt: number | null;
}

function fail(code: string, message: string): never {
  throw new FrameworkError(code, message);
}

function redact(error: unknown, code = 'STORE_IO_ERROR', message = 'Durable store operation failed.'): never {
  if (error instanceof FrameworkError) throw error;
  fail(code, message);
}

function assertPositiveInteger(value: number, code: string, message: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code, message);
}

function assertReference(value: string, label: string, allowEmpty = false): void {
  if (typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.length > MAX_REFERENCE_LENGTH
    || /[\x00-\x1f\x7f]/.test(value)) {
    fail('STORE_INVALID_ARGUMENT', `Expected a valid ${label}.`);
  }
}

function integerField(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail('STORE_CORRUPT', 'Durable store contains invalid metadata.');
  }
  return value;
}

function nullableIntegerField(row: Record<string, unknown>, name: string): number | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail('STORE_CORRUPT', 'Durable store contains invalid metadata.');
  }
  return value;
}

function textField(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') fail('STORE_CORRUPT', 'Durable store contains invalid data.');
  return value;
}

function decodeRecord(row: Record<string, unknown>): StoredRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textField(row, 'value')) as unknown;
  } catch {
    fail('STORE_CORRUPT', 'Durable store contains invalid data.');
  }
  let value: JsonValue;
  try {
    value = snapshot(parsed) as JsonValue;
  } catch {
    fail('STORE_CORRUPT', 'Durable store contains invalid data.');
  }
  return snapshot({
    namespace: textField(row, 'namespace'),
    key: textField(row, 'key'),
    revision: integerField(row, 'revision'),
    updatedAt: integerField(row, 'updatedAt'),
    expiresAt: nullableIntegerField(row, 'expiresAt'),
    value
  });
}

function existingRow(row: Record<string, unknown> | undefined): ExistingRow | null {
  if (!row) return null;
  return {
    revision: integerField(row, 'revision'),
    expiresAt: nullableIntegerField(row, 'expiresAt')
  };
}

function secureFile(filename: string): void {
  if (filename === ':memory:') return;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filename, 'a', 0o600);
    fchmodSync(descriptor, 0o600);
  } catch (error: unknown) {
    redact(error, 'STORE_OPEN_FAILED', 'Could not open durable store.');
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
      }
    }
  }
}

function prepareStatements(database: DatabaseSync): StoreStatements {
  return {
    selectRecord: database.prepare(`
      SELECT namespace, key, value, revision, updated_at AS updatedAt, expires_at AS expiresAt
      FROM durable_records WHERE namespace = ? AND key = ?
    `),
    selectRevision: database.prepare(`
      SELECT revision, expires_at AS expiresAt
      FROM durable_records WHERE namespace = ? AND key = ?
    `),
    countRecords: database.prepare('SELECT COUNT(*) AS count FROM durable_records'),
    updateRevision: database.prepare(`
      UPDATE durable_meta SET value = value + 1
      WHERE name = 'revision' AND value < ? RETURNING value
    `),
    insertRecord: database.prepare(`
      INSERT INTO durable_records(namespace, key, value, revision, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    updateRecord: database.prepare(`
      UPDATE durable_records SET value = ?, revision = ?, updated_at = ?, expires_at = ?
      WHERE namespace = ? AND key = ?
    `),
    deleteRecord: database.prepare('DELETE FROM durable_records WHERE namespace = ? AND key = ?'),
    deleteRecordAtRevision: database.prepare(`
      DELETE FROM durable_records WHERE namespace = ? AND key = ? AND revision = ?
    `),
    listRecords: database.prepare(`
      SELECT namespace, key, value, revision, updated_at AS updatedAt, expires_at AS expiresAt
      FROM durable_records
      WHERE namespace = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY key LIMIT ?
    `),
    listRecordsAfter: database.prepare(`
      SELECT namespace, key, value, revision, updated_at AS updatedAt, expires_at AS expiresAt
      FROM durable_records
      WHERE namespace = ? AND key > ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY key LIMIT ?
    `),
    purgeExpired: database.prepare(`
      DELETE FROM durable_records WHERE rowid IN (
        SELECT rowid FROM durable_records
        WHERE expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at, namespace, key LIMIT ?
      )
    `)
  };
}

export function createSqliteStore(options: SqliteStoreOptions): DurableStore {
  if (!options || typeof options !== 'object') fail('STORE_INVALID_OPTIONS', 'Expected durable store options.');
  const { filename, clock = Date.now, maxRecords = DEFAULT_MAX_RECORDS,
    maxValueBytes = DEFAULT_MAX_VALUE_BYTES } = options;
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 4_096 || filename.includes('\0')) {
    fail('STORE_INVALID_OPTIONS', 'Expected a valid durable store filename.');
  }
  if (typeof clock !== 'function') fail('STORE_INVALID_OPTIONS', 'Expected a clock function.');
  assertPositiveInteger(maxRecords, 'STORE_INVALID_OPTIONS', 'Expected a positive record limit.');
  assertPositiveInteger(maxValueBytes, 'STORE_INVALID_OPTIONS', 'Expected a positive value size limit.');
  secureFile(filename);

  let database!: DatabaseSync;
  try {
    database = new DatabaseSync(filename, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000
    });
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA trusted_schema = OFF;
      CREATE TABLE IF NOT EXISTS durable_meta (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL CHECK(value >= 0)
      ) STRICT;
      INSERT OR IGNORE INTO durable_meta(name, value) VALUES ('revision', 0);
      CREATE TABLE IF NOT EXISTS durable_records (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        revision INTEGER NOT NULL UNIQUE,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY(namespace, key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS durable_records_expiry
      ON durable_records(expires_at, namespace, key);
    `);
    database.enableDefensive(true);
  } catch (error: unknown) {
    try {
      if (database?.isOpen) database.close();
    } catch {
    }
    redact(error, 'STORE_OPEN_FAILED', 'Could not initialize durable store.');
  }

  let statements: StoreStatements;
  try {
    statements = prepareStatements(database);
  } catch (error: unknown) {
    try {
      database.close();
    } catch {
    }
    redact(error, 'STORE_OPEN_FAILED', 'Could not initialize durable store.');
  }
  let closed = false;

  function assertOpen(): void {
    if (closed) fail('STORE_CLOSED', 'Durable store is closed.');
  }

  function now(): number {
    const value = clock();
    if (!Number.isSafeInteger(value)) fail('STORE_CLOCK_INVALID', 'Durable store clock returned an invalid value.');
    return value;
  }

  function transaction<Result>(operation: () => Result): Result {
    assertOpen();
    try {
      database.exec('BEGIN IMMEDIATE');
    } catch (error: unknown) {
      redact(error);
    }
    try {
      const result = operation();
      database.exec('COMMIT');
      return result;
    } catch (error: unknown) {
      try {
        if (database.isTransaction) database.exec('ROLLBACK');
      } catch {
      }
      redact(error);
    }
  }

  function nextRevision(): number {
    const row = statements.updateRevision.get(MAX_SQLITE_INTEGER);
    if (!row) fail('STORE_REVISION_EXHAUSTED', 'Durable store revision limit was reached.');
    return integerField(row, 'value');
  }

  function read(namespace: string, key: string): StoredRecord | null {
    assertOpen();
    assertReference(namespace, 'namespace');
    assertReference(key, 'key');
    const currentTime = now();
    try {
      const row = statements.selectRecord.get(namespace, key);
      if (!row) return null;
      const expiresAt = nullableIntegerField(row, 'expiresAt');
      return expiresAt !== null && expiresAt <= currentTime ? null : decodeRecord(row);
    } catch (error: unknown) {
      redact(error);
    }
  }

  function write(namespace: string, key: string, input: JsonValue,
    writeOptions: WriteOptions = {}): StoredRecord {
    assertOpen();
    assertReference(namespace, 'namespace');
    assertReference(key, 'key');
    if (!writeOptions || typeof writeOptions !== 'object') {
      fail('STORE_INVALID_ARGUMENT', 'Expected valid write options.');
    }
    const hasExpectation = Object.hasOwn(writeOptions, 'expectedRevision')
      && writeOptions.expectedRevision !== undefined;
    const expectedRevision = writeOptions.expectedRevision;
    if (hasExpectation && expectedRevision !== null
      && (typeof expectedRevision !== 'number'
        || !Number.isSafeInteger(expectedRevision) || expectedRevision <= 0)) {
      fail('STORE_INVALID_ARGUMENT', 'Expected a valid revision.');
    }
    const expiresAt = writeOptions.expiresAt ?? null;
    if (expiresAt !== null && !Number.isSafeInteger(expiresAt)) {
      fail('STORE_INVALID_ARGUMENT', 'Expected a valid expiration time.');
    }
    const detached = snapshot(input) as JsonValue;
    const serialized = JSON.stringify(detached);
    if (Buffer.byteLength(serialized, 'utf8') > maxValueBytes) {
      fail('STORE_VALUE_TOO_LARGE', 'Durable store value exceeds the configured limit.');
    }
    const canonical = snapshot(JSON.parse(serialized) as unknown) as JsonValue;
    const currentTime = now();

    return transaction(() => {
      const current = existingRow(statements.selectRevision.get(namespace, key));
      const active = current !== null && (current.expiresAt === null || current.expiresAt > currentTime);
      if (hasExpectation && expectedRevision === null && active) {
        fail('STORE_CONFLICT', 'Durable store revision does not match.');
      }
      if (hasExpectation && typeof expectedRevision === 'number'
        && (!active || current.revision !== expectedRevision)) {
        fail('STORE_CONFLICT', 'Durable store revision does not match.');
      }
      if (current === null) {
        const countRow = statements.countRecords.get();
        if (!countRow || integerField(countRow, 'count') >= maxRecords) {
          fail('STORE_CAPACITY_EXCEEDED', 'Durable store record limit was reached.');
        }
      }
      const revision = nextRevision();
      if (current === null) {
        statements.insertRecord.run(namespace, key, serialized, revision, currentTime, expiresAt);
      } else {
        statements.updateRecord.run(serialized, revision, currentTime, expiresAt, namespace, key);
      }
      return snapshot({ namespace, key, revision, updatedAt: currentTime, expiresAt, value: canonical });
    });
  }

  function deleteRecord(namespace: string, key: string, expectedRevision?: number): boolean {
    assertOpen();
    assertReference(namespace, 'namespace');
    assertReference(key, 'key');
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0)) {
      fail('STORE_INVALID_ARGUMENT', 'Expected a valid revision.');
    }
    try {
      const result = expectedRevision === undefined
        ? statements.deleteRecord.run(namespace, key)
        : statements.deleteRecordAtRevision.run(namespace, key, expectedRevision);
      return Number(result.changes) === 1;
    } catch (error: unknown) {
      redact(error);
    }
  }

  function list(namespace: string, listOptions: { limit?: number; after?: string } = {}): readonly StoredRecord[] {
    assertOpen();
    assertReference(namespace, 'namespace');
    if (!listOptions || typeof listOptions !== 'object') {
      fail('STORE_INVALID_ARGUMENT', 'Expected valid list options.');
    }
    const limit = listOptions.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE) {
      fail('STORE_INVALID_ARGUMENT', 'Expected a list limit between 1 and 1000.');
    }
    if (listOptions.after !== undefined) assertReference(listOptions.after, 'cursor', true);
    const currentTime = now();
    try {
      const rows = listOptions.after === undefined
        ? statements.listRecords.all(namespace, currentTime, limit)
        : statements.listRecordsAfter.all(namespace, listOptions.after, currentTime, limit);
      return snapshot(rows.map(decodeRecord));
    } catch (error: unknown) {
      redact(error);
    }
  }

  function purgeExpired(limit = MAX_PAGE_SIZE): number {
    assertOpen();
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE) {
      fail('STORE_INVALID_ARGUMENT', 'Expected a purge limit between 1 and 1000.');
    }
    try {
      return Number(statements.purgeExpired.run(now(), limit).changes);
    } catch (error: unknown) {
      redact(error);
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    try {
      database.close();
    } catch (error: unknown) {
      redact(error, 'STORE_CLOSE_FAILED', 'Could not close durable store.');
    }
  }

  return { read, write, delete: deleteRecord, list, purgeExpired, close };
}
