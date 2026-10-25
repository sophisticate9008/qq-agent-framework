import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteStore } from '../src/storage/sqlite.ts'

test('CAS batches update state and journal atomically, reject stale read sets, and preserve revisions across reopen', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'storage-cas-batch-')); context.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'state.sqlite')
  let store = createSqliteStore({ filename })
  context.after(() => store.close())
  const first = store.write('state', 'entry', { schema: 1, value: 'old' })
  const journal = store.write('journal', 'migration', { schema: 1, phase: 'prepared' })
  assert.throws(() => store.compareAndSetBatch!([
    { kind: 'write', namespace: 'state', key: 'entry', expectedRevision: first.revision, value: { schema: 2, value: 'new' } },
    { kind: 'write', namespace: 'journal', key: 'migration', expectedRevision: journal.revision + 1, value: { schema: 1, phase: 'complete' } }
  ]), { code: 'STORE_CONFLICT' })
  assert.deepEqual(store.read('state', 'entry')?.value, first.value)
  assert.deepEqual(store.read('journal', 'migration')?.value, journal.value)
  const committed = store.compareAndSetBatch!([
    { kind: 'write', namespace: 'state', key: 'entry', expectedRevision: first.revision, value: { schema: 2, value: 'new' } },
    { kind: 'write', namespace: 'journal', key: 'migration', expectedRevision: journal.revision, value: { schema: 1, phase: 'complete' } },
    { kind: 'check', namespace: 'state', key: 'absent', expectedRevision: null }
  ])
  assert(committed[0] && committed[1]); assert(committed[1].revision > committed[0].revision); assert.equal(committed[2], null)
  store.close(); store = createSqliteStore({ filename })
  assert.deepEqual(store.read('state', 'entry'), committed[0])
  assert.deepEqual(store.read('journal', 'migration'), committed[1])
  store.compareAndSetBatch!([{ kind: 'delete', namespace: 'state', key: 'entry', expectedRevision: committed[0].revision }])
  const after = store.compareAndSetBatch!([{ kind: 'write', namespace: 'state', key: 'entry', expectedRevision: null, value: 'replacement' }])[0]!
  assert(after.revision > committed[1].revision)
  assert.throws(() => store.compareAndSetBatch!([{ kind: 'check', namespace: 'state', key: 'entry', expectedRevision: first.revision }]), { code: 'STORE_CONFLICT' })
})

test('a late unique-index failure rolls the entire batch back, including its journal and global revision', () => {
  const store = createSqliteStore({ filename: ':memory:' })
  try {
    store.createIndex!({ namespace: 'sessions', field: 'sessionId', unique: true })
    const first = store.write('sessions', 'first', { sessionId: 'occupied' })
    const journal = store.write('journal', 'migration', { phase: 'prepared' })
    assert.throws(() => store.compareAndSetBatch!([
      { kind: 'write', namespace: 'journal', key: 'migration', expectedRevision: journal.revision, value: { phase: 'complete' } },
      { kind: 'write', namespace: 'sessions', key: 'second', expectedRevision: null, value: { sessionId: 'occupied' } }
    ]))
    assert.deepEqual(store.read('sessions', 'first'), first)
    assert.equal(store.read('sessions', 'second'), null)
    assert.deepEqual(store.read('journal', 'migration'), journal)
    assert.equal(store.write('other', 'test', {}).revision, journal.revision + 1)
  } finally { store.close() }
})

test('CAS batch bounds, duplicate keys, capacity and expiry checks cannot partially modify data', () => {
  let now = 100
  const store = createSqliteStore({ filename: ':memory:', maxRecords: 1, clock: () => now })
  try {
    const first = store.write('state', 'first', {}, { expiresAt: 101 })
    assert.throws(() => store.compareAndSetBatch!([]), { code: 'STORE_INVALID_ARGUMENT' })
    assert.throws(() => store.compareAndSetBatch!([
      { kind: 'check', namespace: 'state', key: 'first', expectedRevision: first.revision },
      { kind: 'delete', namespace: 'state', key: 'first', expectedRevision: first.revision }
    ]), { code: 'STORE_INVALID_ARGUMENT' })
    assert.throws(() => store.compareAndSetBatch!([
      { kind: 'write', namespace: 'state', key: 'first', expectedRevision: first.revision, value: 'changed' },
      { kind: 'write', namespace: 'state', key: 'second', expectedRevision: null, value: {} }
    ]), { code: 'STORE_CAPACITY_EXCEEDED' })
    assert.deepEqual(store.read('state', 'first'), first)
    const replaced = store.compareAndSetBatch!([
      { kind: 'delete', namespace: 'state', key: 'first', expectedRevision: first.revision },
      { kind: 'write', namespace: 'state', key: 'second', expectedRevision: null, value: {}, expiresAt: 101 }
    ])[1]!
    now = 102
    assert.equal(store.compareAndSetBatch!([{ kind: 'check', namespace: 'state', key: 'second', expectedRevision: null }])[0], null)
    assert.throws(() => store.compareAndSetBatch!([{ kind: 'check', namespace: 'state', key: 'second', expectedRevision: replaced.revision }]), { code: 'STORE_CONFLICT' })
    assert.equal(store.stats!().totalRecords, 1)
  } finally { store.close() }
})
