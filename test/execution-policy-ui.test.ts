import assert from 'node:assert/strict';
import test from 'node:test';
import { executionForm, executionPolicy, parseExecutionConfiguration, secondsToMilliseconds, type ExecutionPolicy } from '../web/lib/execution-policy.ts';

const policy: ExecutionPolicy = { schema: 1, turnTimeoutMs: 60_000, noticeEnabled: true,
  noticeText: '请求已超时，结果尚未确认，未自动重复提交。', cancelOnTimeout: true,
  cancelTimeoutMs: 5000, noticeTimeoutMs: 5000, maxActive: 256, unknownHandling: 'isolate-session', lateFinal: 'record-only' };

test('execution policy keeps the sixty-second total deadline separate from short callback waits', () => {
  assert.deepEqual(executionForm(policy), { turnSeconds: '60', noticeEnabled: true, noticeText: policy.noticeText,
    cancelOnTimeout: true, cancelSeconds: '5', noticeSeconds: '5', maxActive: '256' });
  assert.deepEqual(executionPolicy(executionForm(policy)), policy);
  assert.equal(parseExecutionConfiguration({ revision: '0'.repeat(64), policy })?.policy.turnTimeoutMs, 60_000);
  for (const patch of [{ turnTimeoutMs: 0 }, { turnTimeoutMs: 300_001 }, { noticeTimeoutMs: 30_001 },
    { maxActive: 0 }, { noticeText: '' }, { noticeText: null }, { unknownHandling: 'retry' },
    { lateFinal: 'send-next' }, { noticeEnabled: 'false' }, { unexpected: true }]) {
    assert.equal(parseExecutionConfiguration({ revision: '0'.repeat(64), policy: { ...policy, ...patch } }), null);
  }
});

test('execution switches retain values and never imply new permission or automatic replay', () => {
  const disabled = executionPolicy({ ...executionForm(policy), noticeEnabled: false, cancelOnTimeout: false });
  assert(disabled);
  assert.equal(disabled.noticeText, policy.noticeText);
  assert.equal(disabled.cancelTimeoutMs, 5000);
  assert.equal(disabled.unknownHandling, 'isolate-session');
  assert.equal(disabled.lateFinal, 'record-only');
  assert.equal(Object.hasOwn(disabled, 'grants'), false);
  assert(parseExecutionConfiguration({ revision: '0'.repeat(64), policy: { ...policy, noticeEnabled: false, noticeText: null } }));
});

test('decimal seconds map exactly to milliseconds without hidden rounding or unbounded inputs', () => {
  for (const [seconds, milliseconds] of [['0.01', 10], ['0.029', 29], ['1.001', 1001], ['60', 60_000], ['300.000', 300_000]] as const) {
    assert.equal(secondsToMilliseconds(seconds), milliseconds);
  }
  for (const invalid of ['-1', '01', '0.0001', '1e3', 'Infinity', '1.', ' 60', '9007199254740991']) assert.equal(secondsToMilliseconds(invalid), null);
  assert.equal(executionPolicy({ ...executionForm(policy), turnSeconds: '' }), null);
  assert.equal(executionPolicy({ ...executionForm(policy), maxActive: '01' }), null);
});
