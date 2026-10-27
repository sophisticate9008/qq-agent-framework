import { awaitCondition } from './await-condition.ts'
import { handleDshControlFrame, writeDshRpcSuccess, writeDshStreamItem } from './dsh-wire.ts'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocketServer, type WebSocket } from 'ws'
import { parse, stringify } from 'yaml'
import { startGatewayAdmin } from '../../src/admin/gateway.ts'
import { createDshToolScopeReader } from '../../src/adapters/dsh-tool-scope.ts'
import { createDshClaimPluginFixture } from './dsh-claim-plugin.ts'

type Value = Record<string, unknown>
interface ScopedAgent { readonly id: string; readonly ctx: { readonly preset: string }; readonly session: { readonly id: string } }
interface Trace { readonly sequence: number; readonly kind: 'admin' | 'dsh' | 'scope' | 'onebot'; readonly method: string;
  readonly status?: number; readonly sessionId?: string; readonly state?: string; readonly names?: readonly string[];
  readonly externalToolAuthorizationVerified?: boolean; readonly declarationRevisionVerified?: boolean; readonly schemaFingerprint?: string }

export interface NativeCapabilityFixtureLifecycle {
  after(cleanup: () => void | Promise<void>): void
}

export interface NativeCapabilityFixtureOptions {
  readonly evidenceRoot?: string
}

export function capabilityObject(value: unknown): Value {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Value
}

export async function capabilityUntil(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 10_000): Promise<void> {
  await awaitCondition(predicate, { message, timeoutMs })
}

export async function createNativeCapabilityRuntimeFixture(context: NativeCapabilityFixtureLifecycle, options: NativeCapabilityFixtureOptions = {}) {
  const object = capabilityObject
  const evidence = options.evidenceRoot ?? process.env.QQ_CAPABILITY_DEFAULT_EVIDENCE
  const root = evidence ?? tmpdir()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(root, 'native-capability-case-'))
  const profilePath = join(directory, 'cordis.patch.yml')
  const credentialsPath = join(directory, 'credentials.yml')
  const capabilityContent = stringify([{ id: 'operator-work', name: '@operator/mature-work', config: { mode: 'declaration-only' } }])
  const documents = new Map([['operator-work', capabilityContent]])
  const trace: Trace[] = []
  const calls: Array<{ method: string; input: Value }> = []
  const sends: Value[] = []
  const errors: string[] = []
  const onebots = new Set<WebSocket>()
  const agents = new Map<string, ScopedAgent>()
  const selected = new Map<string, Value>()
  const streams: Array<{ socket: WebSocket; streamId: string; sessionId: string }> = []
  const sequences = new Map<string, number>()
  const plugin = createDshClaimPluginFixture()
  const controls = { loaded: true, sourceReadFails: false, livePluginDrift: false, scopeReadFails: false,
    scopeUnavailable: false, scopeWrongPreset: false, scopeHeld: false, scopeAborted: 0,
    schemas: [] as unknown[], promptUnknown: false, creates: 0 }
  const record = (entry: Omit<Trace, 'sequence'>) => trace.push({ ...entry, sequence: trace.length })
  const scopes = createDshToolScopeReader({ sessionId: (value: string) => value,
    agents: { get: (id: string) => controls.scopeUnavailable ? undefined : agents.get(id) },
    agentPresets: { composedPreset: (agentContext: ScopedAgent['ctx']) => controls.scopeWrongPreset ? 'wrong-preset' : agentContext.preset },
    tools: { schemas: () => controls.schemas } })
  await writeFile(profilePath, stringify([{ insert: [
    { id: 'llm', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } },
    { id: 'credentials-local', name: '@deepseek-ai/dsh-credentials-local', config: { path: credentialsPath } },
  ] }]), { mode: 0o600 })
  await writeFile(credentialsPath, stringify({ version: 1, refs: {} }), { mode: 0o600 })

  async function rows(): Promise<Value[]> {
    const patches: unknown = parse(await readFile(profilePath, 'utf8'))
    assert(Array.isArray(patches))
    const indexed = new Map<string, Value>()
    for (const raw of patches) {
      const patch = object(raw)
      if (Array.isArray(patch.insert)) for (const entry of patch.insert) {
        const row = object(entry)
        indexed.set(String(row.id), row)
      }
      else {
        const prior = indexed.get(String(patch.id))
        assert(prior)
        indexed.set(String(patch.id), { ...prior, ...patch })
      }
    }
    return [...indexed.values()]
  }

  const wire = new WebSocketServer({ noServer: true })
  const upstream = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, 'http://127.0.0.1')
      if (url.pathname.startsWith('/onebot/')) {
        assert.equal(request.headers.authorization, 'Bearer fixture-onebot-http')
        record({ kind: 'onebot', method: url.pathname })
        if (url.pathname.endsWith('/get_login_info')) response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 999 } }))
        else {
          let body = ''
          for await (const chunk of request) body += String(chunk)
          sends.push(object(JSON.parse(body)))
          response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 10_000 + sends.length } }))
        }
        return
      }
      if (url.pathname === '/dsh/connect') {
        assert.equal(url.searchParams.get('token'), 'fixture-dsh-owner')
        response.writeHead(302, { location: './api/remote.mux', 'set-cookie': 'capability_fixture=owner; HttpOnly' }).end()
        return
      }
      assert(url.pathname.startsWith('/dsh/api/'))
      assert.equal(request.headers.cookie, 'capability_fixture=owner')
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const envelope = object(JSON.parse(body))
      const args = object(object(envelope.payload).args)
      const input = args.request === undefined ? args : object(args.request)
      const method = String(envelope.method)
      calls.push({ method, input })
      record({ kind: 'dsh', method, ...(typeof input.sessionId === 'string' ? { sessionId: input.sessionId } : {}) })
      const effective = await rows()
      const provider = effective.find(row => row.id === 'llm')!
      const presets = effective.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')
      let value: unknown
      if (method === 'settings/describe') value = { namespaces: controls.loaded ? [
        { ns: 'llm', value: provider.config }, { ns: 'credentials-local', value: { path: credentialsPath } },
      ] : [] }
      else if (method === 'agentPresets/list') value = { presets: [
        ...[...documents.keys()].map(id => ({ id, name: id, isDefault: false })),
        ...(controls.loaded ? presets.map(row => ({ id: object(row.config).id, isDefault: false })) : []),
      ] }
      else if (method === 'agentPresets/read') {
        if (documents.has(String(input.agentPreset))) {
          if (controls.sourceReadFails) { response.writeHead(503).end(); return }
          value = { agentPreset: input.agentPreset, content: documents.get(String(input.agentPreset)) }
        } else {
          const preset = presets.find(row => object(row.config).id === input.agentPreset)
          if (!preset) {
            response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId,
              result: { ok: false, error: { code: 'agent-preset/conflict', message: 'Synthetic preset is not loaded.', details: {} } } }))
            return
          }
          value = { agentPreset: input.agentPreset, content: stringify(controls.livePluginDrift ? [] : object(preset.config).plugins) }
        }
      } else if (method === 'credentials/describe') {
        const refs = object(object(parse(await readFile(credentialsPath, 'utf8'))).refs)
        assert(Array.isArray(input.refs))
        value = Object.fromEntries(input.refs.map(ref => [String(ref), { configured: typeof refs[String(ref)] === 'string', writable: true, source: 'file' }]))
      } else if (method === 'session/modelCatalog') {
        const providers = object(object(provider.config).providers)
        const groups = Object.entries(providers).map(([id, raw]) => {
          const route = object(raw)
          assert(Array.isArray(route.models))
          return { id, name: id, models: route.models.map(rawModel => {
            const model = object(rawModel)
            return { id: model.id, name: model.id }
          }) }
        })
        assert(groups.length)
        value = { default: { provider: groups[0]!.id, model: groups[0]!.models[0]!.id },
          routableProviders: groups.map(group => group.id), groups, failures: [] }
      } else if (method === 'session/create') {
        controls.creates++
        const id = `capability-session-${controls.creates}`
        assert(typeof input.agentPreset === 'string')
        agents.set(id, { id, ctx: { preset: input.agentPreset }, session: { id } })
        value = { sessionId: id, agentPreset: input.agentPreset }
      } else if (method === 'session/selectModel') {
        const selection = { provider: input.provider, model: input.model,
          ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) }
        selected.set(String(input.sessionId), selection)
        value = { selected: selection }
      } else if (method === 'bridgePlugin/inspectScope') {
        if (controls.scopeReadFails) { response.writeHead(503).end(); return }
        if (controls.scopeHeld) { response.once('close', () => { controls.scopeAborted++ }); return }
        assert(typeof input.sessionId === 'string')
        assert(typeof input.expectedPreset === 'string')
        if (input.expectedNames !== undefined) assert(Array.isArray(input.expectedNames) && input.expectedNames.every(name => typeof name === 'string'))
        if (input.expectedSchemaFingerprint !== undefined) assert(typeof input.expectedSchemaFingerprint === 'string')
        value = { ...object(plugin.invoke('bridgePlugin/describe', {})), ...scopes.inspect({ sessionId: input.sessionId, expectedPreset: input.expectedPreset,
          ...(input.expectedNames === undefined ? {} : { expectedNames: input.expectedNames as string[] }),
          ...(input.expectedSchemaFingerprint === undefined ? {} : { expectedSchemaFingerprint: input.expectedSchemaFingerprint }) }) }
        const inspection = object(value)
        record({ kind: 'scope', method, sessionId: input.sessionId, state: String(inspection.state),
          ...(Array.isArray(inspection.names) ? { names: inspection.names as string[] } : {}),
          ...(typeof inspection.schemaFingerprint === 'string' ? { schemaFingerprint: inspection.schemaFingerprint } : {}),
          ...(typeof inspection.externalToolAuthorizationVerified === 'boolean' ? { externalToolAuthorizationVerified: inspection.externalToolAuthorizationVerified } : {}),
          ...(typeof inspection.declarationRevisionVerified === 'boolean' ? { declarationRevisionVerified: inspection.declarationRevisionVerified } : {}) })
      } else if (method.startsWith('bridgePlugin/')) value = plugin.invoke(method, input)
      else if (method === 'session/prompt') {
        if (controls.promptUnknown) { response.writeHead(503).end(); return }
        plugin.accepted(String(input.sessionId), String(input.requestId))
        value = { accepted: true }
      } else if (method === 'session/cancel') value = { accepted: true }
      else assert.fail(`Unexpected model/service operation: ${method}`)
      writeDshRpcSuccess(response, envelope.rpcId, value)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Fixture failure')
      response.writeHead(500).end()
    }
  })
  upstream.on('upgrade', (request, socket, head) => {
    wire.handleUpgrade(request, socket, head, connection => {
      if (request.url === '/onebot-ws') {
        assert.equal(request.headers.authorization, 'Bearer fixture-onebot-ws')
        onebots.add(connection)
        connection.once('close', () => onebots.delete(connection))
        connection.on('message', data => {
          const action = object(JSON.parse(data.toString()))
          assert.equal(action.action, 'get_login_info')
          connection.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo, data: { user_id: 999 } }))
        })
        return
      }
      assert.equal(request.url, '/dsh/api/remote.mux')
      assert.equal(request.headers.cookie, 'capability_fixture=owner')
      connection.on('message', data => {
        const input = object(JSON.parse(data.toString()))
        if (handleDshControlFrame(connection, input)) return
        const sessionId = String(object(object(object(object(input.payload).args).request).address).sessionId)
        streams.push({ socket: connection, streamId: String(input.streamId), sessionId })
        writeDshStreamItem(connection, input.streamId, {
          type: 'snapshot', header: { id: sessionId }, cursor: (sequences.get(sessionId) ?? 0) - 1, records: [],
        })
      })
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  let gateway: Awaited<ReturnType<typeof startGatewayAdmin>> | undefined
  let closing: Promise<void> | undefined
  async function cleanup() {
    await gateway?.close()
    for (const connection of wire.clients) connection.terminate()
    await new Promise<void>(resolve => wire.close(() => resolve()))
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    if (evidence) await writeFile(join(directory, 'trace.json'), JSON.stringify({ trace, errors }, null, 2), { mode: 0o600 })
    else await rm(directory, { recursive: true, force: true })
  }
  function close(): Promise<void> {
    closing ??= cleanup()
    return closing
  }
  context.after(close)
  const adminToken = 'synthetic-admin-login-only-0123456789'
  const tokenFile = join(directory, 'admin.token')
  const gatewayConfiguration = join(directory, 'gateway.json')
  await writeFile(tokenFile, adminToken, { mode: 0o600 })
  await writeFile(join(directory, 'gateway.token'), 'synthetic-gateway-token-0123456789', { mode: 0o600 })
  await writeFile(gatewayConfiguration, JSON.stringify({ port: 0, upstreamEndpoint: `${base}/onebot`,
    tokenFile: './gateway.token', storeFilename: './unused-egress.sqlite', allowedConversations: [], persona: { id: 'egress', version: '1' } }), { mode: 0o600 })
  gateway = await startGatewayAdmin({ host: '127.0.0.1', port: 0, tokenFile, gatewayConfiguration })
  let origin = `http://127.0.0.1:${gateway.address.port}`
  let cookie = ''
  async function api(path: string, body?: Value, expected = 200, authenticated = true) {
    const response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(authenticated && cookie ? { cookie } : {}), ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) })
    record({ kind: 'admin', method: `${body === undefined ? 'GET' : 'POST'} ${path}`, status: response.status })
    const result = object(await response.json())
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`)
    return result
  }
  async function login() {
    const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: {
      authorization: `Bearer ${adminToken}`, origin, 'content-type': 'application/json',
    }, body: '{}', signal: AbortSignal.timeout(5_000) })
    assert.equal(response.status, 200)
    assert.equal(object(await response.json()).authenticated, true)
    cookie = response.headers.get('set-cookie')!.split(';')[0]!
    assert(cookie && !cookie.includes(adminToken))
    record({ kind: 'admin', method: 'POST /api/auth/login', status: response.status })
  }
  async function reopen() {
    await gateway?.close()
    gateway = await startGatewayAdmin({ host: '127.0.0.1', port: 0, tokenFile, gatewayConfiguration })
    origin = `http://127.0.0.1:${gateway.address.port}`
    cookie = ''
    await login()
  }
  async function save(name: string, body: Value) {
    const current = await api(`/api/chat/${name}`)
    return api(`/api/chat/${name}`, { revision: current.revision, ...body })
  }
  const status = () => api('/api/chat/runtime')
  const selection = async () => {
    const catalog = object((await api('/api/chat/capabilities')).catalog)
    assert(Array.isArray(catalog.presets))
    const source = catalog.presets.map(object).find(preset => preset.presetId === 'operator-work')!
    assert.equal(source.composable, true)
    return { schema: 1, presetId: source.presetId, revision: source.revision }
  }
  async function configure(selectedCapability = true, toolDelegationUses?: number) {
    await save('personas', { personas: [{ id: 'independent', name: 'Independent persona', identity: 'Independent identity.', style: 'Concise.' }] })
    await save('providers', { providers: [{ id: 'synthetic', name: 'Synthetic no-network model', type: 'openai', enabled: true,
      baseUrl: `${base}/model-network-forbidden`, apiKey: 'synthetic-model-key-never-used', models: [{ id: 'synthetic-model', name: 'Synthetic' }] }] })
    await save('adapters', { adapters: {
      onebotHttp: { enabled: true, endpoint: `${base}/onebot`, secret: 'fixture-onebot-http' },
      onebotWs: { enabled: true, endpoint: `${base.replace('http:', 'ws:')}/onebot-ws`, secret: 'fixture-onebot-ws' },
      dshAgent: { enabled: true, endpoint: `${base}/dsh`, auth: 'fixture-dsh-owner' },
    } })
    await save('plans', { activePlanId: 'daily', plans: [{ id: 'daily', name: 'Daily', description: '', instructions: 'No implicit permissions.',
      personaId: 'independent', provider: 'synthetic', model: 'synthetic-model', reasoningEffort: 'off',
      contextLimits: { group: 100_000, private: 120_000 }, ...(selectedCapability ? { capabilitySelection: await selection() } : {}) }] })
    await save('access', { allow: ['private:123', 'group:456'], deny: [], owner: '123' })
    await save('authorization', { version: '1', grants: ['private:123', 'group:456'].map(conversationId => ({
      conversationId, submitUses: 20, sendUses: 20, expiresAt: null,
      ...(toolDelegationUses === undefined ? {} : { toolDelegationUses }),
    })) })
    await save('deployment', { deployment: { target: { profilePath, credentialsPath, schemaVersion: '0.2.1-rc.2' },
      modelSettings: { contextWindow: 200_000, maxTokens: 8_000, reasoningEfforts: false }, namespace: 'capability' } })
  }
  const preview = async () => api('/api/chat/deployment/prepare', { revisions: (await status()).revisions })
  async function approve() {
    const prepared = await preview()
    assert.equal(prepared.state, 'prepared')
    const request = object(prepared.capabilityApprovalRequest)
    return api('/api/chat/capabilities/approval', { revisions: (await status()).revisions,
      targetRevision: prepared.targetRevision, compositionRevision: request.compositionRevision, confirm: true })
  }
  async function apply() {
    const prepared = await preview()
    assert.equal(prepared.state, 'prepared')
    return api('/api/chat/deployment/apply', { revisions: (await status()).revisions, targetRevision: prepared.targetRevision })
  }
  const start = async (expected = 200) => api('/api/chat/runtime/start', { revisions: (await status()).revisions }, expected)
  function inbound(messageId: number, conversation: 'private' | 'group' = 'private') {
    assert(onebots.size)
    const message = [...(conversation === 'group' ? [{ type: 'at', data: { qq: '999' } }] : []),
      { type: 'text', data: { text: `Synthetic inbound ${messageId}` } }]
    for (const socket of onebots) socket.send(JSON.stringify({ post_type: 'message', self_id: 999, message_type: conversation,
      ...(conversation === 'group' ? { group_id: 456 } : {}), user_id: 123, message_id: messageId, time: Math.floor(Date.now() / 1000), message }))
  }
  function event(type: string, data: Value, stream = streams.at(-1)) {
    assert(stream)
    const seq = sequences.get(stream.sessionId) ?? 0
    sequences.set(stream.sessionId, seq + 1)
    stream.socket.send(JSON.stringify({ type: 'item', streamId: stream.streamId, value: { type: 'event', event: { type, data, seq } } }))
  }
  return { directory, profilePath, credentialsPath, get origin() { return origin }, adminToken, close,
    api, login, reopen, save, status, configure, selection, preview, approve, apply, start,
    inbound, event, documents, controls, calls, trace, sends, errors, streams, selected, agents }
}
