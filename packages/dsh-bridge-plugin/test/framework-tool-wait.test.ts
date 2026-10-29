import assert from 'node:assert/strict'
import test from 'node:test'
import { createFrameworkToolChannel } from '../dist/framework-tools.js'

test('empty waits time out without claiming calls and cancellation releases waiter capacity', async () => {
  const channel = createFrameworkToolChannel({ issuerEpoch: 'epoch-fixture', getAgent: () => undefined })
  const request = { issuerEpoch: 'epoch-fixture', waitMs: 10000 }
  const controller = new AbortController()
  const waits = Array.from({ length: 32 }, () => channel.waitForCalls(request, controller.signal))
  const outcomes = Promise.allSettled(waits)
  await assert.rejects(channel.waitForCalls(request, controller.signal), /capacity/)
  controller.abort(new Error('cancel fixture'))
  assert((await outcomes).every(outcome => outcome.status === 'rejected'))
  assert.deepEqual(await channel.waitForCalls({ ...request, waitMs: 1 }, new AbortController().signal),
    { schema: 1, issuerEpoch: 'epoch-fixture', calls: [] })
  assert.deepEqual(channel.poll(request), { schema: 1, issuerEpoch: 'epoch-fixture', calls: [] })
  channel.close()
})

test('closing a tool channel interrupts pending waits and validates wait bounds', async () => {
  const channel = createFrameworkToolChannel({ issuerEpoch: 'epoch-fixture', getAgent: () => undefined })
  const signal = new AbortController().signal
  for (const waitMs of [-1, 10001, NaN, 1.5]) {
    await assert.rejects(channel.waitForCalls({ issuerEpoch: 'epoch-fixture', waitMs }, signal), /Invalid framework tool wait/)
  }
  const waiting = channel.waitForCalls({ issuerEpoch: 'epoch-fixture', waitMs: 10000 }, signal)
  const rejected = assert.rejects(waiting, /epoch changed/)
  channel.close()
  await rejected
})
