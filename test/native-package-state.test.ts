import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativePackageState } from '../src/host/native-package-state.ts'
import type { NativePackageStateIdentity } from '../src/contracts/native-package-state.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { FrameworkError, isRecord } from '../src/core/values.ts'

const signal = new AbortController().signal
async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'native-package-state-')); context.after(() => rm(directory, { recursive: true, force: true }))
  const contentFile = join(directory, 'package.ts')
  await writeFile(contentFile, 'export const schema = 1', { mode: 0o600 })
  let store = createSqliteStore({ filename: join(directory, 'state.sqlite') })
  context.after(() => store.close())
  const fingerprint = async () => createHash('sha256').update(await readFile(contentFile)).digest('hex')
  const first: NativePackageStateIdentity = { packageVersion: '1.0.0', stateSchemaVersion: 1, contentFingerprint: await fingerprint() }
  const second = async (): Promise<NativePackageStateIdentity> => {
    await writeFile(contentFile, 'export const schema = 2', { mode: 0o600 })
    return { packageVersion: '2.0.0', stateSchemaVersion: 2, contentFingerprint: await fingerprint() }
  }
  const service = (identity: NativePackageStateIdentity, options: { timeoutMs?: number; owner?: string } = {}) => createNativePackageState({
    store, owner: options.owner ?? 'external', identity, timeoutMs: options.timeoutMs,
    async verifyIdentity(expected) { if (await fingerprint() !== expected.contentFingerprint) throw new FrameworkError('PACKAGE_CONTENT_CHANGED', 'The declared package bytes changed') } })
  return { directory, first, second, service, fingerprint, contentFile, store: () => store,
    reopen() { store.close(); store = createSqliteStore({ filename: join(directory, 'state.sqlite') }) } }
}

test('schema migration keeps stable keys and CAS-checkpoints bounded pages atomically across actual SQLite reopen', async context => {
  const f = await fixture(context)
  const old = f.service(f.first)
  assert.equal(old.status().revision, null)
  await old.initialize(signal)
  for (let index = 0; index < 65; index++) await old.compareAndSet(String(index).padStart(3, '0'), null, { count: index }, signal)
  const newer = await f.second()
  let service = f.service(newer)
  const prepared = await service.prepare(old.status().revision!, signal)
  assert(prepared.migration)
  assert.throws(() => old.read('000'), { code: 'PACKAGE_STATE_MIGRATION_REQUIRED' })
  let transformations = 0
  const transform = (entries: readonly { key: string; value: unknown }[]) => entries.map(entry => {
    transformations++; assert(isRecord(entry.value) && typeof entry.value.count === 'number')
    return { key: entry.key, value: { count: entry.value.count + 1 } }
  })
  const firstPage = await service.applyPage(prepared.revision!, prepared.migration.operationId, transform, signal)
  assert.equal(transformations, 60); assert.equal(firstPage.ready, false); assert.equal(firstPage.migration?.cursor, '059')
  f.reopen(); service = f.service(newer)
  assert.equal(service.status().migration?.phase, 'prepared')
  assert.equal(transformations, 60)
  const complete = await service.applyPage(firstPage.revision!, prepared.migration.operationId, transform, signal)
  assert.equal(complete.ready, true); assert.equal(complete.migration, null); assert.equal(transformations, 65)
  assert.deepEqual(service.read('000')?.value, { count: 1 }); assert.deepEqual(service.read('064')?.value, { count: 65 })
  assert.equal(service.read('064')?.stateSchemaVersion, 2)
  assert.equal(f.store().list('package.external.state', { limit: 100 }).length, 65)
})

test('interrupted migration is persistent unknown, never replays on reopen, and explicit readonly reconciliation verifies unchanged source', async context => {
  const f = await fixture(context)
  const old = f.service(f.first); await old.initialize(signal); await old.compareAndSet('entry', null, { count: 1 }, signal)
  const newer = await f.second()
  let service = f.service(newer, { timeoutMs: 20 })
  const prepared = await service.prepare(old.status().revision!, signal); assert(prepared.migration)
  const original = f.store().read('package.external.state', 'entry')
  let release: (() => void) | undefined
  const wait = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  await assert.rejects(service.applyPage(prepared.revision!, prepared.migration.operationId, async entries => {
    calls++; await wait; return entries.map(entry => ({ key: entry.key, value: { count: 2 } }))
  }, signal), { code: 'PACKAGE_STATE_MIGRATION_TIMEOUT_UNKNOWN' })
  const unknown = service.status(); assert.equal(unknown.migration?.phase, 'unknown')
  f.reopen(); service = f.service(newer)
  await assert.rejects(service.initialize(signal), { code: 'PACKAGE_STATE_MIGRATION_REQUIRED' })
  await assert.rejects(service.applyPage(unknown.revision!, prepared.migration.operationId, () => { calls++; return [] }, signal), { code: 'PACKAGE_STATE_RECONCILIATION_REQUIRED' })
  release!(); await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(f.store().read('package.external.state', 'entry'), original)
  assert.equal(calls, 1)
  const reconciled = await service.reconcile(unknown.revision!, prepared.migration.operationId, signal)
  assert.equal(calls, 1); assert.equal(reconciled.migration?.phase, 'prepared')
  const complete = await service.applyPage(reconciled.revision!, prepared.migration.operationId,
    entries => entries.map(entry => ({ key: entry.key, value: { count: 2 } })), signal)
  assert.equal(complete.ready, true); assert.deepEqual(service.read('entry')?.value, { count: 2 })
})

test('source conflicts preserve the other data and journal unknown; reconciliation cannot hide drift', async context => {
  const f = await fixture(context)
  const old = f.service(f.first); await old.initialize(signal)
  await old.compareAndSet('a', null, 1, signal); await old.compareAndSet('b', null, 2, signal)
  const original = f.store().read('package.external.state', 'b')
  const service = f.service(await f.second())
  const prepared = await service.prepare(old.status().revision!, signal); assert(prepared.migration)
  await assert.rejects(service.applyPage(prepared.revision!, prepared.migration.operationId, entries => {
    const source = f.store().read('package.external.state', 'a')!
    f.store().write(source.namespace, source.key, source.value, { expectedRevision: source.revision })
    return entries.map(entry => ({ key: entry.key, value: 3 }))
  }, signal), { code: 'STORE_CONFLICT' })
  assert.deepEqual(f.store().read('package.external.state', 'b'), original)
  const unknown = service.status(); assert.equal(unknown.migration?.phase, 'unknown')
  await assert.rejects(service.reconcile(unknown.revision!, prepared.migration.operationId, signal), { code: 'PACKAGE_STATE_RECONCILIATION_CONFLICT' })
})

test('content changes, unclaimed legacy data, stale state CAS and owner boundaries fail closed without losing old records', async context => {
  const f = await fixture(context)
  const service = f.service(f.first)
  f.store().write('package.external.state', 'legacy', { historical: 'kept' })
  await assert.rejects(service.initialize(signal), { code: 'PACKAGE_STATE_ADOPTION_REQUIRED' })
  assert.equal(service.status().revision, null)
  assert.deepEqual(f.store().read('package.external.state', 'legacy')?.value, { historical: 'kept' })
  const another = f.service(f.first, { owner: 'another' }); await another.initialize(signal)
  const saved = await another.compareAndSet('same-key', null, { owner: 'another' }, signal)
  await assert.rejects(another.compareAndSet('same-key', null, {}, signal), { code: 'STORE_CONFLICT' })
  assert.deepEqual(another.read('same-key'), saved)
  await writeFile(f.contentFile, 'modified bytes', { mode: 0o600 })
  await assert.rejects(another.compareAndSet('same-key', saved.revision, {}, signal), { code: 'PACKAGE_CONTENT_CHANGED' })
  assert.deepEqual(another.read('same-key'), saved)
  assert.equal(f.store().read('package.external.state', 'same-key'), null)
})

test('explicit raw legacy adoption uses bounded CAS pages, preserves original keys, and never guesses an old schema', async context => {
  const f = await fixture(context)
  for (let index = 0; index < 65; index++) f.store().write('package.external.state', String(index).padStart(3, '0'), { count: index })
  const expiresAt = Date.now() + 60000
  const expiring = f.store().read('package.external.state', '000')!
  f.store().write('package.external.state', '000', expiring.value, { expectedRevision: expiring.revision, expiresAt })
  let service = f.service(f.first)
  await assert.rejects(service.initialize(signal), { code: 'PACKAGE_STATE_ADOPTION_REQUIRED' })
  let state = await service.prepareLegacyAdoption(signal)
  assert.equal(state.ready, false); assert.equal(state.migration?.legacy, true)
  const convert = (entries: Parameters<Parameters<typeof service.applyPage>[2]>[0]) => entries.map(entry => {
    assert.equal(entry.stateSchemaVersion, 0, 'raw source is explicitly unversioned')
    assert(isRecord(entry.value) && typeof entry.value.count === 'number')
    return { key: entry.key, value: { count: entry.value.count, adopted: true } }
  })
  state = await service.applyPage(state.revision!, state.migration!.operationId, convert, signal)
  assert.equal(state.migration?.cursor, '059')
  f.reopen(); service = f.service(f.first); state = service.status()
  await assert.rejects(service.prepareLegacyAdoption(signal), { code: 'PACKAGE_STATE_CONFLICT' })
  state = await service.applyPage(state.revision!, state.migration!.operationId, convert, signal)
  assert.equal(state.ready, true)
  assert.deepEqual(service.read('000')?.value, { count: 0, adopted: true })
  assert.deepEqual(service.read('064')?.value, { count: 64, adopted: true })
  assert.equal(f.store().list('package.external.state', { limit: 100 }).length, 65)
  assert.equal(f.store().read('package.external.state', '000')?.expiresAt, expiresAt)
})
