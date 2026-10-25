import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createNativeExecutionController, DEFAULT_NATIVE_EXECUTION_POLICY, validateNativeExecutionPolicy,
  type NativeExecutionOptions, type NativeExecutionPolicy, type NativeTurnClaimReceipt } from '../src/host/native-execution.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import type { SessionBinding } from '../src/host/types.ts'
import { createNativeExecutionPolicyActions } from '../src/host/native-execution-actions.ts'
import { createPersistentPolicy } from '../src/storage/policy.ts'
import { createDurableTransport } from '../src/host/outbox.ts'

const binding: SessionBinding = { conversationId: 'private:123', sessionId: 'session-1', generation: 1 }
const revision = 'a'.repeat(64)
const accepted = async () => ({ status: 'accepted' as const })
const flush = async () => { await delay(0); await delay(0) }

function fixture(context: TestContext, overrides: Partial<Omit<NativeExecutionOptions, 'store' | 'clock'>> = {}) {
  const store = createSqliteStore({ filename: ':memory:' })
  let clock = 1_000_000
  const controller = createNativeExecutionController({ store, clock: () => clock, policy: policy(), ...overrides })
  context.after(async () => { await controller.stop(); store.close() })
  controller.start()
  return { controller, store, advance: (milliseconds: number) => { clock += milliseconds },
    admit: (requestId = 'request-1', scope = binding) => controller.admit({ binding: scope, requestId, policyRevision: revision }) }
}

function proof(requestId = 'request-1', scope = binding, turn = 8): NativeTurnClaimReceipt {
  return { kind: 'dsh.agent-inbox-claimed', sessionId: scope.sessionId, requestId, userMessageId: `message-${requestId}`,
    turn, evidenceId: `claim-${requestId}`, issuerEpoch: 'plugin-instance-1', receiptSeq: 1 }
}

function policy(overrides: Partial<NativeExecutionPolicy> = {}): NativeExecutionPolicy {
  return { ...DEFAULT_NATIVE_EXECUTION_POLICY, turnTimeoutMs: 60_000, noticeEnabled: true, ...overrides }
}

test('construction is inert, start explicit, default turn deadline is 120 seconds and validation is strict', async () => {
  const store = createSqliteStore({ filename: ':memory:' })
  const controller = createNativeExecutionController({ store })
  assert.equal(DEFAULT_NATIVE_EXECUTION_POLICY.turnTimeoutMs, 120_000)
  assert.equal(DEFAULT_NATIVE_EXECUTION_POLICY.noticeEnabled, false)
  assert.equal(store.stats().totalRecords, 0)
  assert.throws(() => controller.admit({ binding, requestId: 'request', policyRevision: revision }), { code: 'EXECUTION_NOT_STARTED' })
  assert.throws(() => validateNativeExecutionPolicy({ ...policy(), unknownHandling: 'replay' }), { code: 'EXECUTION_INVALID_POLICY' })
  assert.throws(() => validateNativeExecutionPolicy(policy({ noticeText: null })), { code: 'EXECUTION_INVALID_POLICY' })
  assert.throws(() => validateNativeExecutionPolicy({ ...policy(), extra: true }), { code: 'EXECUTION_INVALID_POLICY' })
  assert.equal(validateNativeExecutionPolicy(policy({ noticeEnabled: false, noticeText: null })).noticeText, null)
  await controller.stop()
  assert.throws(() => controller.start(), { code: 'EXECUTION_STOPPED' })
  store.close()
})

test('only exact trusted request-to-turn claim enables one delivery; FIFO and user-message receipt are not proof', async context => {
  const { controller, admit } = fixture(context)
  const execution = admit()
  await controller.submit(execution.id, accepted)
  controller.userMessage(execution.id, { eventId: 'user-1', messageId: 'message-request-1', source: { kind: 'user', rpcId: 'request-1' } })
  const final = { eventId: 'final-1', binding, turnId: '8', kind: 'completed' as const }
  assert.equal(controller.observe(execution.id, final).decision, 'unattributed')
  assert.throws(() => controller.claimed(execution.id, { ...proof(), requestId: 'other' }), { code: 'EXECUTION_CORRELATION_UNPROVEN' })
  assert.throws(() => controller.claimed(execution.id, { ...proof(), sessionId: 'other' }), { code: 'EXECUTION_CORRELATION_UNPROVEN' })
  controller.claimed(execution.id, proof())
  assert.equal(controller.observe(execution.id, { ...final, binding: { ...binding, generation: 2 } }).decision, 'unattributed')
  assert.equal(controller.observe(execution.id, final).decision, 'deliver')
  assert.equal(controller.observe(execution.id, final).decision, 'duplicate')
  assert.equal(controller.observe(execution.id, { ...final, eventId: 'final-2' }).decision, 'record-only')
  assert.equal(controller.get(execution.id)?.isolated, false)
  assert.notEqual(admit('request-2').id, execution.id)
})

test('an exact final arriving before the prompt HTTP acknowledgement is attributed without a second delivery', async context => {
  const { controller, admit } = fixture(context)
  const execution = admit()
  const submitted = controller.submit(execution.id, async () => {
    controller.claimed(execution.id, proof())
    assert.equal(controller.observe(execution.id, { eventId: 'early-final', binding, turnId: '8', kind: 'completed' }).decision, 'deliver')
    return { status: 'accepted' }
  })
  assert.equal((await submitted).status, 'completed')
  assert.equal(controller.get(execution.id)?.externalStatus, 'completed')
})

test('continuous progress cannot extend the persisted sixty-second total deadline', async context => {
  let notices = 0
  let cancels = 0
  const { controller, admit, advance } = fixture(context, {
    cancel: async request => { assert.equal(request.execution.deadlineReached, true); cancels++; return { status: 'accepted' } },
    notify: async request => { assert.equal(request.execution.deadlineReached, true); notices++; return { status: 'confirmed', messageId: 'timeout-notice' } }
  })
  const execution = admit()
  await controller.submit(execution.id, accepted)
  controller.claimed(execution.id, proof())
  for (let progress = 1; progress <= 60; progress++) {
    advance(1_000)
    controller.observe(execution.id, { eventId: `progress-${progress}`, binding, turnId: '8', kind: 'progress' })
    assert.equal(controller.get(execution.id)?.deadlineAt, execution.admittedAt + 60_000)
  }
  await flush()
  const result = controller.get(execution.id)!
  assert.equal(result.status, 'timed-out')
  assert.equal(result.cancelStatus, 'accepted')
  assert.equal(result.externalStatus, 'accepted')
  assert.equal(result.isolated, true)
  assert.equal(notices, 1)
  assert.equal(cancels, 1)
  controller.tick()
  await flush()
  assert.equal(notices, 1)
  assert.equal(cancels, 1)
  assert.throws(() => admit('next'), { code: 'EXECUTION_SESSION_ISOLATED' })
  const late = controller.observe(execution.id, { eventId: 'late-final', binding, turnId: '8', kind: 'completed' })
  assert.equal(late.decision, 'record-only')
  assert.equal(late.execution.isolated, true)
  const cancelled = controller.observe(execution.id, { eventId: 'cancel-confirmed', binding, turnId: '8', kind: 'cancelled' })
  assert.equal(cancelled.execution.cancelStatus, 'confirmed')
  assert.equal(cancelled.execution.isolated, false)
  assert.notEqual(admit('next').id, execution.id)
})

test('late correlated final is record-only and cannot contaminate the next request', async context => {
  const { controller, admit, advance } = fixture(context, { policy: policy({ cancelOnTimeout: false, noticeEnabled: false }) })
  const execution = admit()
  await controller.submit(execution.id, accepted)
  controller.claimed(execution.id, proof())
  advance(60_000)
  controller.tick()
  const late = controller.observe(execution.id, { eventId: 'late-final', binding, turnId: '8', kind: 'completed' })
  assert.equal(late.decision, 'record-only')
  assert.equal(late.execution.status, 'timed-out')
  assert.equal(late.execution.lateOutcome?.eventId, 'late-final')
  const next = admit('request-2')
  await controller.submit(next.id, accepted)
  assert.equal(controller.observe(next.id, { eventId: 'old-final', binding, turnId: '8', kind: 'completed' }).decision, 'unattributed')
  assert.equal(controller.get(next.id)?.status, 'running')
})

test('missing callbacks do not manufacture permissions, cancellation or a delivered notice', async context => {
  const { controller, admit, advance } = fixture(context)
  const execution = admit()
  await controller.submit(execution.id, accepted)
  advance(60_000)
  controller.tick()
  await flush()
  assert.equal(controller.get(execution.id)?.cancelStatus, 'unavailable')
  assert.equal(controller.get(execution.id)?.noticeStatus, 'unavailable')
  assert.equal(controller.get(execution.id)?.isolated, true)
})

test('policy flags disabled never invoke callbacks and an expired unsubmitted request never calls the model', async context => {
  let actions = 0
  const { controller, admit, advance } = fixture(context, {
    policy: policy({ cancelOnTimeout: false, noticeEnabled: false }),
    cancel: async () => { actions++; return { status: 'accepted' } },
    notify: async () => { actions++; return { status: 'unknown' } }
  })
  const execution = admit()
  advance(60_000)
  controller.tick()
  await assert.rejects(controller.submit(execution.id, async () => { actions++; return { status: 'accepted' } }), { code: 'EXECUTION_SUBMIT_BLOCKED' })
  assert.equal(controller.get(execution.id)?.externalStatus, 'rejected')
  assert.equal(controller.get(execution.id)?.isolated, false)
  assert.equal(actions, 0)
  assert.notEqual(admit('new-request').id, execution.id)
})

test('lost stream isolates its session; distinct conversation continues and reused external session is blocked', async context => {
  const { controller, admit } = fixture(context)
  const execution = admit()
  let submits = 0
  await controller.submit(execution.id, async () => { submits++; return { status: 'accepted' } })
  controller.lost(execution.id)
  assert.throws(() => admit('new-same'), { code: 'EXECUTION_SESSION_ISOLATED' })
  assert.throws(() => admit('new-other', { ...binding, conversationId: 'private:456' }), { code: 'EXECUTION_SESSION_ISOLATED' })
  await assert.rejects(controller.submit(execution.id, async () => { submits++; return { status: 'accepted' } }), { code: 'EXECUTION_SUBMIT_BLOCKED' })
  const different = admit('independent', { conversationId: 'private:789', sessionId: 'independent-session', generation: 1 })
  assert.equal((await controller.submit(different.id, accepted)).status, 'running')
  assert.equal(submits, 1)
})

test('raw half-open prompt remains bounded after logical timeout, with no automatic replay', async context => {
  const { controller, admit, advance } = fixture(context, { maxPendingOperations: 1,
    policy: policy({ noticeEnabled: false, cancelOnTimeout: false }) })
  const execution = admit()
  let submits = 0
  let acknowledge: (value: { status: 'accepted' }) => void = () => assert.fail('missing callback')
  const pending = controller.submit(execution.id, async () => {
    submits++
    return await new Promise<{ status: 'accepted' }>(resolve => { acknowledge = resolve })
  })
  advance(60_000)
  controller.tick()
  assert.equal((await pending).deadlineReached, true)
  assert.equal(controller.metrics().rawPending, 1)
  const independent = admit('other', { conversationId: 'private:456', sessionId: 'other-session', generation: 1 })
  await assert.rejects(controller.submit(independent.id, async () => { submits++; return { status: 'accepted' } }), { code: 'EXECUTION_BACKPRESSURE' })
  assert.equal(controller.get(independent.id)?.externalStatus, 'not-started')
  acknowledge({ status: 'accepted' })
  await flush()
  assert.equal(controller.metrics().rawPending, 0)
  assert.equal(controller.get(execution.id)?.status, 'timed-out')
  assert.equal(controller.get(execution.id)?.isolated, true)
  assert.equal(submits, 1)
  assert.equal((await controller.submit(independent.id, accepted)).status, 'running')
})

test('real process timer still expires if wall clock rolls backwards', async context => {
  const { controller, admit, advance } = fixture(context, { policy: policy({ turnTimeoutMs: 30, noticeEnabled: false, cancelOnTimeout: false }) })
  const execution = admit()
  await controller.submit(execution.id, accepted)
  advance(-100)
  await delay(65)
  assert.equal(controller.get(execution.id)?.deadlineReached, true)
  assert.equal(controller.get(execution.id)?.status, 'timed-out')
})

test('concurrent stop is shared, bounded despite ignored cancellation, and late callbacks cannot access closed storage', async context => {
  const store = createSqliteStore({ filename: ':memory:' })
  const controller = createNativeExecutionController({ store, policy: policy({ noticeEnabled: false }) })
  controller.start()
  const execution = controller.admit({ binding, requestId: 'request-1', policyRevision: revision })
  let resolve: (value: { status: 'accepted' }) => void = () => assert.fail('missing callback')
  const submitted = controller.submit(execution.id, () => new Promise<{ status: 'accepted' }>(done => { resolve = done }))
  const first = controller.stop()
  assert.equal(controller.stop(), first)
  await first
  assert.equal((await submitted).status, 'unknown')
  assert.equal(controller.get(execution.id)?.isolated, true)
  store.close()
  resolve({ status: 'accepted' })
  await flush()
  context.assert.equal(controller.metrics().rawPending, 0)
})

test('durable restart retains original deadline and unknown isolation without repeating prompt, cancel or notice', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'native-execution-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  let store = createSqliteStore({ filename: join(directory, 'state.sqlite') })
  const original = createNativeExecutionController({ store, clock: () => 1_000_000, policy: policy() })
  original.start()
  const execution = original.admit({ binding, requestId: 'request-1', policyRevision: revision })
  await original.submit(execution.id, accepted)
  original.claimed(execution.id, proof())
  await original.stop()
  store.close()
  let externalCalls = 0
  store = createSqliteStore({ filename: join(directory, 'state.sqlite') })
  const restored = createNativeExecutionController({ store, clock: () => 1_060_000,
    cancel: async () => { externalCalls++; return { status: 'accepted' } },
    notify: async () => { externalCalls++; return { status: 'unknown' } } })
  context.after(async () => { await restored.stop(); store.close() })
  restored.start()
  await flush()
  assert.equal(restored.get(execution.id)?.deadlineAt, 1_060_000)
  assert.equal(restored.get(execution.id)?.status, 'unknown')
  assert.equal(restored.get(execution.id)?.deadlineReached, true)
  assert.throws(() => restored.admit({ binding, requestId: 'new-request', policyRevision: revision }), { code: 'EXECUTION_SESSION_ISOLATED' })
  await assert.rejects(restored.submit(execution.id, async () => { externalCalls++; return { status: 'accepted' } }), { code: 'EXECUTION_SUBMIT_BLOCKED' })
  assert.equal(externalCalls, 0)
  assert.equal(restored.observe(execution.id, { eventId: 'after-restart-final', binding, turnId: '8', kind: 'completed' }).decision, 'record-only')
})

test('recovery and stop use bounded active indices rather than scanning terminal execution history', async context => {
  const { controller, store, admit } = fixture(context)
  for (let index = 0; index < 100; index++) {
    const execution = admit(`request-${index}`)
    await controller.submit(execution.id, async () => ({ status: 'rejected' }))
  }
  await controller.stop()
  let reads = 0
  const bounded = createNativeExecutionController({ store: { ...store,
    list(namespace, query) { assert.notEqual(namespace, 'host.executions'); reads++; return store.list(namespace, query) }
  } })
  bounded.start()
  await bounded.stop()
  assert.equal(reads, 2)
})

test('request and evidence identities are immutable and cannot silently rebind a different user message or turn', async context => {
  const { controller, admit } = fixture(context)
  const execution = admit()
  assert.equal(admit().id, execution.id)
  assert.throws(() => controller.admit({ binding, requestId: 'request-1', policyRevision: 'b'.repeat(64) }), { code: 'EXECUTION_REQUEST_CONFLICT' })
  await controller.submit(execution.id, accepted)
  controller.claimed(execution.id, proof())
  assert.throws(() => controller.claimed(execution.id, { ...proof(), turn: 9 }), { code: 'EXECUTION_CORRELATION_CONFLICT' })
  assert.throws(() => controller.userMessage(execution.id, { eventId: 'user-other', messageId: 'other-message', source: { kind: 'user', rpcId: 'request-1' } }), { code: 'EXECUTION_CORRELATION_CONFLICT' })
  const event = { eventId: 'event-1', binding, turnId: '8', kind: 'progress' as const }
  controller.observe(execution.id, event)
  assert.throws(() => controller.observe(execution.id, { ...event, kind: 'completed' }), { code: 'EXECUTION_EVENT_CONFLICT' })
})

test('timeout notice consumes original messaging.send budget and cancel requires its own explicit durable grant', async context => {
  const store = createSqliteStore({ filename: ':memory:' })
  const grants = createPersistentPolicy({ store })
  const sent: string[] = []
  let cancels = 0
  const outbox = createDurableTransport({ store, transport: { async send(request) {
    sent.push(request.idempotencyKey)
    assert.equal(request.scope?.persona.version, 'persona-version')
    return { status: 'confirmed', messageId: `notice-${sent.length}` }
  } } })
  const actions = createNativeExecutionPolicyActions({ policy: grants, transport: outbox,
    persona: { id: 'native-persona', version: 'persona-version' }, guard: async () => {},
    cancel: async () => { cancels++ } })
  let clock = 1_000_000
  const controller = createNativeExecutionController({ store, clock: () => clock, policy: policy(), ...actions })
  controller.start()
  context.after(async () => { await controller.stop(); store.close() })
  grants.grant({ id: 'original-send-only', featureId: 'agent-relay', conversationId: binding.conversationId,
    capabilities: ['messaging.send'], maxUses: { 'messaging.send': 1 } })
  const first = controller.admit({ binding, requestId: 'request-1', policyRevision: revision })
  await controller.submit(first.id, accepted)
  controller.claimed(first.id, proof())
  clock += 60_000
  controller.tick()
  await flush()
  assert.equal(controller.get(first.id)?.cancelStatus, 'rejected')
  assert.equal(controller.get(first.id)?.noticeStatus, 'confirmed')
  assert.equal(cancels, 0)
  assert.equal(sent.length, 1)
  assert.equal(grants.describe().grants[0]?.used['messaging.send'], 1)
  controller.observe(first.id, { eventId: 'late-1', binding, turnId: '8', kind: 'completed' })
  grants.grant({ id: 'explicit-cancel-v2', featureId: 'agent-relay', conversationId: binding.conversationId,
    capabilities: ['agent.cancel'], maxUses: { 'agent.cancel': 1 } })
  const second = controller.admit({ binding, requestId: 'request-2', policyRevision: revision })
  await controller.submit(second.id, accepted)
  clock += 60_000
  controller.tick()
  await flush()
  assert.equal(controller.get(second.id)?.noticeStatus, 'rejected')
  assert.equal(controller.get(second.id)?.cancelStatus, 'accepted')
  assert.equal(controller.get(second.id)?.isolated, true)
  assert.equal(cancels, 1)
  assert.equal(sent.length, 1)
  assert.equal(createPersistentPolicy({ store }).describe().grants[0]?.used['messaging.send'], 1)
})

test('cancel and notice timeouts remain unknown and are never retried by progress or management polling', async context => {
  let calls = 0
  const { controller, admit, advance } = fixture(context, {
    policy: policy({ cancelTimeoutMs: 15, noticeTimeoutMs: 15 }),
    cancel: async () => { calls++; return await new Promise(() => {}) },
    notify: async () => { calls++; return await new Promise(() => {}) }
  })
  const execution = admit()
  await controller.submit(execution.id, accepted)
  controller.claimed(execution.id, proof())
  advance(60_000)
  controller.tick()
  await delay(40)
  const result = controller.get(execution.id)!
  assert.equal(result.cancelStatus, 'unknown')
  assert.equal(result.noticeStatus, 'unknown')
  assert.equal(controller.metrics().rawPending, 2)
  for (let index = 0; index < 5; index++) {
    controller.tick()
    controller.list()
    controller.observe(execution.id, { eventId: `after-timeout-${index}`, binding, turnId: '8', kind: 'progress' })
  }
  assert.equal(calls, 2)
  assert.equal(controller.get(execution.id)?.isolated, true)
})

test('an aborted turn does not pretend an unresolved cancellation RPC has settled or release it onto the next prompt', async context => {
  let acknowledge: (value: { status: 'accepted' }) => void = () => assert.fail('missing callback')
  const { controller, admit, advance } = fixture(context, { policy: policy({ cancelTimeoutMs: 15, noticeEnabled: false }),
    cancel: async () => await new Promise<{ status: 'accepted' }>(resolve => { acknowledge = resolve }) })
  const execution = admit()
  await controller.submit(execution.id, accepted)
  controller.claimed(execution.id, proof())
  advance(60_000)
  controller.tick()
  await delay(30)
  assert.equal(controller.get(execution.id)?.cancelStatus, 'unknown')
  const aborted = controller.observe(execution.id, { eventId: 'aborted-while-rpc-unknown', binding, turnId: '8', kind: 'cancelled' })
  assert.equal(aborted.execution.externalStatus, 'cancelled')
  assert.equal(aborted.execution.cancelStatus, 'unknown')
  assert.equal(aborted.execution.isolated, true)
  assert.throws(() => admit('next'), { code: 'EXECUTION_SESSION_ISOLATED' })
  acknowledge({ status: 'accepted' })
  await flush()
  assert.equal(controller.get(execution.id)?.cancelStatus, 'confirmed')
  assert.equal(controller.get(execution.id)?.isolated, false)
})

test('a separate process interrupted after acceptance leaves durable unknown without replay on restart', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'native-execution-crash-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'state.sqlite')
  const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts'
  const controllerUrl = new URL(`../src/host/native-execution.${extension}`, import.meta.url).href
  const sqliteUrl = new URL(`../src/storage/sqlite.${extension}`, import.meta.url).href
  const script = `import {createNativeExecutionController} from ${JSON.stringify(controllerUrl)};
    import {createSqliteStore} from ${JSON.stringify(sqliteUrl)};
    const store=createSqliteStore({filename:${JSON.stringify(filename)}});
    const controller=createNativeExecutionController({store,clock:()=>1000000});controller.start();
    const record=controller.admit({binding:${JSON.stringify(binding)},requestId:'request-1',policyRevision:${JSON.stringify(revision)}});
    await controller.submit(record.id,async()=>({status:'accepted'}));
    process.stdout.write(JSON.stringify({id:record.id,deadlineAt:record.deadlineAt}));process.exit(0);`
  const saved = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] })) as { id: string; deadlineAt: number }
  const store = createSqliteStore({ filename })
  const restored = createNativeExecutionController({ store, clock: () => 1_030_000 })
  context.after(async () => { await restored.stop(); store.close() })
  restored.start()
  assert.equal(restored.get(saved.id)?.status, 'unknown')
  assert.equal(restored.get(saved.id)?.deadlineAt, saved.deadlineAt)
  assert.throws(() => restored.admit({ binding, requestId: 'new-request', policyRevision: revision }), { code: 'EXECUTION_SESSION_ISOLATED' })
  let calls = 0
  await assert.rejects(restored.submit(saved.id, async () => { calls++; return { status: 'accepted' } }), { code: 'EXECUTION_SUBMIT_BLOCKED' })
  assert.equal(calls, 0)
})
