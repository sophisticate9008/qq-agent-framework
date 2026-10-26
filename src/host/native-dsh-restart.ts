import { randomUUID } from 'node:crypto'
import { assert, errorCode, snapshot } from '../core/values.ts'
import { nativeRuntimeIsQuiescent } from '../contracts/native-runtime-quiescence.ts'
import { parseNativeDshRestartRequest, type NativeDshRestartOperation, type NativeDshRestartSnapshot } from '../contracts/native-dsh-restart.ts'
import type { NativeConfigurationRevisions } from '../contracts/native-revisions.ts'
import { createNativeDshRestartStorage, type NativeDshRestartRecord } from '../storage/native-dsh-restart.ts'
import type { NativeChatConfiguration } from './native-chat-configuration.ts'
import { withDeadline } from './deadlines.ts'
import { digest } from './data.ts'

export interface NativeDshRestartPorts {
  configuration(): Promise<NativeChatConfiguration>
  status(): Promise<unknown>
  inspect(configuration: NativeChatConfiguration, signal: AbortSignal): Promise<string>
  assertExclusive(configuration: NativeChatConfiguration, signal: AbortSignal): Promise<void>
  stop(signal: AbortSignal): Promise<void>
  restart(configuration: NativeChatConfiguration, signal: AbortSignal): Promise<void>
  verify(configuration: NativeChatConfiguration, signal: AbortSignal): Promise<void>
  restore(revisions: NativeConfigurationRevisions, wasRunning: boolean, signal: AbortSignal): Promise<void>
}
export function createNativeDshRestartService(options: {
  readonly directory: string
  readonly ports: NativeDshRestartPorts
  readonly signal: AbortSignal
  readonly timeoutMs?: number
}) {
  const storage = createNativeDshRestartStorage(options.directory)
  const instanceId = randomUUID()
  const timeoutMs = options.timeoutMs ?? 240_000
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 300_000, 'DSH_RESTART_TIMEOUT_INVALID', 'A bounded maintenance deadline is required.')
  let active: Promise<void> | undefined
  let admitting = false
  let pendingRaw = 0
  let volatileUnknown: NativeDshRestartOperation | undefined
  const project = (record: NativeDshRestartRecord) => volatileUnknown?.id === record.operation.id ? volatileUnknown
    : record.operation.state === 'running' && record.instanceId !== instanceId
      ? { ...record.operation, state: 'unknown' as const, reasons: ['dsh_restart_process_interrupted'] } : record.operation
  async function update(id: string, patch: Partial<NativeDshRestartOperation>) {
    const prior = await storage.read()
    const record = prior.value.records.find(record => record.operation.id === id)
    assert(record?.instanceId === instanceId, 'DSH_RESTART_OWNERSHIP_CHANGED', 'Maintenance ownership changed.')
    const next = { ...record.operation, ...patch, updatedAt: Date.now() }
    try { await storage.write(prior.revision, { ...prior.value, records: prior.value.records.map(item => item.operation.id === id ? { ...record, operation: next } : item) }) }
    catch (error) { volatileUnknown = { ...next, state: 'unknown', reasons: ['dsh_restart_journal_unknown'] }; throw error }
    return next
  }
  async function checkedConfiguration(expected: NativeConfigurationRevisions, signal: AbortSignal) {
    signal.throwIfAborted()
    const configuration = await options.ports.configuration()
    assert(digest(configuration.revisions) === digest(expected), 'DSH_RESTART_CONFIGURATION_CHANGED', 'Saved settings changed during maintenance.')
    return configuration
  }
  async function run(record: NativeDshRestartRecord, continuing = false) {
    const { id, revisions, wasRunning } = record.operation
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    let sideEffect = continuing
    async function phase(name: NonNullable<NativeDshRestartOperation['phase']>, operation: (signal: AbortSignal) => Promise<void>) {
      await checkedConfiguration(revisions, signal)
      await update(id, { phase: name, phaseState: 'in-flight' })
      signal.throwIfAborted()
      if (name !== 'verify') sideEffect = true
      await withDeadline({ signal, timeoutMs, code: 'DSH_RESTART_PHASE_UNKNOWN', run: phaseSignal => {
        pendingRaw++
        return Promise.resolve().then(() => operation(phaseSignal)).finally(() => { pendingRaw-- })
      } })
      await update(id, { phaseState: 'confirmed', ...(name === 'restart' ? { restartExecutionVerified: true } : {}) })
    }
    try {
      if (!continuing) {
        await phase('stop', signal => options.ports.stop(signal))
        assert(nativeRuntimeIsQuiescent(await options.ports.status()), 'DSH_RESTART_NOT_QUIESCENT', 'Chat resources have not drained.')
        await phase('restart', async signal => {
          const configuration = await checkedConfiguration(revisions, signal)
          await options.ports.assertExclusive(configuration, signal)
          assert(await options.ports.inspect(configuration, signal) === record.targetIdentity, 'DSH_RESTART_TARGET_CHANGED', 'The local DSH target changed.')
          await options.ports.restart(configuration, signal)
        })
      }
      await phase('verify', async signal => {
        const configuration = await checkedConfiguration(revisions, signal)
        assert(await options.ports.inspect(configuration, signal) === record.targetIdentity, 'DSH_RESTART_TARGET_CHANGED', 'The local DSH target changed.')
        await options.ports.verify(configuration, signal)
      })
      await phase('restore', signal => options.ports.restore(revisions, wasRunning, signal))
      await update(id, { state: 'completed', reasons: [] })
    } catch (error) {
      try { await update(id, { state: sideEffect ? 'unknown' : 'blocked', reasons: [errorCode(error, 'DSH_RESTART_UNKNOWN')] }) } catch { /* Preserve the durable in-flight marker. */ }
    }
  }
  async function read(id?: string): Promise<NativeDshRestartSnapshot> {
    const prior = await storage.read()
    const record = id ? prior.value.records.find(record => record.operation.id === id) : prior.value.records.at(-1)
    const missingReasons: string[] = []
    try {
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
      const configuration = await options.ports.configuration()
      await options.ports.inspect(configuration, signal)
      if (!active) await options.ports.assertExclusive(configuration, signal)
    } catch (error) { missingReasons.push(errorCode(error, 'LOCAL_DSH_RESTART_UNAVAILABLE')) }
    return snapshot({ schema: 1, available: missingReasons.length === 0, missingReasons, operation: record ? project(record) : null })
  }
  return Object.freeze({ read,
    async create(input: unknown): Promise<NativeDshRestartSnapshot> {
      const request = parseNativeDshRestartRequest(input)
      assert(request, 'DSH_RESTART_REQUEST_INVALID', 'Explicit versioned maintenance is required.')
      assert(!options.signal.aborted && !admitting, 'DSH_RESTART_BUSY', 'Maintenance cannot be admitted.')
      admitting = true
      try {
        const prior = await storage.read()
        const existing = prior.value.records.find(record => record.operation.id === request.operationId)
        if (existing) {
          assert(digest(existing.operation.revisions) === digest(request.revisions), 'DSH_RESTART_ID_CONFLICT', 'An operation ID cannot change intent.')
          return read(request.operationId)
        }
        assert(!prior.value.retired?.some(item => item.id === request.operationId), 'DSH_RESTART_OPERATION_RETIRED', 'This completed maintenance identity cannot run again.')
        assert(!active && !prior.value.records.some(record => ['running', 'unknown'].includes(project(record).state)), 'DSH_RESTART_RECONCILIATION_REQUIRED', 'Existing maintenance requires reconciliation.')
        const terminal = prior.value.records.filter(record => !['running', 'unknown'].includes(project(record).state))
        const retiring = terminal.slice(0, Math.max(0, terminal.length - 31))
        const retiredIds = new Set(retiring.map(record => record.operation.id))
        const retained = prior.value.records.filter(record => !retiredIds.has(record.operation.id))
        const retired = [...prior.value.retired ?? [], ...retiring.map(record => ({ id: record.operation.id, requestIdentity: digest(record.operation.revisions) }))]
        assert(retained.length < 128 && retired.length <= 8192, 'DSH_RESTART_HISTORY_FULL', 'Maintenance history is full.')
        const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
        const configuration = await checkedConfiguration(request.revisions, signal)
        await options.ports.assertExclusive(configuration, signal)
        const targetIdentity = await options.ports.inspect(configuration, signal)
        const status = await options.ports.status()
        assert(status !== null && typeof status === 'object' && 'state' in status, 'DSH_RESTART_STATUS_UNAVAILABLE', 'Chat status is unavailable.')
        assert(status.state === 'running' || status.state === 'stopped' || status.state === 'error', 'DSH_RESTART_BUSY', 'Chat lifecycle is busy.')
        const at = Date.now()
        const operation: NativeDshRestartOperation = { schema: 1, id: request.operationId, state: 'running', phase: null, phaseState: 'pending',
          revisions: request.revisions, wasRunning: status.state === 'running', restartExecutionVerified: false, createdAt: at, updatedAt: at, reasons: [] }
        const record = { instanceId, targetIdentity, operation }
        await storage.write(prior.revision, { schema: 1, records: [...retained, record], retired })
        active = run(record).finally(() => { active = undefined })
        return snapshot({ schema: 1, available: true, missingReasons: [], operation })
      } finally { admitting = false }
    },
    async reconcile(id: string): Promise<NativeDshRestartSnapshot> {
      assert(!active && !admitting && pendingRaw === 0 && !options.signal.aborted, 'DSH_RESTART_BUSY', 'Maintenance is unsettled.')
      admitting = true
      try {
        const prior = await storage.read()
        const record = prior.value.records.find(record => record.operation.id === id)
        if (!record) {
          const retired = prior.value.retired ?? []
          if (!retired.some(item => item.id === id)) {
            assert(retired.length < 8192, 'DSH_RESTART_HISTORY_FULL', 'Maintenance idempotency history is full.')
            await storage.write(prior.revision, { ...prior.value, retired: [...retired, { id, requestIdentity: digest({ notReceived: id }) }] })
          }
          assert(false, 'DSH_RESTART_NOT_RECEIVED', 'The missing maintenance request has been retired; use a new explicit intent.')
        }
        const operation = project(record)
        if (operation.state !== 'unknown') return read(id)
        const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
        const configuration = await checkedConfiguration(operation.revisions, signal)
        const status = await options.ports.status()
        const alreadyRestored = operation.phase === 'restore' && operation.wasRunning && status !== null && typeof status === 'object'
          && 'state' in status && status.state === 'running' && 'chatReady' in status && status.chatReady === true
          && 'revisions' in status && digest(status.revisions) === digest(operation.revisions)
          && 'activeRevisions' in status && digest(status.activeRevisions) === digest(operation.revisions)
        assert(alreadyRestored || nativeRuntimeIsQuiescent(status), 'DSH_RESTART_NOT_QUIESCENT', 'Chat resources have not drained.')
        await options.ports.assertExclusive(configuration, signal)
        assert(await options.ports.inspect(configuration, signal) === record.targetIdentity, 'DSH_RESTART_TARGET_CHANGED', 'The local DSH target changed.')
        await options.ports.verify(configuration, signal)
        const canContinue = operation.phase === 'restart' || operation.phase === 'verify' || operation.phase === 'restore'
        const next = { ...operation, state: alreadyRestored ? 'completed' as const : canContinue ? 'running' as const : 'blocked' as const,
          ...(alreadyRestored ? { phaseState: 'confirmed' as const } : {}),
          reasons: canContinue ? [] : ['dsh_restart_stopped_new_intent_required'], updatedAt: Date.now() }
        const owned = { ...record, instanceId, operation: next }
        await storage.write(prior.revision, { ...prior.value, records: prior.value.records.map(item => item.operation.id === id ? owned : item) })
        volatileUnknown = undefined
        if (canContinue && !alreadyRestored) active = run(owned, true).finally(() => { active = undefined })
        return snapshot({ schema: 1, available: true, missingReasons: [], operation: next })
      } finally { admitting = false }
    },
    async drain() { await active },
    busy() { return Boolean(active || admitting || pendingRaw > 0) },
    async unresolved() { return Boolean(active || admitting || pendingRaw > 0)
      || (await storage.read()).value.records.some(record => ['running', 'unknown'].includes(project(record).state)) },
  })
}
