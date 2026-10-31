import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { DEFAULT_CHAT_INPUT_CONFIGURATION, validateChatInputConfiguration, resolveChatInputConfiguration } from '../src/contracts/chat-input-configuration.ts'
import { PACKAGE_CONFIGURATION_PATH, type StoredPackageConfiguration } from '../src/contracts/package-configuration.ts'
import { createDefaultPackageConfigurationRegistry, CHAT_INPUT_CONFIGURATION_CONTRIBUTION, readChatInputConfiguration } from '../src/host/chat-input-configuration.ts'
import { createPackageConfigurationRegistry, type PackageConfigurationContribution } from '../src/host/package-configuration.ts'
import { createPackageConfigurationFileStore } from '../src/storage/package-configuration.ts'
import { revision } from '../src/storage/private-json.ts'
import { createPackageConfigurationRoutes } from '../src/admin/package-configuration.ts'
import { NativeConfigurationRepository } from '../src/admin/native-configuration-repository.ts'
import { NATIVE_MEDIA_CONFIGURATION } from '../src/host/native-media-configuration.ts'
import { validateNativeMediaConfiguration } from '../src/contracts/native-media-configuration.ts'
import { DEFAULT_PERSONA_WAKE, validatePersonaWake } from '../src/contracts/persona-wake.ts'

test('group wake probability defaults to one percent for legacy personas and rejects invalid configuration', () => {
  const legacy = { nicknames: [], wakeOnReply: true, continuationMs: 90000 }
  assert.equal(DEFAULT_PERSONA_WAKE.groupWakeProbabilityPercent, 1)
  assert.equal(resolveChatInputConfiguration({ ...DEFAULT_CHAT_INPUT_CONFIGURATION, ...validatePersonaWake(legacy) }, 'group:123').groupWakeProbabilityPercent, 1)
  for (const probability of [0, 1, 100]) {
    assert.equal(validatePersonaWake({ ...legacy, groupWakeProbabilityPercent: probability }).groupWakeProbabilityPercent, probability)
  }
  for (const probability of [-1, 101, 0.5, NaN, Infinity, '1', null]) {
    assert.throws(() => validatePersonaWake({ ...legacy, groupWakeProbabilityPercent: probability }), TypeError)
  }
  assert.throws(() => validatePersonaWake({ ...legacy, unknown: 1 }), TypeError)
})

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'package-configuration-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const registry = createPackageConfigurationRegistry({ store: createPackageConfigurationFileStore(directory),
    contributions: [CHAT_INPUT_CONFIGURATION_CONTRIBUTION] })
  return { directory, registry, signal: new AbortController().signal }
}

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

test('built-in configuration has independent CAS and live readback while native startup revisions stay unchanged', async context => {
  const { directory, registry, signal } = await fixture(context)
  const native = new NativeConfigurationRepository(directory)
  const before = await native.read()
  const initial = await registry.read('chat-input')
  assert.equal(initial.source, 'default')
  assert.deepEqual(await readdir(directory), [])
  const next = { ...DEFAULT_CHAT_INPUT_CONFIGURATION, nicknames: ['小桥'], continuationMs: 15_000,
    scopes: { ...DEFAULT_CHAT_INPUT_CONFIGURATION.scopes, exclude: ['group:123'] } }
  const saved = await registry.compareAndSet('chat-input', initial.revision, next, signal)
  assert.equal(saved.source, 'stored')
  assert.equal((await stat(join(directory, 'package-chat-input.configuration.json'))).mode & 0o777, 0o600)
  assert.deepEqual((await native.read()).revisions, before.revisions)
  const effective = await readChatInputConfiguration(directory, 'group:456', 'Native')
  assert.deepEqual(effective.effective.names, ['Native'])
  assert.equal(effective.effective.continuationMs, DEFAULT_CHAT_INPUT_CONFIGURATION.continuationMs)
  assert.equal((await readChatInputConfiguration(directory, 'group:123')).effective.enabled, true)
  const disabled = await registry.compareAndSet('chat-input', saved.revision, { ...next, enabled: false }, signal)
  assert.equal((await readChatInputConfiguration(directory, 'private:456')).effective.reason, 'active')
  await assert.rejects(registry.compareAndSet('chat-input', initial.revision, next, signal), { code: 'PACKAGE_CONFIGURATION_CONFLICT' })
  assert.equal((await registry.read('chat-input')).revision, disabled.revision)
})

test('two registry instances serialize writes with CAS and cancellation cannot save new settings', async context => {
  const { directory, registry, signal } = await fixture(context)
  const current = await registry.read('chat-input')
  const other = createPackageConfigurationRegistry({ store: createPackageConfigurationFileStore(directory),
    contributions: [CHAT_INPUT_CONFIGURATION_CONTRIBUTION] })
  const results = await Promise.allSettled([
    registry.compareAndSet('chat-input', current.revision, { ...DEFAULT_CHAT_INPUT_CONFIGURATION, continuationMs: 1_000 }, signal),
    other.compareAndSet('chat-input', current.revision, { ...DEFAULT_CHAT_INPUT_CONFIGURATION, continuationMs: 2_000 }, signal)
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')
  assert(rejected?.status === 'rejected')
  assert.equal(object(rejected.reason).code, 'PACKAGE_CONFIGURATION_CONFLICT')
  const saved = await registry.read('chat-input')
  const controller = new AbortController()
  controller.abort(new Error('synthetic-cancellation'))
  await assert.rejects(registry.compareAndSet('chat-input', saved.revision, DEFAULT_CHAT_INPUT_CONFIGURATION, controller.signal), /synthetic-cancellation/)
  assert.equal((await registry.read('chat-input')).revision, saved.revision)
})

test('scope and wake settings only restrict participation, preserve deny precedence, and reject authority-shaped fields', () => {
  const value = validateChatInputConfiguration({ ...DEFAULT_CHAT_INPUT_CONFIGURATION,
    scopes: { group: true, private: false, include: ['group:123'], exclude: ['group:123'] } })
  assert.equal(resolveChatInputConfiguration(value, 'group:123').reason, 'active')
  assert.equal(resolveChatInputConfiguration(value, 'group:456').reason, 'active')
  assert.equal(resolveChatInputConfiguration(value, 'private:123').reason, 'active')
  for (const input of [
    { ...value, authorization: { grants: ['*'] } },
    { ...value, continuationMs: 300_001 },
    { ...value, nicknames: ['Native', 'native'] },
    { ...value, scopes: { ...value.scopes, include: ['group:*'] } }
  ]) assert.throws(() => validateChatInputConfiguration(input), TypeError)
})

test('package contributions reject duplicate identities and corrupted stored values never become defaults', async context => {
  const { directory, registry } = await fixture(context)
  assert.throws(() => registry.register(CHAT_INPUT_CONFIGURATION_CONTRIBUTION), { code: 'PACKAGE_CONFIGURATION_DUPLICATE' })
  const filename = join(directory, 'package-chat-input.configuration.json')
  await writeFile(filename, '{"corrupt":true}\n', { mode: 0o600 })
  const bytes = await readFile(filename)
  await assert.rejects(registry.read('chat-input'), { code: 'PACKAGE_CONFIGURATION_STORAGE_UNAVAILABLE' })
  assert.equal((await readChatInputConfiguration(directory, 'group:123')).effective.enabled, true)
  assert.deepEqual(await readFile(filename), bytes)
  assert.equal(registry.descriptors()[0]?.owner, 'chat-input')
  registry.unregisterOwner('chat-input')
  await assert.rejects(registry.read('chat-input'), { code: 'PACKAGE_CONFIGURATION_NOT_FOUND' })
  assert.deepEqual(await readFile(filename), bytes)
})

test('version migration requires explicit old-revision CAS and does not run during ordinary reads', async context => {
  const { directory, signal } = await fixture(context)
  let migrations = 0
  const contribution: PackageConfigurationContribution = { descriptor: { id: 'synthetic', owner: 'synthetic', schemaVersion: 2,
    title: 'Synthetic', description: '', application: 'live', fields: [] }, defaults: { enabled: false },
    validate(input) { const value = object(input); if (typeof value.enabled !== 'boolean') throw new TypeError('Expected enabled'); return { enabled: value.enabled } },
    migrate(input, fromVersion) { migrations++; assert.equal(fromVersion, 1); return { enabled: object(input).active === true } } }
  const store = createPackageConfigurationFileStore(directory)
  const registry = createPackageConfigurationRegistry({ store, contributions: [contribution] })
  const old: StoredPackageConfiguration = { schema: 1, id: 'synthetic', schemaVersion: 1, configuration: { active: true } }
  const bytes = Buffer.from(`${JSON.stringify(old)}\n`)
  const filename = join(directory, 'package-synthetic.configuration.json')
  await writeFile(filename, bytes, { mode: 0o600 })
  await assert.rejects(registry.read('synthetic'), { code: 'PACKAGE_CONFIGURATION_MIGRATION_REQUIRED' })
  assert.equal(migrations, 0)
  await assert.rejects(registry.migrate('synthetic', '0'.repeat(64), signal), { code: 'PACKAGE_CONFIGURATION_CONFLICT' })
  assert.equal(migrations, 0)
  const migrated = await registry.migrate('synthetic', revision(bytes), signal)
  assert.equal(migrations, 1)
  assert.equal(migrated.schemaVersion, 2)
  assert.deepEqual(migrated.configuration, { enabled: true })
  await registry.migrate('synthetic', migrated.revision, signal)
  assert.equal(migrations, 1)
})

test('package configuration HTTP route is usable with chat stopped, returns live readback, and has no approval surface', async context => {
  const { directory, registry } = await fixture(context)
  const routes = createPackageConfigurationRoutes({ directory, registry })
  const request = async (method: 'GET' | 'POST', pathname: string, body: Record<string, unknown> | null, query = '') => {
    const route = routes.find(candidate => candidate.method === method && candidate.pathname === pathname)
    assert(route)
    return object(await route.handle({ query: new URLSearchParams(query), body, signal: new AbortController().signal }))
  }
  const current = await request('GET', PACKAGE_CONFIGURATION_PATH, null, 'id=chat-input')
  const saved = await request('POST', PACKAGE_CONFIGURATION_PATH,
    { id: 'chat-input', revision: current.revision, configuration: { ...DEFAULT_CHAT_INPUT_CONFIGURATION, wakeOnReply: false } })
  assert.equal(object(saved.configuration).wakeOnReply, false)
  assert.equal(saved.application, 'live')
  const listing = await request('GET', PACKAGE_CONFIGURATION_PATH, null)
  assert.equal(Array.isArray(listing.packages), true)
  await assert.rejects(request('POST', PACKAGE_CONFIGURATION_PATH,
    { id: 'chat-input', revision: saved.revision, configuration: DEFAULT_CHAT_INPUT_CONFIGURATION, approve: true }),
  { statusCode: 400, code: 'invalid_package_configuration' })
  await assert.rejects(request('GET', PACKAGE_CONFIGURATION_PATH, null, 'id=chat-input&id=other'), { statusCode: 400 })
  assert.deepEqual(routes.map(route => route.pathname), [PACKAGE_CONFIGURATION_PATH, PACKAGE_CONFIGURATION_PATH, `${PACKAGE_CONFIGURATION_PATH}/migrate`])
})

test('hot configuration reads and GET defaults never create a missing runtime directory', async context => {
  const { directory } = await fixture(context)
  const absent = join(directory, 'not-created')
  const current = await readChatInputConfiguration(absent, 'group:123')
  assert.equal(current.source, 'stored')
  assert.equal(current.effective.enabled, true)
  await assert.rejects(stat(absent), { code: 'ENOENT' })
})


test('stored media settings default to V1 without a write, and V2 uses independent live CAS', async context => {
  const { directory, signal } = await fixture(context)
  const filename = join(directory, 'package-media.configuration.json')
  const bytes = JSON.stringify({ schema: 1, id: 'media', schemaVersion: 1, configuration: { schema: 1, observeVideo: true } }) + '\n'
  await writeFile(filename, bytes, { mode: 0o600 })
  const registry = createPackageConfigurationRegistry({ store: createPackageConfigurationFileStore(directory), contributions: [NATIVE_MEDIA_CONFIGURATION] })
  const native = new NativeConfigurationRepository(directory)
  const before = await native.read()
  const current = await registry.read('media')
  assert.deepEqual(current.configuration, { schema: 1, observeVideo: true, observationVersion: 'v1' })
  assert.equal(await readFile(filename, 'utf8'), bytes)
  const saved = await registry.compareAndSet('media', current.revision, { schema: 1, observeVideo: true, observationVersion: 'v2' }, signal)
  assert.equal(object(saved.configuration).observationVersion, 'v2')
  assert.deepEqual((await native.read()).revisions, before.revisions)
  await assert.rejects(registry.compareAndSet('media', current.revision, current.configuration, signal), { code: 'PACKAGE_CONFIGURATION_CONFLICT' })
  for (const observationVersion of ['auto', 'v3', 2, null]) assert.throws(() => validateNativeMediaConfiguration({ schema: 1, observeVideo: true, observationVersion }), TypeError)
})
