import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, type ApiClient } from '../web/lib/api.ts';
import { applyAndStartChat, chatApplicationCanReconcile, chatApplicationStore, newChatApplicationId, readChatApplication, reconcileChatApplication, type ChatApplicationPhase } from '../web/lib/chat-application.ts';
import { chatRuntimeCanApplyAndStart, parseChatRuntimeStatus } from '../web/lib/chat-runtime.ts';
import { isNativeApplicationId, parseNativeApplicationEnvelope, type NativeApplicationSnapshot } from '../src/contracts/native-application.ts';
import { NATIVE_CONFIGURATION_REVISION_KEYS, type NativeConfigurationRevisions } from '../src/contracts/native-revisions.ts';

const revisions: NativeConfigurationRevisions = { plans: 'a'.repeat(64), personas: 'a'.repeat(64), access: 'a'.repeat(64), adapters: 'a'.repeat(64),
  providers: 'a'.repeat(64), authorization: 'a'.repeat(64), deployment: 'a'.repeat(64), execution: 'a'.repeat(64) };
const preparedRevisions = { ...revisions, deployment: 'b'.repeat(64) };
function status(state = 'stopped', conflict = false, version: Readonly<Record<string, string>> = revisions) {
  return { state, canStart: !conflict && state === 'stopped', canApplyDeployment: state === 'stopped', chatReady: state === 'running', protocolConnected: true,
    configurationIssues: conflict ? ['persisted_session_configuration_conflict'] : [], missingReasons: conflict ? ['persisted_session_configuration_conflict'] : [],
    revisions: version, activeRevisions: null, lastError: null,
    sessionMigration: { eligible: true, availability: 'requires-preview', requiresPreview: true, missingReasons: [] } };
}
function fixture(options: { terminal?: 'completed' | 'blocked' | 'unknown'; lostAcknowledgement?: boolean; drift?: boolean; active?: boolean } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let operation: NativeApplicationSnapshot | null = options.active ? { schema: 1, id: '11111111-1111-4111-8111-111111111111', state: 'running',
    phase: 'apply', phaseState: 'in-flight', revisions, createdAt: 1, updatedAt: 1, reasons: [] } : null;
  let polls = 0;
  const api: ApiClient = {
    async get(path) {
      calls.push({ method: 'GET', path });
      if (path === '/api/chat/runtime') return status(operation?.state === 'completed' ? 'running' : 'stopped', false,
        options.drift ? { ...preparedRevisions, plans: 'c'.repeat(64) } : operation?.revisions ?? revisions);
      if (path.startsWith('/api/chat/application')) {
        if (path.includes('?id=') && operation && !options.active) {
          polls++;
          const terminal = options.terminal ?? 'completed';
          operation = { ...operation, state: terminal, phase: terminal === 'completed' ? 'start' : 'apply', phaseState: 'confirmed',
            revisions: preparedRevisions, updatedAt: 2, reasons: terminal === 'completed' ? [] : [terminal === 'blocked' ? 'reasoning_effort_not_offered' : 'deployment_result_unknown'] };
        }
        return { schema: 1, operation };
      }
      throw new Error(`Unexpected read: ${path}`);
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      assert.equal(path, '/api/chat/application');
      assert(body && typeof body === 'object' && !Array.isArray(body));
      const request = body as Record<string, unknown>;
      assert(isNativeApplicationId(request.operationId)); assert.deepEqual(request.revisions, revisions);
      assert.equal(typeof request.deploy, 'boolean');
      operation = { schema: 1, id: request.operationId, state: 'running', phase: 'prepare', phaseState: 'in-flight', revisions,
        createdAt: 1, updatedAt: 1, reasons: [] };
      if (options.lostAcknowledgement) throw new ApiError('operation_unknown', 504);
      return { schema: 1, operation };
    },
  };
  return { api, calls, writes: () => calls.filter(call => call.method === 'POST'), polls: () => polls };
}
const run = (api: ApiClient) => applyAndStartChat({ api, signal: new AbortController().signal, isCurrent: () => true, expectedDeploymentRevision: revisions.deployment });

test('saved-settings client creates one persistent operation and only reads its progress and runtime', async () => {
  const fake = fixture(); const phases: ChatApplicationPhase[] = [];
  const result = await applyAndStartChat({ api: fake.api, signal: new AbortController().signal, isCurrent: () => true,
    configurationDocument: 'personas', configurationRevision: revisions.personas, onPhase: phase => phases.push(phase) });
  assert.equal(result.state, 'running'); assert.equal(fake.writes().length, 1); assert.equal(fake.writes()[0]?.path, '/api/chat/application');
  assert.deepEqual(phases, ['prepare', 'start']); assert(fake.polls() > 0);
  assert.equal(chatApplicationStore(fake.api).getSnapshot().operation?.state, 'completed');
});

test('lost POST acknowledgement is reconciled by the same operation id without another write', async () => {
  const fake = fixture({ lostAcknowledgement: true }); assert.equal((await run(fake.api)).state, 'running');
  assert.equal(fake.writes().length, 1);
  const request = fake.writes()[0]?.body as { readonly operationId: string };
  assert(fake.calls.some(call => call.method === 'GET' && call.path === `/api/chat/application?id=${request.operationId}`));
});

test('blocked operation returns its real reasons, while unknown refuses new writes across application entry points', async () => {
  const blocked = fixture({ terminal: 'blocked' }); assert.deepEqual((await run(blocked.api)).reasons, ['reasoning_effort_not_offered']);
  const unknown = fixture({ terminal: 'unknown' }); await assert.rejects(run(unknown.api), /尚未确认/);
  const count = unknown.calls.length; await assert.rejects(run(unknown.api), /尚未确认/);
  assert.equal(unknown.calls.length, count); assert.equal(unknown.writes().length, 1);
  assert.equal(chatApplicationStore(unknown.api).getSnapshot().blocked, true);
});

test('reopening observes an existing server operation and never creates a second one', async () => {
  const fake = fixture({ active: true }); const existing = await readChatApplication(fake.api);
  assert.equal(existing?.state, 'running'); assert.equal(chatApplicationStore(fake.api).getSnapshot().busy, true);
  await assert.rejects(run(fake.api), /正在进行/); assert.equal(fake.writes().length, 0);
});

test('aborting page observation leaves an acknowledged running operation intact and read-only recovery can finish it', async () => {
  const fake = fixture(); const controller = new AbortController();
  await assert.rejects(applyAndStartChat({ api: fake.api, signal: controller.signal, isCurrent: () => true,
    onPhase: () => controller.abort() }), { name: 'AbortError' });
  const state = chatApplicationStore(fake.api).getSnapshot();
  assert.equal(state.busy, true); assert.equal(state.blocked, false); assert(state.operationId);
  assert.equal((await readChatApplication(fake.api, undefined, state.operationId))?.state, 'completed');
  assert.equal(chatApplicationStore(fake.api).getSnapshot().busy, false); assert.equal(fake.writes().length, 1);
});

test('dirty ownership and stale configured revisions fail before an operation POST', async () => {
  const untouched = fixture(); await assert.rejects(applyAndStartChat({ api: untouched.api, signal: new AbortController().signal, isCurrent: () => false }), /页面或草稿/);
  assert.equal(untouched.calls.length, 0);
  const stale = fixture(); await assert.rejects(applyAndStartChat({ api: stale.api, signal: new AbortController().signal, isCurrent: () => true,
    expectedRevisions: { ...revisions, plans: 'f'.repeat(64) } }), /版本已变化/); assert.equal(stale.writes().length, 0);
});

test('application envelopes reject ambiguous identity and UUID generation works without randomUUID', () => {
  assert.deepEqual(parseNativeApplicationEnvelope({ schema: 1, operation: null }), { schema: 1, operation: null });
  assert.equal(parseNativeApplicationEnvelope({ schema: 1, operation: null, secret: 'synthetic' }), null);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); assert(descriptor);
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues(bytes: Uint8Array) { bytes.fill(171); return bytes; } } });
  try { assert(isNativeApplicationId(newChatApplicationId())); }
  finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
});

test('runtime primary action permits eligible same-ID conflicts but not unsupported or unrelated blockers', () => {
  const eligible = parseChatRuntimeStatus(status('stopped', true)); assert(eligible && chatRuntimeCanApplyAndStart(eligible));
  assert.equal(chatRuntimeCanApplyAndStart({ ...eligible, sessionMigrationEligible: false }), false);
  assert.equal(chatRuntimeCanApplyAndStart({ ...eligible, blockingReasons: [...eligible.blockingReasons, 'provider_not_usable'] }), false);
  assert.equal(NATIVE_CONFIGURATION_REVISION_KEYS.length, Object.keys(revisions).length);
});


test('late progress cannot regress a finished operation or erase a new unknown operation intent', () => {
  const fake = fixture(); const store = chatApplicationStore(fake.api);
  const first: NativeApplicationSnapshot = { schema: 1, id: '11111111-1111-4111-8111-111111111111', state: 'running', phase: 'apply',
    phaseState: 'in-flight', revisions, createdAt: 1, updatedAt: 2, reasons: [] };
  assert(store.observe(first));
  assert(store.observe({ ...first, phase: 'start' }));
  assert.equal(store.observe({ ...first, updatedAt: 3 }), false);
  assert.equal(store.observe({ ...first, phase: 'start', createdAt: 0, updatedAt: 3 }), false);
  assert(store.observe({ ...first, state: 'completed', phase: 'start', phaseState: 'confirmed', updatedAt: 3 }));
  assert.equal(store.observe(first), false); assert.equal(store.getSnapshot().busy, false);
  const token = store.claim('application'); const nextId = '22222222-2222-4222-8222-222222222222';
  store.identify(token, nextId); store.freeze();
  assert.equal(store.observe({ ...first, state: 'completed', phase: 'start', phaseState: 'confirmed', updatedAt: 3 }), false);
  assert.equal(store.getSnapshot().operationId, nextId); assert.equal(store.getSnapshot().blocked, true);
});

test('explicit reconciliation posts only the original id and updates the same durable record without replay', async () => {
  const fake = fixture({ terminal: 'unknown' }); await assert.rejects(run(fake.api), /尚未确认/);
  const snapshot = chatApplicationStore(fake.api).getSnapshot().operation; assert(snapshot);
  const calls: string[] = [];
  const api: ApiClient = { get: fake.api.get, async post(path, body) {
    calls.push(path); assert.equal(path, '/api/chat/application/reconcile'); assert.deepEqual(body, { operationId: snapshot.id });
    return { schema: 1, operation: { ...snapshot, state: 'completed', phase: 'start', phaseState: 'confirmed', reasons: [], updatedAt: 3 } };
  } };
  chatApplicationStore(api).observe(snapshot);
  const { reconcileChatApplication } = await import('../web/lib/chat-application.ts');
  const result = await reconcileChatApplication(api, snapshot.id);
  assert.equal(result.state, 'completed'); assert.equal(chatApplicationStore(api).getSnapshot().blocked, false);
  assert.deepEqual(calls, ['/api/chat/application/reconcile']); assert.equal(fake.writes().length, 1);
});

test('manual deployment recovery requires a current successful read and explicit source-scoped acknowledgement', () => {
  const api: ApiClient = { get: async () => ({}), post: async () => ({}) };
  const store = chatApplicationStore(api);
  store.claim('manual', 'deployment'); store.freeze('deployment');
  assert.equal(store.acknowledgeManual(null, 'deployment'), false);
  assert.equal(store.reviewManual('runtime'), null);
  const verified = { verified: true, missingReasons: [], verificationScope: 'provider-preset-and-managed-file-provenance',
    credentialValueIdentityVerified: false, unverified: ['credential_loaded_value_identity'], presets: [{ agentPreset: 'chat:daily' }] };
  for (const partial of [{ revision: 'a'.repeat(64), deployment: {} }, { ...verified, verified: false },
    { ...verified, verificationScope: null }, { ...verified, presets: [] }, { ...verified, unverified: ['managed_file_provenance'] },
    { ...verified, missingReasons: ['pending_reload'] }]) assert.equal(store.reviewManual('deployment', partial), null);
  assert.equal(store.reviewManual('deployment'), null);
  const first = store.reviewManual('deployment', verified); assert(first);
  assert.equal(store.getSnapshot().blocked, true);
  assert.equal(store.reviewManual('deployment', { ...verified, verified: false }), null);
  assert.equal(store.acknowledgeManual(first, 'deployment'), false);
  store.freeze('deployment');
  assert.equal(store.acknowledgeManual(first, 'deployment'), false);
  const current = store.reviewManual('deployment', verified); assert(current);
  assert.equal(store.acknowledgeManual(current, 'runtime'), false);
  assert.equal(store.acknowledgeManual(current, 'deployment'), true);
  assert.equal(store.getSnapshot().blocked, false);
  store.claim('manual', 'runtime'); store.freeze();
  assert.equal(store.reviewManual('deployment'), null);
  assert.equal(store.getSnapshot().blocked, true);
  const applicationApi: ApiClient = { get: async () => ({}), post: async () => ({}) };
  const persistent = chatApplicationStore(applicationApi);
  persistent.claim('application'); persistent.freeze();
  assert.equal(persistent.reviewManual('deployment'), null);
});

test('only an explicit original-operation reconciliation can resume a stopped application snapshot', async () => {
  for (const originalState of ['unknown', 'blocked'] as const) {
    const original: NativeApplicationSnapshot = { schema: 1, id: '11111111-1111-4111-8111-111111111111', state: originalState,
      phase: 'apply', phaseState: 'confirmed', revisions, createdAt: 1, updatedAt: 2,
      reasons: [originalState === 'unknown' ? 'APPLICATION_DEPLOYMENT_UNCONFIRMED' : 'pending_reload'] };
    const resumed: NativeApplicationSnapshot = { ...original, state: 'running', updatedAt: 3, reasons: [] };
    const calls: string[] = [];
    const api: ApiClient = { async get(path) { calls.push(path); return { schema: 1, operation: resumed }; },
      async post(path, body) {
        calls.push(path); assert.equal(path, '/api/chat/application/reconcile'); assert.deepEqual(body, { operationId: original.id });
        return { schema: 1, operation: resumed };
      } };
    const store = chatApplicationStore(api);
    assert(store.observe(original)); assert(chatApplicationCanReconcile(store.getSnapshot()));
    assert.equal(store.observe(resumed), false);
    assert.equal(store.getSnapshot().operation?.state, originalState);
    assert.equal((await reconcileChatApplication(api, original.id)).state, 'running');
    assert.equal(store.getSnapshot().busy, true); assert.equal(store.getSnapshot().blocked, false);
    assert.equal(chatApplicationCanReconcile(store.getSnapshot()), false);
    assert.equal(store.observe({ ...original, updatedAt: 2 }), false);
    assert(store.observe({ ...resumed, state: 'completed', phase: 'start', phaseState: 'confirmed', updatedAt: 4 }));
    const token = store.claimReconciliation(original.id);
    assert.equal(store.observe({ ...resumed, phase: 'start', updatedAt: 5 }, token), false);
    store.release(token);
    assert.deepEqual(calls, ['/api/chat/application/reconcile']);
  }
});

test('pending reload cannot create a fresh application, while deterministic request rejection stays retryable', async () => {
  const pending: NativeApplicationSnapshot = { schema: 1, id: '11111111-1111-4111-8111-111111111111', state: 'blocked',
    phase: 'apply', phaseState: 'confirmed', revisions, createdAt: 1, updatedAt: 2, reasons: ['pending_reload'] };
  let writes = 0;
  const pendingApi: ApiClient = { async get(path) { return path === '/api/chat/runtime' ? status() : { schema: 1, operation: pending }; },
    async post() { writes++; throw new Error('must not create a second application'); } };
  await assert.rejects(run(pendingApi), /原操作标识/);
  assert.equal(writes, 0); assert(chatApplicationCanReconcile(chatApplicationStore(pendingApi).getSnapshot()));

  const rejectedApi: ApiClient = { async get(path) { return path === '/api/chat/runtime' ? status() : { schema: 1, operation: null }; },
    async post() { writes++; throw new ApiError('configuration_revision_conflict', 409); } };
  await assert.rejects(run(rejectedApi), /configuration_revision_conflict/);
  assert.equal(chatApplicationStore(rejectedApi).getSnapshot().blocked, false);
  assert.equal(chatApplicationStore(rejectedApi).getSnapshot().busy, false);
  assert.equal(chatApplicationStore(rejectedApi).getSnapshot().operationId, null);
  assert.equal(chatApplicationStore(rejectedApi).getSnapshot().kind, null);
  await assert.rejects(run(rejectedApi), /configuration_revision_conflict/);
  assert.equal(writes, 2);
});

test('a newer completed read wins over a delayed running reconciliation receipt without freezing', async () => {
  const original: NativeApplicationSnapshot = { schema: 1, id: '11111111-1111-4111-8111-111111111111', state: 'unknown',
    phase: 'apply', phaseState: 'confirmed', revisions, createdAt: 1, updatedAt: 2, reasons: ['APPLICATION_DEPLOYMENT_UNCONFIRMED'] };
  const running: NativeApplicationSnapshot = { ...original, state: 'running', phase: 'migrate', phaseState: 'in-flight', updatedAt: 3, reasons: [] };
  const completed: NativeApplicationSnapshot = { ...running, state: 'completed', phase: 'start', phaseState: 'confirmed', updatedAt: 4 };
  const api: ApiClient = { get: async () => ({}), async post(path) {
    assert.equal(path, '/api/chat/application/reconcile');
    assert(chatApplicationStore(api).observe(completed));
    return { schema: 1, operation: running };
  } };
  const store = chatApplicationStore(api); store.observe(original);
  assert.deepEqual(await reconcileChatApplication(api, original.id), completed);
  assert.equal(store.getSnapshot().blocked, false); assert.equal(store.getSnapshot().busy, false);
  assert.equal(store.getSnapshot().operation?.state, 'completed');
});
