import type { Clock, JsonObject } from '../core/types.ts'
import { FrameworkError, assert, isRecord, reference, snapshot } from '../core/values.ts'
import type { DurableStore, StoredRecord } from './types.ts'
import { digest, json, object } from './data.ts'

export interface NativeUsageTokens {
  readonly input: number | null
  readonly output: number | null
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
  readonly total: number | null
  readonly reasoning?: number | null
}

export interface NativeUsagePrice {
  readonly provider: string
  readonly model: string
  readonly currency: string
  readonly inputPerMillion: number
  readonly outputPerMillion: number
  readonly cacheReadPerMillion: number
  readonly cacheWritePerMillion: number
}

export interface NativeUsageTurn {
  readonly conversationId: string
  readonly sessionId: string
  readonly generation: number
  readonly turnId: string
  readonly stepId?: string | null
  readonly stepNumber?: number | null
  readonly coverage?: 'complete' | 'partial' | 'unknown'
  readonly provider: string
  readonly model: string
  readonly externalProvider?: string
  readonly status: 'completed' | 'failed'
  readonly tokens: NativeUsageTokens
  readonly reportedCost: { readonly amount: number; readonly currency: string } | null
}

export interface NativeUsageQuery {
  readonly limit?: number
  readonly after?: string
  readonly conversationId?: string
  readonly provider?: string
  readonly model?: string
  readonly since?: number
  readonly until?: number
}

const namespace = 'native-usage.turns'
const priceNamespace = 'native-usage.pricing'
const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'reasoning'] as const
const priceKeys = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'] as const

function token(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function money(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15
}

function currency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value)
}

export function validateNativeUsagePrices(input: unknown): readonly NativeUsagePrice[] {
  assert(Array.isArray(input) && input.length <= 256, 'USAGE_INVALID_PRICING', 'A bounded price catalog is required.')
  const seen = new Set<string>()
  return snapshot(input.map(value => {
    assert(isRecord(value) && Object.keys(value).length === 7 && reference(value.provider) && reference(value.model)
      && value.provider.length <= 128 && value.model.length <= 128
      && currency(value.currency) && priceKeys.every(key => money(value[key]) && Number(value[key]) <= 1_000_000),
    'USAGE_INVALID_PRICING', 'Explicit per-million component prices and currency are required.')
    const key = digest([value.provider, value.model])
    assert(!seen.has(key), 'USAGE_INVALID_PRICING', 'Price routes must be unique.')
    seen.add(key)
    return { provider: value.provider, model: value.model, currency: value.currency,
      inputPerMillion: Number(value.inputPerMillion), outputPerMillion: Number(value.outputPerMillion),
      cacheReadPerMillion: Number(value.cacheReadPerMillion), cacheWritePerMillion: Number(value.cacheWritePerMillion) }
  }))
}

function validateTurn(input: NativeUsageTurn): NativeUsageTurn {
  assert(isRecord(input) && reference(input.conversationId) && reference(input.sessionId) && reference(input.turnId)
    && reference(input.provider) && reference(input.model) && Number.isSafeInteger(input.generation) && input.generation > 0
    && (input.externalProvider === undefined || reference(input.externalProvider))
    && ['completed', 'failed'].includes(input.status) && isRecord(input.tokens)
    && (input.stepId === undefined || input.stepId === null || reference(input.stepId))
    && (input.stepNumber === undefined || input.stepNumber === null || token(input.stepNumber))
    && (input.coverage === undefined || ['complete', 'partial', 'unknown'].includes(input.coverage))
    && ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(key => Object.hasOwn(input.tokens, key))
    && Object.keys(input.tokens).every(key => (tokenKeys as readonly string[]).includes(key))
    && tokenKeys.every(key => key === 'reasoning' && input.tokens[key] === undefined
      || input.tokens[key] === null || token(input.tokens[key]))
    && (input.reportedCost === null || isRecord(input.reportedCost) && Object.keys(input.reportedCost).length === 2
      && money(input.reportedCost.amount) && currency(input.reportedCost.currency)),
  'USAGE_INVALID_TURN', 'Usage needs a trusted scoped turn and known or explicitly unknown counters.')
  const knownComponents = [input.tokens.input, input.tokens.output, input.tokens.cacheRead, input.tokens.cacheWrite]
  if (knownComponents.every(value => value !== null)) {
    const total = knownComponents.reduce((sum, value) => sum + value, 0)
    assert(Number.isSafeInteger(total) && (input.tokens.total === null || input.tokens.total === total),
      'USAGE_INVALID_TURN', 'Reported total must match all reported token components.')
  }
  return snapshot({ ...input, tokens: { ...input.tokens, reasoning: input.tokens.reasoning ?? null },
    stepId: input.stepId ?? null, coverage: input.coverage ?? 'unknown' })
}

function validateQuery(query: NativeUsageQuery): Required<Pick<NativeUsageQuery, 'limit'>> & NativeUsageQuery {
  const limit = query.limit ?? 100
  assert(Number.isSafeInteger(limit) && limit > 0 && limit <= 1_000
    && Object.keys(query).every(key => ['limit', 'after', 'conversationId', 'provider', 'model', 'since', 'until'].includes(key))
    && ['after', 'conversationId', 'provider', 'model'].every(key => query[key as keyof NativeUsageQuery] === undefined
      || reference(query[key as keyof NativeUsageQuery]))
    && [query.since, query.until].every(value => value === undefined || token(value))
    && (query.since === undefined || query.until === undefined || query.since < query.until),
  'USAGE_INVALID_QUERY', 'Usage queries must be bounded and unambiguous.')
  return { ...query, limit }
}

function storedTurn(record: StoredRecord) {
  const value = object(record.value)
  assert(value.schema === 1 && reference(value.fingerprint) && token(value.recordedAt) && isRecord(value.turn)
    && (value.cost === null || isRecord(value.cost) && money(value.cost.amount) && currency(value.cost.currency)
      && ['reported', 'operator-price-estimate'].includes(String(value.cost.source))),
  'USAGE_DATA_CORRUPT', 'Stored usage metadata is invalid.')
  const turn = validateTurn(value.turn as unknown as NativeUsageTurn)
  return { cursor: record.key, ...turn, recordedAt: value.recordedAt,
    cost: value.cost as { amount: number; currency: string; source: string } | null,
    pricingRevision: value.pricingRevision as number | null }
}

function matches(turn: ReturnType<typeof storedTurn>, query: NativeUsageQuery): boolean {
  return (query.conversationId === undefined || turn.conversationId === query.conversationId)
    && (query.provider === undefined || turn.provider === query.provider)
    && (query.model === undefined || turn.model === query.model)
    && (query.since === undefined || turn.recordedAt >= query.since)
    && (query.until === undefined || turn.recordedAt < query.until)
}

export function createNativeUsage({ store, clock = Date.now, maxScan = 10_000 }:
  { readonly store: DurableStore; readonly clock?: Clock; readonly maxScan?: number }) {
  assert(Number.isSafeInteger(maxScan) && maxScan >= 1 && maxScan <= 100_000,
    'USAGE_INVALID_OPTIONS', 'Usage scans must have a finite bound.')

  function pricing() {
    const record = store.read(priceNamespace, 'catalog')
    return { revision: record?.revision ?? null,
      prices: record ? validateNativeUsagePrices(object(record.value).prices) : [] }
  }

  function scan(query: NativeUsageQuery = {}) {
    const validated = validateQuery(query)
    const items: ReturnType<typeof storedTurn>[] = []
    let after = validated.after
    let scanned = 0
    while (scanned < maxScan) {
      const limit = Math.min(256, maxScan - scanned)
      const batch = store.list(namespace, { limit, ...(after === undefined ? {} : { after }) })
      for (const record of batch) {
        scanned++
        after = record.key
        const turn = storedTurn(record)
        if (matches(turn, validated)) items.push(turn)
      }
      if (batch.length < limit) return { items, truncated: false, next: null }
    }
    const more = store.list(namespace, { limit: 1, ...(after === undefined ? {} : { after }) }).length > 0
    return { items, truncated: more, next: more ? after ?? null : null }
  }

  function summarize(items: readonly ReturnType<typeof storedTurn>[], partial: boolean) {
    const knownTokens = Object.fromEntries(tokenKeys.map(key => [key, 0])) as Record<typeof tokenKeys[number], number>
    const missingTokens = Object.fromEntries(tokenKeys.map(key => [key, 0])) as Record<typeof tokenKeys[number], number>
    const costs: Record<string, number> = {}
    let missingCostTurns = 0
    for (const turn of items) {
      for (const key of tokenKeys) {
        const value = turn.tokens[key] ?? null
        if (value === null) missingTokens[key]++
        else {
          knownTokens[key] += value
          assert(Number.isSafeInteger(knownTokens[key]), 'USAGE_TOTAL_OVERFLOW', 'Usage total exceeds safe integer bounds.')
        }
      }
      if (!turn.cost) missingCostTurns++
      else {
        costs[turn.cost.currency] = (costs[turn.cost.currency] ?? 0) + turn.cost.amount
        assert(Number.isFinite(costs[turn.cost.currency]), 'USAGE_TOTAL_OVERFLOW', 'Usage cost total exceeds numeric bounds.')
      }
    }
    const incompleteTurns = new Set(items.filter(turn => turn.coverage !== 'complete')
      .map(turn => digest([turn.sessionId, turn.generation, turn.turnId])))
    const tokens = Object.fromEntries(tokenKeys.map(key => [key,
      partial || missingTokens[key] > 0 || incompleteTurns.size > 0 ? null : knownTokens[key]]))
    return { turns: new Set(items.map(turn => digest([turn.sessionId, turn.generation, turn.turnId]))).size,
      records: items.length, incompleteTurns: incompleteTurns.size, partial, tokens, knownTokens, missingTokens,
      knownCosts: costs, missingCostTurns, costComplete: !partial && missingCostTurns === 0 && incompleteTurns.size === 0,
      tokenUsageAvailable: items.some(turn => tokenKeys.some(key => turn.tokens[key] !== null)),
      source: 'durable-dsh-turn-events', observationScope: 'observed-terminal-turns-only',
      retention: 'explicit-store-capacity-no-automatic-reset' }
  }

  return Object.freeze({
    snapshot(query: NativeUsageQuery = {}) { return snapshot(scan(query)) },
    pricing,
    setPricing(prices: unknown, expectedRevision: number | null) {
      const validated = validateNativeUsagePrices(prices)
      assert(expectedRevision === null || token(expectedRevision) && expectedRevision > 0,
        'USAGE_INVALID_PRICING', 'An explicit current price revision is required.')
      store.write(priceNamespace, 'catalog', json({ prices: validated }), { expectedRevision })
      return pricing()
    },
    append(input: NativeUsageTurn) {
      const turn = validateTurn(input)
      const key = digest([turn.conversationId, turn.sessionId, turn.generation, turn.turnId, turn.stepId])
      const fingerprint = digest(turn)
      const prior = store.read(namespace, key)
      if (prior) {
        assert(object(prior.value).fingerprint === fingerprint, 'USAGE_TURN_CONFLICT', 'A recorded turn has different usage.')
        return storedTurn(prior)
      }
      const prices = pricing()
      const price = prices.prices.find(value => value.provider === turn.provider && value.model === turn.model)
      let cost: JsonObject | null = turn.reportedCost === null ? null : { ...turn.reportedCost, source: 'reported' }
      if (cost === null && price && [turn.tokens.input, turn.tokens.output, turn.tokens.cacheRead, turn.tokens.cacheWrite]
        .every(value => value !== null)) {
        const amount = (turn.tokens.input! * price.inputPerMillion + turn.tokens.output! * price.outputPerMillion
          + turn.tokens.cacheRead! * price.cacheReadPerMillion + turn.tokens.cacheWrite! * price.cacheWritePerMillion) / 1_000_000
        assert(money(amount), 'USAGE_COST_OVERFLOW', 'Estimated cost exceeds supported bounds.')
        cost = { amount, currency: price.currency, source: 'operator-price-estimate' }
      }
      const recordedAt = clock()
      assert(token(recordedAt), 'USAGE_INVALID_CLOCK', 'Usage needs a nonnegative integer timestamp.')
      try {
        return storedTurn(store.write(namespace, key,
          json({ schema: 1, turn, fingerprint, cost, pricingRevision: prices.revision, recordedAt }), { expectedRevision: null }))
      } catch (error) {
        if (!(error instanceof FrameworkError) || error.code !== 'STORE_CONFLICT') throw error
        const winner = store.read(namespace, key)
        assert(winner && object(winner.value).fingerprint === fingerprint, 'USAGE_TURN_CONFLICT', 'A recorded turn has different usage.')
        return storedTurn(winner)
      }
    },
    list(query: NativeUsageQuery = {}) {
      const validated = validateQuery(query)
      const page = scan(validated)
      const items = page.items.slice(0, validated.limit)
      const next = page.items.length > validated.limit ? items.at(-1)?.cursor ?? null : page.next
      return snapshot({ items, next, partial: page.truncated })
    },
    summary(query: NativeUsageQuery = {}) {
      const page = scan(query)
      return snapshot({ ...summarize(page.items, page.truncated), next: page.next })
    },
    recent(query: NativeUsageQuery = {}) {
      const validated = validateQuery(query)
      const page = scan(validated)
      return snapshot({ items: page.items.sort((left, right) => right.recordedAt - left.recordedAt
        || left.cursor.localeCompare(right.cursor)).slice(0, validated.limit), partial: page.truncated })
    },
    series(query: NativeUsageQuery = {}, bucketMs = 3_600_000) {
      assert(Number.isSafeInteger(bucketMs) && bucketMs >= 60_000 && bucketMs <= 86_400_000,
        'USAGE_INVALID_QUERY', 'Usage buckets must be between one minute and one day.')
      const page = scan(query)
      const buckets = new Map<number, ReturnType<typeof storedTurn>[]>()
      for (const turn of page.items) {
        const start = Math.floor(turn.recordedAt / bucketMs) * bucketMs
        const bucket = buckets.get(start) ?? []
        bucket.push(turn)
        buckets.set(start, bucket)
      }
      assert(buckets.size <= 1_000, 'USAGE_QUERY_TOO_WIDE', 'Narrow the time range or increase the bucket size.')
      return snapshot({ bucketMs, partial: page.truncated, next: page.next,
        items: [...buckets].sort(([left], [right]) => left - right)
          .map(([start, turns]) => ({ start, end: start + bucketMs, ...summarize(turns, page.truncated) })) })
    }
  })
}
