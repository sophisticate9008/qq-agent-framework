import { FrameworkError } from '../core/values.ts'
import { NATIVE_TOOL_PERMISSIONS_PATH, parseNativeToolPermissionRuntime, parseNativeToolPermissionsRequest,
  type NativeToolPermissionRuntime, type NativeToolPermissionsSnapshot } from '../contracts/native-tool-permissions.ts'
import { createNativeToolPermissionsRepository } from '../host/native-tool-permissions.ts'
import { PrivateJsonStorageError } from '../storage/private-json.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

async function operation<Value>(run: () => Promise<Value>): Promise<Value> {
  try { return await run() }
  catch (error) {
    if (error instanceof AdminRequestError) throw error
    if (error instanceof PrivateJsonStorageError) throw new AdminRequestError(error.statusCode, error.code)
    if (error instanceof FrameworkError) {
      if (error.code === 'TOOL_PERMISSIONS_INVALID') throw new AdminRequestError(400, 'invalid_tool_permissions')
      if (error.code === 'TOOL_PERMISSION_NOT_FOUND') throw new AdminRequestError(404, 'tool_permission_not_found')
      if (error.code === 'TOOL_PERMISSION_ID_EXISTS' || error.code === 'TOOL_PERMISSIONS_CAPACITY') throw new AdminRequestError(409, error.code.toLowerCase())
    }
    throw new AdminRequestError(503, 'tool_permissions_unavailable')
  }
}

export function createNativeToolPermissionRoutes(options: {
  readonly directory: string
  readonly runtime?: (revision: string) => NativeToolPermissionRuntime | Promise<NativeToolPermissionRuntime>
  readonly onChanged?: (revision: string) => NativeToolPermissionRuntime | Promise<NativeToolPermissionRuntime>
}): readonly AdminRoute[] {
  const repository = createNativeToolPermissionsRepository(options.directory)
  const unknown: NativeToolPermissionRuntime = { state: 'unknown', appliedRevision: null }
  async function runtime(revision: string, changed = false): Promise<NativeToolPermissionRuntime> {
    const callback = changed ? options.onChanged ?? options.runtime : options.runtime
    if (!callback) return { state: changed ? 'pending' : 'not-running', appliedRevision: null }
    try {
      const result = parseNativeToolPermissionRuntime(await callback(revision))
      return result && (result.state !== 'applied' || result.appliedRevision === revision) ? result : unknown
    } catch { return unknown }
  }
  return Object.freeze([
    { method: 'GET', pathname: NATIVE_TOOL_PERMISSIONS_PATH, maxResponseBytes: 1_048_576,
      async handle({ query }: Parameters<AdminRoute['handle']>[0]): Promise<NativeToolPermissionsSnapshot> {
        if (query.size !== 0) throw new AdminRequestError(400, 'invalid_query')
        return operation(async () => { const document = await repository.read(); return { ...document.configuration, revision: document.revision, runtime: await runtime(document.revision) } })
      } },
    { method: 'POST', pathname: NATIVE_TOOL_PERMISSIONS_PATH, maxRequestBytes: 16_384,
      async handle({ query, body, signal }: Parameters<AdminRoute['handle']>[0]): Promise<NativeToolPermissionsSnapshot> {
        const request = parseNativeToolPermissionsRequest(body)
        if (query.size !== 0 || !request) throw new AdminRequestError(400, 'invalid_tool_permissions')
        return operation(async () => {
          const document = request.action === 'grant' ? await repository.grant(request.revision, request.grant, signal)
            : await repository.revoke(request.revision, request.id, signal)
          // Configuration is committed once. Runtime notification failure does not replay the grant write.
          return { ...document.configuration, revision: document.revision, runtime: await runtime(document.revision, true) }
        })
      } }
  ] as const)
}
