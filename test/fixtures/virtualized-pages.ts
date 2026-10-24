const anchor = Date.UTC(2026, 9, 25);
const buckets = { cacheMiss: 400, cacheHit: 600, cacheWrite: 0, output: 400, reasoning: 100 };
const counters = { totalTokens: 1400, inputTokens: 1000, outputTokens: 400, cacheHitTokens: 600, cacheMissTokens: 400, cacheWriteTokens: 0, reasoningTokens: 100 };
const models = Array.from({ length: 128 }, (_, index) => ({ id: `fixture-model-${index}`, name: `合成模型 ${index}` }));

export function virtualizedPagesFixture() {
  return {
    sessions: { revision: 'isolated-sessions', sessions: Array.from({ length: 256 }, (_, index) => ({ key: `group:${100_000 + index}`, sessionId: `isolated-session-${index}`, owner: index === 0 })) },
    providers: { revision: 'isolated-providers', providers: Array.from({ length: 128 }, (_, index) => ({ id: `fixture-provider-${index}`, name: `合成提供方 ${index}`, type: 'openai', baseUrl: 'https://fixture.invalid/v1', enabled: true, apiKeyConfigured: true, models })) },
    summary: {
      source: 'chat-ledger', revision: 'isolated-usage', generatedAt: anchor, limit: 200, limited: false,
      currency: 'CNY', symbol: '¥', priceVersion: 'isolated-prices',
      nowTier: { model: models[0].id, label: models[0].name, tier: 'off', tierLabel: '空闲', currency: 'CNY', symbol: '¥', unit: 1_000_000, estimated: false, cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 2 },
      priceTable: { version: 'isolated-prices', currency: 'CNY', symbol: '¥', unit: 1_000_000, peakMultiplier: 2, peakWindows: [[9, 18]], peakWeekdays: [1, 2, 3, 4, 5], holidayCount: 0,
        models: Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`fixture-model-${index}`, { label: `合成模型 ${index}`, off: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 2 } }])) },
      totals: { ...Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, value * 200])), buckets: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value * 200])), cost: 200, attributedCost: 200, unattributedCost: 0, byTier: { peak: 0, off: 200 }, estimated: true, conversations: 200, turns: 200, steps: 200, cacheHitRate: 0.6, avgCostPerTurn: 1, avgCostPerStep: 1 },
      conversations: Array.from({ length: 200 }, (_, index) => ({ key: `group:${100_000 + index}`, sessionCount: 1, ...counters, buckets, cost: 1, attributedCost: 1, unattributedCost: 0, byTier: { peak: 0, off: 1 }, estimated: true, turns: 1, steps: 1, cacheHitRate: 0.6, firstAt: anchor - 60_000, lastAt: anchor, models: models.slice(0, index % 5 + 1).map(model => model.id) })),
    },
    turns(key: string) {
      return { key, generatedAt: anchor, currency: 'CNY', symbol: '¥', sessionIds: ['isolated-session'], sessionCount: 1,
        buckets: Object.fromEntries(Object.entries(buckets).map(([name, value]) => [name, value * 200])), cost: 200, attributedCost: 200, unattributedCost: 0, byTier: { peak: 0, off: 200 }, estimated: true, firstAt: anchor - 200_000, lastAt: anchor, models: [models[0].id], turnLimit: 200, limited: false,
        turns: Array.from({ length: 200 }, (_, index) => ({ key, sessionId: 'isolated-session', turn: index, steps: 1, attempts: 1, startedAt: anchor - (200 - index) * 1000, endedAt: anchor - (199 - index) * 1000, model: models[index % models.length].id, provider: 'fixture-provider-0', buckets, cost: 1, tier: 'off' })) };
    },
    recent: { symbol: '¥', entries: Array.from({ length: 40 }, (_, index) => ({ time: anchor - index * 1000, key: 'group:100000', sid: 'isolated-session', turn: index, step: 1, retry: 0, model: models[0].id, tokens: 1400, ...buckets, cost: 1, tier: 'off', estimated: true })) },
    series(hours: number) {
      const bucketMs = hours * 3_600_000 / 48;
      const from = anchor - hours * 3_600_000;
      const entries = Array.from({ length: 48 }, (_, index) => ({ t: from + bucketMs * index, cost: 1, tokens: 1400, cacheMiss: 400, cacheHit: 600, cacheWrite: 0, output: 400, turns: 1, steps: 1, tier: 'off', keys: ['group:100000'] }));
      return { ok: true, generatedAt: anchor, currency: 'CNY', symbol: '¥', hours, bucketMs, from, to: anchor, buckets: entries, totals: { cost: 48, tokens: 1400 * 48, turns: 48, steps: 48 }, busiest: { t: from, cost: 1, tokens: 1400 }, estimated: true, countedSamples: 48, offChartCost: 152, offChartTokens: 1400 * 152 };
    },
  };
}
