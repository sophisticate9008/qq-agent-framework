import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { capabilityObject as object, capabilityUntil as until, createNativeCapabilityRuntimeFixture } from './fixtures/native-capability-runtime.ts'

type Fixture = Awaited<ReturnType<typeof createNativeCapabilityRuntimeFixture>>
const prompts = (fixture: Fixture) => fixture.calls.filter(call => call.method === 'session/prompt')
const toolSchemas = () => [{ name: 'operator.search', description: 'Synthetic inventory; no real external tool is executed.',
  parameters: { type: 'object', properties: {}, additionalProperties: false } }]
function records(fixture: Fixture, namespace: string) {
  const database = new DatabaseSync(join(fixture.directory, 'runtime/native-chat.sqlite'), { readOnly: true })
  try { return database.prepare('SELECT key,value FROM durable_records WHERE namespace = ? ORDER BY key').all(namespace)
    .map(row => ({ key: String(row.key), value: object(JSON.parse(String(row.value))) })) }
  finally { database.close() }
}
const grants = (fixture: Fixture) => records(fixture, 'policy.grants').map(row => row.value)
async function fresh(fixture: Fixture, capabilities = false) {
  await fixture.login()
  await fixture.configure(capabilities)
  await rm(join(fixture.directory, 'runtime/chat-authorization.json'))
  await fixture.save('access', { allow: ['private:123', 'group:456'], deny: [], owner: null })
}
async function deploy(fixture: Fixture, capabilities = false) {
  if (capabilities) await fixture.approve()
  assert.equal((await fixture.apply()).state, 'verified')
  assert.equal((await fixture.start()).chatReady, true)
}
async function round(fixture: Fixture, id: number, conversation: 'private' | 'group' = 'private') {
  const before = prompts(fixture).length
  const sends = fixture.sends.length
  fixture.inbound(id, conversation)
  await until(() => prompts(fixture).length === before + 1, 'Expected actual unmetered native prompt')
  const sessionId = String(prompts(fixture).at(-1)!.input.sessionId)
  const turn = prompts(fixture).filter(call => call.input.sessionId === sessionId).length
  const stream = fixture.streams.findLast(stream => stream.sessionId === sessionId && stream.socket.readyState === 1)!
  fixture.event('turn/start', { turn }, stream)
  fixture.event('assistant/message', { turn, message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic default-access final.' }] } }, stream)
  fixture.event('turn/end', { turn, reason: { kind: 'completed' } }, stream)
  await until(() => fixture.sends.length === sends + 1, 'Expected confirmed final-only native reply')
  return sessionId
}

test('default factory materializes whitelist only on explicit start; non-owner nonempty DSH scope prompts without delegate quotas and survives restart',
  { timeout: 60_000 }, async context => {
    const fixture = await createNativeCapabilityRuntimeFixture(context, { evidenceRoot: process.env.NATIVE_ACCESS_EVIDENCE })
    await fresh(fixture, true)
    await fixture.save('access', { allow: ['private:123', 'group:456'], deny: [], owner: '9999' })
    fixture.controls.schemas = toolSchemas()
    const auth = await fixture.api('/api/chat/authorization')
    assert.equal(auth.modeSource, 'new-default-whitelist')
    assert.equal(auth.whitelistAvailable, true)
    assert.equal(auth.mode, 'whitelist')
    await fixture.status()
    await assert.rejects(readFile(join(fixture.directory, 'runtime/chat-authorization.json')), { code: 'ENOENT' })
    await assert.rejects(readFile(join(fixture.directory, 'runtime/native-chat.sqlite')), { code: 'ENOENT' })
    await deploy(fixture, true)
    const disk = object(JSON.parse(await readFile(join(fixture.directory, 'runtime/chat-authorization.json'), 'utf8')))
    assert.equal(object(disk.authorization).mode, 'whitelist')
    const initial = grants(fixture)
    assert(initial.every(grant => object(grant.maxUses)['agent.submit'] === null && object(grant.maxUses)['messaging.send'] === null))
    assert(initial.every(grant => Array.isArray(grant.capabilities) && !grant.capabilities.includes('agent.tools.delegate')))
    const privateSession = await round(fixture, 1)
    const groupSession = await round(fixture, 2, 'group')
    const inspected = fixture.trace.filter(row => row.kind === 'scope')
    assert.equal(inspected.length, 2)
    assert(inspected.every(row => row.names?.includes('operator.search') && row.externalToolAuthorizationVerified === false))
    assert.equal(object((await fixture.status()).toolDelegation).requiredForOrdinaryChat, false)
    assert.equal((await fixture.status()).taskDelegationAvailable, false)
    fixture.controls.schemas = [{ ...toolSchemas()[0]!, description: 'Actual observed schema drift.' }]
    fixture.inbound(3)
    await until(async () => {
      const status = await fixture.status()
      return status.lastError === 'NATIVE_CHAT_TOOL_SCOPE_CHANGED'
        && object(object(status.ingress).lastReceipt).errorCode === 'AGENT_UNKNOWN'
    }, 'Inventory drift must still fail closed with its native fault and bounded-agent receipt')
    assert.equal(fixture.trace.filter(row => row.kind === 'scope').at(-1)!.state, 'unverified')
    assert.equal(prompts(fixture).length, 2)
    await fixture.api('/api/chat/runtime/stop', {})
    const stopped = grants(fixture)
    fixture.controls.schemas = toolSchemas()
    await fixture.start()
    assert.deepEqual(grants(fixture), stopped)
    assert.equal(await round(fixture, 4), privateSession)
    const sessions = await fixture.api('/api/chat/sessions')
    assert(JSON.stringify(sessions).includes(groupSession))
    assert.equal(fixture.controls.creates, 2)
    assert.deepEqual(fixture.errors, [])
    console.log(JSON.stringify({ kind: 'whitelist-nonowner-tools', newDefaultAuthorization: auth,
      storedAuthorization: await fixture.api('/api/chat/authorization'), privateSession, groupSession,
      nonemptyScopeChecks: inspected.length, creates: fixture.controls.creates, prompts: prompts(fixture).length,
      grants: grants(fixture), externalToolAuthorizationVerified: false }))
  })

test('default whitelist denies outside and denied conversations without filtering group members by private allow entries', { timeout: 45_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await fresh(fixture)
  await fixture.save('access', { allow: ['private:777', 'group:456'], deny: [], owner: null })
  await deploy(fixture)
  await round(fixture, 1, 'group')
  await fixture.api('/api/chat/runtime/stop', {})
  await fixture.save('access', { allow: ['private:777'], deny: ['group:456'], owner: null })
  await fixture.start()
  fixture.inbound(2, 'group')
  fixture.inbound(3)
  await until(async () => Number(object((await fixture.status()).ingress).rejected) >= 2, 'Deny/outside must reject before sessions')
  assert.equal(object(object((await fixture.status()).ingress).lastReceipt).errorCode, 'NATIVE_CHAT_ACCESS_DENIED')
  assert.equal(prompts(fixture).length, 1)
  assert.equal(fixture.controls.creates, 1)
  assert.deepEqual(grants(fixture).filter(grant => grant.active).map(grant => grant.conversationId), ['private:777'])
})

test('explicit CAS migration from exhausted counted preserves raw backup, old budgets, session and unknown isolation without version rollback or replay',
  { timeout: 90_000 }, async context => {
    const fixture = await createNativeCapabilityRuntimeFixture(context, { evidenceRoot: process.env.NATIVE_ACCESS_EVIDENCE })
    await fixture.login()
    await fixture.configure(true)
    const oldAuthorization = { version: 'legacy-exhausted', grants: ['private:123', 'group:456'].map(conversationId => ({
      conversationId, submitUses: 1, sendUses: 1, toolDelegationUses: 1, expiresAt: null })) }
    await fixture.save('authorization', oldAuthorization)
    fixture.controls.schemas = toolSchemas()
    await deploy(fixture, true)
    const sessionId = await round(fixture, 1)
    fixture.inbound(2)
    await until(async () => object(object((await fixture.status()).ingress).lastReceipt).errorCode === 'BUDGET_EXHAUSTED', 'Legacy counted quota must remain exhausted')
    assert.equal(prompts(fixture).length, 1)
    await fixture.api('/api/chat/runtime/stop', {})
    const oldGrants = grants(fixture)
    const filename = join(fixture.directory, 'runtime/chat-authorization.json')
    const original = await readFile(filename)
    const auth = await fixture.api('/api/chat/authorization')
    assert.equal(auth.mode, 'counted')
    assert.equal(auth.modeSource, 'legacy-counted')
    const body = { revision: auth.revision, version: 'whitelist-v2', mode: 'whitelist', grants: [] }
    await fixture.api('/api/chat/authorization', body, 401, false)
    await fixture.api('/api/chat/authorization', { ...body, version: oldAuthorization.version }, 409)
    await fixture.api('/api/chat/authorization', { ...body, revision: '0'.repeat(64) }, 409)
    const migrated = await fixture.api('/api/chat/authorization', body)
    assert.equal(migrated.mode, 'whitelist')
    assert.deepEqual(await readFile(join(fixture.directory, `runtime/chat-authorization-backups/${auth.revision}.json`)), original)
    assert.deepEqual(grants(fixture), oldGrants)
    await fixture.start()
    for (const old of oldGrants) {
      const retained = grants(fixture).find(grant => grant.id === old.id)!
      assert.equal(retained.active, false)
      assert.deepEqual(retained.used, old.used)
      assert.deepEqual(retained.maxUses, old.maxUses)
    }
    assert.equal(await round(fixture, 3), sessionId)
    await fixture.api('/api/chat/authorization', { revision: migrated.revision, mode: 'counted', ...oldAuthorization }, 409)
    fixture.inbound(4)
    await until(() => prompts(fixture).length === 3, 'Expected controlled accepted unanswered prompt')
    await fixture.api('/api/chat/runtime/stop', {})
    const stoppedJournal = await fixture.api('/api/chat/executions')
    assert(Array.isArray(stoppedJournal.items))
    const unknown = stoppedJournal.items.map(object).find(row => row.status === 'unknown')!
    assert(unknown)
    const stopped = grants(fixture)
    await fixture.start()
    assert.deepEqual(grants(fixture), stopped)
    assert.equal(prompts(fixture).length, 3)
    fixture.inbound(5)
    await until(async () => object(object((await fixture.status()).ingress).lastReceipt).status === 'rejected', 'Unknown same session must remain isolated')
    assert.equal(prompts(fixture).length, 3)
    const journal = await fixture.api('/api/chat/executions')
    assert(Array.isArray(journal.items) && journal.items.some(raw => object(raw).status === 'unknown' && object(raw).isolated === true))
    const restored = journal.items.map(object).find(row => row.id === unknown.id)!
    assert.deepEqual(restored.binding, unknown.binding)
    assert.equal(restored.deadlineAt, unknown.deadlineAt)
    assert.equal(fixture.controls.creates, 1)
    console.log(JSON.stringify({ kind: 'counted-whitelist-migration', countedAuthorization: auth,
      migrationRequest: body, migrated, sessionId, retainedOldGrants: oldGrants.length,
      unknownRecord: unknown.id, prompts: prompts(fixture).length, creates: fixture.controls.creates }))
  })

for (const cancelOnTimeout of [true, false]) test(`default whitelist timeout cancel is scoped and single-attempt only when saved cancelOnTimeout=${cancelOnTimeout}`,
  { timeout: 45_000 }, async context => {
    const fixture = await createNativeCapabilityRuntimeFixture(context, { evidenceRoot: process.env.NATIVE_ACCESS_EVIDENCE })
    await fresh(fixture)
    const execution = object((await fixture.api('/api/chat/execution')).policy)
    await fixture.save('execution', { policy: { ...execution, turnTimeoutMs: 1200, cancelTimeoutMs: 300,
      noticeTimeoutMs: 300, noticeEnabled: false, cancelOnTimeout } })
    await deploy(fixture)
    assert(grants(fixture).every(grant => Object.hasOwn(object(grant.maxUses), 'agent.cancel') === cancelOnTimeout))
    fixture.inbound(1)
    await until(() => prompts(fixture).length === 1, 'Expected accepted scoped execution')
    const sessionId = String(prompts(fixture)[0]!.input.sessionId)
    await until(async () => {
      const journal = await fixture.api('/api/chat/executions')
      return Array.isArray(journal.items) && journal.items.some(raw => object(raw).deadlineReached === true
        && (!cancelOnTimeout || object(raw).cancelStatus === 'accepted'))
    }, 'Expected native timeout and configured cooperative cancel decision')
    const cancellations = () => fixture.calls.filter(call => call.method === 'session/cancel')
    assert.equal(cancellations().length, cancelOnTimeout ? 1 : 0)
    assert(cancellations().every(call => call.input.sessionId === sessionId))
    const journal = await fixture.api('/api/chat/executions')
    assert(Array.isArray(journal.items) && journal.items.some(raw => object(raw).isolated === true))
    const before = grants(fixture)
    await fixture.api('/api/chat/runtime/stop', {})
    await fixture.start()
    assert.deepEqual(grants(fixture), before)
    assert.equal(cancellations().length, cancelOnTimeout ? 1 : 0)
    assert.equal(prompts(fixture).length, 1)
    assert.equal(fixture.controls.creates, 1)
    console.log(JSON.stringify({ kind: 'whitelist-cancel', cancelOnTimeout, cancellations: cancellations(),
      grants: grants(fixture), acceptedIsNotTerminal: true }))
  })

test('saved cancel policy true-false-true creates distinct scoped whitelist grants without reviving old grants or changing sessions', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await fresh(fixture)
  await deploy(fixture)
  const first = grants(fixture).filter(grant => grant.active)
  assert(first.every(grant => object(grant.maxUses)['agent.cancel'] === null))
  await fixture.api('/api/chat/runtime/stop', {})
  const execution = object((await fixture.api('/api/chat/execution')).policy)
  await fixture.save('execution', { policy: { ...execution, cancelOnTimeout: false } })
  await fixture.start()
  const second = grants(fixture).filter(grant => grant.active)
  assert(second.every(grant => !Object.hasOwn(object(grant.maxUses), 'agent.cancel')))
  assert(second.every(grant => !first.some(old => old.id === grant.id)))
  await fixture.api('/api/chat/runtime/stop', {})
  await fixture.save('execution', { policy: { ...execution, cancelOnTimeout: true } })
  await fixture.start()
  const third = grants(fixture).filter(grant => grant.active)
  assert(third.every(grant => object(grant.maxUses)['agent.cancel'] === null))
  assert(third.every(grant => !first.some(old => old.id === grant.id) && !second.some(old => old.id === grant.id)))
  assert.equal(grants(fixture).filter(grant => !grant.active).length, first.length + second.length)
  assert.equal(fixture.controls.creates, 0)
  assert.equal(prompts(fixture).length, 0)
})

test('default whitelist policy audit write failure rejects before any DSH session or prompt instead of bypassing null policy', { timeout: 45_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await fresh(fixture)
  await deploy(fixture)
  const before = grants(fixture)
  const database = new DatabaseSync(join(fixture.directory, 'runtime/native-chat.sqlite'))
  try {
    database.exec("CREATE TRIGGER fail_whitelist_audit BEFORE UPDATE ON durable_records WHEN OLD.namespace = 'policy.grants' BEGIN SELECT RAISE(ABORT, 'synthetic-whitelist-audit-failure'); END")
    fixture.inbound(1)
    await until(async () => {
      const receipt = object((await fixture.status()).ingress).lastReceipt
      return receipt !== null && typeof receipt === 'object' && object(receipt).errorCode === 'STORE_IO_ERROR'
    },
      'Actual null policy audit storage failure must reject')
    assert.equal(prompts(fixture).length, 0)
    assert.equal(fixture.controls.creates, 0)
    assert.equal(fixture.sends.length, 0)
    assert.deepEqual(grants(fixture), before)
  } finally { database.exec('DROP TRIGGER fail_whitelist_audit'); database.close() }
})
