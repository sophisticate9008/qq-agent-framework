import assert from 'node:assert/strict'
import filesystem, { readFile } from 'node:fs/promises'
import {
  request,
  type ClientRequestArgs,
  type IncomingHttpHeaders,
  type Server
} from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { createConnection } from 'node:net'
import test from 'node:test'

import { createAdminServer, AdminRequestError, type AdminServerOptions, type AdminRoute } from '../src/admin/server.ts'

const TOKEN = 'admin-test-token-1234567890'

interface StartOptions {
  snapshot?: () => unknown | Promise<unknown>
  dispatchDemo?: (body: Record<string, unknown>) => unknown | Promise<unknown>
  routes?: readonly AdminRoute[]
}

interface Fixture {
  server: Server
  calls: Array<Record<string, unknown>>
  origin: string
}

interface RawRequestOptions extends Omit<ClientRequestArgs, 'hostname' | 'path' | 'port' | 'protocol'> {
  body?: string | Buffer
  chunks?: ReadonlyArray<string | Buffer>
}

interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  text: string
}

async function start(options: StartOptions = {}): Promise<Fixture> {
  const calls: Array<Record<string, unknown>> = []
  const server = createAdminServer({
    token: TOKEN,
    routes: options.routes,
    snapshot: options.snapshot ?? (() => ({ overview: { mode: 'demo' }, features: [] })),
    dispatchDemo: options.dispatchDemo ?? (body => {
      calls.push(body)
      return { accepted: true }
    })
  })
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => rejectPromise(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolvePromise()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Admin server has no TCP address')
  return {
    server,
    calls,
    origin: `http://127.0.0.1:${address.port}`
  }
}

async function stop(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close(error => {
      if (error) rejectPromise(error)
      else resolvePromise()
    })
  })
}

async function rawRequest(origin: string, path: string, options: RawRequestOptions = {}): Promise<RawResponse> {
  const url = new URL(origin)
  const { body, chunks: requestChunks, ...requestOptions } = options
  return new Promise<RawResponse>((resolvePromise, rejectPromise) => {
    const outgoing = request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path,
      ...requestOptions
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolvePromise({
        status: response.statusCode ?? 0,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8')
      }))
    })
    outgoing.on('error', rejectPromise)
    if (requestChunks !== undefined) {
      for (const chunk of requestChunks) outgoing.write(chunk)
      outgoing.end()
    } else if (body !== undefined) {
      outgoing.end(body)
    } else {
      outgoing.end()
    }
  })
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release: (() => void) | undefined
  const promise = new Promise<void>(resolvePromise => { release = resolvePromise })
  if (release === undefined) throw new Error('Deferred promise was not initialized')
  return { promise, resolve: release }
}

async function incompleteRequest(origin: string, payload: string): Promise<string> {
  const url = new URL(origin)
  const socket = createConnection({ host: url.hostname, port: Number(url.port) })
  try {
    return await new Promise<string>((resolvePromise, rejectPromise) => {
      let response = ''
      socket.setEncoding('utf8')
      socket.setTimeout(4000, () => socket.destroy(new Error('Slow request was not closed')))
      socket.once('connect', () => socket.write(payload))
      socket.on('data', (chunk: string) => { response += chunk })
      socket.once('end', () => resolvePromise(response))
      socket.once('error', rejectPromise)
    })
  } finally {
    socket.destroy()
  }
}

test('validates construction inputs without binding the server', () => {
  assert.throws(() => createAdminServer({ token: 'short', snapshot() {}, dispatchDemo() {} }), /24/)
  const invalidOptions = { token: TOKEN, snapshot: null, dispatchDemo() {} } as unknown as AdminServerOptions
  assert.throws(() => createAdminServer(invalidOptions), /functions/)
  const server = createAdminServer({ token: TOKEN, snapshot() {}, dispatchDemo() {} })
  assert.equal(server.listening, false)
  assert.equal(server.requestTimeout, 15_000)
  assert.equal(server.headersTimeout, 10_000)
  assert.equal(server.timeout, 20_000)
  assert.equal(server.maxHeadersCount, 100)
})

test('serves public health and only explicit static assets', async t => {
  const fixture = await start()
  t.after(async () => stop(fixture.server))

  const health = await rawRequest(fixture.origin, '/health')
  assert.equal(health.status, 200)
  assert.deepEqual(parseJson(health.text), { ok: true, mode: 'demo' })

  for (const path of ['/', '/app.js', '/style.css']) {
    const asset = await rawRequest(fixture.origin, path)
    assert.equal(asset.status, 200)
    assert.equal(asset.headers['cache-control'], 'no-store')
    const contentSecurityPolicy = asset.headers['content-security-policy']
    if (typeof contentSecurityPolicy !== 'string') throw new Error('Missing content security policy')
    assert.match(contentSecurityPolicy, /default-src 'self'/)
    if (path === '/') assert.match(asset.text, /id="conversation-id" value="demo:room"/)
    if (path === '/app.js') assert.doesNotMatch(asset.text, /interface |: unknown|: string/)
  }

  const missing = await rawRequest(fixture.origin, '/package.json')
  assert.equal(missing.status, 404)
  assert.deepEqual(parseJson(missing.text), { error: 'not_found' })

  const disguised = await rawRequest(fixture.origin, '/assets/../app.js')
  assert.equal(disguised.status, 404)

  const typescriptSource = await rawRequest(fixture.origin, '/app.ts')
  assert.equal(typescriptSource.status, 404)
})

test('coalesces static reads, keeps warm assets in memory and isolates server caches', async t => {
  const gate = deferred()
  const reading = deferred()
  let reads = 0
  t.mock.method(filesystem, 'readFile', async () => {
    reads += 1
    reading.resolve()
    await gate.promise
    return Buffer.from('static demo asset')
  })
  syncBuiltinESMExports()
  t.after(() => {
    gate.resolve()
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const fixture = await start()
  t.after(async () => stop(fixture.server))
  const pending = Promise.all(Array.from({ length: 16 }, () => rawRequest(fixture.origin, '/style.css')))
  await reading.promise
  assert.equal(reads, 1)
  gate.resolve()
  for (const response of await pending) {
    assert.equal(response.status, 200)
    assert.equal(response.text, 'static demo asset')
    assert.equal(response.headers['cache-control'], 'no-store')
  }
  const warmed = await rawRequest(fixture.origin, '/style.css?ignored=1')
  assert.equal(warmed.status, 200)
  assert.equal(reads, 1)
  for (const path of ['/missing.css', '/web/style.css', '/app.ts']) {
    assert.equal((await rawRequest(fixture.origin, path)).status, 404)
  }
  assert.equal(reads, 1)

  const other = await start()
  t.after(async () => stop(other.server))
  assert.equal((await rawRequest(other.origin, '/style.css')).status, 200)
  assert.equal(reads, 2)
})

test('serves oversized static assets without retaining them in the cache', async t => {
  const content = Buffer.alloc(256 * 1024 + 1, 'x')
  let reads = 0
  t.mock.method(filesystem, 'readFile', async () => {
    reads += 1
    return content
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const fixture = await start()
  t.after(async () => stop(fixture.server))
  for (let index = 0; index < 2; index += 1) {
    const response = await rawRequest(fixture.origin, '/app.js')
    assert.equal(response.status, 200)
    assert.equal(Buffer.byteLength(response.text), content.byteLength)
  }
  assert.equal(reads, 2)
})

test('does not cache static failures or disclose their details', async t => {
  let reads = 0
  t.mock.method(filesystem, 'readFile', async () => {
    reads += 1
    if (reads === 1) throw new Error(`${TOKEN} /private/missing/app.js`)
    return Buffer.from('recovered asset')
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const fixture = await start()
  t.after(async () => stop(fixture.server))
  const failed = await rawRequest(fixture.origin, '/app.js')
  assert.equal(failed.status, 500)
  assert.deepEqual(parseJson(failed.text), { error: 'internal_error' })
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await rawRequest(fixture.origin, '/app.js')).text, 'recovered asset')
  }
  assert.equal(reads, 2)
})

test('serves concurrent fresh snapshots without blocking health or bypassing authentication', { timeout: 5000 }, async t => {
  const gate = deferred()
  const entered = deferred()
  let snapshots = 0
  const fixture = await start({
    async snapshot() {
      const revision = ++snapshots
      if (snapshots === 16) entered.resolve()
      await gate.promise
      return { overview: { mode: 'demo', revision } }
    }
  })
  t.after(async () => {
    gate.resolve()
    fixture.server.closeAllConnections()
    await stop(fixture.server)
  })
  const headers = { Authorization: `Bearer ${TOKEN}` }
  const pending = Promise.all(Array.from({ length: 16 }, () => rawRequest(fixture.origin, '/api/snapshot', { headers })))
  await entered.promise
  assert.equal((await rawRequest(fixture.origin, '/health')).status, 200)
  assert.equal((await rawRequest(fixture.origin, '/api/snapshot')).status, 401)
  assert.equal(snapshots, 16)
  gate.resolve()
  const responses = await pending
  assert.equal(new Set(responses.map(response => response.text)).size, 16)
  assert.ok(responses.every(response => response.status === 200))
  const latest = await rawRequest(fixture.origin, '/api/snapshot', { headers })
  assert.deepEqual(parseJson(latest.text), { overview: { mode: 'demo', revision: 17 } })
})

test('closes incomplete request headers at the native header deadline', { timeout: 5000 }, async t => {
  const fixture = await start()
  t.after(async () => stop(fixture.server))
  fixture.server.headersTimeout = 50
  fixture.server.requestTimeout = 100
  const response = await incompleteRequest(fixture.origin, 'GET /health HTTP/1.1\r\nHost: localhost\r\nX-Slow: ')
  assert.match(response, /^HTTP\/1\.1 408 /)
})

test('closes incomplete JSON bodies at the native request deadline without dispatch', { timeout: 5000 }, async t => {
  const fixture = await start()
  t.after(async () => stop(fixture.server))
  fixture.server.headersTimeout = 50
  fixture.server.requestTimeout = 100
  const host = new URL(fixture.origin).host
  const response = await incompleteRequest(fixture.origin,
    `POST /api/demo/events HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${TOKEN}\r\nOrigin: ${fixture.origin}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`)
  assert.match(response, /^HTTP\/1\.1 408 /)
  assert.equal(fixture.calls.length, 0)
})

test('limits request header size', async t => {
  const fixture = await start()
  t.after(async () => stop(fixture.server))

  const response = await rawRequest(fixture.origin, '/health', {
    headers: { 'X-Oversized': 'x'.repeat(17 * 1024) }
  })
  assert.equal(response.status, 431)
})

test('protects snapshot with bearer authentication', async t => {
  const fixture = await start()
  t.after(async () => stop(fixture.server))

  const denied = await rawRequest(fixture.origin, '/api/snapshot')
  assert.equal(denied.status, 401)
  assert.equal(denied.headers['www-authenticate'], 'Bearer')

  const queryDenied = await rawRequest(fixture.origin, `/api/snapshot?token=${encodeURIComponent(TOKEN)}`)
  assert.equal(queryDenied.status, 401)

  const accepted = await rawRequest(fixture.origin, '/api/snapshot', {
    headers: { Authorization: `Bearer ${TOKEN}` }
  })
  assert.equal(accepted.status, 200)
  assert.deepEqual(parseJson(accepted.text), { overview: { mode: 'demo' }, features: [] })
})

test('dispatches authenticated same-origin JSON demo events', async t => {
  const fixture = await start()
  t.after(async () => stop(fixture.server))
  const body = { type: 'trigger.fired', conversationId: 'demo', data: { kind: 'reminder', text: 'check' } }

  const accepted = await rawRequest(fixture.origin, '/api/demo/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
      Origin: fixture.origin
    },
    body: JSON.stringify(body)
  })

  assert.equal(accepted.status, 200)
  assert.deepEqual(parseJson(accepted.text), { accepted: true })
  assert.deepEqual(fixture.calls, [body])
})

test('requires a strictly serialized same origin', async t => {
  const fixture = await start()
  t.after(async () => stop(fixture.server))
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  const currentUrl = new URL(fixture.origin)
  const differentPort = `${currentUrl.protocol}//${currentUrl.hostname}:${currentUrl.port === '1' ? '2' : '1'}`

  for (const origin of [
    undefined,
    'null',
    'https://attacker.invalid',
    fixture.origin.replace('http:', 'https:'),
    differentPort,
    `${fixture.origin}/`
  ]) {
    const originHeaders = origin === undefined ? headers : { ...headers, Origin: origin }
    const response = await rawRequest(fixture.origin, '/api/demo/events', {
      method: 'POST',
      headers: originHeaders,
      body: '{}'
    })
    assert.equal(response.status, 403)
    assert.deepEqual(parseJson(response.text), { error: 'origin_forbidden' })
  }
})

test('rejects invalid media, malformed JSON and declared oversized bodies', async t => {
  const fixture = await start()
  t.after(async () => stop(fixture.server))
  const baseHeaders = { Authorization: `Bearer ${TOKEN}`, Origin: fixture.origin }

  const wrongType = await rawRequest(fixture.origin, '/api/demo/events', {
    method: 'POST',
    headers: { ...baseHeaders, 'Content-Type': 'text/plain' },
    body: '{}'
  })
  assert.equal(wrongType.status, 415)

  const malformed = await rawRequest(fixture.origin, '/api/demo/events', {
    method: 'POST',
    headers: { ...baseHeaders, 'Content-Type': 'application/json' },
    body: '{'
  })
  assert.equal(malformed.status, 400)
  assert.deepEqual(parseJson(malformed.text), { error: 'invalid_json' })

  const body = JSON.stringify({ value: 'x'.repeat(33 * 1024) })
  const oversized = await rawRequest(fixture.origin, '/api/demo/events', {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  })
  assert.equal(oversized.status, 413)
  assert.equal(fixture.calls.length, 0)
})

test('rejects oversized chunked bodies before dispatch', async t => {
  const fixture = await start()
  t.after(async () => stop(fixture.server))

  const response = await rawRequest(fixture.origin, '/api/demo/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Origin: fixture.origin,
      'Transfer-Encoding': 'chunked'
    },
    chunks: ['{"value":"', 'x'.repeat(20 * 1024), 'x'.repeat(13 * 1024), '"}']
  })

  assert.equal(response.status, 413)
  assert.deepEqual(parseJson(response.text), { error: 'request_too_large' })
  assert.equal(fixture.calls.length, 0)
})

test('rejects prototype-related fields before dispatch', async t => {
  const fixture = await start()
  t.after(async () => stop(fixture.server))
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    Origin: fixture.origin
  }

  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const body = `{"type":"trigger.fired","data":{"${key}":{"service":"messaging.send"}}}`
    const response = await rawRequest(fixture.origin, '/api/demo/events', { method: 'POST', headers, body })
    assert.equal(response.status, 400)
    assert.deepEqual(parseJson(response.text), { error: 'invalid_request' })
  }
  assert.equal(fixture.calls.length, 0)
})

test('returns stable errors without leaking handler failures', async t => {
  const fixture = await start({
    snapshot() {
      throw new Error(`snapshot failed with ${TOKEN} at /root/private/admin-token.txt`)
    },
    dispatchDemo() {
      throw new Error('secret dispatch detail')
    }
  })
  t.after(async () => stop(fixture.server))

  const snapshot = await rawRequest(fixture.origin, '/api/snapshot', {
    headers: { Authorization: `Bearer ${TOKEN}` }
  })
  assert.equal(snapshot.status, 500)
  assert.deepEqual(parseJson(snapshot.text), { error: 'internal_error' })
  assert.doesNotMatch(snapshot.text, /admin-test-token|\/root\/private/)

  const dispatch = await rawRequest(fixture.origin, '/api/demo/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Origin: fixture.origin
    },
    body: '{}'
  })
  assert.equal(dispatch.status, 500)
  assert.deepEqual(parseJson(dispatch.text), { error: 'internal_error' })
  assert.doesNotMatch(dispatch.text, /secret/)
})

test('frontend keeps token ephemeral and renders dynamic values as text', async () => {
  const asset = import.meta.url.endsWith('.ts') ? '../web/app.ts' : '../web/app.js'
  const source = await readFile(new URL(asset, import.meta.url), 'utf8')
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|innerHTML|insertAdjacentHTML/)
  assert.match(source, /textContent/)
  assert.doesNotMatch(source, /setInterval|setTimeout/)
})

test('mounted admin routes reuse authentication, write guards and stable errors', async t => {
  let calls = 0
  const fixture = await start({ routes: [
    { method: 'GET', pathname: '/api/plugins/example', handle({ query, body }) {
      calls++
      assert.equal(body, null)
      return { after: query.get('after') }
    } },
    { method: 'POST', pathname: '/api/plugins/example', handle({ body }) { calls++; return body } },
    { method: 'GET', pathname: '/api/plugins/failure', handle() { throw new Error('private failure') } },
    { method: 'GET', pathname: '/api/plugins/invalid', handle() { throw new AdminRequestError(400, 'invalid_query') } },
    { method: 'GET', pathname: '/api/plugins/large', handle() { return { value: 'x'.repeat(256 * 1024) } } },
  ] })
  t.after(async () => stop(fixture.server))
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  assert.equal((await rawRequest(fixture.origin, '/api/plugins/example')).status, 401)
  const read = await rawRequest(fixture.origin, '/api/plugins/example?after=room%3A1', { headers })
  assert.deepEqual(parseJson(read.text), { after: 'room:1' })
  assert.equal((await rawRequest(fixture.origin, '/api/plugins/example', { method: 'POST', headers, body: '{}' })).status, 403)
  assert.equal((await rawRequest(fixture.origin, '/api/plugins/example', { method: 'POST',
    headers: { ...headers, Origin: fixture.origin }, body: '{"__proto__":{}}' })).status, 400)
  const write = await rawRequest(fixture.origin, '/api/plugins/example', { method: 'POST',
    headers: { ...headers, Origin: fixture.origin }, body: '{"value":1}' })
  assert.deepEqual(parseJson(write.text), { value: 1 })
  assert.equal(calls, 2)
  assert.equal((await rawRequest(fixture.origin, '/api/plugins/example', { method: 'DELETE', headers })).status, 405)
  const failure = await rawRequest(fixture.origin, '/api/plugins/failure', { headers })
  assert.equal(failure.status, 500)
  assert(!failure.text.includes('private'))
  assert.equal((await rawRequest(fixture.origin, '/api/plugins/invalid', { headers })).status, 400)
  assert.equal((await rawRequest(fixture.origin, '/api/plugins/large', { headers })).status, 413)
})

test('admin route registration rejects collisions and demo dispatch is optional', () => {
  const base = { token: TOKEN, snapshot: () => ({}) }
  const route: AdminRoute = { method: 'GET', pathname: '/api/example', handle: () => ({}) }
  assert.throws(() => createAdminServer({ ...base, routes: [route, route] }), /route/)
  for (const pathname of ['/api/snapshot', '/api/demo/events', '/api/../private', '/api//private', '/other']) {
    assert.throws(() => createAdminServer({ ...base, routes: [{ ...route, pathname }] }), /route/)
  }
  const server = createAdminServer({ ...base, routes: [route] })
  assert.equal(server.listening, false)
})
