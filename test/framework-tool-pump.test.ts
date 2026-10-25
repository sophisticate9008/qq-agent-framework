import test from 'node:test'
import assert from 'node:assert/strict'
import { createFrameworkToolPump } from '../src/host/framework-tool-pump.ts'
import type { FrameworkToolPendingCall, FrameworkToolResult } from '../src/contracts/framework-tools.ts'
import type { DshFrameworkToolPort } from '../src/adapters/dsh-framework-tools.ts'
import { awaitCondition } from './fixtures/await-condition.ts'

const item: FrameworkToolPendingCall = { ticket: 'ticket-1', leaseId: 'projection-1', call: {
  id: 'call-1', sessionId: 'session-1', generation: 1, requestId: 'request-1', userMessageId: 'message-1',
  turn: 0, name: 'qaf_media_inspect', input: { assetId: 'opaque' }, expiresAt: Date.now() + 1000 } }
const signal = new AbortController().signal
function port(poll: DshFrameworkToolPort['poll'], complete: DshFrameworkToolPort['complete']): DshFrameworkToolPort {
  return { poll, complete, async inspect() { throw new Error('unused') }, async install() { throw new Error('unused') }, async withdraw() { throw new Error('unused') } }
}

test('owner pump verifies projection, returns one result and never replays a retained ticket', async () => {
  const completed: FrameworkToolResult[] = []
  let executed = 0
  let polls = 0
  const pump = createFrameworkToolPump({ issuerEpoch: 'epoch-1', pollIntervalMs: 10,
    port: port(async () => { polls++; return [item] }, async request => { completed.push(request.result); return true }),
    accepts: value => value.leaseId === 'projection-1',
    async execute() { executed++; return { status: 'confirmed', value: { kind: 'image' } } } })
  pump.start()
  await awaitCondition(() => polls >= 3, { message: 'three tool polling cycles', timeoutMs: 1000 })
  await pump.close(signal)
  assert.equal(executed, 1)
  assert.deepEqual(completed, [{ status: 'confirmed', value: { kind: 'image' } }])
})

test('withdrawn SDK call cancels in-flight host work and unknown poll failure stops the owner connection', async () => {
  let polls = 0
  let cancelled = false
  let completed = false
  const faults: string[] = []
  const pump = createFrameworkToolPump({ issuerEpoch: 'epoch-1', pollIntervalMs: 10,
    port: port(async () => { polls++; if (polls === 3) throw new Error('private transport detail'); return polls === 1 ? [item] : [] },
      async () => { completed = true; return true }), accepts: () => true,
    execute: (_call, currentSignal) => new Promise(resolve => currentSignal.addEventListener('abort', () => {
      cancelled = true; resolve({ status: 'unknown', code: 'TOOL_CALL_CANCELLED' })
    }, { once: true })), onFault: code => faults.push(code) })
  pump.start()
  await awaitCondition(() => faults.length === 1, { message: 'tool channel closes after transport uncertainty', timeoutMs: 1000 })
  await pump.close(signal)
  assert(cancelled)
  assert.equal(completed, false)
  assert.equal(polls, 3)
  assert.deepEqual(faults, ['TOOL_CHANNEL_UNKNOWN'])
  assert.deepEqual(pump.status(), { state: 'unknown', pending: 0, lastError: 'TOOL_CHANNEL_UNKNOWN' })
})

test('unverified lease produces a rejection without invoking its proposed tool', async () => {
  let result: FrameworkToolResult | undefined
  const pump = createFrameworkToolPump({ issuerEpoch: 'epoch-1', pollIntervalMs: 10,
    port: port(async () => [item], async request => { result = request.result; return true }),
    accepts: () => false, async execute() { throw new Error('must not dispatch an unverified lease') } })
  pump.start()
  await awaitCondition(() => result !== undefined, { message: 'unverified tool projection rejected', timeoutMs: 1000 })
  await pump.close(signal)
  assert.deepEqual(result, { status: 'rejected', code: 'TOOL_PROJECTION_UNVERIFIED' })
})
