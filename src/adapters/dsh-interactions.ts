import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { snapshot } from '../core/values.ts'
import type { JsonObject, JsonValue } from '../contracts/data.ts'
import { catalogToken } from './dsh-model-selection.ts'
import { DshAdapterError, type DshInteractionConnectionRequest, type DshInteractionEvent, type DshInteractionResponseRequest, type DshPortResult } from './dsh.ts'
import { dshFailure as failure, dshRecord as record, dshIdentifier as identifier, type DshCallbackBudget } from './dsh-stream-common.ts'

export function createDshInteractionChannel(options: { readonly base: URL; readonly timeoutMs: number; readonly maxPendingEvents: number;
  readonly maxFollows: number; readonly maxBytes: number; readonly lifetime: AbortController; readonly callbacks: DshCallbackBudget;
  readonly authenticate: (signal: AbortSignal, mode: 'answer') => Promise<string>;
  readonly rpc: (method: '$events/result', input: JsonObject, signal: AbortSignal, direct: true) => Promise<DshPortResult<JsonValue>> }) {
  const { base, timeoutMs, maxPendingEvents, maxFollows, maxBytes, lifetime, callbacks, authenticate, rpc } = options
  const interactionSessions = new Map<string, symbol>()
  let interactionConnection: { readonly stop: () => Promise<void>; readonly closeSession: (sessionId: string) => void;
    readonly respond: (request: DshInteractionResponseRequest) => Promise<DshPortResult<JsonValue>> } | undefined
  const rejected = (code: string): DshPortResult<never> => ({ ok: false, error: { code } })
  const connectInteractions = async (request: DshInteractionConnectionRequest): Promise<() => Promise<void>> => {
    if (interactionConnection !== undefined) throw failure('DSH_INTERACTIONS_ALREADY_CONNECTED')
    request.signal.throwIfAborted()
    const controller = new AbortController()
    const signal = AbortSignal.any([request.signal, lifetime.signal, controller.signal])
    const streamId = randomUUID()
    const pending = new Map<string, { readonly event: Exclude<DshInteractionEvent, { type: 'interaction/closed' }>; readonly owner: symbol }>()
    const seen = new Set<string>()
    const queue: DshInteractionEvent[] = []
    let socket: WebSocket | undefined
    let clientId: string | undefined
    let stopped = false
    let pumping: Promise<void> | undefined
    let closing: Promise<void> | undefined
    let openingTimer: ReturnType<typeof setTimeout> | undefined
    let readyResolve: () => void = () => undefined
    let readyReject: (error: Error) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    void ready.catch(() => undefined)
    const deliver = (event: DshInteractionEvent) => callbacks.deliver(event, request.onEvent, request.signal, 'DSH_INTERACTION_BACKPRESSURE')
    const stop = (reason = 'DSH_INTERACTIONS_CLOSED'): Promise<void> => {
      if (closing !== undefined) return closing
      stopped = true
      clearTimeout(openingTimer)
      signal.removeEventListener('abort', abort)
      controller.abort()
      readyReject(failure(reason))
      queue.length = 0
      pending.clear()
      socket?.terminate()
      closing = (async () => {
        await pumping?.catch(() => undefined)
        for (const sessionId of interactionSessions.keys()) {
          await deliver({ type: 'interaction/closed', sessionId, ...(clientId === undefined ? {} : { clientId }), reason }).catch(() => undefined)
        }
        if (interactionConnection === connection) interactionConnection = undefined
      })()
      return closing
    }
    const abort = (): void => { void stop('DSH_INTERACTIONS_ABORTED') }
    const pump = (): void => {
      if (pumping !== undefined || stopped) return
      pumping = (async () => {
        while (!stopped && queue.length > 0) {
          const event = queue.shift()!
          if (event.type !== 'interaction/closed' && (!interactionSessions.has(event.sessionId) || !pending.has(event.eventId))) continue
          await deliver(event)
        }
      })()
      void pumping.then(() => { pumping = undefined; if (queue.length > 0) pump() }, () => {
        pumping = undefined
        void stop('DSH_INTERACTION_CALLBACK_FAILED')
      })
    }
    const enqueue = (event: DshInteractionEvent): void => {
      if (stopped) return
      if (queue.length >= maxPendingEvents) { void stop('DSH_INTERACTION_BACKPRESSURE'); return }
      queue.push(event)
      pump()
    }
    const connection = {
      stop: () => stop(),
      closeSession(sessionId: string): void {
        for (const [eventId, entry] of pending) if (entry.event.sessionId === sessionId) pending.delete(eventId)
        enqueue({ type: 'interaction/closed', sessionId, ...(clientId === undefined ? {} : { clientId }), reason: 'DSH_INTERACTION_SESSION_REMOVED' })
      },
      async respond(response: DshInteractionResponseRequest): Promise<DshPortResult<JsonValue>> {
        response.signal.throwIfAborted()
        const entry = pending.get(response.eventId)
        if (stopped || !entry || response.clientId !== clientId || entry.event.sessionId !== response.sessionId
          || interactionSessions.get(response.sessionId) !== entry.owner) return rejected('DSH_INTERACTION_UNAVAILABLE')
        const outcome = response.outcome
        if (!record(outcome) || outcome.kind !== 'result') return rejected('DSH_INTERACTION_INVALID_RESPONSE')
        let value: JsonValue
        if (entry.event.type === 'approval/requested') {
          if (outcome.value !== 'allowed-once' && outcome.value !== 'rejected') return rejected('DSH_INTERACTION_INVALID_RESPONSE')
          value = outcome.value
        } else {
          const result = outcome.value
          if (!record(result) || !Array.isArray(result.answers) || result.answers.length !== entry.event.questions.length) return rejected('DSH_INTERACTION_INVALID_RESPONSE')
          const questionIds = new Set(entry.event.questions.map(question => record(question) ? question.id : undefined))
          const answers: JsonObject[] = []
          for (const answer of result.answers) {
            if (!record(answer) || !catalogToken(answer.id) || !questionIds.delete(answer.id)
              || !Array.isArray(answer.selected) || answer.selected.length > 64
              || answer.selected.some(selected => typeof selected !== 'string' || selected.length > 8_000)
              || answer.custom !== undefined && (typeof answer.custom !== 'string' || answer.custom.length > 8_000)) return rejected('DSH_INTERACTION_INVALID_RESPONSE')
            answers.push({ id: answer.id, selected: [...answer.selected] as string[], ...(answer.custom === undefined ? {} : { custom: answer.custom }) })
          }
          value = { answers }
        }
        if (JSON.stringify(value).length > 65_536) return rejected('DSH_INTERACTION_INVALID_RESPONSE')
        pending.delete(response.eventId)
        return rpc('$events/result', { clientId: response.clientId, eventId: response.eventId, outcome: { kind: 'result', value } },
          AbortSignal.any([response.signal, signal]), true)
      },
    }
    interactionConnection = connection
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      openingTimer = setTimeout(() => { void stop('DSH_INTERACTION_OPEN_TIMEOUT') }, timeoutMs)
      const credential = await authenticate(signal, 'answer')
      signal.throwIfAborted()
      const url = new URL('api/remote.mux', base)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url, { headers: { cookie: credential }, followRedirects: false, maxPayload: maxBytes, handshakeTimeout: timeoutMs, perMessageDeflate: false })
      socket.on('error', () => { void stop('DSH_INTERACTION_TRANSPORT_UNKNOWN') })
      socket.on('close', () => { void stop('DSH_INTERACTIONS_CLOSED') })
      socket.on('open', () => {
        if (!stopped) socket!.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }))
      })
      socket.on('message', (data, binary) => {
        if (stopped) return
        try {
          if (binary || !Buffer.isBuffer(data) || data.byteLength > maxBytes) throw failure('DSH_INTERACTION_INVALID_FRAME')
          const frame: unknown = JSON.parse(data.toString())
          if (!record(frame)) throw failure('DSH_INTERACTION_INVALID_FRAME')
          if (frame.streamId !== streamId) return
          if (frame.type === 'end' || frame.type === 'error') { void stop('DSH_INTERACTIONS_CLOSED'); return }
          if (frame.type !== 'item' || !record(frame.value)) throw failure('DSH_INTERACTION_INVALID_FRAME')
          const value = frame.value
          if (value.type === 'ready') {
            if (clientId !== undefined || !identifier(value.clientId)) throw failure('DSH_INTERACTION_INVALID_FRAME')
            clientId = value.clientId
            clearTimeout(openingTimer)
            readyResolve()
            return
          }
          if (clientId === undefined) throw failure('DSH_INTERACTION_INVALID_FRAME')
          if (value.type === 'cancel' && identifier(value.eventId)) {
            const entry = pending.get(value.eventId)
            if (entry) {
              pending.delete(value.eventId)
              enqueue({ type: 'interaction/closed', sessionId: entry.event.sessionId, clientId, eventId: value.eventId, reason: 'DSH_INTERACTION_CANCELLED' })
            }
            return
          }
          if (value.type !== 'waterfall' || !identifier(value.agentId)) return
          const owner = interactionSessions.get(value.agentId)
          if (owner === undefined || !['user-questions/request', 'approval/request'].includes(String(value.event))) return
          if (!identifier(value.eventId) || !record(value.request) || JSON.stringify(value.request).length > 65_536) throw failure('DSH_INTERACTION_INVALID_FRAME')
          if (seen.has(value.eventId)) return
          if (pending.size >= maxPendingEvents || seen.size >= maxPendingEvents * 16) throw failure('DSH_INTERACTION_BACKPRESSURE')
          let event: Exclude<DshInteractionEvent, { type: 'interaction/closed' }>
          if (value.event === 'user-questions/request') {
            const questions = value.request.questions
            if (!Array.isArray(questions) || questions.length === 0 || questions.length > 32
              || questions.some(question => !record(question) || !catalogToken(question.id))
              || new Set(questions.map(question => (question as Record<string, unknown>).id)).size !== questions.length) throw failure('DSH_INTERACTION_INVALID_FRAME')
            event = { type: 'question/requested', sessionId: value.agentId, clientId, eventId: value.eventId, questions: snapshot(questions) as JsonValue[] }
          } else {
            const details = value.request
            if (details.toolName !== undefined && !catalogToken(details.toolName)
              || details.callId !== undefined && !catalogToken(details.callId)
              || details.reason !== undefined && (typeof details.reason !== 'string' || details.reason.length > 8_000)) throw failure('DSH_INTERACTION_INVALID_FRAME')
            event = { type: 'approval/requested', sessionId: value.agentId, clientId, eventId: value.eventId,
              ...(typeof details.toolName === 'string' ? { toolName: details.toolName } : {}),
              ...(typeof details.callId === 'string' ? { callId: details.callId } : {}),
              ...(typeof details.reason === 'string' ? { reason: details.reason } : {}) }
          }
          seen.add(value.eventId)
          pending.set(value.eventId, { event, owner })
          enqueue(snapshot(event))
        } catch (error) {
          void stop(error instanceof DshAdapterError ? error.code : 'DSH_INTERACTION_INVALID_FRAME')
        }
      })
      await ready
      signal.throwIfAborted()
      return connection.stop
    } catch (error) {
      await stop('DSH_INTERACTION_CONNECT_FAILED')
      if (error instanceof DshAdapterError) throw error
      throw failure('DSH_INTERACTION_CONNECT_FAILED')
    }
  }

  return Object.freeze({
    registerSession(sessionId: string) {
      if (!identifier(sessionId) || lifetime.signal.aborted) throw failure('DSH_INVALID_SESSION')
      if (interactionSessions.has(sessionId)) throw failure('DSH_INTERACTION_SESSION_REGISTERED')
      if (interactionSessions.size >= maxFollows) throw failure('DSH_INTERACTION_BACKPRESSURE')
      const owner = Symbol()
      interactionSessions.set(sessionId, owner)
      return () => {
        if (interactionSessions.get(sessionId) !== owner) return
        interactionSessions.delete(sessionId)
        interactionConnection?.closeSession(sessionId)
      }
    },
    connect: connectInteractions,
    async respond(request: DshInteractionResponseRequest): Promise<DshPortResult<JsonValue>> {
      if (!interactionConnection) return rejected('DSH_INTERACTION_UNAVAILABLE')
      return interactionConnection.respond(request)
    },
    async close() { await interactionConnection?.stop(); interactionSessions.clear() },
  })
}
