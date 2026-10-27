import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { capabilityObject as object, capabilityUntil as until, createNativeCapabilityRuntimeFixture } from './fixtures/native-capability-runtime.ts'

type Fixture = Awaited<ReturnType<typeof createNativeCapabilityRuntimeFixture>>

function prompts(fixture: Fixture) { return fixture.calls.filter(call => call.method === 'session/prompt') }

async function settled(fixture: Fixture, received: number, failures = received) {
  await until(async () => {
    const ingress = object((await fixture.status()).ingress)
    return Number(ingress.received) >= received && Number(ingress.rejected) + Number(ingress.unknown) >= failures
  }, 'Native admission did not settle')
}

async function deploy(fixture: Fixture, capabilities = true, toolDelegationUses?: number) {
  await fixture.login()
  await fixture.configure(capabilities, toolDelegationUses)
  if (capabilities) await fixture.approve()
  assert.equal((await fixture.apply()).state, 'verified')
  const resolved = await fixture.api('/api/chat/deployment/reconcile', { revisions: (await fixture.status()).revisions })
  assert.deepEqual(resolved.missingReasons, [])
  const started = await fixture.start()
  assert.equal(started.chatReady, true)
  assert.equal(started.modelExecutionVerified, false)
  return started
}

async function finish(fixture: Fixture, sends: number) {
  fixture.event('turn/start', { turn: 1 })
  fixture.event('assistant/message', { turn: 1, step: 1, message: { role: 'assistant',
    content: [{ type: 'text', text: 'Synthetic final answer.' }] } })
  fixture.event('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => fixture.sends.length === sends, 'Actual native final-only reply was not emitted')
}

test('default authenticated capability approval route persists the actual preview receipt and CAS before any native session', { timeout: 45_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await fixture.login()
  await fixture.configure()
  const before = await fixture.status()
  const prepared = await fixture.preview()
  const request = object(prepared.capabilityApprovalRequest)
  const body = { revisions: before.revisions, targetRevision: prepared.targetRevision, compositionRevision: request.compositionRevision, confirm: true }
  await fixture.api('/api/chat/capabilities/approval', body, 401, false)
  const approved = await fixture.api('/api/chat/capabilities/approval', body)
  const receipt = object(approved.approval)
  assert.deepEqual({ schema: receipt.schema, source: receipt.source, target: receipt.target, compositionRevision: receipt.compositionRevision }, request)
  assert.equal(receipt.authority, 'owner')
  assert.equal(receipt.externalTools, 'separate-runtime-authorization-required')
  await fixture.api('/api/chat/capabilities/approval', body, 409)
  const disk = object(JSON.parse(await readFile(join(fixture.directory, 'runtime/chat-deployment.json'), 'utf8')))
  assert.deepEqual(object(disk.deployment).capabilityApproval, receipt)
  assert.equal((await fixture.apply()).state, 'verified')
  const reconciled = await fixture.api('/api/chat/deployment/reconcile', { revisions: (await fixture.status()).revisions })
  assert.deepEqual(reconciled.missingReasons, [])
  assert.equal((await fixture.status()).canStart, true)
  assert.equal(fixture.controls.creates, 0)
  assert.equal(prompts(fixture).length, 0)
  assert(!fixture.calls.some(call => call.method === 'bridgePlugin/inspectScope'))
  assert.deepEqual(fixture.errors, [])
})

test('default gateway capability selection, authenticated owner receipt CAS and final profile reach new private and group prompt scope', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await fixture.login()
  await fixture.configure()
  const plans = await fixture.api('/api/chat/plans')
  assert(Array.isArray(plans.plans))
  const selection = object(object(plans.plans[0]).capabilitySelection)
  assert.equal(selection.schema, 1)
  const before = await fixture.status()
  const authorization = await fixture.api('/api/chat/authorization')
  const personas = await fixture.api('/api/chat/personas')
  const prepared = await fixture.preview()
  const request = object(prepared.capabilityApprovalRequest)
  const body = { revisions: before.revisions, targetRevision: prepared.targetRevision, compositionRevision: request.compositionRevision, confirm: true }
  await fixture.api('/api/chat/capabilities/approval', body, 401, false)
  const granted = await fixture.api('/api/chat/capabilities/approval', body)
  const receipt = object(granted.approval)
  assert.equal(receipt.authority, 'owner')
  assert.equal(receipt.externalTools, 'separate-runtime-authorization-required')
  assert.deepEqual(receipt.source, selection)
  assert.deepEqual(receipt.target, request.target)
  assert.equal(receipt.compositionRevision, request.compositionRevision)
  assert.equal(granted.requiresNewPreview, true)
  const saved = object(JSON.parse(await readFile(join(fixture.directory, 'runtime/chat-deployment.json'), 'utf8')))
  assert.deepEqual(object(saved.deployment).capabilityApproval, receipt)
  const previousRevisions = object(before.revisions)
  const approvedRevisions = object(granted.revisions)
  assert.deepEqual(Object.keys(approvedRevisions).sort(), Object.keys(previousRevisions).sort())
  for (const key of Object.keys(previousRevisions)) {
    if (key === 'deployment') assert.notEqual(approvedRevisions[key], previousRevisions[key])
    else assert.equal(approvedRevisions[key], previousRevisions[key])
  }
  await fixture.api('/api/chat/capabilities/approval', body, 409)
  assert.deepEqual(await fixture.api('/api/chat/authorization'), authorization)
  assert.deepEqual(await fixture.api('/api/chat/personas'), personas)
  assert.equal((await fixture.apply()).state, 'verified')
  const fresh = await fixture.preview()
  assert.equal(object(fresh.capabilityApprovalRequest).compositionRevision, request.compositionRevision)
  const profile = await readFile(fixture.profilePath, 'utf8')
  assert(profile.includes('@operator/mature-work'))
  assert.equal((await readdir(fixture.directory)).filter(filename => filename.includes('.qqaf-backup-')).length, 2)
  const started = await fixture.start()
  assert.equal(started.chatReady, true)
  fixture.inbound(1)
  await until(() => prompts(fixture).length === 1, 'Selected private capability did not reach prompt')
  await finish(fixture, 1)
  fixture.inbound(2, 'group')
  await until(() => prompts(fixture).length === 2, 'Selected group capability did not reach prompt')
  await finish(fixture, 2)
  assert.equal(fixture.controls.creates, 2)
  for (const prompt of prompts(fixture)) {
    const promptTrace = fixture.trace.find(entry => entry.kind === 'dsh' && entry.method === 'session/prompt' && entry.sessionId === prompt.input.sessionId)
    assert(promptTrace)
    const scope = fixture.trace.find(entry => entry.kind === 'scope' && entry.sessionId === prompt.input.sessionId && entry.sequence < promptTrace.sequence)
    assert(scope)
    assert.deepEqual(scope.names, [])
    assert.equal(scope.state, 'verified-scope')
    const create = fixture.calls.find(call => call.method === 'session/create' && call.input.agentPreset === fixture.agents.get(String(prompt.input.sessionId))?.ctx.preset)
    assert(create)
  }
  assert.deepEqual(fixture.errors, [])
})

test('default text-only path retains prompt compatibility without requiring a capability approval or scope lookup', { timeout: 45_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await deploy(fixture, false)
  fixture.inbound(1)
  await until(() => prompts(fixture).length === 1, 'Legacy text-only prompt was blocked')
  assert.equal(fixture.calls.filter(call => call.method === 'bridgePlugin/inspectScope').length, 0)
  assert.equal(object((await fixture.api('/api/chat/capabilities')).approval ?? {}).approvalId, undefined)
  assert.deepEqual(fixture.errors, [])
})

test('selected tools apply without separate approval and can start a whitelisted conversation', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await fixture.login(); await fixture.configure()
  assert.equal((await fixture.apply()).state, 'verified')
  assert.equal((await fixture.start()).chatReady, true)
  fixture.inbound(1)
  await until(() => prompts(fixture).length === 1, 'Expected prompt without separate tool approval')
  assert.equal(fixture.controls.creates, 1)
  assert.deepEqual(fixture.errors, [])
})

test('default pending-reload file mutation stays non-chat-ready and reconciles without a second write or implicit prompt', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await fixture.login()
  await fixture.configure()
  await fixture.approve()
  fixture.controls.loaded = false
  const applied = await fixture.apply()
  assert.equal(applied.state, 'pending_reload')
  assert.equal(typeof applied.backupId, 'string')
  const written = await readFile(fixture.profilePath, 'utf8')
  await fixture.start(503)
  assert.equal((await fixture.status()).chatReady, false)
  assert.equal(fixture.controls.creates, 0)
  fixture.controls.loaded = true
  const result = await fixture.api('/api/chat/deployment/reconcile', { revisions: (await fixture.status()).revisions })
  assert.deepEqual(result.missingReasons, [])
  assert.equal(await readFile(fixture.profilePath, 'utf8'), written)
  assert.equal((await readdir(fixture.directory)).filter(filename => filename.includes('.qqaf-backup-')).length, 2)
  assert.equal(prompts(fixture).length, 0)
  assert.deepEqual(fixture.errors, [])
})

test('default operator revocation freezes an existing native binding without replay, new session or extra prompt', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await deploy(fixture)
  fixture.inbound(1)
  await until(() => prompts(fixture).length === 1, 'Initial approved prompt missing')
  await finish(fixture, 1)
  const approval = object((await fixture.api('/api/chat/capabilities')).approval)
  await fixture.api('/api/chat/capabilities/revoke', { revisions: (await fixture.status()).revisions, approvalId: approval.approvalId, confirm: true })
  fixture.inbound(2)
  await settled(fixture, 2, 1)
  assert.equal(prompts(fixture).length, 1)
  assert.equal(fixture.controls.creates, 1)
  assert.equal((await fixture.status()).chatReady, false)
  assert.deepEqual(fixture.errors, [])
})

for (const mode of ['source-revision', 'source-read', 'source-ambiguous', 'live-plugins'] as const) {
  test(`default stable ${mode} drift after start blocks first session and prompt without rewriting files`, { timeout: 60_000 }, async context => {
    const fixture = await createNativeCapabilityRuntimeFixture(context)
    await deploy(fixture)
    const before = await readFile(fixture.profilePath, 'utf8')
    if (mode === 'source-revision') fixture.documents.set('operator-work', '[]')
    if (mode === 'source-read') fixture.controls.sourceReadFails = true
    if (mode === 'source-ambiguous') fixture.documents.set('operator-work', '- id: a\n  id: b\n')
    if (mode === 'live-plugins') fixture.controls.livePluginDrift = true
    fixture.inbound(1)
    await settled(fixture, 1)
    assert.equal(prompts(fixture).length, 0)
    assert.equal(fixture.controls.creates, 0)
    assert.equal(await readFile(fixture.profilePath, 'utf8'), before)
    assert.equal((await fixture.status()).chatReady, false)
    assert.deepEqual(fixture.errors, [])
  })
}

for (const mode of ['scope-read', 'scope-missing', 'scope-wrong-preset', 'scope-malformed'] as const) {
  test(`default selected capability ${mode} unknown cannot reach prompt after actual session creation`, { timeout: 60_000 }, async context => {
    const fixture = await createNativeCapabilityRuntimeFixture(context)
    await deploy(fixture)
    if (mode === 'scope-read') fixture.controls.scopeReadFails = true
    if (mode === 'scope-missing') fixture.controls.scopeUnavailable = true
    if (mode === 'scope-wrong-preset') fixture.controls.scopeWrongPreset = true
    if (mode === 'scope-malformed') fixture.controls.schemas = [{ notAName: true }]
    fixture.inbound(1)
    await until(async () => {
      const ingress = object((await fixture.status()).ingress)
      return Number(ingress.received) >= 1 && (Number(ingress.rejected) + Number(ingress.unknown) >= 1 || prompts(fixture).length > 0)
    }, 'Scope admission did not settle')
    assert.equal(fixture.controls.creates, 1)
    assert(fixture.calls.some(call => call.method === 'bridgePlugin/inspectScope'))
    assert.equal(prompts(fixture).length, 0)
    assert.deepEqual(fixture.errors, [])
  })
}

test('default prompt acceptance unknown isolates its actual native session and is not automatically resubmitted', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  fixture.controls.schemas = toolSchemas()
  await deploy(fixture, true, 1)
  fixture.controls.promptUnknown = true
  fixture.inbound(1)
  await settled(fixture, 1)
  assert.equal(prompts(fixture).length, 1)
  const sessionId = prompts(fixture)[0]!.input.sessionId
  fixture.inbound(2)
  await settled(fixture, 2)
  assert.equal(prompts(fixture).length, 1)
  assert.equal(fixture.controls.creates, 1)
  const executions = await fixture.api('/api/chat/executions')
  assert(Array.isArray(executions.items))
  assert(executions.items.some(raw => object(object(raw).binding).sessionId === sessionId && object(raw).status === 'unknown'))
  assert.deepEqual(fixture.errors, [])
})

const toolSchemas = () => [{ name: 'operator.work', description: 'Synthetic schema, no tool implementation is executed.',
  parameters: { type: 'object', properties: {}, additionalProperties: false } }]

test('whitelisted nonempty live scope needs no separate delegation quota', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  fixture.controls.schemas = toolSchemas()
  await deploy(fixture)
  const authorization = await fixture.api('/api/chat/authorization')
  assert(Array.isArray(authorization.grants))
  assert(authorization.grants.every(raw => !Object.hasOwn(object(raw), 'toolDelegationUses')))
  fixture.inbound(1)
  await until(async () => {
    const ingress = object((await fixture.status()).ingress)
    return Number(ingress.received) >= 1 && (Number(ingress.rejected) + Number(ingress.unknown) >= 1 || prompts(fixture).length > 0)
  }, 'Delegation admission did not settle')
  assert.equal(fixture.controls.creates, 1)
  assert(fixture.trace.some(entry => entry.kind === 'scope' && entry.names?.includes('operator.work')))
  assert.equal(prompts(fixture).length, 1)
  assert.deepEqual(fixture.errors, [])
})

test('default explicit finite delegate and submit grants allow one observed nonempty-scope prompt, not external tool execution authorization', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  fixture.controls.schemas = toolSchemas()
  await deploy(fixture, true, 1)
  const authorization = await fixture.api('/api/chat/authorization')
  assert.equal(authorization.toolDelegationAvailable, true)
  fixture.inbound(1)
  await until(() => prompts(fixture).length === 1, 'Explicit delegation did not permit prompt')
  const prompt = prompts(fixture)[0]!
  const promptTrace = fixture.trace.find(entry => entry.kind === 'dsh' && entry.method === 'session/prompt')!
  const scope = fixture.trace.find(entry => entry.kind === 'scope' && entry.sequence < promptTrace.sequence)!
  assert.deepEqual(scope.names, ['operator.work'])
  assert.equal(scope.state, 'verified-scope')
  assert.equal(scope.externalToolAuthorizationVerified, false)
  assert.equal(scope.declarationRevisionVerified, false)
  assert(fixture.selected.has(String(prompt.input.sessionId)))
  await finish(fixture, 1)
  fixture.inbound(2)
  await until(() => prompts(fixture).length === 2, 'Whitelist continues after an old finite quota')
  assert.equal(fixture.controls.creates, 1)
  assert.deepEqual(fixture.errors, [])
})

test('whitelisted tools retain the same session across completed rounds without changing authorization', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  fixture.controls.schemas = toolSchemas()
  await deploy(fixture)
  fixture.inbound(1)
  await until(() => prompts(fixture).length === 1, 'First prompt')
  await finish(fixture, 1)
  fixture.inbound(2)
  await until(() => prompts(fixture).length === 2, 'Second prompt')
  assert.equal(prompts(fixture)[0]!.input.sessionId, prompts(fixture)[1]!.input.sessionId)
  assert.equal(fixture.controls.creates, 1)
})

test('legacy zero submit quota does not block whitelist', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  fixture.controls.schemas = toolSchemas()
  await fixture.login()
  await fixture.configure(true, 2)
  const authorization = await fixture.api('/api/chat/authorization')
  assert(Array.isArray(authorization.grants))
  await fixture.save('authorization', { version: '2', grants: authorization.grants.map(raw => ({ ...object(raw), submitUses: 0 })) })
  await fixture.approve()
  assert.equal((await fixture.apply()).state, 'verified')
  await fixture.start()
  fixture.inbound(1)
  await until(() => prompts(fixture).length === 1, 'Legacy zero quota cannot block whitelist')
  assert.equal(fixture.controls.creates, 1)
  assert.equal(prompts(fixture).length, 1)
  assert.deepEqual(fixture.errors, [])
})

test('default live tool-schema drift on the same approved session blocks the next delegation despite remaining budgets', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  fixture.controls.schemas = toolSchemas()
  await deploy(fixture, true, 3)
  fixture.inbound(1)
  await until(() => prompts(fixture).length === 1, 'Initial delegate prompt missing')
  await finish(fixture, 1)
  fixture.controls.schemas = [{ ...toolSchemas()[0]!, description: 'Changed schema after the first actual prompt.' }]
  fixture.inbound(2)
  await settled(fixture, 2, 1)
  assert.equal(prompts(fixture).length, 1)
  assert.equal(fixture.controls.creates, 1)
  assert.deepEqual(fixture.errors, [])
})

test('default explicit authorization-version revocation blocks later delegation without a replacement session', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  fixture.controls.schemas = toolSchemas()
  await deploy(fixture, true, 3)
  fixture.inbound(1)
  await until(() => prompts(fixture).length === 1, 'Initial authorized prompt missing')
  await finish(fixture, 1)
  const authorization = await fixture.api('/api/chat/authorization')
  assert(Array.isArray(authorization.grants))
  await fixture.save('authorization', { version: '2', grants: authorization.grants.map(raw => ({ ...object(raw), toolDelegationUses: 0 })) })
  fixture.inbound(2)
  await settled(fixture, 2, 1)
  assert.equal(prompts(fixture).length, 1)
  assert.equal(fixture.controls.creates, 1)
  assert.equal((await fixture.status()).chatReady, false)
  assert.deepEqual(fixture.errors, [])
})

test('recreating only the synthetic default gateway factory preserves spent delegation budget and existing native binding', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  fixture.controls.schemas = toolSchemas()
  await deploy(fixture, true, 1)
  fixture.inbound(1)
  await until(() => prompts(fixture).length === 1, 'Initial budgeted prompt missing')
  await finish(fixture, 1)
  const authorization = await fixture.api('/api/chat/authorization')
  await fixture.reopen()
  assert.deepEqual(await fixture.api('/api/chat/authorization'), authorization)
  await until(async () => (await fixture.status()).chatReady === true, 'Persisted running intent must finish restoring before fresh admission')
  fixture.inbound(2)
  await until(() => prompts(fixture).length === 2, 'Restored whitelist remains usable')
  assert.equal(prompts(fixture).length, 2)
  assert.equal(fixture.controls.creates, 1)
  assert.deepEqual(fixture.errors, [])
})

test('selected capability scope RPC is cancelled within the original native admission deadline before any prompt', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  await fixture.login()
  await fixture.configure()
  const execution = await fixture.api('/api/chat/execution')
  await fixture.save('execution', { policy: { ...object(execution.policy), turnTimeoutMs: 1500 } })
  await fixture.approve()
  assert.equal((await fixture.apply()).state, 'verified')
  await fixture.start()
  fixture.controls.scopeHeld = true
  const admittedAt = Date.now()
  fixture.inbound(1)
  await until(() => fixture.calls.some(call => call.method === 'bridgePlugin/inspectScope'), 'Actual scope RPC never started')
  await settled(fixture, 1)
  await until(() => fixture.controls.scopeAborted === 1, 'Scope transport outlived original admission deadline')
  assert(Date.now() - admittedAt < 3500, 'Scope RPC used its independent timeout instead of the original admission deadline')
  assert.equal(prompts(fixture).length, 0)
  assert.equal(fixture.controls.creates, 1)
  assert.deepEqual(fixture.errors, [])
})
