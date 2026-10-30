import { createHash, randomUUID } from 'node:crypto'
import { FrameworkError, snapshot } from '../core/values.ts'
import type { AgentEvent, DurableStore, StoredRecord } from '../contracts/ports.ts'
import type { JsonObject, JsonValue } from '../contracts/data.ts'
import { isRecord } from '../contracts/values.ts'
import { parsePluginModelImages, parsePluginModelSelection, pluginModelIdentifier } from '../contracts/plugin-model.ts'
import type { PluginModelBackend, PluginModelBinding, PluginModelBindingKey, PluginModelClient, PluginModelRunRequest, PluginModelRunResult,
  PluginModelSelection, PluginModelSessionKey, PluginModelManagedSession } from '../contracts/plugin-model.ts'

const BINDINGS = 'plugin-model.bindings'
const EXECUTIONS = 'plugin-model.executions'
const SESSIONS = 'plugin-model.sessions'
const MAX_BINDINGS = 4096
const MAX_PENDING = 256
const MAX_PENDING_PER_KEY = 16

export interface PluginModelServiceOptions {
  readonly store: DurableStore
  readonly backend: PluginModelBackend
  readonly signal?: AbortSignal
  readonly defaultModel?: PluginModelSelection | (() => PluginModelSelection)
  readonly isSessionBusy?: (sessionId: string) => boolean
  /** Reserve the concrete session across QQ, assistant and plugin writers for the complete callback. */
  readonly withSessionLease: <Value>(sessionId: string, signal: AbortSignal, operation: () => Promise<Value>) => Promise<Value>
  readonly onUsage?: (event: { readonly owner: string; readonly requestId: string; readonly sessionId: string;
    readonly conversationId: string | null; readonly status: 'completed' | 'failed'; readonly data: JsonObject }) => void | Promise<void>
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
  if (value.contextRestartedFrom !== undefined && !pluginModelIdentifier(value.contextRestartedFrom)) failure('PLUGIN_MODEL_INVALID_STATE')
  const model = value.model === null ? null : parsePluginModelSelection(value.model)
  return snapshot({ revision, busy, owner: value.owner, name: value.name, conversationId: value.conversationId, sessionId: value.sessionId,
    source: value.source as PluginModelBinding['source'], state: value.state as PluginModelBinding['state'], model,
    createdAt: Number(value.createdAt), updatedAt: Number(value.updatedAt), lastUsedAt: value.lastUsedAt as number | null,
    ...(value.contextRestartedFrom === undefined ? {} : { contextRestartedFrom: value.contextRestartedFrom }) })
}

export function createPluginModelService(options: PluginModelServiceOptions) {
  const queues = new Map<string, Promise<void>>()
  const pendingByKey = new Map<string, number>()
  let pending = 0
  const running = new Set<string>()
  const isBusy = (sessionId: string) => running.has(sessionId) || options.isSessionBusy?.(sessionId) === true
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
    const parsed = binding(value, revision, isRecord(value) && isBusy(String(value.sessionId)))
    const execution = options.store.read(EXECUTIONS, parsed.sessionId)
    const locallyRunning = running.has(parsed.sessionId)
    if (execution && (!isRecord(execution.value) || execution.value.state === 'unknown'
      || !locallyRunning && !['completed', 'failed', 'rejected'].includes(String(execution.value.state)))) {
      // Queue busy also includes durable isolation. That isolation must remain
      // visible and must not disable its own read-only reconciliation entry.
      return snapshot({ ...parsed, state: 'unknown' as const, busy: locallyRunning })
    }
    return parsed
  }
  const combine = (lifetime: AbortSignal, signal?: AbortSignal) => AbortSignal.any([lifetime, ...(options.signal ? [options.signal] : []), ...(signal ? [signal] : [])])
  const managementSignal = (signal: AbortSignal) => options.signal ? AbortSignal.any([signal, options.signal]) : signal
  const serial = async <Value>(id: string, signal: AbortSignal, operation: () => Promise<Value>): Promise<Value> => {
    signal.throwIfAborted()
    const queued = pendingByKey.get(id) ?? 0
    if (pending >= MAX_PENDING || queued >= MAX_PENDING_PER_KEY) failure('PLUGIN_MODEL_QUEUE_FULL')
    pending++
    pendingByKey.set(id, queued + 1)
    const previous = queues.get(id) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => next)
    queues.set(id, tail)
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new FrameworkError('PLUGIN_MODEL_ABORTED', '插件模型排队已停止。'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    try {
      await Promise.race([previous, cancelled])
      signal.throwIfAborted()
      return await operation()
    } finally {
      signal.removeEventListener('abort', abort)
      release()
      // A cancelled waiter remains in the bounded chain until its predecessor
      // settles. Removing its tail early would let a later writer overtake it.
      void tail.then(() => {
        pending--
        const remaining = (pendingByKey.get(id) ?? 1) - 1
        if (remaining === 0) pendingByKey.delete(id)
        else pendingByKey.set(id, remaining)
        if (queues.get(id) === tail) queues.delete(id)
      })
    }
  }
  const read = (owner: string, key: PluginModelSessionKey = {}) => {
    const target = keyOf(owner, key)
    const row = options.store.read(BINDINGS, target.id)
    return { ...target, row, value: row ? readBinding(row.value, row.revision) : null }
  }
  const write = (id: string, value: PluginModelBinding, revision: number | null) => {
    const saved = options.store.write(BINDINGS, id, json(value), { expectedRevision: revision })
    return snapshot({ ...value, revision: saved.revision, busy: isBusy(value.sessionId) })
  }
  const listBindings = (owner?: string): readonly PluginModelBinding[] => {
    options.signal?.throwIfAborted()
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
    signal.throwIfAborted()
    const model = selected ? parsePluginModelSelection(selected) : models[0]
    if (!model || !models.some(candidate => candidate.provider === model.provider && candidate.model === model.model)) failure('PLUGIN_MODEL_UNAVAILABLE')
    return parsePluginModelSelection({ provider: model.provider, model: model.model,
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }) })
  }
  const assertSettled = (sessionId: string) => {
    const previous = options.store.read(EXECUTIONS, sessionId)
    if (previous && (!isRecord(previous.value) || !['completed', 'failed', 'rejected'].includes(String(previous.value.state)))) failure('PLUGIN_MODEL_EXECUTION_UNSETTLED')
  }
  const create = async (owner: string, request: PluginModelBindingKey & { readonly model?: PluginModelSelection }, signal: AbortSignal, contextRestartedFrom?: string) => {
    const current = read(owner, request)
    compareRevision(request.expectedRevision, current.row?.revision ?? null)
    if (current.value && isBusy(current.value.sessionId)) failure('PLUGIN_MODEL_SESSION_BUSY')
    if (current.value && current.value.state !== 'ready') failure('PLUGIN_MODEL_CREATION_UNSETTLED')
    if (current.value) assertSettled(current.value.sessionId)
    if (listBindings().length >= MAX_BINDINGS && !current.value) failure('PLUGIN_MODEL_BINDING_LIMIT')
    const model = await selectModel(request.model, signal)
    if (rows(SESSIONS).length >= MAX_BINDINGS) failure('PLUGIN_MODEL_SESSION_LIMIT')
    const at = Date.now()
    const prepared: PluginModelBinding = { revision: 0, busy: false, owner, name: current.name, conversationId: current.conversationId,
      sessionId: `qbf-plugin-${randomUUID()}`, source: 'created', model, state: 'creating', createdAt: at, updatedAt: at, lastUsedAt: null,
      ...(contextRestartedFrom === undefined ? {} : { contextRestartedFrom }) }
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
      if (previous.value && isBusy(previous.value.sessionId)) failure('PLUGIN_MODEL_SESSION_BUSY')
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
    if (isBusy(current.value.sessionId)) failure('PLUGIN_MODEL_SESSION_BUSY')
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
          stop = await options.backend.follow({ sessionId: target.sessionId, requestId, owner, signal: active, onEvent(event) {
            if (!submitted) return
            if (event.type === 'message') {
              text = (event.content ?? []).flatMap(content => content.type === 'text' ? [content.text] : []).join('\n')
              if (text.length > maxOutput || Buffer.byteLength(text) > 262_144) { outputExceeded = true; text = '' }
            }
            if (event.type === 'failed' && event.data?.terminal === true) reject(new FrameworkError('PLUGIN_MODEL_EXECUTION_UNKNOWN', '插件模型事件连接中断，执行结果尚未确认。'))
            else if (event.type === 'completed' || event.type === 'failed') settle(event)
            if (event.type === 'approval' || event.type === 'question') reject(new FrameworkError('PLUGIN_MODEL_INTERACTION_FORBIDDEN', '纯模型生成不接收工具审批或提问。'))
          } })
          options.store.write(EXECUTIONS, target.sessionId, json({ schema: 1, owner, requestId, sessionId: target.sessionId,
            conversationId: target.conversationId, state: 'running', startedAt: Date.now() }))
          submitted = true
          const result = await options.backend.start({ sessionId: target.sessionId, requestId, owner, prompt: request.prompt,
            ...(request.images ? { images: request.images } : {}),
            ...(model ? { model } : {}), signal: active })
          if (result.status === 'rejected') {
            options.store.write(EXECUTIONS, target.sessionId, json({ schema: 1, owner, requestId, state: 'rejected', code: result.code ?? 'PLUGIN_MODEL_REJECTED', updatedAt: Date.now() }))
            submitted = false
            failure(result.code ?? 'PLUGIN_MODEL_REJECTED')
          }
          if (result.status !== 'accepted') failure('PLUGIN_MODEL_EXECUTION_UNKNOWN')
          const event = await terminal
          const data = event.data ?? {}
          await options.backend.waitForIdle(target.sessionId, requestId, active)
          options.store.write(EXECUTIONS, target.sessionId, json({ schema: 1, owner, requestId,
            state: event.type, updatedAt: Date.now(), usage: data }))
          submitted = false
          if (options.onUsage) await options.onUsage({ owner, requestId, sessionId: target.sessionId, conversationId: target.conversationId,
            status: event.type === 'completed' ? 'completed' : 'failed', data })
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
      options.signal?.throwIfAborted()
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
    models(callerSignal: AbortSignal) {
      const signal = managementSignal(callerSignal)
      signal.throwIfAborted()
      return options.backend.models(signal)
    },
    /** Read exact request evidence only; reconciliation never dispatches another model turn. */
    reconcile(owner: string, key: PluginModelBindingKey, callerSignal: AbortSignal): Promise<PluginModelBinding> {
      const signal = managementSignal(callerSignal)
      return serial(`binding:${keyOf(owner, key).id}`, signal, async () => {
        const current = read(owner, key)
        compareRevision(key.expectedRevision, current.row?.revision ?? null)
        if (!current.value || !current.row) failure('PLUGIN_MODEL_BINDING_NOT_FOUND')
        // A durable unknown barrier is exactly what reconciliation observes.
        // Only this service's active caller must finish before it can be read.
        if (running.has(current.value.sessionId)) failure('PLUGIN_MODEL_SESSION_BUSY')
        const previous = options.store.read(EXECUTIONS, current.value.sessionId)
        if (previous) {
          if (!isRecord(previous.value) || !pluginModelIdentifier(previous.value.requestId) || !pluginModelIdentifier(previous.value.owner)
            || !['running', 'unknown', 'completed', 'failed', 'rejected'].includes(String(previous.value.state))) failure('PLUGIN_MODEL_INVALID_STATE')
          if (['running', 'unknown'].includes(String(previous.value.state))) {
            const observed = await options.backend.inspectRun({ sessionId: current.value.sessionId, requestId: previous.value.requestId,
              owner: previous.value.owner, signal })
            if (!observed.idle || !['completed', 'failed'].includes(observed.state)) return current.value
            signal.throwIfAborted()
            if (options.onUsage) await options.onUsage({ owner: previous.value.owner, requestId: previous.value.requestId,
              sessionId: current.value.sessionId, conversationId: current.value.conversationId,
              status: observed.state === 'completed' ? 'completed' : 'failed', data: observed.usage })
            signal.throwIfAborted()
            options.store.write(EXECUTIONS, current.value.sessionId, json({ ...previous.value, state: observed.state,
              usage: observed.usage, reconciledAt: Date.now(), updatedAt: Date.now() }), { expectedRevision: previous.revision })
          }
        }
        if (!(await options.backend.inspect(current.value.sessionId, signal)).exists) return current.value
        signal.throwIfAborted()
        return write(current.id, { ...current.value, state: 'ready', updatedAt: Date.now() }, current.row.revision)
      })
    },
    /** Management callers authenticate separately; owner is an explicit management target. */
    bind(owner: string, request: PluginModelBindingKey & { readonly sessionId: string }, signal: AbortSignal) { return bind(owner, request, managementSignal(signal)) },
    unbind(owner: string, key: PluginModelBindingKey, signal: AbortSignal) { return unbind(owner, key, managementSignal(signal)) },
    create(owner: string, request: PluginModelBindingKey & { readonly model?: PluginModelSelection }, callerSignal: AbortSignal) {
      const signal = managementSignal(callerSignal)
      return serial(`binding:${keyOf(owner, request).id}`, signal, () => create(owner, request, signal))
    },
    forPlugin(owner: string, lifetime: AbortSignal): PluginModelClient {
      combine(lifetime).throwIfAborted()
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
          if (request.images !== undefined) {
            try { request = { ...request, images: parsePluginModelImages(request.images) } }
            catch { failure('PLUGIN_MODEL_INVALID_IMAGES') }
          }
          const signal = combine(lifetime, request.signal)
          signal.throwIfAborted()
          if (request.mode === 'stateless') {
            const model = await selectModel(request.model, signal)
            if (rows(SESSIONS).length >= MAX_BINDINGS) failure('PLUGIN_MODEL_SESSION_LIMIT')
            const at = Date.now()
            const target: PluginModelBinding = { revision: 0, busy: false, owner, name: request.name ?? 'default', conversationId: request.conversationId ?? null,
              sessionId: `qbf-plugin-${randomUUID()}`, source: 'created', model, state: 'ready', createdAt: at, updatedAt: at, lastUsedAt: null }
            keyOf(owner, request)
            options.store.write(SESSIONS, target.sessionId, json({ schema: 1, ...target, mode: 'stateless' }), { expectedRevision: null })
            await options.backend.create({ sessionId: target.sessionId, owner, model, signal })
            return execute(owner, target, request, signal)
          }
          const target = await serial(`binding:${keyOf(owner, request).id}`, signal, async () => {
            const existing = read(owner, request).value
            if (existing) {
              if (existing.state !== 'ready') failure('PLUGIN_MODEL_CREATION_UNSETTLED')
              // Only an explicit absence result permits replacement. Transport
              // errors propagate while preserving the original binding.
              if (!(await options.backend.inspect(existing.sessionId, signal)).exists) {
                return create(owner, { ...request, model: request.model ?? existing.model ?? undefined }, signal, existing.sessionId)
              }
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
