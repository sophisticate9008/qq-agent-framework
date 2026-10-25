import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createOneBotCompatGateway, type OneBotCompatGatewayOptions } from '../src/adapters/onebot-compat.ts'
import { isRecord } from '../src/core/values.ts'
import { digest } from '../src/host/data.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import type { DurableStore } from '../src/host/types.ts'

const persona = Object.freeze({ id: 'whale', version: 'compat-v1' })

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise)
      resolvePromise()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Server has no TCP address.')
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close(error => error ? rejectPromise(error) : resolvePromise())
  })
}

async function post(origin: string, action: string, body: unknown, options: {
  token?: string
  idempotencyKey?: string
} = {}): Promise<{ status: number; body: unknown }> {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`)
  if (options.idempotencyKey !== undefined) headers.set('x-idempotency-key', options.idempotencyKey)
  const result = await fetch(`${origin}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: result.status, body: await result.json() as unknown }
}

function fixture(fetchImplementation: typeof fetch, overrides: Partial<OneBotCompatGatewayOptions> = {}) {
  const store = createSqliteStore({ filename: ':memory:', maxValueBytes: 33 * 1024 * 1024 })
  const gateway = createOneBotCompatGateway({
    store,
    upstreamEndpoint: 'http://127.0.0.1:39999',
    upstreamToken: 'upstream-secret',
    token: 'gateway-secret',
    allowedConversations: ['group:100', 'private:200'],
    persona,
    fetch: fetchImplementation,
    maxSendUses: 10,
    ...overrides,
  })
  const server = createServer(gateway.handle)
  return { store, gateway, server }
}

test('gateway metrics preserve explicit stored unmetered limits as null instead of zero or a numeric sentinel', async context => {
  const setup = fixture(async () => response({ status: 'ok', retcode: 0, data: { message_id: 77 } }))
  context.after(async () => { await setup.gateway.close(); setup.store.close() })
  const namespace = `onebot.compat.${digest(persona)}.policy.grants`
  const record = setup.store.list(namespace).find(entry => isRecord(entry.value) && entry.value.conversationId === 'group:100')
  assert(record && isRecord(record.value))
  setup.store.write(namespace, record.key, { ...record.value,
    maxUses: { 'messaging.send': null, 'messaging.forward': null } }, { expectedRevision: record.revision })
  const metric = setup.gateway.metrics().policy.find(entry => entry.conversationId === 'group:100')
  assert(metric)
  assert.equal(metric.sendRemaining, null)
  assert.equal(metric.forwardRemaining, null)
  assert.equal(metric.active, true)
  assert.equal(setup.gateway.metrics().policy.find(entry => entry.conversationId === 'private:200')?.sendRemaining, 10)
})

test('service defaults have no daily send quota or expiry', async context => {
  const setup = fixture(async () => response({ status: 'ok', retcode: 0, data: { message_id: 77 } }),
    { maxSendUses: undefined, grantTtlMs: undefined })
  context.after(async () => { await setup.gateway.close(); await closeServer(setup.server); setup.store.close() })
  assert.equal(setup.gateway.metrics().policy[0]!.expiresAt, null)
  assert.equal(setup.gateway.metrics().policy[0]!.sendRemaining, Number.MAX_SAFE_INTEGER)
  const origin = await listen(setup.server)
  const result = await post(origin, 'send_group_msg', { group_id: 100, message: [{ type: 'text', data: { text: 'normal service' } }] }, { token: 'gateway-secret' })
  assert.equal(result.status, 200)
  assert.equal(setup.gateway.metrics().policy.find(entry => entry.conversationId === 'group:100')!.expiresAt, null)
})

test('disabled budgets retain configured values but do not limit sends or expire grants', async context => {
  let calls = 0
  const setup = fixture(async () => {
    calls += 1
    return response({ status: 'ok', retcode: 0, data: { message_id: calls } })
  }, { budgetEnabled: false, maxSendUses: 1, grantTtlMs: 1 })
  context.after(async () => { await setup.gateway.close(); await closeServer(setup.server); setup.store.close() })
  const origin = await listen(setup.server)
  const body = { group_id: 100, message: [{ type: 'text', data: { text: 'unlimited' } }] }

  for (let index = 0; index < 3; index += 1) {
    assert.equal((await post(origin, 'send_group_msg', body,
      { token: 'gateway-secret', idempotencyKey: `disabled-${index}` })).status, 200)
  }
  const policy = setup.gateway.metrics().policy.find(entry => entry.conversationId === 'group:100')!
  assert.equal(calls, 3)
  assert.equal(policy.sendRemaining, Number.MAX_SAFE_INTEGER - 3)
  assert.equal(policy.expiresAt, null)
})

test('enabled budgets apply configured send limits and expiry', async context => {
  let calls = 0
  const setup = fixture(async () => {
    calls += 1
    return response({ status: 'ok', retcode: 0, data: { message_id: calls } })
  }, { budgetEnabled: true, maxSendUses: 2, grantTtlMs: 60_000 })
  context.after(async () => { await setup.gateway.close(); await closeServer(setup.server); setup.store.close() })
  const origin = await listen(setup.server)
  const body = { group_id: 100, message: [{ type: 'text', data: { text: 'limited' } }] }

  assert.equal((await post(origin, 'send_group_msg', body,
    { token: 'gateway-secret', idempotencyKey: 'enabled-1' })).status, 200)
  assert.equal((await post(origin, 'send_group_msg', body,
    { token: 'gateway-secret', idempotencyKey: 'enabled-2' })).status, 200)
  assert.equal((await post(origin, 'send_group_msg', body,
    { token: 'gateway-secret', idempotencyKey: 'enabled-3' })).status, 403)
  const policy = setup.gateway.metrics().policy.find(entry => entry.conversationId === 'group:100')!
  assert.equal(calls, 2)
  assert.equal(policy.sendRemaining, 0)
  assert.equal(typeof policy.expiresAt, 'number')
})

test('changing budget settings with the same authorization version conflicts', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'onebot-compat-budget-switch-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))

  const changes = [
    [{ budgetEnabled: false }, { budgetEnabled: true }],
    [{ budgetEnabled: true, grantTtlMs: 60_000 }, { budgetEnabled: false, grantTtlMs: 60_000 }],
    [{ budgetEnabled: true, grantTtlMs: 60_000 }, { budgetEnabled: true, grantTtlMs: 120_000 }],
  ] as const
  for (const [index, [first, second]] of changes.entries()) {
    const filename = join(directory, `${index}.sqlite`)
    let store = createSqliteStore({ filename, maxValueBytes: 2 * 1024 * 1024 })
    const options = {
      store,
      upstreamEndpoint: 'http://127.0.0.1:39999',
      token: 'gateway-secret',
      allowedConversations: ['group:100'],
      persona,
      authorizationVersion: 'same-version',
      maxSendUses: undefined,
      fetch: async () => response({ status: 'ok', retcode: 0, data: { message_id: 1 } }),
    }
    const gateway = createOneBotCompatGateway({ ...options, ...first })
    await gateway.close()
    store.close()

    store = createSqliteStore({ filename, maxValueBytes: 2 * 1024 * 1024 })
    assert.throws(() => createOneBotCompatGateway({ ...options, store, ...second }),
      { code: 'POLICY_CONFLICT' })
    store.close()
  }
})

test('compat gateway authenticates callers and only exposes validated legacy read actions', async context => {
  const calls: Array<{ url: string; authorization: string | null; params: unknown; redirect: RequestRedirect | undefined }> = []
  const setup = fixture(async (input, init = {}) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init.headers).get('authorization'),
      params: JSON.parse(String(init.body)) as unknown,
      redirect: init.redirect,
    })
    return response({ status: 'ok', retcode: 0, data: { online: true, good: true } })
  })
  context.after(async () => {
    await setup.gateway.close()
    await closeServer(setup.server)
    setup.store.close()
  })
  const origin = await listen(setup.server)

  assert.equal((await post(origin, 'get_status', {})).status, 401)
  assert.equal((await post(origin, 'delete_msg', { message_id: 1 }, { token: 'gateway-secret' })).status, 404)
  assert.equal((await post(origin, 'get_record', { file: '/etc/passwd' }, { token: 'gateway-secret' })).status, 404)
  assert.equal((await post(origin, 'get_image', { file: 'http://internal/image' }, { token: 'gateway-secret' })).status, 404)
  assert.equal((await post(origin, 'get_group_member_list', { group_id: 999 }, { token: 'gateway-secret' })).status, 403)
  const reads = [
    ['get_status', {}],
    ['get_login_info', {}],
    ['get_image', { file: 'f9-0123456789abcdef0123456789abcdef.gif' }],
    ['get_msg', { message_id: -88 }],
    ['get_forward_msg', { id: 'forward-88' }],
    ['fetch_ptt_text', { message_id: '89' }],
    ['fetch_custom_face_detail', { count: 100 }],
    ['fetch_face_entity', { face_id: 14, refresh: false }],
    ['get_group_member_list', { group_id: 100 }],
    ['get_group_msg_history', { group_id: 100, message_seq: 90 }],
  ] as const
  const results = []
  for (const [action, params] of reads) results.push(await post(origin, action, params, { token: 'gateway-secret' }))

  assert(results.every(result => result.status === 200))
  assert.deepEqual(results[0]!.body, { status: 'ok', retcode: 0, data: { online: true, good: true } })
  assert.deepEqual(calls.map(call => call.url), reads.map(([action]) => `http://127.0.0.1:39999/${action}`))
  assert(calls.every(call => call.authorization === 'Bearer upstream-secret' && call.redirect === 'error'))
  assert.deepEqual(calls.map(call => call.params), reads.map(([, params]) => params))
  assert.equal(setup.store.list(`onebot.compat.${digest(persona)}.commands`).length, 0)
  assert.equal(setup.gateway.metrics().reads, reads.length)
  assert.equal(setup.gateway.metrics().rejected, 5)
})

test('ordinary and forward sends preserve raw OneBot params while outbox stores only a fingerprint envelope', async context => {
  const calls: Array<{ url: string; action: string; params: unknown }> = []
  const setup = fixture(async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push({ url: url.href, action: url.pathname.split('/').at(-1)!, params: JSON.parse(String(init.body)) as unknown })
    return response({ status: 'ok', retcode: 0, data: { message_id: calls.length } })
  }, { maxSendUses: 4, maxBodyBytes: 2 * 1024 * 1024 })
  context.after(async () => {
    await setup.gateway.close()
    await closeServer(setup.server)
    setup.store.close()
  })
  const origin = await listen(setup.server)
  const largeBase64 = `base64://${'A'.repeat(1024 * 1024 + 8)}`
  const ordinary = {
    group_id: 100,
    message: [
      { type: 'reply', data: { id: '-88' } },
      { type: 'text', data: { text: 'hello' } },
      { type: 'image', data: { file: largeBase64 } },
      { type: 'record', data: { file: '/trusted/library/voice.mp3' } },
    ],
    auto_escape: false,
  }
  assert(Buffer.byteLength(JSON.stringify(ordinary)) > 1024 * 1024)
  const forward = {
    user_id: '200',
    messages: [
      { type: 'node', data: { user_id: '300', nickname: 'sender', content: [
        { type: 'text', data: { text: 'first' } },
        { type: 'image', data: { file: 'https://example.invalid/preserved.png' } },
      ] } },
      { type: 'node', data: { id: 'forward-reference-1' } },
    ],
  }

  assert.equal((await post(origin, 'send_group_msg', ordinary,
    { token: 'gateway-secret', idempotencyKey: 'ordinary-1' })).status, 200)
  assert.equal((await post(origin, 'send_private_forward_msg', forward,
    { token: 'gateway-secret', idempotencyKey: 'forward-1' })).status, 200)
  assert.deepEqual(calls.map(call => ({ action: call.action, params: call.params })), [
    { action: 'send_group_msg', params: ordinary },
    { action: 'send_private_forward_msg', params: forward },
  ])
  assert.deepEqual(calls.map(call => call.url), [
    'http://127.0.0.1:39999/send_group_msg',
    'http://127.0.0.1:39999/send_private_forward_msg',
  ])

  const prefix = `onebot.compat.${digest(persona)}.`
  const commands = setup.store.list(`${prefix}commands`, { limit: 10 })
  const outbox = setup.store.list(`${prefix}outbox`, { limit: 10 })
  assert.equal(commands.length, 2)
  assert.equal(outbox.length, 2)
  assert(JSON.stringify(commands.map(record => record.value)).includes('forward-reference-1'))
  const persistedOutbox = JSON.stringify(outbox.map(record => record.value))
  assert.match(persistedOutbox, /onebot-compat:v1:/)
  assert.doesNotMatch(persistedOutbox, /hello|forward-reference|base64|trusted|preserved/)
  const metrics = setup.gateway.metrics()
  assert.deepEqual(metrics.policy, [
    { conversationId: 'group:100', sendRemaining: 3, forwardRemaining: 4,
      expiresAt: metrics.policy[0]!.expiresAt, active: true },
    { conversationId: 'private:200', sendRemaining: 3, forwardRemaining: 3,
      expiresAt: metrics.policy[1]!.expiresAt, active: true },
  ])
})

test('unknown writes are never retried and persistent grants are not replenished on restart', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'onebot-compat-'))
  const filename = join(directory, 'gateway.sqlite')
  let calls = 0
  const fetchMock: typeof fetch = async () => {
    calls += 1
    throw new Error('network detail must not escape')
  }
  let server: Server | null = null
  let gateway: ReturnType<typeof createOneBotCompatGateway> | null = null
  let store: DurableStore | null = null
  context.after(async () => {
    if (gateway) await gateway.close()
    if (server) await closeServer(server)
    store?.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const open = () => createSqliteStore({ filename, maxValueBytes: 2 * 1024 * 1024 })
  const create = (opened: DurableStore) => createOneBotCompatGateway({
    store: opened,
    upstreamEndpoint: 'http://127.0.0.1:39999',
    token: 'gateway-secret',
    allowedConversations: ['group:100'],
    persona,
    fetch: fetchMock,
    maxSendUses: 5,
  })

  store = open()
  gateway = create(store)
  server = createServer(gateway.handle)
  let origin = await listen(server)
  const body = { group_id: 100, message: [{ type: 'text', data: { text: 'same body' } }] }
  const first = await post(origin, 'send_group_msg', body, { token: 'gateway-secret', idempotencyKey: 'stable-key' })
  const duplicate = await post(origin, 'send_group_msg', body, { token: 'gateway-secret', idempotencyKey: 'stable-key' })
  await post(origin, 'send_group_msg', body, { token: 'gateway-secret' })
  await post(origin, 'send_group_msg', body, { token: 'gateway-secret' })
  assert.equal(first.status, 502)
  assert.deepEqual(duplicate, first)
  assert.equal(calls, 3)
  assert.equal(gateway.metrics().unknown, 3)
  assert.equal(gateway.metrics().policy[0]!.sendRemaining, 2)

  await gateway.close()
  await closeServer(server)
  store.close()
  store = open()
  gateway = create(store)
  server = createServer(gateway.handle)
  origin = await listen(server)
  assert.deepEqual(await post(origin, 'send_group_msg', body,
    { token: 'gateway-secret', idempotencyKey: 'stable-key' }), first)
  assert.equal(calls, 3)
  assert.equal(gateway.metrics().unknown, 3)
  assert.equal(gateway.metrics().policy[0]!.sendRemaining, 2)
})

test('authorizationVersion is the only operator-controlled grant renewal boundary', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'onebot-compat-authorization-'))
  const filename = join(directory, 'gateway.sqlite')
  let calls = 0
  let server: Server | null = null
  let gateway: ReturnType<typeof createOneBotCompatGateway> | null = null
  let store: DurableStore | null = null
  context.after(async () => {
    if (gateway) await gateway.close()
    if (server) await closeServer(server)
    store?.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const open = () => createSqliteStore({ filename, maxValueBytes: 2 * 1024 * 1024 })
  const start = async (authorizationVersion: string) => {
    store = open()
    gateway = createOneBotCompatGateway({
      store,
      upstreamEndpoint: 'http://127.0.0.1:39999',
      token: 'gateway-secret',
      allowedConversations: ['group:100'],
      persona,
      authorizationVersion,
      maxSendUses: 1,
      fetch: async () => {
        calls += 1
        return response({ status: 'ok', retcode: 0, data: { message_id: calls } })
      },
    })
    server = createServer(gateway.handle)
    return listen(server)
  }
  const stop = async () => {
    await gateway!.close()
    await closeServer(server!)
    store!.close()
    gateway = null
    server = null
    store = null
  }
  const body = { group_id: 100, message: [{ type: 'text', data: { text: 'renewal' } }] }

  let origin = await start('operator-1')
  assert.equal((await post(origin, 'send_group_msg', body,
    { token: 'gateway-secret', idempotencyKey: 'operator-1-first' })).status, 200)
  assert.equal(gateway!.metrics().policy[0]!.sendRemaining, 0)
  await stop()

  origin = await start('operator-1')
  assert.equal((await post(origin, 'send_group_msg', body,
    { token: 'gateway-secret', idempotencyKey: 'operator-1-second' })).status, 403)
  assert.equal(calls, 1)
  assert.equal(gateway!.metrics().policy[0]!.sendRemaining, 0)
  await stop()

  origin = await start('operator-2')
  assert.equal((await post(origin, 'send_group_msg', body,
    { token: 'gateway-secret', idempotencyKey: 'operator-2-first' })).status, 200)
  assert.equal(calls, 2)
  assert.equal(gateway!.metrics().policy[0]!.sendRemaining, 0)
  const prefix = `onebot.compat.${digest(persona)}.`
  const grants = store!.list(`${prefix}policy.grants`, { limit: 10 }).map(record => record.value)
  assert.equal(grants.length, 2)
  assert.equal(grants.filter(value => isRecord(value) && value.active === false).length, 1)
  assert.equal(grants.filter(value => isRecord(value) && value.active === true).length, 1)
})

test('concurrent duplicate keys share one dispatch and maxPending bounds unrelated upstream work', async context => {
  let calls = 0
  let release!: () => void
  const held = new Promise<void>(resolvePromise => { release = resolvePromise })
  const enteredResolvers: Array<() => void> = []
  const entered = new Promise<void>(resolvePromise => enteredResolvers.push(resolvePromise))
  const setup = fixture(async () => {
    calls += 1
    enteredResolvers.splice(0).forEach(resolvePromise => resolvePromise())
    await held
    return response({ status: 'ok', retcode: 0, data: { message_id: 77 } })
  }, { maxPending: 1 })
  context.after(async () => {
    release()
    await setup.gateway.close()
    await closeServer(setup.server)
    setup.store.close()
  })
  const origin = await listen(setup.server)
  const body = { group_id: 100, message: [{ type: 'text', data: { text: 'concurrent' } }] }
  const first = post(origin, 'send_group_msg', body, { token: 'gateway-secret', idempotencyKey: 'shared-key' })
  await entered
  const duplicate = post(origin, 'send_group_msg', body, { token: 'gateway-secret', idempotencyKey: 'shared-key' })
  const backpressured = await post(origin, 'get_status', {}, { token: 'gateway-secret' })
  assert.equal(backpressured.status, 503)
  assert.equal(setup.gateway.metrics().pending, 1)
  release()
  assert.deepEqual(await first, { status: 200, body: { status: 'ok', retcode: 0, data: { message_id: 77 } } })
  assert.deepEqual(await duplicate, await first)
  assert.equal(calls, 1)
  assert.equal(setup.gateway.metrics().pending, 0)
})

test('close is shared and waits for the real upstream promise to settle', async context => {
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolvePromise => { release = resolvePromise })
  const started = new Promise<void>(resolvePromise => { entered = resolvePromise })
  const setup = fixture(async () => {
    entered()
    await held
    return response({ status: 'ok', retcode: 0, data: { online: true } })
  })
  context.after(async () => {
    release()
    await setup.gateway.close()
    await closeServer(setup.server)
    setup.store.close()
  })
  const origin = await listen(setup.server)
  const pendingRequest = post(origin, 'get_status', {}, { token: 'gateway-secret' })
  await started
  let settled = false
  const firstClose = setup.gateway.close()
  const secondClose = setup.gateway.close()
  void firstClose.then(() => { settled = true })
  assert.equal(firstClose, secondClose)
  await new Promise<void>(resolvePromise => setImmediate(resolvePromise))
  assert.equal(settled, false)
  assert.equal(setup.gateway.metrics().pending, 1)
  release()
  await firstClose
  assert.equal(settled, true)
  assert.equal(setup.gateway.metrics().pending, 0)
  assert.equal((await pendingRequest).status, 502)
})
