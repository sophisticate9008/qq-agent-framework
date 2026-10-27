import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createNativeMessageSources } from '../src/host/native-message-sources.ts'
import { createNativeWorkExecutor, type NativeWorkBackend, type NativeWorkBackendResult, type NativeWorkExecutorOptions } from '../src/host/native-work.ts'
import { awaitCondition } from './fixtures/await-condition.ts'
import type { EffectRequest, JsonValue } from '../src/core/types.ts'
import { isRecord } from '../src/core/values.ts'
import type { NativeEventInput } from '../src/contracts/native-events.ts'

function object(value: JsonValue): Record<string, JsonValue> { assert(isRecord(value)); return value as Record<string, JsonValue> }
const configuration = { schema: 1 as const, enabled: true, provider: 'provider', model: 'model', agentPreset: 'work', fullAccess: false, timeoutMs: 1000 }
const signal = new AbortController().signal
const result: NativeWorkBackendResult = { stopReason: 'completed', output: [{ type: 'text', text: 'A verified work result.' }] }

function fixture(context: TestContext, overrides: Partial<NativeWorkExecutorOptions> = {}) {
  const store = createSqliteStore({ filename: ':memory:' })
  context.after(() => store.close())
  let current = true
  let starts = 0
  let followups = 0
  let interrupts = 0
  let deliveryCalls = 0
  let observed: { state: 'running' | 'completed' | 'unknown'; result: NativeWorkBackendResult | null } = { state: 'running', result: null }
  let complete!: (value: NativeWorkBackendResult) => void
  const firstResult = new Promise<NativeWorkBackendResult>(resolve => { complete = resolve })
  const sources = createNativeMessageSources({ owner: 'owner', signal, async validate() {} })
  const backend: NativeWorkBackend = { async verify() {}, async start() { starts++; return { childId: child(), result: firstResult, async dispose() {} } },
    async inspect() { return observed }, async followup() { followups++; observed = { state: 'running', result: null }; return { messageId: 'followup-inbox' } },
    async interrupt() { interrupts++ } }
  let childId = ''
  function child() { return childId }
  const options: NativeWorkExecutorOptions = { store, backend: { ...backend, async start(request) { childId = request.childId; return backend.start(request) } },
    messageSources: sources.reader, async loadConfiguration() { return configuration }, async authorize() {},
    isCurrentParent: binding => current && binding.sessionId === 'parent' && binding.generation === 3 && binding.conversationId === 'group:123',
    async onResult() { deliveryCalls++; return { status: 'confirmed', messageId: `qq-${deliveryCalls}` } }, ...overrides }
  const executor = createNativeWorkExecutor(options)
  context.after(async () => { complete(result); await executor.close(signal) })
  function request(eventId: string, input: JsonValue, userId = 'owner', conversationId = 'group:123', generation = 3): EffectRequest {
    sources.capture({ id: eventId, userId, conversationId }, { receivedAt: Date.now(), expiresAt: Date.now() + 10000, signal })
    return { input, scope: { eventId, conversationId, sessionId: 'parent', generation, featureId: 'work-tools', version: '1' }, signal }
  }
  return { store, executor, options, backend: options.backend!, request, complete,
    starts: () => starts, followups: () => followups, interrupts: () => interrupts, deliveries: () => deliveryCalls,
    current(value: boolean) { current = value }, observed(value: typeof observed) { observed = value } }
}

test('owner work captures a durable result before confirmed delivery and resolves only its current live child scope', async context => {
  const fixture = fixtureForTest(context)
  await assert.rejects(fixture.executor.execute(fixture.request('not-owner', { task: 'must not run' }, 'visitor')), { code: 'NATIVE_MESSAGE_SOURCE_NOT_OWNER' })
  assert.equal(fixture.starts(), 0)
  const request = fixture.request('owner-source', { task: 'Do the requested work', context: 'Explicit task context' })
  const started = object(await fixture.executor.execute(request))
  const id = String(started.id)
  const childId = String(started.childId)
  assert.equal(fixture.starts(), 1)
  assert.deepEqual(fixture.executor.resolveChild(childId), { id, childId, parentSessionId: 'parent', conversationId: 'group:123', generation: 3,
    ownerId: 'owner', expiresAt: fixture.executor.read(id)!.deadlineAt })
  fixture.current(false)
  assert.equal(fixture.executor.resolveChild(childId), null)
  fixture.current(true)
  fixture.complete(result)
  await awaitCondition(() => fixture.executor.read(id)?.delivery === 'confirmed', { message: 'work result confirmed once', timeoutMs: 1000 })
  assert.deepEqual(fixture.executor.read(id)?.result, result)
  assert.equal(fixture.executor.resolveChild(childId), null)
  assert.equal(fixture.store.list('native-work.results').length, 1)
  assert.equal(fixture.deliveries(), 1)
  assert.equal(object(await fixture.executor.execute(request)).status, 'completed')
  assert.equal(fixture.starts(), 1)
  assert.equal(fixture.deliveries(), 1)
})

const fixtureForTest = fixture

test('owner admission uses one prepared backend, preserves owner checks, and never repeats full configuration loading', async context => {
  let preparations = 0
  let assertions = 0
  let starts = 0
  const f = fixture(context, {
    async loadConfiguration() { throw new Error('Full configuration must be prepared once') },
    async prepareAdmission() {
      preparations++
      return { configuration, async assertCurrent() { assertions++ }, backend: {
        async verify() {}, async start(request) { starts++; return { childId: request.childId, result: Promise.resolve(result), async dispose() {} } }
      } }
    }
  })
  await assert.rejects(f.executor.execute(f.request('visitor-preparation', { task: 'must not prepare' }, 'visitor')), { code: 'NATIVE_MESSAGE_SOURCE_NOT_OWNER' })
  assert.equal(preparations, 0)
  const accepted = object(await f.executor.execute(f.request('owner-preparation', { task: 'run once' })))
  assert.equal(preparations, 1)
  assert.equal(assertions, 1)
  assert.equal(starts, 1)
  await awaitCondition(() => f.executor.read(String(accepted.id))?.delivery === 'confirmed', { timeoutMs: 1000, message: 'prepared work delivered' })
})

test('a changed local preparation before backend start is failed, with no external work or unknown result', async context => {
  let starts = 0
  const f = fixture(context, { async prepareAdmission() {
    return { configuration, async assertCurrent() { throw Object.assign(new Error('Changed'), { code: 'ASSISTANT_CONFIGURATION_CHANGED' }) },
      backend: { async verify() {}, async start(request) { starts++; return { childId: request.childId, result: Promise.resolve(result), async dispose() {} } } } }
  } })
  await assert.rejects(f.executor.execute(f.request('changed-preparation', { task: 'do not start' })), { code: 'ASSISTANT_CONFIGURATION_CHANGED' })
  assert.equal(starts, 0)
  assert.equal(f.executor.list().records[0]?.status, 'failed')
})

test('actual work lifecycle emits bounded correlated observations without exposing task or result and ignores observer faults',async context=>{
  const events:NativeEventInput[]=[]
  const f=fixture(context,{onObservation(event){events.push(event);if(event.status==='progress')throw Error('observer failed')}})
  const started=object(await f.executor.execute(f.request('observed-work',{task:'private-task-instructions'})))
  const id=String(started.id)
  assert.deepEqual(events.map(event=>event.status),['started','progress'])
  f.complete(result)
  await awaitCondition(()=>f.executor.read(id)?.delivery==='confirmed',{timeoutMs:1000,message:'observed work still delivers once'})
  assert.deepEqual(events.map(event=>event.status),['started','progress','completed'])
  assert(events.every(event=>event.correlation.workId===id&&event.correlation.sessionId==='parent'&&event.correlation.generation===3))
  assert.equal(events[0]!.correlation.childSessionId,started.childId)
  assert(!JSON.stringify(events).includes('private-task'));assert(!JSON.stringify(events).includes('verified work result'))
  assert.equal(f.starts(),1);assert.equal(f.deliveries(),1)
})

test('delivery failure retains output across executor recovery without redelivery or restarting work', async context => {
  let deliveries = 0
  const fixture = fixtureForTest(context, { async onResult() { deliveries++; throw new Error('transport detail must stay private') } })
  const request = fixture.request('delivery-owner', { task: 'Produce a result' })
  const started = object(await fixture.executor.execute(request))
  const id = String(started.id)
  fixture.complete(result)
  await awaitCondition(() => fixture.executor.read(id)?.delivery === 'unknown', { message: 'uncertain work delivery is retained', timeoutMs: 1000 })
  assert.deepEqual(fixture.executor.read(id)?.result, result)
  await fixture.executor.close(signal)
  const recovered = createNativeWorkExecutor(fixture.options)
  context.after(() => recovered.close(signal))
  assert.deepEqual(recovered.read(id)?.result, result)
  assert.equal(recovered.read(id)?.delivery, 'unknown')
  assert.equal(recovered.list().records.length, 1)
  assert.equal(object(await recovered.execute(request)).status, 'completed')
  assert.equal(fixture.starts(), 1)
  assert.equal(deliveries, 1)
  assert(!JSON.stringify(recovered.read(id)).includes('transport detail'))
})

test('deadline-isolated work records late result evidence without invoking delivery', async context => {
  const fixture = fixtureForTest(context, { async loadConfiguration() { return { ...configuration, timeoutMs: 30 } } })
  const started = object(await fixture.executor.execute(fixture.request('late-owner', { task: 'Wait beyond the admitted deadline' })))
  const id = String(started.id)
  await awaitCondition(() => fixture.executor.read(id)?.status === 'unknown', { message: 'work reaches admitted deadline', timeoutMs: 1000 })
  fixture.complete(result)
  await awaitCondition(() => fixture.executor.read(id)?.lateResult !== null, { message: 'late work result is only recorded', timeoutMs: 1000 })
  assert.equal(fixture.executor.read(id)?.status, 'unknown')
  assert.deepEqual(fixture.executor.read(id)?.lateResult, result)
  assert.equal(fixture.deliveries(), 0)
})

test('owner follow-up and interrupt retain child identity, enforce scope and never replay accepted control', async context => {
  const fixture = fixtureForTest(context)
  const started = object(await fixture.executor.execute(fixture.request('start-source', { task: 'Initial work' })))
  const id = String(started.id)
  fixture.complete(result)
  await awaitCondition(() => fixture.executor.read(id)?.delivery === 'confirmed', { message: 'initial result finishes', timeoutMs: 1000 })
  await new Promise<void>(resolve => setImmediate(resolve))
  await assert.rejects(fixture.executor.followup(fixture.request('wrong-scope', { id, text: 'Cross conversation' }, 'owner', 'group:456')),
    { code: 'NATIVE_WORK_SCOPE_MISMATCH' })
  await assert.rejects(fixture.executor.followup(fixture.request('wrong-generation', { id, text: 'Old generation' }, 'owner', 'group:123', 2)),
    { code: 'NATIVE_WORK_SCOPE_MISMATCH' })
  const followup = fixture.request('followup-source', { id, text: 'Continue the same task', delivery: 'queue' })
  assert.equal(object(await fixture.executor.followup(followup)).state, 'accepted')
  assert.equal(object(await fixture.executor.followup(followup)).state, 'accepted')
  assert.equal(fixture.followups(), 1)
  assert.equal(fixture.starts(), 1)
  assert.equal(fixture.executor.read(id)?.childId, started.childId)
  fixture.observed({ state: 'completed', result: { ...result, output: [{ type: 'text', text: 'Follow-up result.' }] } })
  await awaitCondition(() => fixture.deliveries() === 2, { message: 'follow-up final result delivered', timeoutMs: 1000 })
  const interrupt = fixture.request('interrupt-source', { id })
  await fixture.executor.interrupt(interrupt)
  await fixture.executor.interrupt(interrupt)
  assert.equal(fixture.interrupts(), 1)
  assert.equal(fixture.store.list('native-work.results').length, 2)
})

test('explicit read-only recovery can capture a durable result while leaving delivery unknown', async context => {
  const fixture = fixtureForTest(context)
  const started = object(await fixture.executor.execute(fixture.request('recover-source', { task: 'Recover work result' })))
  const id = String(started.id)
  fixture.complete(result)
  await awaitCondition(() => fixture.executor.read(id)?.delivery === 'confirmed', { message: 'first executor result settles', timeoutMs: 1000 })
  await fixture.executor.close(signal)
  const prior = fixture.store.read('native-work.executions', id)!
  fixture.store.write(prior.namespace, prior.key, { ...object(prior.value), status: 'unknown', result: null, delivery: 'unknown' }, { expectedRevision: prior.revision })
  fixture.observed({ state: 'completed', result })
  const recovered = createNativeWorkExecutor(fixture.options)
  context.after(() => recovered.close(signal))
  assert.equal(recovered.read(id)?.result, null)
  const view = await recovered.reconcile(fixture.request('reconcile-source', { id }))
  assert.deepEqual(view.result, result)
  assert.equal(view.delivery, 'unknown')
  assert.equal(fixture.deliveries(), 1)
  assert.equal(fixture.starts(), 1)
})

test('child interaction routing is registered after durable admission, before SDK start, and released on terminal or unknown work', async context => {
  const registered = new Set<string>()
  let registrations = 0
  const fixture = fixtureForTest(context, { registerChild(binding) {
    registrations++
    assert.equal(binding.ownerId, 'owner')
    assert.equal(binding.parentSessionId, 'parent')
    assert.equal(binding.generation, 3)
    registered.add(binding.childId)
    return () => { assert(registered.delete(binding.childId)) }
  } })
  const start = fixture.backend.start
  fixture.backend.start = async request => {
    assert(registered.has(request.childId))
    assert.equal(fixture.store.list('native-work.executions').length, 1)
    return start(request)
  }
  const created = object(await fixture.executor.execute(fixture.request('route-source', { task: 'Work with QQ questions' })))
  fixture.complete(result)
  await awaitCondition(() => registered.size === 0, { message: 'terminal work releases child routing', timeoutMs: 1000 })
  const followup = fixture.backend.followup!
  fixture.backend.followup = async request => { assert(registered.has(request.childId)); return followup(request) }
  await fixture.executor.followup(fixture.request('route-followup', { id: created.id!, text: 'Continue the same child' }))
  assert.equal(registrations, 2)
  assert.equal(registered.size, 1)
  await fixture.executor.close(signal)
  assert.equal(registered.size, 0)
  assert.equal(fixture.executor.resolveChild(String(created.childId)), null)
})

test('file-only work delivery records its real file id without inventing a message id', async context => {
  const fixture = fixtureForTest(context, { async onResult() { return { status: 'confirmed', kind: 'file-upload', fileId: 'real-result-file', name: 'report.txt' } } })
  const created = object(await fixture.executor.execute(fixture.request('file-result', { task: 'Produce a file' })))
  fixture.complete({ stopReason: 'completed', output: [{ type: 'file', assetId: 'registered-result', name: 'report.txt' }] })
  await awaitCondition(() => fixture.executor.read(String(created.id))?.delivery === 'confirmed', { message: 'file result accepted', timeoutMs: 1000 })
  assert.equal(fixture.executor.read(String(created.id))?.deliveryFileId, 'real-result-file')
  assert.equal(fixture.executor.read(String(created.id))?.deliveryMessageId, null)
})
