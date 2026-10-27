import { parseNativeToolInventory, type NativeToolInventory } from '../contracts/native-tool-inventory.ts'
import { unavailableToolInventory } from '../adapters/dsh-tool-inventory.ts'
import { withFrameworkToolInventory } from '../host/native-tool-inventory.ts'
import { withDeadline } from '../host/deadlines.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

export type NativeToolInventoryReader = (signal: AbortSignal) => Promise<NativeToolInventory>
export function createNativeToolInventoryRoutes(read?: NativeToolInventoryReader): readonly AdminRoute[] {
  let reading = false
  const unavailable = () => withFrameworkToolInventory(unavailableToolInventory('tool_inventory_unavailable'))
  return [{ method: 'GET', pathname: '/api/chat/tool-inventory', maxResponseBytes: 4_194_304,
    async handle({ query, signal }) {
      if ([...query.keys()].length > 0) throw new AdminRequestError(400, 'invalid_query')
      if (!read || reading) return unavailable()
      reading = true
      try {
        return await withDeadline({ signal, timeoutMs: 5_000, code: 'NATIVE_TOOL_INVENTORY_UNAVAILABLE',
          run: async controlSignal => parseNativeToolInventory(await read(controlSignal)) })
      } catch {
        if (signal.aborted) throw new AdminRequestError(499, 'request_aborted')
        return unavailable()
      } finally { reading = false }
    } }]
}
