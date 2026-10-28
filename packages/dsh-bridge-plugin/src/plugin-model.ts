import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
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
  settled: boolean
}
export interface UsageStep {
  readonly eventId: string
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly model: string
  readonly usage: Record<string, number>
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const MAX_OWNED_HANDLES = 64
const MAX_RUNS = 256
const MAX_ACTIVE = 32
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
  const allocations = new Set<Promise<AgentHandle>>()
  let closing = false
  const assertOpen = () => { if (closing) throw new TypeError('Plugin model channel is closing') }
  const allocate = async (sessionId: string, signal: AbortSignal, create: () => Promise<AgentHandle>) => {
    assertOpen()
    signal.throwIfAborted()
    if (handles.has(sessionId) || handles.size + allocations.size >= MAX_OWNED_HANDLES) throw new TypeError('Plugin model handle capacity is exhausted')
    // Reserve capacity before any asynchronous creation or model lookup starts.
    const allocation = Promise.resolve().then(async () => {
      signal.throwIfAborted()
      const handle = await create()
      handles.set(sessionId, handle)
      return handle
    })
    allocations.add(allocation)
    try { return await allocation }
    finally { allocations.delete(allocation) }
  }
  const admitRun = (sessionId: string) => {
    assertOpen()
    if (active.has(sessionId) || active.size >= MAX_ACTIVE) throw new TypeError('Plugin model execution capacity is exhausted')
    const previous = runs.get(sessionId)
    if (previous?.settled) runs.delete(sessionId)
    for (const [id, run] of runs) {
      if (runs.size + active.size < MAX_RUNS) break
      if (run.settled) runs.delete(id)
    }
    if (runs.size + active.size >= MAX_RUNS) throw new TypeError('Plugin model run capacity is exhausted')
    active.add(sessionId)
  }
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
          const handle = await allocate(sessionId, signal, () => ctx.agents.resume({ resumeSessionId: SessionId(sessionId), signal,
            agentOptions: { provider: model.provider, model: model.model,
              ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }) } }))
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
      const persistence = ctx.get('sessionPersistence')
      if (!persistence) throw new TypeError('Session persistence is unavailable')
      await allocate(request.sessionId, signal, async () => {
        await verifySelection(model, signal)
        if (ctx.agents.get(SessionId(request.sessionId)) || await persistence.stat(SessionId(request.sessionId), { signal })) throw new TypeError('Plugin session already exists')
        assertOpen()
        return ctx.agents.create({ sessionId: SessionId(request.sessionId), signal,
          agentOptions: { provider: model.provider, model: model.model,
            ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }) },
          setup: (_scope, agent) => {
            agent.session.append('qaf-plugin/session', { owner: request.owner })
            agent.session.append('model/selection', { provider: model.provider, model: model.model,
              ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }) })
          } })
      })
      await persistence.flush()
      return { sessionId: request.sessionId, created: true }
    },
    async start(request: { sessionId: string; requestId: string; owner: string; prompt: string; model?: Selection }, signal: AbortSignal) {
      if (!object(request) || Object.keys(request).some(key => !['sessionId', 'requestId', 'owner', 'prompt', 'model'].includes(key))
        || !identifier(request.sessionId) || !identifier(request.requestId) || !identifier(request.owner)
        || typeof request.prompt !== 'string' || request.prompt.trim() === '' || request.prompt.length > 128_000
        || Buffer.byteLength(request.prompt) > 262_144) throw new TypeError('Invalid plugin model request')
      admitRun(request.sessionId)
      const disposers: (() => void)[] = []
      let handedOff = false
      try {
        const agent = await resolve(request.sessionId, signal)
        const model = request.model === undefined ? undefined : selection(request.model)
        if (model) await verifySelection(model, signal)
        signal.throwIfAborted()
        assertOpen()
        if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new TypeError('Plugin session is not idle')
        const ownContext = agent.session.snapshotEvents().some(event => event.type === 'qaf-plugin/session')
        // restrict() alone masks global tools only. Assembly removes scoped schemas,
        // while the monotonic guard also rejects calls reconstructed from old history.
        disposers.push(agent.ctx.tools.restrict({ allow: [] }))
        disposers.push(agent.ctx.tools.guard(() => 'Plugin generation does not execute tools'))
        disposers.push(agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
          const assembled = await next()
          return { ...assembled, tools: [], ...(ownContext ? { sections: [], contexts: [], variables: {} } : {}) }
        }))
        if (model) disposers.push(agent.ctx.on('agent/request', async (_event, next): Promise<LlmCallConfig> => {
          const current = await next()
          const { reasoningEffort: _previous, ...rest } = current
          return { ...rest, provider: model.provider, model: model.model,
            ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }) }
        }))
        const message = createUserMessage({ source: { kind: 'qaf-plugin', owner: request.owner, requestId: request.requestId }, content: [{ type: 'text',
          text: `本轮来源为插件 ${request.owner} 的文本生成请求。结果返回该插件；本轮没有 QQ 发言者或 QQ 主人身份，工具不可用。\n\n${request.prompt}` }] })
        agent.followup(message)
        let run!: ModelRun
        const idle = agent.whenIdle().finally(async () => {
          try {
            for (const dispose of disposers.reverse()) dispose()
            const handle = handles.get(request.sessionId)
            if (handle?.agent === agent && agent.status === 'idle' && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0) {
              const persistence = ctx.get('sessionPersistence')
              if (!persistence) throw new TypeError('Session persistence is unavailable')
              // Flush before releasing our live handle. The durable session ID,
              // source and transcript remain available for resume and inspection.
              await persistence.flush()
              await handle.dispose()
              if (handles.get(request.sessionId) === handle) handles.delete(request.sessionId)
            }
          } finally {
            active.delete(request.sessionId)
            run.settled = true
          }
        })
        void idle.catch(() => undefined)
        run = { requestId: request.requestId, owner: request.owner, idle, settled: false }
        runs.set(request.sessionId, run)
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
      await ctx.get('sessionPersistence')?.flush()
      return { sessionId: request.sessionId, requestId: request.requestId, idle: true }
    },
    async inspectRun(request: { sessionId: string; requestId: string; owner: string }, signal: AbortSignal) {
      if (!object(request) || Object.keys(request).length !== 3 || !identifier(request.sessionId)
        || !identifier(request.requestId) || !identifier(request.owner)) throw new TypeError('Invalid plugin run inspection')
      const query = ctx.get('sessionQuery')
      if (!query) throw new TypeError('Session query is unavailable')
      const observation = await query.observeSession(SessionId(request.sessionId), { signal })
      try {
        if (observation.events.length > 100_000 || Buffer.byteLength(JSON.stringify(observation.events)) > 16_777_216) throw new TypeError('Plugin session inspection exceeds capacity')
        let currentTurn: number | null = null
        let claimedTurn: number | null = null
        let terminal: Extract<SessionEvent, { type: 'turn/end' }> | undefined
        let validQueue = true
        const pending: Record<'next-turn' | 'next-step', number> = { 'next-turn': 0, 'next-step': 0 }
        for (const event of observation.events) {
          if (event.type === 'turn/start') currentTurn = event.data.turn
          if (event.type === 'user/message' && event.data.source.kind === 'qaf-plugin'
            && event.data.source.owner === request.owner && event.data.source.requestId === request.requestId) claimedTurn = currentTurn
          if (event.type === 'turn/end') {
            if (event.data.turn === claimedTurn) terminal = event
            if (event.data.turn === currentTurn) currentTurn = null
          }
          if (event.type === 'agent/inbox/spliced') {
            const data = event.data
            const removed = data.removedCount ?? 0
            if (!(data.target in pending) || data.start < 0 || data.start > pending[data.target]
              || removed < 0 || removed > pending[data.target] - data.start) validQueue = false
            else pending[data.target] += data.inserted.length - removed
          }
        }
        const live = ctx.agents.get(SessionId(request.sessionId))
        const idle = !active.has(request.sessionId) && validQueue && currentTurn === null
          && pending['next-turn'] === 0 && pending['next-step'] === 0
          && (!live || live.status === 'idle' && live.inbox.nextTurn.length === 0 && live.inbox.nextStep.length === 0)
        const usageSteps: UsageStep[] = []
        let usageComplete = claimedTurn !== null
        if (claimedTurn !== null) for (const event of observation.events) {
          if (event.type !== 'assistant/message' || event.data.turn !== claimedTurn) continue
          const source = event.data.message.source
          const raw = event.data.usage
          if (!raw || source.kind !== 'model' || usageSteps.length >= 256) { usageComplete = false; continue }
          const usage: Record<string, number> = {}
          for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
            const value = raw[key]
            if (value === undefined) continue
            if (!Number.isSafeInteger(value) || value < 0) { usageComplete = false; continue }
            usage[key] = value
          }
          if (usage.cacheReadTokens === undefined) delete usage.inputTokens
          if (usage.cacheReadTokens !== undefined && usage.totalTokens !== undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined
            && usage.totalTokens === usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + (usage.cacheWriteTokens ?? 0)) usage.cacheWriteTokens ??= 0
          usageSteps.push({ eventId: `${event.type}:seq:${event.seq}`, turn: claimedTurn, step: event.data.step,
            provider: source.provider, model: source.model, usage })
        }
        const state: 'running' | 'completed' | 'failed' | 'unknown' = terminal
          ? terminal.data.reason.kind === 'completed' ? 'completed' : 'failed'
          : claimedTurn !== null || active.has(request.sessionId) ? 'running' : 'unknown'
        return { sessionId: request.sessionId, requestId: request.requestId, owner: request.owner, state, idle,
          usage: { usageSteps, usageComplete: usageComplete && usageSteps.length > 0, ...(claimedTurn === null ? {} : { turn: claimedTurn }) } }
      } finally { observation[Symbol.dispose]() }
    },
    async close() {
      closing = true
      await Promise.allSettled([...allocations])
      for (const sessionId of active) ctx.agents.get(SessionId(sessionId))?.cancel({ kind: 'disposed' })
      await Promise.allSettled([...runs.values()].map(run => run.idle))
      const persistence = ctx.get('sessionPersistence')
      if (handles.size && !persistence) throw new TypeError('Session persistence is unavailable')
      await persistence?.flush()
      await Promise.allSettled([...handles.values()].map(handle => handle.dispose()))
      handles.clear(); runs.clear()
    },
  })
}
