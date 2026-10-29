import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createNativeApplicationCoordinator, type NativeApplicationPorts, type NativeApplicationRuntimeStatus } from '../src/host/native-application.ts';
import { createNativeApplicationStorage } from '../src/storage/native-application.ts';
import type { NativeApplicationRequest } from '../src/contracts/native-application.ts';
import type { NativeConfigurationRevisions } from '../src/contracts/native-revisions.ts';

const revisions: NativeConfigurationRevisions = { plans: '1'.repeat(64), personas: '2'.repeat(64), access: '3'.repeat(64),
  adapters: '4'.repeat(64), providers: '5'.repeat(64), authorization: '6'.repeat(64), deployment: '7'.repeat(64), execution: '8'.repeat(64) };
function fixture() {
  const calls: string[] = [];
  let current: NativeApplicationRuntimeStatus = { state: 'running', canStart: false, canApplyDeployment: false,
    chatReady: true, revisions, missingReasons: [], configurationCompatibility: { state: 'compatible' } };
  const ports: NativeApplicationPorts = {
    async status() { return current; },
    async stop() { calls.push('stop'); current = { ...current, state: 'stopped', canStart: true, canApplyDeployment: true, chatReady: false }; return current; },
    async prepare() { calls.push('prepare'); current = { ...current, revisions: { ...revisions, deployment: 'a'.repeat(64) } };
      return { revisions: current.revisions, prepared: { state: 'prepared', targetRevision: 'b'.repeat(64), summary: { ready: true, missingReasons: [] }, preview: null } }; },
    async apply() { calls.push('apply'); return { state: 'verified', backupId: 'backup-1', missingReasons: [] }; },
    async reconcileDeployment() { calls.push('reconcile-deployment'); return { missingReasons: [],
      verificationScope: 'provider-preset-and-managed-file-provenance', credentialValueIdentityVerified: false,
      presetBindings: [{ agentPreset: 'synthetic-preset', definition: { planId: 'synthetic-plan', personaId: 'synthetic-persona',
        instructions: 'Be concise.', persona: { identity: 'Synthetic.', style: 'Concise.' },
        model: { provider: 'synthetic-provider', name: 'synthetic-model', reasoningEffort: 'off' } } }] }; },
    async previewMigration() { throw new Error('Unexpected migration'); },
    async migrate() { throw new Error('Unexpected migration'); },
    async start(expected) { calls.push('start'); assert.deepEqual(expected, current.revisions);
      current = { ...current, state: 'running', canStart: false, canApplyDeployment: false, chatReady: true }; return current; },
  };
  return { calls, ports, setStatus(next: Partial<NativeApplicationRuntimeStatus>) { current = { ...current, ...next }; } };
}
async function directory(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-application-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

test('durable application persists phases, applies revised deployment and deduplicates the same explicit intent', async t => {
  const root = await directory(t); const f = fixture(); const storage = createNativeApplicationStorage(root);
  const coordinator = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal });
  assert.equal(await coordinator.read(), null);
  const request: NativeApplicationRequest = { operationId: randomUUID(), revisions, deploy: true };
  assert.equal((await coordinator.create(request)).state, 'running');
  await coordinator.drain();
  const result = await coordinator.read(request.operationId);
  assert.equal(result?.state, 'completed'); assert.equal(result?.revisions.deployment, 'a'.repeat(64));
  assert.deepEqual(f.calls, ['stop', 'prepare', 'apply', 'start']);
  assert.deepEqual(await coordinator.create(request), result);
  assert.deepEqual(f.calls, ['stop', 'prepare', 'apply', 'start']);
  await assert.rejects(coordinator.create({ ...request, deploy: false }), { code: 'APPLICATION_ID_CONFLICT' });
  assert.equal((await stat(join(root, 'native-application.json'))).mode & 0o777, 0o600);
  const reopened = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal });
  assert.deepEqual(await reopened.read(), result);
});

test('unknown start remains durable across reconstruction and no later intent replays it', async t => {
  const storage = createNativeApplicationStorage(await directory(t)); const f = fixture();
  f.ports.start = async () => { f.calls.push('start'); throw new Error('Connection ended after start'); };
  const coordinator = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal });
  const request = { operationId: randomUUID(), revisions, deploy: false };
  await coordinator.create(request); await coordinator.drain();
  assert.equal((await coordinator.read())?.state, 'unknown');
  const reopened = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal });
  assert.equal((await reopened.create(request)).state, 'unknown');
  await assert.rejects(reopened.create({ ...request, operationId: randomUUID() }), { code: 'APPLICATION_RECONCILIATION_REQUIRED' });
  assert.deepEqual(f.calls, ['stop', 'start']);
});

test('accepted job is independent of callers and coordinator closure aborts phase without late continuation', async t => {
  const storage = createNativeApplicationStorage(await directory(t)); const f = fixture();
  const lifetime = new AbortController(); let release: (() => void) | undefined; let entered: (() => void) | undefined;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const stop = f.ports.stop;
  f.ports.stop = async signal => { entered!(); await waiting; return stop(signal); };
  const coordinator = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: lifetime.signal });
  await coordinator.create({ operationId: randomUUID(), revisions, deploy: true }); await entering;
  const interrupted = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal });
  assert.deepEqual((await interrupted.read())?.reasons, ['application_process_interrupted']);
  lifetime.abort(); await coordinator.drain(); assert.equal((await coordinator.read())?.state, 'unknown');
  release!(); await waiting; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ['stop']); assert.equal((await coordinator.read())?.state, 'unknown');
});

test('revision conflict produces no write or effect; read missing history does not create a journal', async t => {
  const root = await directory(t); const f = fixture(); const storage = createNativeApplicationStorage(root);
  const coordinator = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal });
  assert.equal(await coordinator.read(), null);
  await assert.rejects(readFile(join(root, 'native-application.json')), { code: 'ENOENT' });
  await assert.rejects(coordinator.create({ operationId: randomUUID(), revisions: { ...revisions, plans: 'e'.repeat(64) }, deploy: false }),
    { code: 'APPLICATION_CONFIGURATION_CHANGED' });
  assert.deepEqual(f.calls, []); assert.equal(await coordinator.read(), null);
});

test('explicit reconciliation verifies a lost start result using read-only state and never replays effects', async t => {
  const storage = createNativeApplicationStorage(await directory(t)); const f = fixture();
  const start = f.ports.start;
  f.ports.start = async (revisions, signal) => { await start(revisions, signal); throw new Error('lost acknowledgement'); };
  const coordinator = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal });
  const operationId = randomUUID(); await coordinator.create({ operationId, revisions, deploy: false }); await coordinator.drain();
  assert.equal((await coordinator.read())?.state, 'unknown');
  const reopened = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal });
  assert.equal((await reopened.reconcile(operationId)).state, 'completed');
  assert.deepEqual(f.calls, ['stop', 'start']);
  assert.equal((await storage.read()).value.records[0]?.snapshot.state, 'completed');
});

test('parallel journal observation tolerates atomic replacement without misclassifying detached old inodes as corruption', async t => {
  const storage = createNativeApplicationStorage(await directory(t));
  let current = await storage.read(); const id = randomUUID();
  const base = { schema: 1 as const, records: [{ instanceId: 'test-instance', request: { operationId: id, revisions, deploy: false },
    snapshot: { schema: 1 as const, id, state: 'running' as const, phase: null, phaseState: 'pending' as const,
      revisions, createdAt: 1, updatedAt: 1, reasons: [] } }] };
  current = await storage.write(current.revision, base);
  const writes = (async () => {
    for (let index = 0; index < 30; index++) {
      current = await storage.write(current.revision, { ...base, records: [{ ...base.records[0]!,
        snapshot: { ...base.records[0]!.snapshot, updatedAt: index + 2 } }] });
    }
  })();
  const reads = Array.from({ length: 6 }, async () => {
    for (let index = 0; index < 100; index++) {
      try { assert.equal((await storage.read()).value.records[0]?.snapshot.id, id); }
      catch (error) { assert(error instanceof Error && 'code' in error && error.code === 'application_revision_conflict'); }
    }
  });
  await Promise.all([writes, ...reads]);
  assert.equal((await storage.read()).value.records[0]?.snapshot.updatedAt, 31);
});

test('a normal pending reload waits for observed deployment and finishes the same intent without another apply', async t => {
  const storage = createNativeApplicationStorage(await directory(t)); const f = fixture();
  f.ports.apply = async () => { f.calls.push('apply'); return { state: 'pending_reload', backupId: 'backup', missingReasons: ['pending_reload'] }; };
  const verify = f.ports.reconcileDeployment; let observations = 0;
  f.ports.reconcileDeployment = async (expected, signal) => {
    assert.equal(expected.deployment, 'a'.repeat(64));
    if (++observations === 1) {
      const operation = (await storage.read()).value.records[0]?.snapshot;
      assert(operation); assert.equal(operation.state, 'running'); assert.deepEqual(operation.reasons, ['pending_reload']);
      return { missingReasons: ['pending_reload'], presetBindings: [] };
    }
    return verify(expected, signal);
  };
  const coordinator = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal,
    deploymentVerificationTimeoutMs: 2000, deploymentPollIntervalMs: 1 });
  const request = { operationId: randomUUID(), revisions, deploy: true };
  await coordinator.create(request); await coordinator.drain();
  assert.equal((await coordinator.read(request.operationId))?.state, 'completed');
  assert.equal(observations, 2); assert.deepEqual(f.calls, ['stop', 'prepare', 'apply', 'reconcile-deployment', 'start']);
});

test('reload observation expires as pending, blocks replacement intents and resumes only after explicit proof on the same id', async t => {
  const storage = createNativeApplicationStorage(await directory(t)); const f = fixture();
  f.ports.apply = async () => { f.calls.push('apply'); return { state: 'pending_reload', backupId: 'backup', missingReasons: ['pending_reload'] }; };
  const verify = f.ports.reconcileDeployment;
  f.ports.reconcileDeployment = async () => ({ missingReasons: ['pending_reload'], presetBindings: [] });
  const coordinator = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal,
    deploymentVerificationTimeoutMs: 20, deploymentPollIntervalMs: 1 });
  const request = { operationId: randomUUID(), revisions, deploy: true };
  await coordinator.create(request); await coordinator.drain();
  const pending = await coordinator.read();
  assert.equal(pending?.state, 'blocked'); assert.equal(pending?.phase, 'apply'); assert.equal(pending?.phaseState, 'confirmed');
  assert.deepEqual(pending?.reasons, ['pending_reload']);
  await assert.rejects(coordinator.create({ ...request, operationId: randomUUID() }), { code: 'APPLICATION_RECONCILIATION_REQUIRED' });
  assert.deepEqual(await coordinator.reconcile(request.operationId), pending);
  assert.deepEqual(f.calls, ['stop', 'prepare', 'apply']);
  const observed = await storage.read();
  assert.deepEqual(await coordinator.read(), pending);
  assert.equal((await storage.read()).revision, observed.revision);
  f.ports.reconcileDeployment = verify;
  const start = f.ports.start;
  let release: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  t.after(() => { release?.(); });
  f.ports.start = async (expected, signal) => { await waiting; return start(expected, signal); };
  const continued = await coordinator.reconcile(request.operationId);
  assert.equal(continued.id, request.operationId); assert.equal(continued.state, 'running');
  assert.equal((await coordinator.read())?.state, 'running');
  await assert.rejects(coordinator.reconcile(request.operationId), { code: 'APPLICATION_BUSY' });
  release!();
  await coordinator.drain();
  assert.equal((await coordinator.read())?.state, 'completed');
  assert.deepEqual(f.calls, ['stop', 'prepare', 'apply', 'reconcile-deployment', 'start']);
  assert.equal((await storage.read()).value.records.length, 1);
});

test('old unknown apply resumes with prepared revisions and retains existing sessions without migration', async t => {
  const storage = createNativeApplicationStorage(await directory(t)); const f = fixture();
  const preparedRevisions = { ...revisions, deployment: 'a'.repeat(64) };
  f.setStatus({ state: 'stopped', chatReady: false, canStart: false, canApplyDeployment: true,
    revisions: preparedRevisions, configurationCompatibility: { state: 'blocked' } });
  const id = randomUUID();
  const reconcile = f.ports.reconcileDeployment;
  f.ports.reconcileDeployment = async (...args) => {
    const verified = await reconcile(...args);
    f.setStatus({ canStart: true, configurationCompatibility: { state: 'compatible' } });
    return verified;
  };
  const prior = await storage.read();
  await storage.write(prior.revision, { schema: 1, records: [{ instanceId: 'old-instance', request: { operationId: id, revisions, deploy: true },
    snapshot: { schema: 1, id, state: 'unknown', phase: 'apply', phaseState: 'in-flight', revisions: preparedRevisions,
      createdAt: 1, updatedAt: 1, reasons: ['APPLICATION_DEPLOYMENT_UNCONFIRMED'] } }] });
  const coordinator = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal });
  assert.equal((await coordinator.read())?.phaseState, 'in-flight');
  assert.equal((await coordinator.reconcile(id)).state, 'running'); await coordinator.drain();
  assert.equal((await coordinator.read())?.state, 'completed');
  assert.deepEqual(f.calls, ['reconcile-deployment', 'start']);
  assert.deepEqual((await storage.read()).value.records[0]?.request.revisions, revisions);
  assert.equal((await coordinator.reconcile(id)).state, 'completed');
  assert.deepEqual(f.calls, ['reconcile-deployment', 'start']);
});

test('unknown apply stays unknown without matching configuration and complete deployment proof', async t => {
  const storage = createNativeApplicationStorage(await directory(t)); const f = fixture();
  f.ports.apply = async () => { f.calls.push('apply'); return { state: 'unknown', missingReasons: ['deployment_write_unknown'] }; };
  const coordinator = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal });
  const id = randomUUID(); await coordinator.create({ operationId: id, revisions, deploy: true }); await coordinator.drain();
  const unknown = await coordinator.read(); assert(unknown); assert.equal(unknown.state, 'unknown');
  assert.deepEqual(unknown.reasons, ['deployment_write_unknown']);
  const verify = f.ports.reconcileDeployment;
  const proof = await verify({ ...revisions, deployment: 'a'.repeat(64) }, new AbortController().signal);
  f.calls.pop();
  for (const incomplete of [{ ...proof, presetBindings: [] }, { ...proof, verificationScope: undefined },
    { ...proof, missingReasons: ['pending_reload'] }]) {
    f.ports.reconcileDeployment = async () => incomplete;
    assert.deepEqual(await coordinator.reconcile(id), unknown);
  }
  f.ports.reconcileDeployment = async () => {
    f.setStatus({ revisions: { ...revisions, deployment: 'a'.repeat(64), access: 'f'.repeat(64) } });
    return proof;
  };
  assert.deepEqual(await coordinator.reconcile(id), unknown);
  f.ports.reconcileDeployment = verify;
  f.setStatus({ revisions: { ...revisions, plans: 'f'.repeat(64) } });
  assert.deepEqual(await coordinator.reconcile(id), unknown);
  assert.deepEqual(f.calls, ['stop', 'prepare', 'apply']);
});

test('cancelled reload observation leaves unknown evidence and cannot start or apply a second time', async t => {
  const storage = createNativeApplicationStorage(await directory(t)); const f = fixture(); const lifetime = new AbortController();
  f.ports.apply = async () => { f.calls.push('apply'); return { state: 'pending_reload', backupId: 'backup', missingReasons: ['pending_reload'] }; };
  f.ports.reconcileDeployment = async () => { lifetime.abort(); return { missingReasons: ['pending_reload'], presetBindings: [] }; };
  const coordinator = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: lifetime.signal });
  await coordinator.create({ operationId: randomUUID(), revisions, deploy: true }); await coordinator.drain();
  assert.equal((await coordinator.read())?.state, 'unknown');
  assert.deepEqual(f.calls, ['stop', 'prepare', 'apply']);
});

test('quiescent stopped and preparation intents can finish across safe version changes without rewriting old evidence', async t => {
  for (const phase of [null, 'stop', 'prepare'] as const) {
    const storage = createNativeApplicationStorage(await directory(t)); const f = fixture();
    const latest = { ...revisions, [phase === 'prepare' ? 'deployment' : 'plans']: 'd'.repeat(64) };
    f.setStatus({ state: 'stopped', canApplyDeployment: true, canStart: true, chatReady: false, revisions: latest, quiescent: true });
    const id = randomUUID(); const prior = await storage.read();
    await storage.write(prior.revision, { schema: 1, records: [{ instanceId: 'old-instance', request: { operationId: id, revisions, deploy: true },
      snapshot: { schema: 1, id, state: 'unknown', phase, phaseState: 'in-flight', revisions, createdAt: 1, updatedAt: 1, reasons: ['APPLICATION_PHASE_UNKNOWN'] } }] });
    const coordinator = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal });
    const settled = await coordinator.reconcile(id);
    assert.equal(settled.state, 'blocked'); assert.deepEqual(settled.revisions, revisions);
    assert.deepEqual(settled.reasons, [phase === 'prepare' ? 'application_preparation_saved_new_intent_required' : 'application_stopped_verified_new_intent_required']);
    assert.deepEqual(f.calls, []);
    await coordinator.create({ operationId: randomUUID(), revisions: latest, deploy: false }); await coordinator.drain();
    assert.equal((await coordinator.read())?.state, 'completed'); assert.deepEqual(f.calls, ['start']);
  }
});

test('same-version stopped evidence never bypasses quiescence and preparation cannot retire an unrelated changed intent', async t => {
  for (const phase of [null, 'stop', 'prepare'] as const) {
    const storage = createNativeApplicationStorage(await directory(t)); const f = fixture();
    f.setStatus({ state: 'stopped', canApplyDeployment: true, canStart: true, chatReady: false, quiescent: false });
    const id = randomUUID(); const prior = await storage.read();
    await storage.write(prior.revision, { schema: 1, records: [{ instanceId: 'old-instance', request: { operationId: id, revisions, deploy: true },
      snapshot: { schema: 1, id, state: 'unknown', phase, phaseState: 'confirmed', revisions, createdAt: 1, updatedAt: 1, reasons: ['APPLICATION_PHASE_UNKNOWN'] } }] });
    const coordinator = createNativeApplicationCoordinator({ storage, ports: f.ports, signal: new AbortController().signal });
    assert.equal((await coordinator.reconcile(id)).state, 'unknown');
    if (phase === 'prepare') {
      f.setStatus({ quiescent: true, revisions: { ...revisions, plans: 'e'.repeat(64) } });
      assert.equal((await coordinator.reconcile(id)).state, 'unknown');
    }
    assert.deepEqual(f.calls, []);
  }
});
