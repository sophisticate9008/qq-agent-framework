import type { ConversationUsage, UsageBuckets, UsageCoverage, UsageNowTier, UsagePriceTable, UsageSnapshot, UsageTotals } from './activity.ts';
import type { AggregateUsageTier, UsageConversationDetails, UsageRecent, UsageRecentEntry, UsageSeries, UsageSeriesBucket, UsageTier, UsageTurn } from './usage-details.ts';
import { parseBuiltinPricing } from './usage-pricing.ts';

function invalid(): never { throw new Error('invalid_native_usage'); }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function text(value: unknown, maximum = 256): string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value) ? value : invalid();
}
function quantity(value: unknown): number | null {
  return value === null ? null : typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid();
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}
function counter(value: unknown): number | null { return value === null ? null : count(value); }
function usageTier(value: unknown): UsageTier {
  return value === 'flat' || value === 'peak' || value === 'off' ? value : invalid();
}
function aggregateTier(value: unknown): AggregateUsageTier { return value === 'mixed' ? value : usageTier(value); }
function costRecovery(value: unknown): UsageTurn['costRecovery'] {
  return value === null || value === undefined ? null
    : value === 'price-snapshot' || value === 'historical-reference' ? value : invalid();
}
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function time(value: unknown): number {
  const parsed = count(value);
  return Number.isFinite(new Date(parsed).getTime()) ? parsed : invalid();
}
function array(value: unknown, maximum: number): readonly unknown[] { return Array.isArray(value) && value.length <= maximum ? value : invalid(); }
function strings(value: unknown, maximum: number, length = 256): string[] {
  const parsed = array(value, maximum).map(item => text(item, length));
  return new Set(parsed).size === parsed.length ? parsed : invalid();
}
function numericMap(value: unknown): Readonly<Record<string, number>> {
  const entries = Object.entries(record(value));
  if (entries.length > 256) invalid();
  return Object.fromEntries(entries.map(([key, item]) => {
    const parsed = quantity(item);
    if (parsed === null) invalid();
    return [text(key, 160), parsed];
  }));
}
function coverage(value: Record<string, unknown>): UsageCoverage {
  return { partial: bool(value.partial), incompleteTurns: count(value.incompleteTurns), records: count(value.records),
    tokenUsageAvailable: bool(value.tokenUsageAvailable), missingCostTurns: count(value.missingCostTurns),
    knownTokens: numericMap(value.knownTokens), missingTokens: numericMap(value.missingTokens), knownCosts: numericMap(value.knownCosts) };
}
function coverageState(value: unknown): 'complete' | 'partial' | 'unknown' {
  return value === 'complete' || value === 'partial' || value === 'unknown' ? value : invalid();
}
function buckets(value: unknown, observed = true): UsageBuckets {
  const source = record(value);
  const parsed = { cacheMiss: counter(source.cacheMiss), cacheHit: counter(source.cacheHit), cacheWrite: counter(source.cacheWrite), output: counter(source.output), reasoning: counter(source.reasoning) };
  return observed ? parsed : { cacheMiss: null, cacheHit: null, cacheWrite: null, output: null, reasoning: null };
}
function totals(value: unknown, observed = true): UsageTotals {
  const source = record(value);
  const input = (key: string) => { const parsed = counter(source[key]); return observed ? parsed : null; };
  const money = (key: string) => { const parsed = quantity(source[key]); return observed ? parsed : null; };
  const hitRate = quantity(source.cacheHitRate);
  if (hitRate !== null && hitRate > 1 || source.byTier !== null) invalid();
  return { totalTokens: input('totalTokens'), inputTokens: input('inputTokens'), outputTokens: input('outputTokens'),
    cacheHitTokens: input('cacheHitTokens'), cacheMissTokens: input('cacheMissTokens'), cacheWriteTokens: input('cacheWriteTokens'), reasoningTokens: input('reasoningTokens'),
    cost: money('cost'), estimated: bool(source.estimated), conversations: count(source.conversations), turns: count(source.turns), steps: count(source.steps),
    attributedCost: money('attributedCost'), unattributedCost: money('unattributedCost'), buckets: buckets(source.buckets, observed), byTier: null,
    cacheHitRate: observed ? hitRate : null, avgCostPerTurn: money('avgCostPerTurn'), avgCostPerStep: money('avgCostPerStep') };
}
function pricing(value: unknown): UsagePriceTable | null {
  if (value === null) return null;
  const source = record(value);
  if (source.pricingMode === 'time-of-use') return parseBuiltinPricing(source) ?? invalid();
  if (source.pricingMode !== 'flat' || source.unit !== 1_000_000 || source.peakMultiplier !== 1
    || array(source.peakWindows, 0).length !== 0 || array(source.peakWeekdays, 0).length !== 0 || source.holidayCount !== 0) invalid();
  const entries = Object.entries(record(source.models));
  if (entries.length > 256) invalid();
  return { pricingMode: 'flat', version: text(source.version), currency: text(source.currency, 16), symbol: text(source.symbol, 16), unit: count(source.unit),
    peakMultiplier: 1, peakWindows: [], peakWeekdays: [], holidayCount: 0,
    models: Object.fromEntries(entries.map(([name, item]) => {
      const model = record(item);
      const off = record(model.off);
      const price = (key: string) => { const parsed = quantity(off[key]); return parsed === null ? invalid() : parsed; };
      return [text(name, 512), { label: text(model.label, 512), off: { cacheHit: price('cacheHit'), cacheMiss: price('cacheMiss'), cacheWrite: price('cacheWrite'), output: price('output') } }];
    })) };
}
function nowTier(value: unknown): UsageNowTier | null {
  if (value === null) return null;
  const source = record(value);
  const tier = usageTier(source.tier);
  if (source.unit !== 1_000_000) invalid();
  if (tier !== 'flat' && (source.referenceOnly !== true || source.source !== 'migrated-reference'
    || source.cacheWritePricing !== 'same-as-cache-miss-assumption' || source.estimated !== true)) invalid();
  if (tier !== 'flat') { text(source.version); bool(source.calendarKnown); }
  const price = (key: string) => { const parsed = quantity(source[key]); return parsed === null ? invalid() : parsed; };
  return { tier, model: text(source.model, 160), label: text(source.label, 160), tierLabel: text(source.tierLabel), currency: text(source.currency, 16), symbol: text(source.symbol, 16), unit: count(source.unit), estimated: bool(source.estimated), cacheHit: price('cacheHit'), cacheMiss: price('cacheMiss'), cacheWrite: price('cacheWrite'), output: price('output') };
}
function parse<Result>(value: unknown, read: (source: Record<string, unknown>) => Result): Result | null {
  try { const source = record(value); return source.native === true ? read(source) : null; } catch { return null; }
}

export function parseNativeUsageSnapshot(value: unknown): UsageSnapshot | null {
  return parse(value, source => {
    if (source.source !== 'chat-ledger') invalid();
    const resetAvailable = bool(source.resetAvailable);
    const metadata = coverage(source);
    const limit = count(source.limit);
    if (limit < 1 || limit > 500) invalid();
    const conversations: ConversationUsage[] = array(source.conversations, limit).map(item => {
      const conversation = record(item);
      const aggregate = totals(conversation, count(conversation.steps) > 0);
      const key = text(conversation.key, 160);
      const sessionId = conversation.sessionId === undefined || conversation.sessionId === null ? null : text(conversation.sessionId);
      const ledgerKey = conversation.ledgerKey === undefined ? key : text(conversation.ledgerKey);
      const revision = conversation.revision === undefined || conversation.revision === null ? null : text(conversation.revision);
      if (conversation.ledgerKey !== undefined && !sessionId || revision !== null && !/^[a-f0-9]{64}$/.test(revision)) invalid();
      return { ...aggregate, key, ledgerKey, sessionId, revision, sessionCount: count(conversation.sessionCount), models: strings(conversation.models, 256, 160),
        knownCosts: numericMap(conversation.knownCosts),
        firstAt: conversation.firstAt === 0 ? null : new Date(time(conversation.firstAt)).toISOString(), lastAt: conversation.lastAt === 0 ? null : new Date(time(conversation.lastAt)).toISOString() };
    });
    if (new Set(conversations.map(item => item.ledgerKey)).size !== conversations.length) invalid();
    if (new Set(conversations.map(item => JSON.stringify([item.key, item.sessionId]))).size !== conversations.length) invalid();
    const table = pricing(source.priceTable);
    const tier = nowTier(source.nowTier);
    if (tier !== null && (table === null || (table.pricingMode === 'flat') !== (tier.tier === 'flat'))) invalid();
    if (source.pricingMode !== undefined && source.pricingMode !== table?.pricingMode) invalid();
    const unavailable = source.unavailable === undefined ? (table ? ['ledger'] as const : ['pricing', 'ledger'] as const)
      : strings(source.unavailable, 2).map(item => item === 'pricing' || item === 'ledger' ? item : invalid());
    const estimate = source.pricingEstimateAvailable === undefined ? tier !== null : bool(source.pricingEstimateAvailable);
    if (estimate !== (tier !== null)) invalid();
    const missingReasons = source.pricingEstimateMissingReasons === undefined ? (estimate ? [] : ['model_pricing_unavailable'])
      : strings(source.pricingEstimateMissingReasons, 1).map(item => item === 'model_pricing_unavailable' ? item : invalid());
    if (estimate && missingReasons.length > 0 || !estimate && missingReasons.length !== 1) invalid();
    let priceSelection: { model: string; provider: string | null; source: 'query' | 'observed-history' | 'operator-example' | 'builtin-reference' } | undefined;
    if (source.priceSelection !== undefined) {
      const selection = record(source.priceSelection);
      if (selection.source !== 'query' && selection.source !== 'observed-history' && selection.source !== 'operator-example' && selection.source !== 'builtin-reference') invalid();
      priceSelection = { model: text(selection.model, 160), provider: selection.provider === null ? null : text(selection.provider, 160), source: selection.source };
    }
    return { native: true, coverage: metadata, resetAvailable, source: 'chat-ledger', revision: text(source.revision), generatedAt: new Date(time(source.generatedAt)).toISOString(),
      currency: text(source.currency, 16), symbol: text(source.symbol, 16), totals: totals(source.totals, metadata.records > 0), conversations, limit, limited: bool(source.limited),
      unavailable, priceVersion: source.priceVersion === null ? null : text(source.priceVersion), priceTable: table, nowTier: tier, ledger: null,
      pricingEstimateAvailable: estimate, pricingEstimateMissingReasons: missingReasons, ...(priceSelection === undefined ? {} : { priceSelection }) };
  });
}

export function parseNativeUsageSeries(value: unknown): UsageSeries | null {
  return parse(value, source => {
    if (source.ok !== true) invalid();
    const from = time(source.from), to = time(source.to), bucketMs = count(source.bucketMs), hours = count(source.hours);
    if (hours < 1 || hours > 2160 || bucketMs < 1 || from >= to) invalid();
    const rows = array(source.buckets, 120);
    if (rows.length === 0 || to - from !== rows.length * bucketMs || to - from < hours * 3_600_000 || to - from >= hours * 3_600_000 + bucketMs) invalid();
    const parsedBuckets: UsageSeriesBucket[] = rows.map((item, index) => {
      const row = record(item);
      const tier = aggregateTier(row.tier);
      if (time(row.t) !== from + index * bucketMs) invalid();
      const steps = count(row.steps);
      const nullable = (key: string) => { const parsed = counter(row[key]); return steps > 0 ? parsed : null; };
      const cost = quantity(row.cost);
      return { t: time(row.t), cost: steps > 0 ? cost : null, tokens: nullable('tokens'), cacheMiss: nullable('cacheMiss'), cacheHit: nullable('cacheHit'), cacheWrite: nullable('cacheWrite'), output: nullable('output'),
        turns: count(row.turns), steps, tier, keys: strings(row.keys, 500, 160), coverage: coverageState(row.coverage) };
    });
    const aggregate = record(source.totals);
    const steps = count(aggregate.steps);
    const cost = quantity(aggregate.cost), tokens = counter(aggregate.tokens);
    let busiest: UsageSeries['busiest'] = null;
    if (source.busiest !== null) {
      const row = record(source.busiest);
      const found = parsedBuckets.find(item => item.t === time(row.t));
      if (!found) invalid();
      if (found.steps > 0) busiest = { t: found.t, cost: found.cost, tokens: found.tokens };
    }
    return { native: true, partial: bool(source.partial), knownCosts: numericMap(source.knownCosts), ok: true, generatedAt: time(source.generatedAt), currency: text(source.currency, 16), symbol: text(source.symbol, 16), hours, bucketMs, from, to, buckets: parsedBuckets,
      totals: { cost: steps > 0 ? cost : null, tokens: steps > 0 ? tokens : null, turns: count(aggregate.turns), steps }, busiest, estimated: bool(source.estimated), countedSamples: count(source.countedSamples), offChartCost: quantity(source.offChartCost), offChartTokens: counter(source.offChartTokens) };
  });
}

export function parseNativeUsageConversation(value: unknown, expectedKey?: string, expectedSessionId?: string): UsageConversationDetails | null {
  return parse(value, source => {
    const key = text(source.key, 160);
    if (expectedKey !== undefined && key !== expectedKey || source.byTier !== null) invalid();
    const sessionIds = strings(source.sessionIds, 2000);
    if (expectedSessionId !== undefined && sessionIds.some(sessionId => sessionId !== expectedSessionId)) invalid();
    if (count(source.sessionCount) !== sessionIds.length) invalid();
    const turnLimit = count(source.turnLimit);
    if (turnLimit < 1 || turnLimit > 1000) invalid();
    const turns: UsageTurn[] = array(source.turns, turnLimit).map(item => {
      const row = record(item);
      const tier = aggregateTier(row.tier);
      const startedAt = time(row.startedAt), endedAt = time(row.endedAt);
      if (startedAt > endedAt) invalid();
      return { sessionId: text(row.sessionId), key: text(row.key, 160), generation: count(row.generation), turn: counter(row.turn), turnId: text(row.turnId, 160), steps: count(row.steps), attempts: count(row.attempts),
        startedAt, endedAt, model: row.model === null ? null : text(row.model, 160), provider: row.provider === null ? null : text(row.provider, 160), buckets: buckets(row.buckets), cost: quantity(row.cost), costRecovery: costRecovery(row.costRecovery), tier, coverage: coverageState(row.coverage), knownCosts: numericMap(row.knownCosts) };
    });
    const observed = turns.length > 0;
    if (expectedSessionId !== undefined && turns.some(turn => turn.sessionId !== expectedSessionId)) invalid();
    return { native: true, partial: bool(source.partial), knownCosts: numericMap(source.knownCosts), key, generatedAt: time(source.generatedAt), currency: text(source.currency, 16), symbol: text(source.symbol, 16), sessionIds, sessionCount: sessionIds.length,
      buckets: buckets(source.buckets, observed), cost: observed ? quantity(source.cost) : null, attributedCost: observed ? quantity(source.attributedCost) : null, unattributedCost: quantity(source.unattributedCost), byTier: null, estimated: bool(source.estimated),
      firstAt: time(source.firstAt), lastAt: time(source.lastAt), models: strings(source.models, 256, 160), turnLimit, limited: bool(source.limited), turns };
  });
}

export function parseNativeUsageRecent(value: unknown): UsageRecent | null {
  return parse(value, source => {
    const rawItems = array(source.items, 500);
    const entries: UsageRecentEntry[] = array(source.entries, 500).map((item, index) => {
      const row = record(item);
      const tier = usageTier(row.tier);
      let knownCost: UsageRecentEntry['knownCost'] = null;
      if (row.knownCost !== null) {
        const cost = record(row.knownCost);
        const amount = quantity(cost.amount);
        if (amount === null) invalid();
        knownCost = { amount, currency: text(cost.currency, 3), source: text(cost.source) };
      }
      return { id: text(record(rawItems[index]).cursor, 160), time: time(row.time), key: text(row.key, 160), sid: text(row.sid), turn: counter(row.turn), turnId: text(row.turnId, 160), step: counter(row.step), retry: counter(row.retry), model: text(row.model, 160),
        tokens: counter(row.tokens), cacheMiss: counter(row.cacheMiss), cacheHit: counter(row.cacheHit), cacheWrite: counter(row.cacheWrite), output: counter(row.output), reasoning: counter(row.reasoning), cost: quantity(row.cost), knownCost, costRecovery: costRecovery(row.costRecovery),
        tier, estimated: bool(row.estimated), coverage: coverageState(row.coverage), pricingRevision: counter(row.pricingRevision) };
    });
    return { native: true, partial: bool(source.partial), symbol: text(source.symbol, 16), entries };
  });
}
