import assert from 'node:assert/strict'
import {
  request,
  type ClientRequestArgs,
  type IncomingHttpHeaders,
  type Server
} from 'node:http'
import test from 'node:test'

import { createAccessSessionStore } from '../src/admin/access-sessions.ts'
import { createAdminServer, type AdminRoute } from '../src/admin/server.ts'

const TOKEN = 'admin-auth-test-token-1234567890'
const ROTATED_TOKEN = 'rotated-admin-auth-token-123456'

interface RawRequestOptions extends Omit<ClientRequestArgs, 'hostname' | 'path' | 'port' | 'protocol'> {
  readonly body?: string
}

interface RawResponse {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly text: string
}

interface Fixture {
  readonly server: Server
  readonly origin: string
  setToken(value: string | null): void
}

async function start(options: {
  readonly accessSessionTtlMs?: number
  readonly routes?: readonly AdminRoute[]
} = {}): Promise<Fixture> {
  let administratorToken: string | null = TOKEN
  const server = createAdminServer({
    token: () => administratorToken,
    snapshot: () => ({ ready: true }),
    routes: options.routes,
    accessSessionTtlMs: options.accessSessionTtlMs
  })
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
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    setToken(value): void { administratorToken = value }
  }
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections()
  if (!server.listening) return
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close(error => error ? rejectPromise(error) : resolvePromise())
  })
}

async function rawRequest(origin: string, pathname: string, options: RawRequestOptions = {}): Promise<RawResponse> {
  const url = new URL(origin)
  const { body, ...requestOptions } = options
  return new Promise<RawResponse>((resolvePromise, rejectPromise) => {
    const outgoing = request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: pathname,
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
    outgoing.end(body)
  })
}

function json(response: RawResponse): Record<string, unknown> {
  const value: unknown = JSON.parse(response.text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object')
  return value as Record<string, unknown>
}

function setCookie(response: RawResponse): string {
  const values = response.headers['set-cookie']
  assert(Array.isArray(values))
  assert.equal(values.length, 1)
  return values[0]!
}

function cookiePair(response: RawResponse): string {
  return setCookie(response).split(';', 1)[0]!
}

async function login(fixture: Fixture, options: {
  readonly token?: string
  readonly cookie?: string
  readonly origin?: string
  readonly contentType?: string
  readonly body?: string
  readonly path?: string
  readonly extraHeaders?: Readonly<Record<string, string>>
} = {}): Promise<RawResponse> {
  return rawRequest(fixture.origin, options.path ?? '/api/auth/login', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.token ?? TOKEN}`,
      Origin: options.origin ?? fixture.origin,
      'Content-Type': options.contentType ?? 'application/json',
      ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
      ...options.extraHeaders
    },
    body: options.body ?? '{}'
  })
}

test('login issues an independent host-only strict cookie and session restores API access', async context => {
  const fixture = await start()
  context.after(async () => stop(fixture.server))

  const startedAt = Date.now()
  const response = await login(fixture, { extraHeaders: { 'X-Forwarded-Proto': 'https' } })
  assert.equal(response.status, 200)
  const payload = json(response)
  assert.equal(payload.authenticated, true)
  assert.equal(typeof payload.expiresAt, 'number')
  assert(Number(payload.expiresAt) >= startedAt + 7 * 24 * 60 * 60 * 1000)
  assert(Number(payload.expiresAt) <= Date.now() + 7 * 24 * 60 * 60 * 1000)

  const cookie = setCookie(response)
  const pair = cookiePair(response)
  const accessToken = pair.slice(pair.indexOf('=') + 1)
  assert.match(accessToken, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(accessToken, TOKEN)
  assert.match(cookie, /; Path=\/api(?:;|$)/)
  assert.match(cookie, /; Max-Age=604800(?:;|$)/)
  assert.match(cookie, /; HttpOnly(?:;|$)/)
  assert.match(cookie, /; SameSite=Strict(?:;|$)/)
  assert.doesNotMatch(cookie, /; Domain=/i)
  assert.doesNotMatch(cookie, /; Secure(?:;|$)/)
  assert.doesNotMatch(response.text, new RegExp(TOKEN))
  assert.doesNotMatch(response.text, new RegExp(accessToken))

  const session = await rawRequest(fixture.origin, '/api/auth/session', { headers: { Cookie: pair } })
  assert.equal(session.status, 200)
  assert.deepEqual(json(session), payload)
  const snapshot = await rawRequest(fixture.origin, '/api/snapshot', { headers: { Cookie: pair } })
  assert.equal(snapshot.status, 200)
  assert.deepEqual(json(snapshot), { ready: true })

  const accessTokenAsAdministrator = await login(fixture, { token: accessToken })
  assert.equal(accessTokenAsAdministrator.status, 401)
  assert.doesNotMatch(accessTokenAsAdministrator.text, new RegExp(accessToken))
})

test('explicit invalid Authorization never falls back to a valid cookie and Bearer stays compatible', async context => {
  const fixture = await start({ routes: [{
    method: 'POST',
    pathname: '/api/example/write',
    handle: ({ body }) => body
  }] })
  context.after(async () => stop(fixture.server))
  const cookie = cookiePair(await login(fixture))

  const denied = await rawRequest(fixture.origin, '/api/snapshot', {
    headers: { Authorization: 'Bearer definitely-wrong-token', Cookie: cookie }
  })
  assert.equal(denied.status, 401)

  const bearer = await rawRequest(fixture.origin, '/api/snapshot', {
    headers: { Authorization: `Bearer ${TOKEN}` }
  })
  assert.equal(bearer.status, 200)

  const cookieWrite = await rawRequest(fixture.origin, '/api/example/write', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: fixture.origin, 'Content-Type': 'application/json' },
    body: '{"value":1}'
  })
  assert.equal(cookieWrite.status, 200)
  assert.deepEqual(json(cookieWrite), { value: 1 })

  const bearerWrite = await rawRequest(fixture.origin, '/api/example/write', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, Origin: fixture.origin, 'Content-Type': 'application/json' },
    body: '{"value":2}'
  })
  assert.equal(bearerWrite.status, 200)
  assert.deepEqual(json(bearerWrite), { value: 2 })
})

test('re-login rotates the browser session and logout revokes and clears it', async context => {
  const fixture = await start()
  context.after(async () => stop(fixture.server))
  const firstCookie = cookiePair(await login(fixture))
  const secondLogin = await login(fixture, { cookie: firstCookie })
  assert.equal(secondLogin.status, 200)
  const secondCookie = cookiePair(secondLogin)
  assert.notEqual(secondCookie, firstCookie)
  assert.equal((await rawRequest(fixture.origin, '/api/auth/session', { headers: { Cookie: firstCookie } })).status, 401)
  assert.equal((await rawRequest(fixture.origin, '/api/auth/session', { headers: { Cookie: secondCookie } })).status, 200)

  const logout = await rawRequest(fixture.origin, '/api/auth/logout', {
    method: 'POST',
    headers: { Cookie: secondCookie, Origin: fixture.origin, 'Content-Type': 'application/json' },
    body: '{}'
  })
  assert.equal(logout.status, 200)
  assert.deepEqual(json(logout), { authenticated: false })
  assert.match(setCookie(logout), /^qq_admin_access=;/)
  assert.match(setCookie(logout), /; Max-Age=0(?:;|$)/)
  assert.equal((await rawRequest(fixture.origin, '/api/auth/session', { headers: { Cookie: secondCookie } })).status, 401)
})

test('short absolute expiry and administrator token rotation invalidate old sessions', async context => {
  const fixture = await start({ accessSessionTtlMs: 10 })
  context.after(async () => stop(fixture.server))
  const expiringCookie = cookiePair(await login(fixture))
  await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  assert.equal((await rawRequest(fixture.origin, '/api/auth/session', { headers: { Cookie: expiringCookie } })).status, 401)

  const firstCookie = cookiePair(await login(fixture))
  fixture.setToken(ROTATED_TOKEN)
  assert.equal((await rawRequest(fixture.origin, '/api/auth/session', { headers: { Cookie: firstCookie } })).status, 401)
  assert.equal((await rawRequest(fixture.origin, '/api/snapshot', {
    headers: { Authorization: `Bearer ${TOKEN}` }
  })).status, 401)
  const rotatedCookie = cookiePair(await login(fixture, { token: ROTATED_TOKEN }))
  fixture.setToken(null)
  assert.equal((await rawRequest(fixture.origin, '/api/auth/session', { headers: { Cookie: rotatedCookie } })).status, 401)
})

test('auth routes strictly validate method, query, origin, content type and empty object bodies', async context => {
  const fixture = await start()
  context.after(async () => stop(fixture.server))
  const cookie = cookiePair(await login(fixture))

  for (const [pathname, method] of [
    ['/api/auth/login', 'GET'],
    ['/api/auth/session', 'POST'],
    ['/api/auth/logout', 'GET']
  ] as const) {
    const response = await rawRequest(fixture.origin, pathname, { method })
    assert.equal(response.status, 405)
  }

  for (const pathname of ['/api/auth/login?next=1', '/api/auth/session?refresh=1', '/api/auth/logout?all=1']) {
    const isSession = pathname.includes('/session')
    const response = await rawRequest(fixture.origin, pathname, isSession ? {
      headers: { Cookie: cookie }
    } : {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, Cookie: cookie, Origin: fixture.origin, 'Content-Type': 'application/json' },
      body: '{}'
    })
    assert.equal(response.status, 400)
  }

  assert.equal((await login(fixture, { origin: 'https://attacker.invalid' })).status, 403)
  assert.equal((await login(fixture, { contentType: 'text/plain' })).status, 415)
  assert.equal((await login(fixture, { body: '{"unexpected":true}' })).status, 400)
  assert.equal((await login(fixture, { body: '[]' })).status, 400)

  const crossOriginLogout = await rawRequest(fixture.origin, '/api/auth/logout', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
    body: '{}'
  })
  assert.equal(crossOriginLogout.status, 403)
  const wrongLogoutType = await rawRequest(fixture.origin, '/api/auth/logout', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: fixture.origin, 'Content-Type': 'text/plain' },
    body: '{}'
  })
  assert.equal(wrongLogoutType.status, 415)
  const nonemptyLogout = await rawRequest(fixture.origin, '/api/auth/logout', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: fixture.origin, 'Content-Type': 'application/json' },
    body: '{"all":true}'
  })
  assert.equal(nonemptyLogout.status, 400)
  assert.equal((await rawRequest(fixture.origin, '/api/auth/session', {
    headers: { Cookie: cookie, 'Content-Length': '2' }, body: '{}'
  })).status, 400)
})

test('session storage is bounded, purges expiry, rotates with the administrator and clears explicitly', () => {
  let currentTime = 1_000
  const sessions = createAccessSessionStore({ ttlMs: 50, clock: () => currentTime })
  const issued = Array.from({ length: 256 }, () => sessions.issue(TOKEN))
  assert(issued.every(session => session !== null))
  assert.equal(new Set(issued.map(session => session!.token)).size, 256)
  assert.equal(sessions.activeCount(TOKEN), 256)
  assert.equal(sessions.issue(TOKEN), null)
  assert.equal(sessions.authenticate('not-an-issued-token', TOKEN), null)

  currentTime += 50
  assert.equal(sessions.activeCount(TOKEN), 0)
  const fresh = sessions.issue(TOKEN)
  assert(fresh !== null)
  assert.equal(sessions.authenticate(fresh.token, TOKEN), fresh.expiresAt)
  assert.equal(sessions.authenticate(fresh.token, ROTATED_TOKEN), null)
  assert.equal(sessions.activeCount(ROTATED_TOKEN), 0)

  const rotated = sessions.issue(ROTATED_TOKEN)
  assert(rotated !== null)
  sessions.clear()
  assert.equal(sessions.authenticate(rotated.token, ROTATED_TOKEN), null)
})

test('validates access-session bounds and reserves the auth namespace from extensions', () => {
  const base = { token: TOKEN, snapshot: () => ({}) }
  for (const accessSessionTtlMs of [9, 30 * 24 * 60 * 60 * 1000 + 1, 10.5]) {
    assert.throws(() => createAdminServer({ ...base, accessSessionTtlMs }), /accessSessionTtlMs/)
  }
  assert.doesNotThrow(() => createAdminServer({ ...base, accessSessionTtlMs: 10 }))
  assert.doesNotThrow(() => createAdminServer({ ...base, accessSessionTtlMs: 30 * 24 * 60 * 60 * 1000 }))
  for (const pathname of ['/api/auth', '/api/auth/login', '/api/auth/session', '/api/auth/logout', '/api/auth/future']) {
    assert.throws(() => createAdminServer({
      ...base,
      routes: [{ method: 'GET', pathname, handle: () => ({}) }]
    }), /route/)
  }
})
