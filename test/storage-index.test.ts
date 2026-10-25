import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqliteStore } from '../src/storage/sqlite.ts';

test('restricted JSON indexes enforce unique CAS writes and track transitions in the same authoritative row', context => {
  const store = createSqliteStore({ filename: ':memory:' });
  context.after(() => store.close());
  const index = { namespace: 'bindings', field: 'sessionId', unique: true, where: { field: 'state', equals: 'ready' } } as const;
  store.createIndex(index);
  const first = store.write('bindings', 'one', { sessionId: 'external', state: 'ready', generation: 1 });
  const query = { namespace: 'bindings', field: 'sessionId', equals: 'external', where: index.where };
  assert.deepEqual(store.lookup(query), [first]);
  assert.throws(() => store.write('bindings', 'two', { sessionId: 'external', state: 'ready', generation: 1 }), { code: 'STORE_IO_ERROR' });
  assert.equal(store.read('bindings', 'two'), null);
  assert.throws(() => store.write('bindings', 'one', { sessionId: 'next', state: 'ready', generation: 2 },
    { expectedRevision: first.revision + 1 }), { code: 'STORE_CONFLICT' });
  assert.deepEqual(store.lookup(query), [first]);
  store.write('bindings', 'one', { sessionId: null, state: 'retired', generation: 2 }, { expectedRevision: first.revision });
  assert.deepEqual(store.lookup(query), []);
  const second = store.write('bindings', 'two', { sessionId: 'external', state: 'ready', generation: 2 });
  assert.deepEqual(store.lookup(query), [second]);
});

test('index ports reject SQL-like fields, unknown lookups and unbounded result requests', context => {
  const store = createSqliteStore({ filename: ':memory:' });
  context.after(() => store.close());
  for (const field of ['sessionId.value', "id'); DROP TABLE durable_records; --", 'value[0]', '']) {
    assert.throws(() => store.createIndex({ namespace: 'bindings', field }), { code: 'STORE_INVALID_INDEX' });
  }
  assert.throws(() => store.lookup({ namespace: 'bindings', field: 'sessionId', equals: 'one' }), { code: 'STORE_INDEX_UNAVAILABLE' });
  const namespace = "quoted'namespace";
  store.createIndex({ namespace, field: 'id' });
  const record = store.write(namespace, 'one', { id: 'safe' });
  assert.deepEqual(store.lookup({ namespace, field: 'id', equals: 'safe' }), [record]);
  assert.throws(() => store.lookup({ namespace, field: 'id', equals: 'safe', limit: 2000 }), { code: 'STORE_INVALID_INDEX' });
});
