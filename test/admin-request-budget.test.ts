import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAdminServer } from '../src/admin/server.ts'
import { createNativeRuntimeRoutes } from '../src/admin/runtime.ts'

const token = 'admin-request-budget-test-credential'

test('route-specific body allowances keep the default conservative and validate bounds', () => {
  for (const maxRequestBytes of [0, 1023, 1024 * 1024 + 1, 2048.5, Number.NaN]) {
    assert.throws(() => createAdminServer({ token, snapshot: () => ({}),
      routes: [{ method: 'POST', pathname: '/api/budget', maxRequestBytes, handle: () => ({}) }] }), /maxRequestBytes/)
  }
  assert.throws(() => createAdminServer({ token, snapshot: () => ({}),
    routes: [{ method: 'GET', pathname: '/api/budget', maxRequestBytes: 1024, handle: () => ({}) }] }), /maxRequestBytes/)
})

test('native multibyte catalogs near the document limit round-trip over authenticated HTTP', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'admin-request-budget-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  let smallCalls = 0
  const server = createAdminServer({ token, snapshot: () => ({}), routes: [
    ...createNativeRuntimeRoutes({ directory: join(directory, 'runtime') }),
    { method: 'POST', pathname: '/api/small', handle: () => { smallCalls++; return { ok: true } } }
  ] })
  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  context.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const get = async () => {
    const response = await fetch(`${origin}/api/chat/personas`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(response.status, 200)
    return await response.json() as { revision: string; personas: unknown[] }
  }
  const post = (path: string, body: unknown, authorized = true) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json',
      ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
  })
  const initial = await get()
  const personas = [{ id: 'near-limit', name: '中文人设', identity: '中'.repeat(10_500), style: '文'.repeat(10_500) }]
  const body = { revision: initial.revision, personas }
  assert(Buffer.byteLength(JSON.stringify(body)) > 32 * 1024)
  const saved = await post('/api/chat/personas', body)
  assert.equal(saved.status, 200)
  const current = await get()
  assert.deepEqual(current.personas, personas)
  personas[0].style = `字${personas[0].style.slice(1)}`
  const edited = await post('/api/chat/personas', { revision: current.revision, personas })
  assert.equal(edited.status, 200)
  const latest = await get()
  const tooLarge = await post('/api/chat/personas', { revision: latest.revision,
    personas: [{ ...personas[0], identity: '中'.repeat(16_000), style: '文'.repeat(16_000) }] })
  assert.equal(tooLarge.status, 413)
  assert.deepEqual(await get(), latest)
  assert.equal((await post('/api/small', body)).status, 413)
  assert.equal(smallCalls, 0)
  assert.equal((await post('/api/chat/personas', { padding: 'x'.repeat(130 * 1024) })).status, 413)
  assert.equal((await post('/api/chat/personas', body, false)).status, 401)
  assert.deepEqual(await get(), latest)
})
