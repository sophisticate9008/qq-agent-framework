import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeConversationKey,
  formatActivityCost,
  formatActivityCount,
  formatUsageCount,
  parseSessionResetResult,
  parseSessionSnapshot,
  parseUsageSnapshot,
} from '../web/lib/activity.ts';

test('session snapshots expose only validated group and private bindings', () => {
  const result = parseSessionSnapshot({
    revision: 'revision-1',
    sessions: [
      { key: 'group:123456', sessionId: 'session-group', owner: false },
      { key: 'private:90001', sessionId: 'session-owner', owner: true },
    ],
  });
  assert.deepEqual(result, {
    revision: 'revision-1',
    sessions: [
      { key: 'group:123456', sessionId: 'session-group', owner: false },
      { key: 'private:90001', sessionId: 'session-owner', owner: true },
    ],
  });
  assert.deepEqual(describeConversationKey('group:123456'), {
    key: 'group:123456', kind: 'group', identifier: '123456', label: '群聊',
  });
  assert.deepEqual(describeConversationKey('private:90001'), {
    key: 'private:90001', kind: 'private', identifier: '90001', label: '私聊',
  });
  assert.deepEqual(describeConversationKey('internal:usage-maintenance'), {
    key: 'internal:usage-maintenance', kind: 'internal', identifier: 'usage-maintenance', label: '内部',
  });
});

test('session parsing rejects missing revisions, empty keys and duplicate bindings', () => {
  assert.equal(parseSessionSnapshot({ sessions: [] }), null);
  assert.equal(parseSessionSnapshot({ revision: 'r', sessions: [{ key: '', sessionId: 'one', owner: false }] }), null);
  assert.equal(parseSessionSnapshot({ revision: 'r', sessions: [
    { key: 'group:1', sessionId: 'one', owner: false },
    { key: 'group:1', sessionId: 'two', owner: false },
  ] }), null);
});

test('unknown legacy conversation keys remain visible as other bindings', () => {
  assert.deepEqual(describeConversationKey('legacy-room'), {
    key: 'legacy-room', kind: 'other', identifier: 'legacy-room', label: '历史',
  });
  assert(parseSessionSnapshot({ revision: 'r', sessions: [{ key: 'legacy-room', sessionId: 'one', owner: false }] }));
});

test('session reset confirmation requires the exact selected binding result', () => {
  const response = {
    ok: true,
    key: 'private:90001',
    previousSessionId: 'session-owner',
    bridgeBindingRemoved: true,
    externalWorkStopped: 'unverified',
  };
  assert.deepEqual(parseSessionResetResult(response, 'private:90001', 'session-owner'), response);
  assert.equal(parseSessionResetResult(response, 'private:90001', 'different-session'), null);
  assert.equal(parseSessionResetResult({ ...response, externalWorkStopped: true }, 'private:90001', 'session-owner'), null);
});

test('usage snapshots validate ledger totals and conversation summaries', () => {
  const result = parseUsageSnapshot({
    source: 'chat-ledger',
    generatedAt: 1_798_014_600_000,
    currency: 'usd',
    symbol: '$',
    totals: {
      totalTokens: 12345, inputTokens: 8000, outputTokens: 4345, cacheHitTokens: 2000,
      cacheMissTokens: 6000, cacheWriteTokens: 300, reasoningTokens: 400, cost: 0.123456,
      estimated: true, conversations: 1, turns: 4, steps: 7, unattributedCost: 0.01,
    },
    conversations: [{
      key: 'group:123456', sessionCount: 2, totalTokens: 12345, inputTokens: 8000,
      outputTokens: 4345, cacheHitTokens: 2000, cost: 0.113456, estimated: true,
      turns: 4, steps: 7, lastAt: 1_798_014_540_000, models: ['gpt-5'],
    }],
    limit: 100,
    limited: false,
  });
  assert(result);
  assert.equal(result.currency, 'USD');
  assert.equal(result.totals.totalTokens, 12345);
  assert.equal(result.conversations[0]?.models[0], 'gpt-5');
  assert.equal(result.revision, null);
  assert.deepEqual(result.unavailable, ['pricing', 'ledger']);
});

test('usage snapshots parse complete pricing, ledger and enhanced statistics without exposing extras', () => {
  const result = parseUsageSnapshot({
    source: 'chat-ledger', revision: 'revision-full', generatedAt: 1_798_014_600_000,
    currency: 'cny', symbol: '¥', unavailable: [], priceVersion: 'price-v2',
    nowTier: {
      model: 'reference-model', label: '参考模型', tier: 'peak', tierLabel: '高峰', currency: 'CNY',
      symbol: '¥', unit: 10_000, estimated: true, cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1.2, output: 4,
    },
    priceTable: {
      version: 'price-v2', currency: 'CNY', symbol: '¥', unit: 10_000, peakMultiplier: 1.75,
      peakWindows: [[8, 11], [15.5, 19]], peakWeekdays: [1, 2, 3, 4], holidayCount: 18,
      models: { '<model>': { label: '<script>alert(1)</script>', off: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1.2, output: 4 } } },
    },
    ledger: {
      journalLines: 12, maxLines: 20_000, droppedLines: 2, sessions: 3, baselines: 2, samples: 9,
      lastIngestAt: 1_798_014_590_000, lastCompactedAt: 0,
    },
    totals: {
      totalTokens: 160, inputTokens: 130, outputTokens: 30, cacheHitTokens: 20, cacheMissTokens: 100,
      cacheWriteTokens: 10, reasoningTokens: 4, buckets: { cacheMiss: 100, cacheHit: 20, cacheWrite: 10, output: 30, reasoning: 4 },
      cost: 0.4, attributedCost: 0.5, unattributedCost: 0, byTier: { peak: 0.3, off: 0.1 }, estimated: true,
      conversations: 1, turns: 2, steps: 3, cacheHitRate: 20 / 130, avgCostPerTurn: 0.2, avgCostPerStep: 0.4 / 3,
    },
    conversations: [{
      key: 'internal:usage-maintenance', sessionCount: 1, totalTokens: 160, inputTokens: 130,
      outputTokens: 30, cacheHitTokens: 20, cacheMissTokens: 100, cacheWriteTokens: 10, reasoningTokens: 4,
      buckets: { cacheMiss: 100, cacheHit: 20, cacheWrite: 10, output: 30, reasoning: 4 },
      cost: 0.4, attributedCost: 0.5, unattributedCost: 0, byTier: { peak: 0.3, off: 0.1 },
      cacheHitRate: 20 / 130, estimated: true, turns: 2, steps: 3, firstAt: 1_798_014_500_000,
      lastAt: 1_798_014_590_000, models: ['<model>'],
    }],
    limit: 200, limited: false,
  });
  assert(result);
  assert.equal(result.revision, 'revision-full');
  assert.equal(result.priceTable?.peakMultiplier, 1.75);
  assert.equal(result.priceTable?.models['<model>']?.label, '<script>alert(1)</script>');
  assert.equal(result.ledger?.lastCompactedAt, 0);
  assert.equal(result.conversations[0]?.attributedCost, 0.5);
});

test('usage accepts bounded historical keys and treats zero lastAt as unrecorded', () => {
  const result = parseUsageSnapshot({
    source: 'chat-ledger', generatedAt: 1_798_014_600_000, currency: 'CNY', symbol: '¥',
    totals: {
      totalTokens: 1, inputTokens: 1, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 1,
      cacheWriteTokens: 0, reasoningTokens: 0, cost: 0.01, estimated: true, conversations: 1,
      turns: 1, steps: 1, unattributedCost: 0.01,
    },
    conversations: [{
      key: '未归属:legacy', sessionCount: 0, totalTokens: 1, inputTokens: 1, outputTokens: 0,
      cacheHitTokens: 0, cost: 0.01, estimated: true, turns: 1, steps: 1, lastAt: 0, models: [],
    }],
    limit: 100, limited: false,
  });
  assert(result);
  assert.equal(result.conversations[0]?.lastAt, null);
  assert.deepEqual(describeConversationKey(result.conversations[0]!.key), {
    key: '未归属:legacy', kind: 'unattributed', identifier: 'legacy', label: '未归属',
  });
});

test('usage parsing rejects malformed, negative and non-ledger statistics', () => {
  const base = {
    source: 'chat-ledger', generatedAt: 1_798_014_600_000, currency: 'USD', symbol: '$',
    totals: {
      totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0,
      cacheWriteTokens: 0, reasoningTokens: 0, cost: 0, estimated: true, conversations: 0,
      turns: 0, steps: 0, unattributedCost: 0,
    },
    conversations: [], limit: 100, limited: false,
  };
  assert.equal(parseUsageSnapshot({ ...base, source: 'platform-bill' }), null);
  assert.equal(parseUsageSnapshot({ ...base, generatedAt: Number.MAX_SAFE_INTEGER }), null);
  assert.equal(parseUsageSnapshot({ ...base, totals: { ...base.totals, cost: -1 } }), null);
  assert.equal(parseUsageSnapshot({ ...base, limit: 501 }), null);
  assert(parseUsageSnapshot({ ...base, totals: { ...base.totals, cost: 0, unattributedCost: 0.01 } }));
  assert.equal(parseUsageSnapshot({ ...base, unavailable: ['pricing'], ledger: {
    journalLines: 0, maxLines: 20_000, droppedLines: 0, sessions: 0, baselines: 0, samples: 0,
    lastIngestAt: 0, lastCompactedAt: Number.MAX_SAFE_INTEGER,
  } }), null);
});

test('activity formatters use locale counts and fall back to the provided currency symbol', () => {
  assert.equal(formatActivityCount(12345), '12,345');
  assert.equal(formatActivityCost(1.25, 'USD', 'US$'), 'US$1.25');
  assert.equal(formatActivityCost(1.25, 'USD', '$'), '$1.25');
  assert.equal(formatActivityCost(1.25, 'invalid-currency', '¤'), '¤1.25');
  assert.equal(formatActivityCost(1.25, 'invalid-currency', '<b>'), '<b>1.25');
});

test('usage counts compact thousands, millions and billions with rounded unit promotion', () => {
  for (const [value, expected] of [
    [0, '0'], [999, '999'], [1_000, '1k'], [1_250, '1.25k'], [1_255, '1.26k'],
    [12_345, '12.35k'], [999_994, '999.99k'], [999_995, '1m'], [999_999, '1m'],
    [1_000_000, '1m'], [1_250_000, '1.25m'], [999_999_999, '1b'],
    [1_000_000_000, '1b'], [1_250_000_000, '1.25b'],
  ] as const) {
    assert.equal(formatUsageCount(value), expected);
  }
});

test('usage detailed counts preserve full locale counts without changing session formatting', () => {
  for (const value of [0, 999, 1_000, 1_250, 999_999, 1_000_000, 1_000_000_000]) {
    assert.equal(formatUsageCount(value, true), formatActivityCount(value));
  }
  assert.equal(formatUsageCount(1_250, true), '1,250');
  assert.equal(formatUsageCount(999_999, true), '999,999');
  assert.equal(formatActivityCount(1_000_000), '1,000,000');
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => formatUsageCount(value), RangeError);
    assert.throws(() => formatUsageCount(value, true), RangeError);
  }
});
