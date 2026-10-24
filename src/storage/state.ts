import { Buffer } from 'node:buffer';

import type { FeatureStateScope } from '../core/context.ts';
import type { JsonObject, JsonValue } from '../core/types.ts';
import { FrameworkError, assert, identifier, isRecord, reference, snapshot } from '../core/values.ts';
import type { DurableStore, StoredRecord } from '../host/types.ts';

const STATE_NAMESPACE = 'feature.state';
const MAX_ATTEMPTS = 12;
const PAGE_SIZE = 1_000;

interface FeatureStateNamespaceDescription extends JsonObject {
  featureId: string;
  conversationId: string;
  entries: number;
}

interface FeatureStateDescription extends JsonObject {
  namespaces: FeatureStateNamespaceDescription[];
}

interface PersistentFeatureState {
  scope(featureId: string, conversationId: string): FeatureStateScope;
  describe(): FeatureStateDescription;
}

interface StateEntry {
  featureId: string;
  conversationId: string;
  key: string;
  value: JsonValue;
}

export interface PersistentFeatureStateOptions {
  store: DurableStore;
}

function stateRecordKey(featureId: string, conversationId: string, key: string): string {
  return `v1.${Buffer.from(JSON.stringify([featureId, conversationId, key]), 'utf8').toString('base64url')}`;
}

function stateValue(entry: StateEntry): JsonObject {
  return {
    schema: 1,
    featureId: entry.featureId,
    conversationId: entry.conversationId,
    key: entry.key,
    value: entry.value
  };
}

function parseEntry(record: StoredRecord): StateEntry {
  const value = record.value;
  assert(isRecord(value)
    && value.schema === 1
    && identifier(value.featureId)
    && reference(value.conversationId)
    && reference(value.key),
  'FEATURE_STATE_INVALID_VALUE', 'Stored feature state data is invalid.');
  assert(record.key === stateRecordKey(value.featureId, value.conversationId, value.key),
    'FEATURE_STATE_INVALID_VALUE', 'Stored feature state data is invalid.');
  return {
    featureId: value.featureId,
    conversationId: value.conversationId,
    key: value.key,
    value: value.value as JsonValue
  };
}

function conflict(error: unknown): boolean {
  return error instanceof FrameworkError && error.code === 'STORE_CONFLICT';
}

function safeValue(value: JsonValue): JsonValue {
  try {
    return snapshot(value);
  } catch {
    throw new FrameworkError('FEATURE_STATE_INVALID_VALUE', 'State value must contain JSON data.');
  }
}

export function createPersistentFeatureState({ store }: PersistentFeatureStateOptions): Readonly<PersistentFeatureState> {
  assert(store && typeof store.read === 'function' && typeof store.write === 'function',
    'FEATURE_STATE_INVALID_SCOPE', 'A durable store is required.');

  function scope(featureId: string, conversationId: string): FeatureStateScope {
    assert(identifier(featureId), 'FEATURE_STATE_INVALID_SCOPE', 'Feature id is invalid.');
    assert(reference(conversationId), 'FEATURE_STATE_INVALID_SCOPE', 'Conversation id is invalid.');

    return Object.freeze({
      get(key: string, fallback: JsonValue = null): JsonValue {
        assert(reference(key), 'FEATURE_STATE_INVALID_KEY', 'State key is invalid.');
        const record = store.read(STATE_NAMESPACE, stateRecordKey(featureId, conversationId, key));
        if (!record) return fallback;
        const entry = parseEntry(record);
        assert(entry.featureId === featureId && entry.conversationId === conversationId && entry.key === key,
          'FEATURE_STATE_INVALID_VALUE', 'Stored feature state data is invalid.');
        return entry.value;
      },
      set(key: string, value: JsonValue): JsonValue {
        assert(reference(key), 'FEATURE_STATE_INVALID_KEY', 'State key is invalid.');
        const detached = safeValue(value);
        const recordKey = stateRecordKey(featureId, conversationId, key);
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          const current = store.read(STATE_NAMESPACE, recordKey);
          if (current) parseEntry(current);
          try {
            const written = store.write(STATE_NAMESPACE, recordKey, stateValue({
              featureId,
              conversationId,
              key,
              value: detached
            }), { expectedRevision: current?.revision ?? null });
            return parseEntry(written).value;
          } catch (error: unknown) {
            if (!conflict(error)) throw error;
          }
        }
        throw new FrameworkError('FEATURE_STATE_CONFLICT', 'Feature state changed concurrently.');
      },
      delete(key: string): boolean {
        assert(reference(key), 'FEATURE_STATE_INVALID_KEY', 'State key is invalid.');
        const recordKey = stateRecordKey(featureId, conversationId, key);
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          const current = store.read(STATE_NAMESPACE, recordKey);
          if (!current) return false;
          parseEntry(current);
          if (store.delete(STATE_NAMESPACE, recordKey, current.revision)) return true;
        }
        throw new FrameworkError('FEATURE_STATE_CONFLICT', 'Feature state changed concurrently.');
      }
    });
  }

  function describe(): FeatureStateDescription {
    const counts = new Map<string, { featureId: string; conversationId: string; entries: number }>();
    let after: string | undefined;
    do {
      const page = store.list(STATE_NAMESPACE, {
        limit: PAGE_SIZE,
        ...(after === undefined ? {} : { after })
      });
      for (const record of page) {
        const entry = parseEntry(record);
        const identity = JSON.stringify([entry.featureId, entry.conversationId]);
        const current = counts.get(identity);
        if (current) current.entries += 1;
        else counts.set(identity, {
          featureId: entry.featureId,
          conversationId: entry.conversationId,
          entries: 1
        });
      }
      after = page.at(-1)?.key;
      if (page.length < PAGE_SIZE) break;
    } while (after !== undefined);
    const namespaces = [...counts.values()].sort((left, right) =>
      left.featureId.localeCompare(right.featureId)
      || left.conversationId.localeCompare(right.conversationId));
    return snapshot({ namespaces });
  }

  return Object.freeze({ scope, describe });
}
