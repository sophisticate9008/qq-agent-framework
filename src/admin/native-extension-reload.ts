import { NATIVE_REVISION_PATTERN } from '../contracts/native-revisions.ts'
import { reloadableExtensionErrorCode } from '../contracts/reloadable-extensions.ts'
import { identifier } from '../core/values.ts'
import type { NativeChatRuntime } from '../host/native-chat-runtime.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

export const NATIVE_EXTENSION_RELOAD_PATH = '/api/chat/extensions/reload'

/** Operator maintenance reuses administrator authentication; plugin execution keeps its own policy. */
export function createNativeExtensionReloadRoutes(runtime?: Pick<NativeChatRuntime,
  'extensionStatus' | 'reloadExtension'>): readonly AdminRoute[] {
  return [{ method: 'GET', pathname: NATIVE_EXTENSION_RELOAD_PATH, maxResponseBytes: 131_072,
    handle({ query }) {
      if (query.size !== 0) throw new AdminRequestError(400, 'invalid_extension_query')
      return { schema: 1, items: runtime?.extensionStatus() ?? [] }
    },
  }, { method: 'POST', pathname: NATIVE_EXTENSION_RELOAD_PATH, maxRequestBytes: 4096,
    async handle({ query, body, signal }) {
      if (query.size !== 0 || !body || Object.keys(body).length !== 2 || !identifier(body.id)
        || typeof body.expectedRevision !== 'string' || !NATIVE_REVISION_PATTERN.test(body.expectedRevision)) {
        throw new AdminRequestError(400, 'invalid_extension_reload')
      }
      if (!runtime) throw new AdminRequestError(503, 'extension_runtime_unavailable')
      try {
        return { schema: 1, ...await runtime.reloadExtension(body.id, body.expectedRevision, signal) }
      } catch (failure) {
        if (signal.aborted) throw new AdminRequestError(499, 'request_aborted')
        const code = reloadableExtensionErrorCode(failure)
        throw new AdminRequestError(code === 'EXTENSION_NOT_FOUND' ? 404
          : /CONFLICT|BUSY|DRAINING|CLOSED|LIMIT/.test(code) ? 409 : 503, code.toLowerCase())
      }
    },
  }]
}
