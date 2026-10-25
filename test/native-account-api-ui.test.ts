import assert from 'node:assert/strict';
import test from 'node:test';
import { accountDispatchPath, createAccountApiRegistry } from '../web/lib/account-api.ts';
import { createDraftKey, retainDraft, retainedDraft } from '../web/lib/retained-drafts.ts';
import { readResource, clearReadResources } from '../web/lib/resource-reader.ts';
test('account transport preserves method/body/query while global management remains global', async () => {
  const calls: unknown[] = []; const global = { get: async (path: string) => { calls.push(['get', path]); return {}; }, post: async (path: string, body: unknown) => { calls.push(['post', path, body]); return {}; } };
  const registry = createAccountApiRegistry(global); const id = 'a'.repeat(64); const client = registry.client(id); const body = { revision: 'opaque', value: true };
  await client.post('/api/chat/plans?filter=one&filter=two', body); const dispatch = new URL((calls[0] as string[])[1] ?? '', 'http://fixture');
  assert.equal(dispatch.pathname, '/api/accounts/dispatch'); assert.equal(dispatch.searchParams.get('account'), id); assert.equal(dispatch.searchParams.get('path'), '/api/chat/plans'); assert.deepEqual(dispatch.searchParams.getAll('filter'), ['one', 'two']); assert.equal((calls[0] as unknown[])[2], body);
  await client.get('/api/accounts'); assert.deepEqual(calls[1], ['get', '/api/accounts']); await client.get('/api/snapshot'); assert.deepEqual(calls[2], ['get', '/api/snapshot']);
  assert.throws(() => accountDispatchPath('/api/chat/plans?account=other', id)); assert.throws(() => registry.client('not-an-id'));
});
test('switching account identity cancels old reads while drafts and unknown operation evidence stay with their original account', async () => {
  const global = { get: (_path: string, signal?: AbortSignal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })), post: async () => ({}) };
  const registry = createAccountApiRegistry(global); const first = registry.client('a'.repeat(64)); const second = registry.client('b'.repeat(64)); assert.notEqual(first, second);
  const key = createDraftKey<{ readonly operationId: string; readonly state: 'unknown' }>('account-test'); retainDraft(first, key, { operationId: 'original', state: 'unknown' as const });
  const pending = readResource(first, '/api/chat/runtime'); await Promise.resolve(); clearReadResources(first); await assert.rejects(pending); assert.equal(retainedDraft(second, key), undefined);
  assert.equal(registry.client('a'.repeat(64)), first); assert.equal(retainedDraft(first, key)?.operationId, 'original'); assert.equal(registry.client(null), global);
});
test('saved operation evidence and read filters do not count as unsaved configuration drafts', async () => {
  const { retainedDraftCount, retainedDraftScopes, clearRetainedDrafts } = await import('../web/lib/retained-drafts.ts');
  const api = { get: async () => null, post: async () => null }; const state = createDraftKey<string>('operation-result', { kind: 'state' }); const draft = createDraftKey<string>('actual-form');
  retainDraft(api, state, 'original-unknown-id'); assert.equal(retainedDraftCount(api), 0); assert.deepEqual(retainedDraftScopes(api), []);
  retainDraft(api, draft, 'edited-value'); assert.equal(retainedDraftCount(api), 1); assert.deepEqual(retainedDraftScopes(api), ['actual-form']); clearRetainedDrafts(api); assert.equal(retainedDraft(api, state), undefined);
});
