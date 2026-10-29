import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AttachmentStore, AttachmentId, type ImageAttachmentRef, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import Llm, { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { createPluginModelChannel } from '../dist/plugin-model.js'

class ModelAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) {
    if (model === 'broken') throw new Error('Fixture model configuration unavailable')
    return { provider, id: model, name: 'Fixture', inputModalities: model === 'vision' ? ['text' as const, 'image' as const] : ['text' as const], defaultMaxTokens: 128 }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture answer' } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64')
class FixtureAttachments extends AttachmentStore {
  readonly imageLimits = { maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096,
    maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png' as const] }
  readonly saved = new Map<string, Uint8Array>()
  constructor(ctx: Context) { super(ctx) }
  override async validateImage(input: SaveImageAttachment) {
    assert.equal(input.mediaType, 'image/png')
    assert(Buffer.from(input.data).equals(PNG))
  }
  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    await this.validateImage(input)
    const attachmentId = AttachmentId('sha256:' + createHash('sha256').update(input.data).digest('hex'))
    this.saved.set(attachmentId, input.data)
    return { attachmentId, mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1 }
  }
  override async readImage(ref: ImageAttachmentRef) {
    const data = this.saved.get(ref.attachmentId)
    assert(data)
    return { ref, data }
  }
}

test('SDK plugin sessions remain readable, resume history and exclude global complete persona, required context and all tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-plugin-model-'))
  const ctx = new Context()
  const adapter = new ModelAdapter()
  let channel: ReturnType<typeof createPluginModelChannel> | undefined
  try {
    const loader = ctx.plugin(Loader)
    const fibers = [Agents, Sessions, Projections, SystemPrompt, Tools, Llm, FixtureAttachments].map(plugin => ctx.plugin(plugin))
    fibers.push(ctx.plugin(Presets, { default: 'fixture' }), ctx.plugin(AgentLoop), ctx.plugin(Query, { path: ':memory:', openAt: 'never' }))
    const persistence = ctx.plugin(Persistence, { root: join(directory, 'sessions'), compression: 'none' })
    await loader.inertia
    await Promise.all(fibers.map(fiber => fiber.inertia))
    await persistence.inertia
    ctx.provide('settings', { describe: () => [{ ns: 'fixture-config', value: { models: [{ id: 'fixture-model' }, { id: 'vision' }, { id: 'broken' }] } }] })
    ctx.llm.registerAdapter(['fixture'], adapter)
    ctx.llm.registerConfigurableProviders([{ provider: 'fixture', displayName: 'Fixture', settingsNs: 'fixture-config', settingsPath: [] }])
    ctx.systemPrompt.section({ name: 'deployment-persona', order: 0, text: 'QQ_PERSONA_MUST_BE_ABSENT', complete: true })
    ctx.systemPrompt.context({ name: 'required-runtime', order: 0, text: 'REQUIRED_CONTEXT_MUST_BE_ABSENT', required: true })
    let toolExecutions = 0
    ctx.tools.register({ name: 'global_fixture', description: 'Must be unavailable', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: () => [] },
      execute: async () => { toolExecutions++; return 'unexpected' } })
    const owner = ctx.plugin({ name: 'plugin-model-sdk-owner', inject: ['agents', 'tools'],
      apply(ownerContext: Context) { channel = createPluginModelChannel(ownerContext) } })
    await owner.inertia
    assert(channel)
    const signal = AbortSignal.timeout(10_000), sessionId = 'qbf-plugin-readable-sdk'
    await channel.create({ sessionId, owner: 'fixture-plugin', model: { provider: 'fixture', model: 'fixture-model' } }, signal)
    const observed = await ctx.sessionQuery.observeSession(SessionId(sessionId), { signal })
    assert.equal(observed.header.cwd, process.cwd())
    assert(observed.events.some(event => pluginRecordOf(event)?.type === 'plugin:qbf/model-session' && event.ignorable === true))
    observed[Symbol.dispose]()
    const agent = ctx.agents.get(SessionId(sessionId))!
    agent.ctx.systemPrompt.section({ name: 'sdk-local-file-reference', order: 10, text: 'LOCAL_SDK_PROMPT_MUST_BE_ABSENT' })
    agent.ctx.systemPrompt.context({ name: 'sdk-local-directory', order: 10, text: 'SDK_REQUIRED_DIRECTORY_FACT', required: true })
    agent.ctx.tools.register({ name: 'scoped_fixture', description: 'Must also be unavailable', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: () => [] },
      execute: async () => { toolExecutions++; return 'unexpected' } })
    let denied = false
    const checkGuard = agent.ctx.on('agent/request', async (_event, next) => {
      const result = await agent.ctx.tools.execute({ agent, callId: ToolCallId('guard-probe'), name: 'scoped_fixture', arguments: {}, signal })
      denied = result.isError === true
      return next()
    })
    await channel.start({ sessionId, requestId: 'first', owner: 'fixture-plugin', prompt: 'First context marker' }, signal)
    await channel.waitIdle({ sessionId, requestId: 'first' }, signal)
    checkGuard()
    assert(denied)
    assert.equal(toolExecutions, 0)
    assert.equal(ctx.agents.get(SessionId(sessionId)), undefined, 'owned handles are released after durable idle')
    const first = await channel.inspectRun({ sessionId, requestId: 'first', owner: 'fixture-plugin' }, signal)
    assert.equal(first.state, 'completed')
    assert.equal(first.idle, true)
    assert.equal(first.usage.usageSteps.length, 1)
    await channel.start({ sessionId, requestId: 'second', owner: 'fixture-plugin', prompt: 'Second context marker' }, signal)
    await channel.waitIdle({ sessionId, requestId: 'second' }, signal)
    assert.equal(adapter.requests.length, 2)
    for (const request of adapter.requests) {
      assert.equal(request.tools?.length ?? 0, 0)
      const wire = JSON.stringify(request.messages)
      assert(!wire.includes('QQ_PERSONA_MUST_BE_ABSENT'))
      assert(!wire.includes('REQUIRED_CONTEXT_MUST_BE_ABSENT'))
      assert(!wire.includes('LOCAL_SDK_PROMPT_MUST_BE_ABSENT'))
    }
    assert(JSON.stringify(adapter.requests[1]!.messages).includes('First context marker'))
    assert(JSON.stringify(adapter.requests[1]!.messages).includes('fixture answer'))
    assert.deepEqual(await channel.start({ sessionId, requestId: 'text-model-image', owner: 'fixture-plugin', prompt: 'Inspect image',
      images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }] }, signal), { accepted: false, code: 'PLUGIN_MODEL_IMAGE_UNSUPPORTED' })
    assert.equal(adapter.requests.length, 2)
    await channel.start({ sessionId, requestId: 'native-image', owner: 'fixture-plugin', prompt: 'Inspect native image',
      model: { provider: 'fixture', model: 'vision' }, images: [{ mediaType: 'image/png', data: PNG.toString('base64') }] }, signal)
    await channel.waitIdle({ sessionId, requestId: 'native-image' }, signal)
    assert.equal(adapter.requests.length, 3)
    const imageBlocks = adapter.requests[2]!.messages.flatMap(message => message.content.filter(block => block.type === 'image'))
    assert.equal(imageBlocks.length, 1)
    assert.equal(imageBlocks[0]!.attachment.mediaType, 'image/png')
    assert.equal(JSON.stringify(adapter.requests[2]!.messages).includes(PNG.toString('base64')), false, 'encoded bytes never masquerade as model-visible text')
    await channel.start({ sessionId, requestId: 'before-user-failure', owner: 'fixture-plugin', prompt: 'Configuration failure',
      model: { provider: 'fixture', model: 'broken' } }, signal)
    await channel.waitIdle({ sessionId, requestId: 'before-user-failure' }, signal)
    const failure = await channel.inspectRun({ sessionId, requestId: 'before-user-failure', owner: 'fixture-plugin' }, signal)
    assert.equal(failure.state, 'failed', 'inbox consumption proves the failed turn even before user/message admission')
    assert.equal(failure.idle, true)
  } finally {
    await channel?.close()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
