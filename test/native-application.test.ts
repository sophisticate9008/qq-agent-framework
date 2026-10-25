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
    async previewMigration() { throw new Error('Unexpected migration'); },
    async migrate() { throw new Error('Unexpected migration'); },
    async start(expected) { calls.push('start'); assert.deepEqual(expected, current.revisions);
      current = { ...current, state: 'running', canStart: false, canApplyDeployment: false, chatReady: true }; return current; },
  };
  return { calls, ports, setStatus(next: Partial<NativeApplicationRuntimeStatus>) { current = { ...current, ...next }; } };
}
async function directory(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'qaf-application-'));
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
