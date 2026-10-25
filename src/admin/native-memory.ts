import { FrameworkError, isRecord } from '../core/values.ts'
import { NATIVE_MEMORY_PATH, validateNativeMemoryScope, type NativeMemoryEntry, type NativeMemoryReadOptions,
  type NativeMemorySnapshot } from '../contracts/native-memory.ts'
import type { NativeMemoryService } from '../host/native-memory.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

function invalid(): never { throw new AdminRequestError(400, 'invalid_memory_request') }
function exact(input: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key)) }
async function operation<Value>(run: () => Value | Promise<Value>, signal?: AbortSignal): Promise<Value> {
  try { return await run() }
  catch (error) {
    if (error instanceof AdminRequestError) throw error
    if (signal?.aborted) throw new AdminRequestError(499, 'request_aborted')
    if (error instanceof FrameworkError) {
      if (error.code === 'MEMORY_NOT_FOUND') throw new AdminRequestError(404, 'memory_not_found')
      if (['MEMORY_CONFLICT', 'STORE_CONFLICT', 'MEMORY_CAPACITY_EXCEEDED', 'MEMORY_SCOPE_CAPACITY_EXCEEDED', 'MEMORY_REVOKED', 'MEMORY_EXPIRED'].includes(error.code))
        throw new AdminRequestError(409, error.code === 'STORE_CONFLICT' ? 'memory_conflict' : error.code.toLowerCase())
      if (['MEMORY_WRITE_UNKNOWN', 'MEMORY_DELETE_UNKNOWN'].includes(error.code)) throw new AdminRequestError(500, error.code.toLowerCase())
      if (['MEMORY_INVALID', 'MEMORY_INVALID_QUERY', 'MEMORY_SCOPE_IMMUTABLE', 'MEMORY_EXPIRY_IN_PAST'].includes(error.code)) invalid()
      if (['MEMORY_OWNER_REQUIRED', 'MEMORY_ACCESS_DENIED', 'NATIVE_CHAT_ACCESS_DENIED'].includes(error.code)) throw new AdminRequestError(403, 'memory_access_denied')
    }
    throw new AdminRequestError(503, 'memory_unavailable')
  }
}

/** Memory configuration is explicit operator data. Model proposals cannot be confirmed through this route. */
export function createNativeMemoryRoutes(options: {
  readonly read: (options: NativeMemoryReadOptions) => NativeMemorySnapshot | Promise<NativeMemorySnapshot>
  readonly entry: (id: string) => NativeMemoryEntry | Promise<NativeMemoryEntry>
  readonly service: () => NativeMemoryService | Promise<NativeMemoryService>
}): readonly AdminRoute[] {
  return Object.freeze([
    { method: 'GET', pathname: NATIVE_MEMORY_PATH, maxResponseBytes: 4_194_304,
      handle({ query }: Parameters<AdminRoute['handle']>[0]) {
        if ([...query.keys()].some(key => !['id', 'scope', 'conversationId', 'userId', 'limit', 'after'].includes(key) || query.getAll(key).length !== 1)) invalid()
        const id = query.get('id')
        if (id !== null) { if (query.size !== 1) invalid(); return operation(() => options.entry(id)) }
        const scope = query.get('scope')
        let target: NativeMemoryReadOptions['scope']
        try {
          if (scope !== null) target = validateNativeMemoryScope(scope === 'global' ? { kind: 'global' }
            : scope === 'group' ? { kind: 'group', conversationId: query.get('conversationId') }
              : { kind: scope, conversationId: query.get('conversationId'), userId: query.get('userId') })
        } catch { invalid() }
        if ((scope === null || scope === 'global') && (query.has('conversationId') || query.has('userId')) || scope === 'group' && query.has('userId')) invalid()
        const limit = query.get('limit')
        if (limit !== null && (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 256)) invalid()
        return operation(() => options.read({ ...(target === undefined ? {} : { scope: target }),
          ...(limit === null ? {} : { limit: Number(limit) }), ...(query.has('after') ? { after: query.get('after')! } : {}) }))
      } },
    { method: 'POST', pathname: NATIVE_MEMORY_PATH, maxRequestBytes: 32_768,
      async handle({ query, body, signal }: Parameters<AdminRoute['handle']>[0]) {
        if (query.size !== 0 || !isRecord(body)) invalid()
        const authority = { kind: 'operator' as const }
        if (body.action === 'create' && exact(body, ['action', 'entry']))
          return operation(async () => (await options.service()).createConfirmed(body.entry, authority, signal), signal)
        if (body.action === 'purge-expired' && (exact(body, ['action']) || exact(body, ['action', 'limit']))) {
          if (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isSafeInteger(body.limit))) invalid()
          const limit = body.limit as number | undefined
          return operation(async () => (await options.service()).purgeExpired(authority, signal, limit), signal)
        }
        if (typeof body.id !== 'string' || typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision)) invalid()
        const { id, revision } = body
        if (body.action === 'correct' && exact(body, ['action', 'id', 'revision', 'entry']))
          return operation(async () => (await options.service()).correct(id, revision, body.entry, authority, signal), signal)
        if (body.action === 'revoke' && exact(body, ['action', 'id', 'revision']))
          return operation(async () => (await options.service()).revoke(id, revision, authority, signal), signal)
        if (body.action === 'remove' && exact(body, ['action', 'id', 'revision']))
          return operation(async () => ({ schema: 1, removed: await (await options.service()).remove(id, revision, authority, signal) }), signal)
        invalid()
      } }
  ] as const)
}
