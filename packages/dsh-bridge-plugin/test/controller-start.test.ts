import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { SessionCreateValue, SessionSelectModelValue } from '@deepseek-ai/dsh-api-session-controller'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import Llm, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Registry from '@deepseek-ai/dsh-typert-registry'
import type BridgePlugin from '../dist/index.js'

class NoGenerationAdapter extends LlmAdapter {
  streams = 0
  catalogs = 0

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.catalogs++
    return [{ provider, id: 'safe-fixture-model', name: 'Local metadata fixture' }]
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.streams++
    throw new Error('No model generation is permitted during session preparation')
  }
}

test('official session/create and selectModel publish the preset live agent before any prompt or generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qq-dsh-controller-start-'))
  const ctx = new Context()
  const adapter = new NoGenerationAdapter()
  try {
    const loader = ctx.plugin(Loader)
    for (const plugin of [Agents, Sessions, Projections, SystemPrompt, Tools, Llm, Registry, RemoteAccess, Gateway]) ctx.plugin(plugin)
    ctx.plugin(DefaultModel, { provider: 'safe-fixture', model: 'safe-fixture-model' })
    ctx.plugin(Presets, { default: 'chosen-group' })
    ctx.plugin(AgentLoop)
    ctx.plugin(SessionQuery, { path: ':memory:', openAt: 'never' })
    ctx.provide('fs', {})
    ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1,
      maxMessageImageBytes: 1024, maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'] } })
    ctx.provide('fileUploads', { registerAgentResolver: (_resolve: unknown) => () => {} })
    ctx.provide('workspaceRegistry', { archivedSessionIds: [], get: () => undefined, list: () => [] })
    const controller = ctx.plugin(SessionController, { nativeOpen: false })
    await loader.inertia
    await new Promise<void>(resolve => setImmediate(resolve))
    await controller.inertia
    assert(ctx.sessionController)
    ctx.llm.registerAdapter(['safe-fixture'], adapter)
    await ctx.agentPresets.register({ id: 'chosen-group', plugins: [] })
    await ctx.agentPresets.register({ id: 'chosen-private', plugins: [] })
    await ctx.loader.create({ name: import.meta.resolve('@qq-bridge-framework/dsh-bridge-plugin') })
    await ctx.loader.await()
    const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' })
    const invoke = (namespace: string, method: string, request?: Record<string, unknown>) => ctx.typertGateway.invoke({
      namespace, method, args: request === undefined ? {} : { request }, peer,
    })
    const discovered = await invoke('bridgePlugin', 'describe') as ReturnType<BridgePlugin['describe']>
    for (const preset of ['chosen-group', 'chosen-private']) {
      const created = await invoke('session', 'create', { cwd: directory, agentPreset: preset }) as SessionCreateValue
      assert.equal(created.agentPreset, preset)
      const agent = ctx.agents.get(created.sessionId)
      assert(agent, 'the stock create response must already have an actual registry agent')
      assert.equal(agent.session.id, created.sessionId)
      assert.equal(ctx.agentPresets.composedPreset(agent.ctx), preset)
      assert.equal(agent.status, 'idle')
      const initial = await invoke('bridgePlugin', 'inspectScope', { sessionId: created.sessionId, expectedPreset: preset, expectedNames: [] }) as ReturnType<BridgePlugin['inspectScope']>
      assert.equal(initial.state, 'verified-scope')
      assert.equal(initial.issuerEpoch, discovered.issuerEpoch)
      await assert.rejects(invoke('session', 'selectModel', { sessionId: created.sessionId, provider: 'safe-fixture',
        model: 'safe-fixture-model', reasoningEffort: 'off' }),
      error => error instanceof Error && 'code' in error && error.code === 'session/model-unavailable')
      assert.equal(ctx.agents.get(created.sessionId), agent)
      const selected = await invoke('session', 'selectModel', { sessionId: created.sessionId, provider: 'safe-fixture', model: 'safe-fixture-model' }) as SessionSelectModelValue
      assert.equal(selected.selected.model, 'safe-fixture-model')
      assert.equal(ctx.agents.get(created.sessionId), agent)
      const scope = await invoke('bridgePlugin', 'inspectScope', { sessionId: created.sessionId, expectedPreset: preset, expectedNames: [] }) as ReturnType<BridgePlugin['inspectScope']>
      assert.equal(scope.state, 'verified-scope')
      assert.equal(scope.issuerEpoch, discovered.issuerEpoch)
      const claims = await invoke('bridgePlugin', 'claimReceipts', { sessionId: created.sessionId, issuerEpoch: discovered.issuerEpoch }) as ReturnType<BridgePlugin['claimReceipts']>
      assert.deepEqual(claims.receipts, [])
      assert.equal(agent.session.snapshotEvents().some(event => ['turn/start', 'user/message', 'request/header', 'assistant/message'].includes(event.type)), false)
    }
    assert(adapter.catalogs >= 2)
    assert.equal(adapter.streams, 0)
    await peer.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
