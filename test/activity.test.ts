import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeConversationKey,
  formatActivityCost,
  formatActivityCount,
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
  assert.equal(parseUsageSnapshot({ ...base, limit: 201 }), null);
  assert.equal(parseUsageSnapshot({ ...base, totals: { ...base.totals, cost: 0, unattributedCost: 0.01 } }), null);
});

test('activity formatters use locale counts and fall back to the provided currency symbol', () => {
  assert.equal(formatActivityCount(12345), '12,345');
  assert.match(formatActivityCost(1.25, 'USD', '$'), /1\.25/);
  assert.equal(formatActivityCost(1.25, 'invalid-currency', '¤'), '¤1.25');
  assert.equal(formatActivityCost(1.25, 'invalid-currency', '<b>'), '<b>1.25');
});
