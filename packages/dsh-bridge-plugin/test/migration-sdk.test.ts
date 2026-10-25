import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import Agents, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import Llm, { createAssistantMessage, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk, type LlmResolvedModelInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import Workspaces from '@deepseek-ai/dsh-workspace'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Registry from '@deepseek-ai/dsh-typert-registry'
import type BridgePlugin from '../dist/index.js'
import type { DshExecutionEvidence } from '../dist/execution-evidence-protocol.js'
import { migrationDigest } from '../dist/migration-journal.js'
import { prepareSdkMigration } from '../dist/migration-runtime.js'
import type { ForkPreviewResult, ForkWithPresetRequest, ForkWithPresetResult } from '../dist/migration-protocol.js'

class OfflineAdapter extends LlmAdapter {
  calls = 0
  targetWindow = 8192
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: 'Offline migration metadata', context: { contextWindow: this.targetWindow }, defaultMaxTokens: 1024,
      reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high') } }
  }
  override async listModels() { return [] }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    throw new Error('不允许模型调用。')
  }
}

test('real SDK owner fork preserves completed text, target model selection, workspace and durable source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qaf-migration-sdk-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  ctx.logger.exporter({ export(message) { if (message.type === 'error') console.error(...message.args) } })
  const adapter = new OfflineAdapter()
  try {
    const loader = ctx.plugin(Loader)
    for (const plugin of [Agents, Sessions, Projections, SystemPrompt, Tools, Llm, Registry, RemoteAccess, Gateway, Storage]) ctx.plugin(plugin)
    ctx.plugin(StorageJson, { root: join(directory, 'domain') })
    ctx.plugin(Domain, { backend: 'json' })
    const persistence = ctx.plugin(Persistence, { root: join(directory, 'sessions'), compression: 'none' })
    const workspaces = ctx.plugin(Workspaces)
    ctx.plugin(Presets, { default: 'old' })
    ctx.plugin(AgentLoop)
    ctx.plugin(Query, { path: ':memory:', openAt: 'never' })
    ctx.provide('tokenMeter', {})
    ctx.provide('fs', {})
    ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1,
      maxMessageImageBytes: 1024, maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'] } })
    ctx.provide('fileUploads', { registerAgentResolver: () => () => {} })
    ctx.plugin(SessionController, { nativeOpen: false })
    const provider = { api: 'openai-responses', baseURL: 'http://127.0.0.1:1',
      models: [{ id: 'fixture-model', contextWindow: 4096, maxTokens: 512, reasoningEfforts: false }] }
    const routes = { 'old-route': { ...provider, apiKeyEnv: 'FIXTURE_OLD_KEY' },
      'new-route': { ...provider, apiKeyEnv: 'FIXTURE_NEW_KEY' }, 'next-route': { ...provider, apiKeyEnv: 'FIXTURE_NEXT_KEY' } }
    const profiles = createVolatile(routes)
    const credentialValues = new Map(Object.values(routes).map(route => [route.apiKeyEnv, 'offline-identical-key']))
    ctx.provide('credentials', { async resolve(reference: string) {
      const value = credentialValues.get(reference)
      return value === undefined ? undefined : { value, source: 'fixture' }
    } })
    ctx.provide('configEditor', { configuration: () => [{ entry: { options: { name: '@deepseek-ai/dsh-llm-pi-ai' },
      fiber: { config: { providers: profiles } } } }] })
    await loader.inertia
    ctx.loader.builtins.group = Group
    await persistence.inertia
    await workspaces.inertia
    await new Promise<void>(resolve => setImmediate(resolve))
    ctx.llm.registerAdapter(['old-route', 'new-route', 'next-route'], adapter)
    for (const id of ['old', 'new', 'next']) {
      await ctx.agentPresets.register({ id, plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: `${id} instructions`, complete: true, includeRuntimeContext: false } },
        { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
          { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {
            auto: true, headroomTokens: 0, maxTokens: 512, summarizationProvider: `${id}-route`, summarizationModel: 'fixture-model' } },
        ] },
      ] })
    }
    await ctx.loader.create({ name: import.meta.resolve('@qq-agent-framework/dsh-bridge-plugin') })
    await ctx.loader.await()
    const workspace = await ctx.workspaceRegistry.create(directory)
    const sourceHandle = await ctx.agents.create({ sessionId: SessionId('text-source'), meta: { cwd: directory, agentPreset: 'old' },
      agentOptions: { provider: 'old-route', model: 'fixture-model' }, setup: async (agentCtx, agent) => {
        installModelSelection(agentCtx, { current: { provider: 'old-route', model: 'fixture-model' }, assembled: undefined })
        await ctx.agentPresets.mount(agentCtx, 'old')
        agent.session.append('agent-preset/selected', { agentPreset: 'old' })
      } })
    const source = sourceHandle.agent
    source.session.append('turn/start', { turn: 1 })
    source.session.append('step/start', { turn: 1, step: 1 })
    source.session.append('request/header', { reason: 'initial', header: { config: { provider: 'old-route', model: 'fixture-model' } } })
    source.session.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: 'original-qq-request' }, content: [{ type: 'text', text: '离线原始问题' }] }), { surfaceOp: 'append' })
    source.session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'old-route', model: 'fixture-model' }, content: [{ type: 'text', text: '离线已完成答复' }] }), stream: [] }, { surfaceOp: 'append' })
    source.session.append('step/end', { turn: 1, step: 1 })
    source.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessionPersistence.flush()
    await workspace.attachSession(source.id)
    const original = source.session.snapshotEvents()
    const before = migrationDigest(original)
    const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' })
    const invoke = (method: string, request: object) => ctx.typertGateway.invoke({ namespace: 'bridgePlugin', method, args: { request }, peer })
    const evidenceRequest = { sessionId: source.id, requestId: 'original-qq-request' }
    assert.throws(() => ctx.bridgePlugin.inspectExecution(evidenceRequest), /authenticated DSH owner/)
    await assert.rejects(ctx.agents.withInitiator(source, () => invoke('inspectExecution', evidenceRequest)), /authenticated DSH owner/)
    const evidence = await invoke('inspectExecution', evidenceRequest) as DshExecutionEvidence
    assert.equal(evidence.state, 'settled', JSON.stringify(evidence))
    assert.equal(evidence.outcome, 'completed')
    assert.equal(evidence.matchedTurn, 1)
    assert.equal(evidence.matchedUserMessageId, original.find(event => event.type === 'user/message')!.data.id)
    assert.match(evidence.checkpointHash!, /^[a-f0-9]{64}$/)
    const absentEvidence = await invoke('inspectExecution', { ...evidenceRequest, requestId: 'unknown-request' }) as DshExecutionEvidence
    assert.equal(absentEvidence.state, 'not-observed')
    const mismatchedEvidence = await invoke('inspectExecution', { ...evidenceRequest, userMessageId: 'forged-message' }) as DshExecutionEvidence
    assert.deepEqual(mismatchedEvidence.missingReasons, ['execution_correlation_conflict'])
    assert.equal(adapter.calls, 0)
    const refs = { migrationId: 'real-sdk-text', sourceSessionId: source.id, expectedPreset: 'old', targetPreset: 'new' }
    assert.throws(() => ctx.bridgePlugin.forkPreview(refs), /authenticated DSH owner/)
    await assert.rejects(ctx.agents.withInitiator(source, () => invoke('forkPreview', refs)), /authenticated DSH owner/)
    await prepareSdkMigration(ctx, refs, new AbortController().signal)
    const preview = await invoke('forkPreview', refs) as ForkPreviewResult
    assert.deepEqual(preview.missingReasons, [])
    assert.equal(preview.state, 'available')
    const request: ForkWithPresetRequest = { ...refs, issuerEpoch: preview.issuerEpoch, expectedCursor: preview.sourceCursor!,
      expectedSourceDigest: preview.sourceDigest!, expectedTargetRevision: preview.targetRevision! }
    const result = await invoke('forkWithPreset', request) as ForkWithPresetResult
    assert.deepEqual(result.missingReasons, [])
    assert.equal(result.state, 'completed')
    assert(result.childSessionId && result.childSessionId !== source.id)
    const child = ctx.agents.get(SessionId(result.childSessionId))!
    assert(child)
    assert.equal(ctx.agentPresets.composedPreset(child.ctx), 'new')
    assert.equal(child.session.header.parentSession, source.id)
    assert.equal(migrationDigest(child.session.snapshotEvents().slice(0, original.length)), before)
    assert.equal(migrationDigest(source.session.snapshotEvents()), before)
    assert(workspace.sessionIds.includes(child.id))
    const selected = child.session.snapshotEvents().findLast(event => event.type === 'model/selection')
    assert.equal(selected?.data.provider, 'new-route')
    assert.equal(ctx.sessionProjections.stateOf(child.session, 'agentPreset'), 'new')
    assert.equal((await invoke('forkWithPreset', request) as ForkWithPresetResult).idempotency, 'replayed')
    assert.equal((await invoke('inspectMigration', request) as ForkWithPresetResult).childSessionId, child.id)
    const persisted = await ctx.sessionPersistence.open(child.id, 'read')
    assert.equal(migrationDigest((await persisted.read()).events), migrationDigest(child.session.snapshotEvents()))
    await persisted.close()
    const childPrefix = child.session.snapshotEvents()
    const repeatedRefs = { migrationId: 'second-generation', sourceSessionId: child.id, expectedPreset: 'new', targetPreset: 'next' }
    const repeatedPreview = await invoke('forkPreview', repeatedRefs) as ForkPreviewResult
    assert.deepEqual(repeatedPreview.missingReasons, [])
    assert.equal(repeatedPreview.state, 'available')
    const repeated = await invoke('forkWithPreset', { ...repeatedRefs, issuerEpoch: repeatedPreview.issuerEpoch,
      expectedCursor: repeatedPreview.sourceCursor!, expectedSourceDigest: repeatedPreview.sourceDigest!,
      expectedTargetRevision: repeatedPreview.targetRevision! }) as ForkWithPresetResult
    assert.deepEqual(repeated.missingReasons, [])
    assert.equal(repeated.state, 'completed')
    assert(repeated.childSessionId)
    const grandchild = ctx.agents.get(SessionId(repeated.childSessionId))!
    assert.equal(grandchild.session.header.parentSession, child.id)
    assert.equal(ctx.agentPresets.composedPreset(grandchild.ctx), 'next')
    assert.equal(migrationDigest(grandchild.session.snapshotEvents().slice(0, childPrefix.length)), migrationDigest(childPrefix))
    assert.equal(migrationDigest(child.session.snapshotEvents()), migrationDigest(childPrefix))
    assert(workspace.sessionIds.includes(grandchild.id))
    assert.equal(grandchild.session.snapshotEvents().filter(event => event.type === 'request/header').length, 1)
    const grandchildSelection = grandchild.session.snapshotEvents().findLast(event => event.type === 'model/selection')
    assert.equal(grandchildSelection?.data.provider, 'next-route')
    const durableGrandchild = await ctx.sessionPersistence.open(grandchild.id, 'read')
    assert.equal(migrationDigest((await durableGrandchild.read()).events), migrationDigest(grandchild.session.snapshotEvents()))
    await durableGrandchild.close()
    const storedCount = (await ctx.sessionPersistence.list()).length
    async function blockedAlias() {
      const blocked = await invoke('forkPreview', { ...repeatedRefs, migrationId: 'changed-alias' }) as ForkPreviewResult
      assert.equal(blocked.state, 'blocked')
      assert.deepEqual(blocked.missingReasons, ['migration_model_changed'])
      assert.equal((await ctx.sessionPersistence.list()).length, storedCount)
    }
    updateVolatile(profiles, createVolatile({ ...routes, 'new-route': { ...routes['new-route'], api: 'openai-completions' } }))
    await blockedAlias()
    updateVolatile(profiles, createVolatile(routes))
    credentialValues.set('FIXTURE_NEW_KEY', 'offline-different-key')
    await blockedAlias()
    credentialValues.set('FIXTURE_NEW_KEY', 'offline-identical-key')
    child.session.append('model/selection', { provider: 'new-route', model: 'different-model' })
    await blockedAlias()
    child.session.append('model/selection', { provider: 'new-route', model: 'fixture-model', reasoningEffort: 'high' })
    await blockedAlias()
    child.session.append('model/selection', { provider: 'new-route', model: 'fixture-model' })
    assert.equal(adapter.calls, 0)
    assert.equal((await readFile(join(directory, 'storages', 'qaf-session-migrations', `${migrationDigest(refs.migrationId)}.json`), 'utf8')).includes('离线原始问题'), false)
    await chmod(directory, 0o777)
    const unsafe = await invoke('forkPreview', { ...refs, migrationId: 'unsafe-workspace' }) as ForkPreviewResult
    assert.equal(unsafe.state, 'blocked')
    assert.deepEqual(unsafe.missingReasons, ['migration_workspace_unverified'])
    await chmod(directory, 0o700)
    await sourceHandle.dispose()
    assert.equal(ctx.agents.get(source.id), undefined)
    const coldEvidence = await invoke('inspectExecution', evidenceRequest) as DshExecutionEvidence
    assert.equal(coldEvidence.state, 'settled', JSON.stringify(coldEvidence))
    assert.equal(coldEvidence.checkpointHash, evidence.checkpointHash)
    const recoveryRefs = { migrationId: 'same-preset-execution-recovery', sourceSessionId: source.id, expectedPreset: 'old', targetPreset: 'old' }
    const recoveryPreview = await invoke('forkPreview', recoveryRefs) as ForkPreviewResult
    assert.equal(recoveryPreview.state, 'available', JSON.stringify(recoveryPreview))
    const recovery = await invoke('forkWithPreset', { ...recoveryRefs, issuerEpoch: recoveryPreview.issuerEpoch,
      expectedCursor: recoveryPreview.sourceCursor!, expectedSourceDigest: recoveryPreview.sourceDigest!, expectedTargetRevision: recoveryPreview.targetRevision! }) as ForkWithPresetResult
    assert.equal(recovery.state, 'completed', JSON.stringify(recovery))
    assert(recovery.childSessionId && recovery.childSessionId !== source.id)
    const recoveryChild = ctx.agents.get(SessionId(recovery.childSessionId))!
    assert.equal(recoveryChild.session.header.parentSession, source.id)
    assert.equal(ctx.agentPresets.composedPreset(recoveryChild.ctx), 'old')
    assert.equal(recoveryChild.options.provider, 'old-route')
    assert.equal(recoveryChild.options.model, 'fixture-model')
    assert.equal(migrationDigest(recoveryChild.session.snapshotEvents().slice(0, original.length)), before)
    const recoveryDurable = await ctx.sessionPersistence.open(recoveryChild.id, 'read')
    try { assert.equal(migrationDigest((await recoveryDurable.read()).events), migrationDigest(recoveryChild.session.snapshotEvents())) }
    finally { await recoveryDurable.close() }
    const originalDurable = await ctx.sessionPersistence.open(source.id, 'read')
    try { assert.equal(migrationDigest((await originalDurable.read()).events), before) } finally { await originalDurable.close() }
    assert.equal(ctx.agents.get(source.id), undefined)
    const coldRefs = { ...refs, migrationId: 'cold-sdk-text' }
    const coldPreview = await invoke('forkPreview', coldRefs) as ForkPreviewResult
    assert.deepEqual(coldPreview.missingReasons, [])
    assert.equal(coldPreview.state, 'available')
    const cold = await invoke('forkWithPreset', { ...coldRefs, issuerEpoch: coldPreview.issuerEpoch,
      expectedCursor: coldPreview.sourceCursor!, expectedSourceDigest: coldPreview.sourceDigest!,
      expectedTargetRevision: coldPreview.targetRevision! }) as ForkWithPresetResult
    assert.deepEqual(cold.missingReasons, [])
    assert.equal(cold.state, 'completed')
    assert(cold.childSessionId && cold.childSessionId !== result.childSessionId)
    const coldChild = ctx.agents.get(SessionId(cold.childSessionId))!
    assert.equal(migrationDigest(coldChild.session.snapshotEvents().slice(0, original.length)), before)
    assert(workspace.sessionIds.includes(coldChild.id))
    const changedRoute = { ...provider, apiKeyEnv: 'FIXTURE_NEW_KEY', models: [{ id: 'next-model', contextWindow: 8192, maxTokens: 1024, reasoningEfforts: ['high'] }] }
    updateVolatile(profiles, createVolatile({ ...routes, 'changed-route': changedRoute }))
    ctx.llm.registerAdapter(['changed-route'], adapter)
    await ctx.agentPresets.register({ id: 'changed', plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'Updated model instructions', complete: true, includeRuntimeContext: false } },
      { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {
          auto: true, headroomTokens: 0, maxTokens: 1024, summarizationProvider: 'changed-route', summarizationModel: 'next-model' } },
      ] },
    ] })
    const targetSelection = { provider: 'changed-route', model: 'next-model', reasoningEffort: 'high',
      contextLimits: { contextWindow: 8192, maxTokens: 1024, headroomTokens: 0 } }
    const changedRefs = { migrationId: 'controlled-model-capacity', sourceSessionId: source.id, expectedPreset: 'old', targetPreset: 'changed', targetSelection }
    await prepareSdkMigration(ctx, changedRefs, new AbortController().signal)
    const changedPreview = await invoke('forkPreview', changedRefs) as ForkPreviewResult
    assert.equal(changedPreview.state, 'available', JSON.stringify(changedPreview))
    const changedRequest: ForkWithPresetRequest = { ...changedRefs, issuerEpoch: changedPreview.issuerEpoch, expectedCursor: changedPreview.sourceCursor!,
      expectedSourceDigest: changedPreview.sourceDigest!, expectedTargetRevision: changedPreview.targetRevision! }
    const driftRefs = { ...changedRefs, migrationId: 'capacity-metadata-drift' }
    const driftPreview = await invoke('forkPreview', driftRefs) as ForkPreviewResult
    assert.equal(driftPreview.state, 'available')
    adapter.targetWindow = 4096
    const driftResult = await invoke('forkWithPreset', { ...driftRefs, issuerEpoch: driftPreview.issuerEpoch, expectedCursor: driftPreview.sourceCursor!,
      expectedSourceDigest: driftPreview.sourceDigest!, expectedTargetRevision: driftPreview.targetRevision! }) as ForkWithPresetResult
    assert.equal(driftResult.state, 'rejected')
    assert.deepEqual(driftResult.missingReasons, ['migration_model_metadata_unverified'])
    adapter.targetWindow = 8192
    const changed = await invoke('forkWithPreset', changedRequest) as ForkWithPresetResult
    assert.equal(changed.state, 'completed', JSON.stringify(changed))
    assert.deepEqual(changed.targetSelection, targetSelection)
    const changedChild = ctx.agents.get(SessionId(changed.childSessionId!))!
    assert.equal(changedChild.options.provider, 'changed-route')
    assert.equal(changedChild.options.model, 'next-model')
    assert.equal(changedChild.options.reasoningEffort, 'high')
    assert.equal(changedChild.options.maxTokens, 1024)
    assert.equal(changedChild.session.header.parentSession, source.id)
    assert.equal(migrationDigest(changedChild.session.snapshotEvents().slice(0, original.length)), before)
    const changedDurable = await ctx.sessionPersistence.open(changedChild.id, 'read')
    try {
      assert.equal(changedDurable.inheritedEventCount, original.length)
      assert.equal(migrationDigest((await changedDurable.read()).events), migrationDigest(changedChild.session.snapshotEvents()))
    } finally { await changedDurable.close() }
    assert.equal((await invoke('inspectMigration', changedRequest) as ForkWithPresetResult).childSessionId, changedChild.id)
    const unsupportedReasoning = await invoke('forkPreview', { ...changedRefs, migrationId: 'reasoning-not-supported',
      targetSelection: { ...targetSelection, reasoningEffort: 'max' } }) as ForkPreviewResult
    assert.equal(unsupportedReasoning.state, 'blocked')
    assert.deepEqual(unsupportedReasoning.missingReasons, ['migration_reasoning_unverified'])
    const sourceAgain = await ctx.sessionPersistence.open(source.id, 'read')
    try { assert.equal(migrationDigest((await sourceAgain.read()).events), before) } finally { await sourceAgain.close() }
    coldChild.session.append('turn/start', { turn: 2 })
    const active = await invoke('forkPreview', { migrationId: 'active-source', sourceSessionId: coldChild.id,
      expectedPreset: 'new', targetPreset: 'old' }) as ForkPreviewResult
    assert.equal(active.state, 'blocked')
    assert.deepEqual(active.missingReasons, ['migration_source_not_idle'])
    coldChild.session.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: 'synthetic-close-request' }, content: [{ type: 'text', text: 'unfinished' }] }), { surfaceOp: 'append' })
    coldChild.session.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
    await ctx.sessionPersistence.flush()
    const synthetic = await invoke('inspectExecution', { sessionId: coldChild.id, requestId: 'synthetic-close-request' }) as DshExecutionEvidence
    assert.equal(synthetic.state, 'unavailable')
    assert.deepEqual(synthetic.missingReasons, ['execution_terminal_unverifiable'])
    assert.equal(adapter.calls, 0)
    await peer.dispose()
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
