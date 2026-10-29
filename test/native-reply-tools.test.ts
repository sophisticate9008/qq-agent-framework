import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DshFrameworkToolPort } from '../src/adapters/dsh-framework-tools.ts'
import { projectDshToolSchema } from '../src/adapters/dsh-tool-schema.ts'
import { DEFAULT_NATIVE_OUTPUT } from '../src/contracts/native-output.ts'
import type { FrameworkToolCall, FrameworkToolPendingCall, FrameworkToolResult } from '../src/contracts/framework-tools.ts'
import type { DeliveryReceipt, JsonValue, SendRequest } from '../src/core/types.ts'
import { isRecord } from '../src/core/values.ts'
import { createContextStore } from '../src/core/context.ts'
import { createBridgeHost } from '../src/host/bridge.ts'
import { digest } from '../src/host/data.ts'
import { createNativeFrameworkTools, NATIVE_TOOL_EVENT, validateNativeToolEvent } from '../src/host/native-framework-tools.ts'
import { createNativeMessageSources } from '../src/host/native-message-sources.ts'
import { createNativeOutputService } from '../src/host/native-output.ts'
import { createNativePackageConfigurationRegistry } from '../src/host/native-package-configuration.ts'
import { createNativeReplyEffects, NATIVE_REPLY_TOOLS } from '../src/host/native-reply-tools.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { awaitCondition } from './fixtures/await-condition.ts'

function receiptResult(result: FrameworkToolResult): FrameworkToolResult {
  if (result.status !== 'confirmed' || !isRecord(result.value)) return result
  const { cached: _cached, reused: _reused, explanation: _explanation, ...value } = result.value
  return { ...result, value }
}

async function fixture(context: TestContext, options: { receipts?: readonly DeliveryReceipt[]; suppress?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-reply-'))
  const store = createSqliteStore({ filename: ':memory:' })
  const lifetime = new AbortController()
  const signal = lifetime.signal
  const sources = createNativeMessageSources({ owner: '999', signal, validate: async () => {}, validateExecution: () => {} })
  const contextStore = createContextStore()
  const persona = contextStore.registerPersona({ id: 'test', version: '1', name: 'Test', identity: {}, style: {} })
  const sent: SendRequest[] = []
  const rendered: string[] = []
  const configuration = createNativePackageConfigurationRegistry({ directory })
  const currentOutput = await configuration.read('chat-output')
  await configuration.compareAndSet('chat-output', currentOutput.revision, { ...DEFAULT_NATIVE_OUTPUT, longTextAsForward: true }, signal)
  const output = createNativeOutputService(configuration, { async renderMarkdown(request) {
    assert.equal(request.event.type, NATIVE_TOOL_EVENT)
    rendered.push(request.body)
    return [{ type: 'image', assetId: 'markdown-scoped-asset' }]
  } })
  const host = createBridgeHost({ store, context: contextStore, persona, authorizeIncoming: () => false,
    agent: { async createSession() { return { sessionId: 'session' } }, async submit() { return { status: 'accepted' } }, async follow() { return () => {} } },
    transport: { async send(request) { sent.push(request); return options.receipts?.[sent.length - 1] ?? { status: 'confirmed', messageId: `sent-${sent.length}` } } },
    eventValidators: { [NATIVE_TOOL_EVENT]: validateNativeToolEvent },
    effectAdapters: { ...createNativeReplyEffects({ sources: () => sources.reader, authorize: async () => {} }),
      'native.media.inspect': { execute: () => null }, 'native.media.read': { execute: () => null } },
    agentMessagePreparation: { capabilities: [], prepare: (execution, event) => output.prepare(event.data.content, event, execution.signal) },
    splitAgentMessage: output.split, shouldSendAgentMessage: () => options.suppress !== true })
  const binding = await host.sessions.resolve('group:123', signal)
  const requestId = digest([binding.conversationId, 'source-message', 'prompt'])
  sources.capture({ id: 'source-message', conversationId: binding.conversationId, userId: '1234' },
    { receivedAt: Date.now(), expiresAt: Date.now() + 60000, signal })
  sources.retain({ requestId, sessionId: binding.sessionId, generation: binding.generation })
  let pending: FrameworkToolPendingCall[] = []
  const completed = new Map<string, FrameworkToolResult>()
  const calls = new Map<string, FrameworkToolCall>()
  const port: DshFrameworkToolPort = {
    async inspect() { return null },
    async install(request) {
      for (const tool of request.tools) projectDshToolSchema(tool.parameters)
      return { leaseId: 'lease', sessionId: request.sessionId, generation: request.generation, names: request.tools.map(tool => tool.name) }
    },
    async withdraw() { return true }, async poll() { return pending },
    async complete(request) { completed.set(request.ticket, request.result); pending = pending.filter(item => item.ticket !== request.ticket); return true }
  }
  const tools = createNativeFrameworkTools({ host, store, port, issuerEpoch: 'epoch', signal, tools: NATIVE_REPLY_TOOLS,
    guard: async () => {}, async resolveScope(call, currentSignal) {
      const scope = { eventId: 'source-message', conversationId: binding.conversationId, sessionId: binding.sessionId,
        generation: binding.generation, featureId: 'framework-tools', version: '1.0.0' }
      const eventId = `tool-${call.id}`
      await sources.alias(scope, eventId, currentSignal)
      return { ...scope, eventId }
    } })
  host.engine.install(tools.feature)
  host.policy.grant({ id: 'tools', featureId: 'framework-tools', conversationId: binding.conversationId,
    capabilities: tools.feature.capabilities, maxUses: Object.fromEntries(tools.feature.capabilities.map(capability => [capability, null])) })
  await tools.project(binding, signal)
  let tickets = 0
  async function invoke(input: JsonValue, id = `call-${tickets}`): Promise<FrameworkToolResult> {
    const call = calls.get(id) ?? { id, name: 'qbf_reply', input, requestId, sessionId: binding.sessionId,
      generation: binding.generation, userMessageId: 'user-message', turn: 0, expiresAt: Date.now() + 10000 }
    calls.set(id, call)
    const ticket = `ticket-${tickets++}`
    pending.push({ ticket, leaseId: 'lease', call })
    await awaitCondition(() => completed.has(ticket), { timeoutMs: 2000, message: 'reply tool completion' })
    return completed.get(ticket)!
  }
  context.after(async () => { await tools.close(new AbortController().signal); lifetime.abort(); await host.stop(); store.close(); await rm(directory, { recursive: true, force: true }) })
  return { host, binding, requestId, sent, rendered, invoke }
}

test('reply tool sends a non-owner source through policy and outbox without clearing another reply watchdog', async context => {
  const runtime = await fixture(context)
  runtime.host.replies.watch(runtime.binding, 'another-pending-request')
  const result = await runtime.invoke({ content: [{ type: 'text', text: 'hello' }, { type: 'image', assetId: 'registered-image' }] }, 'once')
  assert.deepEqual(receiptResult(result), { status: 'confirmed', value: { status: 'sent', receipts: [{ status: 'confirmed', messageId: 'sent-1' }] } })
  assert.equal(runtime.sent.length, 1)
  assert.equal(runtime.sent[0]?.scope?.generation, runtime.binding.generation)
  assert.equal(runtime.host.history.snapshot(runtime.binding.conversationId).messages[0]?.id, 'sent-1')
  assert.equal(runtime.host.replies.get(runtime.binding.conversationId)?.requestId, 'another-pending-request')
  assert.equal(runtime.host.replies.get(runtime.binding.conversationId)?.status, 'waiting')
  assert.equal(runtime.host.deliveryForRequest(runtime.requestId)?.status, 'sent')
  assert.deepEqual(await runtime.invoke({ content: 'ignored duplicate' }, 'once'), result)
  assert.equal(runtime.sent.length, 1)
  runtime.host.policy.revoke('tools')
  assert.deepEqual(await runtime.invoke({ content: 'revoked' }), { status: 'rejected', code: 'POLICY_DENIED' })
  assert.equal(runtime.sent.length, 1)
})

for (const status of ['unknown', 'rejected'] as const) test(`reply tool preserves partial ${status} receipts and only confirmed history`, async context => {
  const runtime = await fixture(context, { receipts: [{ status: 'confirmed', messageId: 'first' }, { status }] })
  const result = await runtime.invoke({ content: 'first paragraph\n\nsecond paragraph' })
  assert.deepEqual(receiptResult(result), { status: 'confirmed', value: { status, receipts: [{ status: 'confirmed', messageId: 'first' }, { status }],
    errorCode: status === 'unknown' ? 'DELIVERY_UNKNOWN' : 'DELIVERY_REJECTED' } })
  assert.deepEqual(runtime.host.history.snapshot(runtime.binding.conversationId).messages.map(item => item.id), ['first'])
  assert.equal(runtime.host.deliveryForRequest(runtime.requestId)?.status, status)
})

test('reply tool reuses Markdown images, long forward planning and text plus file deliveries', async context => {
  const runtime = await fixture(context)
  await runtime.invoke({ content: { schema: 'qbf.output/1', format: 'markdown-image', body: '# Report\n\nBody' } })
  assert.deepEqual(runtime.rendered, ['# Report\n\nBody'])
  assert.deepEqual(runtime.sent[0]?.content, [{ type: 'image', assetId: 'markdown-scoped-asset' }])
  await runtime.invoke({ content: 'plain text '.repeat(1000) })
  assert.equal(runtime.sent[1]?.content[0]?.type, 'forward')
  await runtime.invoke({ content: [{ type: 'text', text: 'attachment' }, { type: 'file', assetId: 'registered-file', name: 'report.txt' }] })
  assert.deepEqual(runtime.sent.slice(2).map(item => item.content[0]?.type), ['text', 'file'])
})

test('reply suppression reports rejected without sending and exact input rejects owner injection', async context => {
  const runtime = await fixture(context, { suppress: true })
  assert.deepEqual(receiptResult(await runtime.invoke({ content: 'deferred' })), { status: 'confirmed', value: {
    status: 'rejected', receipts: [], errorCode: 'AGENT_MESSAGE_SUPPRESSED' } })
  assert.deepEqual(await runtime.invoke({ content: 'spoof', owner: true }), { status: 'rejected', code: 'INVALID_REPLY_INPUT' })
  assert.equal(runtime.sent.length, 0)
})

for (const firstStatus of ['confirmed', 'unknown', 'rejected'] as const) test(`same content with different tool calls reuses its ${firstStatus} delivery and distinct content still sends`, async context => {
  const receipt: DeliveryReceipt = firstStatus === 'confirmed' ? { status: 'confirmed', messageId: 'single-face' } : { status: firstStatus }
  const runtime = await fixture(context, { receipts: [receipt] })
  const first = await runtime.invoke({ content: [{ type: 'face', id: '14' }] }, 'first-face')
  const second = await runtime.invoke({ content: [{ id: '14', type: 'face' }] }, 'second-face')
  assert(first.status === 'confirmed' && isRecord(first.value))
  assert(second.status === 'confirmed' && isRecord(second.value))
  assert.equal(first.value.cached, false)
  assert.equal(second.value.cached, true)
  assert.equal(second.value.reused, true)
  assert.equal(first.value.status, firstStatus === 'confirmed' ? 'sent' : firstStatus)
  assert.equal(second.value.status, first.value.status)
  assert.deepEqual(second.value.receipts, [receipt])
  assert.match(String(second.value.explanation), firstStatus === 'confirmed' ? /已送达/ : firstStatus === 'unknown' ? /不要重复/ : /不重复提交/)
  assert.equal(runtime.sent.length, 1)
  await runtime.invoke({ content: [{ type: 'face', id: '15' }] }, 'different-face')
  assert.equal(runtime.sent.length, 2)
})

test('a superseded reply rejects rewritten followup content until a new request snapshot', async context => {
  const runtime = await fixture(context, { suppress: true })
  const first = await runtime.invoke({ content: 'old answer' }, 'superseded')
  const second = await runtime.invoke({ content: '# rewritten old answer' }, 'rewritten')
  assert(first.status === 'confirmed' && isRecord(first.value))
  assert(second.status === 'confirmed' && isRecord(second.value))
  assert.equal(first.value.status, 'rejected')
  assert.equal(first.value.errorCode, 'AGENT_MESSAGE_SUPPRESSED')
  assert.equal(second.value.cached, true)
  assert.equal(second.value.reused, true)
  assert.match(String(second.value.explanation), /新的会话快照/)
  assert.deepEqual(runtime.rendered, [], 'rewritten old content is rejected before another render or send')
  assert.equal(runtime.sent.length, 0)
})

test('plain and enveloped structured content share one normalized delivery identity', async context => {
  const runtime = await fixture(context)
  await runtime.invoke({ content: [{ type: 'face', id: '14' }] }, 'plain-structure')
  const repeated = await runtime.invoke({ content: { schema: 'qbf.output/1', content: [{ id: '14', type: 'face' }] } }, 'wrapped-structure')
  assert(repeated.status === 'confirmed' && isRecord(repeated.value))
  assert.equal(repeated.value.cached, true)
  assert.equal(runtime.sent.length, 1)
})
