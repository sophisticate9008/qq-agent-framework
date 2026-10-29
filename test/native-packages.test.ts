import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNativePackages, type NativePackageDefinition } from '../src/host/native-packages.ts'
import { createPackageConfigurationRegistry } from '../src/host/package-configuration.ts'
import { createPackageConfigurationFileStore } from '../src/storage/package-configuration.ts'
import { createChatInputNativePackage, createMediaNativePackage, type NativeChatInputPackageService,
  type NativeMediaPackageService } from '../src/host/default-native-packages.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createNativeMediaRegistry } from '../src/host/native-media.ts'
import { DEFAULT_CHAT_INPUT_CONFIGURATION } from '../src/contracts/chat-input-configuration.ts'
import type { DurableStore } from '../src/contracts/ports.ts'

function definition(id: string, overrides: Partial<NativePackageDefinition> = {}): NativePackageDefinition {
  return { manifest: { schema: 1, id, version: '1.0.0', dependencies: [], provides: [], requires: [], contributions: [] }, ...overrides }
}
function registry() { return createPackageConfigurationRegistry({ store: {
  async read() { throw new Error('No configuration I/O expected') }, async compareAndSet() { throw new Error('No configuration I/O expected') }
} }) }

test('package preflight rejects duplicates, cycles, missing dependencies, service versions and conflicting contributions before side effects', () => {
  let calls = 0
  const base = definition('base', { install() { calls++ } })
  const dependent = (dependencies: readonly string[], version = 1) => definition('dependent', { manifest: {
    ...definition('dependent').manifest, dependencies, requires: [{ id: 'service', version }] } })
  const provider = definition('base', { ...base, manifest: { ...base.manifest, provides: [{ id: 'service', version: 1 }] } })
  const cases: readonly { packages: readonly NativePackageDefinition[]; code: string }[] = [
    { packages: [base, base], code: 'NATIVE_PACKAGE_DUPLICATE' },
    { packages: [dependent(['missing'])], code: 'NATIVE_PACKAGE_DEPENDENCY_MISSING' },
    { packages: [definition('base', { manifest: { ...base.manifest, dependencies: ['dependent'] } }), dependent(['base'])], code: 'NATIVE_PACKAGE_DEPENDENCY_CYCLE' },
    { packages: [provider, dependent(['base'], 2)], code: 'NATIVE_PACKAGE_SERVICE_VERSION_UNAVAILABLE' },
    { packages: [provider, dependent([])], code: 'NATIVE_PACKAGE_SERVICE_DEPENDENCY_REQUIRED' },
    { packages: [definition('other', { manifest: { ...definition('other').manifest, provides: [{ id: 'service', version: 1 }] } }), provider], code: 'NATIVE_PACKAGE_SERVICE_DUPLICATE' },
    { packages: ['one', 'two'].map(id => definition(id, { manifest: { ...definition(id).manifest, contributions: [{ kind: 'effect', id: 'same' }] } })), code: 'NATIVE_PACKAGE_CONTRIBUTION_DUPLICATE' }
  ]
  for (const fixture of cases) assert.throws(() => createNativePackages({ packages: fixture.packages, configurationRegistry: registry() }), { code: fixture.code })
  assert.equal(calls, 0)
})

test('packages use dependency order, declared versioned services and reverse lifecycle resource cleanup exactly once', async () => {
  const events: string[] = []
  const producer = definition('producer', {
    manifest: { ...definition('producer').manifest, provides: [{ id: 'clock', version: 1 }] },
    prepare() { events.push('producer.prepare') }, migrate() { events.push('producer.migrate') },
    install(context) {
      events.push('producer.install')
      context.publish('clock', 1, 42)
      context.own('timer', 'timer', () => { events.push('producer.timer') })
    }, recover() { events.push('producer.recover') }, start() { events.push('producer.start') },
    drain() { events.push('producer.drain') }, dispose() { events.push('producer.dispose') }
  })
  const consumer = definition('consumer', {
    manifest: { ...definition('consumer').manifest, dependencies: ['producer'], requires: [{ id: 'clock', version: 1 }],
      contributions: [{ kind: 'feature', id: 'consumer.feature' }] },
    install(context) {
      events.push('consumer.install')
      assert.equal(context.service('clock', 1), 42)
      assert.throws(() => context.service('clock', 2), { code: 'NATIVE_PACKAGE_SERVICE_UNDECLARED' })
      context.contribute('feature', 'consumer.feature', { enabled: true })
      context.own('subscription', 'subscription', () => { events.push('consumer.subscription') })
    }, drain() { events.push('consumer.drain') }, dispose() { events.push('consumer.dispose') }
  })
  const manager = createNativePackages({ packages: [consumer, producer], configurationRegistry: registry() })
  assert.deepEqual((await manager.start()).map(item => [item.id, item.state]), [['producer', 'running'], ['consumer', 'running']])
  assert.deepEqual(events, ['producer.prepare', 'producer.migrate', 'producer.install', 'producer.recover', 'producer.start', 'consumer.install'])
  assert.equal(manager.contributions()[0]?.owner, 'consumer')
  assert.equal(manager.service('clock', 1), 42)
  await manager.start()
  await Promise.all([manager.stop(), manager.stop()])
  assert.deepEqual(events.slice(6), ['consumer.drain', 'consumer.subscription', 'consumer.dispose', 'producer.drain', 'producer.timer', 'producer.dispose'])
  assert(manager.describe().every(item => item.state === 'stopped' && item.resources.every(resource => resource.state === 'disposed')))
  assert.deepEqual(manager.contributions(), [])
  assert.throws(() => manager.service('clock', 1), { code: 'NATIVE_PACKAGE_SERVICE_UNAVAILABLE' })
})

test('failed package rolls back its own resources and blocks dependents while independent packages stay running', async () => {
  const released: string[] = []
  const healthy = definition('healthy', { install(context) { context.own('task', 'work', () => { released.push('healthy') }) } })
  const failed = definition('failed', { install(context) {
    context.own('timer', 'timer', () => { released.push('failed') })
    throw new Error('synthetic startup failure')
  }, dispose() { released.push('failed.dispose') } })
  const dependent = definition('dependent', { manifest: { ...definition('dependent').manifest, dependencies: ['failed'] },
    install() { throw new Error('Must never run') } })
  const manager = createNativePackages({ packages: [healthy, failed, dependent], configurationRegistry: registry() })
  assert.deepEqual((await manager.start()).map(item => item.state), ['running', 'failed', 'blocked'])
  assert.deepEqual(released, ['failed', 'failed.dispose'])
  await manager.start()
  assert.deepEqual(released, ['failed', 'failed.dispose'])
  await manager.stop()
  assert.deepEqual(released, ['failed', 'failed.dispose', 'healthy'])
})

test('unresolved owned resources remain visibly unknown and cleanup is never replayed', async () => {
  let disposals = 0
  const manager = createNativePackages({ timeoutMs: 10, configurationRegistry: registry(), packages: [definition('hanging', {
    install(context) { context.own('task', 'unresolved', () => { disposals++; return new Promise<void>(() => {}) }) }
  })] })
  await manager.start()
  const stopped = await manager.stop()
  assert.equal(stopped[0]?.state, 'unknown')
  assert.equal(stopped[0]?.resources[0]?.state, 'unknown')
  await manager.stop(); await manager.start()
  assert.equal(disposals, 1)
})

test('package storage is isolated by stable owner namespace and cannot purge or close shared storage', async context => {
  const store = createSqliteStore({ filename: ':memory:' })
  context.after(() => store.close())
  const handles = new Map<string, DurableStore>()
  const packages = ['one', 'two'].map(id => definition(id, { install(context) {
    const scoped = context.store(store)
    handles.set(id, scoped)
    scoped.write('facts', 'same-key', { owner: id })
    assert.deepEqual(scoped.list('facts').map(record => record.value), [{ owner: id }])
    assert.throws(() => scoped.read('../outside', 'same-key'), { code: 'NATIVE_PACKAGE_NAMESPACE_INVALID' })
    assert.throws(() => scoped.purgeExpired(), { code: 'NATIVE_PACKAGE_GLOBAL_STORAGE_OPERATION_FORBIDDEN' })
    scoped.close()
  } }))
  const manager = createNativePackages({ packages, configurationRegistry: registry() })
  assert((await manager.start()).every(item => item.state === 'running'))
  assert.deepEqual(store.read('package.one.facts', 'same-key')?.value, { owner: 'one' })
  assert.deepEqual(store.read('package.two.facts', 'same-key')?.value, { owner: 'two' })
  await manager.stop()
  assert.throws(() => handles.get('one')!.write('facts', 'late', {}))
  // Version upgrades keep the same namespace rather than silently hiding previous data.
  const upgrade = createNativePackages({ configurationRegistry: registry(), packages: [definition('one', {
    manifest: { ...definition('one').manifest, version: '2.0.0' },
    install(context) { assert.deepEqual(context.store(store).read('facts', 'same-key')?.value, { owner: 'one' }) }
  })] })
  await upgrade.start(); await upgrade.stop()
})

test('stop cancels an in-flight package start and does not replay late work', async () => {
  let started = 0
  let released = 0
  let entered!: () => void
  const entering = new Promise<void>(resolve => { entered = resolve })
  const manager = createNativePackages({ timeoutMs: 30, configurationRegistry: registry(), packages: [definition('slow', {
    start(context) {
      started++
      context.own('task', 'started', () => { released++ })
      entered()
      return new Promise<void>(() => {})
    }
  })] })
  const starting = manager.start()
  await entering
  const stopped = await manager.stop()
  await starting
  assert.equal(stopped[0]?.state, 'unknown')
  assert.equal(started, 1)
  assert.equal(released, 1)
  await manager.start(); await manager.stop()
  assert.equal(started, 1)
})

test('chat-input and media packages coexist with hot CAS configuration, owned storage and stopped service guards', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-packages-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const store = createSqliteStore({ filename: ':memory:' })
  context.after(() => store.close())
  const configurations = createPackageConfigurationRegistry({ store: createPackageConfigurationFileStore(directory) })
  let authorizations = 0
  let wake = { nicknames: [] as string[], wakeOnReply: true, continuationMs: 90_000 }
  const manager = createNativePackages({ configurationRegistry: configurations, packages: [
    createChatInputNativePackage({ directory, readPersona: async () => ({ id: 'fixture', name: 'Fixture', identity: 'Fixture identity', style: 'Brief', wake }) }), createMediaNativePackage({ registry: createNativeMediaRegistry({ store, accountId: '999',
      async authorize() { authorizations++ } }) })] })
  assert((await manager.start()).every(item => item.state === 'running'))
  const chat = manager.service('chat-input', 1) as NativeChatInputPackageService
  const media = manager.service('media', 1) as NativeMediaPackageService
  const signal = new AbortController().signal
  assert.equal((await chat.read('group:123')).effective.enabled, true)
  wake = { ...wake, nicknames: ['小助手'], continuationMs: 0 }
  const updated = await chat.read('group:123')
  assert.deepEqual(updated.effective.names, ['小助手', 'Fixture'])
  assert.equal(updated.effective.continuationMs, 0)
  const assetId = await media.register({ kind: 'image', messageId: '456', conversationId: 'group:123', source: { file: 'opaque-id' } }, signal)
  const inspected = await media.inspect.execute({ input: { assetId }, signal,
    scope: { conversationId: 'group:123', featureId: 'fixture', eventId: '456', version: '1.0.0' } })
  assert.equal((inspected as { contentRead: boolean }).contentRead, false)
  assert.equal(authorizations, 2)
  assert.equal(store.list('native-chat.media').length, 1)
  assert.equal(manager.contributions().length, 3)
  await manager.stop()
  assert.throws(() => chat.read('group:123'), { code: 'NATIVE_PACKAGE_SERVICE_UNAVAILABLE' })
  assert.throws(() => media.register({ kind: 'image', messageId: '789', conversationId: 'group:123', source: { file: 'opaque-id' } }, signal),
    { code: 'NATIVE_PACKAGE_SERVICE_UNAVAILABLE' })
  assert.equal(store.list('native-chat.media').length, 1)
  await assert.rejects(configurations.read('chat-input'), { code: 'PACKAGE_CONFIGURATION_NOT_FOUND' })
  assert.equal(configurations.descriptors().length, 1)
  // Stopping a package neither closes shared storage nor removes persistent facts/configuration.
  store.write('another-package', 'alive', { ok: true })
  assert(store.read('another-package', 'alive'))
})
