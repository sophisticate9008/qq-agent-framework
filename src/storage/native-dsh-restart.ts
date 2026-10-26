import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { parseNativeDshRestartOperation, type NativeDshRestartOperation } from '../contracts/native-dsh-restart.ts'
import { assert } from '../core/values.ts'
import { ensurePrivateDirectory, readPrivateJson, replacePrivateJson, withDirectoryWriteLock, PrivateJsonStorageError } from './private-json.ts'

export interface NativeDshRestartRecord {
  readonly instanceId: string
  readonly targetIdentity: string
  readonly operation: NativeDshRestartOperation
}
export interface NativeDshRestartJournal { readonly schema: 1; readonly records: readonly NativeDshRestartRecord[];
  readonly retired?: readonly { readonly id: string; readonly requestIdentity: string }[] }
function validate(value: unknown): NativeDshRestartJournal {
  assert(value !== null && typeof value === 'object' && 'schema' in value && value.schema === 1
    && 'records' in value && Array.isArray(value.records) && value.records.length <= 128, 'DSH_RESTART_JOURNAL_INVALID', 'Invalid DSH maintenance journal.')
  const ids = new Set<string>()
  const records = value.records.map((record: unknown) => {
    assert(record !== null && typeof record === 'object' && 'operation' in record
      && 'instanceId' in record && typeof record.instanceId === 'string' && record.instanceId.length <= 128
      && 'targetIdentity' in record && typeof record.targetIdentity === 'string' && /^[a-f0-9]{64}$/.test(record.targetIdentity),
    'DSH_RESTART_JOURNAL_INVALID', 'Invalid DSH maintenance record.')
    const operation = parseNativeDshRestartOperation(record.operation)
    assert(operation && !ids.has(operation.id), 'DSH_RESTART_JOURNAL_INVALID', 'Invalid DSH maintenance operation.')
    ids.add(operation.id)
    return { instanceId: record.instanceId, targetIdentity: record.targetIdentity, operation }
  })
  const retired = 'retired' in value && value.retired !== undefined ? value.retired : []
  assert(Array.isArray(retired) && retired.length <= 8192, 'DSH_RESTART_JOURNAL_INVALID', 'Invalid maintenance idempotency history.')
  const tombstones = retired.map((item: unknown) => {
    assert(item !== null && typeof item === 'object' && 'id' in item && typeof item.id === 'string'
      && /^[0-9a-f-]{36}$/.test(item.id) && !ids.has(item.id) && 'requestIdentity' in item
      && typeof item.requestIdentity === 'string' && /^[a-f0-9]{64}$/.test(item.requestIdentity),
    'DSH_RESTART_JOURNAL_INVALID', 'Invalid retired maintenance identity.')
    ids.add(item.id)
    return { id: item.id, requestIdentity: item.requestIdentity }
  })
  return { schema: 1, records, retired: tombstones }
}
export function createNativeDshRestartStorage(directory: string) {
  assert(isAbsolute(directory), 'DSH_RESTART_DIRECTORY_INVALID', 'An absolute maintenance directory is required.')
  const filename = join(directory, 'native-dsh-restart.json')
  const readOnce = () => readPrivateJson(filename, { validate, maxBytes: 2 * 1024 * 1024, exactMode: 0o600, requireSingleLink: true,
    fallback: { value: { schema: 1 as const, records: [] } }, invalidCode: 'dsh_restart_storage_invalid', conflictCode: 'dsh_restart_revision_conflict' })
  const read = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await readOnce() }
      catch (error) { if (attempt >= 2 || !(error instanceof PrivateJsonStorageError) || error.code !== 'dsh_restart_revision_conflict') throw error }
    }
  }
  return { read, async write(expectedRevision: string, journal: NativeDshRestartJournal) {
    const content = Buffer.from(JSON.stringify(validate(journal)) + '\n')
    await ensurePrivateDirectory(directory)
    return withDirectoryWriteLock(directory, () => replacePrivateJson({ directory, filename,
      temporary: join(directory, `.dsh-restart-${randomUUID()}.tmp`), expectedRevision, content, read,
      verifyTemporaryMetadata: true, conflictCode: 'dsh_restart_revision_conflict',
      writeFailedCode: 'dsh_restart_write_failed', writeUnknownCode: 'dsh_restart_write_unknown' }))
  } }
}
