import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeNativeConfigurationImpact } from '../src/host/native-configuration-impact.ts'
import { createDefaultAdapterConfiguration } from '../src/host/adapter-configuration.ts'
import { buildChatSessionDefinition } from '../src/host/chat-plans.ts'
import { DEFAULT_NATIVE_CHAT_AUTHORIZATION, DEFAULT_NATIVE_CHAT_DEPLOYMENT,
  type NativeChatConfiguration } from '../src/host/native-chat-configuration.ts'
import { DEFAULT_NATIVE_EXECUTION_POLICY } from '../src/host/native-execution.ts'
import { NATIVE_CONFIGURATION_REVISION_KEYS, type NativeConfigurationRevisionKey } from '../src/contracts/native-revisions.ts'

function fixture(): NativeChatConfiguration {
  const persona = { id: 'native', name: 'Native', identity: 'Synthetic private identity.', style: 'Brief.' }
  return { revisions: Object.fromEntries(NATIVE_CONFIGURATION_REVISION_KEYS.map(key => [key, 'a'.repeat(64)])),
    catalog: { activePlanId: 'daily', plans: [{ id: 'daily', name: 'Daily', description: '',
      instructions: 'Synthetic private instructions.', personaId: persona.id, provider: 'provider', model: 'chat', reasoningEffort: 'low' }] },
    personas: [persona], providers: [{ id: 'provider', name: 'Provider', type: 'openai',
      baseUrl: 'https://model.example.test', enabled: true, apiKey: 'synthetic-provider-secret', models: [{ id: 'chat', name: 'Chat' }] }],
    access: { owner: '456', allow: ['group:123', 'private:456'], deny: [] },
    adapters: { ...createDefaultAdapterConfiguration(), dshAgent: { enabled: true,
      endpoint: 'https://dsh.example.test', auth: 'synthetic-dsh-secret' } },
    authorization: DEFAULT_NATIVE_CHAT_AUTHORIZATION, deployment: DEFAULT_NATIVE_CHAT_DEPLOYMENT,
    execution: DEFAULT_NATIVE_EXECUTION_POLICY }
}

function changed(previous: NativeChatConfiguration, key: NativeConfigurationRevisionKey,
  patch: Partial<NativeChatConfiguration>): NativeChatConfiguration {
  return { ...previous, ...patch, revisions: { ...previous.revisions, [key]: 'b'.repeat(64) } }
}

test('unselected catalog edits and display-only plan/provider edits require no restart', () => {
  const previous = fixture()
  const extraPersona = { id: 'other', name: 'Other', identity: 'Other identity.', style: 'Other style.' }
  const extraProvider = { ...previous.providers[0]!, id: 'other', name: 'Other', apiKey: 'unused-secret' }
  const next = changed(previous, 'plans', { catalog: { ...previous.catalog,
    plans: [{ ...previous.catalog.plans[0]!, name: 'Renamed', description: 'Display description.' },
      { ...previous.catalog.plans[0]!, id: 'unused', personaId: extraPersona.id, provider: extraProvider.id }] },
    personas: [...previous.personas, extraPersona], providers: [{ ...previous.providers[0]!, name: 'Renamed provider',
      models: [...previous.providers[0]!.models, { id: 'unused-model', name: 'Unused' }] }, extraProvider] })
  const impact = analyzeNativeConfigurationImpact(previous, next)
  assert.equal(impact.state, 'verified')
  assert.equal(impact.action, 'none')
  assert.equal(impact.canContinue, true)
  assert.deepEqual(impact.ignoredCatalogRevisions, ['plans'])
  assert.deepEqual(impact.changedDependencies, [])
  assert.equal(impact.fingerprints.previous, impact.fingerprints.next)
})

test('selected persona content, instructions, model and context changes require explicit application while preserving sessions', () => {
  const previous = fixture()
  const changes: NativeChatConfiguration[] = [
    changed(previous, 'personas', { personas: [{ ...previous.personas[0]!, identity: 'Changed identity.' }] }),
    changed(previous, 'plans', { catalog: { ...previous.catalog, plans: [{ ...previous.catalog.plans[0]!, instructions: 'Changed instructions.' }] } }),
    changed(previous, 'plans', { catalog: { ...previous.catalog, plans: [{ ...previous.catalog.plans[0]!, reasoningEffort: 'high' }] } }),
    changed(previous, 'plans', { catalog: { ...previous.catalog, plans: [{ ...previous.catalog.plans[0]!, contextLimits: { group: 64_000, private: 128_000 } }] } })
  ]
  for (const next of changes) {
    const impact = analyzeNativeConfigurationImpact(previous, next)
    assert.equal(impact.state, 'verified')
    assert.equal(impact.action, 'restart')
    assert.equal(impact.sessionMigrationRequired, false)
    assert.equal(impact.canContinue, false)
  }
})

test('selected connection credentials, owner, execution and deployment dependencies remain restart barriers', () => {
  const previous = fixture()
  const cases: NativeChatConfiguration[] = [
    changed(previous, 'providers', { providers: [{ ...previous.providers[0]!, apiKey: 'rotated-secret' }] }),
    changed(previous, 'adapters', { adapters: { ...previous.adapters, dshAgent: { ...previous.adapters.dshAgent, auth: 'rotated-dsh-secret' } } }),
    changed(previous, 'access', { access: { ...previous.access, owner: '789' } }),
    changed(previous, 'execution', { execution: { ...previous.execution, turnTimeoutMs: 60_000 } }),
    changed(previous, 'deployment', { deployment: { ...previous.deployment, namespace: 'different' } })
  ]
  for (const next of cases) {
    const impact = analyzeNativeConfigurationImpact(previous, next)
    assert.equal(impact.state, 'verified')
    assert.equal(impact.action, 'restart')
    assert.equal(impact.canContinue, false)
  }
})

test('access withdrawal remains live but always requires immediate current policy evaluation', () => {
  const previous = fixture()
  const next = changed(previous, 'access', { access: { ...previous.access, allow: ['private:456'], deny: ['group:123'] } })
  const impact = analyzeNativeConfigurationImpact(previous, next)
  assert.equal(impact.action, 'none')
  assert.equal(impact.canContinue, true)
  assert.equal(impact.immediatePolicyCheck, true)
  assert.deepEqual(impact.withdrawnConversations, ['group:123'])
  assert.deepEqual(next.authorization, previous.authorization)
})

test('counted grant removal or reduction cannot hide behind catalog-only changes', () => {
  const original = fixture()
  const previous: NativeChatConfiguration = { ...original, authorization: { version: 'counted-1', mode: 'counted',
    grants: [{ conversationId: 'group:123', submitUses: 10, sendUses: 10, expiresAt: null }] } }
  const next = changed(previous, 'authorization', { authorization: { ...previous.authorization,
    grants: [{ ...previous.authorization.grants[0]!, sendUses: 1, expiresAt: 1 }] } })
  const impact = analyzeNativeConfigurationImpact(previous, next)
  assert.equal(impact.action, 'restart')
  assert.equal(impact.immediatePolicyCheck, true)
  assert.deepEqual(impact.withdrawnConversations, ['group:123'])
})

test('unknown, missing or malformed revisions and unavailable selected dependencies fail closed', () => {
  const previous = fixture()
  const { execution: _execution, ...incomplete } = previous.revisions
  const cases: NativeChatConfiguration[] = [
    { ...previous, revisions: incomplete },
    { ...previous, revisions: { ...previous.revisions, future: 'a'.repeat(64) } },
    { ...previous, revisions: { ...previous.revisions, execution: 'unknown' } },
    { ...previous, providers: [] },
    { ...previous, personas: [] },
    { ...previous, catalog: { activePlanId: null, plans: previous.catalog.plans } }
  ]
  for (const next of cases) {
    const impact = analyzeNativeConfigurationImpact(previous, next)
    assert.equal(impact.state, 'unavailable')
    assert.equal(impact.canContinue, false)
    assert.equal(impact.immediatePolicyCheck, true)
  }
})

test('verified deployed bindings participate in the dependency hash and incomplete binding snapshots fail closed', () => {
  const previous = fixture()
  const definition = buildChatSessionDefinition(previous.catalog.plans[0]!, previous.personas[0]!)
  const original = [{ agentPreset: 'preset', definition, conversationKind: 'group' as const }]
  const updated = [{ ...original[0]!, agentPreset: 'other-preset' }]
  const impact = analyzeNativeConfigurationImpact(previous, previous, { previousBindings: original, nextBindings: updated })
  assert.equal(impact.action, 'restart')
  assert.deepEqual(impact.changedDependencies, ['bindings'])
  assert.equal(impact.bindingsCompared, true)
  assert.equal(analyzeNativeConfigurationImpact(previous, previous, { previousBindings: original }).state, 'unavailable')
})

test('impact projections contain fingerprints and dependency names without private prompts or credentials', () => {
  const previous = fixture()
  const next = changed(previous, 'providers', { providers: [{ ...previous.providers[0]!, apiKey: 'rotated-secret' }] })
  const impact = analyzeNativeConfigurationImpact(previous, next)
  const output = JSON.stringify(impact)
  for (const secret of ['synthetic-provider-secret', 'synthetic-dsh-secret', 'rotated-secret',
    previous.personas[0]!.identity, previous.catalog.plans[0]!.instructions]) assert.equal(output.includes(secret), false)
  assert.match(impact.fingerprints.previous!, /^[a-f0-9]{64}$/)
  assert.notEqual(impact.fingerprints.previous, impact.fingerprints.next)
})

test('runtime access comparisons retain 32 digit OneBot identifiers and deny precedence from injected configuration', () => {
  const original = fixture()
  const longId = '12345678901234567890123456789012'
  const previous = { ...original, access: { owner: longId, allow: [`group:${longId}`], deny: [] } }
  const next = changed(previous, 'access', { access: { ...previous.access, deny: [`group:${longId}`] } })
  const impact = analyzeNativeConfigurationImpact(previous, next)
  assert.equal(impact.state, 'verified')
  assert.equal(impact.action, 'none')
  assert.equal(impact.immediatePolicyCheck, true)
  assert.deepEqual(impact.withdrawnConversations, [`group:${longId}`])
})


test('guard checks every delivery authority using current configuration without per-turn deployment RPC', async () => {
  const { createNativeConfigurationGuard } = await import('../src/host/native-configuration-guard.ts')
  const active = fixture()
  let current = active
  const controller = new AbortController()
  const definition = buildChatSessionDefinition(active.catalog.plans[0], active.personas[0])
  const bindings = [{ agentPreset: 'chat', definition }]
  let reads = 0
  const guard = createNativeConfigurationGuard({ current: () => ({ state: 'running', signal: controller.signal, configuration: active, bindings }),
    definition: () => definition, loadConfiguration: async () => current,
    resolveDeployment: async () => { reads++; throw new Error('Deployment is verified at startup and application') } })
  await Promise.all(Array.from({ length: 16 }, () => guard.check('private:456', controller.signal, false, 'delivery')))
  assert.equal(reads, 0)
  assert.equal(guard.describe().phases.delivery.configurationReads, 16)
  current = { ...active, access: { ...active.access, deny: ['private:456'] } }
  await assert.rejects(guard.check('private:456', controller.signal, false, 'delivery'), { code: 'NATIVE_CHAT_ACCESS_DENIED' })
  assert.equal(guard.describe().permissionCaching, false)
})

test('guard fences asynchronous configuration reads against changed runtime lifetimes', async () => {
  const { createNativeConfigurationGuard } = await import('../src/host/native-configuration-guard.ts')
  const { awaitCondition } = await import('./fixtures/await-condition.ts')
  const active = fixture()
  let lifetime = new AbortController()
  const initial = lifetime
  const definition = buildChatSessionDefinition(active.catalog.plans[0], active.personas[0])
  const bindings = [{ agentPreset: 'chat', definition }]
  let release = () => {}
  const hold = new Promise<void>(resolve => { release = resolve })
  let reads = 0
  const guard = createNativeConfigurationGuard({ current: () => ({ state: 'running', signal: lifetime.signal, configuration: active, bindings }),
    definition: () => definition, loadConfiguration: async () => { reads++; await hold; return active },
    resolveDeployment: async () => { throw new Error('No deployment RPC during a turn') } })
  const first = guard.check('private:456', initial.signal)
  await awaitCondition(() => reads === 1, { timeoutMs: 1500, message: 'Configuration read must enter before the runtime changes' })
  lifetime = new AbortController()
  const second = guard.check('private:456', lifetime.signal)
  const settled = Promise.allSettled([first, second]); release()
  assert.deepEqual((await settled).map(result => result.status), ['rejected', 'fulfilled'])
})
