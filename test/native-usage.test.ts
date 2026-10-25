import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNativeUsage, validateNativeUsagePrices, type NativeUsageTurn } from '../src/host/native-usage.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createNativeUsageProjection } from '../src/host/native-usage-projection.ts'

const usageTurn: NativeUsageTurn = { conversationId: 'private:123', sessionId: 'session-1', generation: 1,
  turnId: 'turn-1', stepId: 'step-1', coverage: 'complete', provider: 'provider', model: 'model', status: 'completed',
  tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, total: 170 }, reportedCost: null }
const price = { provider: 'provider', model: 'model', currency: 'USD', inputPerMillion: 1,
  outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.5 }

test('durable usage deduplicates model steps per turn and never reprices old records implicitly', context => {
  const directory = mkdtempSync(join(tmpdir(), 'native-usage-'))
  let store = createSqliteStore({ filename: join(directory, 'usage.sqlite') })
  context.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  let usage = createNativeUsage({ store, clock: () => 1_000 })
  assert.equal(usage.pricing().revision, null)
  assert.deepEqual(usage.pricing().prices, [])
  assert.equal(usage.pricing().builtin.referenceOnly, true)
  const prices = usage.setPricing([price], null)
  const first = usage.append(usageTurn)
  assert(!('retired' in first))
  assert.equal(first.cost?.source, 'operator-price-estimate')
  assert.equal(first.cost?.amount, 0.000145)
  assert.deepEqual(usage.append(usageTurn), first)
  assert.throws(() => usage.append({ ...usageTurn, tokens: { ...usageTurn.tokens, input: 101, total: 171 } }), { code: 'USAGE_TURN_CONFLICT' })
  usage.append({ ...usageTurn, stepId: 'step-2' })
  const totals = usage.summary()
  assert.equal(totals.turns, 1)
  assert.equal(totals.records, 2)
  assert.equal(totals.tokens.total, 340)
  assert.equal(totals.costComplete, true)
  store.close()
  store = createSqliteStore({ filename: join(directory, 'usage.sqlite') })
  usage = createNativeUsage({ store, clock: () => 2_000 })
  usage.setPricing([{ ...price, inputPerMillion: 100 }], prices.revision)
  assert.deepEqual(usage.append(usageTurn), first)
  assert.equal(usage.summary().records, 2)
  assert.equal(usage.summary().knownCosts.USD, 0.00029)
  assert.throws(() => usage.setPricing([price], prices.revision), { code: 'STORE_CONFLICT' })
})

test('unknown counters, partial streams and missing prices remain unknown rather than zero', context => {
  const store = createSqliteStore({ filename: ':memory:' })
  context.after(() => store.close())
  const usage = createNativeUsage({ store })
  const estimated = usage.append({ ...usageTurn, coverage: 'partial' })
  assert(!('retired' in estimated))
  assert(estimated.cost)
  assert.equal(estimated.priceSnapshot?.source, 'migrated-reference')
  usage.append({ ...usageTurn, turnId: 'turn-2', tokens: { input: null, output: 3, cacheRead: null, cacheWrite: null, total: null } })
  const totals = usage.summary()
  assert.equal(totals.turns, 2)
  assert.equal(totals.tokens.total, null)
  assert.equal(totals.tokens.output, null)
  assert.equal(totals.knownTokens.output, 23)
  assert.equal(totals.missingTokens.total, 1)
  assert.equal(totals.incompleteTurns, 1)
  assert.equal(totals.missingCostTurns, 1)
  assert.equal(totals.costComplete, false)
  assert.deepEqual(totals.knownCosts, { [estimated.cost.currency]: estimated.cost.amount })
})

test('explicit provider-reported costs retain currency and do not require operator estimates', context => {
  const store = createSqliteStore({ filename: ':memory:' })
  context.after(() => store.close())
  const usage = createNativeUsage({ store })
  usage.append({ ...usageTurn, reportedCost: { amount: 0.3, currency: 'USD' } })
  usage.append({ ...usageTurn, turnId: 'turn-2', reportedCost: { amount: 2.5, currency: 'CNY' } })
  assert.deepEqual(usage.summary().knownCosts, { USD: 0.3, CNY: 2.5 })
  assert.equal(usage.summary().costComplete, true)
  assert.throws(() => usage.append({ ...usageTurn, turnId: 'turn-3', reportedCost: { amount: -1, currency: 'USD' } }), { code: 'USAGE_INVALID_TURN' })
})

test('usage queries page, filter and aggregate bounded time series without leaking message content', context => {
  const store = createSqliteStore({ filename: ':memory:' })
  context.after(() => store.close())
  let now = 60_000
  const usage = createNativeUsage({ store, clock: () => now })
  usage.append(usageTurn)
  now = 120_000
  usage.append({ ...usageTurn, turnId: 'turn-2', conversationId: 'group:456' })
  const first = usage.list({ limit: 1 })
  assert.equal(first.items.length, 1)
  assert(first.next)
  const second = usage.list({ limit: 1, after: first.next })
  assert.equal(second.items.length, 1)
  assert.notEqual(first.items[0]?.turnId, second.items[0]?.turnId)
  assert.equal(usage.summary({ conversationId: 'group:456' }).turns, 1)
  assert.equal(usage.summary({ since: 60_000, until: 120_000 }).turns, 1)
  assert.equal(usage.recent().items[0]?.turnId, 'turn-2')
  assert.equal(usage.series({}, 60_000).items.length, 2)
  assert(!JSON.stringify(usage.list()).includes('content'))
  assert.throws(() => usage.list({ limit: 10_000 }), { code: 'USAGE_INVALID_QUERY' })
  assert.throws(() => usage.series({}, 1), { code: 'USAGE_INVALID_QUERY' })
})

test('scan saturation reports partial totals and never fabricates complete usage', context => {
  const store = createSqliteStore({ filename: ':memory:' })
  context.after(() => store.close())
  const writer = createNativeUsage({ store })
  writer.append(usageTurn)
  writer.append({ ...usageTurn, turnId: 'turn-2' })
  const reader = createNativeUsage({ store, maxScan: 1 })
  assert.equal(reader.summary().partial, true)
  assert.equal(reader.summary().tokens.total, null)
  assert.equal(reader.summary().costComplete, false)
  assert(reader.list().next)
})

test('prices and counters validate finite values, complete units and unique model routes', () => {
  for (const invalid of [[{ ...price, outputPerMillion: Infinity }], [price, price], [{ ...price, currency: 'usd' }],
    [{ provider: 'provider', model: 'model', currency: 'USD', inputPerMillion: 1 }]]) {
    assert.throws(() => validateNativeUsagePrices(invalid), { code: 'USAGE_INVALID_PRICING' })
  }
  const store = createSqliteStore({ filename: ':memory:' })
  try {
    const usage = createNativeUsage({ store })
    assert.throws(() => usage.append({ ...usageTurn, tokens: { ...usageTurn.tokens, total: 1 } }), { code: 'USAGE_INVALID_TURN' })
  } finally { store.close() }
})

test('full usage projections preserve mature UI sections and distinguish flat pricing, unknowns and known subtotals', context => {
  const store = createSqliteStore({ filename: ':memory:' })
  context.after(() => store.close())
  const clock = () => 3_600_000
  const usage = createNativeUsage({ store, clock })
  const projection = createNativeUsageProjection({ usage, clock })
  usage.setPricing([price], null)
  usage.append({ ...usageTurn, turnId: '1', stepNumber: 2 })
  const summary = projection.summary({ limit: 200 })
  assert.equal(summary.native, true)
  assert.equal(summary.source, 'chat-ledger')
  assert.equal(summary.totals.totalTokens, 170)
  assert.equal(summary.totals.reasoningTokens, null)
  assert.equal(summary.totals.inputTokens, 150)
  assert.equal(summary.conversations[0]?.key, 'private:123')
  assert.equal(summary.nowTier?.tier, 'flat')
  assert.equal(summary.priceTable?.pricingMode, 'flat')
  assert.equal(summary.resetAvailable, false)
  const series = projection.series(24, 48)
  assert.equal(series.buckets.length, 48)
  assert.equal(series.totals.tokens, 170)
  assert.equal(series.hours, 24)
  const conversation = projection.conversation('private:123', { limit: 200 })
  assert.equal(conversation.turns[0]?.turn, 1)
  assert.equal(conversation.turns[0]?.attemptsSource, 'observed-model-response-events')
  const recent = projection.recent({ limit: 40 })
  assert.equal(recent.entries[0]?.step, 2)
  assert.equal(recent.entries[0]?.retry, null)
  assert.equal(recent.entries[0]?.tier, 'flat')
  usage.append({ ...usageTurn, turnId: 'unknown', coverage: 'unknown',
    tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null } })
  const incomplete = projection.summary()
  assert.equal(incomplete.totals.totalTokens, null)
  assert.equal(incomplete.totals.cost, null)
  assert.equal(incomplete.knownTokens.total, 170)
  assert.equal(incomplete.knownCosts.USD, 0.000145)
  assert.equal(projection.series().totals.cost, null)
})
