import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createNativePackageConfigurationRegistry } from '../src/host/native-package-configuration.ts'
import { defineNativeBootstrap, createNativeBootstrapMount, type LoadedNativeBootstrap } from '../src/host/native-bootstrap.ts'
import { createNativePackages, type NativePackageContext, type NativePackageDefinition } from '../src/host/native-packages.ts'
import type { PackageConfigurationContribution } from '../src/host/package-configuration.ts'
import { createPackageConfigurationRoutes } from '../src/admin/package-configuration.ts'
import { createAdminServer } from '../src/admin/server.ts'
import { createContextStore } from '../src/core/context.ts'
import { isRecord } from '../src/core/values.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

function contribution(schemaVersion = 1): PackageConfigurationContribution {
  return { descriptor: { id: 'external-setting', owner: 'external', schemaVersion, title: 'External setting', description: 'Synthetic package data', application: 'live',
    fields: [{ id: 'enabled', path: ['enabled'], kind: 'boolean', label: 'Enabled', description: 'Synthetic enabled setting' }] }, defaults: { enabled: false },
  validate(input) { if (!isRecord(input) || Object.keys(input).length !== 1 || typeof input.enabled !== 'boolean') throw new TypeError('Invalid external setting'); return { enabled: input.enabled } },
  ...(schemaVersion > 1 ? { migrate: (input: unknown) => { if (!isRecord(input) || typeof input.oldEnabled !== 'boolean') throw new TypeError('Invalid old setting'); return { enabled: input.oldEnabled } } } : {}) }
}

function loaded(configurations: readonly PackageConfigurationContribution[], packages: readonly NativePackageDefinition[], onCreate = () => {}): LoadedNativeBootstrap {
  const definition = defineNativeBootstrap({ manifest: { id: 'extension', version: '1.0.0', apiVersion: 1 }, packageConfigurations: configurations,
    create() { onCreate(); return { packages } } })
  return { ...definition, metadata: { manifest: definition.manifest, codeFingerprint: 'a'.repeat(64), trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true } }
}
function packageDefinition(configurationIds: readonly string[] = ['external-setting']): NativePackageDefinition {
  return { manifest: { schema: 1, id: 'external', version: '1.0.0', dependencies: [], provides: [], requires: [], contributions: [] }, configurationIds }
}

test('external package settings are readable and CAS editable before any bootstrap create/start and remain editable after stop', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-package-configuration-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  let creates = 0
  const bootstrap = loaded([contribution()], [packageDefinition()], () => { creates++ })
  const registry = createNativePackageConfigurationRegistry({ directory, contributions: bootstrap.packageConfigurations })
  const token = 'package-config-admin-token-12345678'
  const server = createAdminServer({ token, snapshot: () => ({}), routes: createPackageConfigurationRoutes({ directory, registry }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const headers = { authorization: `Bearer ${token}` }
  const path = `${origin}/api/chat/packages/configuration`
  const response = await fetch(`${path}?id=external-setting`, { headers }); assert.equal(response.status, 200)
  const initial = await response.json(); assert(isRecord(initial))
  assert.equal(initial.source, 'default'); assert.deepEqual(initial.configuration, { enabled: false })
  assert.equal(creates, 0); assert.deepEqual(await readdir(directory), [])
  const post = (revision: string, enabled: boolean) => fetch(path, { method: 'POST', headers: { ...headers, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'external-setting', revision, configuration: { enabled } }) })
  assert.equal((await post(String(initial.revision), true)).status, 200)
  assert.equal((await post(String(initial.revision), false)).status, 409)
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close())
  const content = createContextStore(); const persona = content.registerPersona({ id: 'fixture', version: '1', name: 'Fixture', identity: {}, style: {} })
  const mount = await createNativeBootstrapMount({ bootstrap, context: { directory, store, context: content, persona, signal: new AbortController().signal } })
  assert.equal(creates, 1)
  let owned: NativePackageContext | undefined
  const definition = mount.packageDefinitions[0]!
  const manager = createNativePackages({ packages: [{ ...definition, install(context) { owned = context } }], configurationRegistry: registry })
  await manager.start(); assert(owned)
  assert.deepEqual((await owned.configuration.read('external-setting')).configuration, { enabled: true })
  await assert.rejects(owned.configuration.read('chat-input'), { code: 'NATIVE_PACKAGE_CONFIGURATION_UNDECLARED' })
  const current = await registry.read('external-setting')
  await assert.rejects(owned.configuration.migrate('external-setting', current.revision), { code: 'NATIVE_PACKAGE_CONFIGURATION_MIGRATION_DENIED' })
  await manager.stop()
  await assert.rejects(owned.configuration.read('external-setting'))
  assert.equal((await post(current.revision, false)).status, 200)
  assert.deepEqual((await registry.read('external-setting')).configuration, { enabled: false })
})

test('owned lifecycle migration uses declared canonical schema, exact CAS and preserves stopped management declarations', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-package-migration-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'package-external-setting.configuration.json')
  await writeFile(filename, JSON.stringify({ schema: 1, id: 'external-setting', schemaVersion: 1, configuration: { oldEnabled: true } }), { mode: 0o600 })
  const registry = createNativePackageConfigurationRegistry({ directory, contributions: [contribution(2)] })
  const before = await registry.inspect('external-setting')
  assert.equal(before.schemaVersion, 1); assert.equal(before.targetSchemaVersion, 2)
  await assert.rejects(registry.read('external-setting'), { code: 'PACKAGE_CONFIGURATION_MIGRATION_REQUIRED' })
  const definition: NativePackageDefinition = { ...packageDefinition(), async migrate(context) {
    const metadata = await context.configuration.inspect('external-setting')
    await context.configuration.migrate('external-setting', metadata.revision)
  } }
  const manager = createNativePackages({ packages: [definition], configurationRegistry: registry })
  assert.equal((await manager.start())[0]?.state, 'running')
  assert.deepEqual((await registry.read('external-setting')).configuration, { enabled: true })
  const bytes = await readFile(filename)
  await assert.rejects(registry.migrate('external-setting', before.revision, new AbortController().signal), { code: 'PACKAGE_CONFIGURATION_CONFLICT' })
  assert.deepEqual(await readFile(filename), bytes)
  await manager.stop()
  assert.equal(registry.descriptors().some(descriptor => descriptor.id === 'external-setting'), true)
})

test('bootstrap rejects undeclared/mismatched schema and cross-owner references before package lifecycle', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-package-config-preflight-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close())
  const content = createContextStore(); const persona = content.registerPersona({ id: 'fixture', version: '1', name: 'Fixture', identity: {}, style: {} })
  const options = { directory, store, context: content, persona, signal: new AbortController().signal }
  await assert.rejects(createNativeBootstrapMount({ bootstrap: loaded([], [packageDefinition()]), context: options }), { code: 'NATIVE_BOOTSTRAP_CONFIGURATION_UNDECLARED' })
  await assert.rejects(createNativeBootstrapMount({ bootstrap: loaded([contribution()], [packageDefinition([])]), context: options }), { code: 'NATIVE_BOOTSTRAP_CONFIGURATION_UNDECLARED' })
  const original = contribution()
  await assert.rejects(createNativeBootstrapMount({ bootstrap: loaded([original], [{ ...packageDefinition(), configurations: [{ ...original, validate: () => ({ enabled: true }) }] }]), context: options }), { code: 'NATIVE_BOOTSTRAP_CONFIGURATION_MISMATCH' })
  const registry = createNativePackageConfigurationRegistry({ directory, contributions: [original] })
  assert.throws(() => createNativePackages({ packages: [{ ...packageDefinition(), manifest: { ...packageDefinition().manifest, id: 'intruder' } }], configurationRegistry: registry }), { code: 'NATIVE_PACKAGE_CONFIGURATION_OWNER_INVALID' })
})

test('unawaited migration cannot commit after its phase ends or leave a package falsely running', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-package-migration-late-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'package-external-setting.configuration.json')
  await writeFile(filename, JSON.stringify({ schema: 1, id: 'external-setting', schemaVersion: 1, configuration: { oldEnabled: true } }), { mode: 0o600 })
  const before = await readFile(filename)
  let release: (() => void) | undefined
  const wait = new Promise<void>(resolve => { release = resolve })
  const canonical = contribution(2)
  const registry = createNativePackageConfigurationRegistry({ directory, contributions: [{ ...canonical, async migrate(input, fromVersion) {
    await wait
    return canonical.migrate!(input, fromVersion)
  } }] })
  let detached: Promise<unknown> | undefined
  const manager = createNativePackages({ packages: [{ ...packageDefinition(), async migrate(context) {
    const metadata = await context.configuration.inspect('external-setting')
    detached = context.configuration.migrate('external-setting', metadata.revision).catch(error => error)
  } }], configurationRegistry: registry })
  assert.equal((await manager.start())[0]?.state, 'failed')
  release!()
  assert(await detached instanceof Error)
  assert.deepEqual(await readFile(filename), before)
  await manager.stop()
})
