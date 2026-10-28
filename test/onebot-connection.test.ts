import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'

import type { OneBotWebSocketClient, OneBotWebSocketOptions, OneBotWebSocketStatus } from '../src/adapters/onebot-websocket.ts'
import { createDefaultAdapterConfiguration, updateAdapterConfiguration } from '../src/host/adapter-configuration.ts'
import { createOneBotConnectionManager } from '../src/host/onebot-connection.ts'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release: (() => void) | undefined
  const promise = new Promise<void>(resolvePromise => { release = resolvePromise })
  return { promise, resolve: () => release?.() }
}

function configuration(endpoint = 'ws://127.0.0.1:3001') {
  return updateAdapterConfiguration(createDefaultAdapterConfiguration(), {
    onebotHttp: { enabled: true, endpoint: 'https://http.example.test', secret: 'preserved-http-secret' },
    onebotWs: { enabled: true, endpoint, secret: 'private-ws-secret' }
  })
}

function fakeClient(options: { login?: Promise<void>; failed?: boolean; close?: Promise<void> } = {}) {
  let current: OneBotWebSocketStatus = { state: 'disconnected', selfId: null, lastError: null, received: 0, dropped: 0 }
  let closes = 0
  let signal: AbortSignal | undefined
  const entered = deferred()
  const closing = deferred()
  const client: OneBotWebSocketClient = {
    async connect(connectSignal) {
      signal = connectSignal
      current = { ...current, state: 'connecting' }
      entered.resolve()
      if (options.login !== undefined) await options.login
      if (options.failed) throw new Error('private-raw-network-diagnostic')
      if (connectSignal?.aborted) throw new Error('aborted')
      current = { ...current, state: 'connected', selfId: '123', received: 2, dropped: 2 }
    },
    status: () => ({ ...current }),
    async close() {
      closes += 1
      closing.resolve()
      await options.close
      current = { ...current, state: 'disconnected', selfId: null }
    }
  }
  return { client, entered: entered.promise, closing: closing.promise, closes: () => closes, signal: () => signal }
}

test('connection manager construction is offline and HTTP-only configuration never opens a WS client', async context => {
  let calls = 0
  const manager = createOneBotConnectionManager({ createClient() { calls += 1; return fakeClient().client } })
  context.after(() => manager.close())
  assert.deepEqual(manager.status(), { running: false })
  assert.deepEqual(manager.connectionStatus(), { state: 'disconnected', selfId: null, lastError: null, received: 0, dropped: 0, chatReady: false, accountOnline: null, accountGood: null })
  await assert.rejects(manager.connect(createDefaultAdapterConfiguration(), new AbortController().signal), { code: 'onebot_ws_not_enabled' })
  assert.equal(calls, 0)
})

test('manager waits for verified identity, omits event delivery and keeps protocol separate from chat', async context => {
  const login = deferred()
  const fake = fakeClient({ login: login.promise })
  let received: OneBotWebSocketOptions | undefined
  const manager = createOneBotConnectionManager({ createClient(options) { received = options; return fake.client } })
  context.after(() => manager.close())
  const controller = new AbortController()
  const selected = configuration()
  const before = JSON.stringify(selected)
  const connecting = manager.connect(selected, controller.signal)
  await fake.entered
  assert.deepEqual(manager.status(), { running: false })
  assert.equal(manager.connectionStatus().state, 'connecting')
  login.resolve()
  assert.deepEqual(received, { endpoint: selected.onebotWs.endpoint, accessToken: 'private-ws-secret', callbackTimeoutMs: 300_000, connectTimeoutMs: 5_000, maxReconnectAttempts: null })
  login.resolve()
  await connecting
  assert.deepEqual(manager.status(), { running: true })
  assert.deepEqual(manager.connectionStatus(), { state: 'connected', selfId: '123', lastError: null, received: 2, dropped: 2, chatReady: false, accountOnline: null, accountGood: null })
  controller.abort()
  assert.equal(fake.signal()?.aborted, false)
  await manager.disconnect()
  assert.equal(fake.signal()?.aborted, true)
  assert.deepEqual(manager.status(), { running: false })
  assert.equal(fake.closes(), 1)
  assert.equal(JSON.stringify(selected), before)
  assert(!JSON.stringify(manager.connectionStatus()).includes('private-ws-secret'))
})

test('manager closes the previous client before replacement and close is terminal and idempotent', async context => {
  const first = fakeClient()
  const second = fakeClient()
  let calls = 0
  const manager = createOneBotConnectionManager({ createClient() {
    calls += 1
    if (calls === 1) return first.client
    assert.equal(first.closes(), 1)
    assert.equal(first.signal()?.aborted, true)
    return second.client
  } })
  context.after(() => manager.close())
  await manager.connect(configuration(), new AbortController().signal)
  await manager.connect(configuration('wss://other.example.test'), new AbortController().signal)
  assert.equal(calls, 2)
  await Promise.all([manager.close(), manager.close()])
  assert.equal(second.closes(), 1)
  assert.deepEqual(manager.status(), { running: false })
  await assert.rejects(manager.connect(configuration(), new AbortController().signal), { code: 'adapter_runtime_closed' })
})

test('concurrent manager starts reject and disconnect cancels a pending handshake without waiting for raw login', async context => {
  const login = deferred()
  const fake = fakeClient({ login: login.promise })
  const manager = createOneBotConnectionManager({ createClient: () => fake.client })
  context.after(() => manager.close())
  const connecting = manager.connect(configuration(), new AbortController().signal)
  const rejection = assert.rejects(connecting, { code: 'onebot_ws_connection_failed' })
  await fake.entered
  await assert.rejects(manager.connect(configuration(), new AbortController().signal), { code: 'adapter_runtime_busy' })
  await manager.disconnect()
  await rejection
  assert.equal(fake.signal()?.aborted, true)
  assert.equal(manager.connectionStatus().state, 'disconnected')
  login.resolve()
})

test('manager start deadline, client aborts and failed logins close the client without exposing diagnostics', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const login = deferred()
  const fake = fakeClient({ login: login.promise })
  const manager = createOneBotConnectionManager({ createClient: () => fake.client })
  context.after(() => manager.close())
  const connecting = manager.connect(configuration(), new AbortController().signal)
  const rejection = assert.rejects(connecting, { code: 'onebot_ws_connection_failed' })
  await fake.entered
  context.mock.timers.tick(10_000)
  await rejection
  assert.equal(fake.closes(), 1)
  assert.deepEqual(manager.status(), { running: false })
  assert.equal(manager.connectionStatus().state, 'error')
  login.resolve()
  const failed = fakeClient({ failed: true })
  const rejected = createOneBotConnectionManager({ createClient: () => failed.client })
  context.after(() => rejected.close())
  await assert.rejects(rejected.connect(configuration(), new AbortController().signal), { code: 'onebot_ws_connection_failed' })
  assert.equal(failed.closes(), 1)
  assert(!JSON.stringify(rejected.connectionStatus()).includes('private-raw-network-diagnostic'))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(rejected.connect(configuration(), controller.signal), { code: 'adapter_runtime_aborted' })
})

test('manager stop remains bounded if an injected client does not settle its close', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const close = deferred()
  const fake = fakeClient({ close: close.promise })
  const manager = createOneBotConnectionManager({ createClient: () => fake.client })
  await manager.connect(configuration(), new AbortController().signal)
  const stopping = manager.disconnect()
  const rejected = assert.rejects(stopping, { code: 'adapter_runtime_aborted' })
  await fake.closing
  context.mock.timers.tick(5_000)
  await rejected
  close.resolve()
  await manager.close()
})

test('no-auth WS omits credentials, never borrows the HTTP token and disconnect cancels finite recovery', async context => {
  const sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolvePromise => sockets.once('listening', () => resolvePromise()))
  context.after(async () => {
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>(resolvePromise => sockets.close(() => resolvePromise()))
  })
  const address = sockets.address()
  assert(address !== null && typeof address !== 'string')
  let connections = 0
  sockets.on('connection', (socket, request) => {
    connections += 1
    assert.equal(request.headers.authorization, undefined)
    socket.on('message', raw => {
      const request: unknown = JSON.parse(raw.toString())
      assert(request !== null && typeof request === 'object' && 'action' in request && 'echo' in request)
      assert.equal(request.action, 'get_login_info')
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { user_id: 123 } }))
    })
  })
  const manager = createOneBotConnectionManager()
  context.after(() => manager.close())
  const selected = updateAdapterConfiguration(createDefaultAdapterConfiguration(), {
    onebotHttp: { enabled: true, endpoint: 'https://http.example.test', secret: 'http-only-private-token' },
    onebotWs: { enabled: true, endpoint: `ws://127.0.0.1:${address.port}` }
  })
  await manager.connect(selected, new AbortController().signal)
  assert.deepEqual(manager.status(), { running: true })
  assert.equal(connections, 1)
  for (const socket of sockets.clients) socket.terminate()
  for (let attempt = 0; attempt < 150 && manager.connectionStatus().state !== 'reconnecting'; attempt += 1) await delay(5)
  assert.equal(manager.connectionStatus().state, 'reconnecting')
  assert.deepEqual(manager.status(), { running: false })
  await manager.disconnect()
  await delay(350)
  assert.equal(manager.connectionStatus().state, 'disconnected')
  assert.equal(connections, 1)
  await manager.connect(selected, new AbortController().signal)
  assert.equal(connections, 2)
  assert.equal(manager.connectionStatus().chatReady, false)
  await manager.close()
  await delay(350)
  assert.equal(connections, 2)
})
