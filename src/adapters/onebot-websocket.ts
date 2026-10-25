import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import type { JsonObject } from '../core/types.ts'
import { normalizeOneBotProtocolEvent, type OneBotProtocolEvent } from './onebot-events.ts'

export interface OneBotWebSocketEventContext {
  readonly selfId: string
  readonly signal: AbortSignal
  readonly receivedAt: number
}

export interface OneBotWebSocketOptions {
  endpoint: string
  accessToken?: string
  accountId?: string
  onEvent?: (event: Readonly<JsonObject>, context: {
    readonly selfId: string
    readonly signal: AbortSignal
    readonly receivedAt: number
  }) => void | Promise<void>
  onProtocolEvent?: (event: Readonly<OneBotProtocolEvent>, context: OneBotWebSocketEventContext) => void | Promise<void>
  connectTimeoutMs?: number
  callbackTimeoutMs?: number
  maxPendingEvents?: number
  maxReconnectAttempts?: number
  reconnectDelayMs?: number
  pingIntervalMs?: number
  pongTimeoutMs?: number
}

export interface OneBotWebSocketStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
  selfId: string | null
  lastError: string | null
  received: number
  dropped: number
}

export type OneBotWebSocketErrorCode =
  | 'onebot_ws_invalid_options' | 'onebot_ws_invalid_endpoint'
  | 'onebot_ws_closed' | 'onebot_ws_aborted' | 'onebot_ws_connect_timeout'
  | 'onebot_ws_connection_failed' | 'onebot_ws_auth_rejected'
  | 'onebot_ws_upgrade_rejected' | 'onebot_ws_login_rejected'
  | 'onebot_ws_invalid_identity' | 'onebot_ws_payload_too_large'
  | 'onebot_ws_callback_timeout' | 'onebot_ws_callback_failed'
  | 'onebot_ws_pong_timeout'

export class OneBotWebSocketError extends Error {
  readonly code: OneBotWebSocketErrorCode

  constructor(code: OneBotWebSocketErrorCode) {
    super(code)
    this.code = code
    this.name = 'OneBotWebSocketError'
  }
}

export interface OneBotWebSocketClient {
  connect(signal?: AbortSignal): Promise<void>
  status(): OneBotWebSocketStatus
  close(): Promise<void>
}

const MAX_PAYLOAD_BYTES = 1024 * 1024

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new OneBotWebSocketError('onebot_ws_invalid_options')
  }
  return result
}

function endpointUrl(endpoint: string): string {
  try {
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || /[\s\\?#]/.test(endpoint)) throw new Error()
    const authority = /^wss?:\/\/([^/]+)/i.exec(endpoint)?.[1]
    if (!authority || authority.includes('@')) throw new Error()
    const url = new URL(endpoint)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error()
    const hostname = authority.startsWith('[')
      ? authority.slice(0, authority.indexOf(']') + 1).toLowerCase()
      : authority.split(':')[0]!.toLowerCase()
    const octets = hostname.split('.')
    const loopback = hostname === 'localhost' || hostname === '[::1]' || (
      octets.length === 4 && octets[0] === '127' &&
      octets.every(octet => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
    )
    if (url.protocol === 'ws:' && !loopback) throw new Error()
    return url.href
  } catch {
    throw new OneBotWebSocketError('onebot_ws_invalid_endpoint')
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function selfIdentifier(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return null
  return Number.isSafeInteger(Number(value)) ? value : null
}

function freezeEvent(event: Record<string, unknown>): Readonly<JsonObject> | null {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: event, depth: 0 }]
  let visited = 0
  while (pending.length > 0) {
    const entry = pending.pop()!
    visited += 1
    if (visited > 65536 || entry.depth > 64) return null
    if (entry.value !== null && typeof entry.value === 'object') {
      Object.freeze(entry.value)
      for (const value of Object.values(entry.value)) pending.push({ value, depth: entry.depth + 1 })
    } else if (typeof entry.value === 'number' && !Number.isFinite(entry.value)) return null
  }
  return event as JsonObject
}

interface Attempt {
  socket: WebSocket
  generation: number
  echo: string
  timer: ReturnType<typeof setTimeout> | undefined
  pingTimer: ReturnType<typeof setTimeout> | undefined
  pongTimer: ReturnType<typeof setTimeout> | undefined
  pingNonce: string | undefined
  authenticated: boolean
}

interface QueuedEvent {
  event: Readonly<JsonObject>
  protocolEvent?: Readonly<OneBotProtocolEvent>
  selfId: string
  generation: number
  receivedAt: number
}

interface Callback {
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
  generation: number
}

export function createOneBotWebSocketClient(options: OneBotWebSocketOptions): OneBotWebSocketClient {
  const endpoint = endpointUrl(options.endpoint)
  const accessToken = options.accessToken
  const onEvent = options.onEvent
  const onProtocolEvent = options.onProtocolEvent
  if ((accessToken !== undefined && (typeof accessToken !== 'string' ||
    accessToken.length > 4096 || !/^[\x21-\x7e]+$/.test(accessToken))) ||
    (onEvent !== undefined && typeof onEvent !== 'function') ||
    (onProtocolEvent !== undefined && typeof onProtocolEvent !== 'function') ||
    options.accountId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.accountId)) {
    throw new OneBotWebSocketError('onebot_ws_invalid_options')
  }
  const connectTimeoutMs = bounded(options.connectTimeoutMs, 5000, 10, 300000)
  const callbackTimeoutMs = bounded(options.callbackTimeoutMs, 30000, 10, 300000)
  const maxPendingEvents = bounded(options.maxPendingEvents, 64, 1, 256)
  const maxReconnectAttempts = bounded(options.maxReconnectAttempts, 8, 0, 8)
  const reconnectDelayMs = bounded(options.reconnectDelayMs, 250, 10, 30000)
  const pingIntervalMs = bounded(options.pingIntervalMs, 30000, 100, 300000)
  const pongTimeoutMs = bounded(options.pongTimeoutMs, 10000, 100, 300000)
  const snapshot: OneBotWebSocketStatus = {
    state: 'disconnected', selfId: null, lastError: null, received: 0, dropped: 0,
  }
  let closed = false
  let generation = 0
  let reconnectAttempts = 0
  let hasConnected = false
  let attempt: Attempt | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let removeAbort: (() => void) | undefined
  let readiness: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | undefined
  let closePromise: Promise<void> | undefined
  let queue: QueuedEvent[] = []
  let callback: Callback | undefined
  let rawPending = 0
  const disposing = new Set<Promise<void>>()

  function ready(): Promise<void> {
    if (!readiness) {
      let resolveReady!: () => void
      let rejectReady!: (error: Error) => void
      const promise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
      readiness = { promise, resolve: resolveReady, reject: rejectReady }
      void promise.catch(() => undefined)
    }
    return readiness!.promise
  }

  function settle(code?: OneBotWebSocketErrorCode): void {
    const pending = readiness
    readiness = undefined
    if (code) pending?.reject(new OneBotWebSocketError(code))
    else pending?.resolve()
  }

  function cancelCallbacks(code: OneBotWebSocketErrorCode): void {
    snapshot.dropped += queue.length
    queue = []
    const running = callback
    callback = undefined
    if (running) {
      clearTimeout(running.timer)
      snapshot.dropped += 1
      running.controller.abort(new OneBotWebSocketError(code))
    }
  }

  function dispose(current: Attempt, graceful = false): void {
    clearTimeout(current.timer)
    clearTimeout(current.pingTimer)
    clearTimeout(current.pongTimer)
    current.pingTimer = undefined
    current.pongTimer = undefined
    current.pingNonce = undefined
    const socket = current.socket
    if (socket.readyState === WebSocket.CLOSED) return
    const disposal = new Promise<void>(resolve => {
      const done = (): void => {
        clearTimeout(timer)
        socket.removeListener('close', done)
        resolve()
      }
      const timer = setTimeout(() => { socket.terminate(); done() }, 250)
      socket.once('close', done)
      if (graceful && socket.readyState === WebSocket.OPEN) socket.close(1000)
      else socket.terminate()
    })
    disposing.add(disposal)
    void disposal.then(() => disposing.delete(disposal))
  }

  function stop(code: OneBotWebSocketErrorCode, state: 'disconnected' | 'error'): void {
    generation += 1
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    removeAbort?.()
    removeAbort = undefined
    const current = attempt
    attempt = undefined
    snapshot.state = state
    snapshot.selfId = null
    snapshot.lastError = code
    settle(code)
    if (current) dispose(current, state === 'disconnected')
    cancelCallbacks(code)
  }

  function pump(): void {
    if (closed || snapshot.state !== 'connected' || callback || !onEvent && !onProtocolEvent || rawPending >= maxPendingEvents) return
    const entry = queue.shift()
    if (!entry) return
    const controller = new AbortController()
    const running: Callback = {
      controller, generation: entry.generation,
      timer: setTimeout(() => finish('onebot_ws_callback_timeout'), callbackTimeoutMs),
    }
    callback = running
    rawPending += 1
    function finish(code?: 'onebot_ws_callback_timeout' | 'onebot_ws_callback_failed'): void {
      if (callback !== running || running.generation !== generation) return
      callback = undefined
      clearTimeout(running.timer)
      if (code) {
        snapshot.dropped += 1
        snapshot.lastError = code
        controller.abort(new OneBotWebSocketError(code))
      }
      pump()
    }
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted && entry.generation === generation && !closed) {
        const context = Object.freeze({ selfId: entry.selfId, signal: controller.signal, receivedAt: entry.receivedAt })
        return entry.protocolEvent ? onProtocolEvent?.(entry.protocolEvent, context) : onEvent?.(entry.event, context)
      }
    }).then(() => { rawPending -= 1; finish(); pump() }, () => {
      rawPending -= 1
      finish('onebot_ws_callback_failed')
      pump()
    })
  }

  function fail(current: Attempt, code: OneBotWebSocketErrorCode, terminal = false): void {
    if (attempt !== current || closed) return
    attempt = undefined
    generation += 1
    snapshot.selfId = null
    snapshot.lastError = code
    dispose(current)
    if (terminal || !hasConnected || reconnectAttempts >= maxReconnectAttempts) {
      stop(code, 'error')
      return
    }
    snapshot.state = 'reconnecting'
    void ready()
    const delay = Math.min(30000, reconnectDelayMs * 2 ** reconnectAttempts)
    reconnectAttempts += 1
    const expectedGeneration = generation
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      if (!closed && generation === expectedGeneration && snapshot.state === 'reconnecting') open()
    }, delay)
    cancelCallbacks(code)
  }

  function isConnected(current: Attempt): boolean {
    return attempt === current && current.generation === generation && !closed &&
      current.authenticated && snapshot.state === 'connected'
  }

  function schedulePing(current: Attempt): void {
    if (!isConnected(current)) return
    current.pingTimer = setTimeout(() => {
      current.pingTimer = undefined
      if (!isConnected(current)) return
      if (current.socket.readyState !== WebSocket.OPEN) {
        fail(current, 'onebot_ws_connection_failed')
        return
      }
      current.pingNonce = `ping-${randomUUID()}`
      current.pongTimer = setTimeout(() => {
        current.pongTimer = undefined
        if (isConnected(current)) fail(current, 'onebot_ws_pong_timeout')
      }, pongTimeoutMs)
      try {
        current.socket.ping(current.pingNonce, undefined, error => {
          if (error) fail(current, 'onebot_ws_connection_failed')
        })
      } catch {
        fail(current, 'onebot_ws_connection_failed')
      }
    }, pingIntervalMs)
  }

  function receive(current: Attempt, data: RawData, binary: boolean): void {
    if (attempt !== current || current.generation !== generation || closed) return
    const size = Array.isArray(data) ? data.reduce((total, chunk) => total + chunk.byteLength, 0) : data.byteLength
    if (size > MAX_PAYLOAD_BYTES) { fail(current, 'onebot_ws_payload_too_large', true); return }
    let value: unknown
    try {
      if (binary) throw new Error()
      const body = Array.isArray(data) ? Buffer.concat(data)
        : data instanceof ArrayBuffer ? Buffer.from(data) : data
      value = JSON.parse(body.toString('utf8')) as unknown
    } catch { snapshot.dropped += 1; return }
    if (!object(value)) { snapshot.dropped += 1; return }
    if (!current.authenticated && value.echo === current.echo) {
      if (value.retcode !== 0 || value.status !== 'ok') { fail(current, 'onebot_ws_login_rejected', true); return }
      const selfId = object(value.data) ? selfIdentifier(value.data.user_id) : null
      if (!selfId) { fail(current, 'onebot_ws_invalid_identity', true); return }
      clearTimeout(current.timer)
      current.timer = undefined
      current.authenticated = true
      snapshot.state = 'connected'
      snapshot.selfId = selfId
      snapshot.lastError = null
      hasConnected = true
      schedulePing(current)
      settle()
      return
    }
    const protocol = value.post_type !== 'message'
    if (protocol && (!onProtocolEvent || !['notice', 'request', 'meta_event'].includes(String(value.post_type)))) return
    snapshot.received += 1
    if (!current.authenticated || selfIdentifier(value.self_id) !== snapshot.selfId || (protocol ? !onProtocolEvent : !onEvent) ||
      queue.length + (callback ? 1 : 0) >= maxPendingEvents || rawPending >= maxPendingEvents) {
      snapshot.dropped += 1
      return
    }
    const receivedAt = Date.now()
    const protocolEvent = protocol ? normalizeOneBotProtocolEvent(value, {
      selfId: snapshot.selfId!, receivedAt, ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
    }) : undefined
    if (protocol && protocolEvent === null) { snapshot.dropped += 1; return }
    const event = protocol ? Object.freeze({}) : freezeEvent(value)
    if (!event) { snapshot.dropped += 1; return }
    queue.push({ event, ...(protocolEvent ? { protocolEvent } : {}), selfId: snapshot.selfId!, generation, receivedAt })
    pump()
  }

  function open(): void {
    const currentGeneration = ++generation
    let socket: WebSocket
    try {
      socket = new WebSocket(endpoint, {
        headers: accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` },
        followRedirects: false, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false,
      })
    } catch {
      stop('onebot_ws_connection_failed', 'error')
      return
    }
    const current: Attempt = {
      socket, generation: currentGeneration, echo: `login-${randomUUID()}`, authenticated: false,
      timer: setTimeout(() => fail(current, 'onebot_ws_connect_timeout'), connectTimeoutMs),
      pingTimer: undefined, pongTimer: undefined, pingNonce: undefined,
    }
    attempt = current
    socket.on('open', () => {
      if (attempt !== current || closed || generation !== currentGeneration) return
      socket.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: current.echo }), error => {
        if (error) fail(current, 'onebot_ws_connection_failed')
      })
    })
    socket.on('message', (data, binary) => receive(current, data, binary))
    socket.on('pong', data => {
      if (!isConnected(current) || current.pingNonce === undefined || data.toString() !== current.pingNonce) return
      clearTimeout(current.pongTimer)
      current.pongTimer = undefined
      current.pingNonce = undefined
      schedulePing(current)
    })
    socket.on('unexpected-response', (_request, response) => {
      response.destroy()
      fail(current, response.statusCode === 401 || response.statusCode === 403
        ? 'onebot_ws_auth_rejected' : 'onebot_ws_upgrade_rejected', true)
    })
    socket.on('error', (error: Error & { code?: string }) => {
      const oversized = error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
      fail(current, oversized ? 'onebot_ws_payload_too_large' : 'onebot_ws_connection_failed', oversized)
    })
    socket.on('close', () => fail(current, 'onebot_ws_connection_failed'))
  }

  return {
    connect(signal) {
      if (closed) return Promise.reject(new OneBotWebSocketError('onebot_ws_closed'))
      if (signal?.aborted) return Promise.reject(new OneBotWebSocketError('onebot_ws_aborted'))
      if (snapshot.state === 'connected') return Promise.resolve()
      if (snapshot.state === 'connecting' || snapshot.state === 'reconnecting') return ready()
      snapshot.state = 'connecting'
      snapshot.lastError = null
      reconnectAttempts = 0
      hasConnected = false
      const promise = ready()
      if (signal) {
        const abort = (): void => stop('onebot_ws_aborted', 'disconnected')
        signal.addEventListener('abort', abort, { once: true })
        removeAbort = () => signal.removeEventListener('abort', abort)
      }
      open()
      return promise
    },
    status: () => ({ ...snapshot }),
    close() {
      if (closePromise) return closePromise
      closePromise = Promise.resolve().then(() => Promise.all([...disposing])).then(() => undefined)
      closed = true
      stop('onebot_ws_closed', 'disconnected')
      snapshot.lastError = null
      return closePromise
    },
  }
}
