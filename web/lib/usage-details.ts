import type { UsageBuckets, UsageByTier } from './activity.ts';
import { parseNativeUsageConversation, parseNativeUsageRecent, parseNativeUsageSeries } from './native-usage.ts';

export const usageSectionLabels = Object.freeze({
  summary: '账本汇总',
  breakdown: 'Token 构成',
  chart: '消耗走势',
  conversations: '按会话汇总',
  turns: '逐轮花费',
  recent: '最近调用流水',
  prices: '当前生效价目表',
  pricingEditor: '配置后续用量单价',
  management: '账本管理',
});

export type UsageTier = 'peak' | 'off' | 'flat';
export type AggregateUsageTier = UsageTier | 'mixed';
export type UsageChartMetric = 'cost' | 'tokens';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = nonNegativeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function timeValue(value: unknown): number | null {
  const parsed = nonNegativeInteger(value);
  if (parsed === null || !Number.isFinite(new Date(parsed).getTime())) return null;
  return parsed;
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

function parseAggregateTier(value: unknown): AggregateUsageTier | null {
  return value === 'peak' || value === 'off' || value === 'mixed' ? value : null;
}

function parseUsageTier(value: unknown): UsageTier | null {
  return value === 'peak' || value === 'off' ? value : null;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(left) * 1e-9, Math.abs(right) * 1e-9);
}

export interface UsageSeriesBucket {
  readonly t: number;
  readonly cost: number | null;
  readonly tokens: number | null;
  readonly cacheMiss: number | null;
  readonly cacheHit: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
  readonly turns: number;
  readonly steps: number;
  readonly tier: AggregateUsageTier;
  readonly keys: readonly string[];
  readonly coverage?: 'complete' | 'partial' | 'unknown';
}

export interface UsageSeries {
  readonly native?: true;
  readonly partial?: boolean;
  readonly knownCosts?: Readonly<Record<string, number>>;
  readonly ok: true;
  readonly generatedAt: number;
  readonly currency: string;
  readonly symbol: string;
  readonly hours: number;
  readonly bucketMs: number;
  readonly from: number;
  readonly to: number;
  readonly buckets: readonly UsageSeriesBucket[];
  readonly totals: { readonly cost: number | null; readonly tokens: number | null; readonly turns: number; readonly steps: number };
  readonly busiest: { readonly t: number; readonly cost: number | null; readonly tokens: number | null } | null;
  readonly estimated: boolean;
  readonly countedSamples: number;
  readonly offChartCost: number | null;
  readonly offChartTokens: number | null;
}

function parseSeriesBucket(value: unknown): UsageSeriesBucket | null {
  if (!isRecord(value) || !Array.isArray(value.keys) || value.keys.length > 500) return null;
  const t = timeValue(value.t);
  const cost = nonNegativeNumber(value.cost);
  const tokens = nonNegativeInteger(value.tokens);
  const cacheMiss = nonNegativeInteger(value.cacheMiss);
  const cacheHit = nonNegativeInteger(value.cacheHit);
  const cacheWrite = nonNegativeInteger(value.cacheWrite);
  const output = nonNegativeInteger(value.output);
  const turns = nonNegativeInteger(value.turns);
  const steps = nonNegativeInteger(value.steps);
  const tier = parseAggregateTier(value.tier);
  const keys = value.keys.map(key => boundedText(key, 128));
  if (t === null || cost === null || tokens === null || cacheMiss === null || cacheHit === null
    || cacheWrite === null || output === null || turns === null || steps === null || !tier
    || keys.some(key => key === null) || new Set(keys).size !== keys.length) return null;
  const computedTokens = cacheMiss + cacheHit + cacheWrite + output;
  if (!Number.isSafeInteger(computedTokens) || computedTokens !== tokens) return null;
  return { t, cost, tokens, cacheMiss, cacheHit, cacheWrite, output, turns, steps, tier, keys: keys as string[] };
}

export function formatUsageWindowEndpoint(value: number): string {
  const totalSeconds = Math.round(value * 3_600);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  const base = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return seconds === 0 ? base : `${base}:${String(seconds).padStart(2, '0')}`;
}

export function parseUsageSeries(value: unknown): UsageSeries | null {
  if (isRecord(value) && value.native === true) return parseNativeUsageSeries(value);
  if (!isRecord(value) || value.ok !== true || typeof value.estimated !== 'boolean'
    || !Array.isArray(value.buckets) || value.buckets.length < 1 || value.buckets.length > 120 || !isRecord(value.totals)) return null;
  const generatedAt = timeValue(value.generatedAt);
  const currency = boundedText(value.currency, 16);
  const symbol = boundedText(value.symbol, 16);
  const hours = positiveInteger(value.hours);
  const bucketMs = positiveInteger(value.bucketMs);
  const from = timeValue(value.from);
  const to = timeValue(value.to);
  const countedSamples = nonNegativeInteger(value.countedSamples);
  const offChartCost = nonNegativeNumber(value.offChartCost);
  const offChartTokens = nonNegativeInteger(value.offChartTokens);
  const totalCost = nonNegativeNumber(value.totals.cost);
  const totalTokens = nonNegativeInteger(value.totals.tokens);
  const totalTurns = nonNegativeInteger(value.totals.turns);
  const totalSteps = nonNegativeInteger(value.totals.steps);
  if (generatedAt === null || !currency || !symbol || hours === null || hours > 2160 || bucketMs === null
    || from === null || to === null || from >= to || countedSamples === null || offChartCost === null
    || offChartTokens === null || totalCost === null || totalTokens === null || totalTurns === null || totalSteps === null) return null;
  const expectedBuckets = (to - from) / bucketMs;
  if (!Number.isSafeInteger(expectedBuckets) || expectedBuckets !== value.buckets.length
    || to - from < hours * 3_600_000 || to - from >= hours * 3_600_000 + bucketMs) return null;
  const buckets: UsageSeriesBucket[] = [];
  for (let index = 0; index < value.buckets.length; index += 1) {
    const bucket = parseSeriesBucket(value.buckets[index]);
    if (!bucket || bucket.t !== from + index * bucketMs) return null;
    buckets.push(bucket);
  }
  const summedCost = buckets.reduce((total, bucket) => total + (bucket.cost ?? Number.NaN), 0);
  const summedTokens = buckets.reduce((total, bucket) => total + (bucket.tokens ?? Number.NaN), 0);
  const summedSteps = buckets.reduce((total, bucket) => total + bucket.steps, 0);
  const summedTurns = buckets.reduce((total, bucket) => total + bucket.turns, 0);
  if (!nearlyEqual(summedCost, totalCost) || summedTokens !== totalTokens || summedSteps !== totalSteps
    || totalTurns > summedTurns || countedSamples !== totalSteps) return null;
  let busiest: UsageSeries['busiest'] = null;
  if (value.busiest !== null) {
    if (!isRecord(value.busiest)) return null;
    const t = timeValue(value.busiest.t);
    const cost = nonNegativeNumber(value.busiest.cost);
    const tokens = nonNegativeInteger(value.busiest.tokens);
    const bucket = t === null ? undefined : buckets.find(item => item.t === t);
    if (t === null || cost === null || tokens === null || !bucket || bucket.cost === null || !nearlyEqual(bucket.cost, cost)
      || bucket.tokens !== tokens) return null;
    busiest = { t, cost, tokens };
  }
  return {
    ok: true, generatedAt, currency: currency.toUpperCase(), symbol, hours, bucketMs, from, to, buckets,
    totals: { cost: totalCost, tokens: totalTokens, turns: totalTurns, steps: totalSteps }, busiest,
    estimated: value.estimated, countedSamples, offChartCost, offChartTokens,
  };
}

export interface UsageTurn {
  readonly sessionId: string;
  readonly key: string | null;
  readonly turn: number | null;
  readonly turnId?: string;
  readonly generation?: number;
  readonly coverage?: 'complete' | 'partial' | 'unknown';
  readonly knownCosts?: Readonly<Record<string, number>>;
  readonly steps: number;
  readonly attempts: number;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly model: string | null;
  readonly provider: string | null;
  readonly buckets: UsageBuckets;
  readonly cost: number | null;
  readonly tier: AggregateUsageTier;
}

export interface UsageConversationDetails {
  readonly native?: true;
  readonly partial?: boolean;
  readonly knownCosts?: Readonly<Record<string, number>>;
  readonly key: string;
  readonly generatedAt: number;
  readonly currency: string;
  readonly symbol: string;
  readonly sessionIds: readonly string[];
  readonly sessionCount: number;
  readonly buckets: UsageBuckets;
  readonly cost: number | null;
  readonly attributedCost: number | null;
  readonly unattributedCost: number | null;
  readonly byTier: UsageByTier | null;
  readonly estimated: boolean;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly models: readonly string[];
  readonly turnLimit: number;
  readonly limited: boolean | null;
  readonly turns: readonly UsageTurn[];
}

function parseUsageTurn(value: unknown): UsageTurn | null {
  if (!isRecord(value)) return null;
  const sessionId = boundedText(value.sessionId, 256);
  const key = value.key === undefined ? null : boundedText(value.key, 128);
  const turn = nonNegativeInteger(value.turn);
  const steps = nonNegativeInteger(value.steps);
  const attempts = nonNegativeInteger(value.attempts);
  const startedAt = timeValue(value.startedAt);
  const endedAt = timeValue(value.endedAt);
  const model = value.model === null ? null : boundedText(value.model, 256);
  const provider = value.provider === null ? null : boundedText(value.provider, 256);
  const buckets = parseBuckets(value.buckets);
  const cost = nonNegativeNumber(value.cost);
  const tier = parseAggregateTier(value.tier);
  if (!sessionId || value.key !== undefined && !key || turn === null || steps === null || attempts === null
    || startedAt === null || endedAt === null || startedAt > endedAt || value.model !== null && !model
    || value.provider !== null && !provider || !buckets || cost === null || !tier) return null;
  return { sessionId, key, turn, steps, attempts, startedAt, endedAt, model, provider, buckets, cost, tier };
}

export function parseUsageConversation(value: unknown, expectedKey?: string): UsageConversationDetails | null {
  if (isRecord(value) && value.native === true) return parseNativeUsageConversation(value, expectedKey);
  if (!isRecord(value) || typeof value.estimated !== 'boolean' || !Array.isArray(value.sessionIds)
    || !Array.isArray(value.models) || !Array.isArray(value.turns) || value.sessionIds.length > 2000
    || value.models.length > 256 || value.turns.length > 1000) return null;
  const key = boundedText(value.key, 128);
  const generatedAt = timeValue(value.generatedAt);
  const currency = boundedText(value.currency, 16);
  const symbol = boundedText(value.symbol, 16);
  const sessionIds = value.sessionIds.map(sessionId => boundedText(sessionId, 256));
  const sessionCount = nonNegativeInteger(value.sessionCount);
  const buckets = parseBuckets(value.buckets);
  const cost = nonNegativeNumber(value.cost);
  const attributedCost = nonNegativeNumber(value.attributedCost);
  const unattributedCost = nonNegativeNumber(value.unattributedCost);
  const byTier = parseByTier(value.byTier);
  const firstAt = timeValue(value.firstAt);
  const lastAt = timeValue(value.lastAt);
  const models = value.models.map(model => boundedText(model, 256));
  const turnLimit = positiveInteger(value.turnLimit);
  const limited = value.limited === undefined ? null : typeof value.limited === 'boolean' ? value.limited : undefined;
  if (!key || expectedKey !== undefined && key !== expectedKey || generatedAt === null || !currency || !symbol
    || sessionIds.some(sessionId => sessionId === null) || new Set(sessionIds).size !== sessionIds.length
    || sessionCount === null || sessionCount !== sessionIds.length || !buckets || cost === null
    || attributedCost === null || unattributedCost === null || !byTier || !nearlyEqual(byTier.peak + byTier.off, cost)
    || firstAt === null || lastAt === null || firstAt > lastAt || models.some(model => model === null)
    || new Set(models).size !== models.length || turnLimit === null || turnLimit > 1000 || limited === undefined
    || value.turns.length > turnLimit) return null;
  const turns: UsageTurn[] = [];
  for (const item of value.turns) {
    const turn = parseUsageTurn(item);
    if (!turn) return null;
    turns.push(turn);
  }
  return {
    key, generatedAt, currency: currency.toUpperCase(), symbol, sessionIds: sessionIds as string[], sessionCount,
    buckets, cost, attributedCost, unattributedCost, byTier, estimated: value.estimated, firstAt, lastAt,
    models: models as string[], turnLimit, limited, turns,
  };
}

export interface UsageRecentEntry {
  readonly id?: string;
  readonly time: number;
  readonly key: string | null;
  readonly sid: string;
  readonly turn: number | null;
  readonly turnId?: string;
  readonly step: number | null;
  readonly retry: number | null;
  readonly model: string | null;
  readonly tokens: number | null;
  readonly cacheMiss: number | null;
  readonly cacheHit: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
  readonly cost: number | null;
  readonly knownCost?: { readonly amount: number; readonly currency: string; readonly source: string } | null;
  readonly coverage?: 'complete' | 'partial' | 'unknown';
  readonly pricingRevision?: number | null;
  readonly tier: UsageTier;
  readonly estimated: boolean;
}

export interface UsageRecent {
  readonly native?: true;
  readonly partial?: boolean;
  readonly symbol: string;
  readonly entries: readonly UsageRecentEntry[];
}

function parseRecentEntry(value: unknown): UsageRecentEntry | null {
  if (!isRecord(value) || typeof value.estimated !== 'boolean') return null;
  const time = timeValue(value.time);
  const key = value.key === null ? null : boundedText(value.key, 128);
  const sid = boundedText(value.sid, 256);
  const turn = nonNegativeInteger(value.turn);
  const step = nonNegativeInteger(value.step);
  const retry = nonNegativeInteger(value.retry);
  const model = value.model === null ? null : boundedText(value.model, 256);
  const tokens = nonNegativeInteger(value.tokens);
  const cacheMiss = nonNegativeInteger(value.cacheMiss);
  const cacheHit = nonNegativeInteger(value.cacheHit);
  const cacheWrite = nonNegativeInteger(value.cacheWrite);
  const output = nonNegativeInteger(value.output);
  const reasoning = nonNegativeInteger(value.reasoning);
  const cost = nonNegativeNumber(value.cost);
  const tier = parseUsageTier(value.tier);
  if (time === null || value.key !== null && !key || !sid || turn === null || step === null || retry === null
    || value.model !== null && !model || tokens === null || cacheMiss === null || cacheHit === null
    || cacheWrite === null || output === null || reasoning === null || cost === null || !tier) return null;
  return { time, key, sid, turn, step, retry, model, tokens, cacheMiss, cacheHit, cacheWrite, output,
    reasoning, cost, tier, estimated: value.estimated };
}

export function parseUsageRecent(value: unknown): UsageRecent | null {
  if (isRecord(value) && value.native === true) return parseNativeUsageRecent(value);
  if (!isRecord(value) || !Array.isArray(value.entries) || value.entries.length > 500) return null;
  const symbol = boundedText(value.symbol, 16);
  if (!symbol) return null;
  const entries: UsageRecentEntry[] = [];
  for (const item of value.entries) {
    const entry = parseRecentEntry(item);
    if (!entry) return null;
    entries.push(entry);
  }
  return { symbol, entries };
}

export interface UsageResetAccepted {
  readonly ok: true;
  readonly resetAccepted: true;
}

export function parseUsageResetAccepted(value: unknown): UsageResetAccepted | null {
  return isRecord(value) && value.ok === true && value.resetAccepted === true
    ? { ok: true, resetAccepted: true }
    : null;
}

export function usageBucketValue(bucket: UsageSeriesBucket, metric: UsageChartMetric): number | null {
  return metric === 'tokens' ? bucket.tokens : bucket.cost;
}
