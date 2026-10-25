import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { snapshot } from '../core/values.ts'
import { DshAdapterError, type DshFollowRequest, type DshFollowEvent } from './dsh.ts'
import { dshFailure as failure, dshRecord as record, dshIdentifier as identifier, type DshCallbackBudget } from './dsh-stream-common.ts'

export function createDshSessionFollower(options: { readonly base: URL; readonly timeoutMs: number; readonly idleMs: number;
  readonly maxPendingEvents: number; readonly maxFollows: number; readonly maxBytes: number; readonly lifetime: AbortController;
  readonly follows: Map<string, () => Promise<void>>; readonly callbacks: DshCallbackBudget;
  readonly authenticate: (signal: AbortSignal) => Promise<string> }) {
  const { base, timeoutMs, idleMs, maxPendingEvents, maxFollows, maxBytes, lifetime, follows, callbacks, authenticate } = options
  const invokeCallback = (request: DshFollowRequest, event: DshFollowEvent, signal: AbortSignal) =>
    callbacks.deliver(event, request.onEvent, signal, 'DSH_FOLLOW_BACKPRESSURE')
  const follow = async (request: DshFollowRequest): Promise<() => Promise<void>> => {
    if (!identifier(request.sessionId)) throw failure('DSH_INVALID_SESSION')
    if (follows.has(request.sessionId)) throw failure('DSH_FOLLOW_ALREADY_ACTIVE')
    if (follows.size >= maxFollows || callbacks.active >= maxFollows) throw failure('DSH_FOLLOW_BACKPRESSURE')
    const controller = new AbortController()
    const signal = AbortSignal.any([request.signal, lifetime.signal, controller.signal])
    let socket: WebSocket | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let pongTimer: ReturnType<typeof setTimeout> | undefined
    let pendingPing: string | undefined
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
        clearTimeout(pongTimer)
        pendingPing = undefined
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
      if (stopped || !opened || pendingPing !== undefined) return
      idleTimer = setTimeout(() => {
        if (stopped) return
        if (socket?.readyState !== WebSocket.OPEN) { fail('DSH_FOLLOW_ENDED'); return }
        pendingPing = randomUUID()
        pongTimer = setTimeout(() => fail('DSH_FOLLOW_PONG_TIMEOUT'), Math.min(timeoutMs, 10_000))
        try {
          socket.ping(pendingPing, undefined, error => { if (error) fail('DSH_FOLLOW_TRANSPORT_UNKNOWN') })
        } catch { fail('DSH_FOLLOW_TRANSPORT_UNKNOWN') }
      }, idleMs)
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
      socket.on('pong', payload => {
        if (stopped || pendingPing === undefined || payload.toString() !== pendingPing) return
        clearTimeout(pongTimer)
        pendingPing = undefined
        resetIdle()
      })
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

  return follow
}
