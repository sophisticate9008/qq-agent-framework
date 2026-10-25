import { parseNativeUsageSnapshot } from './native-usage.ts';

export interface ConversationIdentity {
  readonly key: string;
  readonly kind: 'group' | 'private' | 'internal' | 'unattributed' | 'other';
  readonly identifier: string;
  readonly label: '群聊' | '私聊' | '内部' | '未归属' | '历史';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function describeConversationKey(key: string): ConversationIdentity {
  const match = /^(group|private):([1-9]\d{0,15})$/.exec(key);
  if (!match) {
    const internalPrefix = 'internal:';
    if (key.startsWith(internalPrefix) && key.length > internalPrefix.length) {
      return { key, kind: 'internal', identifier: key.slice(internalPrefix.length), label: '内部' };
    }
    const prefix = '未归属:';
    return key.startsWith(prefix) && key.length > prefix.length
      ? { key, kind: 'unattributed', identifier: key.slice(prefix.length), label: '未归属' }
      : { key, kind: 'other', identifier: key, label: '历史' };
  }
  const kind = match[1] as ConversationIdentity['kind'];
  return { key, kind, identifier: match[2]!, label: kind === 'group' ? '群聊' : '私聊' };
}

export interface ManagedSession {
  readonly key: string;
  readonly sessionId: string;
  readonly owner: boolean;
  readonly bindingRevision?: string;
}

export interface SessionSnapshot {
  readonly sessions: readonly ManagedSession[];
  readonly revision: string;
  readonly next?: string | null;
  readonly resetAvailable?: boolean;
  readonly source?: string;
  readonly historyReadOnly?: boolean;
}

export function parseSessionSnapshot(value: unknown): SessionSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.sessions) || value.sessions.length > 1000) return null;
  const revision = boundedText(value.revision, 256);
  if (!revision) return null;
  if (value.next !== undefined && value.next !== null && (typeof value.next !== 'string' || value.next.length === 0 || value.next.length > 160 || /[\x00-\x1f\x7f]/.test(value.next))) return null;
  if (value.resetAvailable !== undefined && typeof value.resetAvailable !== 'boolean') return null;
  if (value.source !== undefined && !boundedText(value.source, 128)) return null;
  if (value.historyReadOnly !== undefined && typeof value.historyReadOnly !== 'boolean') return null;
  if ((value.source === 'imported' || value.historyReadOnly === true) && value.resetAvailable === true) return null;
  const sessions: ManagedSession[] = [];
  const keys = new Set<string>();
  for (const item of value.sessions) {
    if (!isRecord(item)) return null;
    const key = boundedText(item.key, 128);
    const sessionId = boundedText(item.sessionId, 256);
    if (!key || !sessionId || typeof item.owner !== 'boolean' || keys.has(key)) return null;
    keys.add(key);
    sessions.push({ key, sessionId, owner: item.owner });
  }
  return { sessions, revision, ...(value.next === undefined ? {} : { next: value.next as string | null }),
    ...(value.resetAvailable === undefined ? {} : { resetAvailable: value.resetAvailable }),
    ...(value.source === undefined ? {} : { source: value.source as string }),
    ...(value.historyReadOnly === undefined ? {} : { historyReadOnly: value.historyReadOnly }) };
}

export interface SessionResetResult {
  readonly ok: true;
  readonly key: string;
  readonly previousSessionId: string;
  readonly bridgeBindingRemoved: true;
  readonly externalWorkStopped: 'unverified';
}

export function parseSessionResetResult(value: unknown, key: string, sessionId: string): SessionResetResult | null {
  if (!isRecord(value) || value.ok !== true || value.key !== key || value.previousSessionId !== sessionId
    || value.bridgeBindingRemoved !== true || value.externalWorkStopped !== 'unverified') return null;
  return {
    ok: true,
    key,
    previousSessionId: sessionId,
    bridgeBindingRemoved: true,
    externalWorkStopped: 'unverified',
  };
}

export interface UsageTotals {
  readonly totalTokens: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheHitTokens: number | null;
  readonly cacheMissTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cost: number | null;
  readonly estimated: boolean;
  readonly conversations: number;
  readonly turns: number;
  readonly steps: number;
  readonly unattributedCost: number | null;
  readonly attributedCost: number | null;
  readonly buckets: UsageBuckets | null;
  readonly byTier: UsageByTier | null;
  readonly cacheHitRate: number | null;
  readonly avgCostPerTurn: number | null;
  readonly avgCostPerStep: number | null;
}

export interface UsageBuckets {
  readonly cacheMiss: number | null;
  readonly cacheHit: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
}

export interface UsageByTier {
  readonly peak: number;
  readonly off: number;
}

export interface UsageNowTier {
  readonly model: string;
  readonly label: string;
  readonly tier: 'peak' | 'off' | 'flat';
  readonly tierLabel: string;
  readonly currency: string;
  readonly symbol: string;
  readonly unit: number;
  readonly estimated: boolean;
  readonly cacheHit: number;
  readonly cacheMiss: number;
  readonly cacheWrite: number;
  readonly output: number;
}

export interface UsagePriceModel {
  readonly label: string;
  readonly off: {
    readonly cacheHit: number;
    readonly cacheMiss: number;
    readonly cacheWrite: number;
    readonly output: number;
  };
}

export interface UsagePriceTable {
  readonly pricingMode?: 'flat' | 'time-of-use';
  readonly version: string;
  readonly currency: string;
  readonly symbol: string;
  readonly unit: number;
  readonly peakMultiplier: number;
  readonly peakWindows: readonly (readonly [number, number])[];
  readonly peakWeekdays: readonly number[];
  readonly holidayCount: number;
  readonly models: Readonly<Record<string, UsagePriceModel>>;
}

export interface UsageLedgerStats {
  readonly journalLines: number;
  readonly maxLines: number;
  readonly droppedLines: number;
  readonly sessions: number;
  readonly baselines: number;
  readonly samples: number;
  readonly lastIngestAt: number;
  readonly lastCompactedAt: number;
}

export interface ConversationUsage {
  readonly key: string;
  readonly sessionCount: number;
  readonly totalTokens: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheHitTokens: number | null;
  readonly cost: number | null;
  readonly estimated: boolean;
  readonly turns: number;
  readonly steps: number;
  readonly lastAt: string | null;
  readonly models: readonly string[];
  readonly buckets: UsageBuckets | null;
  readonly attributedCost: number | null;
  readonly unattributedCost: number | null;
  readonly byTier: UsageByTier | null;
  readonly cacheHitRate: number | null;
  readonly firstAt: string | null;
  readonly coverage?: UsageCoverage;
  readonly knownCosts?: Readonly<Record<string, number>>;
}

export interface UsageCoverage {
  readonly partial: boolean;
  readonly incompleteTurns: number;
  readonly records: number;
  readonly tokenUsageAvailable: boolean;
  readonly missingCostTurns: number;
  readonly knownTokens: Readonly<Record<string, number>>;
  readonly missingTokens: Readonly<Record<string, number>>;
  readonly knownCosts: Readonly<Record<string, number>>;
}

export interface UsageSnapshot {
  readonly native?: true;
  readonly coverage?: UsageCoverage;
  readonly resetAvailable?: false;
  readonly source: 'chat-ledger';
  readonly revision: string | null;
  readonly generatedAt: string;
  readonly currency: string;
  readonly symbol: string;
  readonly totals: UsageTotals;
  readonly conversations: readonly ConversationUsage[];
  readonly limit: number;
  readonly limited: boolean;
  readonly unavailable: readonly ('pricing' | 'ledger')[];
  readonly priceVersion: string | null;
  readonly nowTier: UsageNowTier | null;
  readonly priceTable: UsagePriceTable | null;
  readonly ledger: UsageLedgerStats | null;
}

function parseBuckets(value: unknown): UsageBuckets | null {
  if (!isRecord(value)) return null;
  const cacheMiss = nonNegativeInteger(value.cacheMiss);
  const cacheHit = nonNegativeInteger(value.cacheHit);
  const cacheWrite = nonNegativeInteger(value.cacheWrite);
  const output = nonNegativeInteger(value.output);
  const reasoning = nonNegativeInteger(value.reasoning);
  if ([cacheMiss, cacheHit, cacheWrite, output, reasoning].some(item => item === null)) return null;
  return { cacheMiss: cacheMiss!, cacheHit: cacheHit!, cacheWrite: cacheWrite!, output: output!, reasoning: reasoning! };
}

function parseByTier(value: unknown): UsageByTier | null {
  if (!isRecord(value)) return null;
  const peak = nonNegativeNumber(value.peak);
  const off = nonNegativeNumber(value.off);
  return peak === null || off === null ? null : { peak, off };
}

function optionalNonNegativeNumber(value: unknown): number | null {
  return value === undefined ? null : nonNegativeNumber(value);
}

function parseTotals(value: unknown): UsageTotals | null {
  if (!isRecord(value) || typeof value.estimated !== 'boolean') return null;
  const totalTokens = nonNegativeInteger(value.totalTokens);
  const inputTokens = nonNegativeInteger(value.inputTokens);
  const outputTokens = nonNegativeInteger(value.outputTokens);
  const cacheHitTokens = nonNegativeInteger(value.cacheHitTokens);
  const cacheMissTokens = nonNegativeInteger(value.cacheMissTokens);
  const cacheWriteTokens = nonNegativeInteger(value.cacheWriteTokens);
  const reasoningTokens = nonNegativeInteger(value.reasoningTokens);
  const cost = nonNegativeNumber(value.cost);
  const conversations = nonNegativeInteger(value.conversations);
  const turns = nonNegativeInteger(value.turns);
  const steps = nonNegativeInteger(value.steps);
  const unattributedCost = nonNegativeNumber(value.unattributedCost);
  const enhancedValues = [value.attributedCost, value.buckets, value.byTier, value.cacheHitRate,
    value.avgCostPerTurn, value.avgCostPerStep];
  const hasEnhancedValues = enhancedValues.some(item => item !== undefined);
  if (hasEnhancedValues && enhancedValues.some(item => item === undefined)) return null;
  const attributedCost = optionalNonNegativeNumber(value.attributedCost);
  const buckets = value.buckets === undefined ? null : parseBuckets(value.buckets);
  const byTier = value.byTier === undefined ? null : parseByTier(value.byTier);
  const cacheHitRate = optionalNonNegativeNumber(value.cacheHitRate);
  const avgCostPerTurn = optionalNonNegativeNumber(value.avgCostPerTurn);
  const avgCostPerStep = optionalNonNegativeNumber(value.avgCostPerStep);
  if ([totalTokens, inputTokens, outputTokens, cacheHitTokens, cacheMissTokens, cacheWriteTokens, reasoningTokens,
    cost, conversations, turns, steps, unattributedCost].some(item => item === null)
    || hasEnhancedValues && (attributedCost === null || buckets === null || byTier === null || cacheHitRate === null
      || avgCostPerTurn === null || avgCostPerStep === null || cacheHitRate > 1)) return null;
  return {
    totalTokens: totalTokens!, inputTokens: inputTokens!, outputTokens: outputTokens!,
    cacheHitTokens: cacheHitTokens!, cacheMissTokens: cacheMissTokens!, cacheWriteTokens: cacheWriteTokens!,
    reasoningTokens: reasoningTokens!, cost: cost!, estimated: value.estimated,
    conversations: conversations!, turns: turns!, steps: steps!, unattributedCost: unattributedCost!,
    attributedCost, buckets, byTier, cacheHitRate, avgCostPerTurn, avgCostPerStep,
  };
}

function parseConversationUsage(value: unknown): ConversationUsage | null {
  if (!isRecord(value) || typeof value.estimated !== 'boolean' || !Array.isArray(value.models) || value.models.length > 256) return null;
  const key = boundedText(value.key, 128);
  const sessionCount = nonNegativeInteger(value.sessionCount);
  const totalTokens = nonNegativeInteger(value.totalTokens);
  const inputTokens = nonNegativeInteger(value.inputTokens);
  const outputTokens = nonNegativeInteger(value.outputTokens);
  const cacheHitTokens = nonNegativeInteger(value.cacheHitTokens);
  const cost = nonNegativeNumber(value.cost);
  const turns = nonNegativeInteger(value.turns);
  const steps = nonNegativeInteger(value.steps);
  const lastAt = value.lastAt === 0 ? null : timestamp(value.lastAt);
  const models = value.models.map(model => boundedText(model, 256));
  const enhancedValues = [value.buckets, value.attributedCost, value.unattributedCost, value.byTier,
    value.cacheHitRate, value.firstAt];
  const hasEnhancedValues = enhancedValues.some(item => item !== undefined);
  if (hasEnhancedValues && enhancedValues.some(item => item === undefined)) return null;
  const buckets = value.buckets === undefined ? null : parseBuckets(value.buckets);
  const attributedCost = optionalNonNegativeNumber(value.attributedCost);
  const unattributedCost = optionalNonNegativeNumber(value.unattributedCost);
  const byTier = value.byTier === undefined ? null : parseByTier(value.byTier);
  const cacheHitRate = optionalNonNegativeNumber(value.cacheHitRate);
  const firstAt = value.firstAt === undefined || value.firstAt === 0 ? null : timestamp(value.firstAt);
  if (!key || sessionCount === null || totalTokens === null || inputTokens === null
    || outputTokens === null || cacheHitTokens === null || cost === null || turns === null || steps === null
    || lastAt === null && value.lastAt !== 0 || models.some(model => model === null) || new Set(models).size !== models.length
    || hasEnhancedValues && (buckets === null || attributedCost === null || unattributedCost === null || byTier === null
      || cacheHitRate === null || cacheHitRate > 1 || firstAt === null && value.firstAt !== 0)) return null;
  return {
    key, sessionCount, totalTokens, inputTokens, outputTokens, cacheHitTokens, cost,
    estimated: value.estimated, turns, steps, lastAt, models: models as string[], buckets,
    attributedCost, unattributedCost, byTier, cacheHitRate, firstAt,
  };
}

function parseNowTier(value: unknown): UsageNowTier | null {
  if (!isRecord(value) || typeof value.estimated !== 'boolean' || value.tier !== 'peak' && value.tier !== 'off') return null;
  const model = boundedText(value.model, 256);
  const label = boundedText(value.label, 256);
  const tierLabel = boundedText(value.tierLabel, 64);
  const currency = boundedText(value.currency, 16);
  const symbol = boundedText(value.symbol, 16);
  const unit = nonNegativeNumber(value.unit);
  const cacheHit = nonNegativeNumber(value.cacheHit);
  const cacheMiss = nonNegativeNumber(value.cacheMiss);
  const cacheWrite = nonNegativeNumber(value.cacheWrite);
  const output = nonNegativeNumber(value.output);
  if (!model || !label || !tierLabel || !currency || !symbol || unit === null || unit < 1
    || cacheHit === null || cacheMiss === null || cacheWrite === null || output === null) return null;
  return { model, label, tier: value.tier, tierLabel, currency: currency.toUpperCase(), symbol, unit,
    estimated: value.estimated, cacheHit, cacheMiss, cacheWrite, output };
}

function parsePriceTable(value: unknown): UsagePriceTable | null {
  if (!isRecord(value) || !Array.isArray(value.peakWindows) || !Array.isArray(value.peakWeekdays)
    || !isRecord(value.models) || Object.keys(value.models).length > 256) return null;
  const version = boundedText(value.version, 256);
  const currency = boundedText(value.currency, 16);
  const symbol = boundedText(value.symbol, 16);
  const unit = nonNegativeNumber(value.unit);
  const peakMultiplier = nonNegativeNumber(value.peakMultiplier);
  const holidayCount = nonNegativeInteger(value.holidayCount);
  if (!version || !currency || !symbol || unit === null || unit < 1 || peakMultiplier === null || peakMultiplier <= 0
    || holidayCount === null || value.peakWindows.length > 24 || value.peakWeekdays.length > 7) return null;
  const peakWindows: Array<readonly [number, number]> = [];
  for (const window of value.peakWindows) {
    if (!Array.isArray(window) || window.length !== 2) return null;
    const start = nonNegativeNumber(window[0]);
    const end = nonNegativeNumber(window[1]);
    if (start === null || end === null || start >= end || end > 24) return null;
    peakWindows.push([start, end]);
  }
  const peakWeekdays = value.peakWeekdays.map(nonNegativeInteger);
  if (peakWeekdays.some(day => day === null || day < 1 || day > 7)
    || new Set(peakWeekdays).size !== peakWeekdays.length) return null;
  const models: Record<string, UsagePriceModel> = {};
  for (const [name, modelValue] of Object.entries(value.models)) {
    const safeName = boundedText(name, 256);
    if (!safeName || !isRecord(modelValue) || !isRecord(modelValue.off)) return null;
    const label = boundedText(modelValue.label, 256);
    const cacheHit = nonNegativeNumber(modelValue.off.cacheHit);
    const cacheMiss = nonNegativeNumber(modelValue.off.cacheMiss);
    const cacheWrite = nonNegativeNumber(modelValue.off.cacheWrite);
    const output = nonNegativeNumber(modelValue.off.output);
    if (!label || cacheHit === null || cacheMiss === null || cacheWrite === null || output === null) return null;
    models[safeName] = { label, off: { cacheHit, cacheMiss, cacheWrite, output } };
  }
  return { version, currency: currency.toUpperCase(), symbol, unit, peakMultiplier,
    peakWindows, peakWeekdays: peakWeekdays as number[], holidayCount, models };
}

function parseLedger(value: unknown): UsageLedgerStats | null {
  if (!isRecord(value)) return null;
  const journalLines = nonNegativeInteger(value.journalLines);
  const maxLines = nonNegativeInteger(value.maxLines);
  const droppedLines = nonNegativeInteger(value.droppedLines);
  const sessions = nonNegativeInteger(value.sessions);
  const baselines = nonNegativeInteger(value.baselines);
  const samples = nonNegativeInteger(value.samples);
  const lastIngestAt = nonNegativeInteger(value.lastIngestAt);
  const lastCompactedAt = nonNegativeInteger(value.lastCompactedAt);
  if ([journalLines, maxLines, droppedLines, sessions, baselines, samples, lastIngestAt, lastCompactedAt]
    .some(item => item === null) || maxLines === 0 || timestamp(lastIngestAt) === null || timestamp(lastCompactedAt) === null) return null;
  return { journalLines: journalLines!, maxLines: maxLines!, droppedLines: droppedLines!, sessions: sessions!,
    baselines: baselines!, samples: samples!, lastIngestAt: lastIngestAt!, lastCompactedAt: lastCompactedAt! };
}

export function parseUsageSnapshot(value: unknown): UsageSnapshot | null {
  if (isRecord(value) && value.native === true) return parseNativeUsageSnapshot(value);
  if (!isRecord(value) || value.source !== 'chat-ledger' || !Array.isArray(value.conversations)
    || value.conversations.length > 1000 || typeof value.limited !== 'boolean') return null;
  const generatedAt = timestamp(value.generatedAt);
  const currency = boundedText(value.currency, 16);
  const symbol = boundedText(value.symbol, 16);
  const totals = parseTotals(value.totals);
  const limit = nonNegativeInteger(value.limit);
  const revision = value.revision === undefined ? null : boundedText(value.revision, 256);
  if (!generatedAt || !currency || !symbol || !totals
    || value.revision !== undefined && !revision || limit === null || limit < 1 || limit > 500
    || value.conversations.length > limit) return null;
  const conversations: ConversationUsage[] = [];
  const keys = new Set<string>();
  for (const item of value.conversations) {
    const conversation = parseConversationUsage(item);
    if (!conversation || keys.has(conversation.key)) return null;
    keys.add(conversation.key);
    conversations.push(conversation);
  }
  const pricingValues = [value.priceVersion, value.nowTier, value.priceTable];
  const pricingPresent = pricingValues.some(item => item !== undefined);
  if (pricingPresent && pricingValues.some(item => item === undefined)) return null;
  const priceVersion = value.priceVersion === undefined ? null : boundedText(value.priceVersion, 256);
  const nowTier = value.nowTier === undefined ? null : parseNowTier(value.nowTier);
  const priceTable = value.priceTable === undefined ? null : parsePriceTable(value.priceTable);
  const ledger = value.ledger === undefined ? null : parseLedger(value.ledger);
  if (pricingPresent && (!priceVersion || !nowTier || !priceTable) || value.ledger !== undefined && !ledger) return null;
  let unavailable: Array<'pricing' | 'ledger'>;
  if (value.unavailable === undefined) {
    unavailable = [...(!pricingPresent ? ['pricing' as const] : []), ...(!ledger ? ['ledger' as const] : [])];
  } else {
    const unavailableValues = value.unavailable;
    if (!Array.isArray(unavailableValues) || unavailableValues.length > 2
      || unavailableValues.some(item => item !== 'pricing' && item !== 'ledger')
      || new Set(unavailableValues).size !== unavailableValues.length) return null;
    unavailable = ['pricing', 'ledger'].filter(item => unavailableValues.includes(item)) as Array<'pricing' | 'ledger'>;
    if (unavailable.includes('pricing') === pricingPresent || unavailable.includes('ledger') === Boolean(ledger)) return null;
  }
  return {
    source: 'chat-ledger', revision, generatedAt, currency: currency.toUpperCase(), symbol, totals,
    conversations, limit, limited: value.limited, unavailable, priceVersion, nowTier, priceTable, ledger,
  };
}

const countFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const usageCountFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, useGrouping: false });
const decimalFormatter = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export function formatActivityCount(value: number): string {
  return countFormatter.format(value);
}

export function formatUsageCount(value: number | null, detailed = false): string {
  if (value === null) return '未知';
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Usage count must be finite and nonnegative.');
  if (detailed || value < 1_000) return formatActivityCount(value);
  const units = [
    { divisor: 1_000, suffix: 'k' },
    { divisor: 1_000_000, suffix: 'm' },
    { divisor: 1_000_000_000, suffix: 'b' },
  ];
  for (const [index, unit] of units.entries()) {
    const formatted = usageCountFormatter.format(value / unit.divisor);
    if (Number(formatted) < 1_000 || index === units.length - 1) return `${formatted}${unit.suffix}`;
  }
  return formatActivityCount(value);
}

export function formatActivityCost(value: number | null, _currency: string, symbol: string): string {
  if (value === null) return '未知';
  return `${symbol}${decimalFormatter.format(value)}`;
}

export function sumUsageCounts(...values: readonly (number | null)[]): number | null {
  return values.reduce<number | null>((total, value) => total === null || value === null ? null : total + value, 0);
}
