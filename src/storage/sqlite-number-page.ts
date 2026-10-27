import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DurableNumberPage } from '../contracts/ports.ts';
import { assert, reference } from '../core/values.ts';

const indexes = new WeakMap<DatabaseSync, Set<string>>();

/** Keyset pagination keeps old pages stable when execution progress changes. */
export function readNumberPage(database: DatabaseSync, query: DurableNumberPage, now: number, writable = false) {
  assert(reference(query.namespace) && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(query.field)
    && Number.isSafeInteger(query.limit) && query.limit >= 1 && query.limit <= 1000
    && (query.before === undefined || Number.isSafeInteger(query.before.value) && reference(query.before.key)),
  'STORE_INVALID_ARGUMENT', 'Numeric pages require a bounded query and cursor.');
  const namespace = `'${query.namespace.replaceAll("'", "''")}'`;
  const field = `json_extract(value, '$.${query.field}')`;
  const identity = `${namespace}:${field}`;
  if (writable) {
    const installed = indexes.get(database) ?? new Set<string>();
    if (!installed.has(identity)) {
      assert(installed.size < 64, 'STORE_INDEX_LIMIT', 'The index registration bound was reached.');
      const name = `durable_number_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
      database.exec(`CREATE INDEX IF NOT EXISTS ${name} ON durable_records(${field} DESC, key DESC) WHERE namespace = ${namespace}`);
      installed.add(identity);
      indexes.set(database, installed);
    }
  }
  const statement = database.prepare(`SELECT namespace, key, value, revision, updated_at AS updatedAt, expires_at AS expiresAt
    FROM durable_records WHERE namespace = ${namespace} AND (expires_at IS NULL OR expires_at > ?)
    ${query.before ? `AND (${field}, key) < (?, ?)` : ''}
    ORDER BY ${field} DESC, key DESC LIMIT ?`);
  return query.before
    ? statement.all(now, query.before.value, query.before.key, query.limit)
    : statement.all(now, query.limit);
}
