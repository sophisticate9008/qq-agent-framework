import { snapshot } from '../core/values.ts'
import type { DshToolCatalog, DshToolCatalogItem } from '../adapters/dsh-tool-catalog.ts'
import { withDeadline } from '../host/deadlines.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

export type NativeToolsSnapshot = DshToolCatalog
export type NativeToolItem = DshToolCatalogItem
export type NativeToolsReader = (signal: AbortSignal) => Promise<NativeToolsSnapshot>

function empty(state: 'not-connected' | 'unavailable'): NativeToolsSnapshot {
  return snapshot<NativeToolsSnapshot>({ state, scope: null, items: [], limited: false,
    missingReasons: [state === 'not-connected' ? 'native_chat_not_running' : 'tool_catalog_unavailable'],
    externalToolAuthorizationVerified: false })
}

export function createNativeToolsRoutes(options: {
  readonly state: () => string
  readonly read?: NativeToolsReader
}): readonly AdminRoute[] {
  let reading = false
  return Object.freeze([Object.freeze({
    method: 'GET' as const, pathname: '/api/chat/tools', maxResponseBytes: 4_194_304,
    async handle({ query, signal }: Parameters<AdminRoute['handle']>[0]): Promise<NativeToolsSnapshot> {
      if ([...query.keys()].length > 0) throw new AdminRequestError(400, 'invalid_query')
      if (options.state() !== 'running') return empty('not-connected')
      const read = options.read
      if (!read || reading) return empty('unavailable')
      try {
        return await withDeadline({ signal, timeoutMs: 5_000, code: 'NATIVE_TOOLS_UNAVAILABLE',
          async run(controlSignal) {
            reading = true
            try {
              const result = await read(controlSignal)
              controlSignal.throwIfAborted()
              if (options.state() !== 'running') return empty('not-connected')
              return snapshot(result)
            } finally { reading = false }
          } })
      } catch {
        if (signal.aborted) throw new AdminRequestError(499, 'request_aborted')
        return empty(options.state() === 'running' ? 'unavailable' : 'not-connected')
      }
    }
  })])
}
