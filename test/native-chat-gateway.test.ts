import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { WebSocketServer, type WebSocket } from 'ws'
import { parse, stringify } from 'yaml'
import { parseSessionSnapshot, parseUsageSnapshot } from '../web/lib/activity.ts'
import { parseUsageConversation, parseUsageRecent, parseUsageSeries } from '../web/lib/usage-details.ts'

type Value = Record<string, unknown>
const adminToken = 'local-admin-token-no-production-0123456789'

function object(value: unknown): Value {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Value
}

async function until(predicate: () => boolean | Promise<boolean>, milliseconds = 5_000) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(10)
  }
  assert.fail('Real CLI-admin local fixture did not settle')
}

test('CLI-admin subprocess default mount applies real fixture YAML then manually chats, records usage, restores and safely stops/times out',
  { timeout: 40_000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'native-cli-gateway-'))
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
    let holdLogin = false
    let loginRequests = 0
    let authFails = false
    let httpLoginStatus: string | null = 'ok'
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
        else {
          sends.push(object(JSON.parse(body)))
          response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 10_000 + sends.length } }))
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
      if (method === 'settings/describe') value = { namespaces: [{ ns: 'llm', value: providers.config },
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
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }))
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
          if (input.type === 'cancel') return
          const sessionId = String(object(object(object(object(input.payload).args).request).address).sessionId)
          streams.push({ socket: connection, streamId: String(input.streamId), sessionId })
          connection.send(JSON.stringify({ type: 'item', streamId: input.streamId, value: {
            type: 'snapshot', header: { id: sessionId }, cursor: (sequences.get(sessionId) ?? 0) - 1,
            records: [{ type: 'assistant/message', text: 'Old historical text never sent.' }]
          } }))
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
    async function launch() {
      child = spawn(process.execPath, ['scripts/gateway-admin.ts', '--config', configurationFile], {
        cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      child.stdout!.on('data', chunk => { output += String(chunk) })
      child.stderr!.on('data', chunk => { diagnostics += String(chunk) })
      await until(() => {
        const match = /listening on (http:\/\/127\.0\.0\.1:[0-9]+)/.exec(output)
        if (!match) return false
        origin = match[1]
        return true
      })
    }
    async function shutdown() {
      if (!child || child.exitCode !== null) return
      const stopping = child
      const exited = once(stopping, 'exit')
      stopping.kill('SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { stopping.kill('SIGKILL'); reject(new Error('CLI-admin did not drain')) }, 5_000)
        })])
        assert.equal(result[0], 0, diagnostics)
        child = undefined
      } finally { clearTimeout(timer) }
    }
    context.after(async () => {
      if (child) await shutdown()
      for (const socket of wire.clients) socket.terminate()
      await new Promise<void>(resolve => wire.close(() => resolve()))
      upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    })
    async function api(path: string, body?: Value, expected = 200) {
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${adminToken}`, ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12_000) })
        .catch(error => { throw new Error(`CLI-admin fixture request failed: ${path}`, { cause: error }) })
      const result = object(await response.json())
      assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`)
      return result
    }
    async function save(name: string, body: Value) {
      const previous = await api(`/api/chat/${name}`)
      return api(`/api/chat/${name}`, { revision: previous.revision, ...body })
    }
    const runtime = () => api('/api/chat/runtime')
    const start = async (expected = 200) => api('/api/chat/runtime/start', { revisions: (await runtime()).revisions }, expected)
    function inbound(id: number) {
      assert(onebots.size > 0)
      for (const socket of onebots) socket.send(JSON.stringify({ post_type: 'message', self_id: 999,
        message_type: 'private', user_id: 123, message_id: id, time: id + 1_000,
        message: [{ type: 'text', data: { text: `Fixture input ${id}` } }] }))
    }
    function event(type: string, data: Value) {
      const stream = streams.at(-1)!
      const seq = sequences.get(stream.sessionId) ?? 0
      sequences.set(stream.sessionId, seq + 1)
      if (stream.socket.readyState === 1) stream.socket.send(JSON.stringify({ type: 'item', streamId: stream.streamId,
        value: { type: 'event', event: { type, data, seq } } }))
    }
    await launch()
    assert.equal((await runtime()).state, 'stopped')
    assert.equal(onebots.size, 0)
    assert.equal(calls.length, 0)
    await save('personas', { personas: [{ id: 'native', name: 'Native', identity: 'Fixture identity.', style: 'Concise.' }] })
    await save('providers', { providers: [{ id: 'provider', name: 'Provider', enabled: true, type: 'openai',
      baseUrl: 'https://never-called.example.test', apiKey: 'private-provider-never-networked', models: [{ id: 'model', name: 'Model' }] }] })
    await save('plans', { activePlanId: 'daily', plans: [{ id: 'daily', name: 'Daily', description: '',
      instructions: 'Fixture instructions.', personaId: 'native', provider: 'provider', model: 'model', reasoningEffort: 'off',
      contextLimits: { group: 100_000, private: 120_000 } }] })
    await save('access', { allow: ['private:123'], deny: [], owner: '123' })
    await save('adapters', { adapters: {
      onebotHttp: { enabled: true, endpoint: `${base}/onebot`, secret: 'onebot-http-only' },
      onebotWs: { enabled: true, endpoint: `${base.replace('http:', 'ws:')}/onebot-ws`, secret: 'onebot-ws-only' },
      dshAgent: { enabled: true, endpoint: `${base}/dsh`, auth: 'dsh-fixture-only' }
    } })
    await save('authorization', { version: '1', grants: [{ conversationId: 'private:123', submitUses: 20, sendUses: 20, expiresAt: null }] })
    await save('deployment', { deployment: { target: { profilePath, credentialsPath, schemaVersion: '0.2.1-rc.2' },
      modelSettings: { contextWindow: 200_000, maxTokens: 8_000, reasoningEfforts: false }, namespace: 'fixture' } })
    const revisions = (await runtime()).revisions
    const prepared = await api('/api/chat/deployment/prepare', { revisions })
    assert.equal(prepared.state, 'prepared')
    assert.equal(typeof prepared.targetRevision, 'string')
    await api('/api/chat/deployment/apply', { revisions }, 400)
    const applied = await api('/api/chat/deployment/apply', { revisions, targetRevision: prepared.targetRevision })
    assert.equal(applied.state, 'verified')
    assert.equal((await runtime()).canStart, true)
    assert.equal(creates, 0)
    assert.equal(onebots.size, 0)
    for (const source of ['env', 'project-env', 'user-env', 'local-file']) {
      credentialSource = source
      await start(503)
      assert.equal((await runtime()).chatReady, false)
      assert.equal(creates, 0)
    }
    credentialSource = 'file'
    liveCredentialsPath = join(directory, 'different-credentials.yml')
    await start(503)
    assert.equal((await runtime()).chatReady, false)
    assert.equal(creates, 0)
    liveCredentialsPath = credentialsPath
    const stale = { ...object(revisions), access: '0'.repeat(64) }
    await api('/api/chat/runtime/start', { revisions: stale }, 409)
    assert.equal(onebots.size, 0)
    for (const status of [null, 'async', 'failed']) {
      httpLoginStatus = status
      await start(503)
      const refused = await runtime()
      assert.equal(refused.chatReady, false)
      assert.equal(refused.modelExecutionVerified, false)
      assert.equal(creates, 0)
      assert.deepEqual((await api('/api/host/sessions')).items, [])
    }
    httpLoginStatus = 'ok'
    const started = await start()
    assert.equal(started.chatReady, true)
    assert.equal(started.modelExecutionVerified, false)
    assert.equal(started.credentialValueIdentityVerified, false)
    await api('/api/chat/usage/pricing', { revision: null, prices: [{ provider: 'provider', model: 'model', currency: 'USD',
      inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1 }] })
    inbound(1)
    await until(() => calls.some(call => call.method === 'session/prompt'))
    assert.equal(creates, 1)
    const modelRoute = selected.get('native-session-1')!
    event('turn/start', { turn: 1 })
    event('assistant/message', { turn: 1, step: 1, message: { source: { kind: 'model', ...modelRoute },
      content: [{ type: 'text', text: 'Private work prefix.' }, { type: 'tool-call', name: 'not-run' }] },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 18 } })
    event('step/start', { turn: 1, step: 2 })
    event('assistant/message', { turn: 1, step: 2, message: { id: 'final-1', source: { kind: 'model', ...modelRoute },
      content: [{ type: 'text', text: 'Only this final answer.' }, { type: 'reasoning', text: 'Private reasoning.' }] },
      usage: { inputTokens: 20, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 0, totalTokens: 33 } })
    await delay(60)
    assert.equal(sends.length, 0)
    event('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await until(() => sends.length === 1)
    await until(async () => (await api('/api/chat/usage')).records === 2)
    const usage = await api('/api/chat/usage')
    assert(parseUsageSnapshot(usage), 'Actual native summary must parse in the complete usage UI')
    assert.equal(usage.native, true)
    assert.equal(usage.source, 'chat-ledger')
    assert.equal(object(usage.totals).totalTokens, 51)
    assert.equal(object(usage.totals).reasoningTokens, null)
    assert.equal(object(usage.tokens).total, 51)
    assert.equal(usage.costComplete, true)
    const fullRecent = await api('/api/chat/usage/recent?limit=40')
    assert(parseUsageRecent(fullRecent), 'Actual native recent entries must parse in the usage UI')
    assert.equal(fullRecent.partial, false)
    assert.equal((await api('/api/chat/usage/series?bucketMs=60000')).partial, false)
    const fullSeries = await api('/api/chat/usage/series?hours=24&buckets=48')
    assert(parseUsageSeries(fullSeries), 'Actual native chart must parse in the complete usage UI')
    assert.equal(fullSeries.native, true)
    assert.equal((fullSeries.buckets as unknown[]).length, 48)
    assert.equal(object(fullSeries.totals).tokens, 51)
    const detail = await api('/api/chat/usage/turns?key=private%3A123&limit=200')
    assert(parseUsageConversation(detail, 'private:123'), 'Actual native per-turn detail must parse in the usage UI')
    assert.equal(detail.native, true)
    assert.equal((detail.turns as unknown[]).length, 1)
    const prices = await api('/api/chat/usage/pricing')
    await api('/api/chat/usage/pricing', { revision: null, prices: [] }, 409)
    await api('/api/chat/usage/pricing', { revision: prices.revision, prices: [] })
    assert.equal(object((await api('/api/chat/usage')).totals).cost, object(usage.totals).cost)
    assert(!JSON.stringify(sends).includes('prefix'))
    assert(!JSON.stringify(sends).includes('reasoning'))
    const sessions = await api('/api/chat/sessions')
    assert(parseSessionSnapshot(sessions), 'Actual durable sessions must parse in the sessions UI')
    await shutdown()
    await launch()
    assert.equal((await runtime()).chatReady, false)
    assert.equal(onebots.size, 0)
    await start()
    assert.deepEqual((await api('/api/chat/sessions')).items, sessions.items)
    assert.equal((await api('/api/chat/usage')).records, 2)
    assert.equal(sends.length, 1)
    inbound(1)
    await delay(60)
    assert.equal(calls.filter(call => call.method === 'session/prompt').length, 1)
    const oldStream = streams.at(-1)!
    oldStream.socket.close()
    await until(async () => object((await runtime()).host).unhealthyFollows === 1)
    inbound(2)
    await until(() => calls.filter(call => call.method === 'session/prompt').length === 2)
    assert.notEqual(streams.at(-1), oldStream)
    assert.equal(creates, 1)
    assert.equal((await api('/api/chat/usage')).records, 2)
    await until(async () => (await runtime()).chatReady === true)
    await api('/api/chat/runtime/stop', {})
    holdLogin = true
    const previousLogins = loginRequests
    const starting = start(503)
    await until(() => loginRequests > previousLogins)
    await Promise.all([api('/api/chat/runtime/stop', {}), api('/api/chat/runtime/stop', {})])
    await starting
    assert.equal((await runtime()).state, 'stopped')
    assert.equal(sends.length, 1)
    const timeoutStart = await start(503)
    assert.equal(timeoutStart.error, 'native_chat_start_failed')
    assert.equal((await runtime()).chatReady, false)
    assert.equal(onebots.size, 0)
    holdLogin = false
    authFails = true
    await start(503)
    assert.equal((await runtime()).chatReady, false)
    assert.equal(creates, 1)
    assert(!JSON.stringify(await runtime()).includes('private-provider-never-networked'))
  })
