import { isAbsolute, join, resolve } from 'node:path'
import { FrameworkError } from '../core/values.ts'
import { NATIVE_TOOL_PERMISSION_LIMIT, isNativeToolPermissionId, parseNativeToolPermissionInput, parseNativeToolPermissionsConfiguration,
  type NativeToolPermissionInput, type NativeToolPermissionsConfiguration } from '../contracts/native-tool-permissions.ts'
import { NATIVE_REVISION_PATTERN } from '../contracts/native-revisions.ts'
import { ensurePrivateDirectory, readDocument, updateDocument } from '../storage/private-json.ts'

const EMPTY: NativeToolPermissionsConfiguration = Object.freeze({ schema: 1, grants: Object.freeze([]) })
function configuration(value: unknown): NativeToolPermissionsConfiguration {
  const result = parseNativeToolPermissionsConfiguration(value)
  if (!result) throw new FrameworkError('TOOL_PERMISSIONS_STORED_INVALID', 'The tool permission document is invalid.')
  return result
}
function fail(code: string): never { throw new FrameworkError(code, 'The tool permission change could not be completed.') }

/** Immutable grant ids preserve policy usage; revocation leaves a durable tombstone. Reads never create files. */
export function createNativeToolPermissionsRepository(directory: string, now: () => number = Date.now) {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute tool permission directory is required')
  const root = resolve(directory)
  const filename = join(root, 'chat-tool-permissions.json')
  const project = (document: Awaited<ReturnType<typeof readDocument<NativeToolPermissionsConfiguration>>>) => ({
    revision: document.revision, configuration: document.value
  })
  const read = async () => project(await readDocument(filename, EMPTY, configuration))
  const update = async (revision: string, change: (current: NativeToolPermissionsConfiguration) => NativeToolPermissionsConfiguration, signal: AbortSignal) => {
    if (!NATIVE_REVISION_PATTERN.test(revision)) fail('TOOL_PERMISSIONS_INVALID')
    signal.throwIfAborted()
    await ensurePrivateDirectory(root)
    return project(await updateDocument(root, filename, revision, EMPTY, configuration, change, next => {
      signal.throwIfAborted()
      if (Buffer.byteLength(JSON.stringify(next) + '\n', 'utf8') > 60 * 1_024) fail('TOOL_PERMISSIONS_CAPACITY')
    }))
  }
  return Object.freeze({
    read,
    grant(revision: string, input: NativeToolPermissionInput, signal: AbortSignal) {
      const grant = parseNativeToolPermissionInput(input)
      if (!grant || grant.expiresAt !== null && grant.expiresAt <= now()) fail('TOOL_PERMISSIONS_INVALID')
      return update(revision, current => {
        if (current.grants.some(existing => existing.id === grant.id)) fail('TOOL_PERMISSION_ID_EXISTS')
        if (current.grants.length >= NATIVE_TOOL_PERMISSION_LIMIT) fail('TOOL_PERMISSIONS_CAPACITY')
        return configuration({ schema: 1, grants: [...current.grants, { ...grant, createdAt: now(), revokedAt: null }] })
      }, signal)
    },
    revoke(revision: string, id: string, signal: AbortSignal) {
      if (!isNativeToolPermissionId(id)) fail('TOOL_PERMISSIONS_INVALID')
      return update(revision, current => {
        if (!current.grants.some(grant => grant.id === id)) fail('TOOL_PERMISSION_NOT_FOUND')
        return configuration({ schema: 1, grants: current.grants.map(grant => grant.id === id && grant.revokedAt === null ? { ...grant, revokedAt: now() } : grant) })
      }, signal)
    }
  })
}
