export interface ConversationIdentity {
  readonly key: string;
  readonly kind: 'group' | 'private' | 'unattributed' | 'other';
  readonly identifier: string;
  readonly label: '群聊' | '私聊' | '未归属' | '历史';
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
}

export interface SessionSnapshot {
  readonly sessions: readonly ManagedSession[];
  readonly revision: string;
}

export function parseSessionSnapshot(value: unknown): SessionSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.sessions) || value.sessions.length > 256) return null;
  const revision = boundedText(value.revision, 256);
  if (!revision) return null;
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
  return { sessions, revision };
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
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly cost: number;
  readonly estimated: boolean;
  readonly conversations: number;
  readonly turns: number;
  readonly steps: number;
  readonly unattributedCost: number;
}

export interface ConversationUsage {
  readonly key: string;
  readonly sessionCount: number;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheHitTokens: number;
  readonly cost: number;
  readonly estimated: boolean;
  readonly turns: number;
  readonly steps: number;
  readonly lastAt: string | null;
  readonly models: readonly string[];
}

export interface UsageSnapshot {
  readonly source: 'chat-ledger';
  readonly generatedAt: string;
  readonly currency: string;
  readonly symbol: string;
  readonly totals: UsageTotals;
  readonly conversations: readonly ConversationUsage[];
  readonly limit: number;
  readonly limited: boolean;
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
  if ([totalTokens, inputTokens, outputTokens, cacheHitTokens, cacheMissTokens, cacheWriteTokens, reasoningTokens,
    cost, conversations, turns, steps, unattributedCost].some(item => item === null)) return null;
  return {
    totalTokens: totalTokens!, inputTokens: inputTokens!, outputTokens: outputTokens!,
    cacheHitTokens: cacheHitTokens!, cacheMissTokens: cacheMissTokens!, cacheWriteTokens: cacheWriteTokens!,
    reasoningTokens: reasoningTokens!, cost: cost!, estimated: value.estimated,
    conversations: conversations!, turns: turns!, steps: steps!, unattributedCost: unattributedCost!,
  };
}

function parseConversationUsage(value: unknown): ConversationUsage | null {
  if (!isRecord(value) || typeof value.estimated !== 'boolean' || !Array.isArray(value.models) || value.models.length > 64) return null;
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
  if (!key || sessionCount === null || totalTokens === null || inputTokens === null
    || outputTokens === null || cacheHitTokens === null || cost === null || turns === null || steps === null
    || lastAt === null && value.lastAt !== 0 || models.some(model => model === null) || new Set(models).size !== models.length) return null;
  return {
    key, sessionCount, totalTokens, inputTokens, outputTokens, cacheHitTokens, cost,
    estimated: value.estimated, turns, steps, lastAt, models: models as string[],
  };
}

export function parseUsageSnapshot(value: unknown): UsageSnapshot | null {
  if (!isRecord(value) || value.source !== 'chat-ledger' || !Array.isArray(value.conversations)
    || value.conversations.length > 1000 || typeof value.limited !== 'boolean') return null;
  const generatedAt = timestamp(value.generatedAt);
  const currency = boundedText(value.currency, 16);
  const symbol = boundedText(value.symbol, 16);
  const totals = parseTotals(value.totals);
  const limit = nonNegativeInteger(value.limit);
  if (!generatedAt || !currency || !symbol || !totals || totals.unattributedCost > totals.cost
    || limit === null || limit < 1 || limit > 200 || value.conversations.length > limit) return null;
  const conversations: ConversationUsage[] = [];
  const keys = new Set<string>();
  for (const item of value.conversations) {
    const conversation = parseConversationUsage(item);
    if (!conversation || keys.has(conversation.key)) return null;
    keys.add(conversation.key);
    conversations.push(conversation);
  }
  return {
    source: 'chat-ledger', generatedAt, currency: currency.toUpperCase(), symbol, totals,
    conversations, limit, limited: value.limited,
  };
}

const countFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export function formatActivityCount(value: number): string {
  return countFormatter.format(value);
}

export function formatActivityCost(value: number, currency: string, symbol: string): string {
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 6,
    }).format(value);
  } catch {
    return `${symbol}${decimalFormatter.format(value)}`;
  }
}
