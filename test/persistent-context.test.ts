import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { createContextStore } from '../src/core/context.ts';
import type { JsonValue } from '../src/core/types.ts';
import { FrameworkError } from '../src/core/values.ts';
import type { DurableStore, WriteOptions } from '../src/host/types.ts';
import { createPersistentContextStore } from '../src/storage/context.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

type ContextStore = ReturnType<typeof createContextStore>;

function temporaryDatabase(): { directory: string; filename: string } {
  const directory = mkdtempSync(join(tmpdir(), 'qq-bridge-framework-context-'));
  return { directory, filename: join(directory, 'context.sqlite') };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function registerPersona(context: ContextStore): string {
  return context.registerPersona({
    id: 'snow',
    version: '1.0.0',
    name: 'Snow',
    identity: { role: 'assistant' },
    style: { tone: 'warm' }
  });
}

test('personas, configuration and preference precedence survive reopen', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  let now = 100;
  const firstStore = createSqliteStore({ filename: temporary.filename });
  const first: ContextStore = createPersistentContextStore({ store: firstStore, clock: () => now });
  const persona = registerPersona(first);
  first.setConfiguration({
    scope: { kind: 'global' },
    values: { mode: 'global' },
    source: 'operator'
  });
  first.setConfiguration({
    scope: { kind: 'conversation', id: 'room:one' },
    values: { mode: 'conversation' },
    source: 'migration'
  });
  first.setPreferences({
    id: 'first',
    scope: { kind: 'conversation', id: 'room:one' },
    values: { tone: 'first', authorized: true },
    source: 'operator'
  });
  first.setPreferences({
    id: 'second',
    scope: { kind: 'conversation', id: 'room:one' },
    values: { tone: 'second' },
    source: 'confirmed-user'
  });
  first.setPreferences({
    id: 'first',
    scope: { kind: 'conversation', id: 'room:one' },
    values: { tone: 'updated', authorized: true },
    source: 'operator'
  });
  const temporaryValues = { tone: 'temporary' };
  first.setPreferences({
    id: 'temporary',
    scope: { kind: 'conversation', id: 'room:one' },
    values: temporaryValues,
    source: 'confirmed-user',
    expiresAt: 200
  });
  temporaryValues.tone = 'mutated';
  assert.equal(first.resolve({ persona, conversationId: 'room:one' }).preferences.tone, 'temporary');
  firstStore.close();

  const reopenedStore = createSqliteStore({ filename: temporary.filename });
  context.after(() => reopenedStore.close());
  const reopened = createPersistentContextStore({ store: reopenedStore, clock: () => now });
  const active = reopened.resolve({ persona, conversationId: 'room:one' });
  assert.equal(active.configuration.mode, 'conversation');
  assert.equal(active.preferences.tone, 'temporary');
  assert.equal(active.preferences.authorized, true);
  assert.equal('permissions' in active, false);
  assert(Object.isFrozen(active));
  assert.deepEqual(reopened.describe().preferences.map((entry) => entry.id), [
    'first', 'second', 'temporary'
  ]);
  now = 200;
  const expired = reopened.resolve({ persona, conversationId: 'room:one' });
  assert.equal(expired.preferences.tone, 'updated');
  assert.equal(reopened.describe().preferences.find((entry) => entry.id === 'temporary')?.active, false);
  assert.equal(reopened.removePreferences('temporary'), true);
  reopenedStore.close();

  const thirdStore = createSqliteStore({ filename: temporary.filename });
  context.after(() => thirdStore.close());
  const third = createPersistentContextStore({ store: thirdStore, clock: () => now });
  assert.deepEqual(third.describe().preferences.map((entry) => entry.id), ['first', 'second']);
  assert.equal(third.resolve({ persona, conversationId: 'room:one' }).preferences.tone, 'updated');
  assert.equal(thirdStore.list('context.personas').length, 1);
  assert.equal(thirdStore.list('context.configurations').length, 2);
  assert.equal(thirdStore.list('context.preferences').length, 2);
});

test('database failures and schema rejection leave the active memory snapshot unchanged', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const baseStore = createSqliteStore({ filename: temporary.filename });
  context.after(() => baseStore.close());
  let failWrite = false;
  let failDelete = false;
  const failingStore: DurableStore = {
    read(namespace: string, key: string) {
      return baseStore.read(namespace, key);
    },
    write(namespace: string, key: string, value: JsonValue, options?: WriteOptions) {
      if (failWrite) {
        failWrite = false;
        throw new FrameworkError('STORE_IO_ERROR', 'Injected durable failure.');
      }
      return baseStore.write(namespace, key, value, options);
    },
    delete(namespace: string, key: string, expectedRevision?: number) {
      if (failDelete) {
        failDelete = false;
        throw new FrameworkError('STORE_IO_ERROR', 'Injected durable failure.');
      }
      return baseStore.delete(namespace, key, expectedRevision);
    },
    list(namespace: string, options?: { limit?: number; after?: string }) {
      return baseStore.list(namespace, options);
    },
    purgeExpired(limit?: number) {
      return baseStore.purgeExpired(limit);
    },
    close() {
      baseStore.close();
    }
  };
  const persistent = createPersistentContextStore({ store: failingStore });
  failWrite = true;
  assert.throws(() => registerPersona(persistent), (error: unknown) => hasCode(error, 'STORE_IO_ERROR'));
  assert.deepEqual(persistent.describe().personas, []);
  const persona = registerPersona(persistent);
  persistent.setConfiguration({
    scope: { kind: 'conversation', id: 'room:one' },
    values: { mode: 'old' },
    source: 'operator'
  });
  failWrite = true;
  assert.throws(() => persistent.setConfiguration({
    scope: { kind: 'conversation', id: 'room:one' },
    values: { mode: 'new' },
    source: 'operator'
  }), (error: unknown) => hasCode(error, 'STORE_IO_ERROR'));
  assert.equal(persistent.resolve({ persona, conversationId: 'room:one' }).configuration.mode, 'old');
  persistent.setPreferences({
    id: 'preference',
    scope: { kind: 'conversation', id: 'room:one' },
    values: { tone: 'old' },
    source: 'operator'
  });
  failWrite = true;
  assert.throws(() => persistent.setPreferences({
    id: 'preference',
    scope: { kind: 'conversation', id: 'room:one' },
    values: { tone: 'new' },
    source: 'operator'
  }), (error: unknown) => hasCode(error, 'STORE_IO_ERROR'));
  assert.equal(persistent.resolve({ persona, conversationId: 'room:one' }).preferences.tone, 'old');
  failDelete = true;
  assert.throws(() => persistent.removePreferences('preference'),
    (error: unknown) => hasCode(error, 'STORE_IO_ERROR'));
  assert.equal(persistent.resolve({ persona, conversationId: 'room:one' }).preferences.tone, 'old');
  assert.throws(() => persistent.setPreferences({
    id: 'preference',
    scope: { kind: 'user', id: 'user:other' },
    values: { tone: 'invalid-scope-change' },
    source: 'operator'
  }), (error: unknown) => hasCode(error, 'CONTEXT_PREFERENCE_SCOPE_MISMATCH'));
  assert.equal(persistent.resolve({ persona, conversationId: 'room:one' }).preferences.tone, 'old');
});

test('stale writers receive CONTEXT_CONFLICT and reload explicitly refreshes the mirror', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const firstStore = createSqliteStore({ filename: temporary.filename });
  const secondStore = createSqliteStore({ filename: temporary.filename });
  context.after(() => firstStore.close());
  context.after(() => secondStore.close());
  const first = createPersistentContextStore({ store: firstStore });
  const second = createPersistentContextStore({ store: secondStore });
  const persona = registerPersona(first);
  assert.throws(() => registerPersona(second),
    (error: unknown) => hasCode(error, 'CONTEXT_CONFLICT'));
  assert.deepEqual(second.describe().personas, []);
  second.reload();
  assert.equal(second.describe().personas[0]?.key, persona);

  first.setConfiguration({
    scope: { kind: 'conversation', id: 'room:one' },
    values: { mode: 'from-first' },
    source: 'operator'
  });
  assert.throws(() => second.setConfiguration({
    scope: { kind: 'conversation', id: 'room:one' },
    values: { mode: 'from-second' },
    source: 'operator'
  }), (error: unknown) => hasCode(error, 'CONTEXT_CONFLICT'));
  assert.deepEqual(second.resolve({ persona, conversationId: 'room:one' }).configuration, {});
  second.reload();
  assert.equal(second.resolve({ persona, conversationId: 'room:one' }).configuration.mode, 'from-first');

  first.setPreferences({
    id: 'shared-preference',
    scope: { kind: 'conversation', id: 'room:one' },
    values: { tone: 'first' },
    source: 'operator'
  });
  assert.throws(() => second.removePreferences('shared-preference'),
    (error: unknown) => hasCode(error, 'CONTEXT_CONFLICT'));
  second.reload();
  assert.equal(second.resolve({ persona, conversationId: 'room:one' }).preferences.tone, 'first');
});

test('resolve uses the loaded mirror without durable scans', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const baseStore = createSqliteStore({ filename: temporary.filename });
  context.after(() => baseStore.close());
  let reads = 0;
  let lists = 0;
  const countedStore: DurableStore = {
    read(namespace: string, key: string) {
      reads += 1;
      return baseStore.read(namespace, key);
    },
    write(namespace: string, key: string, value: JsonValue, options?: WriteOptions) {
      return baseStore.write(namespace, key, value, options);
    },
    delete(namespace: string, key: string, expectedRevision?: number) {
      return baseStore.delete(namespace, key, expectedRevision);
    },
    list(namespace: string, options?: { limit?: number; after?: string }) {
      lists += 1;
      return baseStore.list(namespace, options);
    },
    purgeExpired(limit?: number) {
      return baseStore.purgeExpired(limit);
    },
    close() {
      baseStore.close();
    }
  };
  const persistent = createPersistentContextStore({ store: countedStore });
  const persona = registerPersona(persistent);
  reads = 0;
  lists = 0;
  for (let index = 0; index < 100; index += 1) {
    assert.equal(persistent.resolve({ persona, conversationId: `room:${index}` }).persona.name, 'Snow');
  }
  assert.equal(reads, 0);
  assert.equal(lists, 0);
});

test('reload rejects stored records that bypass the core schema', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  context.after(() => store.close());
  store.write('context.preferences', 'invalid', {
    schema: 1,
    kind: 'preference',
    descriptionOrder: 1,
    precedenceOrder: 1,
    id: 'invalid',
    scope: { kind: 'unsupported' },
    values: { authorized: true },
    source: 'operator',
    expiresAt: null
  }, { expectedRevision: null });
  assert.throws(() => createPersistentContextStore({ store }),
    (error: unknown) => hasCode(error, 'INVALID_STORED_DATA'));
});
