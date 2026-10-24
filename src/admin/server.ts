import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse
} from 'node:http'

const MAX_BODY_BYTES = 32 * 1024
const MAX_HEADER_BYTES = 16 * 1024
const MAX_CACHED_ASSET_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MS = 15 * 1000
const HEADERS_TIMEOUT_MS = 10 * 1000
const SOCKET_TIMEOUT_MS = 20 * 1000
const DEFAULT_HANDLER_TIMEOUT_MS = 10 * 1000
const MIN_HANDLER_TIMEOUT_MS = 10
const MAX_HANDLER_TIMEOUT_MS = 5 * 60 * 1000
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const WEB_ROOT = new URL('../../web/', import.meta.url)
const APP_URL = import.meta.url.endsWith('.ts')
  ? new URL('../../dist/web/app.js', import.meta.url)
  : new URL('../../web/app.js', import.meta.url)

interface StaticAsset {
  readonly url: URL
  readonly type: string
}

export interface AdminServerOptions {
  token: string
  snapshot: (signal?: AbortSignal) => unknown | Promise<unknown>
  dispatchDemo?: (body: Record<string, unknown>, signal?: AbortSignal) => unknown | Promise<unknown>
  routes?: readonly AdminRoute[]
  handlerTimeoutMs?: number
}

export interface AdminRoute {
  readonly method: 'GET' | 'POST'
  readonly pathname: string
  readonly handle: (request: {
    query: URLSearchParams
    body: Record<string, unknown> | null
    signal: AbortSignal
  }) => unknown | Promise<unknown>
}

const STATIC_ROUTES = new Map<string, StaticAsset>([
  ['/', { url: new URL('index.html', WEB_ROOT), type: 'text/html; charset=utf-8' }],
  ['/app.js', { url: APP_URL, type: 'text/javascript; charset=utf-8' }],
  ['/style.css', { url: new URL('style.css', WEB_ROOT), type: 'text/css; charset=utf-8' }]
])

const SECURITY_HEADERS: Readonly<OutgoingHttpHeaders> = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
}

function send(
  response: ServerResponse,
  statusCode: number,
  body: string | Uint8Array,
  contentType = 'application/json; charset=utf-8',
  extraHeaders: OutgoingHttpHeaders = {}
): void {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body)
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': contentType,
    'Content-Length': payload.byteLength
  })
  response.end(payload)
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  extraHeaders: OutgoingHttpHeaders = {}
): void {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('response is not JSON serializable')
  send(response, statusCode, serialized, 'application/json; charset=utf-8', extraHeaders)
}

function sendError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  extraHeaders: OutgoingHttpHeaders = {}
): void {
  sendJson(response, statusCode, { error: code }, extraHeaders)
}

function hasValidBearer(request: IncomingMessage, tokenBuffer: Buffer): boolean {
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice(7))
  return supplied.byteLength === tokenBuffer.byteLength && timingSafeEqual(supplied, tokenBuffer)
}

function hasSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    const parsed = new URL(origin)
    const expected = new URL(`http://${host}`)
    return origin === parsed.origin && parsed.origin === expected.origin
  } catch {
    return false
  }
}

function hasJsonContentType(request: IncomingMessage): boolean {
  const contentType = request.headers['content-type']
  if (typeof contentType !== 'string') return false
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasForbiddenObjectKey(value: unknown): boolean {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    if (!isRecord(current)) continue
    for (const [key, nestedValue] of Object.entries(current)) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) return true
      pending.push(nestedValue)
    }
  }
  return false
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declaredLength = request.headers['content-length']
  if (declaredLength !== undefined) {
    const bytes = Number(declaredLength)
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RequestError(400, 'invalid_request')
    if (bytes > MAX_BODY_BYTES) {
      request.resume()
      throw new RequestError(413, 'request_too_large')
    }
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<unknown>) {
    if (!(chunk instanceof Uint8Array)) throw new RequestError(400, 'invalid_request')
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) throw new RequestError(413, 'request_too_large')
    chunks.push(Buffer.from(chunk))
  }

  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new RequestError(400, 'invalid_json')
  }
  if (!isRecord(value) || hasForbiddenObjectKey(value)) throw new RequestError(400, 'invalid_request')
  return value
}

export class AdminRequestError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string) {
    super(code)
    this.statusCode = statusCode
    this.code = code
  }
}

const RequestError = AdminRequestError

class ClientDisconnectedError extends Error {}

interface HandlerDeadlineOptions<Value> {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly timeoutMs: number
  readonly write: boolean
  readonly handle: (signal: AbortSignal) => Value | Promise<Value>
}

function waitForHandler<Value>({
  request,
  response,
  timeoutMs,
  write,
  handle
}: HandlerDeadlineOptions<Value>): Promise<Value> {
  const controller = new AbortController()
  return new Promise<Value>((resolvePromise, rejectPromise) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout)
      request.off('aborted', disconnect)
      response.off('close', disconnect)
    }
    const resolve = (value: Value): void => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(value)
    }
    const reject = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(error)
    }
    const disconnect = (): void => {
      if (settled) return
      const error = new ClientDisconnectedError('client disconnected')
      controller.abort(error)
      reject(error)
    }

    request.once('aborted', disconnect)
    response.once('close', disconnect)
    timeout = setTimeout(() => {
      const error = new RequestError(504, write ? 'operation_unknown' : 'handler_timeout')
      controller.abort(error)
      reject(error)
    }, timeoutMs)

    if (request.aborted || response.destroyed || response.closed) {
      disconnect()
      return
    }

    Promise.resolve()
      .then(() => handle(controller.signal))
      .then(resolve, reject)
  })
}

async function serveStatic(
  pathname: string,
  response: ServerResponse,
  cache: Map<string, Promise<Buffer>>
): Promise<void> {
  const asset = STATIC_ROUTES.get(pathname)
  if (asset === undefined) {
    sendError(response, 404, 'not_found')
    return
  }
  try {
    let pending = cache.get(pathname)
    if (pending === undefined) {
      pending = readFile(asset.url).then(content => {
        if (content.byteLength > MAX_CACHED_ASSET_BYTES) cache.delete(pathname)
        return content
      }, (error: unknown) => {
        cache.delete(pathname)
        throw error
      })
      cache.set(pathname, pending)
    }
    const content = await pending
    send(response, 200, content, asset.type)
  } catch {
    sendError(response, 500, 'internal_error')
  }
}

export function createAdminServer({
  token,
  snapshot,
  dispatchDemo,
  routes = [],
  handlerTimeoutMs = DEFAULT_HANDLER_TIMEOUT_MS
}: AdminServerOptions): Server {
  if (typeof token !== 'string' || token.length < 24) {
    throw new TypeError('token must contain at least 24 characters')
  }
  if (typeof snapshot !== 'function' || dispatchDemo !== undefined && typeof dispatchDemo !== 'function') {
    throw new TypeError('snapshot and dispatchDemo must be functions')
  }
  if (!Number.isInteger(handlerTimeoutMs)
    || handlerTimeoutMs < MIN_HANDLER_TIMEOUT_MS
    || handlerTimeoutMs > MAX_HANDLER_TIMEOUT_MS) {
    throw new TypeError('handlerTimeoutMs must be an integer between 10 and 300000')
  }

  if (!Array.isArray(routes) || routes.length > 64) throw new TypeError('routes must be a bounded array')
  const extensions = new Map<string, AdminRoute>()
  const methods = new Map<string, string[]>()
  for (const route of routes) {
    if (!/^\/api\/[a-z][a-z0-9/-]{0,127}$/.test(route.pathname) || route.pathname.includes('//')
      || route.pathname === '/api/snapshot' || route.pathname === '/api/demo/events'
      || !['GET', 'POST'].includes(route.method) || typeof route.handle !== 'function'
      || extensions.has(`${route.method} ${route.pathname}`)) throw new TypeError('Invalid or duplicate admin route')
    extensions.set(`${route.method} ${route.pathname}`, Object.freeze({ ...route }))
    methods.set(route.pathname, [...(methods.get(route.pathname) ?? []), route.method])
  }

  const tokenBuffer = Buffer.from(token)
  const staticCache = new Map<string, Promise<Buffer>>()
  const server = createServer({
    connectionsCheckingInterval: 1000,
    headersTimeout: HEADERS_TIMEOUT_MS,
    keepAliveTimeout: 5000,
    maxHeaderSize: MAX_HEADER_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS
  }, async (request, response) => {
    try {
      const requestTarget = request.url ?? '/'
      const queryIndex = requestTarget.indexOf('?')
      const pathname = queryIndex === -1 ? requestTarget : requestTarget.slice(0, queryIndex)

      if (request.method === 'GET' && pathname === '/health') {
        sendJson(response, 200, { ok: true, mode: dispatchDemo ? 'demo' : 'framework' })
        return
      }

      if (request.method === 'GET' && pathname === '/api/snapshot') {
        if (!hasValidBearer(request, tokenBuffer)) {
          sendError(response, 401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' })
          return
        }
        const result = await waitForHandler({
          request,
          response,
          timeoutMs: handlerTimeoutMs,
          write: false,
          handle: signal => snapshot(signal)
        })
        sendJson(response, 200, result)
        return
      }

      if (dispatchDemo && request.method === 'POST' && pathname === '/api/demo/events') {
        if (!hasValidBearer(request, tokenBuffer)) {
          sendError(response, 401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' })
          return
        }
        if (!hasSameOrigin(request)) {
          sendError(response, 403, 'origin_forbidden')
          return
        }
        if (!hasJsonContentType(request)) {
          sendError(response, 415, 'unsupported_media_type')
          return
        }
        const body = await readJsonBody(request)
        const result = await waitForHandler({
          request,
          response,
          timeoutMs: handlerTimeoutMs,
          write: true,
          handle: signal => dispatchDemo(body, signal)
        })
        sendJson(response, 200, result ?? { ok: true })
        return
      }

      const route = extensions.get(`${request.method} ${pathname}`)
      if (route) {
        if (!hasValidBearer(request, tokenBuffer)) {
          sendError(response, 401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' })
          return
        }
        let body: Record<string, unknown> | null = null
        if (route.method === 'POST') {
          if (!hasSameOrigin(request)) { sendError(response, 403, 'origin_forbidden'); return }
          if (!hasJsonContentType(request)) { sendError(response, 415, 'unsupported_media_type'); return }
          body = await readJsonBody(request)
        }
        const result = await waitForHandler({
          request,
          response,
          timeoutMs: handlerTimeoutMs,
          write: route.method === 'POST',
          handle: signal => route.handle({
            query: new URLSearchParams(queryIndex < 0 ? '' : requestTarget.slice(queryIndex + 1)),
            body,
            signal
          })
        })
        const payload = JSON.stringify(result ?? { ok: true })
        if (Buffer.byteLength(payload) > 256 * 1024) throw new RequestError(413, 'response_too_large')
        send(response, 200, payload)
        return
      }
      if (methods.has(pathname)) {
        sendError(response, 405, 'method_not_allowed', { Allow: methods.get(pathname)!.join(', ') })
        return
      }

      if (request.method === 'GET' && STATIC_ROUTES.has(pathname)) {
        await serveStatic(pathname, response, staticCache)
        return
      }

      if (
        pathname === '/health'
        || pathname === '/api/snapshot'
        || dispatchDemo && pathname === '/api/demo/events'
        || STATIC_ROUTES.has(pathname)
      ) {
        sendError(response, 405, 'method_not_allowed', { Allow: pathname === '/api/demo/events' ? 'POST' : 'GET' })
        return
      }

      sendError(response, 404, 'not_found')
    } catch (error: unknown) {
      if (error instanceof ClientDisconnectedError) return
      if (response.destroyed || response.writableEnded || response.closed) return
      if (error instanceof RequestError) {
        sendError(response, error.statusCode, error.code)
        return
      }
      if (!response.headersSent) sendError(response, 500, 'internal_error')
      else response.destroy()
    }
  })
  server.maxHeadersCount = 100
  server.setTimeout(SOCKET_TIMEOUT_MS)
  server.once('close', () => staticCache.clear())
  return server
}
