import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import type { JsonObject } from '../src/core/types.ts'
import { createOneBotWebSocketClient, OneBotWebSocketError } from '../src/adapters/onebot-websocket.ts'
import type { OneBotWebSocketClient, OneBotWebSocketOptions } from '../src/adapters/onebot-websocket.ts'

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    assert(Date.now() < deadline, 'Local WebSocket condition timed out')
    await delay(10)
  }
}

async function fixture(context: TestContext, options: {
  login?: (socket: WebSocket, request: JsonObject, index: number) => void
  upgradeStatus?: number
  hangUpgrade?: boolean
  autoPong?: boolean
  ping?: (socket: WebSocket, data: Buffer, index: number) => void
} = {}) {
  const sockets = new WebSocketServer({ noServer: true, autoPong: options.autoPong ?? true })
  const peers: WebSocket[] = []
  const pings: Array<{ index: number; data: Buffer }> = []
  const requests: JsonObject[] = []
  const authorizations: Array<string | undefined> = []
  const paths: Array<string | undefined> = []
  const clients: OneBotWebSocketClient[] = []
  const transports = new Set<import('node:stream').Duplex>()
  const server = createServer()
  server.on('upgrade', (request, transport, head) => {
    transports.add(transport)
    transport.on('error', () => undefined)
    transport.on('close', () => transports.delete(transport))
    authorizations.push(request.headers.authorization)
    paths.push(request.url)
    if (options.hangUpgrade) return
    if (options.upgradeStatus) {
      transport.end(`HTTP/1.1 ${options.upgradeStatus} Rejected\r\nLocation: /redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
      return
    }
    sockets.handleUpgrade(request, transport, head, socket => {
      const index = peers.length
      peers.push(socket)
      socket.on('error', () => undefined)
      socket.on('ping', data => {
        pings.push({ index, data })
        options.ping?.(socket, data, index)
      })
      socket.on('message', body => {
        const input = JSON.parse(body.toString()) as JsonObject
        requests.push(input)
        if (options.login) options.login(socket, input, index)
        else socket.send(JSON.stringify({ echo: input.echo, retcode: 0, status: 'ok', data: { user_id: 12345 } }))
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const endpoint = `ws://127.0.0.1:${address.port}/onebot/v11`
  context.after(async () => {
    await Promise.all(clients.map(client => client.close()))
    for (const socket of sockets.clients) socket.terminate()
    for (const transport of transports) transport.destroy()
    await new Promise<void>(resolve => sockets.close(() => resolve()))
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const client = (overrides: Partial<OneBotWebSocketOptions> = {}) => {
    const result = createOneBotWebSocketClient({
      endpoint, connectTimeoutMs: 500, callbackTimeoutMs: 500,
      maxReconnectAttempts: 0, reconnectDelayMs: 100, ...overrides,
    })
    clients.push(result)
    return result
  }
  const send = (value: JsonObject, index = peers.length - 1) => peers[index]!.send(JSON.stringify(value))
  const message = (sequence: number, selfId: number | string = 12345, index = peers.length - 1) => {
    send({ post_type: 'message', self_id: selfId, sequence, message: [{ type: 'text', data: { text: 'test' } }] }, index)
  }
  return { endpoint, client, peers, requests, authorizations, paths, send, message, pings }
}

test('OneBot WS validates endpoint/options without construction-time networking', async context => {
  const fake = await fixture(context)
  for (const endpoint of [
    'http://127.0.0.1', 'ws://example.com', 'ws://10.0.0.1', 'ws://127.1',
    'ws://2130706433', 'ws://0x7f000001', 'ws://127.00.0.1', 'ws://localhost.example',
    'ws://[::ffff:127.0.0.1]', 'ws://user:private@localhost', 'ws://@localhost',
    'ws://localhost/?token=private', 'ws://localhost/?', 'ws://localhost/#',
    ' ws://localhost', 'ws://localhost\\evil',
  ]) {
    assert.throws(() => fake.client({ endpoint }), { code: 'onebot_ws_invalid_endpoint' })
  }
  for (const overrides of [
    { accessToken: 'secret\r\nInjected: value' }, { accessToken: '' },
    { connectTimeoutMs: Infinity }, { callbackTimeoutMs: 0 }, { maxPendingEvents: 257 },
    { maxReconnectAttempts: 9 }, { reconnectDelayMs: -1 },
    { pingIntervalMs: 0 }, { pingIntervalMs: 300001 }, { pongTimeoutMs: NaN }, { pongTimeoutMs: 99 },
  ]) assert.throws(() => fake.client(overrides), { code: 'onebot_ws_invalid_options' })
  for (const endpoint of [fake.endpoint, 'ws://127.2.3.4:1234', 'ws://localhost:1234', 'ws://[::1]:1234', 'wss://example.com/socket']) {
    const client = fake.client({ endpoint })
    assert.deepEqual(client.status(), { state: 'disconnected', selfId: null, lastError: null, received: 0, dropped: 0 })
    await client.close()
  }
  await delay(50)
  assert.equal(fake.authorizations.length, 0)
})

test('OneBot WS uses Bearer plus one read-only login RPC, discovers identity and filters messages', async context => {
  const fake = await fixture(context, { login: (socket, request) => {
    socket.send(JSON.stringify({ echo: `${request.echo}-wrong`, retcode: 0, status: 'ok', data: { user_id: 999 } }))
    socket.send(JSON.stringify({ post_type: 'meta_event', self_id: 999 }))
  } })
  const delivered: Array<{ event: Readonly<JsonObject>; selfId: string; signal: AbortSignal }> = []
  const client = fake.client({ accessToken: 'synthetic-private-token', onEvent: (event, details) => {
    assert(Object.isFrozen(event))
    assert(Object.isFrozen(event.message))
    assert(Object.isFrozen(details))
    delivered.push({ event, ...details })
  } })
  const connecting = client.connect()
  assert.equal(client.connect(), connecting)
  await until(() => fake.requests.length === 1)
  assert.equal(client.status().state, 'connecting')
  assert.equal(client.status().selfId, null)
  const login = fake.requests[0]!
  assert.deepEqual(Object.keys(login).sort(), ['action', 'echo', 'params'])
  assert.equal(login.action, 'get_login_info')
  assert.deepEqual(login.params, {})
  assert.equal(typeof login.echo, 'string')
  assert(String(login.echo).length <= 64)
  fake.send({ echo: login.echo!, retcode: 0, status: 'ok', data: { user_id: 12345 } })
  await connecting
  assert.equal(client.status().state, 'connected')
  assert.equal(client.status().selfId, '12345')
  assert.deepEqual(fake.authorizations, ['Bearer synthetic-private-token'])
  assert.deepEqual(fake.paths, ['/onebot/v11'])
  fake.message(1, 999)
  fake.message(2, '12345')
  fake.send({ post_type: 'notice', self_id: 12345 })
  fake.send({ echo: 'unrelated', retcode: 0, status: 'ok' })
  const pong = new Promise<void>(resolve => fake.peers[0]!.once('pong', () => resolve()))
  fake.peers[0]!.ping('check')
  await Promise.race([pong, delay(1000).then(() => { assert.fail('Expected automatic pong') })])
  await until(() => delivered.length === 1)
  assert.equal(delivered[0]!.event.sequence, 2)
  assert.equal(delivered[0]!.selfId, '12345')
  assert.equal(delivered[0]!.signal.aborted, false)
  assert.equal(client.status().received, 2)
  assert.equal(client.status().dropped, 1)
  assert.equal(fake.requests.length, 1)
})

test('OneBot WS without a callback drops all bodies instead of retaining or sending them', async context => {
  const fake = await fixture(context)
  const client = fake.client()
  await client.connect()
  for (let index = 0; index < 100; index += 1) fake.message(index)
  await until(() => client.status().received === 100)
  assert.equal(client.status().dropped, 100)
  assert.equal(fake.requests.length, 1)
})

test('OneBot WS drops malformed/binary/deep events and bounds the full fragmented payload', async context => {
  const fake = await fixture(context)
  const delivered: number[] = []
  const client = fake.client({ onEvent: event => { delivered.push(Number(event.sequence)) } })
  await client.connect()
  fake.peers[0]!.send('{broken')
  fake.peers[0]!.send('[]')
  fake.peers[0]!.send(Buffer.from('{"post_type":"message","self_id":12345}'))
  fake.peers[0]!.send('{"post_type":"message","self_id":12345,"number":1e400}')
  fake.peers[0]!.send(`{"post_type":"message","self_id":12345,"nested":${'['.repeat(100)}0${']'.repeat(100)}}`)
  fake.message(1)
  await until(() => delivered.length === 1)
  assert.deepEqual(delivered, [1])
  assert.equal(client.status().dropped, 5)
  fake.peers[0]!.send('x'.repeat(700000), { fin: false })
  fake.peers[0]!.send('x'.repeat(400000), { fin: true })
  await until(() => client.status().state === 'error')
  assert.equal(client.status().lastError, 'onebot_ws_payload_too_large')
  assert.equal(client.status().selfId, null)
})

test('OneBot WS accepts an exactly 1MiB JSON payload and rejects larger individual frames', async context => {
  const fake = await fixture(context)
  const delivered: Readonly<JsonObject>[] = []
  const client = fake.client({ onEvent: event => { delivered.push(event) } })
  await client.connect()
  const prefix = '{"post_type":"message","self_id":12345,"text":"'
  fake.peers[0]!.send(prefix + 'a'.repeat(1024 * 1024 - Buffer.byteLength(prefix) - 2) + '"}')
  await until(() => delivered.length === 1)
  fake.peers[0]!.send('x'.repeat(1024 * 1024 + 1))
  await until(() => client.status().state === 'error')
  assert.equal(client.status().lastError, 'onebot_ws_payload_too_large')
})

test('OneBot WS login and upgrade deadlines are finite and sanitized', async context => {
  for (const hangUpgrade of [false, true]) {
    const fake = await fixture(context, { hangUpgrade, login: () => undefined })
    const client = fake.client({ connectTimeoutMs: 150, maxReconnectAttempts: 8 })
    await assert.rejects(client.connect(), { code: 'onebot_ws_connect_timeout', message: 'onebot_ws_connect_timeout' })
    assert.equal(client.status().state, 'error')
    await delay(200)
    assert.equal(fake.authorizations.length, 1)
  }
})

test('OneBot WS rejects auth/redirect upgrades with no credential leak or retry', async context => {
  for (const upgradeStatus of [401, 403, 302]) {
    const fake = await fixture(context, { upgradeStatus })
    const client = fake.client({ accessToken: 'never-echo-this', maxReconnectAttempts: 8 })
    const code = upgradeStatus === 302 ? 'onebot_ws_upgrade_rejected' : 'onebot_ws_auth_rejected'
    await assert.rejects(client.connect(), { code, message: code })
    await delay(150)
    assert.equal(fake.authorizations.length, 1)
    assert.equal(fake.requests.length, 0)
    assert.equal(client.status().lastError, code)
    assert(!JSON.stringify(client.status()).includes('never-echo-this'))
    assert(!JSON.stringify(client.status()).includes(fake.endpoint))
  }
})

test('OneBot WS requires exact successful login status and positive safe discovered identity', async context => {
  const responses: Array<{ value: JsonObject; code: string }> = [
    { value: { retcode: 1, status: 'ok', data: { user_id: 12345 } }, code: 'onebot_ws_login_rejected' },
    { value: { retcode: 0, status: 'failed', data: { user_id: 12345 } }, code: 'onebot_ws_login_rejected' },
    ...[0, -1, 1.5, '0', '00123', '9007199254740992', 9007199254740992, null].map(userId => ({
      value: { retcode: 0, status: 'ok', data: { user_id: userId } }, code: 'onebot_ws_invalid_identity',
    })),
  ]
  for (const response of responses) {
    const fake = await fixture(context, { login: (socket, request) => {
      socket.send(JSON.stringify({ echo: request.echo, ...response.value }))
    } })
    const client = fake.client({ maxReconnectAttempts: 8 })
    await assert.rejects(client.connect(), { code: response.code })
    assert.equal(client.status().selfId, null)
    assert.equal(fake.requests.length, 1)
  }
})

test('OneBot WS reconnects with new echoes/identity and stops at its lifetime retry budget', async context => {
  const fake = await fixture(context, { login: (socket, request, index) => {
    socket.send(JSON.stringify({ echo: request.echo, retcode: 0, status: 'ok', data: { user_id: 12345 + index } }))
  } })
  const delivered: string[] = []
  const client = fake.client({ maxReconnectAttempts: 2, onEvent: (_event, details) => { delivered.push(details.selfId) } })
  await client.connect()
  fake.peers[0]!.terminate()
  await until(() => client.status().state === 'reconnecting')
  assert.equal(client.status().selfId, null)
  await client.connect()
  assert.equal(client.status().selfId, '12346')
  fake.message(1, 12345)
  fake.message(2, 12346)
  await until(() => delivered.length === 1)
  assert.deepEqual(delivered, ['12346'])
  fake.peers[1]!.terminate()
  await until(() => fake.requests.length === 3 && client.status().state === 'connected')
  fake.peers[2]!.terminate()
  await until(() => client.status().state === 'error')
  await delay(250)
  assert.equal(fake.requests.length, 3)
  assert.equal(new Set(fake.requests.map(request => request.echo)).size, 3)
  assert(fake.requests.every(request => request.action === 'get_login_info'))
})

test('OneBot WS abort cancels upgrade, login and connected lifecycle, including reconnect backoff', async context => {
  for (const stage of ['upgrade', 'login', 'connected', 'backoff']) {
    const fake = await fixture(context, {
      hangUpgrade: stage === 'upgrade',
      ...(stage === 'login' ? { login: () => undefined } : {}),
    })
    const controller = new AbortController()
    const client = fake.client({ maxReconnectAttempts: 8, reconnectDelayMs: 250 })
    const connecting = client.connect(controller.signal)
    const rejected = stage === 'upgrade' || stage === 'login'
      ? assert.rejects(connecting, { code: 'onebot_ws_aborted' }) : connecting
    if (stage === 'upgrade' || stage === 'login') await until(() => fake.authorizations.length === 1)
    else await connecting
    if (stage === 'backoff') {
      fake.peers[0]!.terminate()
      await until(() => client.status().state === 'reconnecting')
    }
    controller.abort(new Error('unsanitized private reason'))
    await rejected
    assert.equal(client.status().state, 'disconnected')
    assert.equal(client.status().lastError, 'onebot_ws_aborted')
    assert.equal(client.status().selfId, null)
    await delay(300)
    assert.equal(fake.authorizations.length, 1)
  }
})

test('OneBot WS pre-aborted connect has no network and close is terminal/idempotent during login', async context => {
  const fake = await fixture(context, { login: () => undefined })
  const client = fake.client()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(client.connect(controller.signal), { code: 'onebot_ws_aborted' })
  assert.equal(fake.authorizations.length, 0)
  const connecting = client.connect()
  const rejected = assert.rejects(connecting, { code: 'onebot_ws_closed' })
  await until(() => fake.requests.length === 1)
  const closing = client.close()
  assert.equal(client.close(), closing)
  await closing
  await rejected
  await assert.rejects(client.connect(), { code: 'onebot_ws_closed' })
  assert.equal(client.status().state, 'disconnected')
  assert.equal(client.status().selfId, null)
})

test('OneBot WS retains trusted receive times while callbacks wait in its FIFO', async context => {
  const fake = await fixture(context)
  const calls: Array<{ sequence: number; receivedAt: number; enteredAt: number; frozen: boolean }> = []
  let unblock!: () => void
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  context.after(() => unblock())
  const client = fake.client({ onEvent: (event, details) => {
    calls.push({ sequence: Number(event.sequence), receivedAt: details.receivedAt,
      enteredAt: Date.now(), frozen: Object.isFrozen(details) })
    if (event.sequence === 1) return blocked
  } })
  await client.connect()
  const before = Date.now()
  for (const sequence of [1, 2]) fake.send({ post_type: 'message', self_id: 12345, sequence,
    receivedAt: 1, time: -1, message: [{ type: 'text', data: { text: 'test' } }] })
  await until(() => client.status().received === 2 && calls.length === 1)
  const bothQueuedAt = Date.now()
  await delay(25)
  const releasedAt = Date.now()
  unblock()
  await until(() => calls.length === 2)
  assert.deepEqual(calls.map(call => call.sequence), [1, 2])
  for (const call of calls) {
    assert(Number.isSafeInteger(call.receivedAt) && call.receivedAt >= before && call.receivedAt <= bothQueuedAt)
    assert.equal(call.frozen, true)
  }
  assert(calls[1].receivedAt < releasedAt)
  assert(calls[1].enteredAt >= releasedAt)
})

test('OneBot WS callback FIFO admission, deadlines and raw pending cap survive ignored cancellation', async context => {
  const fake = await fixture(context)
  const calls: number[] = []
  const signals: AbortSignal[] = []
  const release: Array<() => void> = []
  const client = fake.client({ callbackTimeoutMs: 150, maxPendingEvents: 2, onEvent: (event, details) => {
    calls.push(Number(event.sequence))
    signals.push(details.signal)
    return new Promise<void>(resolve => { release.push(resolve) })
  } })
  await client.connect()
  fake.message(1)
  fake.message(2)
  fake.message(3)
  await until(() => client.status().received === 3)
  assert.deepEqual(calls, [1])
  assert.equal(client.status().dropped, 1)
  await until(() => calls.length === 2 && signals[0]!.aborted)
  await until(() => signals[1]!.aborted)
  fake.message(4)
  await until(() => client.status().received === 4)
  assert.deepEqual(calls, [1, 2])
  assert.equal(client.status().dropped, 4)
  assert.equal(client.status().lastError, 'onebot_ws_callback_timeout')
  release[0]!()
  await delay(30)
  fake.message(5)
  await until(() => calls.length === 3)
  assert.deepEqual(calls, [1, 2, 5])
  const before = Date.now()
  await client.close()
  assert(Date.now() - before < 1000)
  assert(signals[2]!.aborted)
  const closed = client.status()
  for (const resolve of release) resolve()
  await delay(200)
  assert.deepEqual(client.status(), closed)
  assert.equal(fake.requests.length, 1)
})

test('OneBot WS old callbacks cannot release the cross-generation raw cap or revive closed state', async context => {
  const fake = await fixture(context)
  const signals: AbortSignal[] = []
  let release: (() => void) | undefined
  const client = fake.client({ maxPendingEvents: 1, maxReconnectAttempts: 1, onEvent: (_event, details) => {
    signals.push(details.signal)
    return new Promise<void>(resolve => { release = resolve })
  } })
  await client.connect()
  fake.message(1)
  await until(() => signals.length === 1)
  fake.peers[0]!.terminate()
  await until(() => fake.requests.length === 2 && client.status().state === 'connected')
  assert(signals[0]!.aborted)
  fake.message(2)
  await until(() => client.status().received === 2)
  assert.equal(signals.length, 1)
  assert.equal(client.status().dropped, 2)
  await client.close()
  const closed = client.status()
  release!()
  await delay(200)
  assert.deepEqual(client.status(), closed)
})

test('OneBot WS resumes queued FIFO work when a timed-out raw callback finally releases capacity', async context => {
  const fake = await fixture(context)
  const calls: number[] = []
  const signals: AbortSignal[] = []
  const releases: Array<() => void> = []
  const client = fake.client({ maxPendingEvents: 3, callbackTimeoutMs: 200, onEvent: (event, details) => {
    calls.push(Number(event.sequence))
    signals.push(details.signal)
    return new Promise<void>(resolve => { releases.push(resolve) })
  } })
  await client.connect()
  fake.message(1)
  fake.message(2)
  fake.message(3)
  await until(() => calls.length === 2)
  fake.message(4)
  await until(() => calls.length === 3 && signals[2]!.aborted)
  assert.deepEqual(calls, [1, 2, 3])
  releases[0]!()
  await until(() => calls.length === 4)
  assert.deepEqual(calls, [1, 2, 3, 4])
  await client.close()
  for (const release of releases) release()
})

test('OneBot WS close stays idempotent when callback cancellation reenters close', async context => {
  const fake = await fixture(context)
  let nestedClose: Promise<void> | undefined
  let invoked = false
  const client = fake.client({ onEvent: (_event, details) => {
    invoked = true
    details.signal.addEventListener('abort', () => { nestedClose = client.close() }, { once: true })
    return new Promise<void>(() => undefined)
  } })
  await client.connect()
  fake.message(1)
  await until(() => invoked)
  const closing = client.close()
  assert.equal(nestedClose, closing)
  await closing
  assert.equal(client.status().state, 'disconnected')
})

test('OneBot WS reconnect login failures are bounded and auth failures cannot self-heal', async context => {
  for (const timeout of [false, true]) {
    const fake = await fixture(context, { login: (socket, request, index) => {
      if (index === 0) socket.send(JSON.stringify({ echo: request.echo, retcode: 0, status: 'ok', data: { user_id: '12345' } }))
      else if (!timeout) socket.send(JSON.stringify({ echo: request.echo, retcode: 401, status: 'failed', wording: 'private upstream failure' }))
    } })
    const client = fake.client({ maxReconnectAttempts: timeout ? 1 : 8, connectTimeoutMs: 150 })
    await client.connect()
    fake.peers[0]!.terminate()
    await until(() => client.status().state === 'error')
    assert.equal(client.status().lastError, timeout ? 'onebot_ws_connect_timeout' : 'onebot_ws_login_rejected')
    assert.equal(client.status().selfId, null)
    await delay(200)
    assert.equal(fake.requests.length, 2)
  }
})

test('OneBot WS callback exceptions are isolated; close cancels queued events and reconnect timers', async context => {
  const fake = await fixture(context)
  const calls: number[] = []
  let release: (() => void) | undefined
  const client = fake.client({ maxReconnectAttempts: 8, reconnectDelayMs: 250, onEvent: event => {
    calls.push(Number(event.sequence))
    if (event.sequence === 1) throw new Error('raw private payload')
    return new Promise<void>(resolve => { release = resolve })
  } })
  await client.connect()
  fake.message(1)
  fake.message(2)
  fake.message(3)
  await until(() => calls.length === 2)
  assert.equal(client.status().lastError, 'onebot_ws_callback_failed')
  fake.peers[0]!.terminate()
  await until(() => client.status().state === 'reconnecting')
  const waiting = client.connect()
  const rejected = assert.rejects(waiting, { code: 'onebot_ws_closed' })
  await client.close()
  await rejected
  release!()
  await delay(350)
  assert.deepEqual(calls, [1, 2])
  assert.equal(client.status().state, 'disconnected')
  assert.equal(fake.requests.length, 1)
})

test('OneBot WS exports only sanitized typed failures', () => {
  const error = new OneBotWebSocketError('onebot_ws_auth_rejected')
  assert(error instanceof Error)
  assert.equal(error.name, 'OneBotWebSocketError')
  assert.equal(error.message, error.code)
})

test('OneBot WS watchdog accepts matching automatic pongs and close disposes the next ping timer', async context => {
  const fake = await fixture(context)
  const client = fake.client({ pingIntervalMs: 200, pongTimeoutMs: 300 })
  await client.connect()
  await until(() => fake.pings.length >= 3)
  assert.equal(client.status().state, 'connected')
  assert.equal(client.status().lastError, null)
  assert.equal(client.status().received, 0)
  assert.equal(client.status().dropped, 0)
  assert.equal(fake.requests.length, 1)
  assert.equal(fake.requests[0]!.action, 'get_login_info')
  assert(fake.pings.every(ping => ping.data.byteLength <= 125))
  assert.equal(new Set(fake.pings.map(ping => ping.data.toString())).size, fake.pings.length)
  await client.close()
  const count = fake.pings.length
  const closed = client.status()
  await delay(550)
  assert.equal(fake.pings.length, count)
  assert.deepEqual(client.status(), closed)
})

test('OneBot WS watchdog detects silent or wrong pongs even while meta events keep arriving', async context => {
  for (const wrongPong of [false, true]) {
    const fake = await fixture(context, {
      autoPong: false,
      ping: socket => { if (wrongPong) socket.pong('not-the-current-nonce') },
    })
    const client = fake.client({ pingIntervalMs: 200, pongTimeoutMs: 300 })
    await client.connect()
    const metaTimer = setInterval(() => {
      if (fake.peers[0]!.readyState === WebSocket.OPEN) fake.send({ post_type: 'meta_event', self_id: 12345 })
    }, 150)
    context.after(() => clearInterval(metaTimer))
    await until(() => client.status().state === 'error')
    clearInterval(metaTimer)
    assert.equal(client.status().lastError, 'onebot_ws_pong_timeout')
    assert.equal(client.status().selfId, null)
    await until(() => fake.peers[0]!.readyState === WebSocket.CLOSED)
    await delay(350)
    assert.equal(fake.requests.length, 1)
    assert.equal(fake.pings.length, 1)
    assert.equal(client.status().state, 'error')
  }
})

test('OneBot WS watchdog reconnects with fresh identity and ignores stale-generation pong payloads', async context => {
  let oldNonce: Buffer | undefined
  const fake = await fixture(context, {
    autoPong: false,
    login: (socket, request, index) => socket.send(JSON.stringify({
      echo: request.echo, retcode: 0, status: 'ok', data: { user_id: 12345 + index },
    })),
    ping: (socket, data, index) => {
      if (index === 0) oldNonce = data
      else socket.pong(oldNonce!)
    },
  })
  const client = fake.client({ pingIntervalMs: 200, pongTimeoutMs: 300, maxReconnectAttempts: 1 })
  await client.connect()
  await until(() => client.status().state === 'reconnecting')
  assert.equal(client.status().lastError, 'onebot_ws_pong_timeout')
  assert.equal(client.status().selfId, null)
  await until(() => fake.requests.length === 2 && client.status().state === 'connected')
  assert.equal(client.status().selfId, '12346')
  await until(() => client.status().state === 'error')
  assert.equal(client.status().lastError, 'onebot_ws_pong_timeout')
  assert.equal(fake.pings.length, 2)
  assert.notDeepEqual(fake.pings[0]!.data, fake.pings[1]!.data)
  await delay(350)
  assert.equal(fake.requests.length, 2)
})

test('OneBot WS close/abort during a pending pong disposes deadlines without reconnecting or reviving', async context => {
  for (const abort of [false, true]) {
    const fake = await fixture(context, { autoPong: false })
    const client = fake.client({ pingIntervalMs: 200, pongTimeoutMs: 300, maxReconnectAttempts: 8 })
    const controller = new AbortController()
    await client.connect(controller.signal)
    await until(() => fake.pings.length === 1)
    if (abort) controller.abort()
    else await client.close()
    const stopped = client.status()
    assert.equal(stopped.state, 'disconnected')
    assert.equal(stopped.selfId, null)
    await delay(650)
    assert.deepEqual(client.status(), stopped)
    assert.equal(fake.requests.length, 1)
    assert.equal(fake.pings.length, 1)
  }
})

test('OneBot WS decodes protocol notices through the same bounded FIFO while separating them from messages', async context => {
  const fake = await fixture(context)
  const delivered: string[] = []
  let release: (() => void) | undefined
  const client = fake.client({ maxPendingEvents: 3,
    onEvent() { delivered.push('message') },
    async onProtocolEvent(event, details) {
      assert.equal(event.data.selfId, details.selfId)
      assert(Object.isFrozen(event.data))
      delivered.push(event.type)
      if (event.type === 'protocol.message.recalled') await new Promise<void>(resolve => { release = resolve })
    },
  })
  await client.connect()
  fake.send({ post_type: 'notice', notice_type: 'group_recall', self_id: 12345, time: 1,
    group_id: 456, user_id: 123, operator_id: 123, message_id: -1 })
  await until(() => release !== undefined)
  fake.message(1)
  fake.send({ post_type: 'notice', notice_type: 'group_decrease', sub_type: 'kick_me', self_id: 12345,
    time: 1, group_id: 456, user_id: 12345, operator_id: 123 })
  await delay(30)
  assert.deepEqual(delivered, ['protocol.message.recalled'])
  release!()
  await until(() => delivered.length === 3)
  assert.deepEqual(delivered, ['protocol.message.recalled', 'message', 'protocol.group.member.changed'])
  fake.send({ post_type: 'notice', notice_type: 'group_recall', self_id: 999, time: 1, group_id: 456,
    user_id: 123, operator_id: 123, message_id: -1 })
  fake.send({ post_type: 'notice', notice_type: 'group_recall', self_id: 12345, time: 1,
    group_id: 456, user_id: 123, operator_id: 123 })
  await until(() => client.status().dropped === 2)
  assert.equal(delivered.length, 3)
})
