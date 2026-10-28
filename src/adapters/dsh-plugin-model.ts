import { createDshAdapter, DshAdapterError, type DshClientPort, type DshPortResult } from './dsh.ts'
import { isRecord } from '../contracts/values.ts'
import { parsePluginModelSelection, pluginModelIdentifier } from '../contracts/plugin-model.ts'
import type { PluginModelBackend, PluginModelDescription } from '../contracts/plugin-model.ts'
import type { JsonObject, JsonValue } from '../contracts/data.ts'

export type DshPluginModelMethod = 'bridgePlugin/pluginModels' | 'bridgePlugin/createPluginModelSession'
  | 'bridgePlugin/inspectPluginModelSession' | 'bridgePlugin/startPluginModel' | 'bridgePlugin/waitPluginModelIdle'

export function createDshPluginModelBackend(options: {
  readonly client: DshClientPort
  readonly invoke: (method: DshPluginModelMethod, input: JsonObject, signal: AbortSignal) => Promise<DshPortResult<JsonValue>>
}): PluginModelBackend {
  const adapter = createDshAdapter(options.client)
  const invoke = async (method: DshPluginModelMethod, input: JsonObject, signal: AbortSignal) => {
    const result = await options.invoke(method, input, signal)
    if (!result.ok || !isRecord(result.value)) throw new DshAdapterError('DSH_PLUGIN_MODEL_UNAVAILABLE', 'DSH 插件模型服务不可用。')
    return result.value
  }
  return Object.freeze<PluginModelBackend>({
    async models(signal) {
      const result = await invoke('bridgePlugin/pluginModels', {}, signal)
      if (!Array.isArray(result.models) || result.models.length > 4096) throw new DshAdapterError('DSH_PLUGIN_MODEL_INVALID', 'DSH 模型列表无效。')
      return result.models.map((entry): PluginModelDescription => {
        if (!isRecord(entry) || !pluginModelIdentifier(entry.provider) || !pluginModelIdentifier(entry.model)
          || typeof entry.providerName !== 'string' || entry.providerName.length > 256
          || typeof entry.modelName !== 'string' || entry.modelName.length > 256) throw new DshAdapterError('DSH_PLUGIN_MODEL_INVALID', 'DSH 模型列表无效。')
        return { provider: entry.provider, model: entry.model, providerName: entry.providerName, modelName: entry.modelName }
      })
    },
    async inspect(sessionId, signal) {
      if (!pluginModelIdentifier(sessionId)) throw new TypeError('Invalid session ID')
      const result = await invoke('bridgePlugin/inspectPluginModelSession', { sessionId }, signal)
      if (result.sessionId !== sessionId || typeof result.exists !== 'boolean') throw new DshAdapterError('DSH_PLUGIN_MODEL_INVALID', 'DSH 会话状态无效。')
      return { exists: result.exists }
    },
    async create(request) {
      const result = await invoke('bridgePlugin/createPluginModelSession', { sessionId: request.sessionId, owner: request.owner,
        model: { ...parsePluginModelSelection(request.model) } }, request.signal)
      if (result.sessionId !== request.sessionId || result.created !== true) throw new DshAdapterError('DSH_PLUGIN_MODEL_CREATE_UNKNOWN', 'DSH 插件会话创建结果未知。')
    },
    async start(request) {
      try {
        const result = await options.invoke('bridgePlugin/startPluginModel', { sessionId: request.sessionId, requestId: request.requestId,
          owner: request.owner, prompt: request.prompt, ...(request.model ? { model: { ...parsePluginModelSelection(request.model) } } : {}) }, request.signal)
        if (!result.ok) return { status: 'rejected' }
        return isRecord(result.value) && result.value.accepted === true ? { status: 'accepted' } : { status: 'unknown' }
      } catch { return { status: 'unknown' } }
    },
    follow: request => adapter.follow(request),
    async waitForIdle(sessionId, requestId, signal) {
      const result = await invoke('bridgePlugin/waitPluginModelIdle', { sessionId, requestId }, signal)
      if (result.sessionId !== sessionId || result.requestId !== requestId || result.idle !== true) throw new DshAdapterError('DSH_PLUGIN_MODEL_IDLE_UNKNOWN', 'DSH 插件会话尚未排空。')
    },
    cancel: request => adapter.cancel!(request),
  })
}
