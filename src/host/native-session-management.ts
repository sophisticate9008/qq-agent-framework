import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FrameworkError, isRecord } from '../core/values.ts'
import { openReadonlySqliteStore } from '../storage/sqlite-readonly.ts'
import { readSessionMetadata, type SessionMetadata } from './sessions.ts'

export type NativeSessionManagementState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface NativeSessionResetTarget {
  readonly key: string
  readonly sessionId: string
  readonly generation: number
  readonly bindingRevision: string
}

function fail(code: string): never {
  throw new FrameworkError(code, 'The selected session could not be reset safely.')
}

function missing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function sessionMetadata(value: unknown): SessionMetadata {
  if (!isRecord(value) || typeof value.conversationId !== 'string' || !/^(?:group|private):[1-9][0-9]{0,19}$/.test(value.conversationId)
    || value.state !== 'ready' || typeof value.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value.sessionId)
    || typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 1
    || typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt)
    || value.requestId !== null && (typeof value.requestId !== 'string' || value.requestId.length > 1024)) fail('SESSION_MANAGEMENT_INVALID_BINDING')
  return { conversationId: value.conversationId, state: 'ready', generation: value.generation,
    requestId: value.requestId as string | null, sessionId: value.sessionId, updatedAt: value.updatedAt }
}

export function nativeSessionBindingRevision(value: unknown): string {
  const binding = sessionMetadata(value)
  return createHash('sha256').update(JSON.stringify([binding.conversationId, binding.state, binding.sessionId,
    binding.generation, binding.requestId, binding.updatedAt])).digest('hex')
}

export function validNativeSessionResetTarget(value: unknown): value is NativeSessionResetTarget {
  return isRecord(value) && typeof value.key === 'string' && /^(?:group|private):[1-9][0-9]{0,19}$/.test(value.key)
    && typeof value.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value.sessionId)
    && typeof value.generation === 'number' && Number.isSafeInteger(value.generation) && value.generation > 0
    && typeof value.bindingRevision === 'string' && /^[a-f0-9]{64}$/.test(value.bindingRevision)
}

function leaseAbsent(directory: string): boolean {
  try { lstatSync(join(directory, '.native-chat-runtime.lock')); return false }
  catch (error) { if (missing(error)) return true; throw error }
}

function validateIdentity(store: ReturnType<typeof openReadonlySqliteStore>): void {
  const identity = store.read('native-chat.meta', 'session-definition')
  if (!identity || !isRecord(identity.value) || typeof identity.value.identity !== 'string'
    || !/^[a-f0-9]{64}$/.test(identity.value.identity)) fail('SESSION_MANAGEMENT_STORAGE_UNAVAILABLE')
}

export function nativeSessionManagementAvailable(directory: string, state: NativeSessionManagementState): boolean {
  if (state !== 'stopped') return false
  let store: ReturnType<typeof openReadonlySqliteStore> | undefined
  try {
    if (!leaseAbsent(directory)) return false
    store = openReadonlySqliteStore(join(directory, 'native-chat.sqlite'))
    validateIdentity(store)
    return true
  } catch { return false } finally { store?.close() }
}

export function readNativeSessionManagement(options: {
  readonly directory: string
  readonly state: NativeSessionManagementState
  readonly owner: string | null
  readonly limit?: number
  readonly after?: string
}) {
  let store: ReturnType<typeof openReadonlySqliteStore>
  try { store = openReadonlySqliteStore(join(options.directory, 'native-chat.sqlite')) }
  catch (error) { if (error instanceof FrameworkError && error.code === 'STORE_NOT_FOUND') return null; throw error }
  try {
    return store.withSnapshot(() => {
      validateIdentity(store)
      const limit = options.limit ?? 100
      const items = readSessionMetadata(store, { limit, ...(options.after === undefined ? {} : { after: options.after }) })
      const sessions = items.filter(item => item.state === 'ready').map(item => ({ key: item.conversationId,
        sessionId: item.sessionId!, generation: item.generation, bindingRevision: nativeSessionBindingRevision(item),
        owner: options.owner !== null && item.conversationId === `private:${options.owner}` }))
      const resetAvailable = options.state === 'stopped' && leaseAbsent(options.directory)
      return { native: true, source: 'native', sessions, items, next: items.length === limit ? items.at(-1)!.conversationId : null,
        revision: createHash('sha256').update(JSON.stringify({ sessions, items })).digest('hex'), resetAvailable,
        historyReadOnly: !resetAvailable, resetScope: 'binding-only' as const,
        resetUnavailableReason: resetAvailable ? null : options.state !== 'stopped' ? 'runtime_not_stopped' : 'native_session_management_busy' }
    })
  } finally { store.close() }
}

function privateFiles(directory: string): void {
  if (!isAbsolute(directory) || resolve(directory) !== directory || realpathSync(directory) !== directory) fail('SESSION_MANAGEMENT_STORAGE_UNSAFE')
  const folder = lstatSync(directory)
  if (!folder.isDirectory() || folder.isSymbolicLink() || (folder.mode & 0o7777) !== 0o700
    || typeof process.getuid === 'function' && folder.uid !== process.getuid()) fail('SESSION_MANAGEMENT_STORAGE_UNSAFE')
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      const metadata = lstatSync(join(directory, `native-chat.sqlite${suffix}`))
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o7777) !== 0o600
        || typeof process.getuid === 'function' && metadata.uid !== process.getuid()) fail('SESSION_MANAGEMENT_STORAGE_UNSAFE')
    } catch (error) { if (suffix !== '' && missing(error)) continue; throw error }
  }
}

export async function resetNativeSessionContext(options: {
  readonly directory: string
  readonly state: () => NativeSessionManagementState | Promise<NativeSessionManagementState>
  readonly target: NativeSessionResetTarget
  readonly signal: AbortSignal
}) {
  if (!validNativeSessionResetTarget(options.target)) fail('SESSION_MANAGEMENT_INVALID_TARGET')
  options.signal.throwIfAborted()
  if (await options.state() !== 'stopped') fail('SESSION_MANAGEMENT_NOT_STOPPED')
  privateFiles(options.directory)
  const lease = join(options.directory, '.native-chat-runtime.lock')
  const handle = await open(lease, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    .catch(() => fail('SESSION_MANAGEMENT_BUSY'))
  const held = await handle.stat()
  let database: DatabaseSync | undefined
  let transaction = false
  let committing = false
  try {
    await handle.writeFile(JSON.stringify({ operation: 'session-reset', id: randomUUID() }))
    await handle.sync()
    options.signal.throwIfAborted()
    if (await options.state() !== 'stopped') fail('SESSION_MANAGEMENT_NOT_STOPPED')
    const reader = openReadonlySqliteStore(join(options.directory, 'native-chat.sqlite'))
    try {
      validateIdentity(reader)
      const record = reader.read('host.sessions', options.target.key)
      if (!record || !isRecord(record.value) || record.value.state !== 'ready') fail('SESSION_MANAGEMENT_CONFLICT')
      const metadata = sessionMetadata({ ...record.value, conversationId: record.key })
      if (metadata.sessionId !== options.target.sessionId || metadata.generation !== options.target.generation
        || nativeSessionBindingRevision(metadata) !== options.target.bindingRevision) fail('SESSION_MANAGEMENT_CONFLICT')
    } finally { reader.close() }
    privateFiles(options.directory)
    const filename = join(options.directory, 'native-chat.sqlite')
    const before = lstatSync(filename)
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA trusted_schema = OFF')
    const location = new URL(`file://${filename}`)
    location.searchParams.set('mode', 'rw')
    database.prepare('ATTACH DATABASE ? AS managed').run(location.href)
    const after = lstatSync(filename)
    if (before.dev !== after.dev || before.ino !== after.ino) fail('SESSION_MANAGEMENT_STORAGE_UNSAFE')
    database.exec('PRAGMA managed.synchronous = FULL; BEGIN IMMEDIATE')
    transaction = true
    const target = options.target
    const row = database.prepare('SELECT value, revision, expires_at AS expiresAt FROM managed.durable_records WHERE namespace = ? AND key = ?')
      .get('host.sessions', target.key)
    if (!row || typeof row.value !== 'string' || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision)
      || row.expiresAt !== null) fail('SESSION_MANAGEMENT_CONFLICT')
    const value: unknown = JSON.parse(row.value)
    if (!isRecord(value) || value.schema !== 1) fail('SESSION_MANAGEMENT_INVALID_BINDING')
    const metadata = sessionMetadata({ ...value, conversationId: target.key })
    if (metadata.sessionId !== target.sessionId || metadata.generation !== target.generation
      || nativeSessionBindingRevision(metadata) !== target.bindingRevision) fail('SESSION_MANAGEMENT_CONFLICT')
    const unsettled = database.prepare(`SELECT 1 FROM managed.durable_records WHERE namespace = 'host.executions'
      AND json_extract(value, '$.binding.conversationId') = ? AND json_extract(value, '$.binding.sessionId') = ?
      AND json_extract(value, '$.binding.generation') = ? AND (
        coalesce(json_extract(value, '$.isolated'), 1) != 0 OR
        NOT (coalesce(json_extract(value, '$.status'), '') IN ('completed', 'failed', 'rejected', 'timed-out') OR
          (coalesce(json_extract(value, '$.status'), '') = 'unknown' AND
            coalesce(json_extract(value, '$.externalStatus'), 'unknown') IN ('completed', 'failed', 'rejected', 'cancelled'))) OR
        coalesce(json_extract(value, '$.externalStatus'), 'unknown') NOT IN ('completed', 'failed', 'rejected', 'cancelled', 'not-started') OR
        coalesce(json_extract(value, '$.cancelStatus'), 'unknown') IN ('requesting', 'accepted', 'unknown') OR
        coalesce(json_extract(value, '$.noticeStatus'), 'unknown') IN ('sending', 'unknown')) LIMIT 1`)
      .get(target.key, target.sessionId, target.generation)
    if (unsettled) fail('SESSION_MANAGEMENT_EXECUTION_UNSETTLED')
    const generation = metadata.generation + 1
    if (!Number.isSafeInteger(generation)) fail('SESSION_MANAGEMENT_GENERATION_EXHAUSTED')
    const at = Date.now()
    const owner = database.prepare('SELECT value, expires_at AS expiresAt FROM managed.durable_records WHERE namespace = ? AND key = ?')
      .get('host.session-ids', target.sessionId)
    if (owner) {
      if (typeof owner.value !== 'string' || owner.expiresAt !== null) fail('SESSION_MANAGEMENT_STORAGE_UNAVAILABLE')
      const ownership: unknown = JSON.parse(owner.value)
      if (!isRecord(ownership) || ownership.schema !== 1 || typeof ownership.conversationId !== 'string'
        || typeof ownership.generation !== 'number' || !Number.isSafeInteger(ownership.generation) || ownership.generation < 1) {
        fail('SESSION_MANAGEMENT_STORAGE_UNAVAILABLE')
      }
      if (ownership.conversationId !== target.key || ownership.generation !== target.generation) fail('SESSION_MANAGEMENT_CONFLICT')
    }
    const revisionDelta = owner ? 2 : 3
    const revision = database.prepare("UPDATE managed.durable_meta SET value = value + ? WHERE name = 'revision' AND value <= ? RETURNING value")
      .get(revisionDelta, Number.MAX_SAFE_INTEGER - revisionDelta)?.value
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) fail('SESSION_MANAGEMENT_REVISION_EXHAUSTED')
    if (!owner) {
      database.prepare('INSERT INTO managed.durable_records(namespace, key, value, revision, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL)')
        .run('host.session-ids', target.sessionId, JSON.stringify({ schema: 1, conversationId: target.key,
          generation: target.generation }), revision - 2, at)
    }
    const archiveId = createHash('sha256').update(JSON.stringify([target.key, target.sessionId, target.generation, row.revision])).digest('hex')
    const archive = { schema: 1, conversationId: target.key, sessionId: target.sessionId, generation: target.generation,
      resetAt: at, previousRevision: row.revision, previous: value }
    database.prepare('INSERT INTO managed.durable_records(namespace, key, value, revision, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .run('host.session-archives', archiveId, JSON.stringify(archive), revision - 1, at)
    const retired = { schema: 1, state: 'retired', generation, requestId: null, sessionId: null, updatedAt: at }
    const changed = database.prepare('UPDATE managed.durable_records SET value = ?, revision = ?, updated_at = ? WHERE namespace = ? AND key = ? AND revision = ?')
      .run(JSON.stringify(retired), revision, at, 'host.sessions', target.key, row.revision)
    if (changed.changes !== 1) fail('SESSION_MANAGEMENT_CONFLICT')
    options.signal.throwIfAborted()
    privateFiles(options.directory)
    const finalFile = lstatSync(filename)
    if (before.dev !== finalFile.dev || before.ino !== finalFile.ino) fail('SESSION_MANAGEMENT_STORAGE_UNSAFE')
    committing = true
    database.exec('COMMIT')
    transaction = false
    const observed = database.prepare('SELECT value, revision FROM managed.durable_records WHERE namespace = ? AND key = ?')
      .get('host.sessions', target.key)
    if (!observed || observed.value !== JSON.stringify(retired) || observed.revision !== revision) fail('SESSION_MANAGEMENT_UNKNOWN')
    const observedOwner = database.prepare('SELECT value, expires_at AS expiresAt FROM managed.durable_records WHERE namespace = ? AND key = ?')
      .get('host.session-ids', target.sessionId)
    if (!observedOwner || typeof observedOwner.value !== 'string' || observedOwner.expiresAt !== null) fail('SESSION_MANAGEMENT_UNKNOWN')
    const ownership: unknown = JSON.parse(observedOwner.value)
    if (!isRecord(ownership) || ownership.schema !== 1 || ownership.conversationId !== target.key
      || ownership.generation !== target.generation) fail('SESSION_MANAGEMENT_UNKNOWN')
    return { ok: true as const, key: target.key, previousSessionId: target.sessionId, previousGeneration: target.generation,
      nextGeneration: generation, bridgeBindingRemoved: true as const, externalWorkStopped: 'unverified' as const,
      historyPreserved: true as const, contextReset: true as const }
  } catch (error) {
    if (transaction) { try { database?.exec('ROLLBACK') } catch {} }
    if (committing) fail('SESSION_MANAGEMENT_UNKNOWN')
    if (error instanceof FrameworkError) throw error
    fail('SESSION_MANAGEMENT_STORAGE_UNAVAILABLE')
  } finally {
    let cleanupFailed = false
    try { database?.close() } catch { cleanupFailed = true }
    try { await handle.close() } catch { cleanupFailed = true }
    try {
      const current = await lstat(lease)
      if (current.dev === held.dev && current.ino === held.ino) await unlink(lease)
    } catch (error) { if (!missing(error)) cleanupFailed = true }
    if (cleanupFailed) fail(committing ? 'SESSION_MANAGEMENT_UNKNOWN' : 'SESSION_MANAGEMENT_STORAGE_UNAVAILABLE')
  }
}
