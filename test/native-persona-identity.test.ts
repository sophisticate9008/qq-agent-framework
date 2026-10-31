import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createContextStore } from '../src/core/context.ts'
import { createEngine } from '../src/core/engine.ts'
import { createPolicy } from '../src/core/policy.ts'
import type { SendRequest } from '../src/core/types.ts'
import { buildChatSessionDefinition, type ChatPlan } from '../src/host/chat-plans.ts'
import { createNativePersonaIdentity, inspectNativePersonaScope } from '../src/host/native-persona-identity.ts'
import { createResourceRegistry } from '../src/host/resources.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

const persona = { id: 'Persona:Imported_1', name: 'Fixed persona', identity: 'A fixed assistant identity.', style: 'Concise.' }
const plan: ChatPlan = { id: 'daily', name: 'Daily', description: '', personaId: persona.id,
  instructions: 'Normal chat.', provider: 'provider-1', model: 'model-1', reasoningEffort: 'off',
  contextLimits: { group: 128_000, private: 128_000 } }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

test('persona content version excludes plan, instructions, provider, model, reasoning and context settings', () => {
  const original = createNativePersonaIdentity(persona)
  const first = buildChatSessionDefinition(plan, persona)
  for (const groupWakeProbabilityPercent of [0, 1, 100]) {
    const changed = { ...persona, wake: { nicknames: [], wakeOnReply: true, continuationMs: 90000, groupWakeProbabilityPercent } }
    assert.equal(createNativePersonaIdentity(changed).version, original.version)
    assert.equal(hash(buildChatSessionDefinition(plan, changed)), hash(first))
  }
  for (const changes of [{ id: 'other-plan' }, { instructions: 'Different runtime instructions.' },
    { provider: 'provider-2' }, { model: 'model-2' }, { reasoningEffort: 'high' as const },
    { contextLimits: { group: 10_000, private: 20_000 } }]) {
    const definition = buildChatSessionDefinition({ ...plan, ...changes }, persona)
    assert.notEqual(hash(first), hash(definition))
    assert.deepEqual(createNativePersonaIdentity(persona), original)
  }
  assert.equal(original.contextId, `native-${hash(persona.id).slice(0, 32)}`)
  assert.equal(original.nativeId, persona.id)
  for (const changes of [{ identity: 'New identity.' }, { style: 'Formal.' }, { name: 'New published name' }, { id: 'other-persona' }]) {
    assert.notEqual(createNativePersonaIdentity({ ...persona, ...changes }).version, original.version)
  }
})

test('real engine sends preserve persona scope and preference/resource identity across dynamic configuration changes', async context => {
  const identity = createNativePersonaIdentity(persona)
  const configuration = createContextStore()
  assert.equal(configuration.registerPersona(identity.persona), identity.reference)
  configuration.setPreferences({ id: 'fixed-preference', scope: { kind: 'persona', id: identity.reference },
    values: { tone: 'friendly' }, source: 'operator' })
  const store = createSqliteStore({ filename: ':memory:' })
  const resources = createResourceRegistry({ store })
  resources.register({ id: 'fixed-resource', type: 'image', scope: 'group:123', persona: identity.reference,
    version: 'asset-1', source: { kind: 'gateway', id: 'safe-asset-id' } })
  resources.approve('fixed-resource')
  const policy = createPolicy()
  const sent: SendRequest[] = []
  const engine = createEngine({ context: configuration, persona: identity.reference, policy,
    transport: { send(request) { sent.push(request); return { status: 'confirmed', messageId: `sent-${sent.length}` } } } })
  context.after(async () => { await engine.stop(); store.close() })
  policy.grant({ id: 'fixed-grant', featureId: 'stable-persona', conversationId: 'group:123',
    capabilities: ['messaging.send'], maxUses: { 'messaging.send': 3 } })
  engine.install({ id: 'stable-persona', version: '1.0.0', apiVersion: 1, capabilities: ['messaging.send'],
    subscriptions: ['trigger.fired'], setup(services) {
      services.on('trigger.fired', async execution => {
        assert.equal(execution.context.preferences.tone, 'friendly')
        await execution.send([{ type: 'text', text: 'Scoped notice.' }])
      })
    } })
  for (let index = 0; index < 3; index++) {
    configuration.setConfiguration({ scope: { kind: 'global' }, values: { model: `model-${index}`, instructions: `policy-${index}` }, source: 'operator' })
    const report = await engine.emit({ id: `notice-${index}`, type: 'trigger.fired', conversationId: 'group:123', data: {} })
    assert.equal(report.outcomes[0]?.status, 'completed')
    const scope = sent[index]?.scope
    assert.deepEqual(scope?.persona, { id: identity.contextId, version: identity.version })
    assert.equal(resources.resolve({ assetId: 'fixed-resource', type: 'image', conversationId: 'group:123',
      persona: `${scope?.persona.id}@${scope?.persona.version}` }), 'safe-asset-id')
  }
  const denied = await engine.emit({ id: 'exhausted', type: 'trigger.fired', conversationId: 'group:123', data: {} })
  assert.equal(denied.outcomes[0]?.errorCode, 'BUDGET_EXHAUSTED')
  assert.equal(sent.length, 3)
})

test('legacy 015 definition hashes are not silently aliased or granted access to content-version resources', () => {
  const identity = createNativePersonaIdentity(persona)
  const oldVersion = hash(buildChatSessionDefinition(plan, persona))
  const boundary = inspectNativePersonaScope(identity, oldVersion)
  assert.equal(boundary.migrationRequired, true)
  assert.equal(boundary.automaticAliasAvailable, false)
  assert.equal(inspectNativePersonaScope(identity, null).migrationRequired, false)
  assert.equal(inspectNativePersonaScope(identity, identity.version).migrationRequired, false)
  const store = createSqliteStore({ filename: ':memory:' })
  try {
    const resources = createResourceRegistry({ store })
    resources.register({ id: 'legacy', type: 'image', scope: 'group:123', persona: `${identity.contextId}@${oldVersion}`,
      version: 'asset-1', source: { kind: 'gateway', id: 'legacy-asset' } })
    resources.approve('legacy')
    assert.throws(() => resources.resolve({ assetId: 'legacy', type: 'image', conversationId: 'group:123', persona: identity.reference }),
      { code: 'RESOURCE_UNAVAILABLE' })
    assert.equal(resources.resolve({ assetId: 'legacy', type: 'image', conversationId: 'group:123',
      persona: `${identity.contextId}@${oldVersion}` }), 'legacy-asset')
  } finally { store.close() }
})
