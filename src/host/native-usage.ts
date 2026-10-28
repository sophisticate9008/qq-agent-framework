import type { Clock, JsonObject } from '../core/types.ts'
import { FrameworkError, assert, isRecord, reference, snapshot } from '../core/values.ts'
import type { DurableStore, StoredRecord } from './types.ts'
import { digest, json, object } from './data.ts'
import { createDefaultUsagePriceTable, defaultUsagePriceAt } from './default-usage-prices.ts'

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

export interface NativeUsagePriceSnapshot extends NativeUsagePrice {
  readonly schema: 1
  readonly source: 'operator' | 'migrated-reference'
  readonly version: string
  readonly tier: 'flat' | 'peak' | 'off'
  readonly unit: 1_000_000
  readonly at: number
  readonly cacheWritePricing: 'operator' | 'same-as-cache-miss-assumption'
  readonly requestedModel?: string
  readonly referenceModel?: string
  readonly fallbackUsed?: boolean
}

export interface NativeUsageTurn {
  readonly recordKind?: 'turn' | 'opening-balance' | 'detail-only'
  readonly conversationId: string
  readonly sessionId: string
  readonly generation: number
  readonly turnId: string
  readonly stepId?: string | null
  readonly stepNumber?: number | null
  readonly retryNumber?: number | null
  readonly coverage?: 'complete' | 'partial' | 'unknown'
  readonly provider: string
  readonly model: string
  readonly externalProvider?: string
  readonly status: 'completed' | 'failed' | 'unknown'
  readonly tokens: NativeUsageTokens
  readonly reportedCost: { readonly amount: number; readonly currency: string } | null
}

export interface NativeUsageQuery {
  readonly limit?: number
  readonly after?: string
  readonly conversationId?: string
  readonly sessionId?: string
  readonly provider?: string
  readonly model?: string
  readonly since?: number
  readonly until?: number
}

export const NATIVE_USAGE_TURNS_NAMESPACE = 'native-usage.turns'
export const NATIVE_USAGE_ARCHIVE_NAMESPACE = 'native-usage.archive'
export const NATIVE_USAGE_RETIRED_NAMESPACE = 'native-usage.retired'
const namespace = NATIVE_USAGE_TURNS_NAMESPACE
const priceNamespace = 'native-usage.pricing'
const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'reasoning'] as const
const priceKeys = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'] as const

export interface NativeUsageSessionReference {
  readonly namespace: string
  readonly key: string
  readonly revision: number
  readonly fingerprint: string
}

/** References are internal maintenance evidence, not query limits or a filtered display snapshot. */
export function readNativeUsageSessionLedgers(store: Pick<DurableStore, 'list'>) {
  const groups = new Map<string, { conversationId: string; sessionId: string; references: NativeUsageSessionReference[] }>()
  let scanned = 0
  let partial = false
  sources: for (const source of [NATIVE_USAGE_TURNS_NAMESPACE, NATIVE_USAGE_ARCHIVE_NAMESPACE]) {
    let after: string | undefined
    for (;;) {
      const batch = store.list(source, { limit: 256, ...(after === undefined ? {} : { after }) })
      for (const record of batch) {
        if (scanned >= 100_000) { partial = true; break sources }
        scanned++
        const value = object(record.value)
        assert(value.schema === 1 && isRecord(value.turn) && reference(value.turn.conversationId)
          && reference(value.turn.sessionId) && reference(value.fingerprint),
        'USAGE_DATA_CORRUPT', 'Stored ledger scope and fingerprint are required.')
        const { conversationId, sessionId } = value.turn
        const ledgerKey = digest([conversationId, sessionId])
        let group = groups.get(ledgerKey)
        if (!group) {
          group = { conversationId, sessionId, references: [] }
          groups.set(ledgerKey, group)
        }
        group.references.push({ namespace: source, key: record.key, revision: record.revision, fingerprint: value.fingerprint })
      }
      if (batch.length < 256) break
      after = batch[batch.length - 1]!.key
    }
  }
  return { partial, items: [...groups].map(([ledgerKey, group]) => ({ ...group, ledgerKey,
    revision: digest([group.conversationId, group.sessionId,
      group.references.map(row => [row.namespace, row.key, row.revision, row.fingerprint])]) })) }
}

function token(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function money(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15
}

function currency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value)
}

/** A known read split and exact total can prove an omitted write count is zero. */
function restoreZeroCacheTokens(tokens: NativeUsageTokens): NativeUsageTokens {
  if (tokens.cacheRead === null || tokens.input === null || tokens.output === null || tokens.total === null
    || tokens.total !== tokens.input + tokens.output + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0)) return tokens
  return { ...tokens, cacheWrite: tokens.cacheWrite ?? 0 }
}

function historicalReferencePrice(turn: NativeUsageTurn, at: number): NativeUsagePriceSnapshot | undefined {
  const rate = defaultUsagePriceAt(turn.model, at)
  return rate ? { schema: 1, provider: turn.provider, model: turn.model, currency: rate.currency,
    inputPerMillion: rate.cacheMiss, outputPerMillion: rate.output,
    cacheReadPerMillion: rate.cacheHit, cacheWritePerMillion: rate.cacheWrite,
    source: rate.source, version: rate.version, tier: rate.tier, unit: rate.unit, at,
    cacheWritePricing: rate.cacheWritePricing, requestedModel: rate.requestedModel,
    referenceModel: rate.referenceModel, fallbackUsed: rate.fallbackUsed } : undefined
}

function estimatedCost(tokens: NativeUsageTokens, price: NativeUsagePrice): number | null {
  const { input, output, cacheRead, cacheWrite } = tokens
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null
  const amount = (input * price.inputPerMillion + output * price.outputPerMillion
    + cacheRead * price.cacheReadPerMillion + cacheWrite * price.cacheWritePerMillion) / 1_000_000
  assert(money(amount), 'USAGE_COST_OVERFLOW', 'Estimated cost exceeds supported bounds.')
  return amount
}

/** Accept earlier null/zero cache encodings only for deduplication; never infer new usage from them. */
function usageFingerprints(turn: NativeUsageTurn): ReadonlySet<string> {
  let variants: NativeUsageTurn[] = [turn]
  // Earlier DSH projections encoded all input as a cache miss when read usage
  // was missing. Recognize that old fingerprint without rewriting its record.
  if (turn.tokens.input === null && turn.tokens.cacheRead === null
    && turn.tokens.total !== null && turn.tokens.output !== null
    && turn.tokens.total >= turn.tokens.output + (turn.tokens.cacheWrite ?? 0)) {
    variants.push({ ...turn, tokens: { ...turn.tokens,
      input: turn.tokens.total - turn.tokens.output - (turn.tokens.cacheWrite ?? 0) } })
  }
  const compatible = variants.flatMap(base => {
    let encodings = [base]
    if (base.tokens.total !== null && base.tokens.input !== null && base.tokens.output !== null
      && base.tokens.total === base.tokens.input + base.tokens.output + (base.tokens.cacheRead ?? 0) + (base.tokens.cacheWrite ?? 0)) {
      for (const key of ['cacheRead', 'cacheWrite'] as const) if (base.tokens[key] === 0 || base.tokens[key] === null) {
        encodings = encodings.flatMap(value => [value,
          { ...value, tokens: { ...value.tokens, [key]: base.tokens[key] === null ? 0 : null } }])
      }
    }
    return encodings
  })
  return new Set(compatible.map(value => digest(value)))
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
    && (input.recordKind === undefined || ['turn', 'opening-balance', 'detail-only'].includes(input.recordKind))
    && reference(input.provider) && reference(input.model) && Number.isSafeInteger(input.generation) && input.generation > 0
    && (input.externalProvider === undefined || reference(input.externalProvider))
    && ['completed', 'failed', 'unknown'].includes(input.status) && isRecord(input.tokens)
    && (input.stepId === undefined || input.stepId === null || reference(input.stepId))
    && (input.stepNumber === undefined || input.stepNumber === null || token(input.stepNumber))
    && (input.retryNumber === undefined || input.retryNumber === null || token(input.retryNumber))
    && (input.coverage === undefined || ['complete', 'partial', 'unknown'].includes(input.coverage))
    && ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(key => Object.hasOwn(input.tokens, key))
    && Object.keys(input.tokens).every(key => (tokenKeys as readonly string[]).includes(key))
    && tokenKeys.every(key => key === 'reasoning' && input.tokens[key] === undefined
      || input.tokens[key] === null || token(input.tokens[key]))
    && (input.reportedCost === null || isRecord(input.reportedCost) && Object.keys(input.reportedCost).length === 2
      && money(input.reportedCost.amount) && currency(input.reportedCost.currency)),
  'USAGE_INVALID_TURN', 'Usage needs a trusted scoped turn and known or explicitly unknown counters.')
  const tokens = restoreZeroCacheTokens(input.tokens)
  const knownComponents = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite]
  if (knownComponents.every(value => value !== null)) {
    const total = knownComponents.reduce((sum, value) => sum + value, 0)
    assert(Number.isSafeInteger(total) && (input.tokens.total === null || input.tokens.total === total),
      'USAGE_INVALID_TURN', 'Reported total must match all reported token components.')
  }
  return snapshot({ ...input, tokens: { ...tokens, reasoning: tokens.reasoning ?? null },
    stepId: input.stepId ?? null, coverage: input.coverage ?? 'unknown' })
}

function validateQuery(query: NativeUsageQuery): Required<Pick<NativeUsageQuery, 'limit'>> & NativeUsageQuery {
  const limit = query.limit ?? 100
  assert(Number.isSafeInteger(limit) && limit > 0 && limit <= 1_000
    && Object.keys(query).every(key => ['limit', 'after', 'conversationId', 'sessionId', 'provider', 'model', 'since', 'until'].includes(key))
    && ['after', 'conversationId', 'sessionId', 'provider', 'model'].every(key => query[key as keyof NativeUsageQuery] === undefined
      || reference(query[key as keyof NativeUsageQuery]))
    && [query.since, query.until].every(value => value === undefined || token(value))
    && (query.since === undefined || query.until === undefined || query.since < query.until),
  'USAGE_INVALID_QUERY', 'Usage queries must be bounded and unambiguous.')
  return { ...query, limit }
}

export function readNativeUsageStoredTurn(record: StoredRecord) {
  const value = object(record.value)
  assert(value.schema === 1 && reference(value.fingerprint) && token(value.recordedAt) && isRecord(value.turn)
    && (value.cost === null || isRecord(value.cost) && money(value.cost.amount) && currency(value.cost.currency)
      && ['reported', 'operator-price-estimate'].includes(String(value.cost.source))),
  'USAGE_DATA_CORRUPT', 'Stored usage metadata is invalid.')
  const turn = validateTurn(value.turn as unknown as NativeUsageTurn)
  if (value.priceSnapshot !== undefined) {
    const price = object(value.priceSnapshot)
    assert(price.schema === 1 && ['operator', 'migrated-reference'].includes(String(price.source))
      && reference(price.version) && ['flat', 'peak', 'off'].includes(String(price.tier))
      && price.unit === 1_000_000 && token(price.at) && reference(price.provider) && reference(price.model)
      && (price.requestedModel === undefined && price.referenceModel === undefined && price.fallbackUsed === undefined
        || price.requestedModel === turn.model && reference(price.referenceModel) && typeof price.fallbackUsed === 'boolean'
          && price.fallbackUsed === (price.referenceModel !== price.requestedModel))
      && currency(price.currency) && priceKeys.every(key => money(price[key]) && Number(price[key]) <= 1_000_000)
      && ['operator', 'same-as-cache-miss-assumption'].includes(String(price.cacheWritePricing)),
    'USAGE_DATA_CORRUPT', 'Stored usage price snapshot is invalid.')
  }
  const publicTurn: NativeUsageTurn = { conversationId: turn.conversationId, sessionId: turn.sessionId, generation: turn.generation,
    turnId: turn.turnId, provider: turn.provider, model: turn.model, status: turn.status, tokens: turn.tokens, reportedCost: turn.reportedCost,
    ...(turn.recordKind === undefined ? {} : { recordKind: turn.recordKind }), ...(turn.externalProvider === undefined ? {} : { externalProvider: turn.externalProvider }),
    ...(turn.stepId === undefined ? {} : { stepId: turn.stepId }), ...(turn.stepNumber === undefined ? {} : { stepNumber: turn.stepNumber }),
    ...(turn.retryNumber === undefined ? {} : { retryNumber: turn.retryNumber }), ...(turn.coverage === undefined ? {} : { coverage: turn.coverage }) }
  const rawPrice = value.priceSnapshot as unknown as NativeUsagePriceSnapshot | undefined
  let priceSnapshot: NativeUsagePriceSnapshot | undefined = rawPrice === undefined ? undefined : {
    schema: 1, source: rawPrice.source, version: rawPrice.version, tier: rawPrice.tier, unit: 1_000_000, at: rawPrice.at,
    provider: rawPrice.provider, model: rawPrice.model, currency: rawPrice.currency, inputPerMillion: rawPrice.inputPerMillion,
    outputPerMillion: rawPrice.outputPerMillion, cacheReadPerMillion: rawPrice.cacheReadPerMillion, cacheWritePerMillion: rawPrice.cacheWritePerMillion,
    cacheWritePricing: rawPrice.cacheWritePricing, ...(rawPrice.requestedModel === undefined ? {} : { requestedModel: rawPrice.requestedModel }),
    ...(rawPrice.referenceModel === undefined ? {} : { referenceModel: rawPrice.referenceModel }), ...(rawPrice.fallbackUsed === undefined ? {} : { fallbackUsed: rawPrice.fallbackUsed }) }
  const rawCost = value.cost as { amount: number; currency: string; source: string } | null
  let cost = rawCost === null ? null : { amount: rawCost.amount, currency: rawCost.currency, source: rawCost.source }
  let costRecovery: 'price-snapshot' | 'historical-reference' | null = null
  if (cost === null && turn.recordKind !== 'opening-balance' && turn.recordKind !== 'detail-only') {
    const originalPrice = priceSnapshot
    const reference = originalPrice ?? historicalReferencePrice(turn, Number(value.recordedAt))
    const amount = reference ? estimatedCost(turn.tokens, reference) : null
    if (reference && amount !== null) {
      priceSnapshot = reference
      cost = { amount, currency: reference.currency, source: 'operator-price-estimate' }
      costRecovery = originalPrice ? 'price-snapshot' : 'historical-reference'
    }
  }
  return { cursor: record.key, ...publicTurn, recordedAt: value.recordedAt,
    cost, costRecovery,
    ...(priceSnapshot === undefined ? {} : { priceSnapshot }), pricingRevision: value.pricingRevision as number | null }
}

function matches(turn: ReturnType<typeof readNativeUsageStoredTurn>, query: NativeUsageQuery): boolean {
  return (query.conversationId === undefined || turn.conversationId === query.conversationId)
    && (query.sessionId === undefined || turn.sessionId === query.sessionId)
    && (query.provider === undefined || turn.provider === query.provider)
    && (query.model === undefined || turn.model === query.model)
    && (query.since === undefined || turn.recordedAt >= query.since)
    && (query.until === undefined || turn.recordedAt < query.until)
}

export function createNativeUsage({ store, clock = Date.now, maxScan = 10_000, builtinHolidays, builtinHolidayYears }:
  { readonly store: DurableStore; readonly clock?: Clock; readonly maxScan?: number;
    readonly builtinHolidays?: readonly string[]; readonly builtinHolidayYears?: readonly number[] }) {
  assert(Number.isSafeInteger(maxScan) && maxScan >= 1 && maxScan <= 100_000,
    'USAGE_INVALID_OPTIONS', 'Usage scans must have a finite bound.')
  const builtin = createDefaultUsagePriceTable({ holidays: builtinHolidays, holidayYears: builtinHolidayYears })

  function pricing() {
    const record = store.read(priceNamespace, 'catalog')
    return { revision: record?.revision ?? null,
      prices: record ? validateNativeUsagePrices(object(record.value).prices) : [], builtin }
  }

  function scan(query: NativeUsageQuery = {}) {
    const validated = validateQuery(query)
    const items: ReturnType<typeof readNativeUsageStoredTurn>[] = []
    let after = validated.after
    let scanned = 0
    while (scanned < maxScan) {
      const limit = Math.min(256, maxScan - scanned)
      const batch = store.list(namespace, { limit, ...(after === undefined ? {} : { after }) })
      for (const record of batch) {
        scanned++
        after = record.key
        const turn = readNativeUsageStoredTurn(record)
        if (matches(turn, validated)) items.push(turn)
      }
      if (batch.length < limit) return { items, truncated: false, next: null }
    }
    const more = store.list(namespace, { limit: 1, ...(after === undefined ? {} : { after }) }).length > 0
    return { items, truncated: more, next: more ? after ?? null : null }
  }

  function summarize(items: readonly ReturnType<typeof readNativeUsageStoredTurn>[], partial: boolean) {
    const knownTokens = Object.fromEntries(tokenKeys.map(key => [key, 0])) as Record<typeof tokenKeys[number], number>
    const missingTokens = Object.fromEntries(tokenKeys.map(key => [key, 0])) as Record<typeof tokenKeys[number], number>
    const costs: Record<string, number> = {}
    let missingCostTurns = 0
    let missingCostRecords = 0
    const totalRecords = items.filter(turn => turn.recordKind !== 'detail-only')
    for (const turn of totalRecords) {
      for (const key of tokenKeys) {
        const value = turn.tokens[key] ?? null
        if (value === null) missingTokens[key]++
        else {
          knownTokens[key] += value
          assert(Number.isSafeInteger(knownTokens[key]), 'USAGE_TOTAL_OVERFLOW', 'Usage total exceeds safe integer bounds.')
        }
      }
      if (!turn.cost) {
        missingCostRecords++
        if (turn.recordKind !== 'opening-balance') missingCostTurns++
      }
      else {
        costs[turn.cost.currency] = (costs[turn.cost.currency] ?? 0) + turn.cost.amount
        assert(Number.isFinite(costs[turn.cost.currency]), 'USAGE_TOTAL_OVERFLOW', 'Usage cost total exceeds numeric bounds.')
      }
    }
    const modelRecords = items.filter(turn => turn.recordKind !== 'opening-balance')
    const incompleteTurns = new Set(modelRecords.filter(turn => turn.coverage !== 'complete')
      .map(turn => digest([turn.sessionId, turn.generation, turn.turnId])))
    const incompleteTotals = modelRecords.some(turn => turn.recordKind !== 'detail-only' && turn.coverage !== 'complete')
    const historical = items.some(turn => turn.recordKind === 'opening-balance' || turn.recordKind === 'detail-only' || turn.status === 'unknown')
    const tokens = Object.fromEntries(tokenKeys.map(key => [key,
      totalRecords.length > missingTokens[key] ? knownTokens[key] : null]))
    return { turns: new Set(modelRecords.map(turn => digest([turn.sessionId, turn.generation, turn.turnId]))).size,
      records: items.length, incompleteTurns: incompleteTurns.size, partial, tokens, knownTokens, missingTokens,
      knownCosts: costs, missingCostTurns, costComplete: !partial && missingCostRecords === 0 && !incompleteTotals
        && totalRecords.length > 0 && Object.keys(costs).length === 1,
      tokenUsageAvailable: totalRecords.some(turn => tokenKeys.some(key => turn.tokens[key] !== null)),
      source: historical ? 'durable-dsh-turn-events-and-imported-history' : 'durable-dsh-turn-events',
      observationScope: historical ? 'observed-events-and-preserved-history' : 'observed-terminal-turns-only',
      retention: 'explicit-store-capacity-no-automatic-reset' }
  }

  return Object.freeze({
    snapshot(query: NativeUsageQuery = {}) { return snapshot(scan(query)) },
    sessionLedgers() {
      const index = readNativeUsageSessionLedgers(store)
      return snapshot({ partial: index.partial, items: index.items.map(({ references: _references, ...entry }) => entry) })
    },
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
      const fingerprints = usageFingerprints(turn)
      const prior = store.read(namespace, key)
      if (prior) {
        assert(fingerprints.has(String(object(prior.value).fingerprint)), 'USAGE_TURN_CONFLICT', 'A recorded turn has different usage.')
        return readNativeUsageStoredTurn(prior)
      }
      const archived = store.read(NATIVE_USAGE_ARCHIVE_NAMESPACE, key)
      if (archived) {
        assert(fingerprints.has(String(object(archived.value).fingerprint)), 'USAGE_TURN_CONFLICT', 'An archived turn has different usage.')
        return readNativeUsageStoredTurn(archived)
      }
      const retired = store.read(NATIVE_USAGE_RETIRED_NAMESPACE, key)
      if (retired) {
        const receipt = object(retired.value)
        assert(receipt.schema === 1 && fingerprints.has(String(receipt.fingerprint)), 'USAGE_TURN_CONFLICT', 'A retired turn has different usage.')
        return Object.freeze({ retired: true as const, cursor: key, fingerprint })
      }
      const prices = turn.recordKind === 'opening-balance' || turn.recordKind === 'detail-only'
        ? { revision: null, prices: [] } : pricing()
      const recordedAt = clock()
      assert(token(recordedAt), 'USAGE_INVALID_CLOCK', 'Usage needs a nonnegative integer timestamp.')
      const manual = prices.prices.find(value => value.provider === turn.provider && value.model === turn.model)
      const rate = !manual && turn.recordKind !== 'opening-balance' && turn.recordKind !== 'detail-only'
        ? defaultUsagePriceAt(turn.model, recordedAt, builtin) : null
      const price = manual ? { ...manual, schema: 1 as const, source: 'operator' as const,
        version: `native:${prices.revision}`, tier: 'flat' as const, unit: 1_000_000 as const,
        at: recordedAt, cacheWritePricing: 'operator' as const,
        requestedModel: turn.model, referenceModel: turn.model, fallbackUsed: false }
        : rate ? { schema: 1 as const, provider: turn.provider, model: turn.model, currency: rate.currency,
          inputPerMillion: rate.cacheMiss, outputPerMillion: rate.output,
          cacheReadPerMillion: rate.cacheHit, cacheWritePerMillion: rate.cacheWrite,
          source: rate.source, version: rate.version, tier: rate.tier, unit: rate.unit, at: recordedAt,
          cacheWritePricing: rate.cacheWritePricing, requestedModel: rate.requestedModel,
          referenceModel: rate.referenceModel, fallbackUsed: rate.fallbackUsed } : null
      let priceSnapshot: NativeUsagePriceSnapshot | undefined = price ?? undefined
      let cost: JsonObject | null = turn.reportedCost === null ? null : { ...turn.reportedCost, source: 'reported' }
      const amount = cost === null && price ? estimatedCost(turn.tokens, price) : null
      if (cost === null && price && amount !== null) {
        cost = { amount, currency: price.currency, source: 'operator-price-estimate' }
        priceSnapshot = price
      }
      try {
        const value = json({ schema: 1, turn, fingerprint, cost, pricingRevision: prices.revision, recordedAt,
          ...(priceSnapshot ? { priceSnapshot } : {}) })
        const saved = store.compareAndSetBatch ? store.compareAndSetBatch([
          { kind: 'check', namespace: NATIVE_USAGE_ARCHIVE_NAMESPACE, key, expectedRevision: null },
          { kind: 'check', namespace: NATIVE_USAGE_RETIRED_NAMESPACE, key, expectedRevision: null },
          { kind: 'write', namespace, key, expectedRevision: null, value }
        ])[2] : store.write(namespace, key, value, { expectedRevision: null })
        assert(saved, 'USAGE_TURN_CONFLICT', 'Usage was retired while being recorded.')
        return readNativeUsageStoredTurn(saved)
      } catch (error) {
        if (!(error instanceof FrameworkError) || error.code !== 'STORE_CONFLICT') throw error
        const winner = store.read(namespace, key) ?? store.read(NATIVE_USAGE_ARCHIVE_NAMESPACE, key)
        const retired = store.read(NATIVE_USAGE_RETIRED_NAMESPACE, key)
        if (!winner && retired) {
          assert(fingerprints.has(String(object(retired.value).fingerprint)), 'USAGE_TURN_CONFLICT', 'A retired turn has different usage.')
          return Object.freeze({ retired: true as const, cursor: key, fingerprint })
        }
        assert(winner && fingerprints.has(String(object(winner.value).fingerprint)), 'USAGE_TURN_CONFLICT', 'A recorded turn has different usage.')
        return readNativeUsageStoredTurn(winner)
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
      return snapshot({ items: page.items.filter(turn => turn.recordKind !== 'opening-balance')
        .sort((left, right) => right.recordedAt - left.recordedAt
        || left.cursor.localeCompare(right.cursor)).slice(0, validated.limit), partial: page.truncated })
    },
    series(query: NativeUsageQuery = {}, bucketMs = 3_600_000) {
      assert(Number.isSafeInteger(bucketMs) && bucketMs >= 60_000 && bucketMs <= 86_400_000,
        'USAGE_INVALID_QUERY', 'Usage buckets must be between one minute and one day.')
      const page = scan(query)
      const buckets = new Map<number, ReturnType<typeof readNativeUsageStoredTurn>[]>()
      for (const turn of page.items) {
        if (turn.recordKind === 'opening-balance') continue
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
