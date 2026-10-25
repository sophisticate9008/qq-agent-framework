import assert from 'node:assert/strict';
import test from 'node:test';
import { configurationApplyOutcome, configurationOperationStore } from '../web/lib/configuration-operations.ts';
import type { ApiClient } from '../web/lib/api.ts';

function client(): ApiClient {
  return { get: async () => ({}), post: async () => ({}) };
}

test('configuration guard requires a matching review and explicit release; stale completion never unlocks', () => {
  const store = configurationOperationStore(client());
  const token = store.begin('admin', 'revision');
  assert(token);
  assert.equal(store.begin('admin', 'revision'), null);
  assert(store.block('admin', token, 'unknown'));
  assert.equal(store.complete('admin', token), false);
  const owner = {};
  assert.equal(store.release('admin', token, owner), false);
  assert(store.review('admin', token, owner));
  assert.equal(store.release('admin', token, {}), false);
  store.invalidateReviews();
  assert.equal(store.release('admin', token, owner), false);
  assert(store.review('admin', token, owner));
  assert(store.release('admin', token, owner));
  const next = store.begin('admin', 'revision');
  assert(next);
  assert.equal(store.complete('admin', token), false);
  assert.equal(store.block('admin', token, 'conflict'), false);
  assert.equal(store.getSnapshot().admin?.token, next);
  assert(store.complete('admin', next));
});

test('configuration guard is source-scoped and retained for the same API only', () => {
  const api = client();
  const store = configurationOperationStore(api);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  const token = store.begin('admin', 'revision');
  assert(token);
  store.block('admin', token, 'conflict');
  assert.equal(configurationOperationStore(api), store);
  assert.equal(configurationOperationStore(client()).getSnapshot().admin, undefined);
  assert(store.begin('gateway', 'revision'));
  assert.equal(notifications, 3);
  unsubscribe();
});

test('configuration apply trusts only matching official acknowledgements, never ambiguous JSON', () => {
  const base = { ok: true, source: 'admin', revision: 'revision' };
  assert.equal(configurationApplyOutcome({ ...base, application: { applied: true } }, 'admin', 'revision'), 'applied');
  assert.equal(configurationApplyOutcome({ ...base, application: { accepted: true, reconnectUrl: 'http://127.0.0.1:8100' } }, 'admin', 'revision'), 'accepted');
  for (const value of [null, {}, { ok: true }, { ...base, status: 'unknown', application: { applied: true } },
    { ...base, source: 'gateway', application: { applied: true } }, { ...base, revision: 'other', application: { applied: true } },
    { ...base, application: {} }, { ...base, application: { applied: true, status: 'unknown' } },
    { ...base, application: { accepted: true, reconnectUrl: 'javascript:alert(1)' } }]) {
    assert.equal(configurationApplyOutcome(value, 'admin', 'revision'), 'unknown');
  }
});
