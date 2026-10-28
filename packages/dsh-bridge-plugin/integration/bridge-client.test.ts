import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Llm, { LlmAdapter, ReasoningEffortId, ToolCallId, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import Registry from '@deepseek-ai/dsh-typert-registry'
import { RECEIPT_LIMITS } from '@qq-agent-framework/dsh-bridge-plugin/protocol'
import type { ClaimReceiptPage, ClaimReceiptQuery } from '../dist/receipts.js'
import type { DshToolScopeRequest } from '../dist/tool-scope.js'
import type BridgePlugin from '../dist/index.js'
import type { DshExecutionEvidence, DshExecutionEvidenceRequest } from '../dist/execution-evidence-protocol.js'
import type { FrameworkToolInstall, FrameworkToolOutcome } from '../dist/framework-tools.js'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import Subagents from '@deepseek-ai/dsh-subagent'
import type { WorkAddress, WorkStart, WorkTarget } from '../dist/work.js'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'

interface FrameworkClient {
  work: {
    readAsset?(request: WorkAddress & {kind:'image'|'file';attachmentId:string},signal:AbortSignal):Promise<{asset:unknown;data:Uint8Array}>
    verify(request: WorkTarget & { issuerEpoch: string }, signal: AbortSignal): Promise<boolean>
    start(request: WorkStart, signal: AbortSignal): Promise<{ state: string; childId: string; result: unknown; error: string | null }>
    inspect(request: WorkAddress, signal: AbortSignal): Promise<{ state: string; childId: string; result: unknown; error: string | null }>
    followup(request: WorkAddress & { requestId: string; text: string; delivery: 'queue' | 'steer' }, signal: AbortSignal): Promise<{ messageId: string }>
    interrupt(request: WorkAddress, signal: AbortSignal): Promise<void>
  }
  frameworkTools: {
    inspect(request: { issuerEpoch: string; sessionId: string }, signal: AbortSignal): Promise<{ leaseId: string; generation: number; names: readonly string[] } | null>
    install(request: FrameworkToolInstall, signal: AbortSignal): Promise<{ leaseId: string; names: readonly string[] }>
    poll(request: { issuerEpoch: string }, signal: AbortSignal): Promise<readonly {
      ticket: string; leaseId: string; call: { id: string; sessionId: string; generation: number; requestId: string; userMessageId: string; turn: number; name: string; input: unknown }
    }[]>
    complete(request: { issuerEpoch: string; ticket: string; result: FrameworkToolOutcome }, signal: AbortSignal): Promise<boolean>
    withdraw(request: { issuerEpoch: string; sessionId: string; leaseId: string }, signal: AbortSignal): Promise<boolean>
  }
  bridgePlugin: {
    describe(signal: AbortSignal): Promise<ReturnType<BridgePlugin['describe']>>
    inspectExecution(request: DshExecutionEvidenceRequest, issuerEpoch: string, signal: AbortSignal): Promise<DshExecutionEvidence>
    inspectScope(request: DshToolScopeRequest, issuerEpoch: string, signal: AbortSignal): Promise<ReturnType<BridgePlugin['inspectScope']>>
    claimReceipts(request: ClaimReceiptQuery & { issuerEpoch: string }, signal: AbortSignal): Promise<ClaimReceiptPage>
  }
  createSession(request: { conversationId: string; requestId: string; signal: AbortSignal }): Promise<{ ok: true; value: { sessionId: string } } | { ok: false; error: { code: string } }>
  prompt(request: { sessionId: string; requestId: string; mode: 'queue'; content: { type: 'text'; text: string }[]; signal: AbortSignal }): Promise<{ ok: boolean }>
  close(): Promise<void>
}

interface FrameworkSessionRegistry {
  resolve(conversationId: string, signal: AbortSignal): Promise<{ sessionId: string }>
  get(conversationId: string): unknown
  list(): readonly { state: string }[]
}

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

class LocalFailureAdapter extends LlmAdapter {
  mediaTool = false
  mediaImageInput = false
  mediaToolRequests = 0
  mediaSeen: readonly unknown[] = []
  workOutput = false
  workMedia = false
  workHold = false
  streams = 0
  readonly dispatchedEfforts: (string | undefined)[] = []
  supportsOff = false
  catalogMode: 'normal' | 'missing-model' | 'lookup-failure' | 'high-only' = 'normal'
  raceToHigh = false
  raceResolutions = 0
  recheckMode: 'normal' | 'high-no-default' | 'off-high' | 'invalid' | 'lookup-failure' | 'missing-model' = 'normal'
  recheckResolutions = 0
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalogMode === 'missing-model' || this.recheckMode === 'missing-model' && this.recheckResolutions >= 2
      ? [] : [{ provider, id: 'safe-model', name: 'Local deterministic failure fixture' }]
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.recheckResolutions++
    if (this.mediaTool) return { provider, id: model, name: 'Media fixture', inputModalities: this.mediaImageInput ? ['text', 'image'] : ['text'],
      reasoning: { efforts: [{id:ReasoningEffortId('off'),name:'Off'}], defaultEffort:ReasoningEffortId('off') } }
    if (this.catalogMode === 'lookup-failure') throw new Error('LOCAL_METADATA_UNAVAILABLE')
    const base = { provider, id: model, name: 'Local deterministic failure fixture' }
    if (this.recheckMode === 'high-no-default' && this.recheckResolutions >= 2) {
      return { ...base, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } }
    }
    if (this.recheckResolutions >= 3) {
      if (this.recheckMode === 'lookup-failure') throw new Error('LOCAL_RECHECK_UNAVAILABLE')
      if (this.recheckMode === 'invalid') return { ...base, reasoning: { efforts: [] } }
      if (this.recheckMode === 'off-high') return { ...base, reasoning: {
        efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }],
        defaultEffort: ReasoningEffortId('high'),
      } }
    }
    if (this.catalogMode === 'high-only' || this.raceToHigh && ++this.raceResolutions >= 2) {
      return { provider, id: model, name: 'Local high-only metadata fixture', reasoning: {
        efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high'),
      } }
    }
    return { provider, id: model, name: 'Local deterministic failure fixture',
      ...(this.supportsOff ? { reasoning: {
        efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }],
        defaultEffort: ReasoningEffortId('high'),
      } } : {}) }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.streams++
    this.dispatchedEfforts.push(options.reasoningEffort)
    if (this.mediaTool) {
      const tool = [...options.messages].reverse().find(message => message.role === 'tool')
      if (!tool) {
        this.mediaToolRequests++
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`media-tool-${this.mediaToolRequests}`), name: 'qaf_media_read', arguments: JSON.stringify({assetId:'opaque-image'}) } }
        yield { type: 'finish', reason: {kind:'tool-calls'} }
      } else {
        this.mediaSeen = tool.content
        yield { type:'block-start',index:0,blockType:'text' }
        yield { type:'block-end',index:0,block:{type:'text',text:'MEDIA_TOOL_RESULT_OBSERVED'} }
        yield { type:'finish',reason:{kind:'stop'} }
      }
      return
    }
    if (this.workOutput) {
      if (this.workHold) {
        const control = options.signal
        assert(control, 'The real SDK must forward child cancellation to its model adapter.')
        await new Promise<void>(resolve => {
          if (control.aborted) resolve()
          else control.addEventListener('abort', () => resolve(), { once: true })
        })
        control.throwIfAborted()
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'LOCAL_SDK_WORK_RESULT' } }
      if (this.workMedia) {
        yield { type: 'block-start', index: 1, blockType: 'image' }
        yield { type: 'block-end', index: 1, block: { type: 'image', attachment: {
          attachmentId: AttachmentId('sdk-image'), bytes: 4, mediaType: 'image/png', width: 1, height: 1 } } }
        yield { type: 'block-start', index: 2, blockType: 'file' }
        yield { type: 'block-end', index: 2, block: { type: 'file', attachment: {
          attachmentId: AttachmentId('sdk-file'), bytes: 400000, name: 'result.txt' } } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    throw new Error('LOCAL_EXPECTED_MODEL_FAILURE')
  }
}

test('official plugin entry and actual framework HTTP client isolate claims, permissions, gaps and restart without replay', async context => {
  const modulePath = process.env.QQ_FRAMEWORK_DSH_PORT_MODULE
  assert(modulePath && isAbsolute(modulePath), 'Set an explicit absolute QQ_FRAMEWORK_DSH_PORT_MODULE for this integration test')
  const loaded: unknown = await import(pathToFileURL(modulePath).href)
  const factory = object(loaded).createDshJsonRpcPort
  assert(typeof factory === 'function')
  const frameworkUrl = pathToFileURL(modulePath)
  const extension = modulePath.endsWith('.js') ? '.js' : '.ts'
  const adapt = object(await import(new URL(`./dsh${extension}`, frameworkUrl).href)).createDshAdapter
  const createRegistry = object(await import(new URL(`../host/sessions${extension}`, frameworkUrl).href)).createSessionRegistry
  const createStore = object(await import(new URL(`../storage/sqlite${extension}`, frameworkUrl).href)).createSqliteStore
  assert(typeof adapt === 'function' && typeof createRegistry === 'function' && typeof createStore === 'function')
  const directory = await mkdtemp(join(tmpdir(), 'qq-dsh-client-integration-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const ctx = new Context()
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  const adapter = new LocalFailureAdapter()
  const clients: FrameworkClient[] = []
  try {
    const loader = ctx.plugin(Loader)
    for (const plugin of [Agents, Sessions, Projections, SystemPrompt, Tools, Llm, Registry, RemoteAccess, Gateway]) ctx.plugin(plugin)
    ctx.plugin(DefaultModel, { provider: 'safe-fixture', model: 'safe-model' })
    ctx.plugin(Presets, { default: 'chosen-group' })
    ctx.plugin(AgentLoop)
    ctx.plugin(SessionQuery, { path: ':memory:', openAt: 'never' })
    ctx.provide('fs', {})
    ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1,
      maxMessageImageBytes: 1024, maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'] },
      async saveImage(input:{data:Uint8Array;mediaType:string}) {
        assert.equal(input.mediaType,'image/png')
        assert(Buffer.from(input.data).equals(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHd8AAAAASUVORK5CYII=','base64')))
        return {attachmentId:AttachmentId('sdk-tool-image'),bytes:input.data.length,mediaType:'image/png',width:1,height:1}
      },
      async readImage(ref: {attachmentId:string}) { if(ref.attachmentId==='sdk-tool-image')return {data:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHd8AAAAASUVORK5CYII=','base64')}; assert.equal(ref.attachmentId,'sdk-image'); return {data:Buffer.from([1,2,3,4])} },
      async *readFileStream(ref: {attachmentId:string}) { assert.equal(ref.attachmentId,'sdk-file'); yield Buffer.alloc(400000,7) },
      async admitPromptContent(content: readonly unknown[]) {
        assert(content.every(part => object(part).type === 'text'))
        return content
      },
    })
    ctx.provide('fileUploads', { registerAgentResolver: (_resolve: unknown) => () => {},
      bindPrompt: (_agent: unknown, receipts: readonly unknown[]) => {
        assert.equal(receipts.length, 0)
        return { commit() {}, [Symbol.dispose]() {} }
      },
    })
    ctx.provide('workspaceRegistry', { archivedSessionIds: [], get: () => undefined, list: () => [] })
    const records = new Map<CredentialKey, CredentialRecord>()
    ctx.provide('credentials', { async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const updated = await mutate(records.get(key))
      if (updated !== undefined) records.set(key, updated)
      return records.get(key)
    } })
    const controller = ctx.plugin(SessionController, { nativeOpen: false })
    await loader.inertia
    await new Promise<void>(resolve => setImmediate(resolve))
    await controller.inertia
    assert(ctx.sessionController)
    ctx.llm.registerAdapter(['safe-fixture'], adapter)
    await ctx.agentPresets.register({ id: 'chosen-group', plugins: [] })
    await ctx.agentPresets.register({ id: 'chosen-private', plugins: [] })
    const entryPath = import.meta.resolve('@qq-agent-framework/dsh-bridge-plugin')
    const entryId = await ctx.loader.create({ name: entryPath })
    await ctx.loader.await()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).inertia
    await ctx.plugin(Connection).inertia
    const endpoint = ctx.webServer.getOrigin()
    const auth = new URL(ctx.connection.authenticatedUrl(endpoint)).searchParams.get('token')
    assert(auth)
    const definition = { planId: 'chat', personaId: 'fixture', instructions: 'Local fixture only.', persona: { identity: 'Fixture', style: 'Concise' },
      model: { provider: 'catalog-provider', name: 'safe-model', reasoningEffort: 'off' } }
    type SelectedDefinition = typeof definition & { readonly capabilitySelection?: {
      readonly schema: 1; readonly presetId: string; readonly revision: string
    } | null }
    const makeClient = (credential: string, selectedDefinition: SelectedDefinition = definition, bindingDefinition = selectedDefinition): FrameworkClient => {
      const created: unknown = factory({ endpoint, auth: credential, sessionDefinition: selectedDefinition, presetBindings: [
        { agentPreset: 'chosen-group', definition: bindingDefinition, externalProvider: 'safe-fixture', conversationKind: 'group' },
        { agentPreset: 'chosen-private', definition: bindingDefinition, externalProvider: 'safe-fixture', conversationKind: 'private' },
      ] })
      const port = object(created)
      assert(typeof port.createSession === 'function' && typeof port.prompt === 'function' && typeof port.close === 'function')
      for (const method of ['describe', 'inspectScope', 'claimReceipts']) assert(typeof object(port.bridgePlugin)[method] === 'function')
      const client = created as FrameworkClient
      clients.push(client)
      return client
    }
    const client = makeClient(auth)
    const signal = new AbortController().signal
    const port = client.bridgePlugin
    const discovered = await port.describe(signal)
    await assert.rejects(makeClient('cookie:operator=not-a-valid-cookie').bridgePlugin.describe(signal), error => {
      assert(error instanceof Error)
      assert(!error.message.includes('not-a-valid-cookie'))
      return true
    })
    const created = await client.createSession({ conversationId: 'group:fixture', requestId: 'group-create', signal })
    assert(created.ok)
    const sessionId = created.value.sessionId
    const agent = ctx.agents.get(SessionId(sessionId))
    assert(agent)
    const scope = await port.inspectScope({ sessionId, expectedPreset: 'chosen-group', expectedNames: [] }, discovered.issuerEpoch, signal)
    assert.equal(scope.state, 'verified-scope')
    assert.equal(adapter.streams, 0)
    const baseline = await port.claimReceipts({ sessionId, issuerEpoch: discovered.issuerEpoch }, signal)
    const prompted = await client.prompt({ sessionId, requestId: 'group-request', mode: 'queue', content: [{ type: 'text', text: 'LOCAL-CANARY-NOT-QQ' }], signal })
    assert(prompted.ok)
    await agent.whenIdle()
    assert.equal(adapter.dispatchedEfforts.at(-1), undefined)
    const query = { sessionId, issuerEpoch: discovered.issuerEpoch, after: baseline.head }
    const claimed = await port.claimReceipts(query, signal)
    assert.equal(claimed.state, 'page')
    assert.equal(claimed.receipts.length, 1)
    assert.equal(claimed.receipts[0]?.requestId, 'group-request')
    assert.equal(claimed.receipts[0]?.sessionId, sessionId)
    assert(!JSON.stringify(claimed).includes('LOCAL-CANARY'))
    assert(agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'error'))
    const again = await port.claimReceipts(query, signal)
    assert.equal(again.receipts[0]?.evidenceId, claimed.receipts[0]?.evidenceId)
    assert.deepEqual((await port.claimReceipts({ ...query, after: claimed.nextAfter }, signal)).receipts, [])
    assert((await client.prompt({ sessionId, requestId: 'group-request', mode: 'queue', content: [{ type: 'text', text: 'DUPLICATE-LOCAL-CANARY' }], signal })).ok)
    await agent.whenIdle()
    assert.equal(adapter.streams, 1)
    assert.deepEqual((await port.claimReceipts({ ...query, after: claimed.nextAfter }, signal)).receipts, [])
    const privateCreated = await client.createSession({ conversationId: 'private:fixture', requestId: 'private-create', signal })
    assert(privateCreated.ok)
    assert.deepEqual((await port.claimReceipts({ ...query, sessionId: privateCreated.value.sessionId }, signal)).receipts, [])
    const privateAgent = ctx.agents.get(SessionId(privateCreated.value.sessionId))
    assert(privateAgent)
    assert((await client.prompt({ sessionId: privateCreated.value.sessionId, requestId: 'group-request', mode: 'queue',
      content: [{ type: 'text', text: 'PRIVATE-LOCAL-CANARY' }], signal })).ok)
    await privateAgent.whenIdle()
    const privateClaims = await port.claimReceipts({ ...query, sessionId: privateCreated.value.sessionId }, signal)
    assert.equal(privateClaims.receipts.length, 1)
    assert.equal(privateClaims.receipts[0]?.requestId, 'group-request')
    assert.equal(privateClaims.receipts[0]?.sessionId, privateCreated.value.sessionId)
    assert.notEqual(privateClaims.receipts[0]?.evidenceId, claimed.receipts[0]?.evidenceId)
    assert.deepEqual((await port.claimReceipts({ ...query, after: claimed.nextAfter }, signal)).receipts, [])
    assert.equal((await port.inspectScope({ sessionId, expectedPreset: 'chosen-private' }, discovered.issuerEpoch, signal)).state, 'unverified')
    adapter.supportsOff = true
    const supported = await client.createSession({ conversationId: 'private:fixture', requestId: 'supports-off-create', signal })
    assert(supported.ok)
    const offAgent = ctx.agents.get(SessionId(supported.value.sessionId))
    assert(offAgent)
    assert(offAgent.session.snapshotEvents().some(event => event.type === 'model/selection' && event.data.reasoningEffort === 'off'))
    assert((await client.prompt({ sessionId: supported.value.sessionId, requestId: 'explicit-off-prompt', mode: 'queue',
      content: [{ type: 'text', text: 'LOCAL_EXPLICIT_OFF' }], signal })).ok)
    await offAgent.whenIdle()
    assert.equal(adapter.dispatchedEfforts.at(-1), 'off')
    assert.equal(ctx.agents.get(SessionId(sessionId)), agent)
    let creations = 0
    ctx.on('session/created', () => { creations++ })
    for (const mode of ['missing-model', 'lookup-failure', 'high-only'] as const) {
      adapter.catalogMode = mode
      const blocked = await client.createSession({ conversationId: 'group:fixture', requestId: `blocked-${mode}`, signal })
      assert(!blocked.ok)
      assert.equal(blocked.error.code, mode === 'high-only' ? 'DSH_REASONING_UNSUPPORTED' : 'DSH_MODEL_CAPABILITIES_UNVERIFIED')
      assert.equal(creations, 0)
    }
    adapter.catalogMode = 'normal'
    adapter.supportsOff = false
    adapter.raceToHigh = true
    await assert.rejects(client.createSession({ conversationId: 'group:fixture', requestId: 'race-high', signal }),
      error => error instanceof Error && 'code' in error && error.code === 'DSH_CREATE_CONFIGURATION_UNKNOWN')
    assert.equal(creations, 1)
    adapter.raceToHigh = false
    for (const mode of ['high-no-default', 'off-high', 'invalid', 'lookup-failure', 'missing-model'] as const) {
      await context.test(`official resolver post-selection off evidence: ${mode}`, async () => {
        adapter.recheckMode = mode
        adapter.recheckResolutions = 0
        const beforeCreations = creations
        const beforeStreams = adapter.streams
        const createdSessions: string[] = []
        const dispose = ctx.on('session/created', session => { createdSessions.push(session.id) })
        try {
          await assert.rejects(client.createSession({ conversationId: 'group:fixture', requestId: `recheck-${mode}`, signal }),
            error => error instanceof Error && 'code' in error && error.code === 'DSH_CREATE_CONFIGURATION_UNKNOWN')
          assert.equal(creations, beforeCreations + 1)
          assert.equal(adapter.streams, beforeStreams)
          const createdId = createdSessions[0]
          assert(createdId)
          const unconfirmed = ctx.agents.get(SessionId(createdId))
          assert(unconfirmed)
          const selections = unconfirmed.session.snapshotEvents().filter(event => event.type === 'model/selection')
          assert.equal(selections.length, 1)
          assert.equal(selections[0]?.data.reasoningEffort, undefined)
          assert(!unconfirmed.session.snapshotEvents().some(event => event.type === 'user/message' || event.type === 'turn/start'))
          if (mode === 'high-no-default') {
            const current = await ctx.llm.resolveModelInfo('safe-fixture', 'safe-model')
            assert.deepEqual(current.reasoning?.efforts.map(effort => effort.id), ['high'])
            assert.equal(current.reasoning?.defaultEffort, undefined)
          }
          adapter.recheckResolutions = 0
          const store = object(createStore({ filename: ':memory:' }))
          assert(typeof store.close === 'function')
          try {
            const registry = createRegistry({ store, agent: adapt(client) }) as FrameworkSessionRegistry
            const admitPrompt = async () => {
              const bound = await registry.resolve('group:unknown-fixture', signal)
              return client.prompt({ sessionId: bound.sessionId, requestId: `blocked-prompt-${mode}`, mode: 'queue',
                content: [{ type: 'text', text: 'MUST_NOT_BE_ADMITTED' }], signal })
            }
            await assert.rejects(admitPrompt(), error => error instanceof Error && 'code' in error && error.code === 'SESSION_CREATE_UNKNOWN')
            assert.equal(registry.get('group:unknown-fixture'), null)
            assert.equal(registry.list()[0]?.state, 'unknown')
            await assert.rejects(admitPrompt(), error => error instanceof Error && 'code' in error && error.code === 'SESSION_RECONCILIATION_REQUIRED')
            assert.equal(creations, beforeCreations + 2)
            assert.equal(adapter.streams, beforeStreams)
            assert.equal(createdSessions.length, 2)
            for (const unknownId of createdSessions) {
              const unknownAgent = ctx.agents.get(SessionId(unknownId))
              assert(unknownAgent)
              const events = unknownAgent.session.snapshotEvents()
              assert.equal(events.filter(event => event.type === 'model/selection').length, 1)
              assert(!events.some(event => event.type === 'user/message' || event.type === 'turn/start'))
            }
          } finally {
            store.close()
          }
          context.diagnostic(JSON.stringify({ mode, state: 'DSH_CREATE_CONFIGURATION_UNKNOWN',
            directCreates: 1, registryCreates: 1, registryState: 'unknown', repeatedAdmission: 'SESSION_RECONCILIATION_REQUIRED',
            selectionsPerSession: selections.length, streams: adapter.streams - beforeStreams }))
        } finally {
          dispose()
        }
      })
    }
    adapter.recheckMode = 'normal'
    assert.equal(ctx.agents.get(SessionId(sessionId)), agent)
    clock += RECEIPT_LIMITS.maxAgeMs
    const gap = await port.claimReceipts(query, signal)
    assert.equal(gap.state, 'cursor-gap')
    assert.deepEqual(gap.receipts, [])
    assert.equal(gap.absenceProven, false)
    await assert.rejects(port.claimReceipts({ ...query, limit: 129 }, signal))
    const entryFiber = ctx.loader.resolve(entryId).fiber
    assert(entryFiber)
    await entryFiber.dispose()
    ctx.loader.remove(entryId)
    await ctx.loader.create({ name: entryPath })
    await ctx.loader.await()
    assert.equal((await port.claimReceipts(query, signal)).state, 'unknown-epoch')
    await assert.rejects(port.inspectScope({ sessionId, expectedPreset: 'chosen-group' }, discovered.issuerEpoch, signal))
    const restarted = await port.describe(signal)
    assert.notEqual(restarted.issuerEpoch, discovered.issuerEpoch)
    const newBaseline = await port.claimReceipts({ sessionId, issuerEpoch: restarted.issuerEpoch }, signal)
    assert.deepEqual(newBaseline.receipts, [])
    assert.equal(newBaseline.absenceProven, false)
    await assert.rejects(port.claimReceipts({ sessionId, issuerEpoch: restarted.issuerEpoch }, AbortSignal.abort()))
    assert.equal(adapter.streams, 3)
    await context.test('versioned capability selection remains part of actual framework identity against the official SDK', async () => {
      const selection = { schema: 1 as const, presetId: 'operator-declaration', revision: 'a'.repeat(64) }
      const selectedDefinition = { ...definition, capabilitySelection: selection }
      let capabilityCreations = 0
      let toolExecutions = 0
      const dispose = ctx.on('session/created', () => { capabilityCreations++ })
      const streamsBefore = adapter.streams
      try {
        const incompatible: readonly [SelectedDefinition, SelectedDefinition][] = [
          [selectedDefinition, { ...selectedDefinition, capabilitySelection: { ...selection, revision: 'b'.repeat(64) } }],
          [definition, selectedDefinition],
          [{ ...definition, capabilitySelection: null }, definition],
        ]
        for (const [requested, bound] of incompatible) {
          const rejected = await makeClient(auth, requested, bound).createSession({
            conversationId: 'group:selection-fixture', requestId: 'must-not-create', signal,
          })
          assert.deepEqual(rejected, { ok: false, error: { code: 'DSH_INSTRUCTIONS_UNSUPPORTED' } })
          assert.equal(capabilityCreations, 0)
          assert.equal(adapter.streams, streamsBefore)
        }
        const selectedClient = makeClient(auth, selectedDefinition)
        const created = await selectedClient.createSession({ conversationId: 'group:selection-fixture', requestId: 'selected-create', signal })
        assert(created.ok)
        const selectedAgent = ctx.agents.get(SessionId(created.value.sessionId))
        assert(selectedAgent)
        const described = await selectedClient.bridgePlugin.describe(signal)
        const initial = await selectedClient.bridgePlugin.inspectScope({ sessionId: selectedAgent.id, expectedPreset: 'chosen-group', expectedNames: [] }, described.issuerEpoch, signal)
        assert(initial.state === 'verified-scope')
        const tool: ToolDefinition = { name: 'selection_fixture', description: 'Metadata only, never executed.', parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: () => [] }, execute: async () => { toolExecutions++; throw new Error('Tool execution is forbidden') } }
        selectedAgent.ctx.tools.register(tool)
        const changed = await selectedClient.bridgePlugin.inspectScope({ sessionId: selectedAgent.id, expectedPreset: 'chosen-group',
          expectedSchemaFingerprint: initial.schemaFingerprint }, described.issuerEpoch, signal)
        assert.equal(changed.state, 'unverified')
        const observed = await selectedClient.bridgePlugin.inspectScope({ sessionId: selectedAgent.id, expectedPreset: 'chosen-group',
          expectedNames: ['selection_fixture'] }, described.issuerEpoch, signal)
        assert(observed.state === 'verified-scope')
        assert.equal(observed.externalToolAuthorizationVerified, false)
        assert.equal(observed.declarationRevisionVerified, false)
        const baseline = await selectedClient.bridgePlugin.claimReceipts({ sessionId: selectedAgent.id, issuerEpoch: described.issuerEpoch }, signal)
        assert((await selectedClient.prompt({ sessionId: selectedAgent.id, requestId: 'selected-prompt', mode: 'queue',
          content: [{ type: 'text', text: 'LOCAL_SELECTION_CANARY' }], signal })).ok)
        await selectedAgent.whenIdle()
        assert.equal(adapter.dispatchedEfforts.at(-1), undefined)
        assert.equal(adapter.streams, streamsBefore + 1)
        const claims = await selectedClient.bridgePlugin.claimReceipts({ sessionId: selectedAgent.id, issuerEpoch: described.issuerEpoch, after: baseline.head }, signal)
        assert.equal(claims.receipts.length, 1)
        assert.equal(claims.receipts[0]?.requestId, 'selected-prompt')
        const privateCreated = await selectedClient.createSession({ conversationId: 'private:selection-fixture', requestId: 'selected-private-create', signal })
        assert(privateCreated.ok)
        const privateScope = await selectedClient.bridgePlugin.inspectScope({ sessionId: privateCreated.value.sessionId, expectedPreset: 'chosen-private', expectedNames: [] }, described.issuerEpoch, signal)
        assert.equal(privateScope.state, 'verified-scope')
        assert.equal(capabilityCreations, 2)
        assert.equal(toolExecutions, 0)
        context.diagnostic(JSON.stringify({ selection, identityMismatchesRejected: incompatible.length, created: capabilityCreations,
          observedNames: observed.names, externalToolAuthorizationVerified: false, declarationRevisionVerified: false,
          claims: claims.receipts.length, localStreams: adapter.streams - streamsBefore, toolExecutions }))
      } finally { dispose() }
    })
    await context.test('actual SDK scoped tool calls reach the framework owner channel and return structured outcomes', async () => {
      const created = await client.createSession({ conversationId: 'group:tool-roundtrip', requestId: 'tool-session-create', signal })
      assert(created.ok)
      const agent = ctx.agents.get(SessionId(created.value.sessionId))
      assert(agent)
      const description = await port.describe(signal)
      const originalScope = await port.inspectScope({ sessionId: agent.id, expectedPreset: 'chosen-group', expectedNames: [] }, description.issuerEpoch, signal)
      assert(originalScope.state === 'verified-scope')
      const installed = await client.frameworkTools.install({ issuerEpoch: description.issuerEpoch, sessionId: agent.id, generation: 9,
        tools: [{ name: 'qaf_media_inspect', description: 'Inspect the current QQ scoped opaque media handle.', timeoutMs: 2000,
          parameters: { type: 'object', properties: { assetId: { type: 'string' } }, required: ['assetId'], additionalProperties: false } }] }, signal)
      assert.deepEqual(installed.names, ['qaf_media_inspect'])
      const inspected = await client.frameworkTools.inspect({ issuerEpoch: description.issuerEpoch, sessionId: agent.id }, signal)
      assert.deepEqual(inspected, { sessionId: agent.id, generation: 9, leaseId: installed.leaseId, names: installed.names })
      await assert.rejects(client.frameworkTools.install({ issuerEpoch: description.issuerEpoch, sessionId: agent.id, generation: 9,
        tools: [{ name: 'qaf_media_inspect', description: 'Duplicate install must not silently replace an uncertain lease.', timeoutMs: 2000,
          parameters: { type: 'object', properties: {}, additionalProperties: false } }] }, signal))
      assert.equal((await client.frameworkTools.inspect({ issuerEpoch: description.issuerEpoch, sessionId: agent.id }, signal))?.leaseId, installed.leaseId)
      assert.equal(ctx.tools.schemas(agent).some(schema => schema.name === 'qaf_media_inspect'), true)
      const projectedScope = await port.inspectScope({ sessionId: agent.id, expectedPreset: 'chosen-group', expectedNames: [],
        expectedSchemaFingerprint: originalScope.schemaFingerprint }, description.issuerEpoch, signal)
      assert(projectedScope.state === 'verified-scope')
      const disposeOriginal = agent.ctx.tools.register({ name: 'original_dsh_tool', description: 'Original DSH scope change remains visible.',
        parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => '' })
      assert.equal((await port.inspectScope({ sessionId: agent.id, expectedPreset: 'chosen-group', expectedNames: [],
        expectedSchemaFingerprint: originalScope.schemaFingerprint }, description.issuerEpoch, signal)).state, 'unverified')
      disposeOriginal()
      let outcome: unknown
      let callStarted = false
      let sdkCallId = 'actual-tool-call'
      let toolSignal = signal
      const errors = agent.ctx.on('agent/error', payload => { if (outcome === undefined) outcome = { fixtureError: String(payload.error) } })
      const hook = agent.ctx.on('agent/request', async (payload, next) => {
        if (!callStarted) {
          callStarted = true
          // This focused registry fixture supplies the same committed root event
          // that the model loop publishes before dispatching its tool pipeline.
          agent.session.append('assistant/message', { turn: payload.turn, step: payload.step, stream: [], message: createAssistantMessage({
            source: { provider: 'local-fixture', model: 'safe-model' }, content: [{ type: 'tool-call', id: ToolCallId(sdkCallId),
              name: 'qaf_media_inspect', arguments: '{"assetId":"opaque-asset"}' }]
          }) }, { surfaceOp: 'append' })
          await new Promise<void>(resolve => setImmediate(resolve))
          outcome = await agent.ctx.tools.execute({ callId: ToolCallId(sdkCallId), agent, name: 'qaf_media_inspect',
            arguments: { assetId: 'opaque-asset' }, signal: AbortSignal.any([payload.signal, toolSignal]) })
        }
        return next()
      })
      try {
        assert((await client.prompt({ sessionId: agent.id, requestId: 'real-qq-execution-request', mode: 'queue', content: [{ type: 'text', text: 'LOCAL_TOOL_FIXTURE' }], signal })).ok)
        let queued: Awaited<ReturnType<FrameworkClient['frameworkTools']['poll']>> = []
        for (let attempt = 0; attempt < 100; attempt++) {
          queued = await client.frameworkTools.poll({ issuerEpoch: description.issuerEpoch }, signal)
          if (queued.length) break
          await new Promise<void>(resolve => setTimeout(resolve, 5))
        }
        assert.equal(queued.length, 1, JSON.stringify({ callStarted, outcome }))
        const pending = queued[0]!
        assert.equal(pending.leaseId, installed.leaseId)
        assert.equal(pending.call.id, 'actual-tool-call')
        assert.equal(pending.call.requestId, 'real-qq-execution-request')
        assert.equal(pending.call.sessionId, agent.id)
        assert.equal(pending.call.generation, 9)
        assert.equal(typeof pending.call.userMessageId, 'string')
        assert.deepEqual(pending.call.input, { assetId: 'opaque-asset' })
        assert.equal(await client.frameworkTools.complete({ issuerEpoch: description.issuerEpoch, ticket: pending.ticket,
          result: { status: 'confirmed', value: { kind: 'image', available: true } } }, signal), true)
        await agent.whenIdle()
        assert.equal(object(outcome).isError, false)
        assert.deepEqual(object(outcome).value, { status: 'confirmed', value: { kind: 'image', available: true } })
        assert.equal(await client.frameworkTools.complete({ issuerEpoch: description.issuerEpoch, ticket: pending.ticket,
          result: { status: 'confirmed', value: { duplicate: true } } }, signal), false)
        assert.deepEqual(await client.frameworkTools.poll({ issuerEpoch: description.issuerEpoch }, signal), [])
        const cancellation = new AbortController()
        callStarted = false
        sdkCallId = 'sdk-cancelled-tool'
        toolSignal = cancellation.signal
        assert((await client.prompt({ sessionId: agent.id, requestId: 'cancelled-qq-execution', mode: 'queue', content: [{ type: 'text', text: 'LOCAL_CANCEL_FIXTURE' }], signal })).ok)
        let cancelledTicket: string | undefined
        for (let attempt = 0; attempt < 100; attempt++) {
          cancelledTicket = (await client.frameworkTools.poll({ issuerEpoch: description.issuerEpoch }, signal))[0]?.ticket
          if (cancelledTicket) break
          await new Promise<void>(resolve => setTimeout(resolve, 5))
        }
        assert(cancelledTicket)
        cancellation.abort()
        await agent.whenIdle()
        assert.equal(object(outcome).isError, true)
        assert.deepEqual(await client.frameworkTools.poll({ issuerEpoch: description.issuerEpoch }, signal), [])
        assert.equal(await client.frameworkTools.complete({ issuerEpoch: description.issuerEpoch, ticket: cancelledTicket,
          result: { status: 'confirmed', value: { late: true } } }, signal), false)
        const noSource = await agent.ctx.tools.execute({ callId: ToolCallId('late-old-turn'), agent, name: 'qaf_media_inspect', arguments: { assetId: 'opaque-asset' }, signal })
        assert.equal(noSource.isError, false)
        assert.deepEqual(noSource.value, { status: 'rejected', code: 'TOOL_SOURCE_UNAVAILABLE' })
        const malformed = await agent.ctx.tools.execute({ callId: ToolCallId('forged-input'), agent, name: 'qaf_media_inspect', arguments: { assetId: 'opaque-asset', owner: true }, signal })
        assert.equal(malformed.isError, false)
        assert.deepEqual(malformed.value, { status: 'rejected', code: 'INVALID_TOOL_INPUT' })
        const revoke = agent.ctx.tools.guard(() => 'Original DSH tool policy denies this invocation')
        try {
          const denied = await agent.ctx.tools.execute({ callId: ToolCallId('dsh-policy-denied'), agent, name: 'qaf_media_inspect', arguments: { assetId: 'opaque-asset' }, signal })
          assert.equal(denied.isError, true)
        } finally { revoke() }
        assert.deepEqual(await client.frameworkTools.poll({ issuerEpoch: description.issuerEpoch }, signal), [])
      } finally {
        hook(); errors()
        await client.frameworkTools.withdraw({ issuerEpoch: description.issuerEpoch, sessionId: agent.id, leaseId: installed.leaseId }, signal)
      }
      assert.equal(ctx.tools.schemas(agent).some(schema => schema.name === 'qaf_media_inspect'), false)
      assert.equal(await client.frameworkTools.inspect({ issuerEpoch: description.issuerEpoch, sessionId: agent.id }, signal), null)
    })
    await context.test('structured media tool content reaches the next real SDK model request without Base64 text and unsupported models stay explicit', async () => {
      adapter.mediaTool = true
      adapter.recheckMode = 'normal'
      adapter.catalogMode = 'normal'
      adapter.raceToHigh = false
      try {
        for (const mode of ['image', 'unsupported', 'text'] as const) {
          adapter.mediaImageInput = mode !== 'unsupported'
          adapter.mediaSeen = []
          const created = await client.createSession({conversationId:`group:media-${mode}`,requestId:`media-create-${mode}`,signal})
          assert(created.ok)
          const agent = ctx.agents.get(SessionId(created.value.sessionId)); assert(agent)
          const description = await port.describe(signal)
          await client.frameworkTools.install({issuerEpoch:description.issuerEpoch,sessionId:agent.id,generation:1,tools:[{
            name:'qaf_media_read',description:'Read explicitly authorized scoped image or text bytes.',timeoutMs:3000,
            parameters:{type:'object',properties:{assetId:{type:'string'}},required:['assetId'],additionalProperties:false}}]},signal)
          assert((await client.prompt({sessionId:agent.id,requestId:`media-prompt-${mode}`,mode:'queue',content:[{type:'text',text:'READ_SCOPED_MEDIA'}],signal})).ok)
          let pending: Awaited<ReturnType<FrameworkClient['frameworkTools']['poll']>> = []
          for(let attempt=0;attempt<200&&!pending.length;attempt++) { pending=await client.frameworkTools.poll({issuerEpoch:description.issuerEpoch},signal); if(!pending.length)await new Promise<void>(resolve=>setTimeout(resolve,5)) }
          assert.equal(pending.length,1)
          const content = mode==='text' ? [{type:'text' as const,text:'VERIFIED_UTF8_FILE_BODY'}] : [{type:'image' as const,mediaType:'image/png' as const,data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHd8AAAAASUVORK5CYII='}]
          assert.equal(await client.frameworkTools.complete({issuerEpoch:description.issuerEpoch,ticket:pending[0]!.ticket,result:{status:'confirmed',value:{schema:'qq-agent-framework.media-read/1',kind:mode==='text'?'text':'image',contentRead:true},content}},signal),true)
          await agent.whenIdle()
          assert(adapter.mediaSeen.length>0)
          assert.equal(adapter.mediaSeen.some(part=>object(part).type==='image'),mode==='image')
          assert(!JSON.stringify(adapter.mediaSeen).includes('iVBOR'))
          if(mode==='unsupported') { const summary=object(JSON.parse(String(object(adapter.mediaSeen[0]).text))); assert.equal(object(summary.value).contentRead,false) }
          if(mode==='text')assert(JSON.stringify(adapter.mediaSeen).includes('VERIFIED_UTF8_FILE_BODY'))
        }
      } finally { adapter.mediaTool=false;adapter.mediaImageInput=false }
    })
    await context.test('official SDK continuable spawn work preserves child identity and owner-only result control', async () => {
      const created = await client.createSession({ conversationId: 'group:sdk-work', requestId: 'work-parent-create', signal })
      assert(created.ok)
      const description = await port.describe(signal)
      const target: WorkTarget = { parentSessionId: created.value.sessionId, modelProvider: 'safe-fixture', model: 'safe-model', agentPreset: 'chosen-group', reasoningEffort: 'high' }
      assert.equal(await client.work.verify({ ...target, issuerEpoch: description.issuerEpoch }, signal), false)
      ctx.provide('workingDirectory', { defaultDirectory: directory, async ensure() { return directory }, async set() { return directory }, get() { return directory } })
      await ctx.plugin(Persistence, { root: join(directory, 'work-sessions'), compression: 'none' }).inertia
      await ctx.plugin(Subagents, { maxDepth: 4, maxActiveSubagents: 4 }).inertia
      await new Promise<void>(resolve => setImmediate(resolve))
      const unregister = ctx.subagents.registerProvider({ name: 'spawn', inheritsParentContext: false,
        capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true },
        async prepareContinuable() { return {} } })
      adapter.workOutput = true
      adapter.supportsOff = true
      adapter.catalogMode = 'normal'
      adapter.recheckMode = 'normal'
      adapter.raceToHigh = false
      try {
        assert.equal(await client.work.verify({ ...target, issuerEpoch: description.issuerEpoch }, signal), true)
        const evidenceCreated = await client.createSession({ conversationId: 'group:execution-evidence', requestId: 'evidence-create', signal })
        assert(evidenceCreated.ok)
        const evidenceAgent = ctx.agents.get(SessionId(evidenceCreated.value.sessionId))!
        assert((await client.prompt({ sessionId: evidenceAgent.id, requestId: 'evidence-real-prompt', mode: 'queue', content: [{ type: 'text', text: 'LOCAL_EVIDENCE_CANARY' }], signal })).ok)
        await evidenceAgent.whenIdle()
        await ctx.sessionPersistence.flush()
        const streamsBeforeInspection = adapter.streams
        const evidence = await client.bridgePlugin.inspectExecution({ sessionId: evidenceAgent.id, requestId: 'evidence-real-prompt' }, description.issuerEpoch, signal)
        assert.equal(evidence.state, 'settled', JSON.stringify(evidence))
        assert.equal(evidence.outcome, 'completed')
        assert.equal(evidence.matchedTurn, 1)
        assert.equal(adapter.streams, streamsBeforeInspection)

        const address: WorkAddress = { issuerEpoch: description.issuerEpoch, parentSessionId: created.value.sessionId,
          id: 'sdk-work-operation', childId: 'sdk-work-child', generation: 7 }
        const request: WorkStart = { ...address, ...target, task: 'LOCAL_WORK_TASK', context: 'LOCAL_WORK_CONTEXT', timeoutMs: 2000 }
        const started = await client.work.start(request, signal)
        assert.equal(started.childId, address.childId)
        let latest = started
        for (let attempt = 0; attempt < 100 && latest.state !== 'completed' && latest.state !== 'unknown'; attempt++) {
          await new Promise<void>(resolve => setTimeout(resolve, 5))
          latest = await client.work.inspect(address, signal)
        }
        assert.equal(latest.state, 'completed', JSON.stringify(latest))
        assert.equal(adapter.dispatchedEfforts.at(-1), 'high')
        assert.deepEqual(latest.result, { stopReason: 'completed', output: [{ type: 'text', text: 'LOCAL_SDK_WORK_RESULT' }] })
        // A fresh owner process reads the original association without loading an agent or invoking a model.
        const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
          import assert from 'node:assert/strict';
          import { createWorkChannel } from './dist/work.js';
          import { createWorkJournal } from './dist/work-journal.js';
          const request = JSON.parse(process.argv[1]);
          const channel = createWorkChannel({issuerEpoch:'fresh-owner-epoch',journal:createWorkJournal(process.argv[2]),
            getAgent:()=>undefined,runtime:()=>{throw Error('Recovery must not start SDK work')},hasPreset:async()=>false,continuationAvailable:()=>false});
          const address = {...request,issuerEpoch:'fresh-owner-epoch'};
          const snapshot = await channel.inspect(address);
          assert.equal(snapshot.state,'completed');
          assert.equal(snapshot.childId,request.childId);
          assert.equal(snapshot.result.output[0].text,'LOCAL_SDK_WORK_RESULT');
          await assert.rejects(channel.start(address,new AbortController().signal));
          await assert.rejects(channel.inspect({...address,generation:request.generation+1}));
          await channel.close();
          process.stdout.write(JSON.stringify(snapshot));
        `, JSON.stringify(request), join(directory, 'storages', 'qaf-work')], { cwd: new URL('..', import.meta.url), timeout: 10000 })
        assert.equal(object(JSON.parse(stdout)).issuerEpoch, 'fresh-owner-epoch')
        const parent = ctx.agents.get(SessionId(address.parentSessionId))
        assert(parent)
        assert((await ctx.subagents.listChildren(parent.id, signal)).some(child => child.id === address.childId))
        await assert.rejects(client.work.start(request, signal), 'A lost creation response must be inspected, never replayed.')
        await assert.rejects(client.work.inspect({ ...address, generation: 6 }, signal))
        await assert.rejects(client.work.interrupt({ ...address, parentSessionId: 'other-parent' }, signal))
        const followup = await client.work.followup({ ...address, requestId: 'qq-work-followup', text: 'LOCAL_FOLLOWUP', delivery: 'queue' }, signal)
        assert.equal(typeof followup.messageId, 'string')
        const child = ctx.agents.get(SessionId(address.childId))
        if (child) await child.whenIdle()
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((await client.work.inspect(address, signal)).state === 'completed') break
          await new Promise<void>(resolve => setTimeout(resolve, 5))
        }
        await client.work.interrupt(address, signal)
        assert.equal((await client.work.inspect(address, signal)).state, 'completed')
        adapter.workHold = true
        await client.work.followup({ ...address, requestId: 'qq-work-interrupt', text: 'WAIT_FOR_OWNER_STOP', delivery: 'queue' }, signal)
        assert.equal((await client.work.inspect(address, signal)).state, 'running')
        await client.work.interrupt(address, signal)
        const runningChild = ctx.agents.get(SessionId(address.childId))
        if (runningChild) await runningChild.whenIdle()
        let stopped = await client.work.inspect(address, signal)
        for (let attempt = 0; attempt < 100 && stopped.state !== 'completed'; attempt++) {
          await new Promise<void>(resolve => setTimeout(resolve, 5))
          stopped = await client.work.inspect(address, signal)
        }
        assert.equal(stopped.state, 'completed')
        assert.equal(object(stopped.result).stopReason, 'aborted')
        adapter.workHold = false
        adapter.workMedia = true
        const mediaStart = await client.work.followup({ ...address, requestId: 'qq-work-media', text: 'RETURN_STRUCTURED_MEDIA', delivery: 'queue' }, signal)
        assert.equal(typeof mediaStart.messageId, 'string')
        let media = await client.work.inspect(address, signal)
        for (let attempt = 0; attempt < 100 && media.state !== 'completed'; attempt++) {
          await new Promise<void>(resolve => setTimeout(resolve, 5))
          media = await client.work.inspect(address, signal)
        }
        assert.equal(media.state, 'completed', JSON.stringify(media))
        assert.deepEqual(object(media.result).output, [{type:'text',text:'LOCAL_SDK_WORK_RESULT'},
          {type:'media-reference',kind:'image',attachmentId:'sdk-image',bytes:4,mediaType:'image/png',width:1,height:1},
          {type:'media-reference',kind:'file',attachmentId:'sdk-file',bytes:400000,name:'result.txt'}])
        assert(client.work.readAsset)
        assert.deepEqual((await client.work.readAsset({...address,kind:'image',attachmentId:'sdk-image'},signal)).data,Buffer.from([1,2,3,4]))
        assert.deepEqual((await client.work.readAsset({...address,kind:'file',attachmentId:'sdk-file'},signal)).data,Buffer.alloc(400000,7))
        await assert.rejects(client.work.readAsset({...address,kind:'file',attachmentId:'not-in-result'},signal))
        await assert.rejects(client.work.readAsset({...address,generation:6,kind:'file',attachmentId:'sdk-file'},signal))
      } finally { adapter.workOutput = false; adapter.workHold = false; adapter.workMedia = false; unregister() }
    })
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await ctx.fiber.dispose()
    Date.now = realNow
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
