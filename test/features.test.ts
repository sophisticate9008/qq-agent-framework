import assert from 'node:assert/strict'
import test from 'node:test'

import { createDemoModel, createDemoTransport } from '../src/adapters/demo.ts'
import { conversationFeature } from '../src/features/conversation.ts'
import { reminderFeature } from '../src/features/reminder.ts'
import type { FeatureStateScope, ResolvedContext } from '../src/core/context.ts'
import type {
  DeliveryReceipt,
  FeatureDefinition,
  FeatureExecution,
  FeatureHandler,
  FrameworkEvent,
  JsonObject,
  JsonValue,
  SendRequest,
  MessageContent,
} from '../src/core/types.ts'

interface Registration {
  type: string
  handler: FeatureHandler
}

interface TestState extends FeatureStateScope {
  read(key: string): JsonValue | undefined
}

interface ExecutionOptions {
  configuration?: JsonObject
  preferences?: JsonObject
  receiptStatus?: DeliveryReceipt['status']
}

interface ExecutionFixture {
  execution: FeatureExecution
  prompts: JsonValue[]
  sent: MessageContent[][]
  state: TestState
}

function frameworkEvent(type: string, data: JsonObject, id = 'test-event'): FrameworkEvent {
  return {
    id,
    type,
    conversationId: 'conversation-1',
    userId: 'user-1',
    data,
  }
}

function install(feature: FeatureDefinition): Registration {
  let registration: Registration | undefined
  feature.setup({
    signal: new AbortController().signal,
    on(type, handler) {
      registration = { type, handler }
    },
    defer() {},
  })
  if (!registration) {
    throw new Error('Feature did not register its handler')
  }
  return registration
}

function createState(): TestState {
  const values = new Map<string, JsonValue>()
  return {
    get(key, fallback = null) {
      return values.has(key) ? values.get(key)! : fallback
    },
    set(key, value) {
      values.set(key, value)
      return value
    },
    delete(key) {
      return values.delete(key)
    },
    read(key) {
      return values.get(key)
    },
  }
}

function createExecution({
  configuration = {},
  preferences = {},
  receiptStatus = 'confirmed',
}: ExecutionOptions = {}): ExecutionFixture {
  const prompts: JsonValue[] = []
  const sent: MessageContent[][] = []
  const state = createState()
  const context: ResolvedContext = {
    persona: {
      id: 'demo',
      version: '1.0.0',
      name: '小雪',
      identity: { role: 'assistant' },
      style: { tone: 'warm' },
    },
    configuration,
    preferences,
    provenance: {
      persona: { key: 'demo@1.0.0', id: 'demo', version: '1.0.0' },
      configuration: {},
      preferences: {},
    },
  }
  const execution: FeatureExecution = {
    context,
    state,
    signal: new AbortController().signal,
    async generate(prompt) {
      prompts.push(prompt)
      return { text: '[演示] 回复' }
    },
    async send(content) {
      sent.push(content.map((block) => ({ ...block })))
      return receiptStatus === 'confirmed'
        ? { status: 'confirmed', messageId: `sdk-${sent.length}` }
        : { status: receiptStatus }
    },
    async invoke(_capability, _input) {
      throw new Error('No extension capability is installed in the test SDK')
    },
  }
  return { execution, prompts, sent, state }
}

test('demo model is deterministic and identifies itself as a demo', async () => {
  const model = createDemoModel()
  const signal = new AbortController().signal
  const first = await model.generate({
    prompt: { text: '你好', persona: '小雪', preference: { tone: 'warm' } },
    signal,
  })
  const second = await model.generate({
    prompt: { preference: { tone: 'warm' }, persona: '小雪', text: '你好' },
    signal,
  })

  assert.deepEqual(first, second)
  assert.match(first.text, /^\[演示\] /)
  assert.ok(Object.isFrozen(first))
  assert.deepEqual(await model.generate({ prompt: '直接字符串', signal }), {
    text: '[演示] 直接字符串',
  })
})

test('demo model honors an already-aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    createDemoModel().generate({ prompt: '不会生成', signal: controller.signal }),
    { name: 'FrameworkError', code: 'ABORTED' },
  )
})

test('demo transport stores in-memory snapshots and deduplicates sends', async () => {
  const transport = createDemoTransport()
  const signal = new AbortController().signal
  const request: SendRequest = {
    conversationId: 'conversation-1',
    content: [{ type: 'text', text: 'hello' }],
    idempotencyKey: 'event-1:conversation',
    signal,
  }
  const first = await transport.send(request)
  assert.equal(request.content[0]!.type, 'text')
  if (request.content[0]!.type === 'text') request.content[0]!.text = 'mutated later'
  const duplicate = await transport.send({
    conversationId: 'conversation-1',
    content: [{ type: 'text', text: 'hello' }],
    idempotencyKey: 'event-1:conversation',
    signal,
  })
  const conflict = await transport.send({
    conversationId: 'conversation-1',
    content: [{ type: 'text', text: 'different' }],
    idempotencyKey: 'event-1:conversation',
    signal,
  })

  assert.deepEqual(duplicate, first)
  assert.deepEqual(conflict, { status: 'rejected' })
  assert.deepEqual(transport.describe(), [{
    conversationId: 'conversation-1',
    content: [{ type: 'text', text: 'hello' }],
    idempotencyKey: 'event-1:conversation',
    status: 'confirmed',
    messageId: 'demo-message-1',
  }])
  assert.ok(Object.isFrozen(transport.describe()))
})

test('demo transport honors an already-aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()
  const transport = createDemoTransport()

  await assert.rejects(transport.send({
    conversationId: 'conversation-1',
    content: [{ type: 'text', text: 'hello' }],
    idempotencyKey: 'event-2:conversation',
    signal: controller.signal,
  }), { name: 'FrameworkError', code: 'ABORTED' })
  assert.deepEqual(transport.describe(), [])
})

test('conversation feature declares its contract and ignores unrelated messages', async () => {
  assert.deepEqual(conversationFeature.capabilities, ['model.respond', 'messaging.send'])
  assert.deepEqual(conversationFeature.subscriptions, ['message.received'])
  const registration = install(conversationFeature)
  const direct = createExecution()

  assert.equal(registration.type, 'message.received')
  await registration.handler(direct.execution,
    frameworkEvent('message.received', { directed: false, isSelf: false, text: 'a' }, 'undirected'))
  await registration.handler(direct.execution,
    frameworkEvent('message.received', { directed: true, isSelf: true, text: 'b' }, 'self'))
  assert.equal(direct.prompts.length, 0)
  assert.equal(direct.sent.length, 0)
})

test('conversation feature uses context without changing persona', async () => {
  const registration = install(conversationFeature)
  const sdk = createExecution({
    configuration: { language: 'zh-CN', tone: 'neutral' },
    preferences: { tone: 'friendly' },
  })
  const personaBefore = structuredClone(sdk.execution.context.persona)

  const receipt = await registration.handler(sdk.execution,
    frameworkEvent('message.received', {
      directed: true,
      isSelf: false,
      text: '今天怎么样？',
    }))

  assert.deepEqual(sdk.prompts, [{
    persona: '小雪',
    text: '今天怎么样？',
    configuration: { language: 'zh-CN', tone: 'neutral' },
    preferences: { tone: 'friendly' },
  }])
  assert.deepEqual(sdk.sent, [[{ type: 'text', text: '[演示] 回复' }]])
  assert.deepEqual(receipt, { status: 'confirmed', messageId: 'sdk-1' })
  assert.equal(sdk.state.read('responseCount'), 1)
  assert.deepEqual(sdk.execution.context.persona, personaBefore)
})

test('reminder feature only handles reminder triggers and has isolated state', async () => {
  assert.deepEqual(reminderFeature.capabilities, ['messaging.send'])
  assert.deepEqual(reminderFeature.subscriptions, ['trigger.fired'])
  const registration = install(reminderFeature)
  const reminderSdk = createExecution({
    configuration: { reminderPrefix: '请注意：', reminderDefaultText: '喝水' },
    preferences: { reminderPrefix: '温馨提醒：' },
  })
  const conversationSdk = createExecution()

  assert.equal(registration.type, 'trigger.fired')
  await registration.handler(reminderSdk.execution,
    frameworkEvent('trigger.fired', { kind: 'other', text: '忽略' }, 'other'))
  assert.equal(reminderSdk.sent.length, 0)

  await registration.handler(reminderSdk.execution,
    frameworkEvent('trigger.fired', { kind: 'reminder' }, 'reminder'))
  assert.deepEqual(reminderSdk.sent, [[{ type: 'text', text: '温馨提醒：喝水' }]])
  assert.equal(reminderSdk.state.read('sentCount'), 1)
  assert.equal(conversationSdk.state.read('sentCount'), undefined)
})

test('reminder feature uses event text and creates no timers', async () => {
  const registration = install(reminderFeature)
  const sdk = createExecution()
  const originalSetTimeout = globalThis.setTimeout
  Reflect.set(globalThis, 'setTimeout', () => {
    throw new Error('timer created')
  })
  try {
    await registration.handler(sdk.execution,
      frameworkEvent('trigger.fired', { kind: 'reminder', text: '提交周报' }))
  } finally {
    Reflect.set(globalThis, 'setTimeout', originalSetTimeout)
  }

  assert.deepEqual(sdk.sent, [[{ type: 'text', text: '提醒：提交周报' }]])
})

test('features do not count unknown receipts as delivered', async () => {
  const conversation = install(conversationFeature)
  const conversationSdk = createExecution({ receiptStatus: 'unknown' })
  await conversation.handler(conversationSdk.execution,
    frameworkEvent('message.received', {
      directed: true,
      isSelf: false,
      text: '测试未知回执',
    }))

  const reminder = install(reminderFeature)
  const reminderSdk = createExecution({ receiptStatus: 'unknown' })
  await reminder.handler(reminderSdk.execution,
    frameworkEvent('trigger.fired', { kind: 'reminder', text: '测试未知回执' }))

  assert.equal(conversationSdk.state.read('responseCount'), undefined)
  assert.equal(reminderSdk.state.read('sentCount'), undefined)
})
