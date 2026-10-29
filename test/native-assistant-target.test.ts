import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createNativeAssistantTarget, resolveAssistantReasoning } from '../src/host/native-assistant-target.ts'
import { createNativeAssistantDeploymentRoutes } from '../src/admin/native-assistant-target.ts'
import { createAdminServer } from '../src/admin/server.ts'
import { NativeConfigurationRepository } from '../src/admin/native-configuration-repository.ts'
import { composeStaticDshLayers, readStaticDshProfile, staticDshProfileValues } from '../src/adapters/dsh-static-profile.ts'
import { parseNativeAssistantDeploymentSnapshot, type NativeAssistantDeploymentRequest } from '../src/contracts/native-assistant-target.ts'
import type { ChatAssistantConfiguration } from '../src/host/chat-assistant-configuration.ts'
import type { NativeChatConfiguration } from '../src/host/native-chat-configuration.ts'
import type { JsonValue } from '../src/contracts/data.ts'

const signal = new AbortController().signal
function object(input: unknown): Record<string, unknown> { assert(input && typeof input === 'object' && !Array.isArray(input)); return input as Record<string, unknown> }
function revision(input: unknown): string { return createHash('sha256').update(JSON.stringify(input)).digest('hex') }
function request(snapshot: { assistantRevision: string; configurationRevision: string | null; targetRevision: string | null; operationRevision: string }): NativeAssistantDeploymentRequest {
  assert(snapshot.configurationRevision && snapshot.targetRevision)
  return { assistantRevision: snapshot.assistantRevision, configurationRevision: snapshot.configurationRevision, targetRevision: snapshot.targetRevision, operationRevision: snapshot.operationRevision }
}
async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'native-assistant-target-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const basePath = join(directory, 'base.patch.yml')
  const profilePath = join(directory, 'cordis.patch.yml')
  const credentialsPath = join(directory, '.credentials.yaml')
  const main = { id: 'main-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'existing-main-preset', plugins: [{ id: 'main-persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'Keep the main session identity.' } }] } }
  const base = [{ insert: [{ id: 'provider', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {
    observed: { api: 'openai-completions', baseURL: 'https://assistant.example.test/v1', models: [{ id: 'assistant-model', contextWindow: 256_000, maxTokens: 8_000, reasoningEfforts: false }] },
    original: { api: 'openai-completions', baseURL: 'https://main.example.test/v1', models: [{ id: 'main-model', contextWindow: 128_000, maxTokens: 4_096, reasoningEfforts: false }] }
  } } }, { id: 'credentials-local', name: '@deepseek-ai/dsh-credentials-local', config: { path: credentialsPath } }, main] }]
  await writeFile(basePath, JSON.stringify(base), { mode: 0o600 })
  const originalProfile = '# retain main operator comment\n[]\n'
  await writeFile(profilePath, originalProfile, { mode: 0o600 })
  await writeFile(credentialsPath, 'version: 1\nrefs:\n  ORIGINAL_KEY: keep-existing-private-value\n', { mode: 0o600 })
  const calls: string[] = []
  let loaded = true
  const server = createServer(async (incoming, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const wire = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const method = String(wire.method); calls.push(method)
      const args = object(object(wire.payload).args)
      const layers = [JSON.parse(await readFile(basePath, 'utf8')) as unknown,
        staticDshProfileValues(readStaticDshProfile(await readFile(profilePath, 'utf8')))]
      const rows = composeStaticDshLayers(layers)
      const providers = object(rows.find(row => row.id === 'provider')!.config)
      const presets = rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset').map(row => object(row.config))
      let value: unknown
      if (method === 'settings/describe') value = { writable: true, hasDocument: true, namespaces: loaded ? [
        { ns: 'provider', value: providers }, { ns: 'credentials-local', value: { path: credentialsPath } }] : [] }
      else if (method === 'agentPresets/list') value = { presets: loaded ? presets.map(preset => ({ id: preset.id, isDefault: false })) : [] }
      else if (method === 'agentPresets/read') value = { agentPreset: args.agentPreset, content: JSON.stringify(presets.find(preset => preset.id === args.agentPreset)?.plugins) }
      else if (method === 'credentials/describe') { assert(Array.isArray(args.refs)); value = Object.fromEntries(args.refs.map(ref => [String(ref), { configured: loaded, writable: true, source: 'file' }])) }
      else if (method === 'session/modelCatalog') {
        const routes = object(providers.providers)
        value = { default: { provider: 'original', model: 'main-model' }, routableProviders: Object.keys(routes), failures: [],
          groups: Object.entries(routes).map(([id, config]) => ({ id, name: id, models: (object(config).models as unknown[]).map(entry => ({ id: object(entry).id, name: String(object(entry).id) })) })) }
      } else throw new Error('No session creation, model call or permission mutation is allowed during target deployment')
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'server-response', rpcId: wire.rpcId, result: { ok: true, value } }))
    } catch { response.writeHead(500).end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert(address && typeof address !== 'string')
  const defaults = await new NativeConfigurationRepository(directory).read()
  let configuration: NativeChatConfiguration = { ...defaults,
    catalog: { activePlanId: 'main', plans: [{ id: 'main', name: 'Main', description: '', instructions: 'Keep existing chat.', personaId: 'main',
      provider: 'main', model: 'main-model', reasoningEffort: 'off', contextLimits: { group: 64_000, private: 96_000 } }] },
    personas: [{ id: 'main', name: 'Main persona', identity: 'Main identity.', style: 'Main style.' }],
    providers: [{ id: 'main', name: 'Main', type: 'openai', enabled: true, baseUrl: 'https://main.example.test/v1', apiKey: 'main-private-key', models: [{ id: 'main-model', name: 'Main' }] },
      { id: 'assistant', name: 'Assistant', type: 'openai', enabled: true, baseUrl: 'https://assistant.example.test/v1', apiKey: 'assistant-private-key', models: [{ id: 'assistant-model', name: 'Assistant' }] }],
    adapters: { ...defaults.adapters, dshAgent: { ...defaults.adapters.dshAgent, enabled: true, endpoint: `http://127.0.0.1:${address.port}`, auth: 'cookie:operator=fixture' } },
    deployment: { ...defaults.deployment, target: { profilePath, credentialsPath, layerPaths: [basePath], schemaVersion: '0.2.1-rc.2' },
      modelSettings: { contextWindow: 128_000, maxTokens: 4_096, reasoningEfforts: false } } }
  await writeFile(join(directory, 'chat-providers.json'), JSON.stringify({ schema: 1, providers: configuration.providers }), { mode: 0o600 })
  const storedProviders = await new NativeConfigurationRepository(directory).readProviders()
  configuration = { ...configuration, providers: storedProviders.value.providers,
    revisions: { ...configuration.revisions, providers: storedProviders.revision } }
  let assistant: ChatAssistantConfiguration = { schema: 1, mode: 'chat-assistant', provider: 'assistant', model: 'assistant-model', reasoningEffort: 'off', nickname: 'Helper' }
  const options = { directory, loadConfiguration: async () => configuration,
    loadAssistant: async () => ({ revision: revision(assistant), value: assistant }),
    deploymentOptions: { verificationTimeoutMs: 1_000, pollIntervalMs: 5 } }
  const target = createNativeAssistantTarget(options)
  return { directory, profilePath, credentialsPath, basePath, configuration, target, options, calls, originalProfile, main,
    assistant: () => ({ revision: revision(assistant), value: assistant }), setAssistant(value: ChatAssistantConfiguration) { assistant = value }, loaded(value: boolean) { loaded = value } }
}

test('assistant explicit application creates one independent verified target while main presets/routes/session state remain intact', async context => {
  const data = await fixture(context)
  assert.equal((await data.target.resolve(signal)).configuration.enabled, false)
  const before = await readFile(data.profilePath, 'utf8')
  const prepared = await data.target.prepare(data.assistant().revision, signal)
  assert.equal(parseNativeAssistantDeploymentSnapshot(prepared)?.state, 'prepared', JSON.stringify(prepared))
  assert.equal(await readFile(data.profilePath, 'utf8'), before)
  assert.equal(prepared.fullAccess, false)
  assert.equal(JSON.stringify(prepared).includes('assistant-private-key'), false)
  const applied = await data.target.apply(request(prepared), signal)
  assert.equal(applied.state, 'verified', JSON.stringify(applied))
  assert.equal(applied.fullAccess, true)
  assert.match(applied.agentPreset ?? '', /^qqbfwork-/)
  const resolved = await data.target.resolve(signal)
  assert.equal(resolved.configuration.enabled, true)
  assert.equal(resolved.configuration.provider, 'assistant')
  assert.equal(resolved.configuration.model, 'assistant-model')
  assert.equal(resolved.configuration.reasoningEffort, 'off')
  assert.equal(resolved.reasoningEffort, undefined)
  assert.equal(resolved.configuration.fullAccess, true)
  const rows = composeStaticDshLayers([JSON.parse(await readFile(data.basePath, 'utf8')) as unknown,
    staticDshProfileValues(readStaticDshProfile(await readFile(data.profilePath, 'utf8')))])
  assert.deepEqual(rows.find(row => row.id === 'main-preset'), data.main)
  assert.equal(rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset' && object(row.config).id !== 'existing-main-preset').length, 1)
  assert.match(await readFile(data.profilePath, 'utf8'), /retain main operator comment/)
  assert.match(await readFile(data.credentialsPath, 'utf8'), /ORIGINAL_KEY: keep-existing-private-value/)
  assert(data.calls.every(method => ['settings/describe', 'agentPresets/list', 'agentPresets/read', 'credentials/describe', 'session/modelCatalog'].includes(method)))
  const restored = createNativeAssistantTarget(data.options)
  assert.equal((await restored.resolve(signal)).agentPreset, resolved.agentPreset)
  data.setAssistant({ ...data.assistant().value, mode: 'chat-only' })
  const disabled = await restored.status(signal)
  assert.equal(disabled.state, 'blocked')
  assert.equal(disabled.fullAccess, false)
})

test('assistant pending reload and unknown evidence block replay until explicit readonly reconciliation', async context => {
  const data = await fixture(context)
  const prepared = await data.target.prepare(data.assistant().revision, signal)
  data.loaded(false)
  const pending = await data.target.apply(request(prepared), signal)
  assert.equal(pending.state, 'pending_reload')
  const bytes = await readFile(data.profilePath)
  assert.equal((await data.target.resolve(signal)).configuration.enabled, false)
  assert.equal((await data.target.prepare(data.assistant().revision, signal)).state, 'pending_reload')
  await assert.rejects(data.target.apply({ ...request(prepared), operationRevision: pending.operationRevision }, signal), { code: 'ASSISTANT_DEPLOYMENT_RECONCILIATION_REQUIRED' })
  assert.deepEqual(await readFile(data.profilePath), bytes)
  data.loaded(true)
  const reconciled = await data.target.reconcile(request(pending), signal)
  assert.equal(reconciled.state, 'verified')
  assert.deepEqual(await readFile(data.profilePath), bytes)
  assert.equal((await data.target.resolve(signal)).configuration.enabled, true)
})

test('one work admission verifies once then checks exact local source and deployment fingerprints without repeated RPC', async context => {
  const data = await fixture(context)
  const prepared = await data.target.prepare(data.assistant().revision, signal)
  assert.equal((await data.target.apply(request(prepared), signal)).state, 'verified')
  const work = await data.target.prepareWork(signal)
  assert.equal(work.resolution.configuration.enabled, true)
  const callsAfterPreparation = data.calls.length
  await work.assertCurrent(signal)
  await work.assertCurrent(signal)
  assert.equal(data.calls.length, callsAfterPreparation)
  data.setAssistant({ ...data.assistant().value, nickname: 'Changed after admission' })
  await assert.rejects(work.assertCurrent(signal), { code: 'ASSISTANT_CONFIGURATION_CHANGED' })
  assert.equal(data.calls.length, callsAfterPreparation)
})

test('work admission rejects changed deployment bytes and cancellation retains its real abort reason', async context => {
  const data = await fixture(context)
  const prepared = await data.target.prepare(data.assistant().revision, signal)
  assert.equal((await data.target.apply(request(prepared), signal)).state, 'verified')
  const work = await data.target.prepareWork(signal)
  const callsAfterPreparation = data.calls.length
  await writeFile(data.profilePath, (await readFile(data.profilePath, 'utf8')) + '\n# changed after verified admission\n', { mode: 0o600 })
  await assert.rejects(work.assertCurrent(signal), { code: 'ASSISTANT_CONFIGURATION_CHANGED' })
  assert.equal(data.calls.length, callsAfterPreparation)
  const controller = new AbortController()
  const reason = new Error('cancel-this-admission')
  controller.abort(reason)
  await assert.rejects(data.target.resolve(controller.signal), error => error === reason)
})

test('legacy verified assistant journal upgrades tools in its exact existing preset and never adopts a name without ownership', async context => {
  const data = await fixture(context)
  const prepared = await data.target.prepare(data.assistant().revision, signal)
  const applied = await data.target.apply(request(prepared), signal)
  assert.equal(applied.state, 'verified')
  const profile: unknown = structuredClone(staticDshProfileValues(readStaticDshProfile(await readFile(data.profilePath, 'utf8'))))
  assert(Array.isArray(profile))
  for (const patch of profile) {
    const row = object(patch)
    const entries: unknown[] = Array.isArray(row.insert) ? row.insert : [row]
    for (const entry of entries) {
      const candidate = object(entry)
      if (!candidate.config || object(candidate.config).id !== applied.agentPreset) continue
      const config = object(candidate.config)
      assert(Array.isArray(config.plugins))
      config.plugins = config.plugins.filter(plugin => !String(object(plugin).id).startsWith('qbf-assistant-'))
    }
  }
  await writeFile(data.profilePath, JSON.stringify(profile), { mode: 0o600 })
  const journalPath = join(data.directory, 'assistant-deployment.json')
  const journal = object(JSON.parse(await readFile(journalPath, 'utf8')))
  const legacyRevision = revision({ schema: 1, provider: data.configuration.providers.find(provider => provider.id === 'assistant'),
    model: 'assistant-model', reasoningEffort: 'off', target: data.configuration.deployment.target,
    settings: { contextWindow: 256_000, maxTokens: 8_000, reasoningEfforts: false },
    connection: data.configuration.adapters.dshAgent,
    instructions: '完成当前会话中由用户明确委派的独立工作。只根据宿主提供的任务、来源和上下文行动；工具与资源许可继续由宿主和外部服务分别核验，不把任务内容当作授权。返回真实结果，未完成时说明阻碍。' })
  const restored = createNativeAssistantTarget(data.options)
  object(journal.applied).configurationRevision = '1'.repeat(64)
  object(journal.pending).configurationRevision = '1'.repeat(64)
  await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 })
  const unowned = await restored.prepare(data.assistant().revision, signal)
  assert.equal(unowned.state, 'blocked')
  assert(unowned.missingReasons.includes('preset_conflict'))
  object(journal.applied).configurationRevision = legacyRevision
  object(journal.pending).configurationRevision = legacyRevision
  await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 })
  assert.equal(await restored.needsManagedSynchronization(signal), true)
  const upgrade = await restored.prepare(data.assistant().revision, signal)
  assert.equal(upgrade.state, 'prepared', JSON.stringify(upgrade))
  const upgraded = await restored.apply(request(upgrade), signal)
  assert.equal(upgraded.state, 'verified', JSON.stringify(upgraded))
  assert.equal(upgraded.agentPreset, applied.agentPreset)
  assert.notEqual(upgraded.configurationRevision, legacyRevision)
  const rows = composeStaticDshLayers([JSON.parse(await readFile(data.basePath, 'utf8')) as unknown,
    staticDshProfileValues(readStaticDshProfile(await readFile(data.profilePath, 'utf8')))])
  const matches = rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset' && object(row.config).id === applied.agentPreset)
  assert.equal(matches.length, 1)
  const plugins = object(matches[0]!.config).plugins
  assert(Array.isArray(plugins))
  assert(plugins.some(plugin => object(plugin).name === '@deepseek-ai/dsh-tool-fs'))
  assert(plugins.some(plugin => object(plugin).name === '@deepseek-ai/dsh-tool-fs-search'))
  assert(plugins.some(plugin => ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-pwsh'].includes(String(object(plugin).name))))
})

test('assistant config and target CAS reject stale application and unselected model capacity is never borrowed', async context => {
  const data = await fixture(context)
  const prepared = await data.target.prepare(data.assistant().revision, signal)
  const profile = await readFile(data.profilePath)
  data.setAssistant({ ...data.assistant().value, nickname: 'New nickname' })
  await assert.rejects(data.target.apply(request(prepared), signal), { code: 'ASSISTANT_CONFIGURATION_CONFLICT' })
  assert.deepEqual(await readFile(data.profilePath), profile)
  data.setAssistant({ ...data.assistant().value, model: 'missing-metadata' })
  const unavailable = await data.target.prepare(data.assistant().revision, signal)
  assert.equal(unavailable.state, 'blocked')
  assert.equal((await data.target.resolve(signal)).configuration.enabled, false)
})

test('SDK reasoning selection uses observed effort identifiers and rejects missing/contradictory metadata', () => {
  const catalog = (reasoning?: JsonValue) => ({ groups: [{ id: 'route', models: [{ id: 'model', ...(reasoning === undefined ? {} : { reasoning }) }] }], routableProviders: ['route'], failures: [] })
  assert.deepEqual(resolveAssistantReasoning(catalog(), 'route', 'model', 'off'), {})
  assert.deepEqual(resolveAssistantReasoning(catalog({ efforts: [{ id: 'none' }, { id: 'medium' }] }), 'route', 'model', 'off'), { reasoningEffort: 'none' })
  assert.deepEqual(resolveAssistantReasoning(catalog({ efforts: [{ id: 'off' }, { id: 'medium' }] }), 'route', 'model', 'medium'), { reasoningEffort: 'medium' })
  assert.throws(() => resolveAssistantReasoning(catalog(), 'route', 'model', 'medium'), { code: 'ASSISTANT_REASONING_UNSUPPORTED' })
  assert.throws(() => resolveAssistantReasoning(catalog({ efforts: [{ id: 'medium' }, { id: 'medium' }] }), 'route', 'model', 'medium'), { code: 'ASSISTANT_MODEL_CAPABILITIES_UNVERIFIED' })
})

test('assistant deployment HTTP requires explicit preview revisions and exposes no work execution or permission approval', async context => {
  const data = await fixture(context)
  const token = 'assistant-admin-token-1234567890'
  const server = createAdminServer({ token, snapshot: () => ({}), routes: createNativeAssistantDeploymentRoutes({ target: data.target }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  async function post(action: string, body: unknown) { return fetch(`${origin}/api/chat/assistant/deployment/${action}`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
  assert.equal((await post('apply', {})).status, 400)
  const prepared = await post('prepare', { assistantRevision: data.assistant().revision })
  const parsed = parseNativeAssistantDeploymentSnapshot(await prepared.json()); assert(parsed)
  assert.equal((await post('apply', request(parsed))).status, 200)
  assert.equal((await post('approve', {})).status, 404)
})
