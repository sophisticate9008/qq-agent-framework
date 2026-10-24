import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUsageChartGeometry,
  formatUsageWindowEndpoint,
  parseUsageConversation,
  parseUsageRecent,
  parseUsageResetAccepted,
  parseUsageSeries,
  usageSectionLabels,
} from '../web/lib/usage-details.ts';

const start = 1_798_012_800_000;
const bucketMs = 1_800_000;

function seriesFixture() {
  return {
    ok: true,
    generatedAt: start + bucketMs * 2,
    currency: 'CNY',
    symbol: '¥',
    hours: 1,
    bucketMs,
    from: start,
    to: start + bucketMs * 2,
    buckets: [
      { t: start, cost: 0, tokens: 0, cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, turns: 0, steps: 0, tier: 'off', keys: [] },
      { t: start + bucketMs, cost: 0.25, tokens: 160, cacheMiss: 100, cacheHit: 20, cacheWrite: 10, output: 30, turns: 1, steps: 2, tier: 'mixed', keys: ['group:1'] },
    ],
    totals: { cost: 0.25, tokens: 160, turns: 1, steps: 2 },
    busiest: { t: start + bucketMs, cost: 0.25, tokens: 160 },
    estimated: true,
    countedSamples: 2,
    offChartCost: 0.1,
    offChartTokens: 50,
  };
}

test('usage section labels are the single stable source for page and search titles', () => {
  assert.deepEqual(usageSectionLabels, {
    summary: '账本汇总', breakdown: 'Token 构成', chart: '消耗走势', conversations: '按会话汇总',
    turns: '逐轮花费', recent: '最近调用流水', prices: '当前生效价目表', management: '账本管理',
  });
});

test('pricing window endpoints preserve configured fractional hours', () => {
  assert.equal(formatUsageWindowEndpoint(9.5), '09:30');
  assert.equal(formatUsageWindowEndpoint(12), '12:00');
  assert.equal(formatUsageWindowEndpoint(14.2569444444), '14:15:25');
});

test('series parser preserves zero buckets and chart geometry never invents a positive scale label', () => {
  const parsed = parseUsageSeries(seriesFixture());
  assert(parsed);
  assert.equal(parsed.buckets[0]?.tokens, 0);
  assert.equal(buildUsageChartGeometry(parsed, 'cost').maximum, 0.25);

  const source = seriesFixture();
  const zeroFixture = {
    ...source,
    buckets: [source.buckets[0], { ...source.buckets[1], cost: 0, tokens: 0, cacheMiss: 0, cacheHit: 0,
      cacheWrite: 0, output: 0, turns: 0, steps: 0, tier: 'peak', keys: [] }],
    totals: { cost: 0, tokens: 0, turns: 0, steps: 0 },
    busiest: null,
    countedSamples: 0,
  };
  const zero = parseUsageSeries(zeroFixture);
  assert(zero);
  const geometry = buildUsageChartGeometry(zero, 'tokens');
  assert.deepEqual(geometry.axisValues, [0, 0, 0]);
  assert(geometry.bars.every(bar => bar.height === 0 && bar.value === 0));
});

test('chart geometry reduces tick density without shrinking mobile labels', () => {
  const parsed = parseUsageSeries(seriesFixture());
  assert(parsed);
  const geometry = buildUsageChartGeometry(parsed, 'cost', 280);
  assert.equal(geometry.width, 280);
  assert(geometry.ticks.length <= 3);
  assert(geometry.bars.every(bar => bar.x >= geometry.plotLeft
    && bar.x + bar.width <= geometry.plotLeft + geometry.plotWidth));
});

test('series parser enforces TimeClip, contiguous buckets and the backend key bound', () => {
  const invalidTime = seriesFixture();
  invalidTime.generatedAt = Number.MAX_SAFE_INTEGER;
  assert.equal(parseUsageSeries(invalidTime), null);

  const shifted = seriesFixture();
  shifted.buckets[1] = { ...shifted.buckets[1], t: start + bucketMs + 1 };
  assert.equal(parseUsageSeries(shifted), null);

  const inconsistent = seriesFixture();
  inconsistent.buckets[1] = { ...inconsistent.buckets[1], tokens: 161 };
  inconsistent.totals = { ...inconsistent.totals, tokens: 161 };
  inconsistent.busiest = { ...inconsistent.busiest, tokens: 161 };
  assert.equal(parseUsageSeries(inconsistent), null);

  const bounded = seriesFixture();
  bounded.buckets[1] = { ...bounded.buckets[1], keys: Array.from({ length: 500 }, (_, index) => `group:${index + 1}`) };
  assert(parseUsageSeries(bounded));
  bounded.buckets[1] = { ...bounded.buckets[1], keys: [...bounded.buckets[1].keys, 'group:501'] };
  assert.equal(parseUsageSeries(bounded), null);
});

test('turn parser accepts price-estimated rows without row flags and non-additive attributed cost', () => {
  const fixture = {
    key: 'group:1', generatedAt: start + 20_000, currency: 'CNY', symbol: '¥',
    sessionIds: ['session-1'], sessionCount: 1,
    buckets: { cacheMiss: 100, cacheHit: 20, cacheWrite: 10, output: 30, reasoning: 4 },
    cost: 0.2, attributedCost: 0.3, unattributedCost: 0, byTier: { peak: 0.1, off: 0.1 },
    estimated: true, firstAt: start, lastAt: start + 20_000, models: ['<model>'], turnLimit: 200,
    turns: [{
      sessionId: 'session-1', key: 'legacy-alias', turn: 4, steps: 2, attempts: 1,
      startedAt: start, endedAt: start + 20_000, model: '<model>', provider: '<provider>',
      buckets: { cacheMiss: 100, cacheHit: 20, cacheWrite: 10, output: 30, reasoning: 4 },
      cost: 0.3, tier: 'mixed',
    }],
  };
  const parsed = parseUsageConversation(fixture, 'group:1');
  assert(parsed);
  assert.equal(parsed.attributedCost, 0.3);
  assert.equal(parsed.turns[0]?.provider, '<provider>');
  assert.equal('estimated' in fixture.turns[0], false);
  assert.equal(parseUsageConversation({ ...fixture, generatedAt: Number.MAX_SAFE_INTEGER }, 'group:1'), null);
});

test('recent parser keeps bounded text inert and rejects raw legacy sessionId or malformed dates', () => {
  const fixture = {
    symbol: '¥',
    entries: [{
      time: start, key: '<img src=x onerror=alert(1)>', sid: '<session>', turn: 1, step: 2, retry: 1,
      model: '<script>alert(1)</script>', tokens: 160, cacheMiss: 100, cacheHit: 20, cacheWrite: 10,
      output: 30, reasoning: 4, cost: 0.2, tier: 'peak', estimated: true,
    }],
  };
  const parsed = parseUsageRecent(fixture);
  assert(parsed);
  assert.equal(parsed.entries[0]?.key, '<img src=x onerror=alert(1)>');
  assert.equal(parsed.entries[0]?.model, '<script>alert(1)</script>');
  assert.equal(parseUsageRecent({ ...fixture, entries: [{ ...fixture.entries[0], time: Number.MAX_SAFE_INTEGER }] }), null);
  const rawSession: Record<string, unknown> = { ...fixture.entries[0], sessionId: fixture.entries[0].sid };
  delete rawSession.sid;
  assert.equal(parseUsageRecent({ ...fixture, entries: [rawSession] }), null);
});

test('reset parser accepts only the explicit accepted response', () => {
  assert.deepEqual(parseUsageResetAccepted({ ok: true, resetAccepted: true }), { ok: true, resetAccepted: true });
  assert.equal(parseUsageResetAccepted({ ok: true }), null);
  assert.equal(parseUsageResetAccepted({ ok: true, resetAccepted: false }), null);
});
