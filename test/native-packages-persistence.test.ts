import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativePackages, type NativePackageContext, type NativePackageDefinition } from '../src/host/native-packages.ts'
import { createPackageConfigurationRegistry } from '../src/host/package-configuration.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { FrameworkError, isRecord } from '../src/core/values.ts'

const signal = new AbortController().signal
function registry() { return createPackageConfigurationRegistry({ store: { async read() { throw new Error('unexpected read') }, async compareAndSet() { throw new Error('unexpected write') } } }) }
async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'native-packages-persist-')); context.after(() => rm(directory, { recursive: true, force: true }))
  let store = createSqliteStore({ filename: join(directory, 'state.sqlite') }); context.after(() => store.close())
  const source = join(directory, 'package.ts')
  const definition = async (version: string, schemaVersion: number): Promise<NativePackageDefinition> => {
    await writeFile(source, `export const version = '${version}'`, { mode: 0o600 })
    const fingerprint = createHash('sha256').update(await readFile(source)).digest('hex')
    return { manifest: { schema: 1, id: 'external', version, stateSchemaVersion: schemaVersion, dependencies: [], provides: [], requires: [], contributions: [] },
      content: { identity: { fingerprint, coverage: 'package-tree-and-dependency-locks-v1', files: 1 }, async verify() {
        if (createHash('sha256').update(await readFile(source)).digest('hex') !== fingerprint) throw new FrameworkError('NATIVE_PACKAGE_CONTENT_CHANGED', 'The package bytes changed')
      } } }
  }
  return { definition, store: () => store, reopen() { store.close(); store = createSqliteStore({ filename: join(directory, 'state.sqlite') }) },
    manager(packages: readonly NativePackageDefinition[], timeoutMs = 1000) { return createNativePackages({ packages, stateStore: store, configurationRegistry: registry(), timeoutMs }) } }
}

test('persistent package manager exposes owned schema state and preserves stable keys across content and schema upgrades', async context => {
  const f = await fixture(context)
  let captured: NativePackageContext | undefined
  let definition = await f.definition('1.0.0', 1)
  let manager = f.manager([{ ...definition, install(context) { captured = context } }])
  assert.equal((await manager.start())[0]?.state, 'running'); assert(captured?.state)
  await captured.state.compareAndSet('counter', null, { count: 1 }, signal)
  assert.throws(() => captured!.namespace('other.state'), { code: 'NATIVE_PACKAGE_NAMESPACE_INVALID' })
  const stale = captured.state
  await assert.rejects(stale.prepare(stale.status().revision!, signal), { code: 'NATIVE_PACKAGE_STATE_MIGRATION_DENIED' })
  await manager.stop()
  assert.throws(() => stale.read('counter'))
  await assert.rejects(stale.compareAndSet('late', null, { count: 99 }, signal))
  assert.equal(f.store().read('package.external.state', 'late'), null)
  f.reopen()
  definition = await f.definition('1.0.1', 1)
  manager = f.manager([{ ...definition, install(context) { captured = context } }])
  assert.equal((await manager.start())[0]?.state, 'running'); assert(captured?.state)
  assert.deepEqual(captured.state.read('counter')?.value, { count: 1 })
  await manager.stop(); f.reopen()
  definition = await f.definition('2.0.0', 2)
  manager = f.manager([{ ...definition, async migrate(context) {
    assert(context.state)
    let current = context.state.status()
    while (current.migration) current = await context.state.applyPage(current.revision!, current.migration.operationId, entries => entries.map(entry => {
      assert(isRecord(entry.value) && typeof entry.value.count === 'number')
      return { key: entry.key, value: { count: entry.value.count + 1 } }
    }), context.signal)
  }, install(context) { captured = context } }])
  assert.equal((await manager.start())[0]?.state, 'running'); assert(captured?.state)
  assert.deepEqual(captured.state.read('counter')?.value, { count: 2 })
  assert.equal(captured.state.read('counter')?.stateSchemaVersion, 2)
  assert.equal(f.store().list('package.external.state').length, 1)
  await manager.stop()
})

test('a persisted unfinished package hook blocks restart and requires verified reconciliation without replay', async context => {
  const f = await fixture(context)
  const definition = await f.definition('1.0.0', 1)
  let calls = 0
  let release: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { release = resolve })
  let manager = f.manager([{ ...definition, async start() { calls++; await waiting } }], 20)
  assert.equal((await manager.start())[0]?.state, 'unknown')
  const evidence = manager.lifecycleEvidence('external'); assert(evidence)
  await assert.rejects(manager.reconcileLifecycle('external', evidence.revision, async () => ({ verified: true, evidence: 'not-sufficient-while-running' }), signal), { code: 'NATIVE_PACKAGE_LIFECYCLE_PENDING' })
  release!(); await new Promise<void>(resolve => setImmediate(resolve))
  f.reopen()
  manager = f.manager([{ ...definition, start() { calls++ } }])
  const restored = await manager.start()
  assert.equal(restored[0]?.state, 'unknown'); assert.equal(calls, 1)
  const pending = manager.lifecycleEvidence('external'); assert(pending)
  await assert.rejects(manager.reconcileLifecycle('external', pending.revision, async () => ({ verified: false, evidence: 'missing' }), signal), { code: 'NATIVE_PACKAGE_LIFECYCLE_RECONCILIATION_UNVERIFIED' })
  await manager.reconcileLifecycle('external', pending.revision, async actual => {
    assert.equal(actual.phase, 'start'); return { verified: true, evidence: 'actual-process-local-resources-ended' }
  }, signal)
  manager = f.manager([{ ...definition, start() { calls++ } }])
  assert.equal((await manager.start())[0]?.state, 'running'); assert.equal(calls, 2)
  await manager.stop()
})

test('unclaimed legacy state is preserved and missing verified content cannot be declared ready', async context => {
  const f = await fixture(context)
  const definition = await f.definition('1.0.0', 1)
  f.store().write('package.external.state', 'legacy', { kept: true })
  const manager = f.manager([definition])
  assert.equal((await manager.start())[0]?.reason, 'PACKAGE_STATE_ADOPTION_REQUIRED')
  assert.deepEqual(f.store().read('package.external.state', 'legacy')?.value, { kept: true })
  const { content: _content, ...unknown } = definition
  assert.throws(() => f.manager([unknown]), { code: 'NATIVE_PACKAGE_CONTENT_IDENTITY_REQUIRED' })
})

test('lifecycle reconciliation has an independent bounded deadline and late readonly proof cannot clear unknown', async context => {
  const f = await fixture(context)
  const definition = await f.definition('1.0.0', 1)
  const manager = f.manager([{ ...definition, start() { throw new FrameworkError('EXTERNAL_ACTION_UNKNOWN', 'Unresolved startup evidence') } }], 20)
  assert.equal((await manager.start())[0]?.state, 'unknown')
  const before = manager.lifecycleEvidence('external'); assert(before)
  let verifyCalls = 0
  let finish: ((value: { verified: boolean; evidence: string }) => void) | undefined
  let verificationSignal: AbortSignal | undefined
  await assert.rejects(manager.reconcileLifecycle('external', before.revision, (_actual, current) => {
    verifyCalls++; verificationSignal = current
    return new Promise(resolve => { finish = resolve })
  }, signal), { code: 'NATIVE_PACKAGE_LIFECYCLE_RECONCILIATION_TIMEOUT_UNKNOWN' })
  assert.equal(verificationSignal?.aborted, true)
  assert.deepEqual(manager.lifecycleEvidence('external'), before)
  finish!({ verified: true, evidence: 'late-readonly-proof' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(verifyCalls, 1)
  assert.deepEqual(manager.lifecycleEvidence('external'), before, 'late proof must not commit after its deadline')
  await manager.reconcileLifecycle('external', before.revision, async () => ({ verified: true, evidence: 'explicit-fresh-proof' }), signal)
  assert.equal(manager.lifecycleEvidence('external')?.state, 'completed', 'fresh verification works even after package lifetime was aborted')
})
