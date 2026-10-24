import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { createNativeRuntimeRoutes, type NativeRuntimeRouteOptions } from '../src/admin/runtime.ts'
import { AdminRequestError, type AdminRoute } from '../src/admin/server.ts'

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
  assert.deepEqual(Object.keys(adapters), ['onebotHttp', 'dshAgent', 'onebotWebhook'])
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
    enabled: true, endpoint: 'https://agent.example.test', authConfigured: true
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
  assert.deepEqual(Object.keys(privateAdapters), ['onebotHttp', 'dshAgent', 'onebotWebhook'])
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
  assert.equal(failed.reason.code, 'chat_revision_conflict')
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
  assert.equal((await invoke(setup.routes, 'GET')).revision, saved.revision)
  assert.throws(() => createNativeRuntimeRoutes({
    directory: setup.directory, adapterRuntime: { status: 'unsafe' }
  } as unknown as NativeRuntimeRouteOptions))
})
