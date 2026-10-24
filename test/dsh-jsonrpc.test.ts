import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { createDshAdapter } from '../src/adapters/dsh.ts'
import type { DshFollowEvent } from '../src/adapters/dsh.ts'
import { createDshJsonRpcPort, DSH_JSONRPC_CAPABILITIES } from '../src/adapters/dsh-jsonrpc.ts'
import type { DshJsonRpcOptions } from '../src/adapters/dsh-jsonrpc.ts'
import type { ChatSessionDefinition } from '../src/host/chat-plans.ts'

const sessionDefinition: ChatSessionDefinition = {
  planId: 'chat', personaId: 'persona', instructions: 'System behavior only.',
  persona: { identity: 'A defined identity.', style: 'A defined style.' },
  model: { provider: 'test-provider', name: 'test-model', reasoningEffort: 'high' },
}
const signal = (): AbortSignal => new AbortController().signal
const createRequest = () => ({ conversationId: 'group:fake', requestId: 'create-1', signal: signal() })
const promptRequest = () => ({ sessionId: 'session-1', requestId: 'prompt-1', mode: 'queue' as const, content: [{ type: 'text' as const, text: 'User message.' }], signal: signal() })

test('DSH preset declarations are bounded and cannot reuse an ambiguous preset identifier', () => {
  const options = { endpoint: 'http://127.0.0.1:3080', auth: 'fake-token' }
  const binding = { agentPreset: 'fixed-preset', definition: sessionDefinition }
  assert.throws(() => createDshJsonRpcPort({ ...options, presetBindings: [binding, binding] }), { code: 'DSH_INVALID_OPTIONS' })
  assert.throws(() => createDshJsonRpcPort({ ...options, presetBindings: Array.from({ length: 129 }, (_entry, index) => ({
    agentPreset: `preset-${index}`, definition: sessionDefinition,
  })) }), { code: 'DSH_INVALID_OPTIONS' })
})

test('DSH deployment inspection uses only fixed authenticated read-only APIs and direct Typert arguments', async context => {
  const fake = await fixture(context, { rpc(request, response) {
    assert(['settings/describe', 'agentPresets/list', 'agentPresets/read', 'credentials/describe'].includes(request.method))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: {} } }))
    return true
  } })
  const client = fake.port()
  await client.verify(signal())
  await client.inspectDeployment({ agentPresets: ['deployed-chat'], credentialRefs: ['DEPLOYED_KEY'], signal: signal() })
  assert.deepEqual(fake.requests.map(request => request.method), [
    'settings/describe', 'settings/describe', 'agentPresets/list', 'agentPresets/read', 'credentials/describe',
  ])
  assert.deepEqual(fake.requests.map(request => request.payload.args), [{}, {}, {}, { agentPreset: 'deployed-chat' }, { refs: ['DEPLOYED_KEY'] }])
})

test('DSH scoped deployment bindings choose external provider ids instead of native catalog ids', async context => {
  const fake = await fixture(context, { rpc(request, response) {
    const input = request.payload.args.request
    const value = request.method === 'session/create' ? { sessionId: 'session-1', agentPreset: input.agentPreset }
      : { selected: { provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort } }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }))
    return true
  } })
  const client = fake.port({ presetBindings: [
    { agentPreset: 'deployed-group', conversationKind: 'group', externalProvider: 'external-group', definition: sessionDefinition },
    { agentPreset: 'deployed-private', conversationKind: 'private', externalProvider: 'external-private', definition: sessionDefinition },
  ] })
  assert.equal((await client.createSession(createRequest())).ok, true)
  assert.equal((await client.createSession({ ...createRequest(), conversationId: 'private:fixture' })).ok, true)
  assert.deepEqual(fake.requests.filter(request => request.method === 'session/selectModel').map(request => request.payload.args.request.provider), ['external-group', 'external-private'])
  assert.equal((await client.createSession({ ...createRequest(), conversationId: 'unknown:fixture' })).ok, false)
  assert.equal(fake.requests.length, 4)
})

interface WireRequest {
  type: string
  rpcId: string
  method: string
  payload: { args: { request: Record<string, unknown> } }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (predicate()) return
    await delay(5)
  }
  assert.fail('Fake service condition did not settle')
}

async function fixture(context: TestContext, overrides: {
  rpc?: (request: WireRequest, response: ServerResponse) => boolean
  connect?: (response: ServerResponse) => void
  snapshot?: Record<string, unknown>
} = {}) {
  const requests: WireRequest[] = []
  const httpCookies: Array<string | undefined> = []
  const socketCookies: Array<string | undefined> = []
  const exchanges: URL[] = []
  const streams: Array<{ socket: WebSocket; id: string; input: Record<string, unknown> }> = []
  const cancellations: string[] = []
  const sockets = new WebSocketServer({ noServer: true })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://fake.invalid')
    if (url.pathname === '/mount/connect') {
      exchanges.push(url)
      if (overrides.connect) { overrides.connect(response); return }
      response.writeHead(302, { location: './api/remote.mux', 'set-cookie': 'dsh_fake=signed.operator; Path=/; HttpOnly; SameSite=Strict' }).end()
      return
    }
    httpCookies.push(request.headers.cookie)
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const input = JSON.parse(body) as WireRequest
    requests.push(input)
    assert.equal(url.pathname, `/mount/api/${input.method}`)
    if (overrides.rpc?.(input, response)) return
    const value = input.method === 'session/create' ? { sessionId: 'session-1', agentPreset: 'framework-chat' }
      : input.method === 'session/selectModel' ? { selected: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' } }
        : { accepted: true }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value } }))
  })
  server.on('upgrade', (request, socket, head) => {
    assert.equal(request.url, '/mount/api/remote.mux')
    socketCookies.push(request.headers.cookie)
    sockets.handleUpgrade(request, socket, head, connection => {
      connection.on('message', data => {
        const input = JSON.parse(data.toString()) as Record<string, unknown>
        if (input.type === 'cancel') { cancellations.push(String(input.streamId)); return }
        assert.equal(input.type, 'open')
        const stream = { socket: connection, id: String(input.streamId), input }
        streams.push(stream)
        connection.send(JSON.stringify({ type: 'item', streamId: stream.id, value: overrides.snapshot ?? {
          type: 'snapshot', header: { id: 'session-1' }, cursor: 3,
          records: [{ type: 'event', event: { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Historical, never emit.' }] } } } }],
          projections: { asOfSeq: 3, values: {} }, hasMore: true,
        } }))
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/mount`
  context.after(async () => {
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>(resolve => sockets.close(() => resolve()))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const port = (options: Partial<DshJsonRpcOptions> = {}) => {
    const client = createDshJsonRpcPort({
      endpoint, auth: 'fake-launch-token', sessionDefinition,
      presetBindings: [{ agentPreset: 'framework-chat', definition: sessionDefinition }],
      timeoutMs: 200, ...options,
    })
    context.after(() => client.close())
    return client
  }
  const event = (sequence: number, streamIndex = 0, text = 'Live answer.') => {
    const stream = streams[streamIndex]!
    stream.socket.send(JSON.stringify({ type: 'item', streamId: stream.id, value: {
      type: 'event', event: { type: 'assistant/message', seq: sequence, time: 1, data: { message: { id: `answer-${sequence}`, content: [{ type: 'text', text }] } } },
    } }))
  }
  return { port, endpoint, requests, exchanges, streams, httpCookies, socketCookies, cancellations, event }
}

test('DSH authenticates using launch-token operator exchange and exact official unary envelopes', async context => {
  const fake = await fixture(context)
  const client = fake.port()
  assert.deepEqual(await client.createSession(createRequest()), { ok: true, value: { sessionId: 'session-1' } })
  assert.deepEqual(await client.prompt(promptRequest()), { ok: true, value: { accepted: true } })
  assert.deepEqual(await client.cancel({ sessionId: 'session-1', signal: signal() }), { ok: true, value: { accepted: true } })
  assert.equal(fake.exchanges.length, 1)
  assert.equal(fake.exchanges[0]!.searchParams.get('token'), 'fake-launch-token')
  assert.equal(fake.exchanges[0]!.searchParams.get('interactions'), 'none')
  assert.deepEqual(fake.requests.map(request => request.method), ['session/create', 'session/selectModel', 'session/prompt', 'session/cancel'])
  assert.deepEqual(fake.requests[0]!.payload, { args: { request: { agentPreset: 'framework-chat' } } })
  assert.deepEqual(fake.requests[1]!.payload.args.request, { sessionId: 'session-1', provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' })
  assert.deepEqual(fake.requests[2]!.payload.args.request.content, [{ type: 'text', text: 'User message.' }])
  assert(fake.requests.every(request => request.type === 'client-request'))
  assert(fake.httpCookies.every(cookie => cookie === 'dsh_fake=signed.operator'))
  assert.equal(new Set(fake.requests.map(request => request.rpcId)).size, 4)
})

test('DSH rejects unmapped instructions and missing definitions before any network side effect', async context => {
  const fake = await fixture(context)
  assert.deepEqual(await fake.port({ presetBindings: [] }).createSession(createRequest()), { ok: false, error: { code: 'DSH_INSTRUCTIONS_UNSUPPORTED' } })
  assert.deepEqual(await fake.port({ sessionDefinition: undefined }).createSession(createRequest()), { ok: false, error: { code: 'DSH_SESSION_DEFINITION_REQUIRED' } })
  const altered = { ...sessionDefinition, persona: { ...sessionDefinition.persona, style: 'Different' } }
  assert.deepEqual(await fake.port({ sessionDefinition: altered }).createSession(createRequest()), { ok: false, error: { code: 'DSH_INSTRUCTIONS_UNSUPPORTED' } })
  assert.equal(fake.exchanges.length, 0)
  assert.equal(fake.requests.length, 0)
  assert.equal(DSH_JSONRPC_CAPABILITIES.directSystemInstructions, false)
})

test('DSH snapshots trusted bindings but resolves current plan for every new session', async context => {
  const fake = await fixture(context)
  let current = structuredClone(sessionDefinition)
  const binding = { agentPreset: 'framework-chat', definition: structuredClone(sessionDefinition) }
  const client = fake.port({ sessionDefinition: () => current, presetBindings: [binding] })
  binding.agentPreset = 'unexpected-preset'
  assert.equal((await client.createSession(createRequest())).ok, true)
  current = { ...current, instructions: 'Changed instructions' }
  assert.deepEqual(await client.createSession(createRequest()), { ok: false, error: { code: 'DSH_INSTRUCTIONS_UNSUPPORTED' } })
  assert.equal(fake.requests.length, 2)
})

test('DSH explicit context budgets select only the exact trusted preset without protocol overrides', async context => {
  const fake = await fixture(context)
  const contextLimits = { group: 172_000, private: 384_000 }
  const definition = { ...sessionDefinition, contextLimits }
  const client = fake.port({
    sessionDefinition: structuredClone(definition),
    presetBindings: [{ agentPreset: 'framework-chat', definition }]
  })
  contextLimits.group = 1
  contextLimits.private = 2
  assert.deepEqual(await client.createSession(createRequest()), { ok: true, value: { sessionId: 'session-1' } })
  assert.deepEqual(fake.requests.map(request => request.method), ['session/create', 'session/selectModel'])
  assert.deepEqual(fake.requests[0]!.payload.args.request, { agentPreset: 'framework-chat' })
  assert.deepEqual(fake.requests[1]!.payload.args.request, {
    sessionId: 'session-1', provider: 'test-provider', model: 'test-model', reasoningEffort: 'high'
  })
  assert(!JSON.stringify(fake.requests).includes('contextLimits'))
})

test('DSH omitted or mismatched group/private budgets reject before any authentication or network call', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request') })
  const exact = { ...sessionDefinition, contextLimits: { group: 172_000, private: 384_000 } }
  for (const [selected, trusted] of [
    [{ ...exact, contextLimits: { group: 172_001, private: 384_000 } }, exact],
    [{ ...exact, contextLimits: { group: 172_000, private: 384_001 } }, exact],
    [exact, sessionDefinition],
    [sessionDefinition, exact],
    [{ ...sessionDefinition, contextLimits: { group: 128_000, private: 128_000 } }, sessionDefinition]
  ]) {
    const client = createDshJsonRpcPort({
      endpoint: 'https://agent.example.test', auth: 'private-fixture-token', sessionDefinition: selected,
      presetBindings: [{ agentPreset: 'trusted-preset', definition: trusted }]
    })
    context.after(() => client.close())
    assert.deepEqual(await client.createSession(createRequest()), {
      ok: false, error: { code: 'DSH_INSTRUCTIONS_UNSUPPORTED' }
    })
  }
  let selected: ChatSessionDefinition = exact
  const dynamic = createDshJsonRpcPort({
    endpoint: 'https://agent.example.test', auth: 'private-fixture-token', sessionDefinition: () => selected,
    presetBindings: [{ agentPreset: 'trusted-preset', definition: exact }]
  })
  context.after(() => dynamic.close())
  selected = { ...exact, contextLimits: { group: 172_000, private: 512_000 } }
  assert.deepEqual(await dynamic.createSession(createRequest()), {
    ok: false, error: { code: 'DSH_INSTRUCTIONS_UNSUPPORTED' }
  })
  assert.equal(fetch.mock.callCount(), 0)
})

test('DSH rejects malformed context budgets in definitions, trusted bindings and dynamic plans without network', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request') })
  const options = { endpoint: 'https://agent.example.test', auth: 'private-fixture-token' }
  for (const contextLimits of [
    undefined, null, {}, { group: 1 }, { group: 1, private: 2, extra: 3 },
    { group: 0, private: 1 }, { group: 1, private: 16_777_217 },
    { group: 1.5, private: 1 }, { group: 1, private: NaN },
    { group: Infinity, private: 1 }, { group: 1, private: '384000' }
  ]) {
    const definition = { ...sessionDefinition, contextLimits } as unknown as ChatSessionDefinition
    assert.throws(() => createDshJsonRpcPort({ ...options, sessionDefinition: definition }), {
      code: 'DSH_INVALID_SESSION_DEFINITION'
    })
    assert.throws(() => createDshJsonRpcPort({
      ...options, presetBindings: [{ agentPreset: 'trusted-preset', definition }]
    }), { code: 'DSH_INVALID_SESSION_DEFINITION' })
    const client = createDshJsonRpcPort({
      ...options, sessionDefinition: () => definition,
      presetBindings: [{ agentPreset: 'trusted-preset', definition: sessionDefinition }]
    })
    context.after(() => client.close())
    await assert.rejects(client.createSession(createRequest()), { code: 'DSH_INVALID_SESSION_DEFINITION' })
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test('DSH explicit operator cookie bypasses token exchange and is used for HTTP and WebSocket', async context => {
  const fake = await fixture(context)
  const client = fake.port({ auth: 'cookie:operator=signed.value' })
  await client.prompt(promptRequest())
  const stop = await client.follow({ sessionId: 'session-1', signal: signal(), onEvent() {} })
  await stop()
  assert.equal(fake.exchanges.length, 0)
  assert.deepEqual(fake.httpCookies, ['operator=signed.value'])
  assert.deepEqual(fake.socketCookies, ['operator=signed.value'])
  assert.deepEqual(fake.streams[0]!.input, { type: 'open', streamId: fake.streams[0]!.id, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } } })
})

test('DSH never follows authentication redirects or includes credential/body in errors', async context => {
  const fake = await fixture(context, { connect(response) {
    response.writeHead(302, { location: 'https://external.invalid/api/remote.mux', 'set-cookie': 'dsh_fake=secret' }).end()
  } })
  await assert.rejects(fake.port().prompt(promptRequest()), error => {
    assert(error instanceof Error)
    assert(!error.message.includes('fake-launch-token'))
    assert(!error.message.includes('User message.'))
    return 'code' in error && error.code === 'DSH_AUTH_REJECTED'
  })
  assert.equal(fake.requests.length, 0)
})

test('DSH rejects model/preset mismatches after creation as unknown, never safe rejection', async context => {
  const fake = await fixture(context, { rpc(request, response) {
    if (request.method !== 'session/selectModel') return false
    response.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: false, error: { code: 'session/model-unavailable', message: 'private remote detail', details: {} } } }))
    return true
  } })
  await assert.rejects(fake.port().createSession(createRequest()), { code: 'DSH_CREATE_CONFIGURATION_UNKNOWN' })
  assert.equal(fake.requests.length, 2)
})

test('DSH validates rpc correlation and treats HTTP faults as unknown without replay', async context => {
  const fake = await fixture(context, { rpc(_request, response) {
    response.end(JSON.stringify({ type: 'server-response', rpcId: 'wrong-id', result: { ok: true, value: { accepted: true } } }))
    return true
  } })
  const client = fake.port({ auth: 'cookie:operator=fake' })
  await assert.rejects(client.prompt(promptRequest()), { code: 'DSH_INVALID_RESPONSE' })
  assert.deepEqual(await createDshAdapter(client).submit(promptRequest()), { status: 'unknown' })
  assert.equal(fake.requests.length, 2)
})

test('DSH rejects unsupported media rather than forwarding resource ids as remote paths', async context => {
  const fake = await fixture(context)
  const client = fake.port()
  assert.deepEqual(await client.prompt({ ...promptRequest(), content: [{ type: 'image', assetId: 'unresolved' }] }), { ok: false, error: { code: 'DSH_PROMPT_UNSUPPORTED' } })
  assert.equal(fake.exchanges.length, 0)
})

test('DSH unary deadlines and aborts are bounded and late responses never become acceptance', async context => {
  const fake = await fixture(context, { rpc() { return true } })
  const client = fake.port({ auth: 'cookie:operator=fake', timeoutMs: 35 })
  await assert.rejects(client.prompt(promptRequest()), { code: 'DSH_TIMEOUT' })
  const controller = new AbortController()
  const pending = client.prompt({ ...promptRequest(), signal: controller.signal })
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(pending, { code: 'DSH_ABORTED' })
  const before = fake.requests.length
  await assert.rejects(client.prompt({ ...promptRequest(), signal: AbortSignal.abort() }), { code: 'DSH_ABORTED' })
  assert.equal(fake.requests.length, before)
})

test('DSH follows only new contiguous durable events, filters duplicates/history and disposes late events', async context => {
  const fake = await fixture(context)
  const events: DshFollowEvent[] = []
  const client = fake.port()
  const stop = await client.follow({ sessionId: 'session-1', signal: signal(), onEvent(event) { events.push(event) } })
  assert.equal(events.length, 0)
  fake.event(3)
  fake.event(4)
  fake.event(4)
  fake.event(5)
  await until(() => events.length === 2)
  assert.deepEqual(events.map(event => event.type === 'session/event' ? event.event.seq : null), [4, 5])
  await stop()
  await stop()
  const second = await client.follow({ sessionId: 'session-1', signal: signal(), onEvent(event) { events.push(event) } })
  fake.event(4, 1, 'New generation')
  await until(() => events.length === 3)
  await second()
})

test('DSH accepts empty journal cursor -1, and rejects wrong-session opening snapshots', async context => {
  const fake = await fixture(context, { snapshot: { type: 'snapshot', header: { id: 'session-1' }, cursor: -1, records: [] } })
  const events: DshFollowEvent[] = []
  const client = fake.port()
  const stop = await client.follow({ sessionId: 'session-1', signal: signal(), onEvent(event) { events.push(event) } })
  fake.event(0)
  await until(() => events.length === 1)
  await stop()
  const other = await fixture(context, { snapshot: { type: 'snapshot', header: { id: 'wrong' }, cursor: 0, records: [] } })
  await assert.rejects(other.port().follow({ sessionId: 'session-1', signal: signal(), onEvent() {} }), { code: 'DSH_FOLLOW_INVALID_FRAME' })
})

test('DSH sequence gaps end follow with a sanitized error rather than silent loss/reconnect', async context => {
  const fake = await fixture(context)
  const events: DshFollowEvent[] = []
  await fake.port().follow({ sessionId: 'session-1', signal: signal(), onEvent(event) { events.push(event) } })
  fake.event(6)
  await until(() => events.length === 1)
  assert.deepEqual(events[0], { type: 'stream/error', sessionId: 'session-1', error: { code: 'DSH_FOLLOW_SEQUENCE_GAP' } })
  assert.equal(fake.streams.length, 1)
})

test('DSH slow callbacks are serialized and overflow terminates follow without unbounded buffering', async context => {
  const fake = await fixture(context)
  let release: () => void = () => undefined
  const blocked = new Promise<void>(resolve => { release = resolve })
  const events: DshFollowEvent[] = []
  await fake.port({ maxPendingEvents: 1 }).follow({ sessionId: 'session-1', signal: signal(), async onEvent(event) {
    events.push(event)
    if (event.type === 'session/event') await blocked
  } })
  fake.event(4)
  await until(() => events.length === 1)
  fake.event(5)
  fake.event(6)
  await delay(20)
  release()
  await until(() => events.some(event => event.type === 'stream/error'))
  assert.equal(events.filter(event => event.type === 'session/event').length, 1)
  assert.equal(events.at(-1)?.type, 'stream/error')
})

test('DSH enforces follow idle deadline, duplicate-follow exclusion and abort cleanup', async context => {
  const fake = await fixture(context)
  const events: DshFollowEvent[] = []
  const client = fake.port({ followIdleTimeoutMs: 35 })
  await client.follow({ sessionId: 'session-1', signal: signal(), onEvent(event) { events.push(event) } })
  await assert.rejects(client.follow({ sessionId: 'session-1', signal: signal(), onEvent() {} }), { code: 'DSH_FOLLOW_ALREADY_ACTIVE' })
  await until(() => events.length === 1)
  assert.deepEqual(events[0], { type: 'stream/error', sessionId: 'session-1', error: { code: 'DSH_FOLLOW_IDLE_TIMEOUT' } })
  const controller = new AbortController()
  const stop = await client.follow({ sessionId: 'session-1', signal: controller.signal, onEvent(event) { events.push(event) } })
  controller.abort()
  await stop()
  await delay(45)
  assert.equal(events.length, 1)
  await client.close()
  await assert.rejects(client.prompt(promptRequest()), { code: 'DSH_ABORTED' })
})

test('DSH rejects dangerous endpoint/credential and nonfinite limits synchronously', () => {
  for (const endpoint of ['http://external.invalid', 'https://user:secret@example.invalid', 'https://example.invalid/?token=secret', 'file:///tmp/dsh']) {
    assert.throws(() => createDshJsonRpcPort({ endpoint, auth: 'fake' }), { code: 'DSH_INVALID_OPTIONS' })
  }
  for (const auth of ['', 'cookie:bad=one;other=two', 'with spaces', 'line\r\nbreak']) {
    assert.throws(() => createDshJsonRpcPort({ endpoint: 'http://127.0.0.1:1', auth }), { code: 'DSH_INVALID_OPTIONS' })
  }
  assert.throws(() => createDshJsonRpcPort({ endpoint: 'http://127.0.0.1:1', auth: 'fake', timeoutMs: Infinity }), { code: 'DSH_INVALID_OPTIONS' })
})

test('DSH distinguishes explicit business rejection from internal/partial external outcomes', async context => {
  let remoteCode = 'gateway/bad-request'
  const fake = await fixture(context, { rpc(request, response) {
    response.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: false, error: { code: remoteCode, message: 'secret detail', details: {} } } }))
    return true
  } })
  const client = fake.port({ auth: 'cookie:operator=fake' })
  assert.deepEqual(await client.prompt(promptRequest()), { ok: false, error: { code: 'DSH_RPC_REJECTED' } })
  remoteCode = 'gateway/internal'
  assert.deepEqual(await createDshAdapter(client).submit(promptRequest()), { status: 'unknown' })
  remoteCode = 'session/workspace-attach-failed'
  await assert.rejects(client.createSession(createRequest()), { code: 'DSH_RPC_UNKNOWN' })
})

test('DSH concurrent operations exchange a single token and maintain separate RPC correlation', async context => {
  const fake = await fixture(context)
  const client = fake.port()
  await Promise.all(Array.from({ length: 6 }, () => client.prompt(promptRequest())))
  assert.equal(fake.exchanges.length, 1)
  assert.equal(fake.requests.length, 6)
  assert.equal(new Set(fake.requests.map(request => request.rpcId)).size, 6)
})

test('DSH bounds response bytes and does not treat non-success HTTP responses as safe retries', async context => {
  let oversized = true
  const fake = await fixture(context, { rpc(_request, response) {
    if (oversized) response.end('x'.repeat(1_048_577))
    else response.writeHead(503).end('private failure')
    return true
  } })
  const client = fake.port({ auth: 'cookie:operator=fake' })
  await assert.rejects(client.prompt(promptRequest()), { code: 'DSH_RESPONSE_TOO_LARGE' })
  oversized = false
  await assert.rejects(client.prompt(promptRequest()), { code: 'DSH_HTTP_UNKNOWN' })
  assert.equal(fake.requests.length, 2)
})

test('DSH hanging callbacks retain bounded capacity after timeout and close remains finite', async context => {
  const fake = await fixture(context)
  let started = false
  let release: () => void = () => undefined
  const blocked = new Promise<void>(resolve => { release = resolve })
  const client = fake.port({ timeoutMs: 60, maxFollows: 1 })
  await client.follow({ sessionId: 'session-1', signal: signal(), async onEvent() {
    started = true
    await blocked
  } })
  fake.event(4)
  await until(() => started)
  await delay(90)
  await assert.rejects(client.follow({ sessionId: 'session-1', signal: signal(), onEvent() {} }), { code: 'DSH_FOLLOW_BACKPRESSURE' })
  await client.close()
  release()
})

test('DSH malformed WebSocket frames terminate with no raw payload disclosure', async context => {
  const fake = await fixture(context)
  const events: DshFollowEvent[] = []
  await fake.port().follow({ sessionId: 'session-1', signal: signal(), onEvent(event) { events.push(event) } })
  fake.streams[0]!.socket.send('not JSON: fake-launch-token')
  await until(() => events.length === 1)
  assert.deepEqual(events[0], { type: 'stream/error', sessionId: 'session-1', error: { code: 'DSH_FOLLOW_INVALID_FRAME' } })
})
