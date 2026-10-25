import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createNativeMemoryService } from '../src/host/native-memory.ts';
import { memoryDraft, memoryManagementRequest } from '../web/lib/memory-ui.ts';

test('management corrections preserve proposal state, immutable scope and exact expiry without issuing a confirmation request', async context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close());
  const service = createNativeMemoryService({ store, clock: () => 100, authorizeSource() {}, authorizeOwner() {}, authorizeRead() {} });
  const input = { scope: { kind: 'user' as const, userId: '456', conversationId: 'group:123' }, kind: 'preference' as const,
    content: '尚待确认的偏好', tags: ['style'], expiresAt: 123_456_789 };
  const proposed = await service.propose(input, { kind: 'model-inference', conversationId: 'group:123', userId: '456', messageId: 'synthetic-message' }, new AbortController().signal);
  const draft = { ...memoryDraft(proposed), content: '纠正过的偏好', scope: 'global' as const, conversationId: 'group:999' };
  const request = memoryManagementRequest(draft, proposed, 200);
  assert.equal(request.action, 'correct'); assert.deepEqual(request.entry.scope, proposed.scope); assert.equal(request.entry.expiresAt, input.expiresAt);
  assert('id' in request && 'revision' in request);
  const corrected = await service.correct(request.id, request.revision, request.entry, { kind: 'operator' }, new AbortController().signal);
  assert.equal(corrected.status, 'proposed'); assert.equal(corrected.confirmedBy, null);
  assert.deepEqual(await service.query({ conversationId: 'group:123', userId: '456' }, new AbortController().signal), []);
});

test('new manual memories require a canonical scope and explicit valid duration while retaining independent authorization', () => {
  const draft = { ...memoryDraft(), conversationId: 'group:123', content: '手工事实', tags: 'one\ntwo' };
  const request = memoryManagementRequest(draft, null, 100);
  assert.equal(request.action, 'create'); assert.equal(request.entry.expiresAt, 100 + 24 * 3_600_000);
  assert.deepEqual(request.entry.tags, ['one', 'two']);
  assert.throws(() => memoryManagementRequest({ ...draft, conversationId: '*' }, null, 100));
  assert.throws(() => memoryManagementRequest({ ...draft, hours: '0' }, null, 100));
  assert.equal(memoryManagementRequest({ ...draft, permanent: true }, null, 100).entry.expiresAt, null);
});
