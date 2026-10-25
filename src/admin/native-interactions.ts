import type { NativeInteractions } from '../host/native-interactions.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

function fail(status: number, code: string): never { throw new AdminRequestError(status, code) }
function empty(query: URLSearchParams) { if ([...query.keys()].length > 0) fail(400, 'invalid_query') }

export function createNativeInteractionRoutes(resolve: () => NativeInteractions | undefined): readonly AdminRoute[] {
  function service() {
    const current = resolve()
    if (!current) fail(503, 'native_interactions_unavailable')
    return current
  }
  const routes: AdminRoute[] = [{ method: 'GET', pathname: '/api/chat/interactions', maxResponseBytes: 4_194_304,
    handle({ query }) { empty(query); return service().snapshot() } }]
  return Object.freeze(routes.map(route => Object.freeze(route)))
}
