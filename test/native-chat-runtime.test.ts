import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { WebSocketServer, type WebSocket } from 'ws'

import { createNativeRuntimeRoutes, readNativeChatConfiguration } from '../src/admin/runtime.ts'
import type { AdminRoute } from '../src/admin/server.ts'
import { buildChatSessionDefinition } from '../src/host/chat-plans.ts'
import { createNativeChatRuntime } from '../src/host/native-chat-runtime.ts'
import { bindSyntheticPaginationSessions } from './fixtures/native-session-pages.ts'

const persona = { id: 'native', name: 'Native', identity: 'A test-only identity.', style: 'Concise.' }
const plan = { id: 'daily', name: 'Daily', description: '', instructions: 'Test behavior.',
  personaId: 'native', provider: 'provider', model: 'model', reasoningEffort: 'off' as const,
  contextLimits: { group: 100_000, private: 120_000 } }

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) return
    await delay(5)
  }
  assert.fail('Local pipeline condition did not settle')
}

async function invoke(routes: readonly AdminRoute[], method: 'GET' | 'POST', pathname: string,
  body: Record<string, unknown> | null = null, query = new URLSearchParams()): Promise<Record<string, unknown>> {
  const route = routes.find(value => value.method === method && value.pathname === pathname)
  assert(route)
  const result = await route.handle({ body, query, signal: new AbortController().signal })
  assert(result !== null && typeof result === 'object' && !Array.isArray(result))
  return result as Record<string, unknown>
}

async function fixture(context: TestContext, options: {
  authFails?: boolean
  wrongHttpIdentity?: boolean
  unknownSend?: boolean
  holdCreate?: boolean
  uses?: number
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'native-chat-pipeline-'))
  const wire = new WebSocketServer({ noServer: true })
  const onebots = new Set<WebSocket>()
  const follows: Array<{ socket: WebSocket; id: string; sequence: number }> = []
  const rpc: Array<{ method: string; request: Record<string, unknown> }> = []
  const sends: Record<string, unknown>[] = []
  let creates = 0
  let heldCreate: { response: ServerResponse; rpcId: string } | undefined
  let httpReads = 0
  let exchanges = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://local.test')
    if (url.pathname.startsWith('/onebot/')) {
      assert.equal(request.headers.authorization, 'Bearer http-test-secret')
      let body = ''
      for await (const chunk of request) body += String(chunk)
      if (url.pathname === '/onebot/get_login_info') {
        httpReads++
        response.end(JSON.stringify({ status: 'ok', retcode: 0,
          data: { user_id: options.wrongHttpIdentity ? 998 : 999 } }))
      } else {
        sends.push(JSON.parse(body) as Record<string, unknown>)
        if (options.unknownSend) { response.destroy(); return }
        response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1000 + sends.length } }))
      }
      return
    }
    if (url.pathname === '/dsh/connect') {
      exchanges++
      assert.equal(url.searchParams.get('token'), 'dsh-test-secret')
      if (options.authFails) { response.writeHead(401).end(); return }
      response.writeHead(302, { location: './api/remote.mux', 'set-cookie': 'dsh_test=local.test; HttpOnly' }).end()
      return
    }
    assert.equal(request.headers.cookie, 'dsh_test=local.test')
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const envelope = JSON.parse(body) as { rpcId: string; method: string; payload: { args: { request?: Record<string, unknown> } } }
    const input = envelope.payload.args.request ?? {}
    rpc.push({ method: envelope.method, request: input })
    let value: unknown = {}
    if (envelope.method === 'session/create') {
      creates++
      if (options.holdCreate) { heldCreate = { response, rpcId: envelope.rpcId }; return }
      value = { sessionId: `session-${creates}`, agentPreset: 'test-native-chat' }
    } else if (envelope.method === 'session/selectModel') {
      value = { selected: { provider: 'external-provider', model: 'model', reasoningEffort: 'off' } }
    } else if (envelope.method === 'session/prompt') {
      value = { accepted: true }
    }
    response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }))
  })
  server.on('upgrade', (request, socket, head) => {
    wire.handleUpgrade(request, socket, head, connection => {
      if (request.url === '/onebot-ws') {
        assert.equal(request.headers.authorization, 'Bearer ws-test-secret')
        onebots.add(connection)
        connection.once('close', () => onebots.delete(connection))
        connection.on('message', data => {
          const action = JSON.parse(data.toString()) as { action: string; echo: string }
          assert.equal(action.action, 'get_login_info')
          connection.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo, data: { user_id: 999 } }))
        })
        return
      }
      assert.equal(request.url, '/dsh/api/remote.mux')
      assert.equal(request.headers.cookie, 'dsh_test=local.test')
      connection.on('message', data => {
        const input = JSON.parse(data.toString()) as { type: string; streamId: string; payload: { args: { request: { address: { sessionId: string } } } } }
        if (input.type === 'cancel') return
        const stream = { socket: connection, id: input.streamId, sequence: 0 }
        follows.push(stream)
        connection.send(JSON.stringify({ type: 'item', streamId: input.streamId,
          value: { type: 'snapshot', header: { id: input.payload.args.request.address.sessionId }, cursor: -1,
            records: [{ type: 'assistant/message', text: 'Historical output must not be replayed.' }] } }))
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const createRuntime = () => createNativeChatRuntime({ directory,
    loadConfiguration: () => readNativeChatConfiguration(directory),
    resolveDeployment: async configuration => {
      const selectedPlan = configuration.catalog.plans.find(value => value.id === configuration.catalog.activePlanId)!
      const selectedPersona = configuration.personas.find(value => value.id === selectedPlan?.personaId)!
      return { missingReasons: [], presetBindings: selectedPlan && selectedPersona ? [{ agentPreset: 'test-native-chat',
        externalProvider: 'external-provider', definition: buildChatSessionDefinition(selectedPlan, selectedPersona) }] : [] }
    } })
  let runtime = createRuntime()
  const routes = () => createNativeRuntimeRoutes({ directory, chatRuntime: runtime, adapterRuntime: runtime.adapterRuntime })
  const save = async (name: string, value: Record<string, unknown>) => {
    const current = await invoke(routes(), 'GET', `/api/chat/${name}`)
    return invoke(routes(), 'POST', `/api/chat/${name}`, { revision: current.revision, ...value })
  }
  const configure = async () => {
    await save('personas', { personas: [persona] })
    await save('providers', { providers: [{ id: 'provider', name: 'Provider', type: 'openai', enabled: true,
      baseUrl: 'https://model.example.test', apiKey: 'never-called-model-key', models: [{ id: 'model', name: 'Model' }] }] })
    await save('plans', { activePlanId: 'daily', plans: [plan] })
    await save('access', { allow: ['private:123', 'group:456'], deny: [], owner: '123' })
    await save('adapters', { adapters: {
      onebotHttp: { enabled: true, endpoint: `${base}/onebot`, secret: 'http-test-secret' },
      onebotWs: { enabled: true, endpoint: `${base.replace('http:', 'ws:')}/onebot-ws`, secret: 'ws-test-secret' },
      dshAgent: { enabled: true, endpoint: `${base}/dsh`, auth: 'dsh-test-secret' }
    } })
    await save('authorization', { version: '1', grants: ['private:123', 'group:456'].map(conversationId => ({
      conversationId, submitUses: options.uses ?? 10, sendUses: options.uses ?? 10, expiresAt: null
    })) })
  }
  const start = async () => {
    const configuration = await readNativeChatConfiguration(directory)
    await runtime.start(configuration.revisions, new AbortController().signal)
  }
  const message = (id: number, extra: Record<string, unknown> = {}) => {
    assert(onebots.size > 0)
    for (const socket of onebots) socket.send(JSON.stringify({ post_type: 'message', self_id: 999,
      message_type: 'private', user_id: 123, message_id: id, time: 1_000 + id,
      message: [{ type: 'text', data: { text: `User message ${id}` } }], ...extra }))
  }
  const agentEvent = (type: string, data: Record<string, unknown>, index = follows.length - 1) => {
    const stream = follows[index]
    assert(stream)
    if (stream.socket.readyState !== 1) return
    stream.socket.send(JSON.stringify({ type: 'item', streamId: stream.id,
      value: { type: 'event', event: { seq: stream.sequence++, type, data } } }))
  }
  const answer = (turn = 1) => {
    agentEvent('assistant/message', { turn, message: { id: `answer-${turn}`, role: 'assistant',
      content: [{ type: 'text', text: `Final answer ${turn}` }, { type: 'reasoning', text: 'Not public.' }] } })
    agentEvent('turn/end', { turn, reason: { kind: 'completed' } })
  }
  context.after(async () => {
    await runtime.close()
    for (const socket of wire.clients) socket.terminate()
    await new Promise<void>(resolve => wire.close(() => resolve()))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, configure, save, start, message, agentEvent, answer, routes, rpc, sends, follows,
    runtime: () => runtime, creates: () => creates, httpReads: () => httpReads, exchanges: () => exchanges,
    heldCreate: () => heldCreate,
    async restart() { await runtime.close(); runtime = createRuntime(); await start() } }
}

test('native composition stays offline until manual start and reports layered missing reasons', async context => {
  const fake = await fixture(context)
  const initial = await fake.runtime().status()
  assert.equal(initial.chatReady, false)
  assert(initial.missingReasons.includes('active_plan_or_persona_missing'))
  assert.equal(fake.httpReads(), 0)
  assert.equal(fake.exchanges(), 0)
  await fake.configure()
  assert.equal((await fake.runtime().status()).chatReady, false)
  assert.equal(fake.rpc.length, 0)
  const stale = { ...(await readNativeChatConfiguration(fake.directory)).revisions, plans: '0'.repeat(64) }
  await assert.rejects(fake.runtime().start(stale, new AbortController().signal), { code: 'NATIVE_CHAT_REVISION_CONFLICT' })
  assert.equal(fake.exchanges(), 0)
  assert.equal(fake.creates(), 0)
  assert.throws(() => createNativeRuntimeRoutes({ directory: fake.directory,
    chatRuntime: { status: () => ({ chatReady: true }) } as unknown as ReturnType<typeof createNativeChatRuntime> }), TypeError)
})

test('real local WS text passes through native host/DSH/policy/durable outbox to confirmed QQ HTTP send', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.start()
  assert.equal((await fake.runtime().status()).chatReady, true)
  const adapters = await invoke(fake.routes(), 'GET', '/api/chat/adapters')
  assert.equal((adapters.connection as Record<string, unknown>).chatReady, true)
  assert.equal((adapters.connection as Record<string, unknown>).state, 'connected')
  assert.equal((adapters.connection as Record<string, unknown>).selfId, '999')
  const unrelated = createNativeRuntimeRoutes({ directory: fake.directory, chatRuntime: fake.runtime(),
    adapterRuntime: { status: () => ({ running: false }), connectionStatus: () => ({ state: 'connected',
      selfId: '999', lastError: null, received: 0, dropped: 0, chatReady: true }) } })
  await assert.rejects(invoke(unrelated, 'GET', '/api/chat/adapters'), { statusCode: 503, code: 'adapter_runtime_status_unavailable' })
  assert.deepEqual(fake.rpc.map(request => request.method), ['settings/describe'])
  await assert.rejects(fake.runtime().adapterRuntime.disconnect!(), { code: 'NATIVE_CHAT_BUSY' })
  fake.message(1)
  await until(() => fake.rpc.some(request => request.method === 'session/prompt'))
  assert.deepEqual(fake.rpc.find(request => request.method === 'session/create')?.request, { agentPreset: 'test-native-chat' })
  assert.equal(fake.rpc.find(request => request.method === 'session/selectModel')?.request.provider, 'external-provider')
  fake.agentEvent('assistant/message', { turn: 1, message: { id: 'prefix', content: [{ type: 'text', text: 'Tool narration.' }] } })
  fake.agentEvent('step/start', { turn: 1 })
  await delay(35)
  assert.equal(fake.sends.length, 0)
  fake.answer()
  await until(() => fake.sends.length === 1)
  await until(() => fake.runtime().host()!.outbox.list()[0]?.status === 'confirmed')
  assert.deepEqual(fake.sends[0], { user_id: 123, message: [{ type: 'text', data: { text: 'Final answer 1' } }] })
  const host = fake.runtime().host()!
  assert.equal(host.history.snapshot('private:123').messages.length, 2)
  assert.equal(host.policy.describe().grants.find(grant => grant.conversationId === 'private:123')?.used['agent.submit'], 1)
  const sessions = await invoke(fake.routes(), 'GET', '/api/chat/sessions')
  assert.equal((sessions.items as unknown[]).length, 1)
  const usage = await invoke(fake.routes(), 'GET', '/api/chat/usage')
  assert.equal(usage.tokenUsageAvailable, false)
  assert.equal(usage.source, 'chat-ledger')
  const metrics = await invoke(fake.routes(), 'GET', '/api/host/metrics')
  assert.equal(metrics.started, true)
  fake.message(1)
  await delay(50)
  assert.equal(fake.rpc.filter(request => request.method === 'session/prompt').length, 1)
})

test('access deny and forged WS identities never create agent sessions; self mentions map automatically', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.save('access', { allow: ['group:456'], deny: ['private:123'], owner: '123' })
  await fake.start()
  fake.message(1)
  fake.message(2, { self_id: 100 })
  await delay(50)
  assert.equal(fake.creates(), 0)
  fake.message(3, { message_type: 'group', group_id: 456,
    message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: 'Directed group message' } }] })
  await until(() => fake.rpc.some(request => request.method === 'session/prompt'))
  assert.deepEqual(fake.rpc.find(request => request.method === 'session/prompt')?.request.content,
    [{ type: 'text', text: 'Directed group message' }])
})

test('allow and owner do not grant effects; configuration changes fail closed without clearing sessions', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.save('authorization', { version: '1', grants: [] })
  await assert.rejects(fake.start(), { code: 'NATIVE_CHAT_CONFIGURATION_INCOMPLETE' })
  assert.equal(fake.creates(), 0)
  await fake.save('authorization', { version: '2', grants: [
    { conversationId: 'private:123', submitUses: 2, sendUses: 2, expiresAt: null }
  ] })
  await fake.start()
  fake.message(1)
  await until(() => fake.creates() === 1 && fake.follows.length === 1)
  await fake.save('access', { allow: [], deny: [], owner: '123' })
  assert.equal((await fake.runtime().status()).chatReady, false)
  fake.answer()
  fake.message(2)
  await delay(70)
  assert.equal(fake.sends.length, 0)
  assert.equal(fake.creates(), 1)
  assert.equal(fake.runtime().host()!.sessions.list().length, 1)
})

test('failed DSH authentication and HTTP identity mismatch never report chat ready or create sessions', async context => {
  for (const options of [{ authFails: true }, { wrongHttpIdentity: true }]) {
    const fake = await fixture(context, options)
    await fake.configure()
    await assert.rejects(fake.start())
    const status = await fake.runtime().status()
    assert.equal(status.chatReady, false)
    assert.equal(status.protocolConnected, false)
    assert.equal(status.state, 'error')
    assert.equal(fake.creates(), 0)
    assert(!JSON.stringify(status).includes('dsh-test-secret'))
  }
})

test('restart preserves sessions, history, exhausted budgets and unknown outbox without replay or refilling', async context => {
  const fake = await fixture(context, { unknownSend: true, uses: 1 })
  await fake.configure()
  await fake.start()
  fake.message(1)
  await until(() => fake.rpc.some(request => request.method === 'session/prompt'))
  fake.answer()
  await until(() => fake.runtime().host()!.outbox.list()[0]?.status === 'unknown')
  const before = fake.runtime().host()!.sessions.list()[0]
  assert.equal(fake.sends.length, 1)
  await fake.restart()
  assert.deepEqual(fake.runtime().host()!.sessions.list()[0], before)
  assert.equal(fake.runtime().host()!.outbox.list()[0]?.status, 'unknown')
  assert.equal(fake.runtime().host()!.history.snapshot('private:123').messages.length, 1)
  fake.message(1)
  fake.message(2)
  await delay(80)
  assert.equal(fake.rpc.filter(request => request.method === 'session/prompt').length, 1)
  assert.equal(fake.sends.length, 1)
  assert.equal(fake.creates(), 1)
  await fake.runtime().stop()
  await fake.save('authorization', { version: '1', grants: ['private:123', 'group:456'].map(conversationId => ({
    conversationId, submitUses: 2, sendUses: 2, expiresAt: null
  })) })
  await assert.rejects(fake.start(), { code: 'NATIVE_CHAT_AUTHORIZATION_VERSION_CONFLICT' })
})

test('stop cancels in-flight creation, ignores late response and restart never retries unknown session creation', async context => {
  const fake = await fixture(context, { holdCreate: true })
  await fake.configure()
  await fake.start()
  fake.message(1)
  await until(() => fake.heldCreate() !== undefined)
  const held = fake.heldCreate()!
  await fake.runtime().stop()
  held.response.end(JSON.stringify({ type: 'server-response', rpcId: held.rpcId,
    result: { ok: true, value: { sessionId: 'late-session', agentPreset: 'test-native-chat' } } }))
  assert.equal(fake.runtime().host()!.sessions.list()[0]?.state, 'unknown')
  assert.equal((await fake.runtime().status()).chatReady, false)
  await fake.restart()
  fake.message(2)
  await delay(70)
  assert.equal(fake.creates(), 1)
  assert.equal(fake.runtime().host()!.sessions.list()[0]?.state, 'unknown')
  assert.equal(fake.sends.length, 0)
})

test('changed plan cannot silently reuse or reset durable agent sessions', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.start()
  fake.message(1)
  await until(() => fake.rpc.some(request => request.method === 'session/prompt'))
  await fake.runtime().stop()
  await fake.save('plans', { activePlanId: 'daily', plans: [{ ...plan, instructions: 'New behavior.' }] })
  await assert.rejects(fake.start(), { code: 'NATIVE_CHAT_SESSION_CONFIGURATION_CONFLICT' })
  assert.equal(fake.creates(), 1)
  assert.equal(fake.runtime().host()!.sessions.list()[0]?.sessionId, 'session-1')
})

test('imported catalog identifiers remain unchanged while private core persona mapping runs the real pipeline', async context => {
  const fake = await fixture(context)
  await fake.configure()
  const imported = { ...persona, id: 'Legacy:Whale_v1' }
  await fake.save('personas', { personas: [persona, imported] })
  await fake.save('plans', { activePlanId: 'PLAN:Chat_v1', plans: [{ ...plan, id: 'PLAN:Chat_v1', personaId: imported.id }] })
  await fake.start()
  fake.message(1)
  await until(() => fake.rpc.some(request => request.method === 'session/prompt'))
  fake.answer()
  await until(() => fake.runtime().host()!.outbox.list()[0]?.status === 'confirmed')
  const configuration = await readNativeChatConfiguration(fake.directory)
  assert.equal(configuration.catalog.activePlanId, 'PLAN:Chat_v1')
  assert(configuration.personas.some(value => value.id === imported.id))
  assert.equal(fake.creates(), 1)
})

test('real native session metadata reaches page 101+ with stable exclusive cursors and reset disabled', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.start()
  const fixtureData = bindSyntheticPaginationSessions(fake.runtime().host()!)
  const keys: string[] = []
  let after: string | null = null
  const pageSizes: number[] = []
  do {
    const query = new URLSearchParams({ limit: '100', ...(after === null ? {} : { after }) })
    const page = await invoke(fake.routes(), 'GET', '/api/chat/sessions', null, query)
    assert.equal(page.resetAvailable, false)
    assert.match(String(page.revision), /^[a-f0-9]{64}$/)
    const sessions = page.sessions as Array<{ key: string; sessionId: string; owner: boolean }>
    pageSizes.push(sessions.length)
    keys.push(...sessions.map(session => session.key))
    after = page.next as string | null
  } while (after !== null)
  assert.deepEqual(pageSizes, [100, 100, 5])
  assert.deepEqual(keys, fixtureData.conversationIds)
  assert.equal(new Set(keys).size, fixtureData.count)
  const large = await invoke(fake.routes(), 'GET', '/api/chat/sessions', null, new URLSearchParams({ limit: '1000' }))
  assert.equal((large.items as unknown[]).length, 205)
  await assert.rejects(invoke(fake.routes(), 'POST', '/api/chat/sessions/reset', {}),
    error => error !== null && typeof error === 'object' && 'code' in error && error.code === 'session_reset_not_enabled')
  assert.equal(fake.runtime().host()!.sessions.list({ limit: 1_000 }).length, 205)
  assert.equal(fake.creates(), 0)
  assert.equal(fake.sends.length, 0)
})
