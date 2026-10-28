import { parsePluginSessionManagementRequest, parsePluginSessionSnapshot, parsePluginSessionBinding, parsePluginSessionModels } from '../contracts/plugin-sessions.ts'
import type { PluginModelService } from '../host/plugin-model-service.ts'
import { errorCode } from '../core/values.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

export function createPluginSessionRoutes(options: {
  readonly getService: () => PluginModelService | undefined
  readonly resolveQQ?: (conversationId: string, signal: AbortSignal) => Promise<{ readonly sessionId: string } | null>
}): readonly AdminRoute[] {
  function service(): PluginModelService {
    const service = options.getService()
    if (!service) throw new AdminRequestError(503, 'plugin_sessions_unavailable')
    return service
  }
  function failed(error: unknown, signal: AbortSignal): never {
    if (error instanceof AdminRequestError) throw error
    if (signal.aborted) throw new AdminRequestError(504, 'plugin_session_operation_unknown')
    const code = errorCode(error, 'PLUGIN_SESSION_OPERATION_UNKNOWN')
    throw new AdminRequestError(/INVALID/.test(code) ? 400 : /NOT_FOUND/.test(code) ? 404
      : /CONFLICT|REVISION|BUSY|UNSETTLED|LIMIT/.test(code) ? 409 : /UNKNOWN/.test(code) ? 504 : 503, code.toLowerCase())
  }
  return [{ method: 'GET', pathname: '/api/chat/plugin-sessions', maxResponseBytes: 4_194_304,
    handle({ query }) {
      if (query.size) throw new AdminRequestError(400, 'invalid_plugin_session_query')
      try {
        const result = parsePluginSessionSnapshot({ schema: 1, bindings: service().listBindings() })
        if (!result) throw new AdminRequestError(503, 'plugin_sessions_invalid_state')
        return result
      } catch (error) {
        if (error instanceof AdminRequestError) throw error
        throw new AdminRequestError(503, 'plugin_sessions_unavailable')
      }
    },
  }, { method: 'GET', pathname: '/api/chat/plugin-sessions/models', maxResponseBytes: 1_048_576,
    async handle({ query, signal }) {
      if (query.size) throw new AdminRequestError(400, 'invalid_plugin_session_query')
      try {
        const models = parsePluginSessionModels({ schema: 1, models: await service().models(signal) })
        if (!models) throw new AdminRequestError(503, 'plugin_models_invalid_response')
        return { schema: 1, models }
      } catch (error) { failed(error, signal) }
    },
  }, { method: 'POST', pathname: '/api/chat/plugin-sessions', maxRequestBytes: 8192,
    async handle({ query, body, signal }) {
      const input = parsePluginSessionManagementRequest(body)
      if (query.size || !input) throw new AdminRequestError(400, 'invalid_plugin_session_operation')
      try {
        const target = service()
        const key = { ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }), expectedRevision: input.revision }
        if (input.action === 'unbind') {
          const removed = await target.unbind(input.owner, key, signal)
          if (!removed) throw new AdminRequestError(409, 'plugin_model_binding_conflict')
          return { schema: 1, ok: true, action: input.action, owner: input.owner, name: input.name ?? 'default',
            conversationId: input.conversationId ?? null, historyPreserved: true }
        }
        if (input.action === 'reconcile') {
          const binding = parsePluginSessionBinding(await target.reconcile(input.owner, key, signal))
          if (!binding) throw new AdminRequestError(503, 'plugin_sessions_invalid_state')
          return { schema: 1, ok: true, action: input.action, binding, historyPreserved: true, executionRepeated: false }
        }
        if (input.action === 'bind' && input.qqConversationId !== undefined) {
          if (!options.resolveQQ) throw new AdminRequestError(503, 'plugin_session_qq_lookup_unavailable')
          const source = await options.resolveQQ(input.qqConversationId, signal)
          if (!source || source.sessionId !== input.sessionId) throw new AdminRequestError(409, 'plugin_session_qq_binding_conflict')
        }
        const binding = parsePluginSessionBinding(input.action === 'create'
          ? await target.create(input.owner, { ...key, ...(input.model ? { model: input.model } : {}) }, signal)
          : await target.bind(input.owner, { ...key, sessionId: input.sessionId }, signal))
        if (!binding) throw new AdminRequestError(504, 'plugin_session_operation_unknown')
        return { schema: 1, ok: true, action: input.action, binding, historyPreserved: true }
      } catch (error) { failed(error, signal) }
    },
  }]
}
