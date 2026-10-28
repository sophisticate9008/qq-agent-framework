import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { prepareDshDeployment, validateDshDeploymentSnapshot, validateDshModelSettings } from '../src/adapters/dsh-deployment.ts'
import type { DshDeploymentInput, DshDeploymentProposal, DshDeploymentSnapshot } from '../src/adapters/dsh-deployment.ts'

const input: DshDeploymentInput = {
  definition: {
    planId: 'chat', personaId: 'friend', instructions: 'Keep replies concise.',
    persona: { identity: 'A friendly whale.', style: 'Warm.' },
    contextLimits: { group: 128_000, private: 384_000 },
    model: { provider: 'catalog-only', name: 'model-1', reasoningEffort: 'high' },
  },
  providers: [{ id: 'catalog-only', name: 'Local', type: 'openai', baseUrl: 'https://models.example.test/v1', enabled: true,
    apiKey: 'private-fixture-key', models: [{ id: 'model-1', name: 'Model' }] }],
  target: { profilePath: '/isolated/cordis.patch.yml', credentialsPath: '/isolated/.credentials.yaml', schemaVersion: '0.2.1-rc.2', revision: 'before',
    providerEntryId: 'llm-pi-ai', providerConfig: { providers: { untouched: { apiKeyEnv: 'OTHER_KEY' } } },
    presets: [], credentialChecks: [], configurationLoaded: false },
  modelSettings: { contextWindow: 512_000, maxTokens: 4096, reasoningEfforts: { off: null, high: 'high' } },
}

test('DSH deployment passes through api identifiers, endpoints and credentials without implementing model requests', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected model request') })
  const { type: ignoredType, ...provider } = input.providers[0]!
  void ignoredType
  const revisions = new Set<string>()
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'operator-custom-api']) {
    const prepared = prepareDshDeployment({ ...input, providers: [{ ...provider, api }] })
    assert.equal(prepared.summary.ready, true)
    const result = await prepared.apply(async proposal => {
      const routes = proposal.expected.providerConfig.providers
      assert(routes !== null && typeof routes === 'object' && !Array.isArray(routes))
      for (const [id, route] of Object.entries(routes)) {
        if (id === 'untouched') continue
        assert(route !== null && typeof route === 'object' && !Array.isArray(route))
        assert.equal(route.api, api)
        assert.equal(route.baseURL, provider.baseUrl)
        assert.equal(proposal.credentials.find(credential => credential.ref === route.apiKeyEnv)?.value, provider.apiKey)
      }
      return { status: 'committed', backupId: 'fixture-backup', readback: readback(proposal) }
    }, new AbortController().signal)
    assert.equal(result.status, 'verified')
    revisions.add(JSON.stringify(prepared.summary.selectablePresets))
  }
  assert.equal(revisions.size, 5)
  assert.equal(fetch.mock.callCount(), 0)
})

function readback(proposal: DshDeploymentProposal, changes: Partial<DshDeploymentSnapshot> = {}): DshDeploymentSnapshot {
  return {
    ...input.target!, revision: 'after', providerConfig: proposal.expected.providerConfig, presets: proposal.expected.presets,
    credentialChecks: proposal.credentials.map(credential => ({ ref: credential.ref, localValueMatches: true,
      liveConfigured: true, liveSource: 'file', targetPath: input.target!.credentialsPath })), configurationLoaded: true, ...changes,
  }
}

test('DSH preparation previews generated rows without keys or inherited secrets and maps separate scopes', async () => {
  const preparation = prepareDshDeployment(input)
  assert.equal(preparation.summary.ready, true)
  assert(!JSON.stringify(preparation).includes('private-fixture-key'))
  const preview = preparation.preview()!
  assert.equal(Object.keys(preview.providerUpdates).length, 2)
  assert(!JSON.stringify(preview).includes('OTHER_KEY'))
  assert.deepEqual(preparation.summary.selectablePresets.map(preset => preset.contextWindow), [128_000, 384_000])
  let called = 0
  const result = await preparation.apply(async proposal => {
    called++
    assert.deepEqual(proposal.expected.providerConfig.providers && Object.keys(proposal.expected.providerConfig.providers), [
      'untouched', ...preparation.summary.selectablePresets.map(preset => preset.externalProvider),
    ])
    assert.equal(proposal.expectedRevision, 'before')
    assert.equal(proposal.credentials[0]?.value, 'private-fixture-key')
    assert(proposal.expected.presets.every(preset => JSON.stringify(preset.config).includes('A friendly whale.\\n\\nWarm.\\n\\nKeep replies concise.')))
    return { status: 'committed', backupId: 'private-backup-id', readback: readback(proposal) }
  }, new AbortController().signal)
  assert.equal(result.status, 'verified')
  if (result.status !== 'verified') throw new Error('Not verified')
  assert.deepEqual(result.presetBindings.map(binding => binding.conversationKind), ['group', 'private'])
  assert(result.presetBindings.every(binding => binding.externalProvider !== input.definition.model.provider))
  assert.equal((await preparation.apply(async () => { throw new Error('replayed') }, new AbortController().signal)).status, 'not-ready')
  assert.equal(called, 1)
})

test('DSH provider type and credential rotation produce actual protocol configs without altering native definitions', () => {
  const anthropic = prepareDshDeployment({ ...input, providers: input.providers.map(provider => ({ ...provider, type: 'anthropic' })) })
  assert(anthropic.preview() && JSON.stringify(anthropic.preview()).includes('anthropic-messages'))
  const rotated = prepareDshDeployment({ ...input, providers: input.providers.map(provider => ({ ...provider, apiKey: 'rotated-private-key' })) })
  assert.notEqual(rotated.summary.selectablePresets[0]?.externalProvider, prepareDshDeployment(input).summary.selectablePresets[0]?.externalProvider)
  assert.equal(input.definition.model.provider, 'catalog-only')
})

test('DSH preparation rejects missing capacities, disabled providers, prompt templates and unsupported budgets', () => {
  for (const changed of [
    { ...input, target: undefined },
    { ...input, modelSettings: undefined },
    { ...input, providers: input.providers.map(provider => ({ ...provider, enabled: false })) },
    { ...input, definition: { ...input.definition, instructions: 'Literal {{secret}}' } },
    { ...input, definition: { ...input.definition, contextLimits: { group: 100, private: 10_000 } } },
    { ...input, modelSettings: { ...input.modelSettings!, reasoningEfforts: false as const } },
  ]) assert.equal(prepareDshDeployment(changed).summary.ready, false)
})

test('DSH deployment does not equate write or a matching id with verified loaded state', async () => {
  for (const changes of [
    { configurationLoaded: false }, { credentialChecks: [] }, { providerConfig: {} }, { presets: [] }, { profilePath: '/wrong/cordis.patch.yml' },
  ]) {
    const preparation = prepareDshDeployment(input)
    const result = await preparation.apply(async proposal => ({ status: 'committed', backupId: 'backup', readback: readback(proposal, changes) }), new AbortController().signal)
    assert.equal(result.status, 'unknown')
  }
  assert.equal((await prepareDshDeployment(input).apply(async () => ({ status: 'conflict' }), new AbortController().signal)).status, 'conflict')
  const result = await prepareDshDeployment(input).apply(async () => { throw new Error('private-fixture-key') }, new AbortController().signal)
  assert.equal(result.status, 'unknown')
  assert(!JSON.stringify(result).includes('private-fixture-key'))
})

test('DSH typed validators are bounded, versioned and reject unoffered reasoning values', () => {
  assert.throws(() => validateDshDeploymentSnapshot({ ...input.target, schemaVersion: 'future' }))
  assert.throws(() => validateDshModelSettings({ contextWindow: 500, maxTokens: 100, reasoningEfforts: { off: null } }))
  assert.throws(() => validateDshModelSettings({ contextWindow: 500, maxTokens: 500, reasoningEfforts: false }))
  assert.throws(() => validateDshModelSettings({ contextWindow: 500, maxTokens: 100, reasoningEfforts: { high: null } }))
})

const capabilityContent = JSON.stringify([{ id: 'operator-work', name: '@operator/mature-work', config: { mode: 'declared' } }])
const capabilitySelection = { schema: 1 as const, presetId: 'operator-work',
  revision: createHash('sha256').update(JSON.stringify({ id: 'operator-work', content: capabilityContent })).digest('hex') }
const capabilityInput = {
  ...input, definition: { ...input.definition, capabilitySelection },
  capabilityDeclaration: { selection: capabilitySelection, content: capabilityContent },
}

test('capability composition is the identical preview, write and reconciliation expectation', async () => {
  const prepared = prepareDshDeployment(capabilityInput)
  assert.equal(prepared.summary.ready, true)
  const preview = prepared.preview()!
  assert(preview.presets.every(preset => JSON.stringify(preset.config.plugins).includes('@operator/mature-work')))
  assert.equal(preview.capabilityComposition?.source.revision, capabilitySelection.revision)
  assert.equal(preview.capabilityComposition?.externalToolAuthorizationVerified, false)
  let written: DshDeploymentSnapshot | undefined
  const result = await prepared.apply(async proposal => {
    assert.deepEqual(proposal.expected.presets, preview.presets)
    written = readback(proposal)
    return { status: 'committed', backupId: 'approved-backup', readback: written }
  }, new AbortController().signal)
  assert.equal(result.status, 'verified')
  assert(written)
  const repeated = prepareDshDeployment({ ...capabilityInput, target: written })
  assert.equal(repeated.summary.ready, true)
  assert.deepEqual(repeated.preview()?.capabilityComposition, preview.capabilityComposition)
  assert.equal(repeated.reconcile(written).status, 'verified')
  assert.equal(prepareDshDeployment(input).reconcile(written).status, 'not-ready')
  assert.equal(prepareDshDeployment({ ...input, target: written }).summary.ready, true)
  const changed = structuredClone(written)
  const plugins = changed.presets[0]!.config.plugins
  assert(Array.isArray(plugins))
  plugins.pop()
  assert.equal(repeated.reconcile(changed).status, 'not-ready')
})

test('capability source drift, missing declaration and unsafe composition cannot silently fall back to text-only', () => {
  assert.equal(prepareDshDeployment({ ...capabilityInput, capabilityDeclaration: undefined }).summary.ready, false)
  assert.equal(prepareDshDeployment({ ...capabilityInput, capabilityDeclaration: { selection: capabilitySelection, content: '[]' } }).summary.ready, false)
  assert.equal(prepareDshDeployment({ ...input, capabilityDeclaration: capabilityInput.capabilityDeclaration }).summary.ready, false)
  for (const rows of [
    [{ id: 'persona', name: '@operator/work' }],
    [{ id: 'other-persona', name: '@deepseek-ai/dsh-persona' }],
    [{ id: 'authority', name: '@deepseek-ai/dsh-llm-pi-ai' }],
    [{ id: 'shared', name: '@operator/work', isolate: { tools: 'global' } }],
  ]) {
    const content = JSON.stringify(rows)
    const selection = { ...capabilitySelection, revision: createHash('sha256').update(JSON.stringify({ id: capabilitySelection.presetId, content })).digest('hex') }
    assert.equal(prepareDshDeployment({ ...input, definition: { ...input.definition, capabilitySelection: selection },
      capabilityDeclaration: { selection, content } }).summary.ready, false)
  }
})

test('capability revision and explicit removal create new deployment identities without altering text-only defaults', () => {
  const base = prepareDshDeployment(input).preview()!
  const selected = prepareDshDeployment(capabilityInput).preview()!
  const removed = prepareDshDeployment({ ...input, definition: { ...input.definition, capabilitySelection: null } }).preview()!
  assert.notEqual(selected.presets[0]?.config.id, base.presets[0]?.config.id)
  assert.notEqual(removed.presets[0]?.config.id, selected.presets[0]?.config.id)
  for (const preset of base.presets) {
    assert(Array.isArray(preset.config.plugins))
    assert(preset.config.plugins.every(plugin => plugin !== null && typeof plugin === 'object' && !Array.isArray(plugin)
      && plugin.name !== '@deepseek-ai/dsh-tools' && plugin.name !== '@deepseek-ai/dsh-tool-scope'))
  }
  assert.equal(base.capabilityComposition, null)
  assert.equal(removed.capabilityComposition, null)
  assert(base.presets.every(preset => JSON.stringify(preset.config.plugins).includes('@deepseek-ai/dsh-persona')))
})

test('capability approval fingerprint binds both conversation presets, model routes and deployment target but not unrelated state', () => {
  const before = prepareDshDeployment(capabilityInput).preview()!.capabilityComposition!
  for (const changes of [
    { definition: { ...capabilityInput.definition, instructions: 'Different behavior.' } },
    { definition: { ...capabilityInput.definition, persona: { ...input.definition.persona, style: 'Different style.' } } },
    { definition: { ...capabilityInput.definition, contextLimits: { group: 129_000, private: 384_000 } } },
    { definition: { ...capabilityInput.definition, contextLimits: { group: 128_000, private: 385_000 } } },
    { providers: input.providers.map(provider => ({ ...provider, baseUrl: 'https://different.example.test/v1' })) },
    { providers: input.providers.map(provider => ({ ...provider, apiKey: 'rotated-synthetic-key' })) },
    { target: { ...input.target!, profilePath: '/different/cordis.patch.yml' } },
    { target: { ...input.target!, credentialsPath: '/different/.credentials.yaml' } },
    { namespace: 'different' },
  ]) {
    const prepared = prepareDshDeployment({ ...capabilityInput, ...changes })
    assert.equal(prepared.summary.ready, true)
    assert.notEqual(prepared.preview()?.capabilityComposition?.revision, before.revision)
  }
  const extraProvider = prepareDshDeployment({ ...capabilityInput, target: { ...input.target!, revision: 'new-file-revision',
    providerConfig: { providers: { unrelated: { apiKeyEnv: 'UNRELATED_KEY' } } } } })
  assert.deepEqual(extraProvider.preview()?.capabilityComposition, before)
})
