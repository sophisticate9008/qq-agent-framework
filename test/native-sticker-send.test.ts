import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { DshFrameworkToolPort } from '../src/adapters/dsh-framework-tools.ts'
import type { FrameworkToolCall, FrameworkToolPendingCall, FrameworkToolResult } from '../src/contracts/framework-tools.ts'
import type { JsonValue, SendRequest } from '../src/core/types.ts'
import { normalizeContent } from '../src/core/content.ts'
import { createContextStore } from '../src/core/context.ts'
import { createBridgeHost } from '../src/host/bridge.ts'
import { digest } from '../src/host/data.ts'
import { createNativeFrameworkTools, NATIVE_TOOL_EVENT, validateNativeToolEvent } from '../src/host/native-framework-tools.ts'
import { createNativeMessageSources } from '../src/host/native-message-sources.ts'
import { createNativeStickerSendEffect, NATIVE_STICKER_SEND_TOOLS } from '../src/host/native-sticker-send.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { awaitCondition } from './fixtures/await-condition.ts'

async function fixture(context: TestContext, options: {
  choose?: (signal: AbortSignal) => Promise<string | null>
  prepare?: (signal: AbortSignal) => Promise<void>
} = {}) {
  const store = createSqliteStore({ filename: ':memory:' })
  const lifetime = new AbortController(), signal = lifetime.signal
  const sources = createNativeMessageSources({ owner: 'owner', signal, validate: async () => {}, validateExecution: () => {} })
  const contexts = createContextStore()
  const persona = contexts.registerPersona({ id: 'test', version: '1', name: 'Test', identity: {}, style: {} })
  const sent: SendRequest[] = []
  let choices = 0
  const effect = createNativeStickerSendEffect({ sources: () => sources.reader, authorize: async () => {}, library: () => ({
    async choose(_intent, conversationId, currentSignal) {
      choices++
      assert.equal(conversationId, 'group:fixture')
      return options.choose ? options.choose(currentSignal) : 'media-actual-library-image'
    },
  }) })
  const host = createBridgeHost({ store, context: contexts, persona, authorizeIncoming: () => false,
    agent: { async createSession() { return { sessionId: 'session' } }, async submit() { return { status: 'accepted' } }, async follow() { return () => {} } },
    transport: { async send(request) { sent.push(request); return { status: 'confirmed', messageId: `sent-${sent.length}` } } },
    eventValidators: { [NATIVE_TOOL_EVENT]: validateNativeToolEvent },
    effectAdapters: { 'native.stickers.send': effect, 'native.media.inspect': { execute: () => null }, 'native.media.read': { execute: () => null } },
    agentMessagePreparation: { capabilities: [], async prepare(execution, event) {
      await options.prepare?.(execution.signal)
      return normalizeContent(event.data.content)
    } },
  })
  const binding = await host.sessions.resolve('group:fixture', signal)
  const requestId = digest([binding.conversationId, 'source', 'prompt'])
  sources.capture({ id: 'source', conversationId: binding.conversationId, userId: 'ordinary-member' },
    { receivedAt: Date.now(), expiresAt: Date.now() + 60000, signal })
  sources.retain({ requestId, sessionId: binding.sessionId, generation: binding.generation })
  let pending: FrameworkToolPendingCall[] = []
  const completed = new Map<string, FrameworkToolResult>()
  const port: DshFrameworkToolPort = {
    async inspect() { return null },
    async install(request) { return { leaseId: 'lease', sessionId: request.sessionId, generation: request.generation, names: request.tools.map(tool => tool.name) } },
    async withdraw() { return true }, async poll() { return pending },
    async complete(request) { completed.set(request.ticket, request.result); pending = pending.filter(item => item.ticket !== request.ticket); return true },
  }
  const tools = createNativeFrameworkTools({ host, store, port, issuerEpoch: 'epoch', signal, tools: NATIVE_STICKER_SEND_TOOLS,
    guard: async () => {}, async resolveScope(call, currentSignal) {
      const scope = { eventId: 'source', conversationId: binding.conversationId, sessionId: binding.sessionId,
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
  async function invoke(input: JsonValue, timeoutMs = 5000): Promise<FrameworkToolResult> {
    const ticket = `ticket-${tickets++}`
    const call: FrameworkToolCall = { id: ticket, name: 'qbf_sticker_send', input, requestId, sessionId: binding.sessionId,
      generation: binding.generation, userMessageId: 'user-message', turn: 0, expiresAt: Date.now() + timeoutMs }
    pending.push({ ticket, leaseId: 'lease', call })
    await awaitCondition(() => completed.has(ticket), { timeoutMs: 2000, message: 'sticker send completion' })
    return completed.get(ticket)!
  }
  context.after(async () => { await tools.close(new AbortController().signal); lifetime.abort(); await host.stop(); store.close() })
  return { sent, host, invoke, choices: () => choices }
}

test('an ordinary group member sends through the admitted reply policy, outbox and history', async context => {
  const runtime = await fixture(context)
  const result = await runtime.invoke({ intent: '开心', text: '嘿嘿' })
  assert.equal(result.status, 'confirmed')
  assert.equal(runtime.choices(), 1)
  assert.equal(runtime.sent.length, 1)
  assert.deepEqual(runtime.sent[0]!.content, [{ type: 'text', text: '嘿嘿' }, { type: 'image', assetId: 'media-actual-library-image' }])
  assert.equal(runtime.host.history.snapshot('group:fixture').messages.length, 1)
})

test('revoking the ordinary conversation grant stops selection and dispatch', async context => {
  const runtime = await fixture(context)
  runtime.host.policy.revoke('tools')
  assert.equal((await runtime.invoke({ intent: '开心' })).status, 'rejected')
  assert.equal(runtime.choices(), 0)
  assert.equal(runtime.sent.length, 0)
})

test('an unsuitable selection leaves both image and accompanying text unsent', async context => {
  const runtime = await fixture(context, { choose: async () => null })
  assert.deepEqual(await runtime.invoke({ intent: '开心', text: '嘿嘿' }), { status: 'confirmed', value: { status: 'skipped', quiet: true } })
  assert.equal(runtime.sent.length, 0)
})

test('an expired original call fences a late selector that ignores cancellation', async context => {
  let release: ((assetId: string) => void) | undefined
  let helperSignal: AbortSignal | undefined
  const runtime = await fixture(context, { choose: signal => {
    helperSignal = signal
    return new Promise<string>(resolve => { release = resolve })
  } })
  const pending = runtime.invoke({ intent: '开心' }, 300)
  await awaitCondition(() => release !== undefined, { timeoutMs: 250, message: 'selector started' })
  const result = await pending
  assert.equal(result.status, 'unknown')
  assert.equal(helperSignal!.aborted, true)
  release!('media-too-late')
  await new Promise<void>(resolve => setTimeout(resolve, 30))
  assert.equal(runtime.sent.length, 0)
})

test('output preparation that ignores cancellation cannot dispatch after the original deadline', async context => {
  let release: (() => void) | undefined
  const runtime = await fixture(context, { prepare: () => new Promise<void>(resolve => { release = resolve }) })
  const pending = runtime.invoke({ intent: '开心' }, 300)
  await awaitCondition(() => release !== undefined, { timeoutMs: 250, message: 'output preparation started' })
  assert.equal((await pending).status, 'unknown')
  release!()
  await new Promise<void>(resolve => setTimeout(resolve, 30))
  assert.equal(runtime.sent.length, 0)
})
