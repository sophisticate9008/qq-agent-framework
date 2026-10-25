import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeUsage } from '../src/host/native-usage.ts'
import { createNativeUsageProjection } from '../src/host/native-usage-projection.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

test('native conversation grouping visits high-cardinality records linearly even when response limit is ten', context => {
  const store = createSqliteStore({ filename: ':memory:' })
  context.after(() => store.close())
  const usage = createNativeUsage({ store, clock: () => 100_000 })
  const seed = usage.append({ conversationId: 'private:1', sessionId: 'seed', generation: 1, turnId: 'seed',
    provider: 'synthetic', model: 'synthetic', status: 'completed', coverage: 'complete',
    tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, reasoning: 0, total: 16 },
    reportedCost: { amount: 1, currency: 'USD' } })
  const visits: number[] = []
  for (const count of [1_000, 2_000]) {
    let reads = 0
    assert(!('retired' in seed))
    const rows = Array.from({ length: count }, (_unused, index) => ({ ...seed,
      cursor: `cursor-${index}`, conversationId: `private:${1_000 + index}`,
      sessionId: `session-${index}`, recordedAt: 100_000 + index % 13 }))
    const items = rows.map(row => new Proxy(row, { get(target, property, receiver) {
      if (property === 'conversationId') reads++
      return Reflect.get(target, property, receiver)
    } }))
    const projection = createNativeUsageProjection({ usage: { ...usage,
      snapshot: () => ({ items, truncated: false, next: null }) }, clock: () => 200_000 })
    const result = projection.summary({ limit: 10 })
    const measured = reads
    visits.push(measured)
    assert(measured <= count * 20, `${count} records required ${measured} conversation reads`)
    const expected = [...rows].sort((left, right) => right.recordedAt - left.recordedAt
      || left.conversationId.localeCompare(right.conversationId)).slice(0, 10)
    assert.deepEqual(result.conversations.map(row => row.key), expected.map(row => row.conversationId))
    assert.equal(result.totals.totalTokens, count * 16)
    assert.equal(result.totals.cost, count)
    assert.equal(result.totals.conversations, count)
    assert.equal(result.conversations.every(row => row.sessionCount === 1 && row.steps === 1 && row.totalTokens === 16), true)
    assert.equal(result.limited, true)
  }
  assert(visits[1] <= visits[0] * 2.1)
})

test('linear grouping retains partial coverage, currency subtotals and per-conversation ordering', context => {
  const store = createSqliteStore({ filename: ':memory:' })
  context.after(() => store.close())
  let now = 100
  const usage = createNativeUsage({ store, clock: () => now })
  for (let index = 0; index < 12; index++) {
    now += 10
    usage.append({ conversationId: `group:${100 + index % 3}`, sessionId: `session-${index % 3}`,
      generation: 1, turnId: `turn-${index}`, provider: 'synthetic', model: 'synthetic',
      status: 'completed', coverage: index === 5 ? 'partial' : 'complete',
      tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, reasoning: null, total: 16 },
      reportedCost: { amount: 1, currency: index % 2 ? 'CNY' : 'USD' } })
  }
  const projection = createNativeUsageProjection({ usage, clock: () => 1_000 })
  const result = projection.summary({ limit: 2 })
  assert.equal(result.currency, 'MULTI')
  assert.equal(result.totals.cost, null)
  assert.equal(result.totals.totalTokens, null)
  assert.deepEqual(result.totals.knownCosts, { USD: 6, CNY: 6 })
  assert.deepEqual(result.conversations.map(row => row.key), ['group:102', 'group:101'])
  assert.equal(result.conversations.every(row => row.steps === 4 && row.turns === 4 && row.sessionCount === 1), true)
  assert.equal(result.conversations[0].coverage, 'partial')
  assert.equal(result.conversations[1].coverage, 'complete')
  assert.equal(result.limited, true)
  const page = usage.snapshot()
  const truncated = createNativeUsageProjection({ usage: { ...usage,
    snapshot: () => ({ ...page, truncated: true, next: 'continuation' }) } }).summary()
  assert.equal(truncated.totals.totalTokens, null)
  assert.equal(truncated.totals.coverage, 'partial')
  assert.equal(truncated.limited, true)
})
