import assert from 'node:assert/strict'
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
