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
  assert.equal((await fixture.reply('Synthetic configuration recovery final.', stream)).status, 'confirmed')
  fixture.event('turn/end', { turn, reason: { kind: 'completed' } }, stream)
  await until(() => fixture.sends.length === sendCount + 1, 'Expected final-only reply')
  await until(async () => {
    const executions = await fixture.api('/api/chat/executions')
    return Array.isArray(executions.items) && executions.items.some(raw => object(raw).status === 'completed')
  }, 'Expected completed execution')
  return sessionId
}

test('explicitly applying changed instructions preserves the session and records a credential-free current baseline', { timeout: 90_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await fixture.login(); await fixture.configure(false); await fixture.apply(); await fixture.start()
  await fixture.api('/api/chat/runtime/baseline', undefined, 401, false)
  await fixture.api('/api/chat/runtime/baseline?unexpected=1', undefined, 400)
  const sessionId = await round(fixture, 1)
  await fixture.api('/api/chat/runtime/stop', {})
  const plans = await fixture.api('/api/chat/plans')
  assert(Array.isArray(plans.plans))
  await fixture.save('plans', { activePlanId: plans.activePlanId, plans: plans.plans.map(raw => ({ ...object(raw), instructions: 'Explicitly applied new instructions.' })) })
  await fixture.apply()
  const before = rows(fixture)
  assert.equal((await fixture.status()).canStart, true)
  assert.deepEqual(rows(fixture), before)
  await fixture.start()
  assert.equal(await round(fixture, 2), sessionId)
  const baseline = await fixture.api('/api/chat/runtime/baseline')
  assert.equal(object(object(baseline.values).definition).instructions, 'Explicitly applied new instructions.')
  for (const secret of ['synthetic-model-key-never-used', 'fixture-onebot-http', 'fixture-onebot-ws', 'fixture-dsh-owner']) assert(!JSON.stringify(baseline).includes(secret))
  assert.equal(fixture.controls.creates, 1)
})

test('a saved persona display name is applied explicitly without inventing a session or refilling authorization', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await fixture.login(); await fixture.configure(false); await fixture.apply(); await fixture.start()
  const baseline = await fixture.api('/api/chat/runtime/baseline')
  const original = object(object(baseline.values).persona)
  await fixture.api('/api/chat/runtime/stop', {})
  await fixture.save('personas', { personas: [{ ...original, name: 'Changed before the first session' }] })
  await fixture.apply(); await fixture.start()
  assert.equal(fixture.controls.creates, 0)
  const current = await fixture.api('/api/chat/runtime/baseline')
  assert.equal(object(object(current.values).persona).name, 'Changed before the first session')
  await round(fixture, 1)
  const grant = rows(fixture).filter(row => row.namespace === 'policy.grants').map(row => object(JSON.parse(String(row.value))))
    .find(row => row.featureId === 'agent-relay' && row.conversationId === 'private:123')!
  assert.equal(object(grant.used)['agent.submit'], 1)
})
