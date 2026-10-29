import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { MIGRATION_PROTOCOL, validMigrationTargetSelection, type ForkPreviewRequest, type ForkPreviewResult,
  type ForkWithPresetRequest, type ForkWithPresetResult } from './migration-protocol.js'

export function migrationDigest(value: unknown): string {
  function ordered(input: unknown): unknown {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (Array.isArray(input)) return input.map(ordered)
    if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) {
      return Object.fromEntries(Object.keys(input).sort().map(key => [key, ordered(Reflect.get(input, key))]))
    }
    throw new TypeError('迁移数据不是完整 JSON。')
  }
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
}

export interface PreparedMigration {
  readonly sourceCursor: number
  readonly sourceDigest: string
  readonly targetRevision: string
  create(childSessionId: string, signal: AbortSignal): Promise<void>
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
}

function validPreview(request: ForkPreviewRequest): boolean {
  return !!request && typeof request === 'object'
    && [request.migrationId, request.sourceSessionId, request.expectedPreset, request.targetPreset].every(identifier)
    && (request.targetSelection === undefined || validMigrationTargetSelection(request.targetSelection))
}

function validCommit(request: ForkWithPresetRequest): boolean {
  return validPreview(request) && identifier(request.issuerEpoch) && Number.isSafeInteger(request.expectedCursor)
    && request.expectedCursor >= 0 && /^[a-f0-9]{64}$/.test(request.expectedSourceDigest)
    && /^[a-f0-9]{64}$/.test(request.expectedTargetRevision)
}

function refs(request: ForkPreviewRequest): ForkPreviewRequest {
  return { migrationId: request.migrationId, sourceSessionId: request.sourceSessionId,
    expectedPreset: request.expectedPreset, targetPreset: request.targetPreset,
    ...(request.targetSelection === undefined ? {} : { targetSelection: request.targetSelection }) }
}

function constraints(request: ForkWithPresetRequest): ForkWithPresetRequest {
  return { ...refs(request), issuerEpoch: request.issuerEpoch, expectedCursor: request.expectedCursor,
    expectedSourceDigest: request.expectedSourceDigest, expectedTargetRevision: request.expectedTargetRevision }
}

function reason(error: unknown): string {
  return error instanceof Error && /^migration_[a-z_]+$/.test(error.message) ? error.message : 'migration_unavailable'
}

async function readRecord(filename: string): Promise<{ readonly fingerprint: string; readonly result: ForkWithPresetResult } | null> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  if (!handle) return null
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65_536 || (stat.mode & 0o777) !== 0o600
      || stat.uid !== process.getuid?.()) throw new Error('migration_journal_unavailable')
    const text = await handle.readFile('utf8')
    const after = await handle.stat()
    const current = await lstat(filename)
    if (stat.ino !== current.ino || stat.dev !== current.dev || stat.size !== after.size
      || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('migration_journal_unavailable')
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || !('schema' in value) || value.schema !== 1 || !('fingerprint' in value) || !('result' in value)
      || !('request' in value) || typeof value.fingerprint !== 'string' || !value.result || typeof value.result !== 'object'
      || !value.request || typeof value.request !== 'object') throw new Error('migration_journal_unavailable')
    const result = value.result as ForkWithPresetResult
    const request = value.request as ForkWithPresetRequest
    if (!validCommit(result) || Object.keys(result).length !== 13 + Number(result.targetSelection !== undefined) || result.migrationProtocol !== MIGRATION_PROTOCOL
      || !['completed', 'unknown'].includes(result.state) || !identifier(result.childSessionId)
      || result.childSessionId === result.sourceSessionId || !validCommit(request) || Object.keys(request).length !== 8 + Number(request.targetSelection !== undefined)
      || migrationDigest(constraints(request)) !== value.fingerprint
      || (result.state === 'completed' ? result.idempotency !== 'created' || result.missingReasons.length !== 0 : result.idempotency !== 'unknown')
      || !Array.isArray(result.missingReasons) || !result.missingReasons.every(item => typeof item === 'string')
      || value.fingerprint !== migrationDigest(constraints(result))) throw new Error('migration_journal_unavailable')
    return { fingerprint: value.fingerprint, result }
  } finally { await handle.close() }
}

async function persist(filename: string, fingerprint: string, result: ForkWithPresetResult): Promise<void> {
  const temporary = `${filename}.tmp`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(JSON.stringify({ schema: 1, request: constraints(result), fingerprint, result })); await handle.sync() }
  finally { await handle.close() }
  await rename(temporary, filename)
  const parent = await open(dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await parent.sync() } finally { await parent.close() }
}

export function createMigrationJournal(options: {
  readonly directory: string
  readonly issuerEpoch: string
  prepare(request: ForkPreviewRequest, signal: AbortSignal): Promise<PreparedMigration>
}) {
  if (!isAbsolute(options.directory) || resolve(options.directory) !== options.directory) throw new TypeError('迁移目录必须是规范绝对路径。')
  let busy = false
  const filename = (request: ForkPreviewRequest) => join(options.directory, `${migrationDigest(request.migrationId)}.json`)
  const reply = (request: ForkWithPresetRequest, state: ForkWithPresetResult['state'],
    idempotency: ForkWithPresetResult['idempotency'], missingReasons: readonly string[], childSessionId: string | null = null): ForkWithPresetResult =>
    ({ ...constraints(request), migrationProtocol: MIGRATION_PROTOCOL, state, idempotency, missingReasons, childSessionId })
  async function inspect(request: ForkWithPresetRequest): Promise<ForkWithPresetResult> {
    if (!validCommit(request) || Object.keys(request).length !== 8 + Number(request.targetSelection !== undefined)) throw new TypeError('迁移请求无效。')
    try {
      if (await realpath(options.directory) !== options.directory) throw new Error('migration_journal_unavailable')
      const directory = await lstat(options.directory)
      if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) throw new Error('migration_journal_unavailable')
      const record = await readRecord(filename(request))
      if (!record) return reply(request, 'not-found', 'not-found', ['migration_not_found'])
      if (record.fingerprint !== migrationDigest(constraints(request))) return reply(request, 'rejected', 'conflict', ['migration_id_conflict'])
      return { ...record.result, idempotency: record.result.state === 'completed' ? 'replayed' : 'unknown' }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return reply(request, 'not-found', 'not-found', ['migration_not_found'])
      return reply(request, 'unknown', 'unknown', ['migration_journal_unavailable'])
    }
  }
  return Object.freeze({
    inspect,
    async preview(request: ForkPreviewRequest, signal: AbortSignal): Promise<ForkPreviewResult> {
      if (!validPreview(request) || Object.keys(request).length !== 4 + Number(request.targetSelection !== undefined)) throw new TypeError('迁移预览请求无效。')
      try {
        signal.throwIfAborted()
        const prepared = await options.prepare(request, signal)
        signal.throwIfAborted()
        return { ...refs(request), migrationProtocol: MIGRATION_PROTOCOL, issuerEpoch: options.issuerEpoch,
          state: 'available', sourceCursor: prepared.sourceCursor, sourceDigest: prepared.sourceDigest,
          targetRevision: prepared.targetRevision, missingReasons: [] }
      } catch (error) {
        return { ...refs(request), migrationProtocol: MIGRATION_PROTOCOL, issuerEpoch: options.issuerEpoch,
          state: 'blocked', sourceCursor: null, sourceDigest: null, targetRevision: null, missingReasons: [reason(error)] }
      }
    },
    async commit(request: ForkWithPresetRequest, signal: AbortSignal): Promise<ForkWithPresetResult> {
      if (!validCommit(request) || Object.keys(request).length !== 8 + Number(request.targetSelection !== undefined)) throw new TypeError('迁移提交请求无效。')
      if (request.issuerEpoch !== options.issuerEpoch) return reply(request, 'rejected', 'conflict', ['migration_epoch_changed'])
      if (busy) return reply(request, 'unknown', 'unknown', ['migration_busy'])
      busy = true
      let lock: Awaited<ReturnType<typeof open>> | undefined
      let intent = false
      const childSessionId = `session-qbf-${migrationDigest(request.migrationId)}`
      const fingerprint = migrationDigest(constraints(request))
      try {
        signal.throwIfAborted()
        await mkdir(options.directory, { recursive: true, mode: 0o700 })
        const directory = await lstat(options.directory)
        if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700
          || await realpath(options.directory) !== options.directory) throw new Error('migration_journal_unavailable')
        lock = await open(join(options.directory, '.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        const previous = await readRecord(filename(request))
        if (previous) return previous.fingerprint === fingerprint
          ? { ...previous.result, idempotency: previous.result.state === 'completed' ? 'replayed' : 'unknown' }
          : reply(request, 'rejected', 'conflict', ['migration_id_conflict'])
        if ((await readdir(options.directory)).filter(name => name.endsWith('.json')).length >= 256) throw new Error('migration_capacity_exceeded')
        const prepared = await options.prepare(request, signal)
        if (prepared.sourceCursor !== request.expectedCursor || prepared.sourceDigest !== request.expectedSourceDigest
          || prepared.targetRevision !== request.expectedTargetRevision) return reply(request, 'rejected', 'conflict', ['migration_source_or_target_changed'])
        signal.throwIfAborted()
        intent = true
        await persist(filename(request), fingerprint, reply(request, 'unknown', 'unknown', ['migration_incomplete'], childSessionId))
        await prepared.create(childSessionId, signal)
        const result = reply(request, 'completed', 'created', [], childSessionId)
        await persist(filename(request), fingerprint, result)
        return result
      } catch (error) {
        return reply(request, intent ? 'unknown' : 'rejected', intent ? 'unknown' : 'conflict', [reason(error)], intent ? childSessionId : null)
      } finally {
        if (lock) { await lock.close(); await unlink(join(options.directory, '.lock')).catch(() => undefined) }
        busy = false
      }
    },
  })
}
