import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'qaf-plugin': { readonly kind: 'qaf-plugin'; readonly owner: string; readonly requestId: string }
  }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'qaf-plugin/session': { readonly owner: string }
  }
}
interface Selection { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
interface ModelRun {
  readonly requestId: string
  readonly owner: string
  readonly idle: Promise<void>
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function selection(value: unknown): Selection {
  if (!object(value) || !identifier(value.provider) || !identifier(value.model)
    || value.reasoningEffort !== undefined && !identifier(value.reasoningEffort)
    || Object.keys(value).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) throw new TypeError('Invalid plugin model selection')
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) }
}

/** Model-only turns use ordinary durable SDK sessions without any QQ caller identity. */
export function createPluginModelChannel(ctx: Context) {
  const handles = new Map<string, AgentHandle>()
  const runs = new Map<string, ModelRun>()
  const active = new Set<string>()
  const resolve = async (sessionId: string, signal: AbortSignal): Promise<Agent> => {
    const live = ctx.agents.get(SessionId(sessionId))
    if (live) return live
    // Plugin-owned sessions have no workspace and no chat preset. Resume that
    // recorded composition directly; the ordinary controller requires a cwd.
    if (sessionId.startsWith('qaf-plugin-')) {
      const query = ctx.get('sessionQuery')
      if (!query) throw new TypeError('Session query is unavailable')
      const observed = await query.observeSession(SessionId(sessionId), { signal })
      try {
        if (observed.events.some(event => event.type === 'qaf-plugin/session')) {
          const selected = [...observed.events].reverse().find(event => event.type === 'model/selection')
          if (!selected) throw new TypeError('Plugin session model is unavailable')
          const model = selection(selected.data)
          const handle = await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), signal,
            agentOptions: { provider: model.provider, model: model.model,
              ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }) } })
          handles.set(sessionId, handle)
          return handle.agent
        }
      } finally { observed[Symbol.dispose]() }
    }
    const controller = ctx.get('sessionController')
    if (!controller) throw new TypeError('Session controller is unavailable')
    const result = await controller.resolveAgent(SessionId(sessionId))
    if ('error' in result) throw result.error
    return result.agent
  }
  const models = async (signal: AbortSignal) => {
    signal.throwIfAborted()
    const llm = ctx.get('llm')
    if (!llm) throw new TypeError('Model runtime is unavailable')
    const entries: { provider: string; providerName: string; model: string; modelName: string }[] = []
    for (const provider of llm.listProviders()) {
      signal.throwIfAborted()
      for (const model of await llm.listModels(provider.id)) {
        if (entries.length >= 4096) throw new TypeError('Plugin model catalog exceeds capacity')
        if (!identifier(provider.id) || !identifier(model.id)) continue
        entries.push({ provider: provider.id, providerName: provider.name.slice(0, 256), model: model.id, modelName: model.name.slice(0, 256) })
      }
    }
    return { models: entries }
  }
  const verifySelection = async (model: Selection, signal: AbortSignal) => {
    const catalog = await models(signal)
    if (!catalog.models.some(entry => entry.provider === model.provider && entry.model === model.model)) throw new TypeError('Plugin model is not configured')
    await ctx.llm.resolveModelInfo(model.provider, model.model, signal)
  }
  return Object.freeze({
    models,
    async inspect(request: { sessionId: string }, signal: AbortSignal) {
      if (!object(request) || Object.keys(request).length !== 1 || !identifier(request.sessionId)) throw new TypeError('Invalid plugin session ID')
      signal.throwIfAborted()
      if (ctx.agents.get(SessionId(request.sessionId))) return { sessionId: request.sessionId, exists: true }
      const persistence = ctx.get('sessionPersistence')
      if (!persistence) throw new TypeError('Session persistence is unavailable')
      return { sessionId: request.sessionId, exists: Boolean(await persistence.stat(SessionId(request.sessionId), { signal })) }
    },
    async create(request: { sessionId: string; owner: string; model: Selection }, signal: AbortSignal) {
      if (!object(request) || Object.keys(request).some(key => !['sessionId', 'owner', 'model'].includes(key))
        || !identifier(request.sessionId) || !identifier(request.owner)) throw new TypeError('Invalid plugin session creation')
      const model = selection(request.model)
      await verifySelection(model, signal)
      const persistence = ctx.get('sessionPersistence')
      if (!persistence) throw new TypeError('Session persistence is unavailable')
      if (ctx.agents.get(SessionId(request.sessionId)) || await persistence.stat(SessionId(request.sessionId), { signal })) throw new TypeError('Plugin session already exists')
      const handle = await ctx.agents.create({ sessionId: SessionId(request.sessionId), signal,
        agentOptions: { provider: model.provider, model: model.model,
          ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }) },
        setup: (_scope, agent) => {
          agent.session.append('qaf-plugin/session', { owner: request.owner })
          agent.session.append('model/selection', { provider: model.provider, model: model.model,
            ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }) })
        } })
      handles.set(request.sessionId, handle)
      await persistence.flush()
      return { sessionId: request.sessionId, created: true }
    },
    async start(request: { sessionId: string; requestId: string; owner: string; prompt: string; model?: Selection }, signal: AbortSignal) {
      if (!object(request) || Object.keys(request).some(key => !['sessionId', 'requestId', 'owner', 'prompt', 'model'].includes(key))
        || !identifier(request.sessionId) || !identifier(request.requestId) || !identifier(request.owner)
        || typeof request.prompt !== 'string' || request.prompt.trim() === '' || request.prompt.length > 128_000
        || Buffer.byteLength(request.prompt) > 262_144) throw new TypeError('Invalid plugin model request')
      if (active.has(request.sessionId)) throw new TypeError('Plugin session is busy')
      active.add(request.sessionId)
      const disposers: (() => void)[] = []
      let handedOff = false
      try {
        const agent = await resolve(request.sessionId, signal)
        const model = request.model === undefined ? undefined : selection(request.model)
        if (model) await verifySelection(model, signal)
        signal.throwIfAborted()
        if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new TypeError('Plugin session is not idle')
        // restrict() alone masks global tools only. Assembly removes scoped schemas,
        // while the monotonic guard also rejects calls reconstructed from old history.
        disposers.push(agent.ctx.tools.restrict({ allow: [] }))
        disposers.push(agent.ctx.tools.guard(() => 'Plugin generation does not execute tools'))
        disposers.push(agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({ ...await next(), tools: [] })))
        if (model) disposers.push(agent.ctx.on('agent/request', async (_event, next): Promise<LlmCallConfig> => {
          const current = await next()
          const { reasoningEffort: _previous, ...rest } = current
          return { ...rest, provider: model.provider, model: model.model,
            ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }) }
        }))
        const message = createUserMessage({ source: { kind: 'qaf-plugin', owner: request.owner, requestId: request.requestId }, content: [{ type: 'text',
          text: `本轮来源为插件 ${request.owner} 的文本生成请求。结果返回该插件；本轮没有 QQ 发言者或 QQ 主人身份，工具不可用。\n\n${request.prompt}` }] })
        agent.followup(message)
        const idle = agent.whenIdle().finally(() => {
          for (const dispose of disposers.reverse()) dispose()
          active.delete(request.sessionId)
        })
        void idle.catch(() => undefined)
        runs.set(request.sessionId, { requestId: request.requestId, owner: request.owner, idle })
        handedOff = true
        return { accepted: true }
      } finally {
        if (!handedOff) {
          for (const dispose of disposers.reverse()) dispose()
          active.delete(request.sessionId)
        }
      }
    },
    async waitIdle(request: { sessionId: string; requestId: string }, signal: AbortSignal) {
      if (!object(request) || Object.keys(request).length !== 2 || !identifier(request.sessionId) || !identifier(request.requestId)) throw new TypeError('Invalid plugin model run')
      const run = runs.get(request.sessionId)
      if (!run || run.requestId !== request.requestId) throw new TypeError('Plugin model run is unknown')
      await run.idle
      signal.throwIfAborted()
      return { sessionId: request.sessionId, requestId: request.requestId, idle: true }
    },
    async close() {
      for (const sessionId of active) ctx.agents.get(SessionId(sessionId))?.cancel({ kind: 'disposed' })
      await Promise.allSettled([...runs.values()].map(run => run.idle))
      await Promise.allSettled([...handles.values()].map(handle => handle.dispose()))
      handles.clear(); runs.clear()
    },
  })
}
