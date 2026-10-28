import { awaitCondition } from './await-condition.ts'
import { handleDshControlFrame, writeDshRpcSuccess, writeDshStreamItem } from './dsh-wire.ts'
import assert from 'node:assert/strict'
import { createDshClaimPluginFixture } from './dsh-claim-plugin.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestContext } from 'node:test'
import { WebSocketServer, type WebSocket } from 'ws'
import { parse, stringify } from 'yaml'

type Value = Record<string, unknown>
const adminToken = 'local-admin-token-no-production-0123456789'
export const useRealCli = process.env.QQ_AGENT_FIXTURE_CLI === '1'

export function nativeGatewayFixtureObject(value: unknown): Value {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Value
}

export async function nativeGatewayFixtureUntil(predicate: () => boolean | Promise<boolean>, milliseconds = 5_000) {
  await awaitCondition(predicate, { message: 'Local CLI gateway condition did not settle', timeoutMs: milliseconds })
}

const object = nativeGatewayFixtureObject
const until = nativeGatewayFixtureUntil

export async function createNativeChatGatewayFixture(context: TestContext, options: { readonly bootstrapFile?: string; readonly realCli?: boolean } = {}) {
  const realCli = options.realCli ?? useRealCli
  const privateRoot = join(process.cwd(), 'runtime', 'engineering', '016', 'fixtures')
  await mkdir(privateRoot, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(privateRoot, 'native-cli-gateway-'))
  const bootstrapFile = options.bootstrapFile ?? join(directory, 'operator-bootstrap.ts')
  const lifecycleFile = join(directory, 'bootstrap-lifecycle.log')
  if (options.bootstrapFile === undefined) await writeFile(bootstrapFile, `import {appendFileSync} from 'node:fs';
    const record=(value:string)=>appendFileSync(${JSON.stringify(lifecycleFile)},value+'\\n',{mode:0o600});
    record('loaded');
    export default {manifest:{id:'fixture-bootstrap',version:'1.0.0',apiVersion:1},create(){
      record('create');return {
        features:[{id:'fixture-denied',version:'1.0.0',apiVersion:1,capabilities:['fixture.inspect'],
          subscriptions:['fixture.check'],setup(services){services.on('fixture.check',execution=>execution.invoke('fixture.inspect',{}));}}],
        eventValidators:{'fixture.check':()=>true},
        effectAdapters:{'fixture.inspect':{execute(){record('effect-ran');return null;}}},
        onebot:{resolveAsset(){throw new Error('No resource approved');},forward:{senderId:'999',senderName:'Local fixture',group:true}},
        async start(host){record('start');const report=await host.engine.emit({id:'bootstrap-check',type:'fixture.check',conversationId:'private:123',data:{}});
          record('denied:'+report.outcomes[0]?.errorCode);},stop(){record('stop');}
      };}};`, { mode: 0o600 })
  const profilePath = join(directory, 'cordis.patch.yml')
  const credentialsPath = join(directory, 'credentials.yml')
  await writeFile(profilePath, stringify([{ insert: [
    { id: 'llm', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } },
    { id: 'credentials-local', name: '@deepseek-ai/dsh-credentials-local', config: { path: credentialsPath } }
  ] }]), { mode: 0o600 })
  await writeFile(credentialsPath, stringify({ version: 1, refs: {} }), { mode: 0o600 })
  const wire = new WebSocketServer({ noServer: true })
  const onebots = new Set<WebSocket>()
  const streams: Array<{ socket: WebSocket; streamId: string; sessionId: string }> = []
  const sequences = new Map<string, number>()
  const calls: Array<{ method: string; input: Value }> = []
  const sends: Value[] = []
  const sendActions: string[] = []
  const plugin = createDshClaimPluginFixture()
  let holdLogin = false
  let loginRequests = 0
  let authFails = false
  let httpLoginStatus: string | null = 'ok'
  let onebotSendStatus = 'ok'
  let credentialSource = 'file'
  let liveCredentialsPath = credentialsPath
  let creates = 0
  const selected = new Map<string, Value>()
  async function deploymentRows() {
    const patches: unknown = parse(await readFile(profilePath, 'utf8'))
    assert(Array.isArray(patches))
    const rows = new Map<string, Value>()
    for (const raw of patches) {
      const patch = object(raw)
      if (Array.isArray(patch.insert)) for (const entry of patch.insert) {
        const row = object(entry)
        rows.set(String(row.id), row)
      }
      else {
        const prior = rows.get(String(patch.id))
        assert(prior)
        rows.set(String(patch.id), { ...prior, ...patch })
      }
    }
    return [...rows.values()]
  }
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://fixture.test')
    if (url.pathname.startsWith('/onebot/')) {
      assert.equal(request.headers.authorization, 'Bearer onebot-http-only')
      let body = ''
      for await (const chunk of request) body += String(chunk)
      if (url.pathname === '/onebot/get_login_info') response.end(JSON.stringify({
        ...(httpLoginStatus === null ? {} : { status: httpLoginStatus }), retcode: 0, data: { user_id: 999 } }))
      else if (url.pathname === '/onebot/get_version_info') response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { app_name: 'SyntheticOneBot', app_version: '1.0.0' } }))
      else {
        sends.push(object(JSON.parse(body)))
        sendActions.push(url.pathname)
        response.end(JSON.stringify({ status: onebotSendStatus, retcode: 0, data: { message_id: 10_000 + sends.length } }))
      }
      return
    }
    if (url.pathname === '/dsh/connect') {
      assert.equal(url.searchParams.get('token'), 'dsh-fixture-only')
      if (authFails) { response.writeHead(401).end(); return }
      response.writeHead(302, { location: './api/remote.mux', 'set-cookie': 'dsh_fixture=authorized.local; HttpOnly' }).end()
      return
    }
    assert.equal(request.headers.cookie, 'dsh_fixture=authorized.local')
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const envelope = object(JSON.parse(body))
    const args = object(object(envelope.payload).args)
    const input = args.request === undefined ? args : object(args.request)
    const method = String(envelope.method)
    calls.push({ method, input })
    const rows = await deploymentRows()
    const providers = rows.find(row => row.id === 'llm')!
    const presets = rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')
    let value: unknown
    if (method === 'session/modelCatalog') {
      const routes = object(object(providers.config).providers)
      const groups = Object.entries(routes).map(([id, raw]) => {
        const route = object(raw)
        assert(Array.isArray(route.models))
        return { id, name: id, models: route.models.map(rawModel => {
          const model = object(rawModel)
          return { id: model.id, name: model.id, ...(model.reasoningEfforts === false ? {} : {
            reasoning: { efforts: Object.keys(object(model.reasoningEfforts)).map(effort => ({ id: effort, name: effort })) }
          }) }
        }) }
      })
      assert(groups.length > 0)
      value = { default: { provider: groups[0].id, model: groups[0].models[0].id },
        routableProviders: groups.map(group => group.id), groups, failures: [] }
    }
    else if (method.startsWith('bridgePlugin/')) value = plugin.invoke(method, input)
    else if (method === 'session/prompt') { plugin.accepted(String(input.sessionId), String(input.requestId)); value = { accepted: true } }
    else if (method === 'settings/describe') value = { namespaces: [{ ns: 'llm', value: providers.config },
      { ns: 'credentials-local', value: { path: liveCredentialsPath, watch: true } }] }
    else if (method === 'agentPresets/list') value = { presets: presets.map(row => ({ id: object(row.config).id })) }
    else if (method === 'agentPresets/read') {
      const preset = presets.find(row => object(row.config).id === input.agentPreset)
      if (!preset) {
        response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId,
          result: { ok: false, error: { code: 'agent-preset/conflict', message: 'Not deployed.', details: {} } } }))
        return
      }
      value = { agentPreset: input.agentPreset, content: stringify(object(preset.config).plugins) }
    } else if (method === 'credentials/describe') {
      const refs = object(object(parse(await readFile(credentialsPath, 'utf8'))).refs)
      assert(Array.isArray(input.refs))
      value = Object.fromEntries(input.refs.map(ref => [String(ref), {
        configured: typeof refs[String(ref)] === 'string', writable: true, source: credentialSource
      }]))
    } else if (method === 'session/create') {
      creates++
      value = { sessionId: `native-session-${creates}`, agentPreset: input.agentPreset }
    } else if (method === 'session/selectModel') {
      const route = { provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort }
      selected.set(String(input.sessionId), route)
      value = { selected: route }
    } else value = { accepted: true }
    writeDshRpcSuccess(response, envelope.rpcId, value)
  })
  upstream.on('upgrade', (request, socket, head) => {
    wire.handleUpgrade(request, socket, head, connection => {
      if (request.url === '/onebot-ws') {
        assert.equal(request.headers.authorization, 'Bearer onebot-ws-only')
        onebots.add(connection)
        connection.once('close', () => onebots.delete(connection))
        connection.on('message', data => {
          const action = object(JSON.parse(data.toString()))
          assert.equal(action.action, 'get_login_info')
          loginRequests++
          if (!holdLogin) connection.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo, data: { user_id: 999 } }))
        })
        return
      }
      assert.equal(request.url, '/dsh/api/remote.mux')
      assert.equal(request.headers.cookie, 'dsh_fixture=authorized.local')
      connection.on('message', data => {
        const input = object(JSON.parse(data.toString()))
        if (handleDshControlFrame(connection, input)) return
        const sessionId = String(object(object(object(object(input.payload).args).request).address).sessionId)
        streams.push({ socket: connection, streamId: String(input.streamId), sessionId })
        writeDshStreamItem(connection, input.streamId, {
          type: 'snapshot', header: { id: sessionId }, cursor: (sequences.get(sessionId) ?? 0) - 1,
          records: [{ type: 'assistant/message', text: 'Old historical text never sent.' }]
        })
      })
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress !== 'string')
  const base = `http://127.0.0.1:${upstreamAddress.port}`
  const configurationFile = join(directory, 'admin.json')
  await writeFile(join(directory, 'admin.token'), adminToken, { mode: 0o600 })
  await writeFile(join(directory, 'gateway.token'), 'gateway-fixture-token-0123456789', { mode: 0o600 })
  await writeFile(join(directory, 'gateway.json'), JSON.stringify({ port: 32123, upstreamEndpoint: `${base}/onebot`,
    tokenFile: './gateway.token', storeFilename: './unused-egress.sqlite', allowedConversations: [],
    persona: { id: 'egress', version: '1' } }), { mode: 0o600 })
  await writeFile(configurationFile, JSON.stringify({ host: '127.0.0.1', port: 0,
    tokenFile: './admin.token', gatewayConfiguration: './gateway.json' }), { mode: 0o600 })
  let child: ChildProcess | undefined
  let origin = ''
  let diagnostics = ''
  async function launch(useSavedBootstrap = false) {
    const extension = import.meta.url.endsWith('.js') ? '.js' : '.ts'
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const entry = [fileURLToPath(new URL(`../../scripts/${realCli ? 'cli' : 'gateway-admin'}${extension}`, import.meta.url)),
      ...(realCli ? ['start', '--admin-only'] : [])]
    child = spawn(process.execPath, [...entry, '--config', configurationFile, ...(useSavedBootstrap ? [] : ['--bootstrap', bootstrapFile])], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout!.on('data', chunk => { output += String(chunk) })
    child.stderr!.on('data', chunk => { diagnostics += String(chunk) })
    await until(() => {
      assert.equal(child?.exitCode, null, diagnostics)
      const match = /(?:Framework gateway administrator listening on |管理服务已启动：)(http:\/\/127\.0\.0\.1:[0-9]+)/.exec(output)
      if (!match) return false
      origin = match[1]
      return true
    }, realCli ? 90_000 : 5_000)
  }
  async function shutdown(expectedExitCode = 0) {
    if (!child || child.exitCode !== null) return
    const stopping = child
    const exited = once(stopping, 'exit')
    stopping.kill('SIGTERM')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { stopping.kill('SIGKILL'); reject(new Error('CLI-admin did not drain')) }, 5_000)
      })])
      assert.equal(result[0], expectedExitCode, diagnostics)
      child = undefined
    } finally { clearTimeout(timer) }
  }
  context.after(async () => {
    try { if (child) await shutdown() }
    finally {
      for (const socket of wire.clients) socket.terminate()
      upstream.closeAllConnections()
      await Promise.all([
        new Promise<void>(resolve => wire.close(() => resolve())),
        new Promise<void>(resolve => upstream.close(() => resolve()))
      ])
      await rm(directory, { recursive: true, force: true })
    }
  })
  async function api(path: string, body?: Value, expected: number | readonly number[] = 200) {
    const response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${adminToken}`, ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12_000) })
      .catch(error => { throw new Error(`CLI-admin fixture request failed: ${path}`, { cause: error }) })
    const result = object(await response.json())
    assert((typeof expected === 'number' ? [expected] : expected).includes(response.status), `${path}: ${response.status}: ${JSON.stringify(result)}`)
    return result
  }
  async function save(name: string, body: Value) {
    const previous = await api(`/api/chat/${name}`)
    return api(`/api/chat/${name}`, { revision: previous.revision, ...body })
  }
  const runtime = () => api('/api/chat/runtime')
  const start = async (expected = 200) => {
    try { return await api('/api/chat/runtime/start', { revisions: (await runtime()).revisions }, expected) }
    catch (error) {
      const state = await runtime()
      throw new Error(`CLI-native startup failed: ${JSON.stringify({ state: state.state, lastError: state.lastError,
        configurationIssues: state.configurationIssues, bootstrap: state.bootstrap })}`, { cause: error })
    }
  }
  function inbound(id: number, extra: Value = {}) {
    assert(onebots.size > 0)
    for (const socket of onebots) socket.send(JSON.stringify({ post_type: 'message', self_id: 999,
      message_type: 'private', user_id: 123, message_id: id, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'text', data: { text: `Fixture input ${id}` } }], ...extra }))
  }
  function event(type: string, data: Value, index = streams.length - 1) {
    const stream = streams[index]!
    const seq = sequences.get(stream.sessionId) ?? 0
    sequences.set(stream.sessionId, seq + 1)
    if (stream.socket.readyState === 1) stream.socket.send(JSON.stringify({ type: 'item', streamId: stream.streamId,
      value: { type: 'event', event: { type, data, seq } } }))
  }
  async function reply(content: string, index = streams.length - 1) {
    const stream = streams[index]!
    const ticket = plugin.queue(stream.sessionId, 'qaf_reply', { content })
    await awaitCondition(() => plugin.result(ticket) !== undefined, { message: 'Explicit reply tool did not settle', timeoutMs: 10_000 })
    return plugin.result(ticket)!
  }
  return { directory, configurationFile, bootstrapFile, lifecycleFile, profilePath, credentialsPath, base,
    calls, sends, sendActions, streams, selected, onebots, api, save, runtime, start, inbound, event, reply, launch, shutdown,
    controls: {
      get creates() { return creates },
      get loginRequests() { return loginRequests },
      get holdLogin() { return holdLogin }, set holdLogin(value: boolean) { holdLogin = value },
      get authFails() { return authFails }, set authFails(value: boolean) { authFails = value },
      get httpLoginStatus() { return httpLoginStatus }, set httpLoginStatus(value: string | null) { httpLoginStatus = value },
      get onebotSendStatus() { return onebotSendStatus }, set onebotSendStatus(value: string) { onebotSendStatus = value },
      get credentialSource() { return credentialSource }, set credentialSource(value: string) { credentialSource = value },
      get liveCredentialsPath() { return liveCredentialsPath }, set liveCredentialsPath(value: string) { liveCredentialsPath = value }
    }
  }
}
