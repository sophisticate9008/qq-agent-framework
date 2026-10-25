import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { capabilityObject as object, capabilityUntil as until, createNativeCapabilityRuntimeFixture } from './fixtures/native-capability-runtime.ts'

type Fixture = Awaited<ReturnType<typeof createNativeCapabilityRuntimeFixture>>
const prompts = (fixture: Fixture) => fixture.calls.filter(call => call.method === 'session/prompt')
function rows(fixture: Fixture) {
  const database = new DatabaseSync(join(fixture.directory, 'runtime/native-chat.sqlite'), { readOnly: true })
  try { return database.prepare('SELECT * FROM durable_records ORDER BY namespace,key').all() }
  finally { database.close() }
}
async function round(fixture: Fixture, messageId: number) {
  const promptCount = prompts(fixture).length
  const sendCount = fixture.sends.length
  fixture.inbound(messageId)
  await until(() => prompts(fixture).length === promptCount + 1, 'Expected a real native prompt')
  const sessionId = String(prompts(fixture).at(-1)!.input.sessionId)
  const stream = fixture.streams.findLast(value => value.sessionId === sessionId && value.socket.readyState === 1)!
  const turn = prompts(fixture).filter(call => call.input.sessionId === sessionId).length
  fixture.event('turn/start', { turn }, stream)
  fixture.event('assistant/message', { turn, message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic configuration recovery final.' }] } }, stream)
  fixture.event('turn/end', { turn, reason: { kind: 'completed' } }, stream)
  await until(() => fixture.sends.length === sendCount + 1, 'Expected final-only reply')
  await until(async () => {
    const executions = await fixture.api('/api/chat/executions')
    return Array.isArray(executions.items) && executions.items.some(raw => object(raw).status === 'completed')
  }, 'Expected completed execution')
  return sessionId
}

test('default existing-session precheck blocks incompatible configuration and a credential-free baseline restores the original session without refill', { timeout: 90_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await fixture.login()
  await fixture.configure(false)
  assert.equal((await fixture.apply()).state, 'verified')
  await fixture.start()
  await fixture.api('/api/chat/runtime/baseline', undefined, 401, false)
  await fixture.api('/api/chat/runtime/baseline?unexpected=1', undefined, 400)
  const sessionId = await round(fixture, 1)
  await fixture.api('/api/chat/runtime/stop', {})
  const plans = await fixture.api('/api/chat/plans')
  assert(Array.isArray(plans.plans))
  await fixture.save('plans', { activePlanId: plans.activePlanId, plans: plans.plans.map(raw => ({ ...object(raw), instructions: 'Changed incompatible instructions.' })) })
  assert.equal((await fixture.apply()).state, 'verified')
  const before = rows(fixture)
  const wireBefore = fixture.calls.length
  const blocked = await fixture.status()
  assert.equal(blocked.canStart, false)
  const compatibility = object(blocked.configurationCompatibility)
  assert.equal(compatibility.state, 'blocked')
  assert(compatibility.differences instanceof Array && compatibility.differences.includes('instructions'))
  assert.equal(object(compatibility.recovery).mode, 'restore-original-values')
  const baseline = await fixture.api('/api/chat/runtime/baseline')
  assert.equal(baseline.state, 'available')
  const values = object(baseline.values)
  assert.equal(object(values.definition).instructions, 'No implicit permissions.')
  const serialized = JSON.stringify(baseline)
  for (const secret of ['synthetic-model-key-never-used', 'fixture-onebot-http', 'fixture-onebot-ws', 'fixture-dsh-owner']) assert(!serialized.includes(secret))
  assert.deepEqual(rows(fixture), before)
  await fixture.start(503)
  assert.deepEqual(rows(fixture), before)
  assert.equal((await fixture.status()).canStart, false)
  assert.equal(fixture.controls.creates, 1)
  assert.equal(prompts(fixture).length, 1)
  const latestPlans = await fixture.api('/api/chat/plans')
  assert(Array.isArray(latestPlans.plans))
  await fixture.save('plans', { activePlanId: latestPlans.activePlanId,
    plans: latestPlans.plans.map(raw => ({ ...object(raw), instructions: object(values.definition).instructions })) })
  assert.equal((await fixture.apply()).state, 'verified')
  assert.equal((await fixture.status()).canStart, true)
  await fixture.start()
  assert.equal(await round(fixture, 2), sessionId)
  assert.equal(fixture.controls.creates, 1)
  const grants = rows(fixture).filter(row => row.namespace === 'policy.grants').map(row => object(JSON.parse(String(row.value))))
  const privateGrant = grants.find(grant => grant.conversationId === 'private:123')!
  assert.equal(object(privateGrant.maxUses)['agent.submit'], 20)
  assert.equal(object(privateGrant.used)['agent.submit'], 2)
  assert.equal(object(privateGrant.used)['messaging.send'], 2)
  assert(fixture.calls.length > wireBefore)
  assert.deepEqual(fixture.errors, [])
})

test('default persona name change before any session remains blocked and manually restoring its baseline keeps the original content scope and budgets', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await fixture.login()
  await fixture.configure(false)
  await fixture.apply()
  await fixture.start()
  assert.equal(fixture.controls.creates, 0)
  const baseline = await fixture.api('/api/chat/runtime/baseline')
  assert.equal(baseline.state, 'available')
  const originalPersona = object(object(baseline.values).persona)
  await fixture.api('/api/chat/runtime/stop', {})
  await fixture.save('personas', { personas: [{ ...originalPersona, name: 'Changed before the first session' }] })
  const before = rows(fixture)
  const status = await fixture.status()
  const compatibility = object(status.configurationCompatibility)
  assert.equal(status.canStart, false)
  assert.equal(compatibility.hasPersistedSessions, false)
  assert.equal(compatibility.state, 'blocked')
  assert(Array.isArray(compatibility.differences) && compatibility.differences.includes('persona.name'))
  await fixture.start(503)
  assert.deepEqual(rows(fixture), before)
  assert.deepEqual(await fixture.api('/api/chat/runtime/baseline'), baseline)
  await fixture.save('personas', { personas: [originalPersona] })
  await fixture.start()
  assert.deepEqual(await fixture.api('/api/chat/runtime/baseline'), baseline)
  assert.equal(fixture.controls.creates, 0)
  await round(fixture, 1)
  assert.equal(fixture.controls.creates, 1)
  const grant = rows(fixture).filter(row => row.namespace === 'policy.grants')
    .map(row => object(JSON.parse(String(row.value)))).find(value => value.conversationId === 'private:123')!
  assert.equal(object(grant.maxUses)['agent.submit'], 20)
  assert.equal(object(grant.used)['agent.submit'], 1)
})
