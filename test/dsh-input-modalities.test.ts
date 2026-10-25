import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDshInputModalities, validateDshModelSettings } from '../src/contracts/dsh-model-settings.ts'
import { prepareDshDeployment } from '../src/host/dsh-deployment-plan.ts'
import { resolveLocalDshModelSettings } from '../src/host/local-dsh-model-settings.ts'
import { NativeConfigurationRepository } from '../src/admin/native-configuration-repository.ts'
import type { NativeChatConfiguration } from '../src/host/native-chat-configuration.ts'
import { isRecord } from '../src/core/values.ts'

const capacities = { contextWindow: 128000, maxTokens: 4096, reasoningEfforts: false as const }

test('model settings contract accepts explicit observed text/image modalities and never invents image support', () => {
  assert.deepEqual(parseDshInputModalities(['image', 'text']), ['text', 'image'])
  for (const input of [null, [], ['image'], ['text', 'audio'], ['text', 'image', 'image'], ['text', 'text']]) assert.equal(parseDshInputModalities(input), null)
  assert.deepEqual(validateDshModelSettings(capacities), capacities)
  assert.deepEqual(validateDshModelSettings({ ...capacities, inputModalities: ['text', 'image'] }).inputModalities, ['text', 'image'])
  assert.throws(() => validateDshModelSettings({ ...capacities, inputModalities: ['audio'] }))
})

test('selected model input and overrides survive metadata discovery, CAS storage and actual deployment planning', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-input-modalities-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const profilePath = join(directory, 'cordis.patch.yml')
  const credentialsPath = join(directory, '.credentials.yaml')
  const repository = new NativeConfigurationRepository(directory)
  const defaults = await repository.read()
  const provider = { id: 'selected', name: 'Selected', type: 'openai' as const, enabled: true,
    baseUrl: 'https://models.example.test/v1', apiKey: 'synthetic-secret', models: [{ id: 'chosen', name: 'Chosen' }] }
  const target = { profilePath, credentialsPath, schemaVersion: '0.2.1-rc.2' as const }
  const configuration: NativeChatConfiguration = { ...defaults, providers: [provider],
    personas: [{ id: 'persona', name: 'Persona', identity: 'Test identity.', style: 'Concise.' }],
    catalog: { activePlanId: 'plan', plans: [{ id: 'plan', name: 'Plan', description: '', instructions: 'Be concise.', personaId: 'persona',
      provider: provider.id, model: 'chosen', reasoningEffort: 'off', contextLimits: { group: 64000, private: 96000 } }] },
    deployment: { ...defaults.deployment, target, modelSettings: null } }
  async function profile(input: unknown, override?: unknown) {
    const route = { api: 'openai-completions', baseURL: provider.baseUrl,
      models: [{ id: 'unselected', ...capacities, input: ['audio'] }, { id: 'chosen', ...capacities, ...(input === undefined ? {} : { input }) }],
      ...(override === undefined ? {} : { modelOverrides: { chosen: { input: override } } }) }
    await writeFile(profilePath, JSON.stringify([{ insert: [{ id: 'provider', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { observed: route } } }] }]), { mode: 0o600 })
  }
  async function compile() {
    const { modelSettings } = await resolveLocalDshModelSettings(configuration, target)
    const prepared = prepareDshDeployment({ definition: { planId: 'plan', personaId: 'persona', instructions: 'Be concise.', persona: { identity: 'Test identity.', style: 'Concise.' },
      model: { provider: provider.id, name: 'chosen', reasoningEffort: 'off' }, contextLimits: { group: 64000, private: 96000 } },
    providers: [provider], modelSettings, target: { ...target, revision: 'before', providerEntryId: 'provider', providerConfig: { providers: {} },
      presets: [], credentialChecks: [], configurationLoaded: false } })
    assert.equal(prepared.summary.ready, true, JSON.stringify(prepared.summary))
    const preview = prepared.preview()!
    const routes = Object.values(preview.providerUpdates)
    assert.equal(routes.length, 2)
    for (const route of routes) {
      assert(isRecord(route) && Array.isArray(route.models) && isRecord(route.models[0]))
      assert.deepEqual(route.models[0].input, modelSettings.inputModalities ?? ['text'])
    }
    return modelSettings
  }
  await profile(['text', 'image'])
  const image = await compile()
  assert.deepEqual(image.inputModalities, ['text', 'image'])
  const current = await repository.readDeployment()
  await repository.replaceDeployment(current.revision, { ...current.value.deployment, modelSettings: image })
  assert.deepEqual((await repository.readDeployment()).value.deployment.modelSettings?.inputModalities, ['text', 'image'])
  await profile(['text', 'image'], ['text'])
  assert.deepEqual((await compile()).inputModalities, ['text'])
  await profile(undefined)
  assert.equal((await compile()).inputModalities, undefined)
  await profile(['text', 'audio'])
  await assert.rejects(resolveLocalDshModelSettings({ ...configuration, deployment: { ...configuration.deployment, modelSettings: image } }, target), { code: 'LOCAL_DSH_MODEL_INPUT_UNAVAILABLE' })
})
