import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createNativeRuntimeRoutes, prepareNativeChatAuthorization, readNativeChatConfiguration } from '../src/admin/runtime.ts'
import { createNativeChatRuntime } from '../src/host/native-chat-runtime.ts'
import { DEFAULT_NATIVE_CHAT_AUTHORIZATION, validateNativeChatAuthorization } from '../src/host/native-chat-configuration.ts'
import { nativeAuthorizationMode, nativeAuthorizationSignature, nativeChatGrantAvailable } from '../src/host/native-access.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'native-access-'))
  const runtime = createNativeChatRuntime({ directory, prepareAuthorization: () => prepareNativeChatAuthorization(directory),
    loadConfiguration: () => readNativeChatConfiguration(directory), resolveDeployment: async () => ({ missingReasons: [], presetBindings: [] }) })
  context.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  const routes = createNativeRuntimeRoutes({ directory, chatRuntime: runtime })
  async function api(method: 'GET' | 'POST', body: Record<string, unknown> | null = null) {
    const route = routes.find(route => route.method === method && route.pathname === '/api/chat/authorization')!
    const result = await route.handle({ body, query: new URLSearchParams(), signal: new AbortController().signal })
    assert(result && typeof result === 'object' && !Array.isArray(result))
    return result as Record<string, unknown>
  }
  return { directory, runtime, api }
}

test('authorization mode preserves legacy shape/hash; whitelist is explicit and cannot hide counted or null grant fields', () => {
  for (const grant of [
    { conversationId: 'group:456', submitUses: 1, sendUses: 2, expiresAt: null },
    { conversationId: 'group:456', submitUses: 1, sendUses: 2, cancelUses: 0, expiresAt: null },
    { conversationId: 'group:456', submitUses: 1, sendUses: 2, toolDelegationUses: 1, expiresAt: null }
  ]) {
    const original = { version: 'legacy', grants: [grant] }
    const normalized = validateNativeChatAuthorization(original)
    assert.deepEqual(normalized, original)
    assert.equal(nativeAuthorizationSignature(normalized), nativeAuthorizationSignature(original))
    assert.equal(Object.hasOwn(normalized, 'mode'), false)
    assert.equal(nativeAuthorizationMode(normalized), 'counted')
    assert.throws(() => validateNativeChatAuthorization({ ...original, mode: 'whitelist' }))
    assert.throws(() => validateNativeChatAuthorization({ ...original, grants: [{ ...grant, submitUses: null }] }))
  }
  assert.deepEqual(validateNativeChatAuthorization(DEFAULT_NATIVE_CHAT_AUTHORIZATION), DEFAULT_NATIVE_CHAT_AUTHORIZATION)
  for (const mode of [null, 'other', 1]) assert.throws(() => validateNativeChatAuthorization({ version: '1', mode, grants: [] }))
})

test('fresh GET/status expose whitelist without writing authorization or a database; explicit prepare materializes exactly once', async context => {
  const setup = await fixture(context)
  const first = await setup.api('GET')
  assert.equal(first.mode, 'whitelist')
  assert.equal(first.whitelistAvailable, true)
  assert.equal(first.modeSource, 'new-default-whitelist')
  assert.equal(first.authorizationDocumentPresent, false)
  assert.equal(first.taskDelegationAvailable, false)
  await setup.runtime.status()
  assert.deepEqual(await readdir(setup.directory), [])
  await prepareNativeChatAuthorization(setup.directory)
  const filename = join(setup.directory, 'chat-authorization.json')
  const bytes = await readFile(filename)
  assert.deepEqual(JSON.parse(bytes.toString()), { schema: 1, authorization: DEFAULT_NATIVE_CHAT_AUTHORIZATION })
  await prepareNativeChatAuthorization(setup.directory)
  assert.deepEqual(await readFile(filename), bytes)
  const stored = await setup.api('GET')
  assert.equal(stored.modeSource, 'explicit')
  assert.equal(stored.revision, first.revision)
})

test('existing database without authorization is not a fresh whitelist instance and prepare/status do not repair it', async context => {
  const setup = await fixture(context)
  const store = createSqliteStore({ filename: join(setup.directory, 'native-chat.sqlite') })
  store.write('native-chat.meta', 'session-definition', { identity: 'a'.repeat(64) })
  const before = store.list('native-chat.meta')
  const response = await setup.api('GET')
  assert.equal(response.mode, 'counted')
  assert.equal(response.modeSource, 'missing-with-history')
  assert.equal(response.migrationRequired, true)
  const status = await setup.runtime.status()
  assert(status.configurationIssues.includes('authorization_document_missing_with_history'))
  await prepareNativeChatAuthorization(setup.directory)
  await assert.rejects(readFile(join(setup.directory, 'chat-authorization.json')), { code: 'ENOENT' })
  assert.deepEqual(store.list('native-chat.meta'), before)
  store.close()
})

test('migration requires CAS and a new mode version, backs up exact legacy bytes first, and refuses used-version rollback', async context => {
  const setup = await fixture(context)
  const authorization = { version: 'legacy', grants: [{ conversationId: 'group:456', submitUses: 1, sendUses: 1, expiresAt: null }] }
  const filename = join(setup.directory, 'chat-authorization.json')
  const original = Buffer.from(JSON.stringify({ schema: 1, authorization }, null, 2) + '\n')
  await writeFile(filename, original, { mode: 0o600 })
  const store = createSqliteStore({ filename: join(setup.directory, 'native-chat.sqlite') })
  store.write('native-chat.authorization', 'legacy', { signature: nativeAuthorizationSignature(authorization) })
  store.write('test-sentinel', 'unknown', { status: 'unknown', used: 1 })
  const rows = store.list('native-chat.authorization')
  const first = await setup.api('GET')
  assert.equal(first.modeSource, 'legacy-counted')
  await assert.rejects(setup.api('POST', { revision: first.revision, version: 'legacy', mode: 'whitelist', grants: [] }),
    { code: 'chat_authorization_new_mode_version_required' })
  await assert.rejects(setup.api('POST', { revision: '0'.repeat(64), version: 'white-v2', mode: 'whitelist', grants: [] }),
    { code: 'chat_revision_conflict' })
  const backupDirectory = join(setup.directory, 'chat-authorization-backups')
  await writeFile(backupDirectory, 'not-a-directory', { mode: 0o600 })
  await assert.rejects(setup.api('POST', { revision: first.revision, version: 'white-v2', mode: 'whitelist', grants: [] }))
  assert.deepEqual(await readFile(filename), original)
  await rm(backupDirectory)
  const migrated = await setup.api('POST', { revision: first.revision, version: 'white-v2', mode: 'whitelist', grants: [] })
  assert.equal(migrated.mode, 'whitelist')
  assert.deepEqual(await readFile(join(backupDirectory, `${first.revision}.json`)), original)
  assert.deepEqual(store.list('native-chat.authorization'), rows)
  assert.equal(store.read('test-sentinel', 'unknown')!.value && typeof store.read('test-sentinel', 'unknown')!.value, 'object')
  await assert.rejects(setup.api('POST', { revision: migrated.revision, version: 'legacy', mode: 'counted', grants: authorization.grants }),
    { code: 'chat_authorization_version_conflict' })
  assert.deepEqual(store.list('native-chat.authorization'), rows)
  store.close()
})

test('unmetered readiness still respects active/expiry/feature and does not mistake missing limits for unlimited', () => {
  const base = { featureId: 'agent-relay', active: true, expiresAt: null,
    maxUses: { 'agent.submit': null, 'messaging.send': null },
    used: { 'agent.submit': Number.MAX_SAFE_INTEGER, 'messaging.send': Number.MAX_SAFE_INTEGER } }
  assert.equal(nativeChatGrantAvailable(base), true)
  assert.equal(nativeChatGrantAvailable({ ...base, active: false }), false)
  assert.equal(nativeChatGrantAvailable({ ...base, expiresAt: Date.now() - 1 }), false)
  assert.equal(nativeChatGrantAvailable({ ...base, featureId: 'other' }), false)
  assert.equal(nativeChatGrantAvailable({ ...base, maxUses: {} }), false)
  assert.equal(nativeChatGrantAvailable({ ...base, maxUses: Object.create(base.maxUses) as typeof base.maxUses }), false)
  assert.equal(nativeChatGrantAvailable({ ...base, used: {} }), false)
  assert.equal(nativeChatGrantAvailable({ ...base, maxUses: { 'agent.submit': 1, 'messaging.send': 1 } }), false)
})

test('orphan database sidecars and corrupt history cannot become fresh defaults or authorize a migration', async context => {
  const setup = await fixture(context)
  const sidecar = join(setup.directory, 'native-chat.sqlite-wal')
  await writeFile(sidecar, 'synthetic-orphan', { mode: 0o600 })
  assert.equal((await setup.api('GET')).modeSource, 'missing-with-history')
  await prepareNativeChatAuthorization(setup.directory)
  await assert.rejects(readFile(join(setup.directory, 'chat-authorization.json')), { code: 'ENOENT' })
  await rm(sidecar)
  await writeFile(join(setup.directory, 'native-chat.sqlite'), 'synthetic-corrupt-database', { mode: 0o600 })
  const response = await setup.api('GET')
  await assert.rejects(setup.api('POST', { revision: response.revision, version: 'white-v2', mode: 'whitelist', grants: [] }),
    { code: 'chat_authorization_history_unavailable' })
  await assert.rejects(readFile(join(setup.directory, 'chat-authorization.json')), { code: 'ENOENT' })
})
