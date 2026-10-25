import { NATIVE_WORK_PATH, type NativeWorkReadQuery, type NativeWorkView } from '../contracts/native-work.ts'
import { FrameworkError, reference } from '../core/values.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

function invalid(): never { throw new AdminRequestError(400, 'invalid_work_query') }
async function read<Value>(run: () => Value | Promise<Value>): Promise<Value> {
  try { return await run() }
  catch (error) {
    if (error instanceof AdminRequestError) throw error
    if (error instanceof FrameworkError && error.code === 'INVALID_NATIVE_WORK_INPUT') invalid()
    throw new AdminRequestError(503, 'native_work_history_unavailable')
  }
}

/** Work actions and confirmations belong to QQ; this route exposes persisted evidence only. */
export function createNativeWorkRoutes(options: {
  readonly read: (id: string) => Readonly<NativeWorkView> | null | Promise<Readonly<NativeWorkView> | null>
  readonly list: (query: NativeWorkReadQuery) => { readonly records: readonly NativeWorkView[]; readonly next: string | null }
    | Promise<{ readonly records: readonly NativeWorkView[]; readonly next: string | null }>
}): readonly AdminRoute[] {
  return [{ method: 'GET', pathname: NATIVE_WORK_PATH, maxResponseBytes: 4 * 1024 * 1024,
    handle({ query }) {
      if ([...query.keys()].some(key => !['id', 'conversationId', 'limit', 'after'].includes(key) || query.getAll(key).length !== 1)) invalid()
      const id = query.get('id')
      if (id !== null) {
        if (query.size !== 1 || !reference(id)) invalid()
        return read(async () => {
          const record = await options.read(id)
          if (!record) throw new AdminRequestError(404, 'native_work_not_found')
          return { schema: 1, record }
        })
      }
      const limit = query.get('limit')
      const after = query.get('after')
      const conversationId = query.get('conversationId')
      if (limit !== null && (!/^[1-9][0-9]{0,3}$/.test(limit) || Number(limit) > 1000)
        || after !== null && !reference(after) || conversationId !== null && !reference(conversationId)) invalid()
      return read(async () => ({ schema: 1, ...await options.list({ ...(limit === null ? {} : { limit: Number(limit) }),
        ...(after === null ? {} : { after }), ...(conversationId === null ? {} : { conversationId }) }) }))
    } }]
}
