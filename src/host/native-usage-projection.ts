import type { Clock } from '../core/types.ts'
import { assert, reference, snapshot } from '../core/values.ts'
import { digest } from './data.ts'
import type { createNativeUsage, NativeUsagePrice, NativeUsageQuery } from './native-usage.ts'
import { DEFAULT_USAGE_PRICE_TABLE, defaultUsagePriceAt, type DefaultUsagePriceTable } from './default-usage-prices.ts'

type Usage = Pick<ReturnType<typeof createNativeUsage>, 'snapshot' | 'summary' | 'recent'> & {
  readonly sessionLedgers?: ReturnType<typeof createNativeUsage>['sessionLedgers']
  pricing(): { readonly revision: number | null; readonly prices: readonly NativeUsagePrice[]; readonly builtin?: DefaultUsagePriceTable }
}
type UsageRecord = ReturnType<Usage['snapshot']>['items'][number]

function symbol(currency: string): string {
  return currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : currency === 'EUR' ? '€' : currency
}

function numericId(value: string): number | null {
  return /^(0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
}

function currencies(items: readonly UsageRecord[], prices: ReturnType<Usage['pricing']>): string {
  const reported = new Set(items.flatMap(item => item.cost ? [item.cost.currency] : []))
  const catalog = new Set(prices.prices.map(price => price.currency))
  const selected = reported.size > 0 ? reported : catalog.size > 0 ? catalog : new Set([(prices.builtin ?? DEFAULT_USAGE_PRICE_TABLE).currency])
  return selected.size === 1 ? [...selected][0] : selected.size === 0 ? 'UNKNOWN' : 'MULTI'
}

function totals(records: readonly UsageRecord[], partial: boolean, currency: string, includeDetails = false) {
  const items = includeDetails ? records : records.filter(item => item.recordKind !== 'detail-only')
  const modelRecords = records.filter(item => item.recordKind !== 'opening-balance')
  const totalModelRecords = items.filter(item => item.recordKind !== 'opening-balance')
  const complete = !partial && totalModelRecords.every(item => item.coverage === 'complete')
  const sumKnown = (values: readonly (number | null | undefined)[]) => {
    const known = values.filter((value): value is number => value !== null && value !== undefined)
    if (known.length === 0) return null
    const total = known.reduce((amount, value) => amount + value, 0)
    assert(Number.isSafeInteger(total), 'USAGE_TOTAL_OVERFLOW', 'Usage total exceeds safe integer bounds.')
    return total
  }
  const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'reasoning'] as const
  const missingTokens = Object.fromEntries(tokenKeys.map(key => [key,
    items.filter(item => item.tokens[key] === null || item.tokens[key] === undefined).length])) as Record<typeof tokenKeys[number], number>
  const sum = (key: keyof UsageRecord['tokens']) => sumKnown(items.map(item => item.tokens[key]))
  const priced = items.filter(item => item.cost?.currency === currency)
  const cost = priced.length > 0 ? priced.reduce((amount, item) => amount + item.cost!.amount, 0) : null
  const cacheMiss = sum('input')
  const cacheHit = sum('cacheRead')
  const cacheWrite = sum('cacheWrite')
  const inputs = items.map(item => {
    const counts = item.tokens
    if (counts.input !== null && counts.cacheRead !== null && counts.cacheWrite !== null) {
      return counts.input + counts.cacheRead + counts.cacheWrite
    }
    // Exact aggregate input remains available even when its cache split is unknown.
    if (counts.total !== null && counts.output !== null && counts.total >= counts.output
      && counts.total - counts.output >= (counts.input ?? 0) + (counts.cacheRead ?? 0) + (counts.cacheWrite ?? 0)) {
      return counts.total - counts.output
    }
    return null
  })
  const input = sumKnown(inputs)
  const missingCostRecords = items.filter(item => item.cost === null).length
  const costComplete = complete && items.length > 0 && missingCostRecords === 0 && priced.length === items.length
  const totalsComplete = costComplete
    && tokenKeys.filter(key => key !== 'reasoning').every(key => missingTokens[key] === 0)
  const turns = new Set(modelRecords.map(item => digest([item.sessionId, item.generation, item.turnId]))).size
  const totalModelTurns = new Set(totalModelRecords.map(item => digest([item.sessionId, item.generation, item.turnId]))).size
  const modelCost = totalModelRecords.length > 0 && !partial
    && totalModelRecords.every(item => item.coverage === 'complete' && item.cost?.currency === currency)
    ? totalModelRecords.reduce((amount, item) => amount + item.cost!.amount, 0) : null
  return { totalTokens: sum('total'), inputTokens: input, outputTokens: sum('output'),
    cacheHitTokens: cacheHit, cacheMissTokens: cacheMiss, cacheWriteTokens: cacheWrite, reasoningTokens: sum('reasoning'),
    cost, estimated: items.some(item => item.cost?.source === 'operator-price-estimate') || !totalsComplete,
    conversations: new Set(records.map(item => digest([item.conversationId, item.sessionId]))).size, turns, steps: modelRecords.length,
    attributedCost: cost, unattributedCost: 0,
    buckets: { cacheMiss, cacheHit, cacheWrite, output: sum('output'), reasoning: sum('reasoning') },
    byTier: null, cacheHitRate: !complete || missingTokens.cacheRead > 0 || inputs.some(value => value === null)
      || input === null || cacheHit === null ? null : input > 0 ? cacheHit / input : 0,
    avgCostPerTurn: modelCost === null ? null : totalModelTurns > 0 ? modelCost / totalModelTurns : 0,
    avgCostPerStep: modelCost === null ? null : totalModelRecords.length > 0 ? modelCost / totalModelRecords.length : 0,
    coverage: items.length === 0 ? 'unknown' : totalsComplete ? 'complete' : 'partial',
    totalsComplete, costComplete, missingTokens, missingCostRecords,
    knownCosts: Object.fromEntries([...new Set(items.flatMap(item => item.cost ? [item.cost.currency] : []))]
      .map(unit => [unit, items.reduce((amount, item) => amount + (item.cost?.currency === unit ? item.cost.amount : 0), 0)])),
    missingCostTurns: new Set(totalModelRecords.filter(item => !item.cost).map(item => digest([item.sessionId, item.generation, item.turnId]))).size,
    currencies: [...new Set(items.flatMap(item => item.cost ? [item.cost.currency] : []))] }
}

function groupTurns(items: readonly UsageRecord[], partial: boolean, currency: string) {
  const groups = new Map<string, UsageRecord[]>()
  for (const item of items) {
    if (item.recordKind === 'opening-balance') continue
    const key = digest([item.conversationId, item.sessionId, item.generation, item.turnId])
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  return [...groups.values()].map(group => {
    const first = group[0]
    const summary = totals(group, partial, currency, true)
    const providers = [...new Set(group.map(item => item.provider))]
    const models = [...new Set(group.map(item => item.model))]
    const tiers = [...new Set(group.map(item => item.priceSnapshot?.tier ?? 'flat'))]
    return { sessionId: first.sessionId, key: first.conversationId, generation: first.generation,
      turn: numericId(first.turnId), turnId: first.turnId, steps: group.length, attempts: group.length,
      status: group.some(item => item.status === 'failed') ? 'failed'
        : group.some(item => item.status === 'unknown') ? 'unknown' : 'completed',
      attemptsSource: 'observed-model-response-events',
      startedAt: Math.min(...group.map(item => item.recordedAt)), endedAt: Math.max(...group.map(item => item.recordedAt)),
      timeSource: 'framework-observed', model: models.length === 1 ? models[0] : null,
      provider: providers.length === 1 ? providers[0] : null,
      buckets: summary.buckets, cost: summary.cost, tier: tiers.length === 1 ? tiers[0] : 'mixed', coverage: summary.coverage,
      costRecovery: group.some(item => item.costRecovery === 'historical-reference') ? 'historical-reference'
        : group.some(item => item.costRecovery === 'price-snapshot') ? 'price-snapshot' : null,
      knownCosts: Object.fromEntries([...new Set(group.flatMap(item => item.cost ? [item.cost.currency] : []))]
        .map(unit => [unit, group.reduce((amount, item) => amount + (item.cost?.currency === unit ? item.cost.amount : 0), 0)])) }
  }).sort((left, right) => right.endedAt - left.endedAt || left.sessionId.localeCompare(right.sessionId))
}

export function createNativeUsageProjection({ usage, clock = Date.now }: { readonly usage: Usage; readonly clock?: Clock }) {
  return Object.freeze({
    summary(query: NativeUsageQuery = {}) {
      const page = usage.snapshot(query)
      const prices = usage.pricing()
      const generatedAt = clock()
      const builtin = prices.builtin ?? DEFAULT_USAGE_PRICE_TABLE
      const currency = currencies(page.items, prices)
      const aggregate = totals(page.items, page.truncated, currency)
      const limit = Math.min(query.limit ?? 200, 500)
      const ledgerIndex = usage.sessionLedgers?.()
      const ledgerRevisions = new Map(ledgerIndex && !ledgerIndex.partial
        ? ledgerIndex.items.map(entry => [entry.ledgerKey, entry.revision]) : [])
      const conversationRows = new Map<string, UsageRecord[]>()
      for (const item of page.items) {
        const ledgerKey = digest([item.conversationId, item.sessionId])
        const rows = conversationRows.get(ledgerKey)
        if (rows) rows.push(item)
        else conversationRows.set(ledgerKey, [item])
      }
      const conversations = [...conversationRows].map(([ledgerKey, rows]) => {
        const { conversationId: key, sessionId } = rows[0]
        return { key, ledgerKey, sessionId, revision: ledgerRevisions.get(ledgerKey) ?? null, sessionCount: 1,
          ...totals(rows, page.truncated, currency), models: [...new Set(rows.map(item => item.model))],
          firstAt: Math.min(...rows.map(item => item.recordedAt)), lastAt: Math.max(...rows.map(item => item.recordedAt)) }
      }).sort((left, right) => right.lastAt - left.lastAt || left.key.localeCompare(right.key)
        || left.sessionId.localeCompare(right.sessionId)).slice(0, limit)
      const observed = page.items.filter(item => item.recordKind !== 'opening-balance')
        .reduce<UsageRecord | null>((prior, item) => prior === null || item.recordedAt > prior.recordedAt ? item : prior, null)
      const model = query.model ?? observed?.model ?? (prices.prices.length === 1 ? prices.prices[0].model : builtin.referenceModel)
      const provider = query.provider ?? observed?.provider
      const matchingPrices = prices.prices.filter(price => price.model === model && (provider === undefined || price.provider === provider))
      const nowPrice = matchingPrices.length === 1 ? matchingPrices[0] : null
      const manualPrices = nowPrice ? prices.prices.filter(price => price.currency === nowPrice.currency) : []
      const priceTable = nowPrice ? { version: `native:${prices.revision}`, currency: nowPrice.currency,
        symbol: symbol(nowPrice.currency), unit: 1_000_000, pricingMode: 'flat', peakMultiplier: 1,
        peakWindows: [], peakWeekdays: [], holidayCount: 0,
        models: Object.fromEntries(manualPrices.map(price => [`${price.provider}/${price.model}`, {
          label: `${price.provider} / ${price.model}`, provider: price.provider, model: price.model,
          off: { cacheMiss: price.inputPerMillion, cacheHit: price.cacheReadPerMillion,
            cacheWrite: price.cacheWritePerMillion, output: price.outputPerMillion } }])) } : builtin
      const nowTier = nowPrice ? { model: nowPrice.model, label: nowPrice.model, tier: 'flat', tierLabel: '固定单价',
        requestedModel: nowPrice.model, referenceModel: nowPrice.model, fallbackUsed: false,
        currency: nowPrice.currency, symbol: symbol(nowPrice.currency), unit: 1_000_000, estimated: true,
        cacheMiss: nowPrice.inputPerMillion, cacheHit: nowPrice.cacheReadPerMillion,
        cacheWrite: nowPrice.cacheWritePerMillion, output: nowPrice.outputPerMillion }
        : matchingPrices.length === 0 ? defaultUsagePriceAt(model, generatedAt, builtin) : null
      return snapshot({ ...usage.summary(query), source: 'chat-ledger', native: true,
        revision: digest(page.items.map(item => [item.cursor, item.pricingRevision])), generatedAt, currency, symbol: symbol(currency),
        totals: aggregate, conversations, limit, limited: page.truncated || conversationRows.size > limit,
        unavailable: [], priceVersion: priceTable.version,
        pricingEstimateAvailable: nowTier !== null,
        pricingEstimateMissingReasons: nowTier ? [] : ['model_pricing_unavailable'],
        nowTier, priceTable, pricingMode: priceTable.pricingMode, prices, resetAvailable: true,
        priceSelection: { model, provider: provider ?? null,
          source: query.model ? 'query' : observed ? 'observed-history'
            : prices.prices.length === 1 ? 'operator-example' : 'builtin-reference' },
        ledger: { journalLines: page.items.length, maxLines: null, droppedLines: null,
          sessions: new Set(page.items.map(item => item.sessionId)).size,
          baselines: page.items.some(item => item.recordKind === 'opening-balance')
            ? page.items.filter(item => item.recordKind === 'opening-balance').length : null,
          samples: page.items.filter(item => item.recordKind !== 'opening-balance').length,
          lastIngestAt: page.items.length > 0 ? Math.max(...page.items.map(item => item.recordedAt)) : null, lastCompactedAt: null } })
    },
    conversation(key: string, query: NativeUsageQuery = {}) {
      assert(reference(key), 'USAGE_INVALID_QUERY', 'An explicit native conversation is required.')
      const page = usage.snapshot({ ...query, conversationId: key })
      const currency = currencies(page.items, usage.pricing())
      const aggregate = totals(page.items, page.truncated, currency)
      const allTurns = groupTurns(page.items, page.truncated, currency)
      const limit = query.limit ?? 200
      const sessions = [...new Set(page.items.map(item => item.sessionId))]
      return snapshot({ native: true, key, generatedAt: clock(), currency, symbol: symbol(currency),
        ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId, ledgerKey: digest([key, query.sessionId]) }),
        sessionIds: sessions, sessionCount: sessions.length, buckets: aggregate.buckets, cost: aggregate.cost,
        knownCosts: aggregate.knownCosts, missingCostTurns: aggregate.missingCostTurns,
        attributedCost: aggregate.cost, unattributedCost: 0, byTier: null, estimated: aggregate.estimated,
        firstAt: page.items.length > 0 ? Math.min(...page.items.map(item => item.recordedAt)) : 0,
        lastAt: page.items.length > 0 ? Math.max(...page.items.map(item => item.recordedAt)) : 0,
        models: [...new Set(page.items.map(item => item.model))], turnLimit: limit,
        limited: page.truncated || allTurns.length > limit, partial: page.truncated,
        turns: allTurns.slice(0, limit), items: page.items.slice(0, limit), next: page.next })
    },
    recent(query: NativeUsageQuery = {}) {
      const page = usage.recent({ ...query, limit: Math.min(query.limit ?? 40, 500) })
      const items = page.items.filter(item => item.recordKind !== 'opening-balance')
      const currency = currencies(items, usage.pricing())
      return snapshot({ ...page, items, native: true, currency, symbol: symbol(currency),
        entries: items.map(item => ({ time: item.recordedAt, key: item.conversationId, sid: item.sessionId,
          turn: numericId(item.turnId), turnId: item.turnId, step: item.stepNumber ?? null, retry: item.retryNumber ?? null,
          model: item.model, provider: item.provider, tokens: item.tokens.total, cacheMiss: item.tokens.input,
          cacheHit: item.tokens.cacheRead, cacheWrite: item.tokens.cacheWrite, output: item.tokens.output,
          reasoning: item.tokens.reasoning ?? null, cost: item.cost?.currency === currency ? item.cost.amount : null,
          currency: item.cost?.currency ?? null, knownCost: item.cost, costRecovery: item.costRecovery, tier: item.priceSnapshot?.tier ?? 'flat',
          estimated: item.cost?.source === 'operator-price-estimate', coverage: item.coverage,
          pricingRevision: item.pricingRevision })) })
    },
    series(hours = 24, bucketCount = 48, query: NativeUsageQuery = {}) {
      assert(Number.isSafeInteger(hours) && hours >= 1 && hours <= 2_160 && Number.isSafeInteger(bucketCount)
        && bucketCount >= 1 && bucketCount <= 120, 'USAGE_INVALID_QUERY', 'Usage charts require a bounded window and bucket count.')
      const generatedAt = clock()
      const bucketMs = Math.max(60_000, Math.ceil(hours * 3_600_000 / bucketCount))
      const to = Math.floor(generatedAt / bucketMs) * bucketMs + bucketMs
      const from = to - bucketMs * bucketCount
      const page = usage.snapshot(query)
      const modelRecords = page.items.filter(item => item.recordKind !== 'opening-balance')
      const currency = currencies(modelRecords, usage.pricing())
      const selected = modelRecords.filter(item => item.recordedAt >= from && item.recordedAt < to)
      const buckets = Array.from({ length: bucketCount }, (_unused, index) => {
        const t = from + index * bucketMs
        const rows = selected.filter(item => item.recordedAt >= t && item.recordedAt < t + bucketMs)
        const aggregate = totals(rows, page.truncated, currency, true)
        const keys = [...new Set(rows.map(item => item.conversationId))]
        const tiers = [...new Set(rows.map(item => item.priceSnapshot?.tier ?? 'flat'))]
        return { t, cost: aggregate.cost, tokens: aggregate.totalTokens, cacheMiss: aggregate.cacheMissTokens,
          cacheHit: aggregate.cacheHitTokens, cacheWrite: aggregate.cacheWriteTokens, output: aggregate.outputTokens,
          turns: aggregate.turns, steps: rows.length, tier: tiers.length === 1 ? tiers[0] : tiers.length > 1 ? 'mixed' : 'flat', keys: keys.slice(0, 500),
          keysLimited: keys.length > 500, coverage: aggregate.coverage }
      })
      const aggregate = totals(selected, page.truncated, currency, true)
      const outside = totals(modelRecords.filter(item => item.recordedAt < from || item.recordedAt >= to), page.truncated, currency, true)
      const busiest = buckets.reduce<(typeof buckets)[number] | null>((prior, item) =>
        prior === null || (item.cost ?? 0) > (prior.cost ?? 0) || item.cost === prior.cost && (item.tokens ?? 0) > (prior.tokens ?? 0)
          ? item : prior, null)
      return snapshot({ native: true, ok: true, generatedAt, currency, symbol: symbol(currency), hours, bucketMs, from, to,
        buckets, totals: { cost: aggregate.cost, tokens: aggregate.totalTokens, turns: aggregate.turns, steps: selected.length },
        busiest: busiest ? { t: busiest.t, cost: busiest.cost, tokens: busiest.tokens } : null,
        estimated: aggregate.estimated, countedSamples: selected.length, offChartCost: outside.cost,
        offChartTokens: outside.totalTokens, partial: page.truncated, next: page.next,
        knownCosts: aggregate.knownCosts })
    }
  })
}
