import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { createNativeRuntimeRoutes, type NativeRuntimeRouteOptions } from '../src/admin/runtime.ts'
import { AdminRequestError, type AdminRoute } from '../src/admin/server.ts'
import { createDefaultAdapterConfiguration, type AdapterConnectionStatus, type NativeAdapterConfiguration } from '../src/host/adapter-configuration.ts'

function fixture(context: TestContext): { directory: string; routes: readonly AdminRoute[] } {
  const root = mkdtempSync(join(tmpdir(), 'native-adapters-'))
  const directory = join(root, 'private')
  context.after(() => rmSync(root, { recursive: true, force: true }))
  return { directory, routes: createNativeRuntimeRoutes({ directory }) }
}

async function invoke(
  routes: readonly AdminRoute[],
  method: 'GET' | 'POST',
  body: Record<string, unknown> | null = null,
  query = new URLSearchParams()
): Promise<Record<string, unknown>> {
  const selected = routes.find(route => route.method === method && route.pathname === '/api/chat/adapters')
  assert(selected)
  const value: unknown = await selected.handle({ query, body, signal: new AbortController().signal })
  return object(value)
}

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

async function rejects(operation: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(operation, error => error instanceof AdminRequestError
    && error.statusCode === status && error.code === code && error.message === code)
}

test('adapters default to unassembled resources and saving never calls an external endpoint', async context => {
  const setup = fixture(context)
  let fetchCalls = 0
  context.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1
    throw new Error('External request must not run')
  })
  const initial = await invoke(setup.routes, 'GET')
  assert.match(String(initial.revision), /^[a-f0-9]{64}$/)
  assert.deepEqual(initial.status, { assembled: false, running: false, applyAvailable: false })
  const adapters = object(initial.adapters)
  assert.deepEqual(Object.keys(adapters), ['onebotHttp', 'onebotWs', 'dshAgent', 'onebotWebhook'])
  for (const value of Object.values(adapters)) assert.equal(object(value).enabled, false)
  const saved = await invoke(setup.routes, 'POST', {
    revision: initial.revision,
    adapters: {
      dshAgent: { enabled: true, endpoint: 'https://agent.example.test', auth: 'fixture-agent-auth' }
    }
  })
  assert.deepEqual(saved.status, initial.status)
  assert.deepEqual(Object.keys(object(saved.adapters)), Object.keys(adapters))
  assert.deepEqual(object(saved.adapters).dshAgent, {
    enabled: true, endpoint: 'https://agent.example.test', authConfigured: true, localAuthConfigured: false
  })
  assert.equal(fetchCalls, 0)
  assert.equal(statSync(setup.directory).mode & 0o777, 0o700)
  assert.equal(statSync(join(setup.directory, 'chat-adapters.json')).mode & 0o777, 0o600)
  assert.doesNotMatch(JSON.stringify(saved), /fixture-agent-auth|"auth":/)
})

test('adapter credentials survive partial and blank updates and are only cleared explicitly', async context => {
  const setup = fixture(context)
  const initial = await invoke(setup.routes, 'GET')
  const first = await invoke(setup.routes, 'POST', {
    revision: initial.revision,
    adapters: {
      onebotHttp: { enabled: false, endpoint: 'http://127.0.0.1:3000', secret: 'fixture-onebot-secret' },
      dshAgent: { enabled: false, endpoint: 'http://[::1]:3080', auth: 'fixture-dsh-auth' },
      onebotWebhook: { enabled: false, host: '127.0.0.1', port: 3211, selfId: '123', hmac: 'fixture-hmac' }
    }
  })
  const second = await invoke(setup.routes, 'POST', {
    revision: first.revision,
    adapters: { onebotHttp: { enabled: true, endpoint: 'http://127.0.0.1:3000', secret: '' } }
  })
  const stored = object(JSON.parse(readFileSync(join(setup.directory, 'chat-adapters.json'), 'utf8')) as unknown)
  const privateAdapters = object(stored.adapters)
  assert.deepEqual(Object.keys(privateAdapters), ['onebotHttp', 'onebotWs', 'dshAgent', 'onebotWebhook'])
  assert.equal(object(privateAdapters.onebotHttp).secret, 'fixture-onebot-secret')
  assert.equal(object(privateAdapters.dshAgent).auth, 'fixture-dsh-auth')
  assert.equal(object(privateAdapters.onebotWebhook).hmac, 'fixture-hmac')
  const third = await invoke(setup.routes, 'POST', {
    revision: second.revision,
    adapters: { onebotHttp: { enabled: false, endpoint: '', clearSecret: true } }
  })
  assert.equal(object(object(third.adapters).onebotHttp).secretConfigured, false)
  assert.equal(object(object(third.adapters).dshAgent).authConfigured, true)
  for (const response of [first, second, third, await invoke(setup.routes, 'GET')]) {
    assert.doesNotMatch(JSON.stringify(response), /fixture-|"secret":|"auth":|"token":|"hmac":/)
  }
})

test('adapter CAS is shared across route instances and rejects stale concurrent updates', async context => {
  const setup = fixture(context)
  const other = createNativeRuntimeRoutes({ directory: setup.directory })
  const initial = await invoke(setup.routes, 'GET')
  const requests = [setup.routes, other].map((routes, index) => invoke(routes, 'POST', {
    revision: initial.revision,
    adapters: { dshAgent: { enabled: false, endpoint: `https://agent-${index}.example.test` } }
  }))
  const results = await Promise.allSettled(requests)
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const failed = results.find(result => result.status === 'rejected')
  assert(failed?.status === 'rejected')
  assert(failed.reason instanceof AdminRequestError)
  assert.equal(failed.reason.code, 'native_chat_busy')
  await rejects(invoke(other, 'POST', {
    revision: initial.revision,
    adapters: { dshAgent: { enabled: false, endpoint: 'https://stale.example.test' } }
  }), 409, 'chat_revision_conflict')
})

test('adapter saves honor a private lockfile created by another process', async context => {
  const setup = fixture(context)
  const initial = await invoke(setup.routes, 'GET')
  const lockFile = join(setup.directory, '.chat-runtime.lock')
  const child = spawnSync(process.execPath, ['-e',
    "require('node:fs').writeFileSync(process.argv[1], '', {flag: 'wx', mode: 0o600})", lockFile
  ], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  await rejects(invoke(setup.routes, 'POST', {
    revision: initial.revision,
    adapters: { dshAgent: { enabled: false, endpoint: 'https://agent.example.test' } }
  }), 409, 'chat_storage_busy')
  assert.deepEqual(await invoke(setup.routes, 'GET'), initial)
})

test('adapter input validation rejects unknown fields and returns credential-free stable errors', async context => {
  const setup = fixture(context)
  const initial = await invoke(setup.routes, 'GET')
  for (const body of [
    { ...initial },
    { revision: initial.revision, adapters: {} },
    { revision: initial.revision, adapters: { shell: { module: 'node:child_process' } } },
    { revision: initial.revision, adapters: { dshAgent: {
      enabled: true, endpoint: 'http://remote.example.test', auth: 'private-fixture-secret'
    } } },
    { revision: initial.revision, adapters: { dshAgent: {
      enabled: false, endpoint: '', auth: 'private-fixture-secret', clearAuth: true
    } } },
    { revision: 'bad', adapters: { dshAgent: { enabled: false, endpoint: '' } } }
  ]) await rejects(invoke(setup.routes, 'POST', body), 400, 'invalid_adapter_configuration')
  await rejects(invoke(setup.routes, 'GET', null, new URLSearchParams('directory=/tmp')),
    400, 'invalid_query')
  assert.deepEqual(await invoke(setup.routes, 'GET'), initial)
})

test('adapter API rejects private imageWorker patches without changing stored data or revision', async context => {
  const setup = fixture(context)
  const initial = await invoke(setup.routes, 'GET')
  const saved = await invoke(setup.routes, 'POST', {
    revision: initial.revision,
    adapters: { dshAgent: { enabled: false, endpoint: '', auth: 'private-agent-auth' } }
  })
  const filename = join(setup.directory, 'chat-adapters.json')
  const original = readFileSync(filename)
  for (const imageWorker of [
    null,
    {},
    { enabled: false, endpoint: '', token: '' },
    { enabled: true, endpoint: 'https://image.example.test', token: 'private-image-token' },
    { enabled: false, endpoint: '', tokenConfigured: false },
    { enabled: false, endpoint: '', clearToken: true }
  ]) {
    for (const adapters of [
      { imageWorker },
      { imageWorker, dshAgent: { enabled: false, endpoint: '', clearAuth: true } }
    ]) {
      await rejects(invoke(setup.routes, 'POST', { revision: saved.revision, adapters }),
        400, 'invalid_adapter_configuration')
      assert.deepEqual(readFileSync(filename), original)
      assert.deepEqual(await invoke(setup.routes, 'GET'), saved)
    }
  }
})

test('persisted private imageWorker fields require operator migration and are never rewritten or reset', async context => {
  const setup = fixture(context)
  const initial = await invoke(setup.routes, 'GET')
  const saved = await invoke(setup.routes, 'POST', {
    revision: initial.revision,
    adapters: { dshAgent: { enabled: false, endpoint: '', auth: 'private-agent-auth' } }
  })
  const filename = join(setup.directory, 'chat-adapters.json')
  const stored = object(JSON.parse(readFileSync(filename, 'utf8')) as unknown)
  for (const enabled of [false, true]) {
    const original = Buffer.from(`${JSON.stringify({
      ...stored,
      adapters: {
        ...object(stored.adapters),
        imageWorker: { enabled, endpoint: 'https://image.example.test', token: 'private-image-token' }
      }
    }, null, 2)}\n`)
    writeFileSync(filename, original)
    const before = statSync(filename)
    const reopened = createNativeRuntimeRoutes({ directory: setup.directory })
    for (const routes of [setup.routes, reopened]) {
      await rejects(invoke(routes, 'GET'), 500, 'chat_storage_invalid')
      await rejects(invoke(routes, 'POST', {
        revision: saved.revision,
        adapters: { dshAgent: { enabled: false, endpoint: '', clearAuth: true } }
      }), 500, 'chat_storage_invalid')
      assert.deepEqual(readFileSync(filename), original)
      const after = statSync(filename)
      assert.equal(after.ino, before.ino)
      assert.equal(after.mtimeMs, before.mtimeMs)
      assert.equal(after.mode & 0o777, 0o600)
    }
  }
})

test('adapter documents reject unsafe permissions, symlinks, corruption and excess size', async context => {
  const setup = fixture(context)
  const initial = await invoke(setup.routes, 'GET')
  await invoke(setup.routes, 'POST', {
    revision: initial.revision,
    adapters: { onebotHttp: { enabled: false, endpoint: '' } }
  })
  const filename = join(setup.directory, 'chat-adapters.json')
  chmodSync(filename, 0o644)
  await rejects(invoke(setup.routes, 'GET'), 500, 'chat_storage_invalid')
  chmodSync(filename, 0o600)
  const target = join(setup.directory, 'untouched.json')
  writeFileSync(target, '{}', { mode: 0o600 })
  rmSync(filename)
  symlinkSync(target, filename)
  await rejects(invoke(setup.routes, 'GET'), 500, 'chat_storage_invalid')
  await rejects(invoke(setup.routes, 'POST', {
    revision: initial.revision, adapters: { onebotHttp: { enabled: false, endpoint: '' } }
  }), 500, 'chat_storage_invalid')
  assert.equal(readFileSync(target, 'utf8'), '{}')
  rmSync(filename)
  writeFileSync(filename, '{broken', { mode: 0o600 })
  await rejects(invoke(setup.routes, 'GET'), 500, 'chat_storage_invalid')
  writeFileSync(filename, ' '.repeat(64 * 1024 + 1))
  await rejects(invoke(setup.routes, 'GET'), 500, 'chat_storage_invalid')
})

test('an explicit host status port reports runtime state independently from saved configuration', async context => {
  const setup = fixture(context)
  let running = false
  let calls = 0
  const routes = createNativeRuntimeRoutes({ directory: setup.directory, adapterRuntime: {
    status(...args: unknown[]) {
      assert.equal(args.length, 0)
      calls += 1
      return { running }
    }
  } })
  const initial = await invoke(routes, 'GET')
  assert.deepEqual(initial.status, { assembled: true, running: false, applyAvailable: false })
  running = true
  const saved = await invoke(routes, 'POST', {
    revision: initial.revision,
    adapters: { dshAgent: { enabled: false, endpoint: '' } }
  })
  assert.deepEqual(saved.status, { assembled: true, running: true, applyAvailable: false })
  assert.equal(calls, 2)
  assert.equal(object(object(saved.adapters).dshAgent).enabled, false)
  const unavailable = createNativeRuntimeRoutes({ directory: setup.directory, adapterRuntime: {
    status() { throw new Error('private-status-diagnostic') }
  } })
  await rejects(invoke(unavailable, 'GET'), 503, 'adapter_runtime_status_unavailable')
  await rejects(invoke(unavailable, 'POST', {
    revision: saved.revision,
    adapters: { dshAgent: { enabled: false, endpoint: 'https://new.example.test' } }
  }), 503, 'adapter_runtime_status_unavailable')
  const malformed = createNativeRuntimeRoutes({ directory: setup.directory, adapterRuntime: {
    status: (() => ({ running: 'yes', token: 'private-status-token' })) as unknown as
      NonNullable<NativeRuntimeRouteOptions['adapterRuntime']>['status']
  } })
  await rejects(invoke(malformed, 'GET'), 503, 'adapter_runtime_status_unavailable')
  const observed = await invoke(setup.routes, 'GET')
  assert.notEqual(observed.revision, saved.revision)
  assert.equal(object(object(observed.adapters).dshAgent).endpoint, 'https://new.example.test')
  assert.throws(() => createNativeRuntimeRoutes({
    directory: setup.directory, adapterRuntime: { status: 'unsafe' }
  } as unknown as NativeRuntimeRouteOptions))
})

async function control(
  routes: readonly AdminRoute[],
  action: 'connect' | 'disconnect',
  body: Record<string, unknown>,
  signal = new AbortController().signal
): Promise<Record<string, unknown>> {
  const route = routes.find(entry => entry.method === 'POST' && entry.pathname === `/api/chat/adapters/${action}`)
  assert(route)
  return object(await route.handle({ query: new URLSearchParams(), body, signal }))
}

test('old three-adapter documents normalize WS without rewriting HTTP settings or credential files', async context => {
  const setup = fixture(context)
  await invoke(setup.routes, 'GET')
  const { onebotWs: omitted, ...legacy } = createDefaultAdapterConfiguration()
  void omitted
  const adapters = { ...legacy, onebotHttp: { enabled: true, endpoint: 'https://http.example.test', secret: 'old-http-secret' } }
  const filename = join(setup.directory, 'chat-adapters.json')
  const original = `${JSON.stringify({ schema: 1, adapters }, null, 2)}\n`
  writeFileSync(filename, original, { mode: 0o600 })
  const before = statSync(filename)
  const initial = await invoke(setup.routes, 'GET')
  assert.deepEqual(object(initial.adapters).onebotWs, { enabled: false, endpoint: '', secretConfigured: false })
  assert.deepEqual(object(initial.adapters).onebotHttp, { enabled: true, endpoint: 'https://http.example.test', secretConfigured: true })
  assert.equal(readFileSync(filename, 'utf8'), original)
  assert.equal(statSync(filename).ino, before.ino)
  await invoke(setup.routes, 'POST', {
    revision: initial.revision, adapters: { onebotWs: { enabled: false, endpoint: 'wss://gateway.example.test', secret: 'ws-secret' } }
  })
  const stored = object(object(JSON.parse(readFileSync(filename, 'utf8')) as unknown).adapters)
  assert.deepEqual(stored.onebotHttp, adapters.onebotHttp)
})

test('adapter controls require a real optional port, strict input and current saved revision', async context => {
  const setup = fixture(context)
  const initial = await invoke(setup.routes, 'GET')
  await rejects(control(setup.routes, 'connect', { revision: initial.revision }), 503, 'adapter_runtime_unavailable')
  await rejects(control(setup.routes, 'disconnect', {}), 503, 'adapter_runtime_unavailable')
  const statusOnly = createNativeRuntimeRoutes({ directory: setup.directory, adapterRuntime: { status: () => ({ running: false }) } })
  await rejects(control(statusOnly, 'connect', { revision: initial.revision }), 503, 'adapter_runtime_unavailable')
  await rejects(control(statusOnly, 'disconnect', {}), 503, 'adapter_runtime_unavailable')
  let calls = 0
  const routes = createNativeRuntimeRoutes({ directory: setup.directory, adapterRuntime: {
    status: () => ({ running: false }), async connect() { calls += 1 }, async disconnect() { calls += 1 }
  } })
  for (const body of [{}, { revision: 'bad' }, { revision: initial.revision, endpoint: 'wss://elsewhere.test' }]) {
    await rejects(control(routes, 'connect', body), 400, 'invalid_adapter_configuration')
  }
  await rejects(control(routes, 'disconnect', { revision: initial.revision }), 400, 'invalid_adapter_configuration')
  await rejects(control(routes, 'connect', { revision: 'f'.repeat(64) }), 409, 'chat_revision_conflict')
  assert.equal(calls, 0)
})

test('explicit controls receive saved private configuration under lock and never rewrite it or claim chat readiness', async context => {
  const setup = fixture(context)
  const initial = await invoke(setup.routes, 'GET')
  const saved = await invoke(setup.routes, 'POST', { revision: initial.revision, adapters: {
    onebotHttp: { enabled: true, endpoint: 'https://http.example.test', secret: 'existing-http-secret' },
    onebotWs: { enabled: true, endpoint: 'ws://127.0.0.1:3001', secret: 'private-ws-secret' }
  } })
  const filename = join(setup.directory, 'chat-adapters.json')
  const original = readFileSync(filename)
  const before = statSync(filename)
  let connected = false
  let received: NativeAdapterConfiguration | undefined
  const routes = createNativeRuntimeRoutes({ directory: setup.directory, adapterRuntime: {
    status: () => ({ running: connected }),
    async connect(configuration, signal) {
      assert.equal(signal.aborted, false)
      assert.equal(statSync(join(setup.directory, '.chat-runtime.lock')).mode & 0o777, 0o600)
      received = configuration
      connected = true
    },
    async disconnect() { connected = false },
    connectionStatus: () => ({ state: connected ? 'connected' : 'disconnected', selfId: connected ? '123' : null,
      lastError: null, received: 3, dropped: 3, chatReady: false })
  } })
  const ready = await control(routes, 'connect', { revision: saved.revision })
  assert.equal(received?.onebotWs.secret, 'private-ws-secret')
  assert.equal(received?.onebotHttp.secret, 'existing-http-secret')
  assert(Object.isFrozen(received))
  assert.deepEqual(ready.status, { assembled: true, running: true, applyAvailable: true })
  assert.deepEqual(ready.connection, { state: 'connected', selfId: '123', lastError: null, received: 3, dropped: 3, chatReady: false, accountOnline: null, accountGood: null })
  assert.equal(ready.revision, saved.revision)
  const disconnected = await control(routes, 'disconnect', {})
  assert.deepEqual(disconnected.status, { assembled: true, running: false, applyAvailable: true })
  assert.equal(object(disconnected.connection).state, 'disconnected')
  assert.deepEqual(readFileSync(filename), original)
  assert.equal(statSync(filename).ino, before.ino)
  assert.equal(statSync(filename).mtimeMs, before.mtimeMs)
  const chat = routes.find(route => route.pathname === '/api/chat/status')
  assert(chat)
  assert.deepEqual(await chat.handle({ query: new URLSearchParams(), body: null, signal: new AbortController().signal }), { runtimeConnected: false })
  assert.doesNotMatch(JSON.stringify([ready, disconnected]), /private-ws-secret|existing-http-secret|"secret":/)
})

test('in-flight controls reject concurrent controls and configuration writes without queueing or retry', async context => {
  const setup = fixture(context)
  const initial = await invoke(setup.routes, 'GET')
  let started: (() => void) | undefined
  const entered = new Promise<void>(resolvePromise => { started = resolvePromise })
  let release: (() => void) | undefined
  const pending = new Promise<void>(resolvePromise => { release = resolvePromise })
  const port = { status: () => ({ running: false }), async connect() { started?.(); await pending }, async disconnect() {} }
  const routes = createNativeRuntimeRoutes({ directory: setup.directory, adapterRuntime: port })
  const other = createNativeRuntimeRoutes({ directory: setup.directory, adapterRuntime: port })
  const first = control(routes, 'connect', { revision: initial.revision })
  await entered
  try {
    await rejects(control(other, 'connect', { revision: initial.revision }), 409, 'adapter_runtime_busy')
    await rejects(control(other, 'disconnect', {}), 409, 'native_chat_busy')
    await rejects(invoke(other, 'POST', { revision: initial.revision, adapters: {
      onebotHttp: { enabled: true, endpoint: 'https://http.example.test' }
    } }), 409, 'native_chat_busy')
  } finally {
    release?.()
    await first
  }
})

test('control timeout aborts the port at twelve seconds and retains exclusion until the raw operation settles', async context => {
  const setup = fixture(context)
  const initial = await invoke(setup.routes, 'GET')
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let started: (() => void) | undefined
  const entered = new Promise<void>(resolvePromise => { started = resolvePromise })
  let release: (() => void) | undefined
  const pending = new Promise<void>(resolvePromise => { release = resolvePromise })
  let signal: AbortSignal | undefined
  const routes = createNativeRuntimeRoutes({ directory: setup.directory, adapterRuntime: {
    status: () => ({ running: false }), async connect(_configuration, controlSignal) { signal = controlSignal; started?.(); await pending }
  } })
  const first = control(routes, 'connect', { revision: initial.revision })
  const rejection = rejects(first, 504, 'adapter_runtime_timeout')
  await entered
  context.mock.timers.tick(12_000)
  await rejection
  assert.equal(signal?.aborted, true)
  await rejects(control(routes, 'connect', { revision: initial.revision }), 409, 'adapter_runtime_busy')
  release?.()
})

test('client cancellation reaches controls and raw runtime diagnostics are never returned', async context => {
  const setup = fixture(context)
  const initial = await invoke(setup.routes, 'GET')
  let started: (() => void) | undefined
  const entered = new Promise<void>(resolvePromise => { started = resolvePromise })
  let observed: AbortSignal | undefined
  const routes = createNativeRuntimeRoutes({ directory: setup.directory, adapterRuntime: {
    status: () => ({ running: false }),
    async connect(_configuration, signal) {
      observed = signal
      started?.()
      await new Promise<void>(resolvePromise => signal.addEventListener('abort', () => resolvePromise(), { once: true }))
    },
    async disconnect() { throw new Error('private-runtime-secret') },
    connectionStatus: () => ({ state: 'error', selfId: null, lastError: 'private-runtime-secret', received: 0, dropped: 0, chatReady: false })
  } })
  const controller = new AbortController()
  const attempt = control(routes, 'connect', { revision: initial.revision }, controller.signal)
  const rejection = rejects(attempt, 499, 'request_aborted')
  await entered
  controller.abort()
  await rejection
  assert.equal(observed?.aborted, true)
  assert.equal(object((await invoke(routes, 'GET')).connection).lastError, 'adapter_connection_error')
  const independent = createNativeRuntimeRoutes({ directory: `${setup.directory}-other`, adapterRuntime: {
    status: () => ({ running: false }), async disconnect() { throw new Error('private-runtime-secret') }
  } })
  context.after(() => rmSync(`${setup.directory}-other`, { recursive: true, force: true }))
  await rejects(control(independent, 'disconnect', {}), 503, 'adapter_connection_failed')
})

test('malformed optional runtime ports and connection status fail closed', async context => {
  const setup = fixture(context)
  for (const field of ['connect', 'disconnect', 'connectionStatus']) {
    assert.throws(() => createNativeRuntimeRoutes({ directory: setup.directory, adapterRuntime: {
      status: () => ({ running: false }), [field]: 'unsafe'
    } } as unknown as NativeRuntimeRouteOptions))
  }
  for (const connection of [
    { state: 'connected', selfId: '123', lastError: null, received: 1, dropped: 0, chatReady: true },
    { state: 'connected', selfId: 'private-secret', lastError: null, received: 1, dropped: 0, chatReady: false },
    { state: 'arbitrary', selfId: null, lastError: null, received: -1, dropped: 0, chatReady: false }
  ]) {
    const routes = createNativeRuntimeRoutes({ directory: setup.directory, adapterRuntime: {
      status: () => ({ running: false }), connectionStatus: () => connection as AdapterConnectionStatus
    } })
    await rejects(invoke(routes, 'GET'), 503, 'adapter_runtime_status_unavailable')
  }
})
