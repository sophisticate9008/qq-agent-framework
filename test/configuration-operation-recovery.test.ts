import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiClient } from '../web/lib/api.ts';
import { configurationOperationStore } from '../web/lib/configuration-operation-recovery.ts';
import type { ConfigurationOperationSource } from '../web/lib/configuration-operation-recovery.ts';
import { configurationOperationStore as compatibilityStore } from '../web/lib/configuration-operations.ts';

test('traditional settings and configuration share one subscribed API/source ledger without storing bodies', () => {
  const api: ApiClient = { get: async () => ({}), post: async () => ({}) };
  const settings = configurationOperationStore(api);
  const editor = compatibilityStore(api);
  assert.equal(settings, editor);
  let observed = 0;
  const unsubscribe = editor.subscribe(() => { observed++; });
  const token = settings.begin('gateway', 'revision', 'apply');
  assert(token);
  assert.equal(editor.begin('gateway', 'revision', 'save'), null);
  settings.block('gateway', token, 'unknown');
  const owner = {};
  assert(editor.review('gateway', token, owner));
  assert.equal(settings.getSnapshot().gateway?.phase, 'blocked');
  assert.equal(editor.complete('gateway', token), false);
  assert(editor.acknowledge('gateway', token, owner));
  assert.equal(observed, 4);
  assert.deepEqual(editor.getSnapshot(), {});
  unsubscribe();
});

test('review invalidation is owner-scoped and no DSH deployment target is accepted', () => {
  const api: ApiClient = { get: async () => ({}), post: async () => ({}) };
  const store = configurationOperationStore(api);
  const token = store.begin('admin', 'revision', 'save');
  assert(token);
  store.block('admin', token, 'conflict');
  const owner = {};
  store.review('admin', token, owner);
  store.invalidateReviews({});
  assert.equal(store.getSnapshot().admin?.reviewedBy, owner);
  store.invalidateReviews(owner);
  assert.equal(store.getSnapshot().admin?.reviewedBy, null);
  assert.deepEqual(Object.keys(store.getSnapshot().admin ?? {}).sort(), ['action', 'phase', 'reason', 'reviewedBy', 'revision', 'token']);
  assert.throws(() => store.begin('dsh-deployment' as ConfigurationOperationSource, 'revision'));
});
