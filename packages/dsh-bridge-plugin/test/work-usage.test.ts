import assert from 'node:assert/strict'
import test from 'node:test'
import { readWorkUsage, validWorkUsage } from '../dist/work-usage.js'
const event = (seq: number, usage: Record<string, number>, turn = 1) => ({ type: 'assistant/message', seq, time: 1000 + seq,
  data: { turn, step: seq, usage, message: { source: { kind: 'model', provider: 'actual-route', model: 'actual-model', replayState: { secret: 'never-export' } }, content: [{ text: 'private-content' }] } } })
const end = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
test('work usage exports only exact immutable terminal token facts and preserves cache semantics', () => {
  const events = [event(1, { inputTokens: 2, outputTokens: 3, totalTokens: 12, cacheReadTokens: 7 }),
    event(2, { inputTokens: 10, outputTokens: 1, totalTokens: 11 }), end,
    event(3, { inputTokens: 100, outputTokens: 100 }, 2)]
  const rows = readWorkUsage(events)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.status, 'completed')
  assert.equal(rows[0]?.usage.cacheWriteTokens, 0)
  assert.equal(rows[1]?.usage.inputTokens, undefined)
  assert.equal(rows[1]?.usage.cacheReadTokens, undefined)
  assert.equal(rows[1]?.usage.totalTokens, 11)
  assert.equal(validWorkUsage(rows), true)
  assert.equal(JSON.stringify(rows).includes('private-content'), false)
  assert.equal(JSON.stringify(rows).includes('never-export'), false)
  assert.deepEqual(readWorkUsage(events), rows)
  assert.equal(validWorkUsage([{ ...rows[0], usage: { inputTokens: -1 } }]), false)
})
