import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { FrameworkError } from '../src/core/values.ts'
import { NativeConfigurationRepository } from '../src/admin/native-configuration-repository.ts'
import { createNativeDshRestartService, type NativeDshRestartPorts } from '../src/host/native-dsh-restart.ts'
import { createNativeDshRestartStorage } from '../src/storage/native-dsh-restart.ts'
import { nativeRuntimeIsQuiescent } from '../src/contracts/native-runtime-quiescence.ts'
import { isNativeConfigurationRevisions } from '../src/contracts/native-revisions.ts'
import { parseNativeDshRestartSnapshot, parseNativeDshRestartRequest } from '../src/contracts/native-dsh-restart.ts'

async function fixture(t: TestContext, timeoutMs = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'native-dsh-maintenance-'))
  const configuration = await new NativeConfigurationRepository(directory).read()
  assert(isNativeConfigurationRevisions(configuration.revisions))
  const revisions = configuration.revisions
  const lifetime = new AbortController()
  const calls: string[] = []
  let state = 'running'
  let pendingRaw = 0
  const status = () => ({ state, canApplyDeployment: state === 'stopped', chatReady: state === 'running', revisions,
    activeRevisions: revisions, lifecycleHooks: { manager: { pendingRaw: 0 }, chat: { pendingRaw: 0 } },
    controlCommands: { pendingRaw, inflight: 0 }, packages: [], bootstrap: null, execution: { metrics: null }, host: null })
  const ports: NativeDshRestartPorts = {
    configuration: async () => configuration, status: async () => status(), inspect: async () => 'a'.repeat(64),
    async assertExclusive() {},
    async stop() { calls.push('stop'); state = 'stopped' },
    async restart() { calls.push('restart') },
    async verify() { calls.push('verify') },
    async restore(expected, wasRunning) { calls.push('restore'); assert.deepEqual(expected, revisions); if (wasRunning) state = 'running' },
  }
  const service = createNativeDshRestartService({ directory, ports, signal: lifetime.signal, timeoutMs })
  t.after(async () => { lifetime.abort(); await service.drain(); await rm(directory, { recursive: true, force: true }) })
  return { directory, lifetime, calls, ports, revisions, service, status,
    state: (next: string) => { state = next }, pending: (next: number) => { pendingRaw = next } }
}

test('one explicit local restart drains, restarts, verifies and restores with durable idempotency and read-only GET', async t => {
  const f = await fixture(t)
  assert.equal((await f.service.read()).operation, null)
  assert.deepEqual(f.calls, [])
  await assert.rejects(readFile(join(f.directory, 'native-dsh-restart.json')), { code: 'ENOENT' })
  const request = { operationId: randomUUID(), revisions: f.revisions }
  assert.equal((await f.service.create(request)).operation?.state, 'running')
  await f.service.drain()
  const completed = await f.service.read(request.operationId)
  assert(parseNativeDshRestartSnapshot(completed))
  assert.equal(completed.operation?.state, 'completed')
  assert.equal(completed.operation?.restartExecutionVerified, true)
  assert.deepEqual(f.calls, ['stop', 'restart', 'verify', 'restore'])
  assert.deepEqual(await f.service.create(request), completed)
  await assert.rejects(f.service.create({ ...request, revisions: { ...f.revisions, plans: 'f'.repeat(64) } }), { code: 'DSH_RESTART_ID_CONFLICT' })
  assert.deepEqual(f.calls, ['stop', 'restart', 'verify', 'restore'])
  assert.equal(await f.service.unresolved(), false)
  assert.equal(parseNativeDshRestartRequest({ ...request, command: 'anything' }), null)
  assert.equal(parseNativeDshRestartRequest({ ...request, manager: '/browser/path' }), null)
})

test('remote/unconfigured managers and another active account reject before stopping or creating maintenance', async t => {
  for (const code of ['LOCAL_DSH_RESTART_NOT_CONFIGURED', 'LOCAL_DSH_RESTART_UNAVAILABLE', 'DSH_RESTART_SHARED_RUNTIME_ACTIVE']) {
    const f = await fixture(t)
    const deny = async () => { throw new FrameworkError(code, 'Synthetic preflight denial') }
    if (code.includes('SHARED')) f.ports.assertExclusive = deny
    else f.ports.inspect = deny
    const view = await f.service.read()
    assert.equal(view.available, false); assert.deepEqual(view.missingReasons, [code])
    await assert.rejects(f.service.create({ operationId: randomUUID(), revisions: f.revisions }), { code })
    assert.deepEqual(f.calls, [])
    await assert.rejects(readFile(join(f.directory, 'native-dsh-restart.json')), { code: 'ENOENT' })
  }
})

test('unsettled control effects forbid the real restart and cannot be cleared by retained active revisions', async t => {
  const f = await fixture(t); f.pending(1)
  const id = randomUUID(); await f.service.create({ operationId: id, revisions: f.revisions }); await f.service.drain()
  assert.equal((await f.service.read()).operation?.state, 'unknown')
  assert.deepEqual(f.calls, ['stop']); assert.equal(nativeRuntimeIsQuiescent(f.status()), false)
  await assert.rejects(f.service.reconcile(id), { code: 'DSH_RESTART_NOT_QUIESCENT' })
  assert.equal(await f.service.unresolved(), true)
  f.pending(0); assert.equal(nativeRuntimeIsQuiescent(f.status()), true, 'A stopped runtime may retain activeRevisions')
  assert.equal((await f.service.reconcile(id)).operation?.state, 'blocked')
  assert.deepEqual(f.calls, ['stop', 'verify'])
})

test('a lost restart acknowledgement can restore the same intent but never claims a confirmed restart or repeats its command', async t => {
  const f = await fixture(t)
  f.ports.restart = async () => { f.calls.push('restart'); throw new Error('Synthetic lost process acknowledgement') }
  const request = { operationId: randomUUID(), revisions: f.revisions }
  await f.service.create(request); await f.service.drain()
  assert.equal((await f.service.read()).operation?.state, 'unknown')
  const reopened = createNativeDshRestartService({ directory: f.directory, ports: f.ports, signal: f.lifetime.signal })
  await assert.rejects(reopened.create({ ...request, operationId: randomUUID() }), { code: 'DSH_RESTART_RECONCILIATION_REQUIRED' })
  assert.equal((await reopened.reconcile(request.operationId)).operation?.state, 'running')
  await reopened.drain()
  const result = (await reopened.read()).operation
  assert.equal(result?.state, 'completed'); assert.equal(result?.restartExecutionVerified, false)
  assert.equal(f.calls.filter(call => call === 'restart').length, 1)
  assert.equal(f.status().state, 'running')
})

test('a lost restore acknowledgement is confirmed from actual running and active revisions without another restore', async t => {
  const f = await fixture(t); const restore = f.ports.restore
  f.ports.restore = async (...args) => { await restore(...args); throw new Error('Synthetic lost restore acknowledgement') }
  const request = { operationId: randomUUID(), revisions: f.revisions }
  await f.service.create(request); await f.service.drain()
  assert.equal((await f.service.read()).operation?.state, 'unknown')
  assert.equal((await f.service.reconcile(request.operationId)).operation?.state, 'completed')
  assert.deepEqual(f.calls, ['stop', 'restart', 'verify', 'restore', 'verify'])
})

test('a stopped service stays stopped and parallel admissions cannot run two restart commands', async t => {
  const f = await fixture(t); f.state('stopped')
  const request = { operationId: randomUUID(), revisions: f.revisions }
  const first = f.service.create(request)
  await assert.rejects(f.service.create({ ...request, operationId: randomUUID() }), { code: 'DSH_RESTART_BUSY' })
  await first; await f.service.drain()
  assert.equal(f.status().state, 'stopped'); assert.equal((await f.service.read()).operation?.wasRunning, false)
  assert.equal(f.calls.filter(call => call === 'restart').length, 1)
})

test('bounded terminal compaction retains idempotency tombstones instead of exhausting restart history', async t => {
  const f = await fixture(t); const storage = createNativeDshRestartStorage(f.directory)
  const request = { operationId: randomUUID(), revisions: f.revisions }
  await f.service.create(request); await f.service.drain()
  const prior = await storage.read(); const base = prior.value.records[0]!
  const records = Array.from({ length: 128 }, (_, index) => ({ ...base,
    operation: { ...base.operation, id: index === 0 ? request.operationId : randomUUID() } }))
  await storage.write(prior.revision, { schema: 1, records })
  await f.service.create({ ...request, operationId: randomUUID() }); await f.service.drain()
  const current = await storage.read()
  assert.equal(current.value.records.length, 32); assert.equal(current.value.retired?.length, 97)
  await assert.rejects(f.service.create(request), { code: 'DSH_RESTART_OPERATION_RETIRED' })
  assert.equal(f.calls.filter(call => call === 'restart').length, 2)
})

test('explicit missing-request reconciliation retires the id so a delayed POST cannot execute it', async t => {
  const f = await fixture(t); const id = randomUUID()
  assert.equal((await f.service.read(id)).operation, null)
  await assert.rejects(f.service.reconcile(id), { code: 'DSH_RESTART_NOT_RECEIVED' })
  await assert.rejects(f.service.create({ operationId: id, revisions: f.revisions }), { code: 'DSH_RESTART_OPERATION_RETIRED' })
  assert.equal(await f.service.unresolved(), false)
  await f.service.create({ operationId: randomUUID(), revisions: f.revisions }); await f.service.drain()
  assert.equal(f.calls.filter(call => call === 'restart').length, 1)
})

test('an unsettled restart times out once, retains its raw gate and ignores late success until explicit reconciliation', async t => {
  const f = await fixture(t, 2000)
  let release: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { release = resolve })
  t.after(() => { release?.() })
  f.ports.restart = async () => { f.calls.push('restart'); await waiting }
  const id = randomUUID(); await f.service.create({ operationId: id, revisions: f.revisions }); await f.service.drain()
  assert.equal((await f.service.read(id)).operation?.state, 'unknown')
  assert.equal(await f.service.unresolved(), true)
  await assert.rejects(f.service.reconcile(id), { code: 'DSH_RESTART_BUSY' })
  release!(); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls, ['stop', 'restart'])
  assert.equal((await f.service.read(id)).operation?.state, 'unknown')
  assert.equal((await f.service.reconcile(id)).operation?.state, 'running'); await f.service.drain()
  assert.equal((await f.service.read(id)).operation?.state, 'completed')
  assert.equal((await f.service.read(id)).operation?.restartExecutionVerified, false)
  assert.equal(f.calls.filter(call => call === 'restart').length, 1)
})
