import { createDshAdapter, DshAdapterError, type DshClientPort, type DshPortResult, type DshSessionEvent } from './dsh.ts'
import { isRecord } from '../contracts/values.ts'
import { parsePluginModelImages, parsePluginModelSelection, pluginModelIdentifier, PLUGIN_MODEL_REJECTION_CODES } from '../contracts/plugin-model.ts'
import type { PluginModelBackend, PluginModelDescription } from '../contracts/plugin-model.ts'
import type { JsonObject, JsonValue } from '../contracts/data.ts'

export type DshPluginModelMethod = 'bridgePlugin/pluginModels' | 'bridgePlugin/createPluginModelSession'
  | 'bridgePlugin/inspectPluginModelSession' | 'bridgePlugin/startPluginModel' | 'bridgePlugin/waitPluginModelIdle' | 'bridgePlugin/inspectPluginModelRun'

export function createDshPluginModelBackend(options: {
  readonly client: DshClientPort
  readonly invoke: (method: DshPluginModelMethod, input: JsonObject, signal: AbortSignal) => Promise<DshPortResult<JsonValue>>
}): PluginModelBackend {
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
          owner: request.owner, prompt: request.prompt, ...(request.images ? { images: parsePluginModelImages(request.images).map(image => ({ ...image })) } : {}),
          ...(request.model ? { model: { ...parsePluginModelSelection(request.model) } } : {}) }, request.signal)
        if (!result.ok) return { status: 'rejected' }
        const reportedCode = isRecord(result.value) ? result.value.code : undefined
        const code = PLUGIN_MODEL_REJECTION_CODES.find(code => code === reportedCode)
        return isRecord(result.value) && result.value.accepted === true ? { status: 'accepted' }
          : isRecord(result.value) && result.value.accepted === false ? { status: 'rejected',
            ...(code ? { code } : {}) }
          : { status: 'unknown' }
      } catch { return { status: 'unknown' } }
    },
    follow(request) {
      if (!pluginModelIdentifier(request.owner) || !pluginModelIdentifier(request.requestId)) throw new TypeError('Invalid plugin model follow identity')
      let currentTurn: string | number | undefined
      let matchedTurn: string | number | undefined
      let pendingStart: DshSessionEvent | undefined
      const pending: Record<string, boolean[]> = { 'next-turn': [], 'next-step': [] }
      const matchesSource = (message: unknown) => isRecord(message) && isRecord(message.source)
        && message.source.kind === 'qbf-plugin' && message.source.owner === request.owner && message.source.requestId === request.requestId
      const adapter = createDshAdapter({
        createSession: input => options.client.createSession(input), prompt: input => options.client.prompt(input),
        cancel: input => options.client.cancel(input),
        follow: input => options.client.follow({ ...input, async onEvent(frame) {
          if (frame.type === 'stream/error') { await input.onEvent(frame); return }
          if (frame.type !== 'session/event') {
            if (matchedTurn !== undefined) await input.onEvent(frame)
            return
          }
          const { type, data } = frame.event
          if (type === 'turn/start') {
            const turn = data?.turn
            currentTurn = typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0
              || typeof turn === 'string' && turn.length > 0 && turn.length <= 256 ? turn : undefined
            pendingStart = currentTurn === undefined ? undefined : frame
            return
          }
          let claimed = type === 'user/message' && matchesSource(data)
          if (type === 'agent/inbox/spliced' && data && typeof data.target === 'string' && pending[data.target]
            && Number.isSafeInteger(data.start) && Number.isSafeInteger(data.removedCount ?? 0) && Array.isArray(data.inserted)) {
            const queue = pending[data.target]!
            const start = Number(data.start), removed = Number(data.removedCount ?? 0)
            if (start >= 0 && start <= queue.length && removed >= 0 && removed <= queue.length - start) {
              const consumed = queue.splice(start, removed, ...data.inserted.map(matchesSource))
              if (data.outcome !== 'canceled' && consumed.some(Boolean)) claimed = true
            }
          }
          if (claimed && currentTurn !== undefined) {
            matchedTurn = currentTurn
            if (pendingStart) await input.onEvent(pendingStart)
            pendingStart = undefined
            await input.onEvent(frame)
            return
          }
          if (matchedTurn !== undefined && (data?.turn === matchedTurn || type === 'session/error')) await input.onEvent(frame)
        } }),
      })
      return adapter.follow(request)
    },
    async waitForIdle(sessionId, requestId, signal) {
      const result = await invoke('bridgePlugin/waitPluginModelIdle', { sessionId, requestId }, signal)
      if (result.sessionId !== sessionId || result.requestId !== requestId || result.idle !== true) throw new DshAdapterError('DSH_PLUGIN_MODEL_IDLE_UNKNOWN', 'DSH 插件会话尚未排空。')
    },
    async inspectRun(request) {
      const result = await invoke('bridgePlugin/inspectPluginModelRun', { sessionId: request.sessionId, requestId: request.requestId, owner: request.owner }, request.signal)
      if (result.sessionId !== request.sessionId || result.requestId !== request.requestId || result.owner !== request.owner
        || !['running', 'completed', 'failed', 'unknown'].includes(String(result.state)) || typeof result.idle !== 'boolean'
        || !isRecord(result.usage)) throw new DshAdapterError('DSH_PLUGIN_MODEL_INVALID', 'DSH 插件执行状态无效。')
      return { state: result.state as 'running' | 'completed' | 'failed' | 'unknown', idle: result.idle, usage: result.usage as JsonObject }
    },
    cancel: request => createDshAdapter(options.client).cancel!(request),
  })
}
