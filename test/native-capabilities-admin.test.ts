import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { parseDocument, stringify } from 'yaml'
import { createNativeCapabilityManagement } from '../src/admin/native-capabilities.ts'
import { createNativeRuntimeRoutes, readNativeChatConfiguration } from '../src/admin/runtime.ts'
import { loadGatewayAdminConfiguration, startGatewayAdmin } from '../src/admin/gateway.ts'
import { AdminRequestError, type AdminRoute } from '../src/admin/server.ts'
import { createNativeChatRuntime } from '../src/host/native-chat-runtime.ts'
import type { NativeChatConfiguration, NativeChatDeploymentRuntime } from '../src/host/native-chat-configuration.ts'
import type { ChatCapabilityApprovalRequest } from '../src/host/chat-capabilities.ts'

const content = '- id: work\n  name: fixture-work\n  config: {}\n'
const source = { schema: 1 as const, presetId: 'work', revision: createHash('sha256').update(JSON.stringify({ id: 'work', content })).digest('hex') }
const plan = { id: 'daily', name: 'Daily', description: '', instructions: 'Synthetic only.', personaId: 'native',
  provider: 'provider', model: 'fake', reasoningEffort: 'off', capabilitySelection: source }
const targetRevision = 'e'.repeat(64)
const compositionRevision = 'b'.repeat(64)

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

async function invoke(routes: readonly AdminRoute[], method: 'GET' | 'POST', path: string,
  body: Record<string, unknown> | null = null) {
  const route = routes.find(item => item.method === method && item.pathname === path)
  assert(route, path)
  return object(await route.handle({ body, query: new URLSearchParams(), signal: new AbortController().signal }))
}

async function rejected(operation: Promise<unknown>, statusCode: number, code: string) {
  await assert.rejects(operation, error => error instanceof AdminRequestError && error.statusCode === statusCode && error.code === code)
}

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'native-cap-admin-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  let permitted = true
  let preparations = 0
  let onPrepare: ((configuration: NativeChatConfiguration) => Promise<void>) | undefined
  let request: ChatCapabilityApprovalRequest | undefined
  const deploymentRuntime: NativeChatDeploymentRuntime = {
    async prepare(configuration) {
      preparations++
      await onPrepare?.(configuration)
      request = { schema: 1, source: configuration.catalog.plans[0]!.capabilitySelection!, compositionRevision,
        target: { ...configuration.deployment.target!, layerPaths: configuration.deployment.target?.layerPaths ?? [] } }
      return { state: 'prepared', targetRevision, summary: { ready: true, missingReasons: [] },
        preview: { capabilityComposition: { schema: 1, source: request.source, revision: compositionRevision,
          externalToolAuthorizationVerified: false } }, capabilityApprovalRequest: request }
    },
    async apply() { assert.fail('Approval must never apply external deployment') },
    async reconcile() { assert.fail('Approval must never call live reconciliation') }
  }
  const runtime = createNativeChatRuntime({ directory, loadConfiguration: () => readNativeChatConfiguration(directory),
    resolveDeployment: async () => ({ missingReasons: [], presetBindings: [] }) })
  context.after(() => runtime.close())
  const management = createNativeCapabilityManagement({ directory, deploymentRuntime, canApplyDeployment: async () => permitted })
  const routes = [...createNativeRuntimeRoutes({ directory, chatRuntime: runtime, deploymentRuntime }), ...management.routes]
  const load = () => readNativeChatConfiguration(directory)
  const call = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => invoke(routes, method, path, body)
  async function save(name: string, body: Record<string, unknown>) {
    const previous = await call('GET', `/api/chat/${name}`)
    return call('POST', `/api/chat/${name}`, { revision: previous.revision, ...body })
  }
  await save('personas', { personas: [{ id: 'native', name: 'Native', identity: 'Synthetic.', style: 'Brief.' }] })
  await save('providers', { providers: [{ id: 'provider', name: 'Provider', type: 'openai', enabled: true,
    baseUrl: 'https://never-model.example.test', apiKey: 'synthetic-never-used', models: [{ id: 'fake', name: 'Fake' }] }] })
  await save('plans', { activePlanId: 'daily', plans: [plan] })
  await save('deployment', { deployment: { target: { profilePath: join(directory, 'cordis.patch.yml'),
    credentialsPath: join(directory, 'credentials.yml'), schemaVersion: '0.2.1-rc.2', layerPaths: [join(directory, 'base.yml')] },
    namespace: 'fixture', modelSettings: null } })
  const preview = async () => call('POST', '/api/chat/capabilities/preview', { revisions: (await load()).revisions })
  const approve = async (extra: Record<string, unknown> = {}) => call('POST', '/api/chat/capabilities/approval', {
    revisions: (await load()).revisions, targetRevision, compositionRevision, confirm: true, ...extra })
  return { directory, routes, call, save, load, preview, approve, management,
    request: () => { assert(request); return request },
    preparations: () => preparations,
    permit: (value: boolean) => { permitted = value },
    prepareHook: (value: typeof onPrepare) => { onPrepare = value } }
}

test('actual capability GET projects whitelist approval policy separately from legacy counted mode and preserves saved receipts', async context => {
  const data = await fixture(context)
  const initial = await data.call('GET', '/api/chat/capabilities')
  assert.equal(initial.compositionApprovalRequired, false)
  assert.equal(initial.approval, null)
  await assert.rejects(readFile(join(data.directory, 'chat-authorization.json')), { code: 'ENOENT' })
  await data.save('authorization', { version: 'legacy-projection', grants: [] })
  const authorizationFile = join(data.directory, 'chat-authorization.json')
  const legacy = await readFile(authorizationFile)
  assert.equal(Object.hasOwn(object(object(JSON.parse(legacy.toString())).authorization), 'mode'), false)
  const counted = await data.call('GET', '/api/chat/capabilities')
  assert.equal(counted.compositionApprovalRequired, false)
  assert.deepEqual(await readFile(authorizationFile), legacy)
  await data.approve()
  const saved = (await data.load()).deployment.capabilityApproval
  assert(saved)
  const deploymentFile = join(data.directory, 'chat-deployment.json')
  const deployment = await readFile(deploymentFile)
  await data.save('authorization', { version: 'explicit-counted-projection', mode: 'counted', grants: [] })
  assert.equal((await data.call('GET', '/api/chat/capabilities')).compositionApprovalRequired, false)
  await data.save('authorization', { version: 'whitelist-projection', mode: 'whitelist', grants: [] })
  const beforeGet = await readFile(authorizationFile)
  const whitelist = await data.call('GET', '/api/chat/capabilities')
  assert.equal(whitelist.compositionApprovalRequired, false)
  assert.equal(whitelist.approvalState, 'saved')
  assert.deepEqual(whitelist.approval, saved)
  assert.deepEqual(await readFile(deploymentFile), deployment)
  assert.deepEqual(await readFile(authorizationFile), beforeGet)
  assert.equal(object(whitelist.catalog).available, false)
  console.log(JSON.stringify({ newWhitelist: initial.compositionApprovalRequired,
    legacyCounted: counted.compositionApprovalRequired, explicitCounted: true,
    migratedWhitelist: whitelist.compositionApprovalRequired, approvalHistoryPreserved: true, getterWritesReceipt: false }))
})

test('capability approval is minted only after explicit fresh preview and persists in deployment with eight revisions', async context => {
  const data = await fixture(context)
  const before = await data.load()
  const preview = await data.preview()
  assert.equal(preview.readOnly, true)
  assert.equal(preview.externalMutation, false)
  assert.equal(preview.approvalMatchesPreview, false)
  assert.equal(await data.management.resolveCapabilityApproval(data.request(), new AbortController().signal), null)
  await rejected(data.approve({ confirm: false }), 400, 'invalid_capability_approval')
  await rejected(data.approve({ authority: 'owner' }), 400, 'invalid_runtime_revisions')
  await rejected(data.approve({ compositionRevision: 'c'.repeat(64) }), 409, 'capability_preview_conflict')
  await rejected(data.approve({ targetRevision: 'f'.repeat(64) }), 409, 'capability_preview_conflict')
  const approved = await data.approve()
  const approval = object(approved.approval)
  assert.equal(approval.authority, 'owner')
  assert.equal(approval.externalTools, 'separate-runtime-authorization-required')
  assert.equal(approved.requiresNewPreview, true)
  const after = await data.load()
  await rejected(data.approve({ revisions: before.revisions }), 409, 'chat_revision_conflict')
  assert.equal(Object.keys(after.revisions).length, 8)
  assert.notEqual(after.revisions.deployment, before.revisions.deployment)
  for (const key of Object.keys(before.revisions).filter(key => key !== 'deployment')) assert.equal(after.revisions[key], before.revisions[key])
  assert.deepEqual(await data.management.resolveCapabilityApproval(data.request(), new AbortController().signal), approval)
  assert.equal((await data.preview()).approvalMatchesPreview, true)
  const offline = await data.call('GET', '/api/chat/capabilities')
  assert.equal(object(offline.catalog).available, false)
  assert.equal(offline.approvalState, 'saved')
  assert.deepEqual(offline.approval, approval)
  await data.save('adapters', { adapters: { dshAgent: { enabled: true, endpoint: 'http://127.0.0.1:9', auth: 'cookie:invalid' } } })
  const unavailable = await data.call('GET', '/api/chat/capabilities')
  assert.equal(object(unavailable.catalog).available, false)
  assert.deepEqual(unavailable.approval, approval)
  const restarted = createNativeCapabilityManagement({ directory: data.directory,
    deploymentRuntime: { prepare: async () => null, reconcile: async () => ({ missingReasons: [], presetBindings: [] }), apply: async () => null },
    canApplyDeployment: async () => true })
  assert.deepEqual(await restarted.resolveCapabilityApproval(data.request(), new AbortController().signal), approval)
  assert(!JSON.stringify(approved).includes('synthetic-never-used'))
})

test('generic deployment POST cannot mint, replace or delete an owner receipt and target changes invalidate resolution', async context => {
  const data = await fixture(context)
  await data.approve()
  const before = await data.load()
  const saved = before.deployment.capabilityApproval!
  await rejected(data.save('deployment', { deployment: { ...before.deployment, capabilityApproval: { ...saved, approvalId: 'forged' } } }),
    400, 'invalid_capability_approval')
  await rejected(data.save('deployment', { deployment: { ...before.deployment, capabilityApproval: null } }), 400, 'invalid_capability_approval')
  const { capabilityApproval: _approval, ...ordinary } = before.deployment
  await data.save('deployment', { deployment: ordinary })
  assert.deepEqual((await data.load()).deployment.capabilityApproval, saved)
  const changed = { ...ordinary, target: { ...ordinary.target!, layerPaths: [join(data.directory, 'changed.yml')] } }
  await data.save('deployment', { deployment: changed })
  assert.equal(await data.management.resolveCapabilityApproval(data.request(), new AbortController().signal), null)
})

test('approval checks all eight CAS revisions after asynchronous prepare and running gate before any write', async context => {
  const data = await fixture(context)
  data.permit(false)
  await rejected(data.approve(), 409, 'native_chat_busy')
  assert.equal(data.preparations(), 0)
  data.permit(true)
  data.prepareHook(async () => { await data.save('access', { allow: ['private:1'], deny: [], owner: '1' }) })
  await rejected(data.approve(), 409, 'chat_revision_conflict')
  assert.equal((await data.load()).deployment.capabilityApproval, undefined)
  data.prepareHook(async () => { data.permit(false) })
  await rejected(data.approve(), 409, 'native_chat_busy')
  assert.equal((await data.load()).deployment.capabilityApproval, undefined)
})

test('revoke is explicit, bound to the saved approval id, durable, and never silently clears on text-only selection', async context => {
  const data = await fixture(context)
  const approved = await data.approve()
  const approvalId = object(approved.approval).approvalId
  const previous = (await data.load()).revisions
  await data.save('plans', { activePlanId: 'daily', plans: [{ ...plan, capabilitySelection: null }] })
  assert.equal(await data.management.resolveCapabilityApproval(data.request(), new AbortController().signal), null)
  assert.equal((await data.load()).deployment.capabilityApproval?.approvalId, approvalId)
  await rejected(data.call('POST', '/api/chat/capabilities/revoke', { revisions: previous, approvalId, confirm: true }), 409, 'chat_revision_conflict')
  await rejected(data.call('POST', '/api/chat/capabilities/revoke', { revisions: (await data.load()).revisions,
    approvalId: 'other-tab', confirm: true }), 409, 'capability_approval_conflict')
  const revoked = await data.call('POST', '/api/chat/capabilities/revoke', { revisions: (await data.load()).revisions, approvalId, confirm: true })
  assert.equal(revoked.approval, null)
  assert.equal((await data.load()).deployment.capabilityApproval, null)
})

test('default gateway authenticates catalog and persists counted approval for actual temporary profile apply and revoke without bootstrap', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'cap-default-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const methods: string[] = []
  const profilePath = join(directory, 'cordis.patch.yml')
  const credentialsPath = join(directory, 'credentials.yml')
  const basePath = join(directory, 'base.patch.yml')
  await writeFile(profilePath, '[]\n', { mode: 0o600 })
  await writeFile(credentialsPath, 'version: 1\nrefs: {}\n', { mode: 0o600 })
  await writeFile(basePath, stringify([{ insert: [
    { id: 'llm', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } },
    { id: 'credentials-local', name: '@deepseek-ai/dsh-credentials-local', config: { path: credentialsPath } }
  ] }]), { mode: 0o600 })
  await writeFile(join(directory, 'package.json'), '{"dsh":{"profile":{"bundles":[]}}}\n', { mode: 0o600 })
  const upstream = createServer(async (request, response) => {
    if (request.url?.startsWith('/dsh/connect?')) {
      response.writeHead(302, { location: './api/remote.mux', 'set-cookie': 'fixture=owner; HttpOnly' }).end()
      return
    }
    assert.equal(request.headers.cookie, 'fixture=owner')
    let text = ''
    for await (const chunk of request) text += String(chunk)
    const wire = object(JSON.parse(text))
    methods.push(String(wire.method))
    assert(['agentPresets/list', 'agentPresets/read', 'settings/describe', 'credentials/describe'].includes(String(wire.method)))
    const patches: unknown = parseDocument(await readFile(profilePath, 'utf8')).toJS()
    assert(Array.isArray(patches))
    const rows = patches.map(object)
    const presets = rows.flatMap(row => Array.isArray(row.insert) ? row.insert.map(object)
      .filter(entry => entry.name === '@deepseek-ai/dsh-agent-preset').map(entry => object(entry.config)) : [])
    const args = object(object(wire.payload).args)
    let value: unknown
    if (wire.method === 'agentPresets/list') value = { presets: [{ id: 'work', isDefault: false, name: 'Work' },
      ...presets.map(config => ({ id: config.id, isDefault: false }))] }
    else if (wire.method === 'agentPresets/read') {
      const preset = presets.find(config => config.id === args.agentPreset)
      value = { agentPreset: args.agentPreset, content: args.agentPreset === 'work' ? content : JSON.stringify(preset?.plugins ?? []) }
    } else if (wire.method === 'settings/describe') value = { namespaces: [
      { ns: 'llm', value: rows.find(row => row.id === 'llm')?.config ?? { providers: {} } },
      { ns: 'credentials-local', value: { path: credentialsPath, watch: true } }
    ] }
    else {
      assert(Array.isArray(args.refs))
      value = Object.fromEntries(args.refs.map(ref => [String(ref), { configured: true, writable: true, source: 'file' }]))
    }
    response.end(JSON.stringify({ type: 'server-response', rpcId: wire.rpcId, result: { ok: true, value } }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())))
  const address = upstream.address()
  assert(address && typeof address !== 'string')
  const token = 'synthetic-admin-owner-only-0123456789'
  await writeFile(join(directory, 'admin.token'), token, { mode: 0o600 })
  await writeFile(join(directory, 'gateway.token'), 'synthetic-gateway-0123456789', { mode: 0o600 })
  await writeFile(join(directory, 'gateway.json'), JSON.stringify({ port: 0, upstreamEndpoint: `http://127.0.0.1:${address.port}/onebot`,
    tokenFile: './gateway.token', storeFilename: './unused.sqlite', allowedConversations: [], persona: { id: 'fixture', version: '1' } }), { mode: 0o600 })
  const filename = join(directory, 'admin.json')
  await writeFile(filename, JSON.stringify({ host: '127.0.0.1', port: 0, tokenFile: './admin.token', gatewayConfiguration: './gateway.json' }), { mode: 0o600 })
  const service = await startGatewayAdmin(loadGatewayAdminConfiguration(filename), { configurationFilename: filename })
  context.after(() => service.close())
  const origin = `http://127.0.0.1:${service.address.port}`
  assert.equal((await fetch(`${origin}/api/chat/capabilities`)).status, 401)
  const headers = { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' }
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = object(await (await fetch(`${origin}/api/chat/runtime`, { headers })).json())
    const lifecycle = object(current.lifecycle)
    if (!['not-attempted', 'checking'].includes(String(object(lifecycle.restoration).state))) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const adaptersResponse = await fetch(`${origin}/api/chat/adapters`, { headers })
  const adapters = object(await adaptersResponse.json())
  const response = await fetch(`${origin}/api/chat/adapters`, { method: 'POST', headers,
    body: JSON.stringify({ revision: adapters.revision, adapters: {
      dshAgent: { enabled: true, endpoint: `http://127.0.0.1:${address.port}/dsh`, auth: 'local-dsh-only' } } }) })
  assert.equal(response.status, 200)
  const catalogResponse = await fetch(`${origin}/api/chat/capabilities`, { headers })
  assert.equal(catalogResponse.status, 200)
  const catalog = object(await catalogResponse.json())
  assert.equal(catalog.compositionApprovalRequired, false)
  assert.equal(catalog.activePlanId, null)
  assert.equal(catalog.selection, null)
  assert.equal(catalog.approvalState, 'none')
  assert.equal(object(catalog.catalog).externalToolAuthorizationVerified, false)
  assert.deepEqual(methods, ['agentPresets/list', 'agentPresets/read'])
  assert(!JSON.stringify(catalog).includes('local-dsh-only'))
  assert(!(await readFile(filename, 'utf8')).includes('bootstrap'))
  assert.equal((await fetch(`${origin}/api/chat/capabilities/approval`, { method: 'POST', headers: { ...headers, origin: 'http://foreign.test' }, body: '{}' })).status, 403)
  async function api(path: string, body?: Record<string, unknown>) {
    const result = await fetch(`${origin}${path}`, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })
    const parsed = object(await result.json())
    assert.equal(result.status, 200, `${path}: ${JSON.stringify(parsed)}`)
    return parsed
  }
  async function save(name: string, body: Record<string, unknown>) {
    const previous = await api(`/api/chat/${name}`)
    return api(`/api/chat/${name}`, { revision: previous.revision, ...body })
  }
  await save('authorization', { version: 'legacy-counted-approval', grants: [] })
  assert.equal((await api('/api/chat/capabilities')).compositionApprovalRequired, false)
  await save('personas', { personas: [{ id: 'native', name: 'Native', identity: 'Synthetic.', style: 'Brief.' }] })
  await save('providers', { providers: [{ id: 'provider', name: 'Provider', type: 'openai', enabled: true,
    baseUrl: 'https://never-model.example.test', apiKey: 'synthetic-never-called', models: [{ id: 'fake', name: 'Fake' }] }] })
  await save('plans', { activePlanId: 'daily', plans: [plan] })
  await save('deployment', { deployment: { target: { profilePath, credentialsPath, layerPaths: [basePath], schemaVersion: '0.2.1-rc.2' },
    namespace: 'fixture', modelSettings: { contextWindow: 200000, maxTokens: 4096, reasoningEfforts: false } } })
  const runtime = () => api('/api/chat/runtime')
  const beforeProfile = await readFile(profilePath, 'utf8')
  const preview = await api('/api/chat/capabilities/preview', { revisions: (await runtime()).revisions })
  const preparation = object(preview.preparation)
  assert.equal(preparation.state, 'prepared')
  assert.equal(await readFile(profilePath, 'utf8'), beforeProfile)
  const request = object(preparation.capabilityApprovalRequest)
  const approved = await api('/api/chat/capabilities/approval', { revisions: preview.revisions,
    targetRevision: preparation.targetRevision, compositionRevision: request.compositionRevision, confirm: true })
  assert.equal(object(approved.approval).authority, 'owner')
  const prepared = await api('/api/chat/deployment/prepare', { revisions: approved.revisions })
  assert.equal(prepared.state, 'prepared')
  const applied = await api('/api/chat/deployment/apply', { revisions: approved.revisions, targetRevision: prepared.targetRevision })
  assert.equal(applied.state, 'verified')
  assert.equal(applied.credentialValueIdentityVerified, false)
  assert((await readFile(profilePath, 'utf8')).includes('fixture-work'))
  const reconciled = await api('/api/chat/deployment/reconcile', { revisions: (await runtime()).revisions })
  assert.equal(reconciled.verified, true)
  await api('/api/chat/capabilities/revoke', { revisions: (await runtime()).revisions,
    approvalId: object(approved.approval).approvalId, confirm: true })
  const revoked = await api('/api/chat/deployment/reconcile', { revisions: (await runtime()).revisions })
  assert.equal(revoked.verified, true)
  assert.deepEqual(revoked.missingReasons, [])
  assert.equal((await runtime()).state, 'stopped')
  assert(methods.every(method => ['agentPresets/list', 'agentPresets/read', 'settings/describe', 'credentials/describe'].includes(method)))
})
