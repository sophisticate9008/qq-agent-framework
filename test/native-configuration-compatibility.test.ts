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
  assert.equal((await fixture.reply('Synthetic compatibility final.', stream)).status, 'confirmed')
  fixture.event('turn/end', { turn, reason: { kind: 'completed' } }, stream)
  await until(() => fixture.sends.length === sent + 1, 'Expected real final-only OneBot reply')
  await until(async () => {
    const page = await fixture.api('/api/chat/executions')
    return Array.isArray(page.items) && page.items.map(object).filter(item => item.status === 'completed').length === count + 1
  }, 'Expected persisted completed turn')
  return session(fixture)
}

async function verifiedProfile(fixture: Fixture) {
  const applied = await fixture.apply()
  assert.equal(applied.state, 'verified', JSON.stringify({ applied, errors: fixture.errors, calls: fixture.calls.slice(-12) }))
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

for (const scenario of cases) test(`explicitly applying ${scenario.name} retains the existing session and authorization usage`,
  { timeout: 90_000 }, async context => {
    const fixture = await createNativeCapabilityRuntimeFixture(context)
    await initiallyConfigured(fixture, scenario.selected)
    const first = await round(fixture, 1)
    const original = await baseline(fixture)
    const authorization = await fixture.api('/api/chat/authorization')
    await fixture.api('/api/chat/runtime/stop', {})
    await scenario.mutate(fixture)
    await verifiedProfile(fixture)
    const before = records(fixture)
    const ready = await fixture.status()
    assert.equal(ready.canStart, true, JSON.stringify(ready))
    assert.equal(object(ready.configurationCompatibility).state, 'compatible')
    assert.deepEqual(records(fixture), before, 'status reads do not apply configuration')
    assert.equal((await fixture.start()).chatReady, true)
    assert.equal(fixture.controls.creates, 1)
    assert.equal(prompts(fixture).length, 1, 'starting does not replay old work')
    assert.deepEqual(await round(fixture, 2), first)
    assert.equal(fixture.controls.creates, 1)
    assert.deepEqual(await fixture.api('/api/chat/authorization'), authorization)
    const grant = grants(fixture).find(row => row.featureId === 'agent-relay' && row.conversationId === 'private:123')!
    assert.equal(object(grant.used)['agent.submit'], 2)
    assert.equal(object(grant.used)['messaging.send'], 0)
    assert.equal(grants(fixture).filter(row => row.featureId === 'framework-tools' && row.conversationId === 'private:123')
      .reduce((sum, row) => sum + Number(object(row.used)['messaging.send'] ?? 0), 0), 2)
    assert.notEqual((await baseline(fixture)).capturedAt, original.capturedAt)
    assert.deepEqual(fixture.errors, [])
  })

for (const fault of ['missing-baseline', 'invalid-baseline', 'invalid-identity', 'unreadable-storage'] as const) {
  test(`configuration recovery handles ${fault} without recreating a session or replaying its prompt`, { timeout: 90_000 }, async context => {
    const fixture = await createNativeCapabilityRuntimeFixture(context)
    await initiallyConfigured(fixture)
    const first = await round(fixture, 1)
    await fixture.api('/api/chat/runtime/stop', {})
    if (fault === 'unreadable-storage') await chmod(filename(fixture), 0o640)
    else {
      const database = new DatabaseSync(filename(fixture))
      try {
        if (fault === 'missing-baseline') database.prepare("DELETE FROM durable_records WHERE namespace='native-chat.configuration-baselines'").run()
        else if (fault === 'invalid-identity') database.prepare("UPDATE durable_records SET value=? WHERE namespace='native-chat.meta' AND key='session-definition'").run(JSON.stringify({ identity: 'not-a-hash' }))
        else database.prepare("UPDATE durable_records SET value=? WHERE namespace='native-chat.configuration-baselines'").run(JSON.stringify({ schema: 1, values: {} }))
      } finally { database.close() }
    }
    try {
      const before = records(fixture)
      assert.equal((await fixture.status()).canStart, false)
      await fixture.start(503)
      assert.deepEqual(records(fixture), before)
      assert.equal(fixture.controls.creates, 1)
      assert.equal(prompts(fixture).length, 1)
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

test('configuration application keeps unknown execution evidence isolated without prompt replay', { timeout: 90_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await initiallyConfigured(fixture, true)
  fixture.controls.promptUnknown = true
  fixture.inbound(1)
  await until(async () => Number(object((await fixture.status()).ingress).unknown) === 1, 'Expected unknown admission')
  await fixture.api('/api/chat/runtime/stop', {})
  await changePlan(fixture, plan => ({ ...plan, contextLimits: { group: 100_000, private: 110_000 } }))
  await verifiedProfile(fixture)
  await fixture.start()
  fixture.controls.promptUnknown = false
  fixture.inbound(2)
  await until(async () => Number(object((await fixture.status()).ingress).received) === 2, 'Next input must remain queued')
  assert.equal(prompts(fixture).length, 1)
  assert.equal(fixture.controls.creates, 1)
  const executions = await fixture.api('/api/chat/executions')
  assert(Array.isArray(executions.items) && executions.items.some(raw => object(raw).status === 'unknown'))
})
