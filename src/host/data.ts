import { createHash } from 'node:crypto';
import { assert, isRecord, snapshot } from '../core/values.ts';
import type { JsonObject, JsonValue } from '../core/types.ts';
import type { DurableStore, StoredRecord } from './types.ts';

export function json(value: unknown): JsonValue { return snapshot(value) as JsonValue; }

export function object(value: unknown): JsonObject {
  assert(isRecord(value), 'INVALID_STORED_DATA', 'Stored service data is invalid.');
  return value as JsonObject;
}

export function digest(value: unknown): string {
  const safe = json(value);
  const serialized = JSON.stringify(safe, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
  return createHash('sha256').update(serialized).digest('hex');
}

export function* records(store: DurableStore, namespace: string): Generator<StoredRecord> {
  let after: string | undefined;
  while (true) {
    const batch = store.list(namespace, after === undefined ? { limit: 100 } : { limit: 100, after });
    yield* batch;
    if (batch.length < 100) return;
    after = batch[batch.length - 1].key;
  }
}
