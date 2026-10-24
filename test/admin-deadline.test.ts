import assert from 'node:assert/strict'
import { request, type Server } from 'node:http'
import { connect } from 'node:net'
import test from 'node:test'

import { createAdminServer, type AdminServerOptions } from '../src/admin/server.ts'

const TOKEN = 'admin-deadline-test-token-123456'

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
  readonly reject: (error: unknown) => void
}

interface JsonResponse {
  readonly status: number
  readonly body: Record<string, unknown>
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined
  let rejectPromise: ((error: unknown) => void) | undefined
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  if (resolvePromise === undefined || rejectPromise === undefined) throw new Error('Deferred promise was not initialized')
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function never<Value>(): Promise<Value> {
  return new Promise<Value>(() => undefined)
}

async function start(options: Omit<AdminServerOptions, 'token'>): Promise<{ server: Server; origin: string }> {
  const server = createAdminServer({ token: TOKEN, ...options })
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const fail = (error: Error): void => rejectPromise(error)
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail)
      resolvePromise()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Admin server has no TCP address')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections()
  if (!server.listening) return
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close(error => error ? rejectPromise(error) : resolvePromise())
  })
}

async function call(
  origin: string,
  pathname: string,
  options: { readonly method?: 'GET' | 'POST'; readonly body?: Record<string, unknown> } = {}
): Promise<JsonResponse> {
  const headers = new Headers({ Authorization: `Bearer ${TOKEN}` })
  let body: string | undefined
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    headers.set('Origin', origin)
    body = JSON.stringify(options.body)
  }
  const response = await fetch(`${origin}${pathname}`, { method: options.method ?? 'GET', headers, body })
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>
  }
}

test('validates bounded admin handler deadlines', () => {
  const base = { token: TOKEN, snapshot: () => ({ ok: true }) }
  for (const handlerTimeoutMs of [9, 300_001, 10.5, Number.NaN]) {
    assert.throws(() => createAdminServer({ ...base, handlerTimeoutMs }), /handlerTimeoutMs/)
  }
  assert.doesNotThrow(() => createAdminServer({ ...base, handlerTimeoutMs: 10 }))
  assert.doesNotThrow(() => createAdminServer({ ...base, handlerTimeoutMs: 300_000 }))
})

test('bounds snapshot, demo and custom handlers without retrying uncertain writes', { timeout: 5000 }, async context => {
  let snapshotSignal: AbortSignal | undefined
  let demoSignal: AbortSignal | undefined
  let routeSignal: AbortSignal | undefined
  let demoCalls = 0
  let routeCalls = 0
  const lateRoute = deferred<unknown>()
  const fixture = await start({
    handlerTimeoutMs: 30,
    snapshot(signal) {
      snapshotSignal = signal
      return never()
    },
    dispatchDemo(_body, signal) {
      demoCalls += 1
      demoSignal = signal
      return never()
    },
    routes: [
      {
        method: 'POST',
        pathname: '/api/hung-write',
        handle({ signal }) {
          routeCalls += 1
          routeSignal = signal
          return lateRoute.promise
        }
      },
      {
        method: 'GET',
        pathname: '/api/ready',
        handle: () => ({ ready: true })
      }
    ]
  })
  context.after(async () => stop(fixture.server))

  const snapshot = await call(fixture.origin, '/api/snapshot')
  assert.deepEqual(snapshot, { status: 504, body: { error: 'handler_timeout' } })
  assert.equal(snapshotSignal?.aborted, true)

  const demo = await call(fixture.origin, '/api/demo/events', { method: 'POST', body: { event: 'once' } })
  assert.deepEqual(demo, { status: 504, body: { error: 'operation_unknown' } })
  assert.equal(demoSignal?.aborted, true)
  assert.equal(demoCalls, 1)

  const custom = await call(fixture.origin, '/api/hung-write', { method: 'POST', body: { operation: 'once' } })
  assert.deepEqual(custom, { status: 504, body: { error: 'operation_unknown' } })
  assert.equal(routeSignal?.aborted, true)
  assert.equal(routeCalls, 1)
  assert.equal(Object.hasOwn(custom.body, 'rejected'), false)

  lateRoute.reject(new Error('late private failure'))
  await new Promise<void>(resolvePromise => setImmediate(resolvePromise))

  assert.deepEqual(await call(fixture.origin, '/api/ready'), { status: 200, body: { ready: true } })
  const health = await fetch(`${fixture.origin}/health`)
  assert.equal(health.status, 200)
  assert.equal(routeCalls, 1)
})

test('aborts a disconnected custom handler and keeps serving requests', { timeout: 5000 }, async context => {
  const entered = deferred<void>()
  const cancelled = deferred<void>()
  const fixture = await start({
    handlerTimeoutMs: 1000,
    snapshot: () => ({ ready: true }),
    routes: [
      {
        method: 'GET',
        pathname: '/api/disconnect',
        handle({ signal }) {
          entered.resolve()
          return new Promise(resolvePromise => {
            signal.addEventListener('abort', () => {
              cancelled.resolve()
              resolvePromise({ tooLate: true })
            }, { once: true })
          })
        }
      },
      {
        method: 'GET',
        pathname: '/api/ready',
        handle: () => ({ ready: true })
      }
    ]
  })
  context.after(async () => stop(fixture.server))

  const target = new URL(fixture.origin)
  const outgoing = request({
    hostname: target.hostname,
    port: target.port,
    path: '/api/disconnect',
    headers: { Authorization: `Bearer ${TOKEN}` }
  })
  outgoing.on('error', () => undefined)
  outgoing.end()
  await entered.promise
  outgoing.destroy()
  await cancelled.promise

  assert.deepEqual(await call(fixture.origin, '/api/ready'), { status: 200, body: { ready: true } })
})

test('active handler deadlines extend socket inactivity for GET and POST, but keep bounded cancellation', { timeout: 5000 }, async context => {
  let overdueSignal: AbortSignal | undefined
  const fixture = await start({
    handlerTimeoutMs: 150,
    snapshot: () => ({}),
    routes: [
      ...(['GET', 'POST'] as const).map(method => ({
        method,
        pathname: `/api/slow-${method.toLowerCase()}`,
        async handle() {
          await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 60))
          return { ok: true }
        }
      })),
      { method: 'POST', pathname: '/api/overdue', handle({ signal }) {
        overdueSignal = signal
        return never()
      } }
    ]
  })
  context.after(() => stop(fixture.server))
  fixture.server.prependListener('request', incoming => incoming.socket.setTimeout(20))
  for (const method of ['GET', 'POST'] as const) {
    assert.deepEqual(await call(fixture.origin, `/api/slow-${method.toLowerCase()}`,
      method === 'POST' ? { method, body: {} } : {}), { status: 200, body: { ok: true } })
  }
  assert.deepEqual(await call(fixture.origin, '/api/overdue', { method: 'POST', body: {} }),
    { status: 504, body: { error: 'operation_unknown' } })
  assert.equal(overdueSignal?.aborted, true)
})

test('configured long handler deadlines survive the default twenty-second socket cutoff', { timeout: 30_000 }, async context => {
  const fixture = await start({
    handlerTimeoutMs: 25_000,
    snapshot: () => ({}),
    routes: [...(['GET', 'POST'] as const).map(method => ({
      method,
      pathname: '/api/long-handler',
      async handle() {
        await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 21_000))
        return { ok: true }
      }
    })), { method: 'GET', pathname: '/api/fast', async handle() {
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 50))
      return { fast: true }
    } }]
  })
  context.after(() => stop(fixture.server))
  const target = new URL(fixture.origin)
  const pipelined = new Promise<string>((resolvePromise, rejectPromise) => {
    const socket = connect({ host: target.hostname, port: Number(target.port) })
    const chunks: Buffer[] = []
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)))
    socket.once('error', rejectPromise)
    socket.once('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    socket.once('connect', () => socket.write(
      `GET /api/fast HTTP/1.1\r\nHost: ${target.host}\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`
      + `GET /api/long-handler HTTP/1.1\r\nHost: ${target.host}\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`
    ))
  })
  const [results, pipeline] = await Promise.all([Promise.all([
    call(fixture.origin, '/api/long-handler'),
    call(fixture.origin, '/api/long-handler', { method: 'POST', body: {} })
  ]), pipelined])
  assert.deepEqual(results, [
    { status: 200, body: { ok: true } },
    { status: 200, body: { ok: true } }
  ])
  assert.equal(pipeline.match(/HTTP\/1\.1 200 OK/g)?.length, 2)
  assert(pipeline.includes('"fast":true') && pipeline.includes('"ok":true'))
})
