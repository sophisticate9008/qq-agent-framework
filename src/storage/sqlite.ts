import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { Clock, JsonValue } from '../core/types.ts';
import { FrameworkError, isRecord, snapshot } from '../core/values.ts';
import { openReadonlySqliteStore, validateExistingSqliteSchema } from './sqlite-readonly.ts';
import type { DurableCasMutation, DurableIndexDefinition, DurableLookup, DurableNumberPage, DurableStore, DurableStoreStats, DurableStoreStatsOptions, StoredRecord, WriteOptions } from '../contracts/ports.ts';
import { readNumberPage } from './sqlite-number-page.ts';

const DEFAULT_MAX_RECORDS = 100_000;
const DEFAULT_MAX_VALUE_BYTES = 1_048_576;
const MAX_PAGE_SIZE = 1_000;
const MAX_REFERENCE_LENGTH = 1_024;
const MAX_SQLITE_INTEGER = Number.MAX_SAFE_INTEGER;

export interface SqliteStoreOptions {
  filename: string;
  /** Require a private, existing framework database; never create or repair its permissions/schema. */
  requireExisting?: boolean;
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
  statsTotals: StatementSync;
  statsNamespaces: StatementSync;
  statsNamespacesAfter: StatementSync;
  purgeExpired: StatementSync;
}

export interface SqliteStore extends DurableStore {
  maintenancePage(cutoff: number, after?: { at: number; namespace: string; key: string }): readonly StoredRecord[];
  stats(options?: DurableStoreStatsOptions): DurableStoreStats;
  createIndex(definition: DurableIndexDefinition): void;
  lookup(query: DurableLookup): readonly StoredRecord[];
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
    statsTotals: database.prepare(`
      SELECT COUNT(*) AS totalRecords,
        COUNT(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 END) AS expiredRecords
      FROM durable_records
    `),
    statsNamespaces: database.prepare(`
      SELECT namespace, COUNT(*) AS totalRecords,
        COUNT(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 END) AS expiredRecords,
        MIN(updated_at) AS oldestUpdatedAt
      FROM durable_records
      GROUP BY namespace ORDER BY namespace LIMIT ?
    `),
    statsNamespacesAfter: database.prepare(`
      SELECT namespace, COUNT(*) AS totalRecords,
        COUNT(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 END) AS expiredRecords,
        MIN(updated_at) AS oldestUpdatedAt
      FROM durable_records
      WHERE namespace > ?
      GROUP BY namespace ORDER BY namespace LIMIT ?
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

export function createSqliteStore(options: SqliteStoreOptions): SqliteStore {
  if (!options || typeof options !== 'object') fail('STORE_INVALID_OPTIONS', 'Expected durable store options.');
  const { filename, clock = Date.now, maxRecords = DEFAULT_MAX_RECORDS,
    maxValueBytes = DEFAULT_MAX_VALUE_BYTES } = options;
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 4_096 || filename.includes('\0')) {
    fail('STORE_INVALID_OPTIONS', 'Expected a valid durable store filename.');
  }
  if (typeof clock !== 'function') fail('STORE_INVALID_OPTIONS', 'Expected a clock function.');
  assertPositiveInteger(maxRecords, 'STORE_INVALID_OPTIONS', 'Expected a positive record limit.');
  assertPositiveInteger(maxValueBytes, 'STORE_INVALID_OPTIONS', 'Expected a positive value size limit.');
  if (options.requireExisting !== undefined && typeof options.requireExisting !== 'boolean') fail('STORE_INVALID_OPTIONS', 'Expected an existing-storage flag.');
  let existingDescriptor: number | undefined;
  function checkExistingIdentity(): void {
    if (existingDescriptor === undefined) return;
    const opened = fstatSync(existingDescriptor);
    const current = lstatSync(filename);
    if (!current.isFile() || current.nlink !== 1 || (current.mode & 0o777) !== 0o600
      || typeof process.getuid === 'function' && current.uid !== process.getuid()
      || current.dev !== opened.dev || current.ino !== opened.ino) fail('STORE_READONLY_UNSAFE', 'Existing storage identity changed.');
  }
  if (options.requireExisting) {
    // Reuse the read boundary's canonical path, owner, sidecar and original-schema validation.
    const reader = openReadonlySqliteStore(filename);
    try {
      existingDescriptor = openSync(filename, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      checkExistingIdentity();
    } catch (error) {
      if (existingDescriptor !== undefined) { closeSync(existingDescriptor); existingDescriptor = undefined; }
      redact(error, 'STORE_OPEN_FAILED', 'Could not open existing durable store.');
    } finally { reader.close(); }
  } else secureFile(filename);

  let database!: DatabaseSync;
  try {
    database = new DatabaseSync(filename, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000
    });
    checkExistingIdentity();
    if (options.requireExisting) validateExistingSqliteSchema(database);
    database.exec(options.requireExisting ? `
      PRAGMA synchronous = FULL;
      PRAGMA trusted_schema = OFF;
    ` : `
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
    if (existingDescriptor !== undefined) closeSync(existingDescriptor);
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
    if (existingDescriptor !== undefined) closeSync(existingDescriptor);
    redact(error, 'STORE_OPEN_FAILED', 'Could not initialize durable store.');
  }
  let closed = false;
  const lookupStatements = new Map<string, StatementSync>();

  function assertOpen(): void {
    if (closed) fail('STORE_CLOSED', 'Durable store is closed.');
    checkExistingIdentity();
  }

  function scalar(value: unknown): string {
    if (value === null) return 'NULL';
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)) return `'${value.replaceAll("'", "''")}'`;
    fail('STORE_INVALID_INDEX', 'An index equality requires a bounded JSON scalar.');
  }

  function indexSql(definition: DurableIndexDefinition): { key: string; predicate: string; expression: string } {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)
      || Object.keys(definition).some(key => !['namespace', 'field', 'unique', 'where'].includes(key))
      || typeof definition.field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(definition.field)
      || definition.unique !== undefined && typeof definition.unique !== 'boolean') fail('STORE_INVALID_INDEX', 'Invalid index definition.');
    assertReference(definition.namespace, 'namespace');
    const expression = `json_extract(value, '$.${definition.field}')`;
    let predicate = `namespace = ${scalar(definition.namespace)}`;
    if (definition.where !== undefined) {
      if (!definition.where || typeof definition.where !== 'object' || Array.isArray(definition.where)
        || Object.keys(definition.where).length !== 2 || !Object.hasOwn(definition.where, 'equals')
        || typeof definition.where.field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(definition.where.field)) fail('STORE_INVALID_INDEX', 'Invalid index filter.');
      predicate += ` AND json_extract(value, '$.${definition.where.field}') IS ${scalar(definition.where.equals)}`;
    }
    return { key: `${predicate}:${expression}`, predicate, expression };
  }

  function createIndex(definition: DurableIndexDefinition): void {
    assertOpen();
    const parsed = indexSql(definition);
    if (lookupStatements.size >= 64 && !lookupStatements.has(parsed.key)) fail('STORE_INDEX_LIMIT', 'The index registration bound was reached.');
    const name = `durable_json_${createHash('sha256').update(`${parsed.key}:${definition.unique === true}`).digest('hex').slice(0, 32)}`;
    try {
      database.exec(`CREATE ${definition.unique === true ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${name} ON durable_records(${parsed.expression}) WHERE ${parsed.predicate}`);
      lookupStatements.set(parsed.key, database.prepare(`SELECT namespace, key, value, revision, updated_at AS updatedAt, expires_at AS expiresAt
        FROM durable_records WHERE ${parsed.predicate} AND ${parsed.expression} IS ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?`));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_SQLITE_ERROR'
        && 'errcode' in error && error.errcode === 2067) fail('STORE_INDEX_CONFLICT', 'Existing records violate the unique index.');
      redact(error, 'STORE_INDEX_UNAVAILABLE', 'The requested index could not be installed.');
    }
  }

  function lookup(query: DurableLookup): readonly StoredRecord[] {
    assertOpen();
    if (!query || typeof query !== 'object' || Array.isArray(query)
      || Object.keys(query).some(key => !['namespace', 'field', 'equals', 'where', 'limit'].includes(key))
      || !Object.hasOwn(query, 'equals')) fail('STORE_INVALID_INDEX', 'Invalid indexed lookup.');
    scalar(query.equals);
    const parsed = indexSql({ namespace: query.namespace, field: query.field, ...(query.where === undefined ? {} : { where: query.where }) });
    const statement = lookupStatements.get(parsed.key);
    if (!statement) fail('STORE_INDEX_UNAVAILABLE', 'The lookup requires a registered index.');
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) fail('STORE_INVALID_INDEX', 'Indexed lookup limit is invalid.');
    try {
      const equals = typeof query.equals === 'boolean' ? Number(query.equals) : query.equals;
      return snapshot(statement.all(equals, now(), limit).map(decodeRecord));
    } catch (error) { redact(error); }
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

  function compareAndSetBatch(input: readonly DurableCasMutation[]): readonly (StoredRecord | null)[] {
    assertOpen();
    if (!Array.isArray(input) || input.length < 1 || input.length > 128 || Object.keys(input).length !== input.length)
      fail('STORE_INVALID_ARGUMENT', 'A CAS batch requires between one and 128 mutations.');
    const mutations: readonly DurableCasMutation[] = snapshot(input);
    const currentTime = now();
    const seen = new Set<string>();
    let bytes = 0;
    const prepared = mutations.map(mutation => {
      const candidate: unknown = mutation;
      if (!isRecord(candidate) || typeof candidate.kind !== 'string' || !['write', 'delete', 'check'].includes(candidate.kind)
        || Object.keys(candidate).some(key => !['kind', 'namespace', 'key', 'expectedRevision',
          ...(candidate.kind === 'write' ? ['value', 'expiresAt'] : [])].includes(key))
        || !Object.hasOwn(candidate, 'expectedRevision') || candidate.expectedRevision !== null
          && (typeof candidate.expectedRevision !== 'number' || !Number.isSafeInteger(candidate.expectedRevision) || candidate.expectedRevision <= 0)
        || candidate.kind === 'delete' && candidate.expectedRevision === null) fail('STORE_INVALID_ARGUMENT', 'A CAS mutation requires an exact expected revision.');
      assertReference(mutation.namespace, 'namespace');
      assertReference(mutation.key, 'key');
      const identity = JSON.stringify([mutation.namespace, mutation.key]);
      if (seen.has(identity)) fail('STORE_INVALID_ARGUMENT', 'A record may appear only once in a CAS batch.');
      seen.add(identity);
      const serialized = mutation.kind === 'write' ? JSON.stringify(mutation.value) : null;
      const expiresAt = mutation.kind === 'write' ? mutation.expiresAt ?? null : null;
      if (serialized === undefined || serialized !== null && Buffer.byteLength(serialized) > maxValueBytes
        || expiresAt !== null && !Number.isSafeInteger(expiresAt)) fail('STORE_INVALID_ARGUMENT', 'A CAS mutation exceeds storage limits.');
      bytes += serialized === null ? 0 : Buffer.byteLength(serialized);
      if (bytes > 8 * 1024 * 1024) fail('STORE_VALUE_TOO_LARGE', 'A CAS batch exceeds its byte limit.');
      return { mutation, serialized, expiresAt };
    });
    return transaction(() => {
      // Check the complete read set before changing either business records or their journal.
      const current = prepared.map(({ mutation }) => {
        const value = existingRow(statements.selectRevision.get(mutation.namespace, mutation.key));
        const active = value !== null && (value.expiresAt === null || value.expiresAt > currentTime);
        if (mutation.expectedRevision === null ? active : !active || value!.revision !== mutation.expectedRevision)
          fail('STORE_CONFLICT', 'Durable store revision does not match.');
        return value;
      });
      const count = integerField(statements.countRecords.get()!, 'count');
      const additions = prepared.filter((entry, index) => entry.mutation.kind === 'write' && current[index] === null).length;
      const deletions = prepared.filter(entry => entry.mutation.kind === 'delete').length;
      if (count + additions - deletions > maxRecords) fail('STORE_CAPACITY_EXCEEDED', 'Durable store record limit was reached.');
      const result: (StoredRecord | null)[] = [];
      for (const [index, entry] of prepared.entries()) {
        const mutation = entry.mutation;
        if (mutation.kind === 'delete') { statements.deleteRecordAtRevision.run(mutation.namespace, mutation.key, mutation.expectedRevision); result.push(null); continue; }
        if (mutation.kind === 'check') {
          const row = mutation.expectedRevision === null ? null : statements.selectRecord.get(mutation.namespace, mutation.key);
          result.push(row ? decodeRecord(row) : null);
          continue;
        }
        const revision = nextRevision();
        if (current[index] === null) statements.insertRecord.run(mutation.namespace, mutation.key, entry.serialized, revision, currentTime, entry.expiresAt);
        else statements.updateRecord.run(entry.serialized, revision, currentTime, entry.expiresAt, mutation.namespace, mutation.key);
        result.push(snapshot({ namespace: mutation.namespace, key: mutation.key, revision, updatedAt: currentTime,
          expiresAt: entry.expiresAt, value: mutation.value }));
      }
      return snapshot(result);
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

  function stats(statsOptions: DurableStoreStatsOptions = {}): DurableStoreStats {
    assertOpen();
    if (!statsOptions || typeof statsOptions !== 'object' || Array.isArray(statsOptions)) {
      fail('STORE_INVALID_ARGUMENT', 'Expected valid stats options.');
    }
    const limit = statsOptions.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE) {
      fail('STORE_INVALID_ARGUMENT', 'Expected a stats limit between 1 and 1000.');
    }
    if (statsOptions.after !== undefined) assertReference(statsOptions.after, 'cursor', true);
    const currentTime = now();
    try {
      database.exec('BEGIN');
      const totals = statements.statsTotals.get(currentTime);
      if (!totals) fail('STORE_CORRUPT', 'Durable store contains invalid metadata.');
      const totalRecords = integerField(totals, 'totalRecords');
      const rows = statsOptions.after === undefined
        ? statements.statsNamespaces.all(currentTime, limit + 1)
        : statements.statsNamespacesAfter.all(currentTime, statsOptions.after, limit + 1);
      const page = rows.slice(0, limit);
      const namespaces = page.map(row => ({
        namespace: textField(row, 'namespace'),
        totalRecords: integerField(row, 'totalRecords'),
        expiredRecords: integerField(row, 'expiredRecords'),
        oldestUpdatedAt: integerField(row, 'oldestUpdatedAt'),
      }));
      const result = snapshot({
        maxRecords,
        totalRecords,
        expiredRecords: integerField(totals, 'expiredRecords'),
        remainingRecords: Math.max(0, maxRecords - totalRecords),
        namespaces,
        next: rows.length > limit ? namespaces[namespaces.length - 1].namespace : null,
      });
      database.exec('COMMIT');
      return result;
    } catch (error: unknown) {
      try { if (database.isTransaction) database.exec('ROLLBACK'); } catch {}
      redact(error);
    }
  }

  let maintenanceQuery: StatementSync | undefined;
  function maintenancePage(cutoff: number, after?: { at: number; namespace: string; key: string }): readonly StoredRecord[] {
    assertOpen();
    if (!maintenanceQuery) {
      database.exec('CREATE INDEX IF NOT EXISTS durable_maintenance_order ON durable_records(updated_at, namespace, key)');
      maintenanceQuery = database.prepare(`SELECT namespace, key, value, revision, updated_at AS updatedAt, expires_at AS expiresAt
        FROM durable_records WHERE updated_at <= ? AND (updated_at, namespace, key) > (?, ?, ?)
        ORDER BY updated_at, namespace, key LIMIT 100`);
    }
    return maintenanceQuery.all(cutoff, after?.at ?? -1, after?.namespace ?? '', after?.key ?? '').map(decodeRecord);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    try {
      database.close();
    } catch (error: unknown) {
      redact(error, 'STORE_CLOSE_FAILED', 'Could not close durable store.');
    } finally { if (existingDescriptor !== undefined) closeSync(existingDescriptor); }
  }

  function listByNumber(query: DurableNumberPage): readonly StoredRecord[] {
    assertOpen();
    try { return snapshot(readNumberPage(database, query, now(), true).map(decodeRecord)); }
    catch (error) { redact(error); }
  }
  return { read, write, delete: deleteRecord, list, listByNumber, compareAndSetBatch, purgeExpired, stats, createIndex, lookup, maintenancePage, close };
}
