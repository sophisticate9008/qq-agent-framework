import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { createNativeRuntimeRoutes } from '../src/admin/runtime.ts'
import { AdminRequestError, type AdminRoute } from '../src/admin/server.ts'

function fixture(context: TestContext): { readonly root: string; readonly directory: string } {
  const root = mkdtempSync(join(tmpdir(), 'native-runtime-'))
  const directory = join(root, 'runtime')
  context.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, directory }
}

function route(routes: readonly AdminRoute[], method: 'GET' | 'POST', pathname: string): AdminRoute {
  const selected = routes.find(candidate => candidate.method === method && candidate.pathname === pathname)
  assert(selected)
  return selected
}

async function invoke(
  routes: readonly AdminRoute[],
  method: 'GET' | 'POST',
  pathname: string,
  body: Record<string, unknown> | null = null,
  query = new URLSearchParams()
): Promise<Record<string, unknown>> {
  const value = await route(routes, method, pathname).handle({
    query,
    body,
    signal: new AbortController().signal
  })
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

async function rejects(
  operation: Promise<unknown>,
  statusCode: number,
  code: string
): Promise<void> {
  await assert.rejects(operation, error => error instanceof AdminRequestError
    && error.statusCode === statusCode && error.code === code)
}

async function waitForOutput(stream: NodeJS.ReadableStream, expected: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onData = (chunk: Buffer | string): void => {
      if (!String(chunk).includes(expected)) return
      cleanup()
      resolvePromise()
    }
    const onError = (error: Error): void => {
      cleanup()
      rejectPromise(error)
    }
    const cleanup = (): void => {
      stream.off('data', onData)
      stream.off('error', onError)
    }
    stream.on('data', onData)
    stream.on('error', onError)
  })
}

const persona = {
  id: 'harbor', name: 'Harbor', identity: 'A native persona.', style: 'Concise.'
} as const
const plan = {
  id: 'daily', name: 'Daily', description: '', instructions: 'Use the system instruction.',
  personaId: 'harbor', provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'low'
} as const

test('native runtime exposes empty editable resources without fabricating a connected host', async context => {
  const files = fixture(context)
  const routes = createNativeRuntimeRoutes({ directory: files.directory })
  assert.deepEqual(routes.map(item => `${item.method} ${item.pathname}`), [
    'GET /api/chat/plans', 'POST /api/chat/plans',
    'GET /api/chat/personas', 'POST /api/chat/personas',
    'GET /api/chat/model', 'POST /api/chat/model',
    'GET /api/chat/access', 'POST /api/chat/access',
    'GET /api/chat/status', 'GET /api/chat/features',
    'GET /api/chat/sessions', 'GET /api/chat/usage',
    'POST /api/chat/sessions/reset',
    'GET /api/chat/usage/series', 'GET /api/chat/usage/turns', 'GET /api/chat/usage/recent',
    'POST /api/chat/usage/reset',
    'GET /api/chat/adapters', 'POST /api/chat/adapters'
  ])
  const plans = await invoke(routes, 'GET', '/api/chat/plans')
  const personas = await invoke(routes, 'GET', '/api/chat/personas')
  const access = await invoke(routes, 'GET', '/api/chat/access')
  assert.deepEqual({ activePlanId: plans.activePlanId, plans: plans.plans }, { activePlanId: null, plans: [] })
  assert.deepEqual(personas.personas, [])
  assert.deepEqual({ allow: access.allow, deny: access.deny, owner: access.owner }, {
    allow: [], deny: [], owner: null
  })
  assert.deepEqual(await invoke(routes, 'GET', '/api/chat/model'), {
    revision: plans.revision,
    activePlanId: null,
    provider: null,
    model: null,
    reasoningEffort: null
  })
  const features = await invoke(routes, 'GET', '/api/chat/features')
  assert.deepEqual(await invoke(routes, 'GET', '/api/chat/status'), { runtimeConnected: false })
  assert.equal(features.runtimeConnected, false)
  assert.equal(features.editableResources, true)
  assert.deepEqual(features.features, [])
  assert((features.capabilities as Array<{ installed: boolean }>).every(capability => !capability.installed))
  await rejects(invoke(routes, 'GET', '/api/chat/sessions'), 503, 'runtime_not_connected')
  await rejects(invoke(routes, 'GET', '/api/chat/usage'), 503, 'runtime_not_connected')
  await rejects(invoke(routes, 'POST', '/api/chat/sessions/reset', { key: 'group:123' }),
    503, 'runtime_not_connected')
  await rejects(invoke(routes, 'GET', '/api/chat/usage/series'), 503, 'runtime_not_connected')
  await rejects(invoke(routes, 'GET', '/api/chat/usage/turns'), 503, 'runtime_not_connected')
  await rejects(invoke(routes, 'GET', '/api/chat/usage/recent'), 503, 'runtime_not_connected')
  await rejects(invoke(routes, 'POST', '/api/chat/usage/reset', { confirm: 'reset' }),
    503, 'runtime_not_connected')
  assert.equal(statSync(files.directory).mode & 0o777, 0o700)
})

test('native catalogs persist with CAS and model writes update only the active plan', async context => {
  const files = fixture(context)
  const routes = createNativeRuntimeRoutes({ directory: files.directory })
  const initialPersonas = await invoke(routes, 'GET', '/api/chat/personas')
  const savedPersonas = await invoke(routes, 'POST', '/api/chat/personas', {
    revision: initialPersonas.revision,
    personas: [persona]
  })
  assert.notEqual(savedPersonas.revision, initialPersonas.revision)
  const initialPlans = await invoke(routes, 'GET', '/api/chat/plans')
  const savedPlans = await invoke(routes, 'POST', '/api/chat/plans', {
    revision: initialPlans.revision,
    activePlanId: 'daily',
    plans: [plan]
  })
  assert.equal(savedPlans.activePlanId, 'daily')
  const model = await invoke(routes, 'POST', '/api/chat/model', {
    revision: savedPlans.revision,
    provider: 'native-provider',
    model: 'native/model-v2',
    reasoningEffort: 'high'
  })
  assert.deepEqual(model, {
    revision: model.revision,
    activePlanId: 'daily',
    provider: 'native-provider',
    model: 'native/model-v2',
    reasoningEffort: 'high'
  })
  const finalPlans = await invoke(routes, 'GET', '/api/chat/plans')
  assert.equal(finalPlans.revision, model.revision)
  assert.deepEqual(finalPlans.plans, [{
    ...plan, provider: 'native-provider', model: 'native/model-v2', reasoningEffort: 'high'
  }])
  await rejects(invoke(routes, 'POST', '/api/chat/plans', {
    revision: initialPlans.revision, activePlanId: null, plans: []
  }), 409, 'chat_revision_conflict')
  await rejects(invoke(routes, 'POST', '/api/chat/personas', {
    revision: savedPersonas.revision, personas: []
  }), 409, 'persona_in_use_or_missing')
  for (const filename of ['chat-plans.json', 'chat-personas.json']) {
    assert.equal(statSync(join(files.directory, filename)).mode & 0o777, 0o600)
  }
})

test('plan creation and persona deletion serialize reference checks with their commits', async context => {
  const files = fixture(context)
  const routes = createNativeRuntimeRoutes({ directory: files.directory })
  const initialPersonas = await invoke(routes, 'GET', '/api/chat/personas')
  const savedPersonas = await invoke(routes, 'POST', '/api/chat/personas', {
    revision: initialPersonas.revision,
    personas: [persona]
  })
  const initialPlans = await invoke(routes, 'GET', '/api/chat/plans')
  const results = await Promise.allSettled([
    invoke(routes, 'POST', '/api/chat/plans', {
      revision: initialPlans.revision,
      activePlanId: 'daily',
      plans: [plan]
    }),
    invoke(routes, 'POST', '/api/chat/personas', {
      revision: savedPersonas.revision,
      personas: []
    })
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejection = results.find(result => result.status === 'rejected')
  assert(rejection?.status === 'rejected')
  assert(rejection.reason instanceof AdminRequestError)
  assert.equal(rejection.reason.code, 'persona_in_use_or_missing')
  const finalPlans = await invoke(routes, 'GET', '/api/chat/plans')
  const finalPersonas = await invoke(routes, 'GET', '/api/chat/personas')
  const personaIds = new Set((finalPersonas.personas as Array<{ id: string }>).map(entry => entry.id))
  for (const entry of finalPlans.plans as Array<{ personaId: string }>) {
    assert(personaIds.has(entry.personaId))
  }
})

test('a lock held by another process rejects writes without changing the document', async context => {
  const files = fixture(context)
  const routes = createNativeRuntimeRoutes({ directory: files.directory })
  const initial = await invoke(routes, 'GET', '/api/chat/access')
  const lockFile = join(files.directory, '.chat-runtime.lock')
  const child = spawn(process.execPath, ['-e', [
    "const { openSync } = require('node:fs')",
    'openSync(process.argv[1], \'wx\', 0o600)',
    "process.stdout.write('locked\\n')",
    'setInterval(() => undefined, 1000)'
  ].join(';'), lockFile], { stdio: ['ignore', 'pipe', 'inherit'] })
  context.after(() => {
    child.kill('SIGKILL')
    rmSync(lockFile, { force: true })
  })
  assert(child.stdout)
  await waitForOutput(child.stdout, 'locked')
  await rejects(invoke(routes, 'POST', '/api/chat/access', {
    revision: initial.revision,
    allow: ['group:123'],
    deny: [],
    owner: null
  }), 409, 'chat_storage_busy')
  assert.deepEqual(await invoke(routes, 'GET', '/api/chat/access'), initial)
  child.kill('SIGTERM')
  await once(child, 'exit')
  rmSync(lockFile, { force: true })
})

test('directory sync failure after rename reports an unknown write result', context => {
  const files = fixture(context)
  const script = `
    import { constants } from 'node:fs'
    import * as actual from 'node:fs/promises'
    import { pathToFileURL } from 'node:url'
    import { mock } from 'node:test'
    const directory = process.argv[1]
    mock.module('node:fs/promises', { namedExports: {
      ...actual,
      async open(path, flags, mode) {
        const handle = await actual.open(path, flags, mode)
        if (String(path) !== directory || (flags & constants.O_DIRECTORY) === 0) return handle
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'sync') return async () => { throw new Error('forced directory sync failure') }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }
    } })
    const runtimeUrl = pathToFileURL(process.cwd() + '/src/admin/runtime.ts').href + '?unknown-write-test'
    const serverUrl = pathToFileURL(process.cwd() + '/src/admin/server.ts').href
    const { createNativeRuntimeRoutes } = await import(runtimeUrl)
    const { AdminRequestError } = await import(serverUrl)
    const routes = createNativeRuntimeRoutes({ directory })
    const find = (method, pathname) => routes.find(route => route.method === method && route.pathname === pathname)
    const call = (method, pathname, body = null) => find(method, pathname).handle({
      query: new URLSearchParams(), body, signal: new AbortController().signal
    })
    const initial = await call('GET', '/api/chat/access')
    let failure
    try {
      await call('POST', '/api/chat/access', {
        revision: initial.revision, allow: ['group:123'], deny: [], owner: null
      })
    } catch (error) {
      failure = error instanceof AdminRequestError
        ? { statusCode: error.statusCode, code: error.code }
        : { statusCode: null, code: 'unexpected' }
    }
    const persisted = await call('GET', '/api/chat/access')
    process.stdout.write(JSON.stringify({ failure, allow: persisted.allow }))
  `
  const child = spawnSync(process.execPath, [
    '--experimental-test-module-mocks', '--input-type=module', '-e', script, files.directory
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout) as unknown, {
    failure: { statusCode: 500, code: 'chat_write_unknown' },
    allow: ['group:123']
  })
})

test('native access is deny-by-default and rejects ambiguous or unlisted input', async context => {
  const files = fixture(context)
  const routes = createNativeRuntimeRoutes({ directory: files.directory })
  const initial = await invoke(routes, 'GET', '/api/chat/access')
  const saved = await invoke(routes, 'POST', '/api/chat/access', {
    revision: initial.revision,
    allow: ['group:123', 'private:456'],
    deny: ['group:999'],
    owner: '456'
  })
  assert.deepEqual(saved, {
    revision: saved.revision,
    allow: ['group:123', 'private:456'],
    deny: ['group:999'],
    owner: '456'
  })
  await rejects(invoke(routes, 'POST', '/api/chat/access', {
    revision: saved.revision,
    allow: ['group:123'],
    deny: ['group:123'],
    owner: null
  }), 400, 'invalid_chat_request')
  await rejects(invoke(routes, 'POST', '/api/chat/access', {
    revision: saved.revision,
    allow: [],
    deny: [],
    owner: null,
    allowAllWhenEmpty: true
  }), 400, 'invalid_chat_request')
})

test('native storage rejects symlinks, unsafe files, invalid requests and missing active plans', async context => {
  const files = fixture(context)
  const target = join(files.root, 'target')
  writeFileSync(target, '{}', { mode: 0o600 })
  symlinkSync(target, files.directory)
  const symlinkRoutes = createNativeRuntimeRoutes({ directory: files.directory })
  await new Promise<void>(resolvePromise => setImmediate(resolvePromise))
  await rejects(invoke(symlinkRoutes, 'GET', '/api/chat/plans'), 500, 'chat_storage_invalid')
  rmSync(files.directory)
  const routes = createNativeRuntimeRoutes({ directory: files.directory })
  const initial = await invoke(routes, 'GET', '/api/chat/plans')
  await rejects(invoke(routes, 'POST', '/api/chat/model', {
    revision: initial.revision,
    provider: 'native-provider',
    model: 'native-model',
    reasoningEffort: 'low'
  }), 409, 'no_active_plan')
  await rejects(invoke(routes, 'POST', '/api/chat/plans', {
    revision: initial.revision,
    activePlanId: 'daily',
    plans: [{ ...plan, tools: ['shell'] }]
  }), 400, 'invalid_chat_request')
  writeFileSync(join(files.directory, 'chat-plans.json'), JSON.stringify({ schema: 1 }), { mode: 0o644 })
  await rejects(invoke(routes, 'GET', '/api/chat/plans'), 500, 'chat_storage_invalid')
  assert.equal(readFileSync(target, 'utf8'), '{}')
})
