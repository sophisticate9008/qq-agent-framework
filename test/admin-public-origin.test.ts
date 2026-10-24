import assert from 'node:assert/strict'
import { request } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { createAdminOriginPolicy, isLoopbackAddress, validatePublicOrigin } from '../src/admin/public-origin.ts'
import { createAdminServer } from '../src/admin/server.ts'

const token = 'synthetic-public-origin-admin-token'
const publicOrigin = 'https://console.example.test'

function transport(overrides: Record<string, unknown> = {}) {
  return { tls: false, remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', origin: publicOrigin,
    host: 'backend.internal.test:3210', ...overrides }
}

test('public origin is one exact HTTPS origin, never a credential, URL path or forwarded-header list', () => {
  assert.equal(validatePublicOrigin(''), '')
  assert.equal(validatePublicOrigin(publicOrigin), publicOrigin)
  assert.equal(validatePublicOrigin('https://console.example.test:8443'), 'https://console.example.test:8443')
  for (const value of [null, 1, 'http://console.example.test', 'https://console.example.test/',
    'https://user:secret@console.example.test', 'https://console.example.test?token=private',
    'https://console.example.test/#fragment', 'https://console.example.test/a',
    'https://console.example.test, https://foreign.test', 'https://CONSOLE.example.test',
    'https://console.example.test:443', ' https://console.example.test', 'https:\\console.example.test']) {
    assert.throws(() => validatePublicOrigin(value), /Invalid public management origin/)
  }
  assert.throws(() => createAdminOriginPolicy({ publicOrigin }), /explicit trusted/)
  assert.throws(() => createAdminOriginPolicy({ trustedLoopbackProxy: true }), /explicit trusted/)
})

test('loopback proxy boundary uses actual socket addresses, never hostnames, networks or forwarding claims', () => {
  for (const address of ['127.0.0.1', '127.22.33.44', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isLoopbackAddress(address), true, address)
  }
  for (const address of ['localhost', 'a.localhost', '127.1', '127.0.0.1.attacker.test', '192.168.0.1', '203.0.113.1', '::', '::ffff:192.168.0.1', '::1%eth0']) {
    assert.equal(isLoopbackAddress(address), false, address)
  }
  const policy = createAdminOriginPolicy({ publicOrigin, trustedLoopbackProxy: true })
  assert.equal(policy.sameOrigin(transport()), true)
  assert.equal(policy.secureCookie(transport()), true)
  for (const overrides of [
    { remoteAddress: '203.0.113.5' }, { localAddress: '192.168.1.5' }, { remoteAddress: undefined },
    { origin: 'https://attacker.test' }, { origin: 'http://console.example.test' }, { origin: undefined },
    { origin: `${publicOrigin}/` }, { origin: 'null' },
  ]) assert.equal(policy.sameOrigin(transport(overrides)), false)
  assert.equal(policy.allowsTransport(transport({ remoteAddress: '203.0.113.5' })), false)
})

test('plain loopback HTTP remains same-origin and forwarding claims never change its scheme', () => {
  const policy = createAdminOriginPolicy()
  assert.equal(policy.sameOrigin(transport({ origin: 'http://127.0.0.1:3210', host: '127.0.0.1:3210' })), true)
  assert.equal(policy.secureCookie(transport()), false)
  assert.equal(policy.sameOrigin(transport({ host: 'console.example.test' })), false)
  assert.equal(policy.sameOrigin(transport({ tls: true, host: 'console.example.test' })), true)
  for (const host of ['user:secret@console.example.test', 'console.example.test/path', 'console.example.test?query', 'console.example.test,foreign.test']) {
    assert.equal(policy.sameOrigin(transport({ host })), false)
  }
})

async function fixture(context: TestContext, trusted: boolean) {
  let saves = 0
  let setups = 0
  const server = createAdminServer({
    token, snapshot: () => ({}), ...(trusted ? { publicOrigin, trustedLoopbackProxy: true } : {}),
    setup: { status: () => ({ initialized: false }), initialize: () => { setups++; return { initialized: true } } },
    routes: [{ method: 'POST', pathname: '/api/test/save', handle: () => { saves++; return { saved: true } } }],
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const send = (path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{
    status: number; headers: IncomingHttpHeaders; body: unknown
  }>((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: address.port, path, method: options.method ?? 'POST', headers: {
      host: 'backend.internal.test:3210', origin: publicOrigin, 'content-type': 'application/json',
      'x-forwarded-proto': 'https', ...options.headers,
    } }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }))
    })
    outgoing.once('error', reject)
    outgoing.end(options.body ?? (options.method === 'GET' ? undefined : '{}'))
  })
  return { send, saves: () => saves, setups: () => setups }
}

test('configured TLS termination on a real loopback backend supports login/save/setup with Secure cookies and CSRF checks', async context => {
  const backend = await fixture(context, true)
  const login = await backend.send('/api/auth/login', { headers: { authorization: `Bearer ${token}`, 'x-forwarded-proto': 'http' } })
  assert.equal(login.status, 200)
  const setCookie = login.headers['set-cookie']?.[0]
  assert(setCookie)
  assert.match(setCookie, /; Secure(?:;|$)/)
  assert.match(setCookie, /; HttpOnly; SameSite=Strict/)
  const cookie = setCookie.split(';', 1)[0]!
  assert.equal((await backend.send('/api/test/save', { headers: { cookie } })).status, 200)
  assert.equal(backend.saves(), 1)
  for (const origin of ['https://foreign.test', 'http://console.example.test', 'null', `${publicOrigin}/`]) {
    const denied = await backend.send('/api/test/save', { headers: { cookie, origin, 'x-forwarded-host': 'console.example.test', forwarded: 'proto=https;host=console.example.test' } })
    assert.equal(denied.status, 403)
    assert.deepEqual(denied.body, { error: 'origin_forbidden' })
  }
  assert.equal(backend.saves(), 1)
  assert.equal((await backend.send('/api/setup')).status, 200)
  assert.equal((await backend.send('/api/setup', { headers: { origin: 'https://foreign.test' } })).status, 403)
  assert.equal(backend.setups(), 1)
  const logout = await backend.send('/api/auth/logout', { headers: { cookie } })
  assert.equal(logout.status, 200)
  assert.match(logout.headers['set-cookie']?.[0] ?? '', /Max-Age=0.*; Secure/)
  const expired = await backend.send('/api/auth/session', { method: 'GET', headers: { cookie } })
  assert.equal(expired.status, 401)
  assert.match(expired.headers['set-cookie']?.[0] ?? '', /Max-Age=0.*; Secure/)
})

test('ordinary unconfigured backend does not accept forged TLS forwarding headers', async context => {
  const backend = await fixture(context, false)
  const response = await backend.send('/api/auth/login', { headers: { authorization: `Bearer ${token}` } })
  assert.equal(response.status, 403)
  assert.deepEqual(response.body, { error: 'origin_forbidden' })
  assert.equal(backend.saves(), 0)
})
