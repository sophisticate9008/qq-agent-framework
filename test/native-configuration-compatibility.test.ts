import assert from 'node:assert/strict'
import { chmod, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { capabilityObject as object, capabilityUntil as until, createNativeCapabilityRuntimeFixture } from './fixtures/native-capability-runtime.ts'

type Fixture = Awaited<ReturnType<typeof createNativeCapabilityRuntimeFixture>>
type Value = Record<string, unknown>

const prompts = (fixture: Fixture) => fixture.calls.filter(call => call.method === 'session/prompt')
const filename = (fixture: Fixture) => join(fixture.directory, 'runtime/native-chat.sqlite')

function records(fixture: Fixture) {
  const database = new DatabaseSync(filename(fixture), { readOnly: true })
  try { return database.prepare('SELECT * FROM durable_records ORDER BY namespace,key').all() }
  finally { database.close() }
}

function grants(fixture: Fixture) {
  return records(fixture).filter(row => row.namespace === 'policy.grants').map(row => object(JSON.parse(String(row.value))))
}

async function session(fixture: Fixture) {
  const page = await fixture.api('/api/chat/sessions')
  assert(Array.isArray(page.items))
  const binding = page.items.map(object).find(item => item.conversationId === 'private:123')
  assert(binding)
  return binding
}

async function round(fixture: Fixture, messageId: number) {
  const count = prompts(fixture).length
  const sent = fixture.sends.length
  fixture.inbound(messageId)
  await until(() => prompts(fixture).length === count + 1, 'Expected actual default-factory native prompt')
  const sessionId = String(prompts(fixture).at(-1)!.input.sessionId)
  const stream = fixture.streams.findLast(item => item.sessionId === sessionId && item.socket.readyState === 1)
  assert(stream)
  const turn = prompts(fixture).filter(call => call.input.sessionId === sessionId).length
  fixture.event('turn/start', { turn }, stream)
  fixture.event('assistant/message', { turn, step: 1, message: { role: 'assistant',
    content: [{ type: 'text', text: 'Synthetic compatibility final.' }] } }, stream)
  fixture.event('turn/end', { turn, reason: { kind: 'completed' } }, stream)
  await until(() => fixture.sends.length === sent + 1, 'Expected real final-only OneBot reply')
  await until(async () => {
    const page = await fixture.api('/api/chat/executions')
    return Array.isArray(page.items) && page.items.map(object).filter(item => item.status === 'completed').length === count + 1
  }, 'Expected persisted completed turn')
  return session(fixture)
}

async function verifiedProfile(fixture: Fixture) {
  assert.equal((await fixture.apply()).state, 'verified')
  const reconciled = await fixture.api('/api/chat/deployment/reconcile', { revisions: (await fixture.status()).revisions })
  assert.deepEqual(reconciled.missingReasons, [])
}

async function changePlan(fixture: Fixture, update: (plan: Value) => Value) {
  const current = await fixture.api('/api/chat/plans')
  assert(Array.isArray(current.plans))
  return fixture.save('plans', { activePlanId: current.activePlanId, plans: current.plans.map(raw => update(object(raw))) })
}

async function baseline(fixture: Fixture) {
  const result = await fixture.api('/api/chat/runtime/baseline')
  assert.equal(result.schema, 1)
  assert.equal(result.state, 'available')
  assert.equal(result.unavailableReason, null)
  assert(Number.isSafeInteger(result.capturedAt) && Number(result.capturedAt) > 0)
  const values = object(result.values)
  assert.deepEqual(Object.keys(values).sort(), ['bindings', 'definition', 'endpoint', 'persona'])
  const serialized = JSON.stringify(result)
  for (const secret of ['synthetic-model-key-never-used', 'fixture-onebot-http', 'fixture-onebot-ws',
    'fixture-dsh-owner', fixture.adminToken, 'synthetic-gateway-token-0123456789']) assert(!serialized.includes(secret))
  for (const field of ['apiKey', 'secret', 'auth', 'token']) assert(!serialized.includes(`"${field}":`))
  return result
}

async function restore(fixture: Fixture, original: Value) {
  const values = object(original.values)
  const definition = object(values.definition)
  const model = object(definition.model)
  await changePlan(fixture, plan => {
    const restored: Value = { ...plan, instructions: definition.instructions, personaId: definition.personaId,
      provider: model.provider, model: model.name, reasoningEffort: model.reasoningEffort }
    for (const field of ['contextLimits', 'capabilitySelection'] as const) {
      if (Object.hasOwn(definition, field)) restored[field] = definition[field]
      else delete restored[field]
    }
    return restored
  })
  await fixture.save('personas', { personas: [values.persona] })
  if (definition.capabilitySelection) await fixture.approve()
  await verifiedProfile(fixture)
}

async function initiallyConfigured(fixture: Fixture, selected = false) {
  await fixture.login()
  await fixture.configure(selected, selected ? 2 : undefined)
  const providers = await fixture.api('/api/chat/providers')
  assert(Array.isArray(providers.providers))
  await fixture.save('providers', { providers: providers.providers.map(raw => {
    const { apiKeyConfigured: _configured, ...provider } = object(raw)
    assert(Array.isArray(provider.models))
    return { ...provider, models: [...provider.models, { id: 'synthetic-other', name: 'Other synthetic model' }] }
  }) })
  if (selected) {
    fixture.controls.schemas = [{ name: 'local-observed-tool', description: 'Observed only; never executed.',
      parameters: { type: 'object', properties: {} } }]
    await fixture.approve()
  }
  await verifiedProfile(fixture)
  assert.equal((await fixture.start()).chatReady, true)
}

interface DriftCase {
  readonly name: string
  readonly difference: string
  readonly selected?: boolean
  readonly mutate: (fixture: Fixture) => Promise<unknown>
}

const cases: readonly DriftCase[] = [
  { name: 'context limit', difference: 'contextLimits', mutate: fixture => changePlan(fixture,
    plan => ({ ...plan, contextLimits: { group: 100_000, private: 110_000 } })) },
  { name: 'model', difference: 'model.name', mutate: fixture => changePlan(fixture, plan => ({ ...plan, model: 'synthetic-other' })) },
  { name: 'instructions', difference: 'instructions', mutate: fixture => changePlan(fixture,
    plan => ({ ...plan, instructions: 'Changed instructions are not a migration.' })) },
  { name: 'selected capability to explicit null', selected: true, difference: 'capabilitySelection',
    mutate: fixture => changePlan(fixture, plan => ({ ...plan, capabilitySelection: null })) },
  { name: 'omitted capability to explicit null', difference: 'capabilitySelection',
    mutate: fixture => changePlan(fixture, plan => ({ ...plan, capabilitySelection: null })) },
  { name: 'persona display name', difference: 'persona.name', mutate: async fixture => {
    const current = await fixture.api('/api/chat/personas')
    assert(Array.isArray(current.personas))
    return fixture.save('personas', { personas: current.personas.map(raw => ({ ...object(raw), name: 'Changed persona name' })) })
  } },
]

for (const scenario of cases) test(`default existing session: ${scenario.name} is blocked before start and manual CAS resumes the same generation`,
  { timeout: 90_000 }, async context => {
    const fixture = await createNativeCapabilityRuntimeFixture(context)
    await initiallyConfigured(fixture, scenario.selected)
    const first = await round(fixture, 1)
    const original = await baseline(fixture)
    assert.equal(object(object(original.values).definition).instructions, 'No implicit permissions.')
    const authorization = await fixture.api('/api/chat/authorization')
    const consumed = grants(fixture)
    await fixture.api('/api/chat/runtime/stop', {})
    const oldPlans = await fixture.api('/api/chat/plans')
    await scenario.mutate(fixture)
    await verifiedProfile(fixture)
    const before = records(fixture)
    const blocked = await fixture.status()
    const compatibility = object(blocked.configurationCompatibility)
    assert.equal(blocked.canStart, false)
    assert.equal(compatibility.state, 'blocked')
    assert.equal(compatibility.hasPersistedSessions, true)
    assert(Array.isArray(compatibility.differences) && compatibility.differences.includes(scenario.difference))
    assert.equal(object(compatibility.baseline).state, 'available')
    assert.deepEqual(Object.keys(object(compatibility.baseline)).sort(), ['capturedAt', 'state', 'unavailableReason'])
    assert(!JSON.stringify(compatibility).includes('No implicit permissions.'))
    assert.deepEqual(compatibility.recovery, { mode: 'restore-original-values', automaticRestoreAvailable: false, forwardMigrationAvailable: false })
    assert.deepEqual(await baseline(fixture), original)
    assert.deepEqual(records(fixture), before)
    await fixture.start(503)
    assert.match(String((await fixture.status()).lastError), /NATIVE_CHAT_(SESSION_CONFIGURATION|PERSONA_IDENTITY)_CONFLICT/)
    assert.deepEqual(records(fixture), before)
    assert.deepEqual(await session(fixture), first)
    assert.deepEqual(grants(fixture), consumed)
    assert.equal(fixture.controls.creates, 1)
    assert.equal(prompts(fixture).length, 1)
    if (scenario.difference !== 'persona.name') {
      await fixture.api('/api/chat/plans', { revision: oldPlans.revision, activePlanId: oldPlans.activePlanId, plans: oldPlans.plans }, 409)
      assert.equal(object((await fixture.status()).configurationCompatibility).state, 'blocked')
    }
    await restore(fixture, original)
    const ready = await fixture.status()
    assert.equal(ready.canStart, true)
    assert.equal(object(ready.configurationCompatibility).state, 'compatible')
    assert.deepEqual(await fixture.api('/api/chat/authorization'), authorization)
    assert.deepEqual(grants(fixture), consumed)
    assert.equal((await fixture.start()).chatReady, true)
    assert.deepEqual(await round(fixture, 2), first)
    assert.equal(fixture.controls.creates, 1)
    assert.deepEqual(await baseline(fixture), original)
    const privateGrant = grants(fixture).find(grant => grant.conversationId === 'private:123')!
    assert.equal(object(privateGrant.used)['agent.submit'], 2)
    assert.equal(object(privateGrant.used)['messaging.send'], 2)
    if (scenario.selected) {
      assert.equal(object(privateGrant.used)['agent.tools.delegate'], 0)
      assert.equal((await fixture.status()).toolDelegation && object((await fixture.status()).toolDelegation).externalToolAuthorizationVerified, false)
      assert(fixture.trace.filter(item => item.kind === 'scope' && item.names?.includes('local-observed-tool')).length >= 2)
    }
    assert.deepEqual(fixture.errors, [])
  })

for (const fault of ['missing-baseline', 'invalid-baseline', 'invalid-identity', 'unreadable-storage'] as const) {
  test(`default existing session: ${fault} never invents baseline, recreates sessions or refills grants`, { timeout: 90_000 }, async context => {
    const fixture = await createNativeCapabilityRuntimeFixture(context)
    await initiallyConfigured(fixture)
    const first = await round(fixture, 1)
    await fixture.api('/api/chat/runtime/stop', {})
    await changePlan(fixture, plan => ({ ...plan, contextLimits: { group: 100_000, private: 110_000 } }))
    await verifiedProfile(fixture)
    if (fault === 'unreadable-storage') await chmod(filename(fixture), 0o640)
    else {
      const database = new DatabaseSync(filename(fixture))
      try {
        if (fault === 'missing-baseline') assert.equal(database.prepare("DELETE FROM durable_records WHERE namespace='native-chat.configuration-baselines'").run().changes, 1)
        else if (fault === 'invalid-identity') database.prepare("UPDATE durable_records SET value=? WHERE namespace='native-chat.meta' AND key='session-definition'")
          .run(JSON.stringify({ identity: 'not-a-hash' }))
        else assert.equal(database.prepare("UPDATE durable_records SET value=? WHERE namespace='native-chat.configuration-baselines'")
          .run(JSON.stringify({ schema: 1, values: {} })).changes, 1)
      } finally { database.close() }
    }
    try {
      const before = records(fixture)
      const blocked = await fixture.status()
      const compatibility = object(blocked.configurationCompatibility)
      assert.equal(blocked.canStart, false)
      if (fault === 'unreadable-storage') {
        assert(Array.isArray(blocked.configurationIssues) && blocked.configurationIssues.includes('persisted_configuration_unavailable'))
      }
      assert.equal(compatibility.state, fault === 'invalid-identity' || fault === 'unreadable-storage' ? 'unavailable' : 'blocked')
      const original = await fixture.api('/api/chat/runtime/baseline')
      assert.equal(original.state, fault === 'missing-baseline' || fault === 'invalid-identity' ? 'missing'
        : fault === 'unreadable-storage' ? 'unavailable' : 'invalid')
      assert.equal(original.unavailableReason, fault === 'missing-baseline' || fault === 'invalid-identity' ? 'not-recorded'
        : fault === 'unreadable-storage' ? 'storage-unavailable' : 'invalid-record')
      assert.equal(original.values, null)
      assert.equal(original.capturedAt, null)
      assert.equal(object(compatibility.recovery).automaticRestoreAvailable, false)
      assert.equal(object(compatibility.recovery).forwardMigrationAvailable, false)
      await fixture.start(503)
      assert.deepEqual(records(fixture), before)
      assert.deepEqual(await fixture.api('/api/chat/runtime/baseline'), original)
      assert.equal(fixture.controls.creates, 1)
      assert.equal(prompts(fixture).length, 1)
      if (fault !== 'unreadable-storage') assert.deepEqual(await session(fixture), first)
      assert.deepEqual(fixture.errors, [])
    } finally { if (fault === 'unreadable-storage') await chmod(filename(fixture), 0o600) }
  })
}

test('default baseline is authenticated, readonly and absent before a verified start', async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await fixture.api('/api/chat/runtime/baseline', undefined, 401, false)
  await fixture.login()
  assert.deepEqual(await fixture.api('/api/chat/runtime/baseline'), {
    schema: 1, state: 'missing', capturedAt: null, values: null, unavailableReason: 'not-recorded',
  })
  await fixture.api('/api/chat/runtime/baseline?guess=1', undefined, 400)
  await fixture.api('/api/chat/runtime/baseline', {}, 405)
  await assert.rejects(lstat(filename(fixture)), { code: 'ENOENT' })
  assert.equal(fixture.controls.creates, 0)
  assert.equal(prompts(fixture).length, 0)
})

test('default manual original-value recovery preserves an unknown execution and never retries its prompt or refills delegation',
  { timeout: 90_000 }, async context => {
    const fixture = await createNativeCapabilityRuntimeFixture(context)
    await initiallyConfigured(fixture, true)
    fixture.controls.promptUnknown = true
    fixture.inbound(1)
    await until(async () => Number(object((await fixture.status()).ingress).unknown) === 1, 'Expected actual unknown admission')
    assert.equal(prompts(fixture).length, 1)
    const first = await session(fixture)
    const original = await baseline(fixture)
    const before = grants(fixture)
    await fixture.api('/api/chat/runtime/stop', {})
    await changePlan(fixture, plan => ({ ...plan, contextLimits: { group: 100_000, private: 110_000 } }))
    await fixture.approve()
    await verifiedProfile(fixture)
    assert.equal(object((await fixture.status()).configurationCompatibility).state, 'blocked')
    await fixture.start(503)
    await restore(fixture, original)
    assert.equal(object((await fixture.status()).configurationCompatibility).state, 'compatible')
    await fixture.start()
    fixture.controls.promptUnknown = false
    fixture.inbound(2)
    await until(async () => {
      const ingress = object((await fixture.status()).ingress)
      return Number(ingress.received) === 2 && Number(ingress.rejected) + Number(ingress.unknown) === 2
    }, 'Expected unknown session to refuse a new prompt after restart')
    assert.equal(prompts(fixture).length, 1)
    assert.equal(fixture.controls.creates, 1)
    assert.deepEqual(await session(fixture), first)
    assert.deepEqual(grants(fixture), before)
    const executions = await fixture.api('/api/chat/executions')
    assert(Array.isArray(executions.items))
    assert(executions.items.map(object).some(item => item.status === 'unknown' && object(item.binding).sessionId === first.sessionId))
    assert.deepEqual(fixture.errors, [])
  })

test('pure default fixture accepts a structural browser lifecycle and closes idempotently without a fake TestContext', async () => {
  const cleanups: Array<() => void | Promise<void>> = []
  try {
    const fixture = await createNativeCapabilityRuntimeFixture({ after(cleanup) { cleanups.push(cleanup) } })
    assert.match(fixture.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    await fixture.login()
    const original = fixture.origin
    await fixture.reopen()
    assert.notEqual(fixture.origin, original)
    assert.equal((await fixture.api('/api/chat/runtime/baseline')).state, 'missing')
    await fixture.close()
    await fixture.close()
    await assert.rejects(fetch(`${fixture.origin}/api/chat/runtime`, { signal: AbortSignal.timeout(1000) }))
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
  }
})
