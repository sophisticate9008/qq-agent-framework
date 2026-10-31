import assert from 'node:assert/strict'
import test from 'node:test'
import { createContextStore } from '../src/core/context.ts'
import { normalizeContent } from '../src/core/content.ts'
import type { DeliveryReceipt } from '../src/core/types.ts'
import type { AgentEvent, SessionBinding } from '../src/host/types.ts'
import { createBridgeHost } from '../src/host/bridge.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { awaitCondition } from './fixtures/await-condition.ts'
import { digest } from '../src/host/data.ts'

test('host feedback uses the original session and system history, and fast delivery cannot create a stale reply wait', async () => {
  const store = createSqliteStore({ filename: ':memory:' })
  const context = createContextStore()
  const persona = context.registerPersona({ id: 'test', version: '1', name: 'Test', identity: {}, style: {} })
  let created = 0
  let onEvent: ((event: AgentEvent) => void | Promise<void>) | undefined
  let receipt: DeliveryReceipt | undefined
  const host = createBridgeHost({ store, context, persona, authorizeIncoming: () => false,
    agentMessagePreparation: { capabilities: [], prepare: (_execution, event) => normalizeContent(event.data.content) },
    agent: {
      async createSession() { created++; return { sessionId: 'original-session' } },
      async follow(request) { onEvent = request.onEvent; return () => {} },
      async submit(request) {
        assert.equal(request.sessionId, 'original-session')
        assert.equal(host.replies.get('group:123')?.status, 'waiting')
        await onEvent?.({ id: 'result', sessionId: request.sessionId, type: 'message',
          content: [{ type: 'text', text: '事情做完啦。' }], data: { nativeRequestId: request.requestId } })
        await awaitCondition(() => receipt !== undefined, { timeoutMs: 1000, message: 'delivery before submit returns' })
        return { status: 'accepted' }
      }
    }, transport: { async send() { return { status: 'confirmed', messageId: 'qq-result' } } },
    onAgentDelivery: (_requestId, value) => { receipt = value } })
  try {
    host.policy.grant({ id: 'relay', featureId: 'agent-relay', conversationId: 'group:123', capabilities: ['agent.submit', 'messaging.send'],
      maxUses: { 'agent.submit': 5, 'messaging.send': 5 } })
    const binding = await host.sessions.resolve('group:123', new AbortController().signal)
    const result = await host.notifyAgent({ binding, id: 'work-result', content: [{ type: 'text', text: 'Observed work result' }], signal: new AbortController().signal })
    assert.equal(result.status, 'accepted')
    assert.equal(created, 1)
    assert.equal(host.history.snapshot('group:123').messages[0]?.actor, 'system')
    assert.equal(host.replies.get('group:123')?.status, 'responded')
    assert.deepEqual(receipt, { status: 'confirmed', messageId: 'qq-result' })
    host.policy.revoke('relay')
    await assert.rejects(host.notifyAgent({ binding, id: 'denied', content: [{ type: 'text', text: 'Must not submit' }], signal: new AbortController().signal }), { code: 'POLICY_DENIED' })
    assert.equal(host.history.snapshot('group:123').messages.some(item => item.id === 'denied'), false)
  } finally { await host.stop(); store.close() }
})

test('a failed later bubble cannot confirm a partially delivered feedback message', async () => {
  const store = createSqliteStore({ filename: ':memory:' })
  const context = createContextStore()
  const persona = context.registerPersona({ id: 'test', version: '1', name: 'Test', identity: {}, style: {} })
  let onEvent: ((event: AgentEvent) => void | Promise<void>) | undefined
  let receipt: DeliveryReceipt | undefined
  let sends = 0
  const host = createBridgeHost({ store, context, persona, authorizeIncoming: () => false,
    agentMessagePreparation: { capabilities: [], prepare: (_execution, event) => normalizeContent(event.data.content) },
    splitAgentMessage: () => [[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]],
    agent: { async createSession() { return { sessionId: 'parent' } }, async submit() { return { status: 'accepted' } },
      async follow(request) { onEvent = request.onEvent; return () => {} } },
    transport: { async send() { if (++sends === 2) throw Error('network lost'); return { status: 'confirmed', messageId: 'first-bubble' } } },
    onAgentDelivery: (_id, value) => { receipt = value } })
  try {
    host.policy.grant({ id: 'relay', featureId: 'agent-relay', conversationId: 'group:123', capabilities: ['agent.submit', 'messaging.send'],
      maxUses: { 'agent.submit': 5, 'messaging.send': 5 } })
    const binding = await host.sessions.resolve('group:123', new AbortController().signal)
    await host.notifyAgent({ binding, id: 'work-result', content: [{ type: 'text', text: 'result' }], signal: new AbortController().signal })
    await onEvent?.({ id: 'result', sessionId: 'parent', type: 'message', content: [{ type: 'text', text: 'result' }], data: { nativeRequestId: 'request' } })
    await awaitCondition(() => receipt !== undefined, { timeoutMs: 1000, message: 'partial failure reported' })
    assert.equal(sends, 2)
    assert.equal(receipt?.status, 'unknown')
  } finally { await host.stop(); store.close() }
})

for (const newerWait of [false, true]) test(`unknown final feedback settles only its exact notification wait (${newerWait ? 'newer wait retained' : 'original wait settled'})`, async () => {
  const store = createSqliteStore({ filename: ':memory:' })
  const context = createContextStore()
  const persona = context.registerPersona({ id: 'test', version: '1', name: 'Test', identity: {}, style: {} })
  let onEvent: ((event: AgentEvent) => void | Promise<void>) | undefined
  let requestId = '', creates = 0, submits = 0, sends = 0
  let binding: SessionBinding
  const host = createBridgeHost({ store, context, persona, authorizeIncoming: () => false,
    agentMessagePreparation: { capabilities: [], prepare: (_execution, event) => normalizeContent(event.data.content) },
    agent: { async createSession() { creates++; return { sessionId: 'original-session' } },
      async submit(request) { submits++; requestId = request.requestId; return { status: 'accepted' } },
      async follow(request) { onEvent = request.onEvent; return () => {} } },
    transport: { async send() {
      sends++
      if (newerWait) {
        host.replies.suppress(binding, 'result')
        host.replies.watch(binding, 'new-user-source')
      }
      return { status: 'unknown' }
    } } })
  try {
    host.policy.grant({ id: 'relay', featureId: 'agent-relay', conversationId: 'group:123', capabilities: ['agent.submit', 'messaging.send'],
      maxUses: { 'agent.submit': null, 'messaging.send': null } })
    binding = await host.sessions.resolve('group:123', new AbortController().signal)
    const request = { binding, id: 'result', presentation: 'reply' as const, content: [{ type: 'text' as const, text: 'model narration input' }],
      signal: new AbortController().signal }
    assert.equal((await host.notifyAgent(request)).status, 'accepted')
    assert.equal(requestId, digest(['group:123', 'result', 'prompt']))
    await onEvent?.({ id: 'verified-final', sessionId: binding.sessionId, type: 'message',
      content: [{ type: 'text', text: 'model narration output' }], data: { nativeRequestId: requestId } })
    await awaitCondition(() => host.agentNotificationDelivery(binding, request.id) === 'unknown', { timeoutMs: 1000, message: 'unknown feedback recorded' })
    const waiting = host.replies.get(binding.conversationId)!
    assert.equal(waiting.requestId, newerWait ? 'new-user-source' : 'result')
    assert.equal(waiting.status, newerWait ? 'waiting' : 'suppressed')
    assert.equal(host.outbox.list()[0]?.status, 'unknown')
    assert.equal((await host.notifyAgent(request)).status, 'unknown')
    assert.equal(creates, 1)
    assert.equal(submits, 1)
    assert.equal(sends, 1)
  } finally { await host.stop(); store.close() }
})
