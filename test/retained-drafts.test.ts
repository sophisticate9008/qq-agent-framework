import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiClient } from '../web/lib/api.ts';
import { clearRetainedDrafts, createDraftKey, retainDraft, retainedDraft, retainedDraftCount, retainedDraftScopes } from '../web/lib/retained-drafts.ts';
const client = (): ApiClient => ({ get: async () => ({}), post: async () => ({}) });

test('public drafts survive navigation for the same API identity without issuing requests', () => {
  let reads = 0; let writes = 0;
  const api: ApiClient = { get: async () => { reads++; return {}; }, post: async () => { writes++; return {}; } };
  const key = createDraftKey<{ readonly name: string; readonly revision: string }>('chat-plans');
  const value = { name: '未保存方案', revision: 'saved-version' }; retainDraft(api, key, value);
  assert.deepEqual(retainedDraft(api, key), value); assert.equal(retainedDraftCount(api), 1);
  assert.deepEqual(retainedDraftScopes(api), ['chat-plans']); assert.equal(reads, 0); assert.equal(writes, 0);
  assert.equal(retainedDraft(client(), key), undefined);
});

test('different forms retain independent drafts, while save/reset and exit clear only their intended values', () => {
  const api = client(); const plans = createDraftKey<string>('plans'); const personas = createDraftKey<string>('personas');
  retainDraft(api, plans, 'plan draft'); retainDraft(api, personas, 'persona draft'); retainDraft(api, plans, null);
  assert.equal(retainedDraft(api, personas), 'persona draft'); assert.equal(retainedDraftCount(api), 1);
  clearRetainedDrafts(api); assert.equal(retainedDraftCount(api), 0); assert.equal(retainedDraft(api, personas), undefined);
});
