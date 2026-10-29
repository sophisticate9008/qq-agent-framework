import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Llm, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Registry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type {} from '../dist/index.js'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
class ReplyAdapter extends LlmAdapter {
  requests = 0
  readonly responses: ('bare' | 'tool' | 'silent' | 'invalid' | 'siblings')[] = ['bare', 'tool', 'tool']
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    const response = this.responses.shift() ?? 'silent'
    if (response === 'tool' || response === 'invalid' || response === 'siblings') {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(this.requests <= 3 ? 'reply-call' : `reply-call-${this.requests}`),
        name: 'qbf_reply', arguments: response === 'invalid' ? '{"unexpected":true}' : '{"content":"Sent by an explicit tool"}' } }
      if (response === 'siblings') {
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('sibling-call'), name: 'qbf_sibling', arguments: '{}' } }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: response === 'bare' ? 'Bare answer that must stay private'
        : '{"schema":"qbf.reply/1","action":"silent","reason":"already-answered"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('actual SDK repair stays inside the original turn and user claim until its explicit reply tool settles', async context => {
  const ctx = new Context()
  const loader = ctx.plugin(Loader)
  const fibers = [Agents, Sessions, Projections, SystemPrompt, Tools, Llm, Registry, RemoteAccess, Gateway].map(plugin => ctx.plugin(plugin))
  fibers.push(ctx.plugin(Presets, { default: 'fixture' }), ctx.plugin(AgentLoop))
  await Promise.all(fibers.map(fiber => fiber.inertia))
  await loader.inertia
  await ctx.loader.create({ name: import.meta.resolve('@qq-bridge-framework/dsh-bridge-plugin') })
  await ctx.loader.await()
  await new Promise<void>(resolve => setImmediate(resolve))
  const adapter = new ReplyAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('reply-repair-sdk'), agentOptions: { provider: 'fixture', model: 'model' } })
  const agent = handle.agent
  const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' })
  context.after(async () => { await handle.dispose(); await peer.dispose(); await ctx.fiber.dispose() })
  const invoke = (method: string, args: Record<string, unknown> = {}) => ctx.typertGateway.invoke({ namespace: 'bridgePlugin', method, args, peer })
  const described = await invoke('describe')
  assert(object(described) && typeof described.issuerEpoch === 'string')
  const issuerEpoch = described.issuerEpoch
  await invoke('installFrameworkTools', { request: { issuerEpoch, sessionId: agent.id, generation: 1,
    tools: [{ name: 'qbf_reply', description: 'Explicit local capture reply', timeoutMs: 5000,
      parameters: { type: 'object', additionalProperties: false, properties: { content: { type: 'string' } }, required: ['content'] } },
    { name: 'qbf_sibling', description: 'A second submitted local tool', timeoutMs: 5000,
      parameters: { type: 'object', properties: {}, additionalProperties: false } }] } })
  const terminal: number[] = []
  const observedSources: string[] = []
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'turn/end') terminal.push(event.data.turn)
    if (event.type === 'user/message') observedSources.push(event.data.source.kind)
  })
  const inputModule: unknown = await import(new URL('../../../src/host/native-chat-input.ts', import.meta.url).href)
  assert(object(inputModule) && typeof inputModule.prepareNativeChatInput === 'function')
  const actualInput: unknown = inputModule.prepareNativeChatInput({ id: 'actual-group-input', type: 'message.received',
    conversationId: 'group:fixture', userId: 'member', data: { directed: true, content: [{ type: 'text', text: 'Original user source' }] } }, [],
  { owner: 'configured-owner', partial: false, participation: 'continuation',
    groupWake: [{ messageId: 'earlier-bot-quote', actor: 'other-member', reason: 'reply' }] })
  assert(Array.isArray(actualInput) && actualInput.every(block => object(block) && block.type === 'text' && typeof block.text === 'string'))
  assert(actualInput.some(block => object(block) && String(block.text).startsWith('本批最新消息（结合未读消息选择回应对象）：\n')))
  const original = createUserMessage({ source: { kind: 'user', rpcId: 'authentic-qq-request' },
    content: actualInput.map(block => ({ type: 'text', text: String(block.text) })) })
  agent.followup(original)
  let calls: unknown[] = []
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await invoke('pollFrameworkTools', { request: { issuerEpoch } })
    assert(object(result) && Array.isArray(result.calls))
    calls = result.calls
    if (calls.length) break
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  assert.equal(calls.length, 1)
  assert.equal(adapter.requests, 2, 'the reminder is added only after an omitted decision')
  assert.deepEqual(terminal, [], 'the first bare final does not close the turn')
  assert(observedSources.includes('qbf-reply-decision-repair'))
  const pending = calls[0]
  assert(object(pending) && object(pending.call) && typeof pending.ticket === 'string')
  assert.equal(pending.call.requestId, 'authentic-qq-request')
  assert.equal(pending.call.userMessageId, original.id)
  assert.equal(pending.call.turn, 1)
  const receipts = await invoke('claimReceipts', { request: { sessionId: agent.id } })
  assert(object(receipts) && Array.isArray(receipts.receipts))
  assert.equal(receipts.receipts.length, 1, 'synthetic steering does not register a fresh user claim')
  await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: pending.ticket, result: { status: 'confirmed', value: { status: 'sent', receipts: [{ status: 'confirmed' }] } } } })
  await agent.whenIdle()
  assert.deepEqual(terminal, [1])
  assert.equal(adapter.requests, 2, 'an explicit delivery ends its step without a model acknowledgement request')
  let oldProbe: unknown
  let probed = false
  const probe = agent.ctx.on('agent/request', async (payload, next) => {
    if (payload.turn === 2 && !probed) {
      probed = true
      oldProbe = await agent.ctx.tools.execute({ callId: ToolCallId('reply-call'), agent, name: 'qbf_reply',
        arguments: { content: 'An old call must not borrow the new user source' }, signal: payload.signal })
    }
    return next()
  })
  const second = createUserMessage({ source: { kind: 'user', rpcId: 'second-qq-request' }, content: original.content })
  agent.followup(second)
  let secondCalls: unknown[] = []
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await invoke('pollFrameworkTools', { request: { issuerEpoch } })
    assert(object(result) && Array.isArray(result.calls))
    secondCalls = result.calls
    if (secondCalls.length) break
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  assert(object(oldProbe) && object(oldProbe.value))
  assert.equal(oldProbe.value.code, 'TOOL_SOURCE_UNAVAILABLE')
  assert.equal(secondCalls.length, 1, 'a fresh SDK root may reuse a previous turn call id after seen cleanup')
  const secondPending = secondCalls[0]
  assert(object(secondPending) && object(secondPending.call) && typeof secondPending.ticket === 'string')
  assert.equal(secondPending.call.id, 'reply-call')
  assert.equal(secondPending.call.requestId, 'second-qq-request')
  assert.equal(secondPending.call.userMessageId, second.id)
  assert.equal(secondPending.call.turn, 2)
  await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: secondPending.ticket, result: { status: 'confirmed', value: { status: 'sent', receipts: [{ status: 'confirmed' }] } } } })
  await agent.whenIdle()
  probe()
  assert.deepEqual(terminal, [1, 2])
  assert.equal(adapter.requests, 3, 'a normal explicit tool turn receives neither repair nor acknowledgement requests')
  const cases = [
    { name: 'unknown-delivery', result: { status: 'confirmed', value: { status: 'unknown', receipts: [] } }, terminal: true },
    { name: 'suppressed', result: { status: 'confirmed', value: { status: 'rejected', receipts: [], errorCode: 'AGENT_MESSAGE_SUPPRESSED' } }, terminal: true },
    { name: 'unknown-tool-result', result: { status: 'unknown', code: 'TOOL_HOST_TIMEOUT' }, terminal: true },
    { name: 'rejected-delivery', result: { status: 'confirmed', value: { status: 'rejected', receipts: [], errorCode: 'INVALID_REPLY_INPUT' } }, terminal: false },
    { name: 'rejected-tool', result: { status: 'rejected', code: 'INVALID_TOOL_INPUT' }, terminal: false }
  ]
  async function queuedCall(name = 'qbf_reply') {
    for (let attempt = 0; attempt < 300; attempt++) {
      const result = await invoke('pollFrameworkTools', { request: { issuerEpoch } })
      assert(object(result) && Array.isArray(result.calls))
      const pending = result.calls.find(value => object(value) && object(value.call) && value.call.name === name)
      if (pending !== undefined) { assert(object(pending) && typeof pending.ticket === 'string'); return pending }
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
    assert.fail('SDK tool request did not arrive')
  }
  for (const example of cases) {
    const before: number = adapter.requests
    adapter.responses.push('tool', ...example.terminal ? [] : ['silent' as const])
    agent.followup(createUserMessage({ source: { kind: 'user', rpcId: example.name }, content: original.content }))
    const call = await queuedCall()
    await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: call.ticket, result: example.result } })
    await agent.whenIdle()
    assert.equal(adapter.requests - before, example.terminal ? 1 : 2, example.name)
  }
  const invalidBefore = adapter.requests
  adapter.responses.push('invalid', 'tool')
  agent.followup(createUserMessage({ source: { kind: 'user', rpcId: 'invalid-input-correction' }, content: original.content }))
  const corrected = await queuedCall()
  await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: corrected.ticket,
    result: { status: 'confirmed', value: { status: 'sent', receipts: [{ status: 'confirmed' }] } } } })
  await agent.whenIdle()
  assert.equal(adapter.requests - invalidBefore, 2, 'invalid input permits a corrected tool call inside the original turn')
  const siblingBefore = adapter.requests
  const turnsBefore = terminal.length
  adapter.responses.push('siblings')
  agent.followup(createUserMessage({ source: { kind: 'user', rpcId: 'sibling-drain' }, content: original.content }))
  const reply = await queuedCall()
  await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: reply.ticket,
    result: { status: 'confirmed', value: { status: 'sent', receipts: [{ status: 'confirmed' }] } } } })
  const sibling = await queuedCall('qbf_sibling')
  assert.equal(terminal.length, turnsBefore, 'a concluded reply does not abort the other submitted tool')
  await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: sibling.ticket, result: { status: 'confirmed', value: 'drained' } } })
  await agent.whenIdle()
  assert.equal(terminal.length, turnsBefore + 1)
  assert.equal(adapter.requests - siblingBefore, 1, 'the tool batch drains without an extra model acknowledgement')
})
