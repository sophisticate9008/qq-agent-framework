import { createHash, randomUUID } from 'node:crypto'
import { FrameworkError, snapshot } from '../core/values.ts'
import type { AgentEvent, DurableStore, StoredRecord } from '../contracts/ports.ts'
import type { JsonObject, JsonValue } from '../contracts/data.ts'
import { isRecord } from '../contracts/values.ts'
import { parsePluginModelSelection, pluginModelIdentifier } from '../contracts/plugin-model.ts'
import type { PluginModelBackend, PluginModelBinding, PluginModelBindingKey, PluginModelClient, PluginModelRunRequest, PluginModelRunResult,
  PluginModelSelection, PluginModelSessionKey, PluginModelManagedSession } from '../contracts/plugin-model.ts'

const BINDINGS = 'plugin-model.bindings'
const EXECUTIONS = 'plugin-model.executions'
const SESSIONS = 'plugin-model.sessions'
const MAX_BINDINGS = 4096

export interface PluginModelServiceOptions {
  readonly store: DurableStore
  readonly backend: PluginModelBackend
  readonly signal?: AbortSignal
  readonly defaultModel?: PluginModelSelection | (() => PluginModelSelection)
  /** Reserve the concrete session across QQ, assistant and plugin writers for the complete callback. */
  readonly withSessionLease: <Value>(sessionId: string, signal: AbortSignal, operation: () => Promise<Value>) => Promise<Value>
  readonly onUsage?: (event: { readonly owner: string; readonly requestId: string; readonly sessionId: string;
    readonly conversationId: string | null; readonly data: JsonObject }) => void | Promise<void>
}

function failure(code: string): never { throw new FrameworkError(code, '插件模型服务未能安全完成操作。') }
function json(value: unknown): JsonValue { return snapshot(value) as JsonValue }
function keyOf(owner: string, key: PluginModelSessionKey = {}) {
  if (!pluginModelIdentifier(owner)) failure('PLUGIN_MODEL_INVALID_OWNER')
  const name = key.name ?? 'default'
  if (!pluginModelIdentifier(name) || key.conversationId !== undefined && !/^(group|private):[0-9]{1,32}$/.test(key.conversationId)) failure('PLUGIN_MODEL_INVALID_KEY')
  const conversationId = key.conversationId ?? null
  return { owner, name, conversationId, id: createHash('sha256').update(JSON.stringify([owner, name, conversationId])).digest('hex') }
}
function binding(value: unknown, revision: number, busy: boolean): PluginModelBinding {
  if (!isRecord(value) || !pluginModelIdentifier(value.owner) || !pluginModelIdentifier(value.name)
    || value.conversationId !== null && (typeof value.conversationId !== 'string' || !/^(group|private):[0-9]{1,32}$/.test(value.conversationId))
    || !pluginModelIdentifier(value.sessionId) || !['created', 'existing'].includes(String(value.source))
    || !['ready', 'creating', 'unknown'].includes(String(value.state))
    || ![value.createdAt, value.updatedAt].every(time => typeof time === 'number' && Number.isSafeInteger(time) && time >= 0)
    || value.lastUsedAt !== null && (typeof value.lastUsedAt !== 'number' || !Number.isSafeInteger(value.lastUsedAt) || value.lastUsedAt < 0)) failure('PLUGIN_MODEL_INVALID_STATE')
  const model = value.model === null ? null : parsePluginModelSelection(value.model)
  return snapshot({ revision, busy, owner: value.owner, name: value.name, conversationId: value.conversationId, sessionId: value.sessionId,
    source: value.source as PluginModelBinding['source'], state: value.state as PluginModelBinding['state'], model,
    createdAt: Number(value.createdAt), updatedAt: Number(value.updatedAt), lastUsedAt: value.lastUsedAt as number | null })
}

export function createPluginModelService(options: PluginModelServiceOptions) {
  const queues = new Map<string, Promise<void>>()
  const running = new Set<string>()
  const rows = (namespace: string): readonly StoredRecord[] => {
    const entries: StoredRecord[] = []
    let after: string | undefined
    while (entries.length <= MAX_BINDINGS) {
      const limit = Math.min(1000, MAX_BINDINGS + 1 - entries.length)
      const page = options.store.list(namespace, { limit, ...(after ? { after } : {}) })
      entries.push(...page)
      if (page.length < limit || page.length === 0) break
      after = page.at(-1)!.key
    }
    return entries
  }
  const readBinding = (value: unknown, revision: number) => {
    const parsed = binding(value, revision, isRecord(value) && running.has(String(value.sessionId)))
    const execution = options.store.read(EXECUTIONS, parsed.sessionId)
    if (!parsed.busy && execution && (!isRecord(execution.value)
      || !['completed', 'failed', 'rejected'].includes(String(execution.value.state)))) return snapshot({ ...parsed, state: 'unknown' as const })
    return parsed
  }
  const combine = (lifetime: AbortSignal, signal?: AbortSignal) => AbortSignal.any([lifetime, ...(options.signal ? [options.signal] : []), ...(signal ? [signal] : [])])
  const serial = async <Value>(id: string, signal: AbortSignal, operation: () => Promise<Value>): Promise<Value> => {
    signal.throwIfAborted()
    const previous = queues.get(id) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => next)
    queues.set(id, tail)
    try {
      await previous
      signal.throwIfAborted()
      return await operation()
    } finally {
      release()
      if (queues.get(id) === tail) queues.delete(id)
    }
  }
  const read = (owner: string, key: PluginModelSessionKey = {}) => {
    const target = keyOf(owner, key)
    const row = options.store.read(BINDINGS, target.id)
    return { ...target, row, value: row ? readBinding(row.value, row.revision) : null }
  }
  const write = (id: string, value: PluginModelBinding, revision: number | null) => {
    const saved = options.store.write(BINDINGS, id, json(value), { expectedRevision: revision })
    return snapshot({ ...value, revision: saved.revision, busy: running.has(value.sessionId) })
  }
  const listBindings = (owner?: string): readonly PluginModelBinding[] => {
    if (owner !== undefined) keyOf(owner)
    const entries = rows(BINDINGS)
    if (entries.length > MAX_BINDINGS) failure('PLUGIN_MODEL_BINDING_LIMIT')
    return entries.map(row => readBinding(row.value, row.revision))
      .filter(row => owner === undefined || row.owner === owner)
  }
  const compareRevision = (expected: number | null | undefined, actual: number | null) => {
    if (expected !== undefined && (expected !== null && (!Number.isSafeInteger(expected) || expected < 1) || expected !== actual)) failure('PLUGIN_MODEL_BINDING_CONFLICT')
  }
  const selectModel = async (selection: PluginModelSelection | undefined, signal: AbortSignal): Promise<PluginModelSelection> => {
    const selected = selection ?? (typeof options.defaultModel === 'function' ? options.defaultModel() : options.defaultModel)
    const models = await options.backend.models(signal)
    const model = selected ? parsePluginModelSelection(selected) : models[0]
    if (!model || !models.some(candidate => candidate.provider === model.provider && candidate.model === model.model)) failure('PLUGIN_MODEL_UNAVAILABLE')
    return parsePluginModelSelection({ provider: model.provider, model: model.model,
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }) })
  }
  const assertSettled = (sessionId: string) => {
    const previous = options.store.read(EXECUTIONS, sessionId)
    if (previous && (!isRecord(previous.value) || !['completed', 'failed', 'rejected'].includes(String(previous.value.state)))) failure('PLUGIN_MODEL_EXECUTION_UNSETTLED')
  }
  const create = async (owner: string, request: PluginModelBindingKey & { readonly model?: PluginModelSelection }, signal: AbortSignal) => {
    const current = read(owner, request)
    compareRevision(request.expectedRevision, current.row?.revision ?? null)
    if (current.value && running.has(current.value.sessionId)) failure('PLUGIN_MODEL_SESSION_BUSY')
    if (current.value && current.value.state !== 'ready') failure('PLUGIN_MODEL_CREATION_UNSETTLED')
    if (current.value) assertSettled(current.value.sessionId)
    if (listBindings().length >= MAX_BINDINGS && !current.value) failure('PLUGIN_MODEL_BINDING_LIMIT')
    const model = await selectModel(request.model, signal)
    if (rows(SESSIONS).length >= MAX_BINDINGS) failure('PLUGIN_MODEL_SESSION_LIMIT')
    const at = Date.now()
    const prepared: PluginModelBinding = { revision: 0, busy: false, owner, name: current.name, conversationId: current.conversationId,
      sessionId: `qaf-plugin-${randomUUID()}`, source: 'created', model, state: 'creating', createdAt: at, updatedAt: at, lastUsedAt: null }
    const saved = options.store.write(BINDINGS, current.id, json(prepared), { expectedRevision: current.row?.revision ?? null })
    options.store.write(SESSIONS, prepared.sessionId, json({ schema: 1, ...prepared, mode: 'persistent' }), { expectedRevision: null })
    try {
      await options.backend.create({ sessionId: prepared.sessionId, owner, model, signal })
      return write(current.id, { ...prepared, state: 'ready', updatedAt: Date.now() }, saved.revision)
    } catch (error) {
      write(current.id, { ...prepared, state: 'unknown', updatedAt: Date.now() }, saved.revision)
      throw error
    }
  }
  const bind = async (owner: string, request: PluginModelBindingKey & { readonly sessionId: string }, signal: AbortSignal) => {
    if (!pluginModelIdentifier(request.sessionId)) failure('PLUGIN_MODEL_INVALID_SESSION')
    return serial(`binding:${keyOf(owner, request).id}`, signal, async () => {
      const previous = read(owner, request)
      compareRevision(request.expectedRevision, previous.row?.revision ?? null)
      if (previous.value && running.has(previous.value.sessionId)) failure('PLUGIN_MODEL_SESSION_BUSY')
      if (previous.value) assertSettled(previous.value.sessionId)
      return options.withSessionLease(request.sessionId, signal, async () => {
        assertSettled(request.sessionId)
        if (!(await options.backend.inspect(request.sessionId, signal)).exists) failure('PLUGIN_MODEL_SESSION_NOT_FOUND')
        signal.throwIfAborted()
        const at = Date.now()
        return write(previous.id, { revision: 0, busy: false, owner, name: previous.name, conversationId: previous.conversationId, sessionId: request.sessionId,
          source: 'existing', model: null, state: 'ready', createdAt: at, updatedAt: at, lastUsedAt: null }, previous.row?.revision ?? null)
      })
    })
  }
  const unbind = async (owner: string, key: PluginModelBindingKey, signal: AbortSignal) => serial(`binding:${keyOf(owner, key).id}`, signal, async () => {
    const current = read(owner, key)
    compareRevision(key.expectedRevision, current.row?.revision ?? null)
    if (!current.row || !current.value) return false
    if (running.has(current.value.sessionId)) failure('PLUGIN_MODEL_SESSION_BUSY')
    assertSettled(current.value.sessionId)
    return options.store.delete(BINDINGS, current.id, current.row.revision)
  })
  const execute = async (owner: string, target: PluginModelBinding, request: PluginModelRunRequest, signal: AbortSignal): Promise<PluginModelRunResult> => {
    const timeout = request.timeoutMs ?? 300_000
    const maxOutput = request.maxOutputChars ?? 32_000
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 3_600_000 || !Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > 64_000) failure('PLUGIN_MODEL_INVALID_LIMIT')
    const deadline = new AbortController()
    const active = AbortSignal.any([signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(new FrameworkError('PLUGIN_MODEL_TIMEOUT', '插件模型调用超时。')), timeout)
    const requestId = randomUUID()
    try {
      return await serial(`session:${target.sessionId}`, active, () => options.withSessionLease(target.sessionId, active, async () => {
        assertSettled(target.sessionId)
        running.add(target.sessionId)
        let submitted = false
        let text = ''
        let outputExceeded = false
        let stop: (() => void | Promise<void>) | undefined
        let settle!: (event: AgentEvent) => void
        let reject!: (error: unknown) => void
        const terminal = new Promise<AgentEvent>((resolve, fail) => { settle = resolve; reject = fail })
        void terminal.catch(() => undefined)
        const aborted = () => reject(active.reason ?? new FrameworkError('PLUGIN_MODEL_ABORTED', '插件模型调用已停止。'))
        active.addEventListener('abort', aborted, { once: true })
        try {
          active.throwIfAborted()
          if (!(await options.backend.inspect(target.sessionId, active)).exists) failure('PLUGIN_MODEL_SESSION_NOT_FOUND')
          const model = request.model ? await selectModel(request.model, active) : target.model ?? undefined
          stop = await options.backend.follow({ sessionId: target.sessionId, signal: active, onEvent(event) {
            if (!submitted) return
            if (event.type === 'message') {
              text = (event.content ?? []).flatMap(content => content.type === 'text' ? [content.text] : []).join('\n')
              if (text.length > maxOutput || Buffer.byteLength(text) > 262_144) { outputExceeded = true; text = '' }
            }
            if (event.type === 'completed' || event.type === 'failed') settle(event)
            if (event.type === 'approval' || event.type === 'question') reject(new FrameworkError('PLUGIN_MODEL_INTERACTION_FORBIDDEN', '纯模型生成不接收工具审批或提问。'))
          } })
          options.store.write(EXECUTIONS, target.sessionId, json({ schema: 1, owner, requestId, sessionId: target.sessionId,
            conversationId: target.conversationId, state: 'running', startedAt: Date.now() }))
          submitted = true
          const result = await options.backend.start({ sessionId: target.sessionId, requestId, owner, prompt: request.prompt,
            ...(model ? { model } : {}), signal: active })
          if (result.status === 'rejected') {
            options.store.write(EXECUTIONS, target.sessionId, json({ schema: 1, owner, requestId, state: 'rejected', updatedAt: Date.now() }))
            submitted = false
            failure('PLUGIN_MODEL_REJECTED')
          }
          if (result.status !== 'accepted') failure('PLUGIN_MODEL_EXECUTION_UNKNOWN')
          const event = await terminal
          const data = event.data ?? {}
          await options.backend.waitForIdle(target.sessionId, requestId, active)
          options.store.write(EXECUTIONS, target.sessionId, json({ schema: 1, owner, requestId,
            state: event.type, updatedAt: Date.now(), usage: data }))
          submitted = false
          if (options.onUsage) await options.onUsage({ owner, requestId, sessionId: target.sessionId, conversationId: target.conversationId, data })
          if (outputExceeded) failure('PLUGIN_MODEL_OUTPUT_LIMIT')
          if (event.type !== 'completed') failure('PLUGIN_MODEL_FAILED')
          const latest = read(owner, request)
          if (latest.value?.sessionId === target.sessionId && latest.row) write(latest.id,
            { ...latest.value, ...(model ? { model } : {}), updatedAt: Date.now(), lastUsedAt: Date.now() }, latest.row.revision)
          return snapshot({ requestId, sessionId: target.sessionId, text, usage: data })
        } catch (error) {
          if (submitted) options.store.write(EXECUTIONS, target.sessionId, json({ schema: 1, owner, requestId, state: 'unknown', updatedAt: Date.now() }))
          throw error
        } finally {
          active.removeEventListener('abort', aborted)
          await stop?.()
          running.delete(target.sessionId)
        }
      }))
    } finally { clearTimeout(timer) }
  }
  return Object.freeze({
    listBindings,
    listManagedSessions(owner?: string): readonly PluginModelManagedSession[] {
      if (owner !== undefined) keyOf(owner)
      const entries = rows(SESSIONS)
      if (entries.length > MAX_BINDINGS) failure('PLUGIN_MODEL_SESSION_LIMIT')
      return entries.flatMap(row => {
        if (!isRecord(row.value) || !['persistent', 'stateless'].includes(String(row.value.mode))) failure('PLUGIN_MODEL_INVALID_STATE')
        const parsed = binding(row.value, row.revision, false)
        return owner !== undefined && parsed.owner !== owner ? [] : [{ sessionId: parsed.sessionId, owner: parsed.owner,
          name: parsed.name, conversationId: parsed.conversationId, mode: row.value.mode as 'persistent' | 'stateless', createdAt: parsed.createdAt }]
      })
    },
    models(signal: AbortSignal) { return options.backend.models(signal) },
    /** Management callers authenticate separately; owner is an explicit management target. */
    bind(owner: string, request: PluginModelBindingKey & { readonly sessionId: string }, signal: AbortSignal) { return bind(owner, request, signal) },
    unbind(owner: string, key: PluginModelBindingKey, signal: AbortSignal) { return unbind(owner, key, signal) },
    create(owner: string, request: PluginModelBindingKey & { readonly model?: PluginModelSelection }, signal: AbortSignal) {
      return serial(`binding:${keyOf(owner, request).id}`, signal, () => create(owner, request, signal))
    },
    forPlugin(owner: string, lifetime: AbortSignal): PluginModelClient {
      keyOf(owner)
      return Object.freeze<PluginModelClient>({
        models(signal?: AbortSignal) { return options.backend.models(combine(lifetime, signal)) },
        list() { combine(lifetime).throwIfAborted(); return listBindings(owner) },
        bind(request) { return bind(owner, request, combine(lifetime, request.signal)) },
        unbind(key = {}) { return unbind(owner, key, combine(lifetime)) },
        create(request = {}) { const signal = combine(lifetime, request.signal); return serial(`binding:${keyOf(owner, request).id}`, signal, () => create(owner, request, signal)) },
        async run(request) {
          if (typeof request.prompt !== 'string' || request.prompt.trim() === '' || request.prompt.length > 128_000 || Buffer.byteLength(request.prompt) > 262_144
            || request.mode !== undefined && request.mode !== 'persistent' && request.mode !== 'stateless') failure('PLUGIN_MODEL_INVALID_REQUEST')
          const signal = combine(lifetime, request.signal)
          signal.throwIfAborted()
          if (request.mode === 'stateless') {
            const model = await selectModel(request.model, signal)
            if (rows(SESSIONS).length >= MAX_BINDINGS) failure('PLUGIN_MODEL_SESSION_LIMIT')
            const at = Date.now()
            const target: PluginModelBinding = { revision: 0, busy: false, owner, name: request.name ?? 'default', conversationId: request.conversationId ?? null,
              sessionId: `qaf-plugin-${randomUUID()}`, source: 'created', model, state: 'ready', createdAt: at, updatedAt: at, lastUsedAt: null }
            keyOf(owner, request)
            options.store.write(SESSIONS, target.sessionId, json({ schema: 1, ...target, mode: 'stateless' }), { expectedRevision: null })
            await options.backend.create({ sessionId: target.sessionId, owner, model, signal })
            return execute(owner, target, request, signal)
          }
          const target = await serial(`binding:${keyOf(owner, request).id}`, signal, async () => {
            const existing = read(owner, request).value
            if (existing) {
              if (existing.state !== 'ready') failure('PLUGIN_MODEL_CREATION_UNSETTLED')
              return existing
            }
            return create(owner, request, signal)
          })
          return execute(owner, target, request, signal)
        },
      })
    },
  })
}
export type PluginModelService = ReturnType<typeof createPluginModelService>
