import test from 'node:test'
import assert from 'node:assert/strict'
import { createFrameworkToolRegistry } from '../src/host/framework-tools.ts'
import type { FrameworkToolCall, FrameworkToolDefinition } from '../src/contracts/framework-tools.ts'
import { FrameworkError } from '../src/core/values.ts'

const definition: FrameworkToolDefinition = { name: 'qaf_media_inspect', description: 'Read registered media facts in the current QQ conversation.',
  parameters: { type: 'object', properties: { assetId: { type: 'string' } }, required: ['assetId'], additionalProperties: false },
  featureId: 'media-tools', capability: 'media.inspect', timeoutMs: 1000 }
const call = (changes: Partial<FrameworkToolCall> = {}): FrameworkToolCall => ({ id: 'call-1', name: definition.name,
  sessionId: 'session-1', generation: 3, requestId: 'qq-inbox-request-1', userMessageId: 'dsh-user-message-1', turn: 4,
  input: { assetId: 'opaque-asset' }, expiresAt: Date.now() + 1000, ...changes })
const signal = new AbortController().signal
const validate = (input: unknown) => {
  assert(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 1
    && 'assetId' in input && typeof input.assetId === 'string')
  return { assetId: input.assetId }
}

test('tools resolve trusted current QQ scope, validate exact input, invoke fixed capability and cache identical calls', async () => {
  let executions = 0
  const registry = createFrameworkToolRegistry({
    async resolveScope(request) {
      assert.equal(request.requestId, 'qq-inbox-request-1')
      return { eventId: 'qq-message-1', conversationId: 'group:123', sessionId: request.sessionId,
        generation: 3, featureId: 'untrusted-override', version: '1' }
    },
    async invoke(capability, request) {
      executions++
      assert.equal(capability, 'media.inspect')
      assert.equal(request.scope.featureId, 'media-tools')
      assert.equal(request.scope.conversationId, 'group:123')
      return { kind: 'image', available: true }
    }
  })
  const withdraw = registry.register(definition, validate)
  const request = call()
  const results = await Promise.all([registry.execute(request, signal), registry.execute(request, signal)])
  assert.deepEqual(results, [{ status: 'confirmed', value: { kind: 'image', available: true } },
    { status: 'confirmed', value: { kind: 'image', available: true } }])
  assert.equal(executions, 1)
  assert.deepEqual(await registry.execute({ ...request, input: { assetId: 'other' } }, signal),
    { status: 'rejected', code: 'TOOL_CALL_CONFLICT' })
  assert.equal((await registry.execute(call({ id: 'invalid', input: { assetId: 'opaque', owner: true } }), signal)).status, 'rejected')
  assert.equal(executions, 1)
  withdraw()
  assert.deepEqual(await registry.execute(call({ id: 'withdrawn' }), signal), { status: 'rejected', code: 'TOOL_UNAVAILABLE' })
})

test('old generation, missing current source, policy denial and uncertain execution do not repeat effects', async () => {
  let executions = 0
  const registry = createFrameworkToolRegistry({
    async resolveScope(request) { return request.requestId === 'old-request' ? null : {
      eventId: 'source', conversationId: 'group:123', sessionId: request.sessionId, generation: 3, featureId: 'media-tools', version: '1' } },
    async invoke() { executions++; throw new FrameworkError(executions === 1 ? 'POLICY_DENIED' : 'TRANSPORT_LOST', 'Do not leak source contents') }
  })
  registry.register(definition, validate)
  assert.deepEqual(await registry.execute(call({ id: 'old-generation', generation: 2 }), signal), { status: 'rejected', code: 'TOOL_SOURCE_UNAVAILABLE' })
  assert.deepEqual(await registry.execute(call({ id: 'old-source', requestId: 'old-request' }), signal), { status: 'rejected', code: 'TOOL_SOURCE_UNAVAILABLE' })
  assert.deepEqual(await registry.execute(call({ id: 'denied' }), signal), { status: 'rejected', code: 'POLICY_DENIED' })
  const unknown = call({ id: 'unknown' })
  assert.deepEqual(await registry.execute(unknown, signal), { status: 'unknown', code: 'TRANSPORT_LOST' })
  assert.deepEqual(await registry.execute(unknown, signal), { status: 'unknown', code: 'TRANSPORT_LOST' })
  assert.equal(executions, 2)
})

test('cancellation, withdrawal during resolution and noncooperating effects are bounded', async () => {
  let invoked = false
  let resolved!: () => void
  const hold = new Promise<void>(resolve => { resolved = resolve })
  const registry = createFrameworkToolRegistry({ async resolveScope(request) {
    await hold
    return { eventId: 'source', conversationId: 'group:123', sessionId: request.sessionId, generation: 3, featureId: 'media-tools', version: '1' }
  }, async invoke() { invoked = true; return new Promise(() => {}) } })
  const withdraw = registry.register({ ...definition, timeoutMs: 20 }, validate)
  const pending = registry.execute(call(), signal)
  withdraw(); resolved()
  assert.deepEqual(await pending, { status: 'rejected', code: 'TOOL_UNAVAILABLE' })
  assert.equal(invoked, false)
  registry.register({ ...definition, timeoutMs: 20 }, validate)
  const request = call({ id: 'hung' })
  assert.deepEqual(await registry.execute(request, signal), { status: 'unknown', code: 'TOOL_EXECUTION_UNKNOWN' })
  assert.deepEqual(await registry.execute(request, signal), { status: 'unknown', code: 'TOOL_EXECUTION_UNKNOWN' })
  registry.close()
  assert.deepEqual(await registry.execute(call({ id: 'closed' }), signal), { status: 'rejected', code: 'TOOL_REGISTRY_CLOSED' })
})

test('settled expired calls release capacity while expired duplicates reject before cached success', async () => {
  let now = 1_000_000
  const realNow = Date.now
  Date.now = () => now
  let invocations = 0
  const registry = createFrameworkToolRegistry({ maxCalls: 1,
    async resolveScope(request) { return { eventId: 'source', conversationId: 'group:123', sessionId: request.sessionId,
      generation: 3, featureId: 'media-tools', version: '1' } },
    async invoke() { invocations++; return { status: 'sent' } } })
  registry.register(definition, validate)
  try {
    const first = call({ expiresAt: now + 100 })
    assert.equal((await registry.execute(first, signal)).status, 'confirmed')
    assert.equal((await registry.execute(first, signal)).status, 'confirmed')
    assert.equal(invocations, 1)
    assert.deepEqual(await registry.execute(call({ id: 'while-valid', expiresAt: now + 200 }), signal),
      { status: 'rejected', code: 'TOOL_CALL_CAPACITY' })
    now += 101
    assert.deepEqual(await registry.execute(first, signal), { status: 'rejected', code: 'TOOL_CALL_EXPIRED' })
    assert.equal(invocations, 1)
    assert.equal((await registry.execute(call({ id: 'after-expiry', expiresAt: now + 100 }), signal)).status, 'confirmed')
    assert.equal(invocations, 2)
  } finally { registry.close(); Date.now = realNow }
})

test('expired in-flight calls and settled unknown calls within their validity retain capacity', async () => {
  let now = 2_000_000
  const realNow = Date.now
  Date.now = () => now
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const registry = createFrameworkToolRegistry({ maxCalls: 1,
    async resolveScope(request) { return { eventId: 'source', conversationId: 'group:123', sessionId: request.sessionId,
      generation: 3, featureId: 'media-tools', version: '1' } },
    async invoke() { await pending; throw new FrameworkError('TRANSPORT_LOST', 'Unknown result') } })
  registry.register({ ...definition, timeoutMs: 1000 }, validate)
  try {
    const first = call({ expiresAt: now + 100 })
    const result = registry.execute(first, signal)
    await Promise.resolve(); await Promise.resolve()
    now += 101
    assert.deepEqual(await registry.execute(call({ id: 'still-in-flight', expiresAt: now + 100 }), signal),
      { status: 'rejected', code: 'TOOL_CALL_CAPACITY' })
    finish()
    assert.equal((await result).status, 'unknown')
    now += 1
    const unknown = call({ id: 'unknown-valid', expiresAt: now + 100 })
    assert.equal((await registry.execute(unknown, signal)).status, 'unknown')
    assert.deepEqual(await registry.execute(call({ id: 'unknown-not-expired', expiresAt: now + 100 }), signal),
      { status: 'rejected', code: 'TOOL_CALL_CAPACITY' })
  } finally { finish(); registry.close(); Date.now = realNow }
})
