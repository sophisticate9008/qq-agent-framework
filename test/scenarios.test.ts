import assert from 'node:assert/strict'
import test from 'node:test'

import { createDemoModel, createDemoTransport } from '../src/adapters/demo.ts'
import { createContextStore, createFeatureState } from '../src/core/context.ts'
import { createEngine } from '../src/core/engine.ts'
import { createPolicy } from '../src/core/policy.ts'
import type { JsonValue, ModelAdapter, ModelRequest } from '../src/core/types.ts'
import { conversationFeature } from '../src/features/conversation.ts'
import { reminderFeature } from '../src/features/reminder.ts'

test('conversation and reminder run together through the real core', async () => {
  const context = createContextStore()
  const persona = context.registerPersona({
    id: 'snow',
    version: '1.0.0',
    name: 'Snow',
    identity: { role: 'assistant' },
    style: { tone: 'warm' },
  })
  context.setConfiguration({
    scope: { kind: 'conversation', id: 'demo:room' },
    values: { language: 'zh-CN', reminderDefaultText: '检查今日事项' },
    source: 'operator',
  })
  context.setPreferences({
    id: 'room-preference',
    scope: { kind: 'conversation', id: 'demo:room' },
    values: { tone: 'friendly', reminderPrefix: '温馨提醒：' },
    source: 'confirmed-user',
  })

  const policy = createPolicy()
  policy.grant({
    id: 'conversation-room',
    featureId: 'conversation',
    conversationId: 'demo:room',
    capabilities: ['model.respond', 'messaging.send'],
    maxUses: { 'model.respond': 1, 'messaging.send': 1 },
  })
  policy.grant({
    id: 'reminder-room',
    featureId: 'reminder',
    conversationId: 'demo:room',
    capabilities: ['messaging.send'],
    maxUses: { 'messaging.send': 1 },
  })

  const transport = createDemoTransport()
  const state = createFeatureState()
  const demoModel = createDemoModel()
  const generatedPrompts: JsonValue[] = []
  const model: ModelAdapter = Object.freeze({
    generate(request: ModelRequest) {
      generatedPrompts.push(request.prompt)
      return demoModel.generate(request)
    },
  })
  const engine = createEngine({ transport, model, context, state, policy, persona })
  engine.install(conversationFeature)
  engine.install(reminderFeature)

  try {
    const directed = {
      id: 'message-1',
      type: 'message.received',
      conversationId: 'demo:room',
      userId: 'user-1',
      data: { directed: true, isSelf: false, text: '你好' },
    }
    const first = engine.emit(directed)
    const duplicate = engine.emit(structuredClone(directed))

    assert.equal(duplicate, first)
    assert.deepEqual(await duplicate, {
      eventId: 'message-1',
      conversationId: 'demo:room',
      outcomes: [{ featureId: 'conversation', status: 'completed' }],
    })
    assert.equal(generatedPrompts.length, 1)
    assert.equal(transport.describe().length, 1)

    await engine.emit({
      id: 'message-self',
      type: 'message.received',
      conversationId: 'demo:room',
      userId: 'user-1',
      data: { directed: true, isSelf: true, text: '机器人自己的消息' },
    })
    await engine.emit({
      id: 'message-undirected',
      type: 'message.received',
      conversationId: 'demo:room',
      userId: 'user-1',
      data: { directed: false, isSelf: false, text: '普通群聊' },
    })
    assert.equal(generatedPrompts.length, 1)
    assert.equal(transport.describe().length, 1)

    await engine.emit({
      id: 'reminder-1',
      type: 'trigger.fired',
      conversationId: 'demo:room',
      userId: 'user-1',
      data: { kind: 'reminder', text: '提交周报' },
    })
    assert.equal(generatedPrompts.length, 1)
    assert.equal(transport.describe().length, 2)
    assert.deepEqual(transport.describe()[1]!.content, [
      { type: 'text', text: '温馨提醒：提交周报' },
    ])

    assert.deepEqual(generatedPrompts[0], {
      persona: 'Snow',
      text: '你好',
      configuration: {
        language: 'zh-CN',
        reminderDefaultText: '检查今日事项',
      },
      preferences: {
        tone: 'friendly',
        reminderPrefix: '温馨提醒：',
      },
    })
    assert.equal(state.scope('conversation', 'demo:room').get('responseCount'), 1)
    assert.equal(state.scope('reminder', 'demo:room').get('sentCount'), 1)
    assert.deepEqual(context.resolve({ persona, conversationId: 'demo:room' }).persona, {
      id: 'snow',
      version: '1.0.0',
      name: 'Snow',
      identity: { role: 'assistant' },
      style: { tone: 'warm' },
    })
    assert.deepEqual(policy.describe().grants.map((grant) => grant.used), [
      { 'model.respond': 1, 'messaging.send': 1 },
      { 'messaging.send': 1 },
    ])
  } finally {
    await engine.stop()
  }
})
