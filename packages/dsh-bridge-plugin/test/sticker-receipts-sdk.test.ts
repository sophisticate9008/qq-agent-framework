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
class StickerAdapter extends LlmAdapter {
  requests = 0
  next: { name: string; input: unknown } | null = null
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    const call = this.next
    this.next = null
    if (call) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`sticker-call-${this.requests}`),
        name: call.name, arguments: JSON.stringify(call.input) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"schema":"qbf.reply/1","action":"silent","reason":"no-useful-addition"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('actual SDK collection and sending receipts close quietly, including validation, refusal and timeout', async context => {
  const ctx = new Context()
  const loader = ctx.plugin(Loader)
  const fibers = [Agents, Sessions, Projections, SystemPrompt, Tools, Llm, Registry, RemoteAccess, Gateway].map(plugin => ctx.plugin(plugin))
  fibers.push(ctx.plugin(Presets, { default: 'fixture' }), ctx.plugin(AgentLoop))
  await Promise.all(fibers.map(fiber => fiber.inertia))
  await loader.inertia
  await ctx.loader.create({ name: import.meta.resolve('@qq-bridge-framework/dsh-bridge-plugin') })
  await ctx.loader.await()
  await new Promise<void>(resolve => setImmediate(resolve))
  const adapter = new StickerAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('sticker-receipts-sdk'), agentOptions: { provider: 'fixture', model: 'model' } })
  const agent = handle.agent
  const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' })
  context.after(async () => { await handle.dispose(); await peer.dispose(); await ctx.fiber.dispose() })
  const invoke = (method: string, args: Record<string, unknown> = {}) => ctx.typertGateway.invoke({ namespace: 'bridgePlugin', method, args, peer })
  const described = await invoke('describe')
  assert(object(described) && typeof described.issuerEpoch === 'string')
  const issuerEpoch = described.issuerEpoch
  await invoke('installFrameworkTools', { request: { issuerEpoch, sessionId: agent.id, generation: 1, tools: [
    { name: 'qbf_reply', description: 'Reply fixture', timeoutMs: 5000,
      parameters: { type: 'object', required: ['content'], additionalProperties: false, properties: { content: { type: 'string' } } } },
    { name: 'qbf_sticker_send', description: 'Send fixture', timeoutMs: 100,
      parameters: { type: 'object', required: ['intent'], additionalProperties: false, properties: { intent: { type: 'string' } } } },
    { name: 'qbf_sticker_manage', description: 'Collect fixture', timeoutMs: 100,
      parameters: { type: 'object', required: ['action', 'assetId'], additionalProperties: false,
        properties: { action: { type: 'string' }, assetId: { type: 'string' } } } },
  ] } })
  const sources: string[] = []
  ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'user/message') sources.push(event.data.source.kind)
  })
  const content = [{ type: 'text' as const, text: '会话事实：\n'
    + JSON.stringify({ senderId: 'ordinary-member', conversationId: 'group:fixture', participation: 'direct' }) + '当前消息：\n收藏或者发一张表情' }]
  async function queuedCall() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await invoke('pollFrameworkTools', { request: { issuerEpoch } })
      assert(object(result) && Array.isArray(result.calls))
      if (result.calls.length) {
        const pending = result.calls[0]
        assert(object(pending) && typeof pending.ticket === 'string')
        return pending
      }
      await new Promise<void>(resolve => setTimeout(resolve, 2))
    }
    assert.fail('SDK sticker call did not arrive')
  }
  for (const name of ['qbf_sticker_send', 'qbf_sticker_manage']) {
    const input = name === 'qbf_sticker_send' ? { intent: '开心' } : { action: 'add', assetId: 'registered' }
    for (const result of [
      { status: 'confirmed', value: { status: 'sent' } },
      { status: 'confirmed', value: { status: 'skipped', quiet: true } },
      { status: 'confirmed', value: { status: 'rejected', errorCode: 'STICKER_FILTERED' } },
      { status: 'rejected', code: 'POLICY_DENIED' },
      { status: 'unknown', code: 'TOOL_EXECUTION_UNKNOWN' },
    ]) {
      const before = adapter.requests
      adapter.next = { name, input }
      agent.followup(createUserMessage({ source: { kind: 'user', rpcId: `sticker-${before}` }, content }))
      const pending = await queuedCall()
      await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: pending.ticket, result } })
      await agent.whenIdle()
      assert.equal(adapter.requests - before, 1, `${name}:${result.status}:${JSON.stringify(result)}`)
    }
    for (const invalid of [false, true]) {
      const before = adapter.requests
      adapter.next = { name, input: invalid ? name === 'qbf_sticker_send' ? {} : { action: 'add' } : input }
      agent.followup(createUserMessage({ source: { kind: 'user', rpcId: `sticker-${before}` }, content }))
      if (!invalid) {
        const pending = await queuedCall()
        await agent.whenIdle()
        const late = await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: pending.ticket,
          result: { status: 'confirmed', value: { status: 'sent' } } } })
        assert(object(late) && late.accepted === false, 'late receipts are discarded')
      } else await agent.whenIdle()
      assert.equal(adapter.requests - before, 1, `${name}:${invalid ? 'invalid-input' : 'timeout'}`)
    }
  }
  for (const action of ['annotate', 'delete', 'describe']) {
    const before = adapter.requests
    adapter.next = { name: 'qbf_sticker_manage', input: { action, assetId: 'registered' } }
    agent.followup(createUserMessage({ source: { kind: 'user', rpcId: `manage-${before}` }, content }))
    const pending = await queuedCall()
    await invoke('completeFrameworkTool', { request: { issuerEpoch, ticket: pending.ticket,
      result: { status: 'confirmed', value: { status: 'confirmed' } } } })
    await agent.whenIdle()
    assert.equal(adapter.requests - before, 2, `${action} does not terminate an ordinary tool workflow`)
  }
  assert(!sources.includes('qbf-reply-decision-repair'), 'collection and sending never request a follow-up decision')
})
