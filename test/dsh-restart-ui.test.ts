import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, type ApiClient } from '../web/lib/api.ts';
import { dshRestartPending, dshRestartReadPath, dshRestartStore, requestDshRestart } from '../web/lib/dsh-restart.ts';
import { isNativeConfigurationRevisions, NATIVE_CONFIGURATION_REVISION_KEYS } from '../src/contracts/native-revisions.ts';
import type { NativeDshRestartSnapshot } from '../src/contracts/native-dsh-restart.ts';

const revisions = Object.fromEntries(NATIVE_CONFIGURATION_REVISION_KEYS.map(key => [key, 'a'.repeat(64)]));
assert(isNativeConfigurationRevisions(revisions));

test('restart submits one fixed operation, and a missing acknowledgement only permits original-id reads and reconciliation', async () => {
  const calls: { path: string; body: unknown }[] = [];
  let operationId = '';
  const api: ApiClient = { async get(path) {
    if (path === '/api/chat/runtime') return { revisions };
    assert.equal(path, '/api/chat/dsh/restart'); return { schema: 1, available: true, missingReasons: [], operation: null };
  }, async post(path, body) {
    calls.push({ path, body }); assert(body && typeof body === 'object');
    if (path === '/api/chat/dsh/restart') {
      const input = body as { operationId: string; revisions: unknown }; operationId = input.operationId;
      assert.deepEqual(input.revisions, revisions); throw new ApiError('operation_unknown', 504);
    }
    assert.equal(path, '/api/chat/dsh/restart/reconcile'); assert.deepEqual(body, { operationId });
    return { schema: 1, available: true, missingReasons: [], operation: { schema: 1, id: operationId,
      state: 'completed', phase: 'restore', phaseState: 'confirmed', revisions, wasRunning: true,
      restartExecutionVerified: false, createdAt: 1, updatedAt: 2, reasons: [] } };
  } };
  await requestDshRestart(api);
  assert(dshRestartPending(dshRestartStore(api).getSnapshot()));
  assert.equal(dshRestartReadPath(dshRestartStore(api).getSnapshot()), `/api/chat/dsh/restart?id=${operationId}`);
  await requestDshRestart(api); assert.equal(calls.length, 1);
  await requestDshRestart(api, true); assert.equal(calls.length, 2);
  assert.equal(dshRestartPending(dshRestartStore(api).getSnapshot()), false);
  assert.equal(dshRestartStore(api).getSnapshot().snapshot?.operation?.restartExecutionVerified, false);
});

test('ordinary late restart observations cannot revive a completed operation or regress its evidence', () => {
  const api: ApiClient = { get: async () => ({}), post: async () => ({}) };
  const store = dshRestartStore(api);
  const snapshot: NativeDshRestartSnapshot = { schema: 1, available: true, missingReasons: [], operation: {
    schema: 1, id: '11111111-1111-4111-8111-111111111111', state: 'completed', phase: 'restore', phaseState: 'confirmed',
    revisions,
    wasRunning: true, restartExecutionVerified: true, createdAt: 1, updatedAt: 3, reasons: [],
  } };
  assert(store.observe(snapshot)); assert(snapshot.operation);
  assert.equal(store.observe({ ...snapshot, operation: { ...snapshot.operation, state: 'running', updatedAt: 2 } }), false);
  assert.equal(store.getSnapshot().snapshot?.operation?.state, 'completed');
});

test('a confirmed blocked restart permits a fresh explicit intent after its conditions are fixed', async () => {
  const original = { schema: 1 as const, id: '11111111-1111-4111-8111-111111111111', state: 'blocked' as const,
    phase: 'stop' as const, phaseState: 'confirmed' as const, revisions, wasRunning: false,
    restartExecutionVerified: false, createdAt: 1, updatedAt: 2, reasons: ['DSH_RESTART_APPLICATION_BUSY'] };
  const snapshot: NativeDshRestartSnapshot = { schema: 1, available: true, missingReasons: [], operation: original };
  let writes = 0;
  const api: ApiClient = { async get(path) { return path === '/api/chat/runtime' ? { revisions } : snapshot; },
    async post(path, body) {
      writes++; assert.equal(path, '/api/chat/dsh/restart');
      const input = body as { operationId: string }; assert.notEqual(input.operationId, original.id);
      return { ...snapshot, operation: { ...original, id: input.operationId, state: 'completed', phase: 'restore',
        restartExecutionVerified: true, reasons: [], createdAt: 3, updatedAt: 4 } };
    } };
  dshRestartStore(api).observe(snapshot);
  assert.equal(dshRestartPending(dshRestartStore(api).getSnapshot()), false);
  await requestDshRestart(api);
  assert.equal(writes, 1); assert.equal(dshRestartStore(api).getSnapshot().snapshot?.operation?.state, 'completed');
});

test('a missing read does not erase an uncertain id; only authoritative not-received reconciliation retires it', async () => {
  let writes = 0;
  const empty: NativeDshRestartSnapshot = { schema: 1, available: true, missingReasons: [], operation: null };
  const api: ApiClient = { async get(path) { return path === '/api/chat/runtime' ? { revisions } : empty; },
    async post(path) {
      writes++;
      if (path === '/api/chat/dsh/restart') throw new ApiError('operation_unknown', 504);
      assert.equal(path, '/api/chat/dsh/restart/reconcile');
      throw new ApiError('dsh_restart_not_received', 409);
    } };
  await requestDshRestart(api);
  const store = dshRestartStore(api); const originalId = store.getSnapshot().operationId; assert(originalId);
  assert.equal(store.observe(empty), false);
  assert.equal(store.getSnapshot().operationId, originalId); assert(dshRestartPending(store.getSnapshot()));
  await requestDshRestart(api); assert.equal(writes, 1);
  await requestDshRestart(api, true);
  assert.equal(store.getSnapshot().operationId, null); assert.equal(dshRestartPending(store.getSnapshot()), false);
  assert.match(store.getSnapshot().error, /未被受理/);
});
