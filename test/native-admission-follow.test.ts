import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { WebSocketServer, type WebSocket } from 'ws'
import { createNativeChatRuntime } from '../src/host/native-chat-runtime.ts'
import { DEFAULT_NATIVE_EXECUTION_POLICY } from '../src/host/native-execution.ts'
import { buildChatSessionDefinition } from '../src/host/chat-plans.ts'
import type { NativeChatConfiguration } from '../src/host/native-chat-configuration.ts'
import { digest } from '../src/host/data.ts'
import { createClaimReceiptJournal } from '../packages/dsh-bridge-plugin/src/receipts.ts'
import { createDshClaimPluginFixture } from './fixtures/dsh-claim-plugin.ts'
import { handleDshControlFrame } from './fixtures/dsh-wire.ts'
import { awaitCondition } from './fixtures/await-condition.ts'

function value(input: unknown): Record<string, unknown> {
  assert(input !== null && typeof input === 'object' && !Array.isArray(input))
  return input as Record<string, unknown>
}
async function until(predicate: () => boolean | Promise<boolean>, timeout = 4000) {
  await awaitCondition(predicate, { message: 'PROBE_CONDITION_TIMEOUT', timeoutMs: timeout, intervalMs: 5 })
}

const persona = { id: 'review', name: 'Review', identity: 'Offline review persona.', style: 'Brief.' }
const plan = { id: 'review-plan', name: 'Review plan', description: '', instructions: 'Offline only.',
  personaId: 'review', provider: 'local', model: 'offline', reasoningEffort: 'off' as const }
type Stream = { socket: WebSocket; streamId: string; sequence: number; sessionId: string }
type Call = { method: string; input: Record<string, unknown>; at: number }

async function fixture(name: string, settings: { turnTimeoutMs?: number; createDelayMs?: number; cancelUses?: number; cancelMode?: 'accepted' | 'unknown'; noticeEnabled?: boolean; conversations?: number } = {}) {
  const directory = await mkdtemp(join(process.env.NATIVE_REPAIR_EVIDENCE_DIR ?? tmpdir(), `${name}-`))
  const wire = new WebSocketServer({ noServer: true })
  const bots = new Set<WebSocket>()
  const streams = new Map<string, Stream>()
  const calls: Call[] = []
  const sends: { input: Record<string, unknown>; at: number }[] = []
  let journal = createClaimReceiptJournal()
  const plugin = createDshClaimPluginFixture(() => journal)
  let creates = 0
  let suppressClaims = false
  let sendDelayMs = 0
  let correlationReadDelayMs = 0
  let loadingDelayMs = 0
  let delayedLoadingReads = 0
  let baselineDelayMs = 0
  let claimFault: 'none' | 'auth' = 'none'
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, 'http://localhost').pathname
    if (pathname === '/dsh/connect') {
      const query = new URL(request.url!, 'http://localhost').searchParams
      assert.equal(query.get('token'), 'review-owner-token')
      assert(['none', 'answer'].includes(query.get('interactions')!))
      response.writeHead(302, { 'set-cookie': 'review=offline; Path=/; HttpOnly', location: '/dsh/api/remote.mux' }).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += String(chunk)
    if (pathname.startsWith('/onebot/')) {
      if (pathname.endsWith('get_login_info')) response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 999 } }))
      else if (pathname.endsWith('get_version_info')) response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { app_name: 'SyntheticOneBot' } }))
      else {
        sends.push({ input: value(JSON.parse(body)), at: Date.now() })
        if (sendDelayMs) await delay(sendDelayMs)
        response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 10000 + sends.length } }))
      }
      return
    }
    assert.equal(request.headers.cookie, 'review=offline')
    const envelope = value(JSON.parse(body))
    const args = value(value(envelope.payload).args)
    const input = args.request === undefined ? args : value(args.request)
    const method = String(envelope.method)
    calls.push({ method, input, at: Date.now() })
    let result: unknown = {}
    if (method === 'bridgePlugin/describe') result = plugin.invoke(method, input)
    else if (method === 'bridgePlugin/claimReceipts') {
      if (claimFault === 'auth') { response.writeHead(403).end(); return }
      if (input.after !== undefined && correlationReadDelayMs) await delay(correlationReadDelayMs)
      if (input.after === undefined && baselineDelayMs) await delay(baselineDelayMs)
      result = journal.read({ sessionId: String(input.sessionId), issuerEpoch: String(input.issuerEpoch),
        ...(input.after === undefined ? {} : { after: Number(input.after) }), limit: Number(input.limit) })
    } else if (method.startsWith('bridgePlugin/')) result = plugin.invoke(method, input)
    else if (method === 'session/modelCatalog') result = { default: { provider: 'local', model: 'offline' },
      routableProviders: ['local'], groups: [{ id: 'local', name: 'Local', models: [{ id: 'offline', name: 'Offline' }] }], failures: [] }
    else if (method === 'session/create') {
      creates++
      const sessionId = `review-session-${creates}`
      if (settings.createDelayMs) await delay(settings.createDelayMs)
      result = { sessionId, agentPreset: 'review-preset' }
    } else if (method === 'session/selectModel') result = { selected: { provider: input.provider, model: input.model } }
    else if (method === 'session/prompt') {
      if (!suppressClaims) plugin.accepted(String(input.sessionId), String(input.requestId))
      result = { accepted: true }
    } else if (method === 'session/cancel') {
      if (settings.cancelMode === 'unknown') { response.destroy(); return }
      result = { accepted: true }
    }
    response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: result } }))
  })
  server.on('upgrade', (request, socket, head) => wire.handleUpgrade(request, socket, head, connection => {
    if (request.url === '/onebot-ws') {
      bots.add(connection)
      connection.once('close', () => bots.delete(connection))
      connection.on('message', raw => {
        const action = value(JSON.parse(raw.toString()))
        connection.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo, data: { user_id: 999 } }))
      })
    } else {
      connection.on('message', raw => {
        const envelope = value(JSON.parse(raw.toString()))
        if (handleDshControlFrame(connection, envelope)) return
        if (envelope.type !== 'open') return
        const sessionId = String(value(value(value(value(envelope.payload).args).request).address).sessionId)
        const stream = { socket: connection, streamId: String(envelope.streamId), sequence: streams.get(sessionId)?.sequence ?? 0, sessionId }
        streams.set(sessionId, stream)
        connection.send(JSON.stringify({ type: 'item', streamId: stream.streamId,
          value: { type: 'snapshot', header: { id: sessionId }, cursor: stream.sequence - 1, records: [] } }))
      })
    }
  }))
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  let configuration: NativeChatConfiguration = {
    revisions: Object.fromEntries(['plans', 'personas', 'access', 'adapters', 'providers', 'authorization', 'deployment', 'execution'].map(key => [key, digest(key)])),
    personas: [persona], catalog: { activePlanId: plan.id, plans: [plan] },
    access: { allow: Array.from({ length: settings.conversations ?? 3 }, (_unused, index) => `private:${123 + index}`), deny: [], owner: null },
    authorization: { version: 'review-1', grants: Array.from({ length: settings.conversations ?? 3 }, (_unused, index) => `private:${123 + index}`).map(conversationId => ({ conversationId,
      submitUses: 100, sendUses: 100, cancelUses: settings.cancelUses ?? 0, expiresAt: null })) },
    providers: [{ id: 'local', name: 'Local', type: 'openai', baseUrl: 'https://never-called.example.test', apiKey: 'offline-placeholder', enabled: true,
      models: [{ id: 'offline', name: 'Offline' }] }],
    adapters: { onebotHttp: { enabled: true, endpoint: `${base}/onebot`, secret: '' },
      onebotWs: { enabled: true, endpoint: base.replace('http:', 'ws:') + '/onebot-ws', secret: '' },
      dshAgent: { enabled: true, endpoint: `${base}/dsh`, auth: 'review-owner-token' },
      onebotWebhook: { enabled: false, host: '127.0.0.1', port: 0, selfId: '', hmac: '' } },
    deployment: { target: null, modelSettings: null, namespace: 'review' },
    execution: { ...DEFAULT_NATIVE_EXECUTION_POLICY, ...(settings.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: settings.turnTimeoutMs }),
      noticeEnabled: settings.noticeEnabled ?? true }
  }
  const runtime = createNativeChatRuntime({ directory, async loadConfiguration() {
    if (loadingDelayMs) { delayedLoadingReads++; await delay(loadingDelayMs) }
    return configuration
  }, resolveDeployment: async current => ({ missingReasons: [],
    presetBindings: [{ agentPreset: 'review-preset', definition: buildChatSessionDefinition(current.catalog.plans[0]!, current.personas[0]!) }] }) })
  function inbound(id: number, user = 123) {
    const at = Date.now()
    for (const socket of bots) socket.send(JSON.stringify({ post_type: 'message', self_id: 999, message_type: 'private', user_id: user,
      message_id: id, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: `offline input ${id}` } }] }))
    return at
  }
  function event(sessionId: string, type: string, data: Record<string, unknown>, gap = false) {
    const stream = streams.get(sessionId)
    assert(stream)
    if (gap) stream.sequence++
    stream.socket.send(JSON.stringify({ type: 'item', streamId: stream.streamId,
      value: { type: 'event', event: { seq: stream.sequence++, type, data } } }))
  }
  async function answer(sessionId: string, turn = 1, send = true) {
    const completedBefore = runtime.executions()?.list().filter(row => row.binding.sessionId === sessionId && row.status === 'completed').length ?? 0
    if (send) {
    const ticket = plugin.queue(sessionId, 'qbf_reply', { content: 'offline final' })
    await until(() => plugin.result(ticket) !== undefined)
    assert.equal(plugin.result(ticket)?.status, 'confirmed')
    }
    event(sessionId, 'assistant/message', { turn, message: { id: `answer-${turn}`, role: 'assistant', content: [{ type: 'text', text: 'offline final' }] } })
    event(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } })
    if (send) await until(() => (runtime.executions()?.list().filter(row => row.binding.sessionId === sessionId && row.status === 'completed').length ?? 0) > completedBefore)
  }
  async function start() {
    try { await runtime.start(configuration.revisions, new AbortController().signal) }
    catch (error) {
      const status = await runtime.status()
      throw new Error(`Synthetic native start failed: ${JSON.stringify({ state: status.state, lastError: status.lastError, missingReasons: status.missingReasons })}`, { cause: error })
    }
  }
  async function close() {
    loadingDelayMs = 0
    await runtime.close()
    for (const socket of wire.clients) socket.terminate()
    await new Promise<void>(resolveClose => wire.close(() => resolveClose()))
    server.closeAllConnections()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    if (!process.env.NATIVE_REPAIR_EVIDENCE_DIR) await rm(directory, { recursive: true, force: true })
  }
  return { directory, runtime: { ...runtime, executionJournal: () => runtime.executions()?.list() }, get configuration() { return configuration }, calls, sends, streams, start, inbound, event, answer, close,
    controls: {
      configuration(input: NativeChatConfiguration) { configuration = input },
      set suppressClaims(input: boolean) { suppressClaims = input },
      set sendDelayMs(input: number) { sendDelayMs = input },
      set correlationReadDelayMs(input: number) { correlationReadDelayMs = input },
      set loadingDelayMs(input: number) { loadingDelayMs = input },
      get delayedLoadingReads() { return delayedLoadingReads },
      set baselineDelayMs(input: number) { baselineDelayMs = input },
      set claimFault(input: 'none' | 'auth') { claimFault = input },
      evictReceiptWindow() {
        for (let index = 0; index < 4100; index++) journal.record({ sessionId: 'other-session', requestId: `other-request-${index}`,
          userMessageId: `other-user-${index}`, turn: index })
      },
      restartJournal() { journal = createClaimReceiptJournal() }
    } }
}

function storedRows(directory: string, namespace: string) {
  const database = new DatabaseSync(join(directory, 'native-chat.sqlite'), { readOnly: true })
  try {
    return database.prepare('SELECT key, value FROM durable_records WHERE namespace = ? ORDER BY key').all(namespace)
      .map(row => ({ key: String(row.key), value: value(JSON.parse(String(row.value))) }))
  } finally { database.close() }
}

test('native ingress expires in FIFO and late authorization cannot create or prompt', async context => {
  const fake = await fixture('native-queued-expiry', { turnTimeoutMs: 600, noticeEnabled: false })
  context.after(fake.close)
  await fake.start()
  fake.controls.loadingDelayMs = 900
  const arrivedAt = [fake.inbound(1), fake.inbound(2, 124)]
  await until(() => fake.controls.delayedLoadingReads > 0)
  fake.controls.loadingDelayMs = 0
  await until(async () => (await fake.runtime.status()).ingress.received === 2).catch(async error => { throw new Error(JSON.stringify(await fake.runtime.status()), { cause: error }) })
  await delay(1000)
  assert.equal(fake.calls.filter(call => call.method === 'session/create').length, 0)
  assert.equal(fake.calls.filter(call => call.method === 'session/prompt').length, 0)
  assert.equal(storedRows(fake.directory, 'host.sessions').length, 0)
  assert.equal(fake.runtime.executionJournal()!.length, 0)
  const status = await fake.runtime.status()
  assert(status.ingress.queue)
  assert.equal(status.ingress.queue.items.length, 2)
  assert(status.ingress.queue.items.every(item => item.lastError === 'NATIVE_CHAT_DEADLINE_EXPIRED' && item.expired === 1))
  context.diagnostic(JSON.stringify({ case: 'short-queued-expiry', arrivals: arrivedAt.length, calls: fake.calls.length, expired: status.ingress.queue.items.length }))
})

test('native create and claim baseline share the original ingress budget', async context => {
  const fake = await fixture('native-create-budget', { turnTimeoutMs: 900, createDelayMs: 1400, noticeEnabled: false })
  context.after(fake.close)
  await fake.start()
  const arrival = fake.inbound(1)
  await delay(1000)
  assert.equal(fake.calls.filter(call => call.method === 'session/create').length, 1)
  assert.equal(fake.calls.filter(call => call.method === 'session/prompt').length, 0)
  assert.equal(storedRows(fake.directory, 'host.sessions')[0]?.value.state, 'unknown')
  fake.inbound(1)
  await delay(220)
  assert.equal(fake.calls.filter(call => call.method === 'session/create').length, 1)
  context.diagnostic(JSON.stringify({ case: 'create-expiry', elapsedMs: Date.now() - arrival, creates: fake.calls.filter(call => call.method === 'session/create').length }))

  const baseline = await fixture('native-baseline-budget', { turnTimeoutMs: 900, noticeEnabled: false })
  context.after(baseline.close)
  await baseline.start()
  baseline.controls.baselineDelayMs = 1400
  baseline.inbound(1)
  await delay(1000)
  assert.equal(baseline.calls.filter(call => call.method === 'session/prompt').length, 0)
  assert.equal(baseline.runtime.executionJournal()!.length, 0)
})

test('native recycles idle follows for 24 bindings and lazily reuses the same contexts across two restarts', async context => {
  const fake = await fixture('native-idle-follow', { conversations: 24 })
  context.after(fake.close)
  await fake.start()
  for (let index = 0; index < 24; index++) {
    fake.inbound(100 + index, 123 + index)
    await until(() => fake.calls.filter(call => call.method === 'session/prompt').length === index + 1)
    await fake.answer(`review-session-${index + 1}`)
    await until(() => fake.sends.length === index + 1)
    assert((await fake.runtime.status()).host!.followedSessions <= 16)
  }
  const bindings = storedRows(fake.directory, 'host.sessions')
  const authorization = storedRows(fake.directory, 'policy.grants')
  assert.equal(bindings.length, 24)
  assert.equal(fake.calls.filter(call => call.method === 'session/create').length, 24)
  assert.equal((await fake.runtime.status()).host!.faults, 0)
  for (let restart = 0; restart < 2; restart++) {
    await fake.runtime.stop()
    await fake.start()
    assert.equal((await fake.runtime.status()).state, 'running')
    assert((await fake.runtime.status()).host!.followedSessions <= 1)
    assert.deepEqual(storedRows(fake.directory, 'host.sessions'), bindings)
    assert.deepEqual(storedRows(fake.directory, 'policy.grants'), authorization)
    assert.equal(fake.sends.length, 24 * (restart + 1))
    for (let index = 0; index < 24; index++) {
      const count = 24 * (restart + 1) + index + 1
      fake.inbound(200 + restart * 24 + index, 123 + index)
      await until(() => fake.calls.filter(call => call.method === 'session/prompt').length === count)
      const sessionId = `review-session-${index + 1}`
      assert.equal(fake.calls.filter(call => call.method === 'session/prompt').at(-1)!.input.sessionId, sessionId)
      await fake.answer(sessionId, 2 + restart)
      await until(() => fake.sends.length === count)
      assert((await fake.runtime.status()).host!.followedSessions <= 16)
    }
    assert.equal(fake.calls.filter(call => call.method === 'session/create').length, 24)
    authorization.splice(0, authorization.length, ...storedRows(fake.directory, 'policy.grants'))
  }
  context.diagnostic(JSON.stringify({ case: '24-bindings-restarts', bindings: bindings.length, prompts: fake.calls.filter(call => call.method === 'session/prompt').length, sends: fake.sends.length }))
})

test('native active and unknown follow slots backpressure before create without poisoning restart or refilling grants', async context => {
  const fake = await fixture('native-active-follow', { conversations: 20 })
  context.after(fake.close)
  await fake.start()
  for (let index = 0; index < 16; index++) {
    fake.inbound(300 + index, 123 + index)
    await until(() => fake.calls.filter(call => call.method === 'session/prompt').length === index + 1)
  }
  fake.inbound(316, 139)
  await until(async () => (await fake.runtime.status()).ingress.lastReceipt?.errorCode === 'AGENT_FOLLOW_BACKPRESSURE')
  assert.equal(fake.calls.filter(call => call.method === 'session/create').length, 16)
  assert.equal(storedRows(fake.directory, 'host.sessions').length, 16)
  const grants = storedRows(fake.directory, 'policy.grants')
  for (let restart = 0; restart < 2; restart++) {
    await fake.runtime.stop()
    await fake.start()
    assert.equal((await fake.runtime.status()).state, 'running')
    assert.equal((await fake.runtime.status()).host!.followedSessions, 16)
    assert.equal(fake.calls.filter(call => call.method === 'session/prompt').length, 16)
    assert.deepEqual(storedRows(fake.directory, 'policy.grants'), grants)
  }
  const rejectedBeforeFullPool = (await fake.runtime.status()).ingress.rejected
  fake.inbound(317, 140)
  await until(async () => {
    const status = await fake.runtime.status()
    return status.ingress.received === 18 && status.host!.pendingIngress === 0
      && status.ingress.rejected === rejectedBeforeFullPool + 1
      && status.ingress.lastReceipt?.errorCode === 'AGENT_FOLLOW_BACKPRESSURE'
  })
  assert.equal(fake.calls.filter(call => call.method === 'session/create').length, 16)
  const oldGrant = storedRows(fake.directory, 'policy.grants').filter(row => row.value.conversationId === 'private:123' && row.value.featureId === 'agent-relay')
  assert.equal(oldGrant.length, 1)
  await fake.answer('review-session-1', 1, false)
  await until(() => fake.runtime.executionJournal()!.some(row => row.binding.conversationId === 'private:123' && row.lateOutcome !== null))
  await delay(80)
  assert.equal(fake.sends.length, 0)
  assert.equal(fake.calls.filter(call => call.method === 'session/prompt').length, 16,
    JSON.stringify({ prompts: fake.calls.filter(call => call.method === 'session/prompt').map(call => ({
      sessionId: call.input.sessionId, requestId: call.input.requestId
    })), ingress: (await fake.runtime.status()).ingress }))
  fake.inbound(318, 140)
  await until(() => fake.calls.filter(call => call.method === 'session/prompt').length === 17)
  await fake.answer('review-session-17')
  await until(() => fake.sends.length === 1)
  assert.deepEqual(storedRows(fake.directory, 'policy.grants').filter(row => row.value.conversationId === 'private:123' && row.value.featureId === 'agent-relay'), oldGrant)
  context.diagnostic(JSON.stringify({ case: 'active-full-restarts', prompts: fake.calls.filter(call => call.method === 'session/prompt').length, sends: fake.sends.length }))
})

test('native explicit sixty-second budget includes real FIFO wait and forbids new work after expiry',
  { skip: process.env.NATIVE_REPAIR_REAL_DEADLINE !== '1', timeout: 85_000 }, async context => {
    const fake = await fixture('native-default-queue', { turnTimeoutMs: 60_000, createDelayMs: 4200, conversations: 16 })
    context.after(fake.close)
    assert.equal(fake.configuration.execution.turnTimeoutMs, 60_000)
    await fake.start()
    const arrivals = Array.from({ length: 16 }, (_unused, index) => ({ user: 123 + index, at: fake.inbound(500 + index, 123 + index) }))
    await until(async () => {
      const status = await fake.runtime.status()
      return status.ingress.received === 16 && status.host!.pendingIngress === 0
    }, 72_000)
    await delay(Math.max(0, arrivals[0]!.at + 69_500 - Date.now()))
    const prompts = fake.calls.filter(call => call.method === 'session/prompt')
    assert(prompts.length > 0 && prompts.length < 16)
    for (const prompt of prompts) {
      const execution = fake.runtime.executionJournal()!.find(row => row.binding.sessionId === prompt.input.sessionId)
      assert(execution)
      assert.equal(execution.deadlineAt - execution.admittedAt, 60_000)
      assert(prompt.at < execution.deadlineAt)
      assert(execution.admittedAt - arrivals[0]!.at < 1000)
    }
    assert.equal(fake.calls.filter(call => call.method === 'session/create' && call.at >= arrivals[0]!.at + 60_100).length, 0)
    assert.equal(storedRows(fake.directory, 'host.sessions').some(row => row.key === 'private:138'), false)
    assert.equal((await fake.runtime.status()).ingress.lastReceipt?.errorCode, 'NATIVE_CHAT_DEADLINE_EXPIRED')
    context.diagnostic(JSON.stringify({ case: 'real-default-queue', elapsedMs: Date.now() - arrivals[0]!.at, arrivals: arrivals.length, prompts: prompts.length }))
  })
