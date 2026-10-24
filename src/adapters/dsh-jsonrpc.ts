import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { snapshot } from '../core/values.ts'
import type { JsonObject, JsonValue } from '../core/types.ts'
import type { ChatSessionDefinition } from '../host/chat-plans.ts'
import { buildChatSessionDefinition } from '../host/chat-plans.ts'
import { validateAdapterEndpoint } from '../host/adapter-configuration.ts'
import { DshAdapterError } from './dsh.ts'
import type { DshClientPort, DshCreateSessionRequest, DshFollowEvent, DshFollowRequest, DshPortResult } from './dsh.ts'

export interface DshPresetBinding {
  readonly agentPreset: string
  readonly definition: ChatSessionDefinition
}

export interface DshJsonRpcOptions {
  readonly endpoint: string
  readonly auth: string
  readonly sessionDefinition?: ChatSessionDefinition | ((request: DshCreateSessionRequest) => ChatSessionDefinition)
  readonly presetBindings?: readonly DshPresetBinding[]
  readonly timeoutMs?: number
  readonly followIdleTimeoutMs?: number
  readonly maxPendingEvents?: number
  readonly maxFollows?: number
}

export interface DshJsonRpcPort extends DshClientPort {
  close(): Promise<void>
}

export const DSH_JSONRPC_CAPABILITIES = Object.freeze({
  directSystemInstructions: false,
  agentPreset: true,
  textPromptOnly: true,
  automaticReconnect: false,
  interactionAnswers: false,
})

function failure(code: string): DshAdapterError {
  return new DshAdapterError(code, 'DSH network operation did not complete safely.')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
}

function bound(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) throw failure('DSH_INVALID_OPTIONS')
  return selected
}

function definition(value: ChatSessionDefinition): ChatSessionDefinition {
  try {
    return buildChatSessionDefinition({
      id: value.planId, name: value.planId, description: '', instructions: value.instructions,
      personaId: value.personaId, provider: value.model.provider, model: value.model.name,
      reasoningEffort: value.model.reasoningEffort,
    }, { id: value.personaId, name: value.personaId, identity: value.persona.identity, style: value.persona.style })
  } catch {
    throw failure('DSH_INVALID_SESSION_DEFINITION')
  }
}

function sameDefinition(left: ChatSessionDefinition, right: ChatSessionDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function rejected(code: string): DshPortResult<never> {
  return { ok: false, error: { code } }
}

export function createDshJsonRpcPort(options: DshJsonRpcOptions): DshJsonRpcPort {
  let endpoint: string
  try {
    endpoint = validateAdapterEndpoint(options.endpoint)
    if (endpoint === '') throw failure('DSH_INVALID_OPTIONS')
  } catch {
    throw failure('DSH_INVALID_OPTIONS')
  }
  const base = new URL(endpoint.endsWith('/') ? endpoint : `${endpoint}/`)
  const auth = options.auth
  if (typeof auth !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(auth)) throw failure('DSH_INVALID_OPTIONS')
  let cookie = auth.startsWith('cookie:') ? auth.slice(7) : undefined
  if (cookie !== undefined && !/^[A-Za-z0-9_-]+=[A-Za-z0-9_.~-]+$/.test(cookie)) throw failure('DSH_INVALID_OPTIONS')
  const timeoutMs = bound(options.timeoutMs, 60_000, 300_000)
  const idleMs = bound(options.followIdleTimeoutMs, 300_000, 3_600_000)
  const maxPendingEvents = bound(options.maxPendingEvents, 64, 1_024)
  const maxFollows = bound(options.maxFollows, 16, 128)
  const maxBytes = 1_048_576
  const configuredDefinition = typeof options.sessionDefinition === 'function'
    ? options.sessionDefinition : options.sessionDefinition === undefined ? undefined : definition(options.sessionDefinition)
  const sourceBindings = options.presetBindings ?? []
  if (!Array.isArray(sourceBindings) || sourceBindings.length > 128) throw failure('DSH_INVALID_OPTIONS')
  const presetIds = new Set<string>()
  const bindings = sourceBindings.map(binding => {
    if (!identifier(binding.agentPreset)) throw failure('DSH_INVALID_OPTIONS')
    if (presetIds.has(binding.agentPreset)) throw failure('DSH_INVALID_OPTIONS')
    presetIds.add(binding.agentPreset)
    return { agentPreset: binding.agentPreset, definition: definition(binding.definition) }
  })
  const lifetime = new AbortController()
  const follows = new Map<string, () => Promise<void>>()
  let pendingRpc = 0
  let pendingCallbacks = 0
  let authentication: Promise<string> | undefined

  const limited = async <Value>(operation: (signal: AbortSignal) => Promise<Value>, signal: AbortSignal): Promise<Value> => {
    const deadline = new AbortController()
    const combined = AbortSignal.any([signal, lifetime.signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    try {
      combined.throwIfAborted()
      return await new Promise<Value>((resolve, reject) => {
        const abort = (): void => reject(failure(deadline.signal.aborted ? 'DSH_TIMEOUT' : 'DSH_ABORTED'))
        combined.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(() => {
          combined.throwIfAborted()
          return operation(combined)
        }).then(resolve, reject).finally(() => combined.removeEventListener('abort', abort))
      })
    } catch (error) {
      if (error instanceof DshAdapterError) throw error
      throw failure(combined.aborted ? 'DSH_ABORTED' : 'DSH_TRANSPORT_UNKNOWN')
    } finally {
      clearTimeout(timer)
    }
  }

  const readJson = async (response: Response): Promise<unknown> => {
    const reader = response.body?.getReader()
    if (!reader) throw failure('DSH_INVALID_RESPONSE')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > maxBytes) throw failure('DSH_RESPONSE_TOO_LARGE')
        chunks.push(chunk.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  const authenticate = async (signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    if (cookie !== undefined) return cookie
    if (authentication === undefined) {
      const exchange = limited(async authSignal => {
        const url = new URL('connect', base)
        url.searchParams.set('token', auth)
        url.searchParams.set('interactions', 'none')
        const response = await fetch(url, { redirect: 'manual', signal: authSignal })
        try {
          if (response.status !== 302) throw failure('DSH_AUTH_REJECTED')
          const location = response.headers.get('location')
          if (location === null || new URL(location, url).href !== new URL('api/remote.mux', base).href) {
            throw failure('DSH_AUTH_REJECTED')
          }
          const cookies = response.headers.getSetCookie()
          if (cookies.length !== 1) throw failure('DSH_AUTH_REJECTED')
          const selected = cookies[0]!.split(';', 1)[0]!
          if (!/^[A-Za-z0-9_-]+=[A-Za-z0-9_.~-]+$/.test(selected)) throw failure('DSH_AUTH_REJECTED')
          cookie = selected
          return selected
        } finally {
          await response.body?.cancel().catch(() => undefined)
        }
      }, lifetime.signal)
      authentication = exchange
      void exchange.catch(() => { if (authentication === exchange) authentication = undefined })
    }
    const pending = authentication
    return limited(async () => pending, signal)
  }

  const rpc = async (method: 'session/create' | 'session/selectModel' | 'session/prompt' | 'session/cancel', input: JsonObject, signal: AbortSignal): Promise<DshPortResult<JsonValue>> => {
    if (pendingRpc >= 32) throw failure('DSH_RPC_BACKPRESSURE')
    pendingRpc += 1
    try {
      return await limited(async combined => {
        const credential = await authenticate(combined)
        combined.throwIfAborted()
        const rpcId = randomUUID()
        const response = await fetch(new URL(`api/${method}`, base), {
          method: 'POST', redirect: 'error', signal: combined,
          headers: { 'content-type': 'application/json', cookie: credential },
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request: input } } }),
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw failure(response.status === 401 || response.status === 403 ? 'DSH_AUTH_REJECTED' : 'DSH_HTTP_UNKNOWN')
        }
        const envelope = await readJson(response)
        combined.throwIfAborted()
        if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !record(envelope.result)) {
          throw failure('DSH_INVALID_RESPONSE')
        }
        const result = envelope.result
        if (result.ok === false && record(result.error) && typeof result.error.code === 'string'
          && typeof result.error.message === 'string' && record(result.error.details)) {
          if (!new Set([
            'gateway/bad-request', 'gateway/input-invalid', 'gateway/method-not-found',
            'session/not-found', 'session/agent-busy', 'session/model-unavailable',
            'session/provider-models-unavailable', 'session/provider-credentials-unavailable',
            'session/conflict', 'session/writer-held', 'agent-preset/conflict',
          ]).has(result.error.code)) throw failure('DSH_RPC_UNKNOWN')
          return rejected('DSH_RPC_REJECTED')
        }
        if (result.ok !== true || !Object.hasOwn(result, 'value')) throw failure('DSH_INVALID_RESPONSE')
        return { ok: true, value: snapshot(result.value) as JsonValue }
      }, signal)
    } finally {
      pendingRpc -= 1
    }
  }

  const invokeCallback = async (request: DshFollowRequest, event: DshFollowEvent, signal: AbortSignal): Promise<void> => {
    if (pendingCallbacks >= maxFollows) throw failure('DSH_FOLLOW_BACKPRESSURE')
    pendingCallbacks += 1
    let started = false
    try {
      await limited(async () => {
        started = true
        try { await request.onEvent(event) } finally { pendingCallbacks -= 1 }
      }, signal)
    } finally {
      if (!started) pendingCallbacks -= 1
    }
  }

  const follow = async (request: DshFollowRequest): Promise<() => Promise<void>> => {
    if (!identifier(request.sessionId)) throw failure('DSH_INVALID_SESSION')
    if (follows.has(request.sessionId)) throw failure('DSH_FOLLOW_ALREADY_ACTIVE')
    if (follows.size >= maxFollows || pendingCallbacks >= maxFollows) throw failure('DSH_FOLLOW_BACKPRESSURE')
    const controller = new AbortController()
    const signal = AbortSignal.any([request.signal, lifetime.signal, controller.signal])
    let socket: WebSocket | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let openingTimer: ReturnType<typeof setTimeout> | undefined
    let opened = false
    let stopped = false
    let nextSeq = 0
    let pumping: Promise<void> | undefined
    const queue: DshFollowEvent[] = []
    const streamId = randomUUID()
    let readyResolve: () => void = () => undefined
    let readyReject: (error: Error) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    void ready.catch(() => undefined)
    const stop = async (): Promise<void> => {
      if (!stopped) {
        stopped = true
        queue.length = 0
        clearTimeout(idleTimer)
        clearTimeout(openingTimer)
        signal.removeEventListener('abort', abort)
        controller.abort()
        if (follows.get(request.sessionId) === stop) follows.delete(request.sessionId)
        readyReject(failure('DSH_ABORTED'))
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'cancel', streamId }))
        }
        socket?.terminate()
      }
      await pumping?.catch(() => undefined)
    }
    const fail = (code: string): void => {
      if (stopped) return
      const wasOpened = opened
      readyReject(failure(code))
      void stop().then(async () => {
        if (wasOpened && !request.signal.aborted && !lifetime.signal.aborted && !follows.has(request.sessionId)) {
          await invokeCallback(request, { type: 'stream/error', sessionId: request.sessionId, error: { code } }, request.signal)
        }
      }).catch(() => undefined)
    }
    const abort = (): void => { void stop().catch(() => undefined) }
    const resetIdle = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => fail('DSH_FOLLOW_IDLE_TIMEOUT'), idleMs)
    }
    const pump = (): void => {
      if (pumping !== undefined || stopped) return
      pumping = (async () => {
        while (!stopped && queue.length > 0) {
          await invokeCallback(request, queue.shift()!, signal)
        }
      })()
      void pumping.then(() => { pumping = undefined; if (queue.length > 0) pump() }, () => {
        pumping = undefined
        fail('DSH_FOLLOW_CALLBACK_FAILED')
      })
    }
    follows.set(request.sessionId, stop)
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      openingTimer = setTimeout(() => fail('DSH_FOLLOW_OPEN_TIMEOUT'), timeoutMs)
      const credential = await authenticate(signal)
      signal.throwIfAborted()
      const url = new URL('api/remote.mux', base)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url, { headers: { cookie: credential }, followRedirects: false, maxPayload: maxBytes, handshakeTimeout: timeoutMs, perMessageDeflate: false })
      socket.on('error', () => fail('DSH_FOLLOW_TRANSPORT_UNKNOWN'))
      socket.on('close', () => fail('DSH_FOLLOW_ENDED'))
      socket.on('open', () => {
        if (stopped) return
        socket!.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: request.sessionId } } } } }))
      })
      socket.on('message', (data, binary) => {
        if (stopped) return
        try {
          if (binary || !Buffer.isBuffer(data) || data.byteLength > maxBytes) throw failure('DSH_FOLLOW_INVALID_FRAME')
          const frame: unknown = JSON.parse(data.toString())
          if (!record(frame)) throw failure('DSH_FOLLOW_INVALID_FRAME')
          if (frame.streamId !== streamId) return
          if (frame.type === 'end' || frame.type === 'error') { fail('DSH_FOLLOW_ENDED'); return }
          if (frame.type !== 'item' || !record(frame.value)) throw failure('DSH_FOLLOW_INVALID_FRAME')
          const value = frame.value
          if (!opened) {
            if (value.type !== 'snapshot' || !record(value.header) || value.header.id !== request.sessionId
              || !Number.isSafeInteger(value.cursor) || (value.cursor as number) < -1 || !Array.isArray(value.records)) {
              throw failure('DSH_FOLLOW_INVALID_FRAME')
            }
            nextSeq = (value.cursor as number) + 1
            opened = true
            clearTimeout(openingTimer)
            resetIdle()
            readyResolve()
            return
          }
          if (value.type !== 'event' || !record(value.event)) throw failure('DSH_FOLLOW_INVALID_FRAME')
          const event = value.event
          if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 0 || typeof event.type !== 'string') throw failure('DSH_FOLLOW_INVALID_FRAME')
          const sequence = event.seq as number
          if (sequence < nextSeq) return
          if (sequence !== nextSeq) throw failure('DSH_FOLLOW_SEQUENCE_GAP')
          nextSeq = sequence + 1
          resetIdle()
          if (!record(event.data)) return
          if (queue.length >= maxPendingEvents) throw failure('DSH_FOLLOW_BACKPRESSURE')
          queue.push(snapshot({ type: 'session/event', sessionId: request.sessionId, event: { seq: sequence, type: event.type, data: event.data } }) as DshFollowEvent)
          pump()
        } catch (error) {
          fail(error instanceof DshAdapterError ? error.code : 'DSH_FOLLOW_INVALID_FRAME')
        }
      })
      await ready
      signal.throwIfAborted()
      return stop
    } catch (error) {
      await stop().catch(() => undefined)
      if (error instanceof DshAdapterError) throw error
      throw failure('DSH_FOLLOW_TRANSPORT_UNKNOWN')
    }
  }

  return Object.freeze({
    async createSession(request) {
      request.signal.throwIfAborted()
      if (configuredDefinition === undefined) return rejected('DSH_SESSION_DEFINITION_REQUIRED')
      const selectedDefinition = definition(typeof configuredDefinition === 'function' ? configuredDefinition(request) : configuredDefinition)
      const binding = bindings.find(candidate => sameDefinition(candidate.definition, selectedDefinition))
      if (binding === undefined) return rejected('DSH_INSTRUCTIONS_UNSUPPORTED')
      const created = await rpc('session/create', { agentPreset: binding.agentPreset }, request.signal)
      if (!created.ok) return created
      if (!record(created.value) || !identifier(created.value.sessionId) || created.value.agentPreset !== binding.agentPreset) {
        throw failure('DSH_CREATE_CONFIGURATION_UNKNOWN')
      }
      const sessionId = created.value.sessionId
      const model = selectedDefinition.model
      const selected = await rpc('session/selectModel', { sessionId, provider: model.provider, model: model.name, reasoningEffort: model.reasoningEffort }, request.signal)
      if (!selected.ok || !record(selected.value) || !record(selected.value.selected)
        || selected.value.selected.provider !== model.provider || selected.value.selected.model !== model.name
        || selected.value.selected.reasoningEffort !== model.reasoningEffort) {
        throw failure('DSH_CREATE_CONFIGURATION_UNKNOWN')
      }
      return { ok: true, value: { sessionId } }
    },
    async prompt(request) {
      if (!identifier(request.sessionId) || !identifier(request.requestId) || request.mode !== 'queue'
        || request.content.length === 0 || request.content.length > 8
        || request.content.some(part => part.type !== 'text' || part.text.length > 8_000)
        || !request.content.some(part => part.type === 'text' && part.text.trim().length > 0)) {
        return rejected('DSH_PROMPT_UNSUPPORTED')
      }
      const result = await rpc('session/prompt', { sessionId: request.sessionId, requestId: request.requestId, mode: 'queue', content: request.content.map(part => ({ type: 'text', text: part.type === 'text' ? part.text : '' })) }, request.signal)
      if (result.ok && (!record(result.value) || result.value.accepted !== true)) throw failure('DSH_INVALID_RESPONSE')
      return result
    },
    follow,
    async cancel(request) {
      if (!identifier(request.sessionId)) return rejected('DSH_INVALID_SESSION')
      const result = await rpc('session/cancel', { sessionId: request.sessionId }, request.signal)
      if (result.ok && (!record(result.value) || result.value.accepted !== true)) throw failure('DSH_INVALID_RESPONSE')
      return result
    },
    async close() {
      lifetime.abort()
      await Promise.all([...follows.values()].map(stop => stop()))
    },
  } satisfies DshJsonRpcPort)
}
