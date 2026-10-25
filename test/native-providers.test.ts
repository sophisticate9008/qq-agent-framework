import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { createNativeRuntimeRoutes } from '../src/admin/runtime.ts'
import { AdminRequestError, type AdminRoute } from '../src/admin/server.ts'

const provider = {
  id: 'primary', name: 'Primary', type: 'openai', baseUrl: 'https://model.example.test/v1',
  enabled: true, models: [{ id: 'chat', name: 'Chat' }]
} as const
const persona = { id: 'harbor', name: 'Harbor', identity: 'Native persona.', style: 'Concise.' } as const
const plan = {
  id: 'daily', name: 'Daily', description: '', instructions: 'Native instructions.',
  personaId: persona.id, provider: provider.id, model: 'chat', reasoningEffort: 'low'
} as const

function fixture(context: TestContext): { directory: string; routes: readonly AdminRoute[] } {
  const directory = mkdtempSync(join(tmpdir(), 'native-providers-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, routes: createNativeRuntimeRoutes({ directory }) }
}

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

async function invoke(
  routes: readonly AdminRoute[],
  method: 'GET' | 'POST',
  resource = 'providers',
  body: Record<string, unknown> | null = null,
  query = new URLSearchParams()
): Promise<Record<string, unknown>> {
  const route = routes.find(entry => entry.method === method && entry.pathname === `/api/chat/${resource}`)
  assert(route)
  return object(await route.handle({ query, body, signal: new AbortController().signal }))
}

async function rejects(operation: Promise<unknown>, statusCode: number, code: string): Promise<void> {
  await assert.rejects(operation, error => error instanceof AdminRequestError
    && error.statusCode === statusCode && error.code === code && error.message === code)
}

async function saveProviders(routes: readonly AdminRoute[], providers: unknown): Promise<Record<string, unknown>> {
  const current = await invoke(routes, 'GET')
  return invoke(routes, 'POST', 'providers', { revision: current.revision, providers })
}

async function savePersonas(routes: readonly AdminRoute[]): Promise<void> {
  const current = await invoke(routes, 'GET', 'personas')
  await invoke(routes, 'POST', 'personas', { revision: current.revision, personas: [persona] })
}

async function savePlans(
  routes: readonly AdminRoute[],
  plans: readonly unknown[],
  activePlanId: string | null = null
): Promise<Record<string, unknown>> {
  const current = await invoke(routes, 'GET', 'plans')
  return invoke(routes, 'POST', 'plans', { revision: current.revision, activePlanId, plans })
}

test('native provider API stores private keys, exposes only flags and never contacts external services', async context => {
  const setup = fixture(context)
  const fetch = context.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external request') })
  const initial = await invoke(setup.routes, 'GET')
  assert.deepEqual(initial, { revision: initial.revision, providers: [] })
  const secret = 'private-test-provider-key'
  const saved = await saveProviders(setup.routes, [{ ...provider, apiKey: secret }])
  assert.deepEqual(saved.providers, [{ ...provider, apiKeyConfigured: true }])
  assert(!JSON.stringify(saved).includes(secret))
  const filename = join(setup.directory, 'chat-providers.json')
  assert.equal(statSync(filename).mode & 0o777, 0o600)
  assert.equal(statSync(setup.directory).mode & 0o777, 0o700)
  assert.deepEqual(JSON.parse(readFileSync(filename, 'utf8')) as unknown, {
    schema: 1, providers: [{ ...provider, apiKey: secret }]
  })
  const reopened = createNativeRuntimeRoutes({ directory: setup.directory })
  assert.deepEqual(await invoke(reopened, 'GET'), saved)
  const retained = await saveProviders(reopened, [provider])
  assert.equal(retained.revision, saved.revision)
  const blankRetained = await saveProviders(reopened, [{ ...provider, apiKey: '' }])
  assert.equal(blankRetained.revision, saved.revision)
  const replaced = await saveProviders(reopened, [{ ...provider, apiKey: 'replacement-private-key' }])
  assert.notEqual(replaced.revision, saved.revision)
  const cleared = await saveProviders(reopened, [{ ...provider, clearApiKey: true }])
  assert.deepEqual(cleared.providers, [{ ...provider, apiKeyConfigured: false }])
  assert(!readFileSync(filename, 'utf8').includes('replacement-private-key'))
  const renamed = await saveProviders(reopened, [{ ...provider, id: 'new-provider' }])
  assert.deepEqual(renamed.providers, [{ ...provider, id: 'new-provider', apiKeyConfigured: false }])
  assert.equal(fetch.mock.callCount(), 0)
})

test('provider requests reject invalid revisions, flags, keys and URLs with sanitized stable errors', async context => {
  const setup = fixture(context)
  const initial = await invoke(setup.routes, 'GET')
  for (const body of [
    null, {}, { revision: initial.revision }, { ...initial, unknown: true },
    { revision: 'bad', providers: [] }, { revision: initial.revision, providers: {} },
    { revision: initial.revision, providers: [{ ...provider, apiKeyConfigured: false }] },
    { revision: initial.revision, providers: [{ ...provider, apiKey: 'private-key', clearApiKey: true }] },
    { revision: initial.revision, providers: [{ ...provider, apiKey: 'private\nkey' }] },
    { revision: initial.revision, providers: [{ ...provider, baseUrl: 'https://private:key@example.test' }] },
    { revision: initial.revision, providers: [{ ...provider, baseUrl: 'http://remote.example.test' }] }
  ]) await rejects(invoke(setup.routes, 'POST', 'providers', body), 400, 'invalid_model_providers')
  await rejects(invoke(setup.routes, 'GET', 'providers', null, new URLSearchParams('secret=private-key')),
    400, 'invalid_query')
  await rejects(invoke(setup.routes, 'POST', 'providers', initial, new URLSearchParams('extra=1')),
    400, 'invalid_query')
  assert.deepEqual(await invoke(setup.routes, 'GET'), initial)
})

test('provider catalog persists DSH api identifiers and explicit HTTP consent without contacting DSH or models', async context => {
  const setup = fixture(context)
  const fetch = context.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external request') })
  const { type: ignoredType, ...fields } = provider
  void ignoredType
  const value = { ...fields, api: 'openai-responses', baseUrl: 'http://operator-gateway.example.test/v1',
    allowInsecureHttp: true, apiKey: 'fixture-responses-private-key' }
  const saved = await saveProviders(setup.routes, [value])
  assert.deepEqual(saved.providers, [{ ...fields, api: value.api, baseUrl: value.baseUrl,
    allowInsecureHttp: true, apiKeyConfigured: true }])
  const reopened = createNativeRuntimeRoutes({ directory: setup.directory })
  assert.deepEqual(await invoke(reopened, 'GET'), saved)
  assert.equal(fetch.mock.callCount(), 0)
})

test('provider CAS serializes independent route instances and respects cross-process directory locks', async context => {
  const setup = fixture(context)
  const other = createNativeRuntimeRoutes({ directory: setup.directory })
  const initial = await invoke(setup.routes, 'GET')
  const results = await Promise.allSettled([
    invoke(setup.routes, 'POST', 'providers', { revision: initial.revision, providers: [provider] }),
    invoke(other, 'POST', 'providers', { revision: initial.revision, providers: [{ ...provider, type: 'anthropic' }] })
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const failed = results.find(result => result.status === 'rejected')
  assert(failed?.status === 'rejected' && failed.reason instanceof AdminRequestError)
  assert.equal(failed.reason.code, 'chat_revision_conflict')
  const saved = await invoke(other, 'GET')
  const filename = join(setup.directory, 'chat-providers.json')
  const original = readFileSync(filename)
  const lockFile = join(setup.directory, '.chat-runtime.lock')
  const child = spawnSync(process.execPath, ['-e',
    "require('node:fs').writeFileSync(process.argv[1], '', {flag: 'wx', mode: 0o600})", lockFile
  ], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  await rejects(invoke(other, 'POST', 'providers', { revision: saved.revision, providers: [] }),
    409, 'chat_storage_busy')
  assert.deepEqual(readFileSync(filename), original)
})

test('new and changed plan bindings and model writes must match an enabled listed provider/model', async context => {
  const setup = fixture(context)
  await savePersonas(setup.routes)
  await rejects(savePlans(setup.routes, [plan], plan.id), 409, 'provider_model_missing_or_disabled')
  await saveProviders(setup.routes, [{ ...provider, enabled: false }])
  await rejects(savePlans(setup.routes, [plan]), 409, 'provider_model_missing_or_disabled')
  await saveProviders(setup.routes, [provider])
  await rejects(savePlans(setup.routes, [{ ...plan, model: 'unlisted' }]), 409, 'provider_model_missing_or_disabled')
  const saved = await savePlans(setup.routes, [plan], plan.id)
  for (const binding of [{ provider: 'unknown', model: 'chat' }, { provider: provider.id, model: 'unlisted' }]) {
    await rejects(invoke(setup.routes, 'POST', 'model', {
      revision: saved.revision, ...binding, reasoningEffort: 'high'
    }), 409, 'provider_model_missing_or_disabled')
    await rejects(savePlans(setup.routes, [{ ...plan, ...binding }], plan.id),
      409, 'provider_model_missing_or_disabled')
  }
  const unchanged = await invoke(setup.routes, 'GET', 'plans')
  assert.equal(unchanged.revision, saved.revision)
  await saveProviders(setup.routes, [provider, { ...provider, id: 'alternate', name: 'Alternate', type: 'anthropic' }])
  const model = await invoke(setup.routes, 'POST', 'model', {
    revision: saved.revision, provider: 'alternate', model: 'chat', reasoningEffort: 'high'
  })
  assert.equal(model.provider, 'alternate')
})

test('provider saves prevent deleting, disabling or removing referenced registered models from any plan', async context => {
  const setup = fixture(context)
  await savePersonas(setup.routes)
  const catalog = await saveProviders(setup.routes, [{
    ...provider, models: [...provider.models, { id: 'unused', name: 'Unused' }]
  }])
  await savePlans(setup.routes, [plan])
  for (const providers of [[], [{ ...provider, enabled: false }], [{ ...provider, models: [] }]]) {
    await rejects(invoke(setup.routes, 'POST', 'providers', { revision: catalog.revision, providers }),
      409, 'provider_model_in_use')
  }
  const allowed = await saveProviders(setup.routes, [{ ...provider, name: 'Renamed', clearApiKey: true }])
  assert.notEqual(allowed.revision, catalog.revision)
  await savePlans(setup.routes, [])
  assert.deepEqual((await saveProviders(setup.routes, [])).providers, [])
})

test('plan activation and provider removal serialize cross-document checks under one write lock', async context => {
  for (const providerFirst of [false, true]) {
    const setup = fixture(context)
    await savePersonas(setup.routes)
    const providers = await saveProviders(setup.routes, [provider])
    const plans = await invoke(setup.routes, 'GET', 'plans')
    const other = createNativeRuntimeRoutes({ directory: setup.directory })
    const operations = [
      () => invoke(setup.routes, 'POST', 'plans', { revision: plans.revision, activePlanId: plan.id, plans: [plan] }),
      () => invoke(other, 'POST', 'providers', { revision: providers.revision, providers: [] })
    ]
    if (providerFirst) operations.reverse()
    const results = await Promise.allSettled(operations.map(operation => operation()))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const failed = results.find(result => result.status === 'rejected')
    assert(failed?.status === 'rejected' && failed.reason instanceof AdminRequestError)
    assert(['provider_model_in_use', 'provider_model_missing_or_disabled'].includes(failed.reason.code))
    const finalPlans = await invoke(setup.routes, 'GET', 'plans')
    const finalProviders = await invoke(setup.routes, 'GET')
    for (const entry of finalPlans.plans as Array<{ provider: string }>) {
      assert((finalProviders.providers as Array<{ id: string }>).some(candidate => candidate.id === entry.provider))
    }
  }
})

test('model writes and provider disabling cannot race into an invalid binding', async context => {
  for (const providerFirst of [false, true]) {
    const setup = fixture(context)
    await savePersonas(setup.routes)
    const alternate = { ...provider, id: 'alternate', name: 'Alternate', type: 'anthropic' }
    const catalog = await saveProviders(setup.routes, [provider, alternate])
    const plans = await savePlans(setup.routes, [plan], plan.id)
    const operations = [
      () => invoke(setup.routes, 'POST', 'model', {
        revision: plans.revision, provider: alternate.id, model: 'chat', reasoningEffort: 'high'
      }),
      () => invoke(setup.routes, 'POST', 'providers', {
        revision: catalog.revision, providers: [provider, { ...alternate, enabled: false }]
      })
    ]
    if (providerFirst) operations.reverse()
    const results = await Promise.allSettled(operations.map(operation => operation()))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const failed = results.find(result => result.status === 'rejected')
    assert(failed?.status === 'rejected' && failed.reason instanceof AdminRequestError)
    assert(['provider_model_in_use', 'provider_model_missing_or_disabled'].includes(failed.reason.code))
  }
})

test('legacy unknown bindings remain unchanged without data loss, but cannot be copied, rebound or newly activated', async context => {
  const setup = fixture(context)
  await savePersonas(setup.routes)
  const filename = join(setup.directory, 'chat-plans.json')
  const original = `${JSON.stringify({ schema: 1, activePlanId: null, plans: [plan] }, null, 2)}\n`
  writeFileSync(filename, original, { mode: 0o600 })
  const legacy = await invoke(setup.routes, 'GET', 'plans')
  assert.equal(readFileSync(filename, 'utf8'), original)
  assert.deepEqual(legacy.plans, [{ ...plan, contextLimits: { group: 128_000, private: 128_000 } }])
  await savePlans(setup.routes, [{ ...plan, name: 'Renamed', contextLimits: { group: 172_000, private: 384_000 } }])
  await rejects(savePlans(setup.routes, [plan], plan.id), 409, 'provider_model_missing_or_disabled')
  await rejects(savePlans(setup.routes, [plan, { ...plan, id: 'copy' }]), 409, 'provider_model_missing_or_disabled')
  await rejects(savePlans(setup.routes, [{ ...plan, model: 'different' }]), 409, 'provider_model_missing_or_disabled')
  writeFileSync(filename, JSON.stringify({ schema: 1, activePlanId: plan.id, plans: [plan] }))
  const retainedActive = await savePlans(setup.routes, [{ ...plan, description: 'Still active' }], plan.id)
  await invoke(setup.routes, 'POST', 'model', {
    revision: retainedActive.revision, provider: plan.provider, model: plan.model, reasoningEffort: 'high'
  })
  await savePlans(setup.routes, [plan])
  await rejects(savePlans(setup.routes, [plan], plan.id), 409, 'provider_model_missing_or_disabled')
})

test('provider registration can repair legacy missing references and allow unrelated changes', async context => {
  const setup = fixture(context)
  await savePersonas(setup.routes)
  writeFileSync(join(setup.directory, 'chat-plans.json'), JSON.stringify({
    schema: 1, activePlanId: plan.id, plans: [plan, { ...plan, id: 'other', provider: 'still-missing' }]
  }), { mode: 0o600 })
  const unrelated = { ...provider, id: 'unrelated', name: 'Unrelated' }
  await saveProviders(setup.routes, [unrelated])
  await saveProviders(setup.routes, [unrelated, { ...provider, enabled: false, models: [] }])
  await saveProviders(setup.routes, [{ ...unrelated, name: 'Renamed' }, { ...provider, enabled: false, models: [] }])
  await saveProviders(setup.routes, [unrelated, provider])
  await savePlans(setup.routes, [plan, { ...plan, id: 'other', provider: 'still-missing' }], plan.id)
  await rejects(saveProviders(setup.routes, [unrelated]), 409, 'provider_model_in_use')
})

test('native plans persist separate context budgets while legacy reads normalize without rewriting', async context => {
  const setup = fixture(context)
  await savePersonas(setup.routes)
  await saveProviders(setup.routes, [provider])
  const contextLimits = { group: 172_000, private: 384_000 }
  const saved = await savePlans(setup.routes, [{ ...plan, contextLimits }], plan.id)
  assert.deepEqual(saved.plans, [{ ...plan, contextLimits }])
  const filename = join(setup.directory, 'chat-plans.json')
  assert.deepEqual(JSON.parse(readFileSync(filename, 'utf8')) as unknown, {
    schema: 1, activePlanId: plan.id, plans: [{ ...plan, contextLimits }]
  })
  await invoke(setup.routes, 'POST', 'model', {
    revision: saved.revision, provider: plan.provider, model: plan.model, reasoningEffort: 'max'
  })
  const reopened = createNativeRuntimeRoutes({ directory: setup.directory })
  const current = await invoke(reopened, 'GET', 'plans')
  assert.deepEqual(current.plans, [{ ...plan, reasoningEffort: 'max', contextLimits }])
  for (const contextLimits of [null, { group: 0, private: 1 }, { group: 1, private: 16_777_217 }, { group: 1.2, private: 1 }]) {
    await rejects(savePlans(reopened, [{ ...plan, contextLimits }], plan.id), 400, 'invalid_chat_request')
  }
  assert.equal((await invoke(reopened, 'GET', 'plans')).revision, current.revision)
})

test('provider documents reject insecure links, permissions, corruption, and values exceeding 64 KiB', async context => {
  const setup = fixture(context)
  const saved = await saveProviders(setup.routes, [provider])
  const filename = join(setup.directory, 'chat-providers.json')
  const original = readFileSync(filename)
  chmodSync(filename, 0o644)
  await rejects(invoke(setup.routes, 'GET'), 500, 'chat_storage_invalid')
  await rejects(saveProviders(setup.routes, []), 500, 'chat_storage_invalid')
  chmodSync(filename, 0o600)
  const target = join(setup.directory, 'untouched.json')
  writeFileSync(target, original, { mode: 0o600 })
  rmSync(filename)
  symlinkSync(target, filename)
  await rejects(invoke(setup.routes, 'GET'), 500, 'chat_storage_invalid')
  rmSync(filename)
  linkSync(target, filename)
  await rejects(invoke(setup.routes, 'GET'), 500, 'chat_storage_invalid')
  rmSync(filename)
  assert.deepEqual(readFileSync(target), original)
  for (const content of [
    '{broken', JSON.stringify({ schema: 2, providers: [] }),
    JSON.stringify({ schema: 1, providers: [{ ...provider, apiKey: '', apiKeyConfigured: false }] }),
    ' '.repeat(64 * 1024 + 1)
  ]) {
    writeFileSync(filename, content, { mode: 0o600 })
    await rejects(invoke(setup.routes, 'GET'), 500, 'chat_storage_invalid')
  }
  writeFileSync(filename, original)
  const providers = Array.from({ length: 16 }, (_entry, index) => ({
    ...provider, id: `provider-${index}`, name: `Provider ${index}`, apiKey: 'x'.repeat(4096)
  }))
  await rejects(invoke(setup.routes, 'POST', 'providers', { revision: saved.revision, providers }),
    413, 'chat_document_too_large')
  assert.deepEqual(readFileSync(filename), original)
})

test('provider saves report an unknown result when directory fsync fails after atomic rename', context => {
  const setup = fixture(context)
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
            if (property === 'sync') return async () => { throw new Error('forced fsync failure') }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }
    } })
    const { createNativeRuntimeRoutes } = await import(pathToFileURL(process.cwd() + '/src/admin/runtime.ts').href)
    const { AdminRequestError } = await import(pathToFileURL(process.cwd() + '/src/admin/server.ts').href)
    const routes = createNativeRuntimeRoutes({ directory })
    const call = (method, body = null) => routes.find(route => route.method === method
      && route.pathname === '/api/chat/providers').handle({
        query: new URLSearchParams(), body, signal: new AbortController().signal
      })
    const initial = await call('GET')
    let failure
    try {
      await call('POST', { revision: initial.revision, providers: [{
        id: 'primary', name: 'Primary', type: 'openai', baseUrl: 'https://model.example.test',
        enabled: true, models: [], apiKey: 'private-fixture-key'
      }] })
    } catch (error) {
      failure = error instanceof AdminRequestError
        ? { statusCode: error.statusCode, code: error.code } : { code: 'unexpected' }
    }
    const saved = await call('GET')
    process.stdout.write(JSON.stringify({ failure, providers: saved.providers }))
  `
  const child = spawnSync(process.execPath, [
    '--experimental-test-module-mocks', '--input-type=module', '-e', script, setup.directory
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout) as unknown, {
    failure: { statusCode: 500, code: 'chat_write_unknown' },
    providers: [{
      id: 'primary', name: 'Primary', type: 'openai', baseUrl: 'https://model.example.test',
      enabled: true, models: [], apiKeyConfigured: true
    }]
  })
  assert(!child.stdout.includes('private-fixture-key'))
})
