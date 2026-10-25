import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDshAdapter,
  createDshSdkPort,
  DshAdapterError,
  normalizeDshEvent,
  type DshClientPort,
  type DshCreateSessionRequest,
  type DshFollowRequest,
  type DshPromptRequest,
  type DshSdkClient,
} from '../src/adapters/dsh.ts'
import type { AgentEvent } from '../src/host/types.ts'
import type { JsonObject } from '../src/core/types.ts'
import type { NativeEventInput } from '../src/contracts/native-events.ts'

interface PortFixture {
  port: DshClientPort
  creates: DshCreateSessionRequest[]
  prompts: DshPromptRequest[]
  cancels: string[]
  followRequest: () => DshFollowRequest
  stopped: () => boolean
}

function fixture(): PortFixture {
  const creates: DshCreateSessionRequest[] = []
  const prompts: DshPromptRequest[] = []
  const cancels: string[] = []
  let followed: DshFollowRequest | undefined
  let stopped = false
  const port: DshClientPort = {
    async createSession(request) {
      creates.push(request)
      return { ok: true, value: { sessionId: 'session-1' } }
    },
    async prompt(request) {
      prompts.push(request)
      return { ok: true, value: { queued: true } }
    },
    async follow(request) {
      followed = request
      return () => { stopped = true }
    },
    async cancel(request) {
      cancels.push(request.sessionId)
      return { ok: true, value: null }
    },
  }
  return {
    port,
    creates,
    prompts,
    cancels,
    followRequest() {
      if (!followed) throw new Error('Follow was not started')
      return followed
    },
    stopped: () => stopped,
  }
}

function eventAt(events: readonly AgentEvent[], index: number): AgentEvent {
  const event = events[index]
  if (event === undefined) throw new Error(`Missing event ${index}`)
  return event
}

test('DSH observations report real step and tool metadata while observer failures leave final delivery intact',async()=>{
  const fake=fixture()
  const observations:NativeEventInput[]=[]
  const business:AgentEvent[]=[]
  const adapter=createDshAdapter(fake.port,{onObservation(event){
    observations.push(event)
    if(event.status==='progress')return Promise.reject(Error('observer asynchronous failure'))
    if(event.status==='started')throw Error('observer synchronous failure')
  }})
  const stop=await adapter.follow({sessionId:'session-1',signal:new AbortController().signal,onEvent(event){business.push(event)}})
  const receive=async(type:string,data:JsonObject)=>fake.followRequest().onEvent({type:'session/event',sessionId:'session-1',event:{type,seq:observations.length,data}})
  await receive('turn/start',{turn:1})
  await receive('step/start',{turn:1,step:1})
  await receive('tool/call',{turn:1,step:1,callId:'call-1',name:'fixture',arguments:'private-tool-input'})
  await receive('tool/result',{turn:1,step:1,message:{role:'tool',toolCallId:'call-1',content:[{type:'text',text:'private-tool-output'}]}})
  await receive('assistant/message',{turn:1,message:{id:'final-1',role:'assistant',content:[{type:'text',text:'Actual final content'}]}})
  await receive('turn/end',{turn:1,reason:{kind:'completed'}})
  assert.deepEqual(observations.map(event=>event.status),['accepted','progress','started','completed','completed'])
  assert(!JSON.stringify(observations).includes('private-tool'))
  assert(!JSON.stringify(observations).includes('Actual final content'))
  assert.deepEqual(business.map(event=>event.type),['message','completed'])
  assert.deepEqual(business[0]!.content,[{type:'text',text:'Actual final content'}])
  await stop()
})

test('DSH adapter sends queue prompts with requestId and keeps acceptance separate from completion', async () => {
  const client = fixture()
  const adapter = createDshAdapter(client.port)
  const controller = new AbortController()
  const session = await adapter.createSession({
    conversationId: 'group:123',
    requestId: 'create-request',
    signal: controller.signal,
  })
  assert.deepEqual(session, { sessionId: 'session-1' })
  assert.equal(client.creates[0]!.conversationId, 'group:123')
  assert.equal(client.creates[0]!.requestId, 'create-request')
  assert.equal(client.creates[0]!.signal, controller.signal)

  const events: AgentEvent[] = []
  const stop = await adapter.follow({
    sessionId: session.sessionId,
    signal: controller.signal,
    onEvent(event) { events.push(event) },
  })
  const content = [
    { type: 'text', text: 'hello' },
    { type: 'image', assetId: 'asset-image' },
  ] as const
  const acceptance = await adapter.submit({
    sessionId: session.sessionId,
    requestId: 'prompt-request',
    content,
    signal: controller.signal,
  })

  assert.deepEqual(acceptance, { status: 'accepted' })
  assert.deepEqual(events, [])
  assert.equal(client.prompts.length, 1)
  assert.equal(client.prompts[0]!.mode, 'queue')
  assert.equal(client.prompts[0]!.requestId, 'prompt-request')
  assert.deepEqual(client.prompts[0]!.content, content)
  assert.notEqual(client.prompts[0]!.content, content)

  await client.followRequest().onEvent({
    type: 'session/event',
    sessionId: 'session-1',
    event: { type: 'turn/start', data: { turn: 'turn-1' } },
  })
  assert.deepEqual(events, [])
  await client.followRequest().onEvent({
    type: 'session/event',
    sessionId: 'session-1',
    event: {
      type: 'assistant/message',
      data: {
        turn: 'turn-1',
        message: {
          id: 'assistant-1',
          content: [
            { type: 'text', text: 'generated reply' },
            { type: 'reasoning', text: 'private reasoning' },
          ],
        },
      },
    },
  })
  assert.deepEqual(events, [])
  await client.followRequest().onEvent({
    type: 'session/event',
    sessionId: 'session-1',
    event: {
      type: 'turn/end',
      data: { turn: 'turn-1', reason: { kind: 'completed' } },
    },
  })

  assert.equal(events.length, 2)
  assert.deepEqual(events[0], {
    id: 'assistant/message:assistant-1',
    sessionId: 'session-1',
    type: 'message',
    content: [
      { type: 'text', text: 'generated reply' },
    ],
    data: {
      turn: 'turn-1',
      message: {
        id: 'assistant-1',
      },
    },
  })
  assert.equal(eventAt(events, 1).type, 'completed')
  assert.equal(eventAt(events, 1).id, 'turn/end:turn-1')
  assert(Object.isFrozen(events[0]))

  await client.followRequest().onEvent({
    type: 'session/event',
    sessionId: 'other-session',
    event: { id: 'other', type: 'turn/end', data: { reason: { kind: 'completed' } } },
  })
  assert.equal(events.length, 2)
  await stop()
  assert.equal(client.stopped(), true)
})

test('DSH waits for successful matching turn end and suppresses tools, thoughts, private or interrupted output', async () => {
  const unsafeFrames: JsonObject[] = [
    { message: { content: [{ type: 'text', text: 'working' }, { type: 'tool-call', name: 'shell', arguments: { private: 'secret' } }] } },
    { message: { content: [{ type: 'reasoning', text: 'private thoughts' }] } },
    { interrupted: true, message: { content: [{ type: 'text', text: 'interrupted prefix' }] } },
    { channel: 'analysis', message: { content: [{ type: 'text', text: 'analysis' }] } },
    { message: { content: [{ type: 'text', text: 'private', visibility: 'private' }] } },
    { message: { role: 'tool', content: [{ type: 'text', text: 'tool secret' }] } },
    { message: { content: [{ type: 'image', assetId: 'not-a-dsh-attachment' }] } },
  ]
  for (const unsafe of unsafeFrames) {
    const client = fixture()
    const events: AgentEvent[] = []
    await createDshAdapter(client.port).follow({ sessionId: 's', signal: new AbortController().signal, onEvent(event) { events.push(event) } })
    await client.followRequest().onEvent({ type: 'session/event', sessionId: 's', event: { seq: 1, type: 'assistant/message', data: { turn: 1, ...unsafe } } })
    assert.equal(events.length, 0)
    await client.followRequest().onEvent({ type: 'session/event', sessionId: 's', event: { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } })
    assert(!events.some(event => event.type === 'message'))
    assert(!JSON.stringify(events).includes('private thoughts'))
  }
  for (const reason of ['aborted', 'max-tokens', 'error']) {
    const client = fixture()
    const events: AgentEvent[] = []
    await createDshAdapter(client.port).follow({ sessionId: 's', signal: new AbortController().signal, onEvent(event) { events.push(event) } })
    await client.followRequest().onEvent({ type: 'session/event', sessionId: 's', event: { seq: 1, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'not final' }] } } } })
    await client.followRequest().onEvent({ type: 'session/event', sessionId: 's', event: { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: reason } } } })
    assert(!events.some(event => event.type === 'message'))
  }
})

test('DSH final answer replaces work-step text and usage preserves actual disjoint counters without private replay data', async () => {
  const client = fixture()
  const events: AgentEvent[] = []
  await createDshAdapter(client.port).follow({ sessionId: 's', signal: new AbortController().signal, onEvent(event) { events.push(event) } })
  const emit = (seq: number, type: string, data: JsonObject) => client.followRequest().onEvent({ type: 'session/event', sessionId: 's', event: { seq, type, data } })
  await emit(1, 'turn/start', { turn: 2 })
  await emit(2, 'assistant/message', { turn: 2, step: 1, message: {
    source: { kind: 'model', provider: 'external-route', model: 'model-1', replayState: { secret: 'never expose' } },
    content: [{ type: 'text', text: 'doing work' }, { type: 'tool-call', name: 'shell' }],
  }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } })
  await emit(3, 'step/start', { turn: 2, step: 2 })
  await emit(4, 'assistant/message', { turn: 2, step: 2, message: {
    source: { kind: 'model', provider: 'external-route', model: 'model-1', replayState: { secret: 'never expose' } },
    content: [{ type: 'reasoning', text: 'private internal' }, { type: 'text', text: 'final answer' }],
  }, usage: { inputTokens: 20, outputTokens: 6, totalTokens: 33, cacheReadTokens: 7 } })
  assert.equal(events.length, 0)
  await emit(5, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.deepEqual(events.map(event => event.type), ['message', 'completed'])
  assert.deepEqual(events[0]?.content, [{ type: 'text', text: 'final answer' }])
  assert.equal(events[1]?.data?.usageComplete, true)
  const usageSteps = events[1]?.data?.usageSteps
  assert(Array.isArray(usageSteps))
  assert.equal(usageSteps.length, 2)
  assert(!JSON.stringify(events).includes('never expose'))
  assert(!JSON.stringify(events).includes('private internal'))
  assert(!JSON.stringify(events).includes('doing work'))
})

test('DSH adapter normalizes questions, approvals, failures and cancellation', async () => {
  const client = fixture()
  const adapter = createDshAdapter(client.port)
  const signal = new AbortController().signal
  const events: AgentEvent[] = []
  await adapter.follow({
    sessionId: 'session-1',
    signal,
    onEvent(event) { events.push(event) },
  })
  await client.followRequest().onEvent({
    type: 'question/requested',
    sessionId: 'session-1',
    eventId: 'question-1',
    clientId: 'client-1',
    questions: [{ id: 'q1', question: 'Continue?' }],
  })
  await client.followRequest().onEvent({
    type: 'approval/requested',
    sessionId: 'session-1',
    eventId: 'approval-1',
    clientId: 'client-1',
    toolName: 'shell',
    callId: 'call-1',
    reason: 'required',
  })
  await client.followRequest().onEvent({
    type: 'session/event',
    sessionId: 'session-1',
    event: { type: 'turn/end', data: { turn: 'turn-2', reason: { kind: 'aborted' } } },
  })
  await client.followRequest().onEvent({
    type: 'stream/error',
    sessionId: 'session-1',
    eventId: 'stream-1',
    error: { code: 'transport/closed', message: 'private detail' },
  })

  assert.deepEqual(events.map(event => event.type), ['question', 'approval', 'failed', 'failed'])
  assert.deepEqual(events[0]!.data, {
    eventId: 'question-1',
    questions: [{ id: 'q1', question: 'Continue?' }],
    clientId: 'client-1',
  })
  assert.deepEqual(events[1]!.data, {
    eventId: 'approval-1',
    clientId: 'client-1',
    toolName: 'shell',
    callId: 'call-1',
    reason: 'required',
  })
  assert.deepEqual(events[3]!.data, { terminal: true, code: 'transport/closed' })
  assert.doesNotMatch(JSON.stringify(events[3]), /private detail/)

  await adapter.cancel?.({ sessionId: 'session-1', signal })
  assert.deepEqual(client.cancels, ['session-1'])
})

test('DSH adapter maps prompt failures without inventing responses or retries', async () => {
  let promptCalls = 0
  const base = fixture()
  const rejectedPort: DshClientPort = {
    ...base.port,
    async prompt() {
      promptCalls += 1
      return { ok: false, error: { code: 'session/rejected', message: 'sensitive' } }
    },
  }
  const rejected = createDshAdapter(rejectedPort)
  const signal = new AbortController().signal
  assert.deepEqual(await rejected.submit({
    sessionId: 'session-1',
    requestId: 'request-1',
    content: [{ type: 'text', text: 'hello' }],
    signal,
  }), { status: 'rejected' })
  assert.equal(promptCalls, 1)

  const unknown = createDshAdapter({
    ...base.port,
    async prompt() {
      promptCalls += 1
      throw new Error('network secret')
    },
  })
  assert.deepEqual(await unknown.submit({
    sessionId: 'session-1',
    requestId: 'request-2',
    content: [{ type: 'text', text: 'hello' }],
    signal,
  }), { status: 'unknown' })
  assert.equal(promptCalls, 2)
})

test('DSH adapter sanitizes create, follow and cancel port errors', async () => {
  const base = fixture()
  const signal = new AbortController().signal
  const createFailure = createDshAdapter({
    ...base.port,
    async createSession() { throw new Error('credential-secret') },
  })
  await assert.rejects(
    createFailure.createSession({ conversationId: 'group:1', requestId: 'create', signal }),
    (error: unknown) => error instanceof DshAdapterError
      && error.code === 'DSH_CREATE_UNKNOWN'
      && !error.message.includes('secret'),
  )

  const followFailure = createDshAdapter({
    ...base.port,
    async follow() { throw new Error('mux-secret') },
  })
  await assert.rejects(
    followFailure.follow({ sessionId: 'session-1', signal, onEvent() {} }),
    { name: 'DshAdapterError', code: 'DSH_FOLLOW_UNKNOWN' },
  )

  const cancelFailure = createDshAdapter({
    ...base.port,
    async cancel() { return { ok: false, error: { code: 'cancel/rejected', message: 'private' } } },
  })
  if (!cancelFailure.cancel) throw new Error('DSH adapter has no cancel method')
  await assert.rejects(
    cancelFailure.cancel({ sessionId: 'session-1', signal }),
    { name: 'DshAdapterError', code: 'DSH_CANCEL_REJECTED' },
  )
})

test('normalizeDshEvent requires source identifiers and never treats turn start as completion', () => {
  assert.equal(normalizeDshEvent({
    type: 'session/event',
    sessionId: 'session-1',
    event: { type: 'turn/start', data: { turn: 'turn-1' } },
  }), null)
  assert.equal(normalizeDshEvent({
    type: 'session/event',
    sessionId: 'session-1',
    event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } },
  }), null)
  assert.deepEqual(normalizeDshEvent({
    type: 'session/event',
    sessionId: 'session-1',
    event: { seq: 12, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  }), {
    id: 'turn/end:seq:12',
    sessionId: 'session-1',
    type: 'completed',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
})

test('createDshSdkPort unwraps mature SDK RPCs and filters mux subscriptions by session', async () => {
  const createInputs: unknown[] = []
  const promptInputs: unknown[] = []
  const followed: string[] = []
  const forgotten: string[] = []
  const stopped: string[] = []
  const disposal: string[] = []
  let listener: ((event: unknown) => void | Promise<void>) | undefined
  const client: DshSdkClient = {
    sessions: {
      async create(input) {
        createInputs.push(input)
        return { result: { ok: true, value: { sessionId: 'sdk-session' } } }
      },
      async prompt(input) {
        promptInputs.push(input)
        return { result: { ok: true, value: { queued: true } } }
      },
    },
    events: {
      follow(sessionId) {
        followed.push(sessionId)
      },
      forget(sessionId) {
        forgotten.push(sessionId)
      },
    },
    async stopSessionWork(sessionId) {
      stopped.push(sessionId)
      return { removed: 1 }
    },
  }
  const port = createDshSdkPort({
    client,
    createSessionRequest(request) {
      return { workspaceId: 'workspace-1', bridgeRequestId: request.requestId }
    },
    subscribe(onEvent) {
      listener = onEvent
      return () => { disposal.push('subscription') }
    },
  })
  const adapter = createDshAdapter(port)
  const signal = new AbortController().signal
  assert.deepEqual(await adapter.createSession({
    conversationId: 'group:88',
    requestId: 'create-88',
    signal,
  }), { sessionId: 'sdk-session' })
  assert.deepEqual(createInputs, [{ workspaceId: 'workspace-1', bridgeRequestId: 'create-88' }])
  assert.deepEqual(await adapter.submit({
    sessionId: 'sdk-session',
    requestId: 'prompt-88',
    content: [{ type: 'text', text: 'hello SDK' }],
    signal,
  }), { status: 'accepted' })
  assert.deepEqual(promptInputs, [{
    sessionId: 'sdk-session',
    requestId: 'prompt-88',
    mode: 'queue',
    content: [{ type: 'text', text: 'hello SDK' }],
  }])

  const events: AgentEvent[] = []
  const dispose = await adapter.follow({
    sessionId: 'sdk-session',
    signal,
    onEvent(event) { events.push(event) },
  })
  assert.deepEqual(followed, ['sdk-session'])
  if (!listener) throw new Error('SDK subscription was not installed')
  await listener({
    rpcId: 'mux-other',
    payload: {
      type: 'session/event',
      sessionId: 'other-session',
      event: { type: 'turn/end', data: { turn: 'other', reason: { kind: 'completed' } } },
    },
  })
  await listener({
    rpcId: 'mux-message',
    payload: {
      type: 'session/event',
      sessionId: 'sdk-session',
      event: {
        type: 'assistant/message',
        data: { turn: 3, message: { id: 'message-sdk', content: [{ type: 'text', text: 'done' }] } },
      },
    },
  })
  await listener({
    rpcId: 'mux-end',
    payload: {
      type: 'session/event',
      sessionId: 'sdk-session',
      event: { seq: 42, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
    },
  })
  assert.deepEqual(events.map(event => event.type), ['message', 'completed'])
  assert.equal(events[1]?.id, 'turn/end:seq:42')

  await adapter.cancel?.({ sessionId: 'sdk-session', signal })
  assert.deepEqual(stopped, ['sdk-session'])
  await dispose()
  assert.deepEqual(forgotten, ['sdk-session'])
  assert.deepEqual(disposal, ['subscription'])
})

test('createDshSdkPort supports explicit cancellation and treats malformed SDK acceptance as unknown', async () => {
  const client: DshSdkClient = {
    sessions: {
      async create() {
        return { result: { ok: true, value: { sessionId: 'session-1' } } }
      },
      async prompt() {
        return { result: { ok: true, value: null } }
      },
    },
    events: { follow() {} },
  }
  let cancellations = 0
  const port = createDshSdkPort({
    client,
    subscribe: () => () => {},
    cancel() {
      cancellations += 1
      return { result: { ok: false, error: { code: 'session/cancel-rejected' } } }
    },
  })
  const adapter = createDshAdapter(port)
  const signal = new AbortController().signal
  if (!adapter.cancel) throw new Error('DSH adapter has no cancel method')
  await assert.rejects(
    adapter.cancel({ sessionId: 'session-1', signal }),
    { name: 'DshAdapterError', code: 'DSH_CANCEL_REJECTED' },
  )
  assert.equal(cancellations, 1)

  const malformedClient = {
    ...client,
    sessions: {
      ...client.sessions,
      async prompt() {
        return { result: { ok: true } }
      },
    },
  } as unknown as DshSdkClient
  const malformed = createDshAdapter(createDshSdkPort({
    client: malformedClient,
    subscribe: () => () => {},
    cancel: () => {},
  }))
  assert.deepEqual(await malformed.submit({
    sessionId: 'session-1',
    requestId: 'prompt-malformed',
    content: [{ type: 'text', text: 'hello' }],
    signal,
  }), { status: 'unknown' })

  assert.throws(() => createDshSdkPort({
    client,
    subscribe: () => () => {},
  }), /stopSessionWork or cancel/)
})

test('createDshSdkPort aborts subscriptions without opening a late SDK follow', async () => {
  const controller = new AbortController()
  controller.abort()
  let follows = 0
  let subscriptionsDisposed = 0
  const client: DshSdkClient = {
    sessions: {
      async create() { return { result: { ok: true, value: { sessionId: 'session-1' } } } },
      async prompt() { return { result: { ok: true, value: null } } },
    },
    events: {
      follow() { follows += 1 },
      forget() { throw new Error('No follow was opened') },
    },
  }
  const port = createDshSdkPort({
    client,
    subscribe: () => () => { subscriptionsDisposed += 1 },
    cancel: () => {},
  })
  const dispose = await port.follow({
    sessionId: 'session-1',
    signal: controller.signal,
    onEvent() {},
  })
  assert.equal(follows, 0)
  assert.equal(subscriptionsDisposed, 1)
  await dispose()
  assert.equal(subscriptionsDisposed, 1)
})

test('createDshSdkPort isolates a follow that resolves after cancellation', async () => {
  const controller = new AbortController()
  let resolveFollow: ((dispose: () => void) => void) | undefined
  let listener: ((event: unknown) => void | Promise<void>) | undefined
  let subscriptionsDisposed = 0
  let lateFollowDisposed = 0
  let delivered = 0
  const client: DshSdkClient = {
    sessions: {
      async create() { return { result: { ok: true, value: { sessionId: 'session-1' } } } },
      async prompt() { return { result: { ok: true, value: null } } },
    },
    events: {
      follow() {
        return new Promise<() => void>(resolve => { resolveFollow = resolve })
      },
    },
  }
  const port = createDshSdkPort({
    client,
    subscribe(onEvent) {
      listener = onEvent
      return () => { subscriptionsDisposed += 1 }
    },
    cancel: () => {},
  })
  const following = port.follow({
    sessionId: 'session-1',
    signal: controller.signal,
    onEvent() { delivered += 1 },
  })
  await Promise.resolve()
  controller.abort()
  await Promise.resolve()
  assert.equal(subscriptionsDisposed, 1)
  if (!listener) throw new Error('SDK subscription was not installed')
  await listener({
    payload: {
      type: 'session/event',
      sessionId: 'session-1',
      event: { type: 'turn/end', data: { turn: 'late', reason: { kind: 'completed' } } },
    },
  })
  assert.equal(delivered, 0)
  if (!resolveFollow) throw new Error('SDK follow was not opened')
  resolveFollow(() => { lateFollowDisposed += 1 })
  const dispose = await following
  assert.equal(lateFollowDisposed, 1)
  await dispose()
  assert.equal(subscriptionsDisposed, 1)
  assert.equal(lateFollowDisposed, 1)
})
