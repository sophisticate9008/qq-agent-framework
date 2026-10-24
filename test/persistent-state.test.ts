import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { createFeatureState } from '../src/core/context.ts';
import type { JsonObject, JsonValue } from '../src/core/types.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createPersistentFeatureState } from '../src/storage/state.ts';

type FeatureState = ReturnType<typeof createFeatureState>;

function temporaryDatabase(): { directory: string; filename: string } {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-state-'));
  return { directory, filename: join(directory, 'state.sqlite') };
}

function objectValue(value: JsonValue): JsonObject {
  assert.notEqual(value, null);
  assert.equal(typeof value, 'object');
  assert.equal(Array.isArray(value), false);
  return value as JsonObject;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

test('feature state persists frozen values while keeping scopes isolated', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const firstStore = createSqliteStore({ filename: temporary.filename });
  const firstState: FeatureState = createPersistentFeatureState({ store: firstStore });
  const primary = firstState.scope('conversation', 'conversation-a');
  const otherFeature = firstState.scope('reminder', 'conversation-a');
  const otherConversation = firstState.scope('conversation', 'conversation-b');
  assert.equal(primary.get('missing'), null);
  assert.equal(primary.get('missing', 'fallback'), 'fallback');
  assert.deepEqual(firstState.describe(), { namespaces: [] });

  const mutable = { count: 1, nested: { status: 'stored' } };
  const stored = objectValue(primary.set('progress', mutable));
  mutable.count = 2;
  mutable.nested.status = 'mutated';
  assert.deepEqual(stored, { count: 1, nested: { status: 'stored' } });
  assert(Object.isFrozen(stored));
  assert(Object.isFrozen(objectValue(stored.nested)));
  assert.equal(otherFeature.get('progress'), null);
  assert.equal(otherConversation.get('progress'), null);
  otherFeature.set('private', 'hidden-value');
  firstStore.close();

  const reopenedStore = createSqliteStore({ filename: temporary.filename });
  context.after(() => reopenedStore.close());
  const reopened = createPersistentFeatureState({ store: reopenedStore });
  assert.deepEqual(reopened.scope('conversation', 'conversation-a').get('progress'), {
    count: 1,
    nested: { status: 'stored' }
  });
  const description = reopened.describe();
  assert.deepEqual(description, {
    namespaces: [
      { featureId: 'conversation', conversationId: 'conversation-a', entries: 1 },
      { featureId: 'reminder', conversationId: 'conversation-a', entries: 1 }
    ]
  });
  assert(Object.isFrozen(description));
  assert.equal(JSON.stringify(description).includes('hidden-value'), false);
  const reopenedPrimary = reopened.scope('conversation', 'conversation-a');
  assert.equal(reopenedPrimary.delete('progress'), true);
  assert.equal(reopenedPrimary.delete('progress'), false);
  assert.deepEqual(reopened.describe(), {
    namespaces: [{ featureId: 'reminder', conversationId: 'conversation-a', entries: 1 }]
  });
});

test('prototype-shaped keys and values remain isolated and invalid writes preserve data', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  context.after(() => store.close());
  const state = createPersistentFeatureState({ store });
  const scoped = state.scope('constructor', '__proto__');
  const parsed = JSON.parse(
    '{"__proto__":{"polluted":"state"},"constructor":{"prototype":{"polluted":"state"}}}'
  ) as JsonValue;
  const shaped = objectValue(parsed);
  scoped.set('__proto__', shaped);
  scoped.set('constructor', { safe: true });
  objectValue(shaped['__proto__']).polluted = 'mutated';

  assert.equal(objectValue(objectValue(scoped.get('__proto__'))['__proto__']).polluted, 'state');
  assert.deepEqual(scoped.get('constructor'), { safe: true });
  assert.equal((Object.prototype as { polluted?: unknown }).polluted, undefined);
  const invalid = { value: () => 'not-json' } as unknown as JsonValue;
  assert.throws(() => scoped.set('constructor', invalid),
    (error: unknown) => hasCode(error, 'FEATURE_STATE_INVALID_VALUE'));
  assert.deepEqual(scoped.get('constructor'), { safe: true });
  assert.deepEqual(state.describe(), {
    namespaces: [{ featureId: 'constructor', conversationId: '__proto__', entries: 2 }]
  });
});

test('scope and missing reads never allocate durable namespaces', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename, maxRecords: 1 });
  context.after(() => store.close());
  const state = createPersistentFeatureState({ store });
  for (let index = 0; index < 100; index += 1) {
    const scoped = state.scope('conversation', `conversation-${index}`);
    assert.equal(scoped.get('missing'), null);
  }
  assert.deepEqual(state.describe(), { namespaces: [] });
  state.scope('conversation', 'conversation-a').set('present', true);
  assert.deepEqual(state.describe(), {
    namespaces: [{ featureId: 'conversation', conversationId: 'conversation-a', entries: 1 }]
  });
});
