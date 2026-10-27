import test from 'node:test'
import assert from 'node:assert/strict'
import { createDshNativeWorkBackend } from '../src/host/dsh-native-work.ts'
import type { DshWorkPort } from '../src/adapters/dsh-work.ts'
import type { DshWorkSnapshot } from '../src/contracts/dsh-work.ts'
import type { NativeWorkBackend } from '../src/host/native-work.ts'
import type { NativeWorkConfiguration } from '../src/host/native-work-configuration.ts'

const configuration: NativeWorkConfiguration = { schema: 1, enabled: true, fullAccess: false,
  provider: 'catalog-provider', model: 'model-1', agentPreset: 'work-preset', timeoutMs: 1000 }
const signal = new AbortController().signal
const request: Parameters<NativeWorkBackend['start']>[0] = {
  id: 'work-id', childId: 'child-session', parentSessionId: 'parent-session', task: 'Perform the requested work', context: 'Explicit context',
  configuration, signal, source: { conversationId: 'group:123', sourceMessageId: '100', userId: '456', receivedAt: Date.now(),
    expiresAt: Date.now() + 1000, isOwner: true, assurance: 'normalized-onebot-source-only', workIntentVerified: false,
    capabilityAuthorizationVerified: false, externalToolAuthorizationVerified: false }
}

function fixture() {
  let starts = 0
  let interrupted = 0
  let state: DshWorkSnapshot['state'] = 'running'
  let generation: number | null = 3
  const port: DshWorkPort = {
    async verify() { return true },
    async start(value) { starts++; assert.equal(value.modelProvider, 'actual-dsh-provider'); return { ...value, schema: 1, state, result: null, error: null } },
    async inspect(value) { return { ...value, schema: 1, state, result: state === 'completed'
      ? { stopReason: 'completed', output: [{ type: 'text', text: 'finished' }] } : null, error: state === 'unknown' ? 'WORK_RECORD_UNAVAILABLE' : null } },
    async interrupt() { interrupted++ }, async followup() { return { messageId: 'accepted' } }
  }
  const backend = createDshNativeWorkBackend({ port, issuerEpoch: 'epoch', pollIntervalMs: 10,
    generation: () => generation, async resolveTarget() { return { modelProvider: 'actual-dsh-provider', model: 'model-1', agentPreset: 'work-preset' } } })
  return { backend, port, starts: () => starts, interrupted: () => interrupted,
    state(value: typeof state) { state = value }, generation(value: number | null) { generation = value } }
}

test('real work backend reserves one fixed child, polls result without replaying start and disposes once', async () => {
  const fixture = fixtureForTest()
  await fixture.backend.verify({ parentSessionId: request.parentSessionId, configuration, signal })
  const activation = await fixture.backend.start(request)
  fixture.state('completed')
  assert.equal(activation.childId, 'child-session')
  assert.deepEqual(await activation.result, { stopReason: 'completed', output: [{ type: 'text', text: 'finished' }] })
  await Promise.all([activation.dispose(), activation.dispose()])
  assert.equal(fixture.starts(), 1)
  assert.equal(fixture.interrupted(), 1)
})

const fixtureForTest = fixture

test('rapid progress snapshots retain earlier pending text and final results do not replay progress', async () => {
  const data = fixtureForTest()
  const first = { id: 'assistant/message:seq:1', at: 1, text: 'Read the source files.' }
  const second = { id: 'assistant/message:seq:2', at: 2, text: 'Computed the totals.' }
  const observations: string[][] = []
  const start = data.port.start
  data.port.start = async (value, signal) => ({ ...await start(value, signal), progress: [first] })
  let inspected = 0
  data.port.inspect = async value => {
    inspected++
    return { ...value, schema: 1, state: inspected < 3 ? 'running' : 'completed', progress: [first, second],
      result: inspected < 3 ? null : { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }, error: null }
  }
  const activation = await data.backend.start({ ...request, onProgress: items => observations.push(items.map(item => item.text)) })
  await activation.result
  assert.deepEqual(observations, [[first.text], [first.text, second.text]])
  assert.equal(data.starts(), 1)
  await activation.dispose()
})

test('missing parent and unknown remote outcome fail without creating replacement work', async () => {
  const fixture = fixtureForTest()
  fixture.generation(null)
  await assert.rejects(fixture.backend.start(request), { code: 'WORK_PARENT_UNAVAILABLE' })
  assert.equal(fixture.starts(), 0)
  fixture.generation(3)
  const activation = await fixture.backend.start(request)
  fixture.state('unknown')
  await assert.rejects(activation.result, { code: 'WORK_RESULT_UNKNOWN' })
  assert.equal(fixture.starts(), 1)
  await activation.dispose()
})

test('disposing running work cancels result observation and sends an independently bounded interrupt', async () => {
  const fixture = fixtureForTest()
  const activation = await fixture.backend.start(request)
  const rejected = assert.rejects(activation.result)
  await activation.dispose()
  await rejected
  assert.equal(fixture.interrupted(), 1)
})

test('structured SDK media requires an explicit scoped registrar and preserves text beside registered assets', async () => {
  const fixture = fixtureForTest()
  const media = { type: 'media-reference' as const, kind: 'image' as const, attachmentId: 'opaque-image', bytes: 4,
    mediaType: 'image/png' as const, width: 1, height: 1 }
  fixture.port.inspect = async address => ({ ...address, schema: 1, state: 'completed',
    result: { stopReason: 'completed', output: [{ type: 'text', text: 'before' }, media, { type: 'text', text: 'after' }] }, error: null })
  const missing = await fixture.backend.start(request)
  await assert.rejects(missing.result, { code: 'WORK_MEDIA_REGISTRATION_UNAVAILABLE' })
  await missing.dispose()
  let registered = 0
  const backend = createDshNativeWorkBackend({ port: fixture.port, issuerEpoch: 'epoch', generation: () => 3,
    async resolveTarget() { return { modelProvider: 'actual-dsh-provider', model: 'model-1', agentPreset: 'work-preset', reasoningEffort: 'high' } },
    async registerResultAsset(value) {
      registered++; assert.deepEqual(value.asset, media)
      assert.equal(value.address.parentSessionId, request.parentSessionId)
      assert.equal(value.address.generation, 3)
      return { type: 'image', assetId: 'scoped-asset' }
    } })
  const activation = await backend.start(request)
  assert.deepEqual(await activation.result, { stopReason: 'completed', output: [
    { type: 'text', text: 'before' }, { type: 'image', assetId: 'scoped-asset' }, { type: 'text', text: 'after' }] })
  assert.equal(registered, 1)
  await activation.dispose()
})

test('owner-admitted full-access scope propagates through both SDK verification and creation', async () => {
  const fixture = fixtureForTest()
  const original = fixture.port.start
  let verified = false
  fixture.port.verify = async value => { assert.equal(value.fullAccess, true); verified = true; return true }
  fixture.port.start = async value => { assert.equal(value.fullAccess, true); return original(value, signal) }
  const full = { ...configuration, fullAccess: true }
  await fixture.backend.verify({ parentSessionId: request.parentSessionId, configuration: full, signal })
  const activation = await fixture.backend.start({ ...request, configuration: full })
  fixture.state('completed')
  await activation.result
  await activation.dispose()
  assert.equal(verified, true)
})


test('completed child SDK token facts are observed under its original work address without replaying a model', async () => {
  const data = fixtureForTest()
  const step = { eventId: 'assistant/message:seq:16', turn: '1', step: 1, at: 1000, provider: 'actual-dsh-provider',
    model: 'model-1', status: 'completed' as const, usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 7, cacheWriteTokens: 0, totalTokens: 12 } }
  const observations: unknown[] = []
  data.port.inspect = async value => ({ ...value, schema: 1, state: 'completed', usage: [step],
    result: { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }, error: null })
  const backend = createDshNativeWorkBackend({ port: data.port, issuerEpoch: 'epoch', generation: () => 3, pollIntervalMs: 10,
    async resolveTarget() { return { modelProvider: 'actual-dsh-provider', model: 'model-1', agentPreset: 'work-preset' } },
    recordUsage(value) { observations.push(value); assert.equal(value.address.childId, request.childId); assert.deepEqual(value.steps, [step]) } })
  const activation = await backend.start(request)
  await activation.result
  assert.equal(observations.length, 1)
  assert.equal(data.starts(), 1)
  await backend.inspect!({ id: request.id, childId: request.childId, parentSessionId: request.parentSessionId, generation: 3, signal })
  assert.equal(observations.length, 2, 'inspection can repeat exact usage for idempotent ledger projection')
  await activation.dispose()
})
