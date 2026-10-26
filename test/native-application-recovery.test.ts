import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNativeChatRuntime } from '../src/host/native-chat-runtime.ts'
import { NativeConfigurationRepository } from '../src/admin/native-configuration-repository.ts'
import { restoreNativeChatRunningIntent } from '../src/admin/runtime.ts'
import { createNativeApplicationStorage } from '../src/storage/native-application.ts'
import { isNativeConfigurationRevisions } from '../src/contracts/native-revisions.ts'
import { createNativeDshRestartStorage } from '../src/storage/native-dsh-restart.ts'

for (const state of ['running', 'unknown', 'blocked'] as const) {
  test(`actual running-intent restoration blocks ${state} application evidence before any runtime status or start`, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'native-application-restore-'))
    const repository = new NativeConfigurationRepository(directory)
    const configuration = await repository.read()
    assert(isNativeConfigurationRevisions(configuration.revisions))
    const previous = await repository.readRunningIntent()
    await repository.writeRunningIntent(previous.revision,
      { schema: 1, desiredRunning: true, revisions: configuration.revisions, updatedAt: 1 })
    const runtime = createNativeChatRuntime({ directory, loadConfiguration: () => repository.read(),
      resolveDeployment: async () => ({ missingReasons: [], presetBindings: [] }) })
    context.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
    let starts = 0
    let statuses = 0
    const observed = new Proxy({ ...runtime }, { get(target, property, receiver) {
      if (property === 'start') return async () => { starts++; throw new Error('Restoration must stay blocked') }
      if (property === 'status') return async () => { statuses++; return target.status() }
      return Reflect.get(target, property, receiver)
    } })
    const storage = createNativeApplicationStorage(directory)
    const current = await storage.read()
    const id = randomUUID()
    const journal = { schema: 1 as const, records: [{ instanceId: 'old-process',
      request: { operationId: id, revisions: configuration.revisions, deploy: true },
      snapshot: { schema: 1 as const, id, state, phase: 'apply' as const, phaseState: 'in-flight' as const,
        revisions: configuration.revisions, createdAt: 1, updatedAt: 1, reasons: state === 'blocked' ? ['pending_reload'] : [] } }] }
    const saved = await storage.write(current.revision, journal)
    const bytes = await readFile(join(directory, 'native-application.json'))
    const files = await readdir(directory)
    await assert.rejects(restoreNativeChatRunningIntent(directory, observed, new AbortController().signal),
      { code: 'NATIVE_APPLICATION_RECONCILIATION_REQUIRED' })
    assert.equal(starts, 0)
    assert.equal(statuses, 0)
    assert.deepEqual(await readFile(join(directory, 'native-application.json')), bytes)
    assert.deepEqual(await readdir(directory), files)
    assert.equal((await repository.readRunningIntent()).value.desiredRunning, true)
    await storage.write(saved.revision, { schema: 1, records: journal.records.map(record => ({ ...record,
      snapshot: { ...record.snapshot, state: 'completed', phase: 'start', phaseState: 'confirmed', reasons: [] } })) })
    const result = await restoreNativeChatRunningIntent(directory, observed, new AbortController().signal)
    assert.equal(result.state, 'skipped')
    assert.equal(statuses > 0, true)
    assert.equal(starts, 0)
  })
}

for (const state of ['running', 'unknown'] as const) {
  test(`actual running-intent restoration blocks ${state} DSH maintenance without starting protocol or chat`, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'native-dsh-restore-'))
    const repository = new NativeConfigurationRepository(directory); const configuration = await repository.read()
    assert(isNativeConfigurationRevisions(configuration.revisions))
    const runtime = createNativeChatRuntime({ directory, loadConfiguration: () => repository.read(),
      resolveDeployment: async () => ({ missingReasons: [], presetBindings: [] }) })
    context.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
    const storage = createNativeDshRestartStorage(directory); const prior = await storage.read()
    await storage.write(prior.revision, { schema: 1, records: [{ instanceId: 'old-instance', targetIdentity: 'a'.repeat(64),
      operation: { schema: 1, id: randomUUID(), state, phase: 'restart', phaseState: 'in-flight', revisions: configuration.revisions,
        wasRunning: true, restartExecutionVerified: false, createdAt: 1, updatedAt: 1, reasons: [] } }] })
    await assert.rejects(restoreNativeChatRunningIntent(directory, runtime, new AbortController().signal),
      { code: 'NATIVE_DSH_RESTART_RECONCILIATION_REQUIRED' })
    assert.equal(runtime.activity().state, 'stopped')
    assert.equal((await storage.read()).value.records[0]?.operation.state, state)
  })
}
