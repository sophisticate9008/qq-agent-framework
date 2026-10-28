import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { validSimulationRunId } from '../contracts/admin-activity.ts'
import { parseSimulationSessionResetRequest, type SimulationSession,
  type SimulationSessionResetRequest, type SimulationSessionSnapshot } from '../contracts/simulation-sessions.ts'
import { FrameworkError, isRecord, snapshot } from '../core/values.ts'
import { openReadonlySqliteStore } from '../storage/sqlite-readonly.ts'
import { nativeSessionBindingRevision, resetNativeSessionContext, validNativeSessionResetTarget } from './native-session-management.ts'
import { readSessionMetadata } from './sessions.ts'

function fail(code: string): never { throw new FrameworkError(code, 'The simulation session could not be managed safely.') }
function missing(error: unknown): boolean { return isRecord(error) && error.code === 'ENOENT' }

async function privateDirectory(filename: string): Promise<void> {
  const info = await lstat(filename)
  if (!isAbsolute(filename) || resolve(filename) !== filename || await realpath(filename) !== filename
    || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o7777) !== 0o700
    || process.getuid && info.uid !== process.getuid()) fail('SIMULATION_SESSIONS_SOURCE_UNSAFE')
}

async function privateJson(filename: string, maximum: number, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum || (before.mode & 0o7777) !== 0o600
      || process.getuid && before.uid !== process.getuid()) fail('SIMULATION_SESSIONS_SOURCE_UNSAFE')
    const bytes = Buffer.alloc(maximum + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const after = await handle.stat()
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) fail('SIMULATION_SESSIONS_SOURCE_CHANGED')
    signal.throwIfAborted()
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as unknown
  } finally { await handle.close() }
}

async function simulationRoot(sourceDirectory: string, signal: AbortSignal) {
  await privateDirectory(sourceDirectory)
  let index: unknown
  try { index = await privateJson(join(sourceDirectory, 'simulation-activity-index.json'), 4096, signal) }
  catch (error) { if (missing(error)) return null; throw error }
  if (!isRecord(index) || index.schema !== 1 || typeof index.sourceDirectory !== 'string'
    || !isAbsolute(index.sourceDirectory) || resolve(index.sourceDirectory) !== sourceDirectory
    || typeof index.root !== 'string' || !isAbsolute(index.root) || resolve(index.root) !== index.root
    || index.root === sourceDirectory || !validSimulationRunId(index.latestRunId)) fail('SIMULATION_SESSIONS_SOURCE_INVALID')
  await privateDirectory(index.root)
  return { root: index.root, latestRunId: index.latestRunId }
}

async function nativeDirectoryForRun(root: string, runId: string, sourceDirectory: string, signal: AbortSignal): Promise<string | null> {
  if (!validSimulationRunId(runId)) fail('SIMULATION_SESSION_INVALID_TARGET')
  const runDirectory = join(root, runId)
  await privateDirectory(runDirectory)
  const nativeDirectory = join(runDirectory, 'native')
  try {
    await privateDirectory(nativeDirectory)
    const database = await lstat(join(nativeDirectory, 'native-chat.sqlite'))
    if (!database.isFile() || database.isSymbolicLink() || database.nlink !== 1) fail('SIMULATION_SESSIONS_SOURCE_UNSAFE')
  } catch (error) { if (missing(error)) return null; throw error }
  const manifest = await privateJson(join(runDirectory, 'simulation.json'), 65536, signal)
  if (!isRecord(manifest) || manifest.schema !== 1 || typeof manifest.sourceDirectory !== 'string'
    || !isAbsolute(manifest.sourceDirectory)) fail('SIMULATION_SESSIONS_SOURCE_INVALID')
  // Other accounts can share a simulation root, but never each other's management scope.
  if (resolve(manifest.sourceDirectory) !== sourceDirectory) return null
  if (manifest.nativeDirectory !== nativeDirectory || nativeDirectory === sourceDirectory
    || manifest.protocolMode !== 'local-capture' || manifest.productionBootstrapMounted !== false) fail('SIMULATION_SESSIONS_SOURCE_INVALID')
  return nativeDirectory
}

async function runtimeBusy(directory: string): Promise<boolean> {
  try { await lstat(join(directory, '.native-chat-runtime.lock')); return true }
  catch (error) { if (missing(error)) return false; throw error }
}

/** Resolve only the current account's fixed pointer, then inspect each run's actual private database. */
export function createSimulationSessionManagement(options: { readonly sourceDirectory: string }) {
  const sourceDirectory = resolve(options.sourceDirectory)
  return Object.freeze({
    async list(signal: AbortSignal): Promise<SimulationSessionSnapshot> {
      const selected = await simulationRoot(sourceDirectory, signal)
      if (!selected) return { schema: 1, sessions: [], limited: false, unavailableRuns: 0 }
      const names: string[] = []
      let entries = 0
      let limited = false
      let unavailableRuns = 0
      const folder = await opendir(selected.root)
      for await (const entry of folder) {
        signal.throwIfAborted()
        if (++entries > 2048) { limited = true; break }
        if (!validSimulationRunId(entry.name)) continue
        if (entry.isSymbolicLink()) { unavailableRuns++; continue }
        if (entry.isDirectory()) names.push(entry.name)
      }
      names.sort((left, right) => left === selected.latestRunId ? -1 : right === selected.latestRunId ? 1 : right.localeCompare(left))
      if (names.length > 256) limited = true
      const sessions: SimulationSession[] = []
      for (const runId of names.slice(0, 256)) {
        signal.throwIfAborted()
        try {
          const directory = await nativeDirectoryForRun(selected.root, runId, sourceDirectory, signal)
          if (!directory) continue // Prepared runs without a database have no bindings to manage.
          const busy = await runtimeBusy(directory)
          const store = openReadonlySqliteStore(join(directory, 'native-chat.sqlite'))
          try {
            const rows = store.withSnapshot(() => {
              const identity = store.read('native-chat.meta', 'session-definition')
              if (!identity || !isRecord(identity.value) || typeof identity.value.identity !== 'string'
                || !/^[a-f0-9]{64}$/.test(identity.value.identity)) fail('SIMULATION_SESSIONS_SOURCE_INVALID')
              return readSessionMetadata(store, { limit: 1000 })
            })
            if (rows.length === 1000) limited = true
            for (const row of rows) {
              if (sessions.length >= 4096) { limited = true; break }
              let bindingRevision: string | null = null
              if (row.state === 'ready') {
                try { bindingRevision = nativeSessionBindingRevision(row) } catch { /* Keep an unsupported actual row visible. */ }
              }
              const resetAvailable = !busy && row.state === 'ready' && bindingRevision !== null
              sessions.push({ runId, key: row.conversationId, originalConversationId: row.conversationId,
                ledgerConversationId: `simulation:${runId}:${row.conversationId}`, sessionId: row.sessionId,
                generation: row.generation, bindingRevision, state: row.state, updatedAt: row.updatedAt,
                origin: 'simulation', runtimeState: busy ? 'busy' : 'stopped', resetAvailable,
                resetUnavailableReason: resetAvailable ? null : busy ? 'simulation_runtime_busy'
                  : row.state !== 'ready' ? 'simulation_session_not_ready' : 'simulation_session_unsupported' })
            }
          } finally { store.close() }
        } catch {
          signal.throwIfAborted()
          unavailableRuns++
        }
      }
      return snapshot({ schema: 1, sessions: sessions.sort((left, right) => right.updatedAt - left.updatedAt
        || left.runId.localeCompare(right.runId) || left.key.localeCompare(right.key)), limited, unavailableRuns })
    },
    async reset(input: SimulationSessionResetRequest, signal: AbortSignal) {
      const target = parseSimulationSessionResetRequest(input)
      if (!target || !validNativeSessionResetTarget(target)) fail('SIMULATION_SESSION_INVALID_TARGET')
      const selected = await simulationRoot(sourceDirectory, signal)
      if (!selected) fail('SIMULATION_SESSION_NOT_FOUND')
      let directory: string | null
      try { directory = await nativeDirectoryForRun(selected.root, target.runId, sourceDirectory, signal) }
      catch (error) { if (missing(error)) fail('SIMULATION_SESSION_NOT_FOUND'); throw error }
      if (!directory) fail('SIMULATION_SESSION_NOT_FOUND')
      if (await runtimeBusy(directory)) fail('SIMULATION_SESSION_BUSY')
      // The existing reset owns the same exclusive lease as the real runtime and rechecks the binding in SQLite.
      const result = await resetNativeSessionContext({ directory, state: () => 'stopped', target, signal })
      return { schema: 1 as const, runId: target.runId, ...result }
    },
  })
}
