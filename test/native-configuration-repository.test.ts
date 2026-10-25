import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { NativeConfigurationRepository } from '../src/admin/native-configuration-repository.ts'
import { AdminRequestError } from '../src/admin/errors.ts'
import { NATIVE_CONFIGURATION_REVISION_KEYS, isNativeConfigurationRevisions } from '../src/contracts/native-revisions.ts'

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'native-configuration-repository-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, repository: new NativeConfigurationRepository(directory), signal: new AbortController().signal }
}

function errorCode(code: string) {
  return (error: unknown): boolean => error instanceof AdminRequestError && error.code === code
}

test('native repository reads defaults without materializing authorization and exposes an exact revision set', async context => {
  const { directory, repository } = await fixture(context)
  const configuration = await repository.read()
  assert.equal(configuration.authorizationSource, 'new-default')
  assert.equal(configuration.access.owner, null)
  assert.deepEqual(configuration.access.allow, [])
  assert.equal(isNativeConfigurationRevisions(configuration.revisions), true)
  assert.deepEqual(Object.keys(configuration.revisions), [...NATIVE_CONFIGURATION_REVISION_KEYS])
  assert.deepEqual(await readdir(directory), [])
  await repository.prepareAuthorization()
  assert.deepEqual(await readdir(directory), ['chat-authorization.json'])
  assert.deepEqual((await repository.read()).revisions, configuration.revisions)
})

test('native repository access CAS preserves private files and rejects stale writes and aborted commits', async context => {
  const { directory, repository, signal } = await fixture(context)
  const access = repository.accessPersistence()
  const initial = await access.read()
  const next = { allow: ['group:123'], deny: [], owner: '456' }
  const saved = await access.compareAndSet(initial.revision, next, signal)
  assert.deepEqual(saved.value, next)
  assert.equal((await stat(join(directory, 'chat-access.json'))).mode & 0o777, 0o600)
  await assert.rejects(access.compareAndSet(initial.revision, { ...next, owner: null }, signal), errorCode('chat_revision_conflict'))
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(access.compareAndSet(saved.revision, { ...next, owner: null }, controller.signal), /cancelled/)
  assert.deepEqual(await access.read(), saved)
  assert.deepEqual(await readdir(directory), ['chat-access.json'])
})

test('native repository authorization transitions preserve exact backup bytes and enforce a new mode version', async context => {
  const { directory, repository } = await fixture(context)
  const filename = join(directory, 'chat-authorization.json')
  const previous = Buffer.from(' { "schema": 1, "authorization": { "version": "legacy", "grants": [] } }\n')
  await writeFile(filename, previous, { mode: 0o600 })
  const configuration = await repository.read()
  await assert.rejects(repository.updateAuthorization(configuration.revisions.authorization,
    { version: 'legacy', mode: 'whitelist', grants: [] }), errorCode('chat_authorization_new_mode_version_required'))
  assert.deepEqual(await readFile(filename), previous)
  const updated = await repository.updateAuthorization(configuration.revisions.authorization,
    { version: 'whitelist-2', mode: 'whitelist', grants: [] })
  assert.deepEqual(updated.migrationBackup, { revision: configuration.revisions.authorization })
  assert.deepEqual(await readFile(join(directory, 'chat-authorization-backups', `${configuration.revisions.authorization}.json`)), previous)
  await assert.rejects(repository.updateAuthorization(configuration.revisions.authorization,
    { version: 'whitelist-3', mode: 'whitelist', grants: [] }), errorCode('chat_revision_conflict'))
  assert.equal((await repository.read()).authorization.version, 'whitelist-2')
})

test('shared native revision validator rejects missing, added and malformed entries', () => {
  const revisions = Object.fromEntries(NATIVE_CONFIGURATION_REVISION_KEYS.map(key => [key, 'a'.repeat(64)]))
  assert.equal(isNativeConfigurationRevisions(revisions), true)
  const { execution: _execution, ...legacy } = revisions
  assert.equal(isNativeConfigurationRevisions(legacy), false)
  assert.equal(isNativeConfigurationRevisions({ ...revisions, extra: 'a'.repeat(64) }), false)
  assert.equal(isNativeConfigurationRevisions({ ...revisions, access: 'A'.repeat(64) }), false)
  assert.equal(isNativeConfigurationRevisions(null), false)
})

test('native repository catalog writes enforce persona and model references without HTTP and preserve provider secrets', async context => {
  const { repository } = await fixture(context)
  const persona = { id: 'native', name: 'Native', identity: 'Synthetic identity.', style: 'Brief.' }
  const plan = { id: 'daily', name: 'Daily', description: '', instructions: 'Use the selected persona.',
    personaId: persona.id, provider: 'provider', model: 'chat', reasoningEffort: 'low' as const }
  const catalog = { activePlanId: plan.id, plans: [plan] }
  const initial = await repository.readPlans()
  await assert.rejects(repository.replacePlans(initial.revision, catalog), errorCode('persona_in_use_or_missing'))
  const savedPersona = await repository.replacePersonas((await repository.readPersonas()).revision, [persona])
  await assert.rejects(repository.replacePlans(initial.revision, catalog), errorCode('provider_model_missing_or_disabled'))
  const provider = { id: plan.provider, name: 'Provider', type: 'openai', baseUrl: 'https://model.example.test',
    enabled: true, models: [{ id: plan.model, name: 'Chat' }] }
  let providers = await repository.updateProviders((await repository.readProviders()).revision,
    [{ ...provider, apiKey: 'synthetic-private-value' }])
  const savedPlan = await repository.replacePlans(initial.revision, catalog)
  await assert.rejects(repository.replacePersonas(savedPersona.revision, []), errorCode('persona_in_use_or_missing'))
  await assert.rejects(repository.updateProviders(providers.revision, []), errorCode('provider_model_in_use'))
  providers = await repository.updateProviders(providers.revision, [{ ...provider, name: 'Renamed' }])
  assert.equal(providers.value.providers[0]!.apiKey, 'synthetic-private-value')
  assert.equal((await repository.readPlans()).revision, savedPlan.revision)
  await assert.rejects(repository.updateActiveModel(savedPlan.revision,
    { provider: provider.id, model: 'missing', reasoningEffort: 'low' }), errorCode('provider_model_missing_or_disabled'))
  assert.equal((await repository.readPlans()).revision, savedPlan.revision)
})

test('provider edits preserve active and retained assistant targets until explicitly cleared', async context => {
  const { repository, signal } = await fixture(context)
  const provider = { id: 'assistant-provider', name: 'Assistant', type: 'openai', baseUrl: 'https://assistant.example.test',
    enabled: true, models: [{ id: 'assistant-model', name: 'Assistant model' }] }
  const saved = await repository.updateProviders((await repository.readProviders()).revision, [provider])
  for (const mode of ['chat-assistant', 'chat-only'] as const) {
    await repository.replaceAssistant((await repository.readAssistant()).revision,
      { schema: 1, mode, provider: provider.id, model: 'assistant-model', nickname: '', reasoningEffort: null }, signal,
      async () => { throw new Error('No capability read is needed without a reasoning setting') })
    for (const patch of [[], [{ ...provider, enabled: false }], [{ ...provider, models: [] }]])
      await assert.rejects(repository.updateProviders(saved.revision, patch), errorCode('assistant_target_in_use'))
    assert.equal((await repository.readProviders()).revision, saved.revision)
  }
  await repository.replaceAssistant((await repository.readAssistant()).revision,
    { schema: 1, mode: 'chat-only', provider: null, model: null, nickname: '', reasoningEffort: null }, signal,
    async () => { throw new Error('No capability read is needed') })
  assert.deepEqual((await repository.updateProviders(saved.revision, [])).value.providers, [])
})

test('persona deletion preserves active appearance references and permits explicitly unbound tombstones', async context => {
  const { directory, repository } = await fixture(context)
  const persona = { id: 'appearance-persona', name: 'Appearance', identity: 'Synthetic identity.', style: 'Brief.' }
  const saved = await repository.replacePersonas((await repository.readPersonas()).revision, [persona])
  const filename = join(directory, 'chat-appearance.json')
  const appearance = { schema: 1, assets: [{ id: '11111111-1111-4111-8111-111111111111', versions: [{ version: 1,
    name: 'Synthetic image', description: '', source: 'manual-upload', createdAt: 1, mediaType: 'image/png', bytes: 1,
    width: 1, height: 1, sha256: 'a'.repeat(64) }] }], bindings: [{ personaId: persona.id,
    assetId: '11111111-1111-4111-8111-111111111111', version: 1, generation: 1, updatedAt: 1 }] }
  await writeFile(filename, JSON.stringify(appearance), { mode: 0o600 })
  await assert.rejects(repository.replacePersonas(saved.revision, []), errorCode('persona_in_use_by_appearance'))
  assert.equal((await repository.readPersonas()).revision, saved.revision)
  await writeFile(filename, JSON.stringify({ ...appearance, bindings: [{ ...appearance.bindings[0], assetId: null, version: null, generation: 2 }] }), { mode: 0o600 })
  assert.deepEqual((await repository.replacePersonas(saved.revision, [])).value.personas, [])
})
