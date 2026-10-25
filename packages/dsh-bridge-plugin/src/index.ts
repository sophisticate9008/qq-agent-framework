import { inspectSdkExecution } from './execution-evidence.js'
import { DSH_EXECUTION_EVIDENCE_PROTOCOL, type DshExecutionEvidenceRequest } from './execution-evidence-protocol.js'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { BRIDGE_PLUGIN_PROTOCOL, RECEIPT_LIMITS, createClaimReceiptJournal, type ClaimReceiptQuery } from './receipts.js'
import { createDshToolScopeReader, type DshToolScopeRequest } from './tool-scope.js'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createMigrationJournal } from './migration-journal.js'
import { MIGRATION_PROTOCOL, type ForkPreviewRequest, type ForkWithPresetRequest } from './migration-protocol.js'
import { prepareSdkMigration } from './migration-runtime.js'
import { createFrameworkToolChannel, type FrameworkToolInstall, type FrameworkToolCompletion } from './framework-tools.js'
import { createWorkJournal } from './work-journal.js'
import { createWorkChannel, type WorkAddress, type WorkStart, type WorkTarget } from './work.js'

export default class BridgePlugin extends TypertRemoteService {
  static inject = ['agents', 'agentPresets', 'tools', 'typertGateway']
  private readonly journal = createClaimReceiptJournal()
  private readonly scopeReader
  private readonly migrations
  private readonly frameworkTools
  private readonly work

  constructor(ctx: Context) {
    super(ctx, 'bridgePlugin')
    this.frameworkTools = createFrameworkToolChannel({ issuerEpoch: this.journal.issuerEpoch,
      getAgent: id => ctx.agents.get(SessionId(id)) })
    this.work = createWorkChannel({ readAsset: async (asset, signal) => {
      const attachments = ctx.get('attachments')
      if (!attachments) throw new TypeError('SDK attachment storage is unavailable')
      if (asset.kind === 'image') {
        if (!asset.mediaType || !asset.width || !asset.height) throw new TypeError('SDK image metadata is unavailable')
        return (await attachments.readImage({ attachmentId: AttachmentId(asset.attachmentId), bytes: asset.bytes,
          mediaType: asset.mediaType, width: asset.width, height: asset.height, ...(asset.name ? { name: asset.name } : {}) }, signal)).data
      }
      if (!asset.name) throw new TypeError('SDK file metadata is unavailable')
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of attachments.readFileStream({ attachmentId: AttachmentId(asset.attachmentId), name: asset.name, bytes: asset.bytes }, signal)) {
        signal.throwIfAborted(); total += chunk.length
        if (total > asset.bytes || total > 8 * 1024 * 1024) throw new TypeError('SDK file exceeds its registered size')
        chunks.push(Buffer.from(chunk))
      }
      return Buffer.concat(chunks)
    }, journal: createWorkJournal(join(resolveDshHome(), 'storages', 'qaf-work')), issuerEpoch: this.journal.issuerEpoch, getAgent: id => ctx.agents.get(SessionId(id)),
      runtime: () => ctx.get('subagents'), hasPreset: async id => (await ctx.agentPresets.list()).some(preset => preset.id === id),
      continuationAvailable: () => ctx.get('sessionPersistence') !== undefined && ctx.get('sessionQuery') !== undefined })
    ctx.on('subagent/start', event => this.work.recordStart(event.id))
    ctx.on('subagent/end', event => this.work.recordEnd(event))
    ctx.effect(() => () => this.work.close())
    ctx.effect(() => () => this.frameworkTools.close())
    ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') this.frameworkTools.clearClaim(agent) })
    this.migrations = createMigrationJournal({ directory: join(resolveDshHome(), 'storages', 'qaf-session-migrations'),
      issuerEpoch: this.journal.issuerEpoch, prepare: (request, signal) => prepareSdkMigration(ctx, request, signal) })
    this.scopeReader = createDshToolScopeReader({ sessionId: SessionId, agents: ctx.agents,
      agentPresets: ctx.agentPresets, tools: { schemas: agent => {
        const projected = new Set(this.frameworkTools.projectedNames(agent))
        return ctx.tools.schemas(agent).filter(schema => !projected.has(schema.name))
      } } })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (message.source?.kind === 'user' && 'rpcId' in message.source && typeof message.source.rpcId === 'string')
        this.work.recordClaim(agent.session.id, message.source.rpcId)
      if (ctx.agents.get(agent.id) !== agent || agent.session.id !== agent.id || message.source?.kind !== 'user'
        || !('rpcId' in message.source) || typeof message.source.rpcId !== 'string') return
      this.journal.record({ sessionId: agent.session.id, requestId: message.source.rpcId, userMessageId: message.id, turn })
      this.frameworkTools.recordClaim(agent, { requestId: message.source.rpcId, userMessageId: message.id, turn })
    })
  }

  private assertOperator() {
    const invocation = this.ctx.invocation
    if (!invocation || invocation.service !== 'bridgePlugin' || invocation.peer.principal.kind !== 'owner'
      || invocation.peer.signal.aborted || invocation.signal.aborted || this.ctx.agents.currentInitiator() !== undefined) {
      throw new RemoteError('bridgePlugin/operator-required', 'Bridge management requires an authenticated DSH owner invocation', {})
    }
    return invocation
  }

  @Remote('describe')
  describe() {
    this.assertOperator()
    return { protocol: BRIDGE_PLUGIN_PROTOCOL, pluginVersion: '0.2.0', sdkVersion: '0.2.1-rc.2',
      issuerEpoch: this.journal.issuerEpoch, authentication: 'dsh-owner-peer', retention: RECEIPT_LIMITS,
      migrationProtocol: MIGRATION_PROTOCOL, migrationApiVersion: 2,
      frameworkToolProtocol: 'qq-agent-framework.tools/1',
      workProtocol: 'qq-agent-framework.work/1', executionEvidenceProtocol: DSH_EXECUTION_EVIDENCE_PROTOCOL,
      methods: ['bridgePlugin/describe', 'bridgePlugin/inspectScope', 'bridgePlugin/claimReceipts',
        'bridgePlugin/forkPreview', 'bridgePlugin/forkWithPreset', 'bridgePlugin/inspectMigration',
        'bridgePlugin/installFrameworkTools', 'bridgePlugin/withdrawFrameworkTools',
        'bridgePlugin/pollFrameworkTools', 'bridgePlugin/completeFrameworkTool', 'bridgePlugin/inspectFrameworkTools',
        'bridgePlugin/verifyWork', 'bridgePlugin/startWork', 'bridgePlugin/inspectWork', 'bridgePlugin/followupWork', 'bridgePlugin/interruptWork', 'bridgePlugin/readWorkAsset', 'bridgePlugin/inspectExecution'],
      claimMeaning: 'inbox-claimed-not-completed', durableReceipts: false, externalToolAuthorizationVerified: false }
  }

  @Remote('inspectExecution')
  inspectExecution(request: DshExecutionEvidenceRequest) {
    const invocation = this.assertOperator()
    return inspectSdkExecution(this.ctx, request, this.journal.issuerEpoch, invocation.signal)
  }

  @Remote('installFrameworkTools')
  installFrameworkTools(request: FrameworkToolInstall) {
    this.assertOperator()
    return this.frameworkTools.install(request)
  }

  @Remote('verifyWork')
  verifyWork(request: WorkTarget & { issuerEpoch: string }) { this.assertOperator(); return this.work.verify(request) }

  @Remote('startWork')
  startWork(request: WorkStart) {
    const invocation = this.assertOperator()
    return this.work.start(request, invocation.signal)
  }

  @Remote('inspectWork')
  inspectWork(request: WorkAddress) { this.assertOperator(); return this.work.inspect(request) }

  @Remote('readWorkAsset')
  readWorkAsset(request: WorkAddress & { kind: 'image' | 'file'; attachmentId: string; offset: number; limit: number }) {
    const invocation = this.assertOperator()
    return this.work.readAsset(request, invocation.signal)
  }

  @Remote('followupWork')
  followupWork(request: WorkAddress & { requestId: string; text: string; delivery: 'queue' | 'steer' }) {
    const invocation = this.assertOperator()
    return this.work.followup(request, invocation.signal)
  }

  @Remote('interruptWork')
  interruptWork(request: WorkAddress) { this.assertOperator(); return this.work.interrupt(request) }

  @Remote('withdrawFrameworkTools')
  withdrawFrameworkTools(request: { issuerEpoch: string; sessionId: string; leaseId: string }) {
    this.assertOperator()
    return this.frameworkTools.withdraw(request)
  }

  @Remote('pollFrameworkTools')
  pollFrameworkTools(request: { issuerEpoch: string }) {
    this.assertOperator()
    return this.frameworkTools.poll(request)
  }

  @Remote('inspectFrameworkTools')
  inspectFrameworkTools(request: { issuerEpoch: string; sessionId: string }) {
    this.assertOperator()
    return this.frameworkTools.inspect(request)
  }

  @Remote('completeFrameworkTool')
  completeFrameworkTool(request: FrameworkToolCompletion) {
    const invocation = this.assertOperator()
    return this.frameworkTools.complete(request, invocation.signal)
  }

  @Remote('forkPreview')
  forkPreview(request: ForkPreviewRequest) {
    const invocation = this.assertOperator()
    return this.migrations.preview(request, invocation.signal)
  }

  @Remote('forkWithPreset')
  forkWithPreset(request: ForkWithPresetRequest) {
    const invocation = this.assertOperator()
    return this.migrations.commit(request, invocation.signal)
  }

  @Remote('inspectMigration')
  inspectMigration(request: ForkWithPresetRequest) {
    this.assertOperator()
    return this.migrations.inspect(request)
  }

  @Remote('inspectScope')
  inspectScope(request: DshToolScopeRequest) {
    this.assertOperator()
    const agent = this.ctx.agents.get(SessionId(request.sessionId))
    return { protocol: BRIDGE_PLUGIN_PROTOCOL, issuerEpoch: this.journal.issuerEpoch,
      frameworkToolNames: agent ? [...this.frameworkTools.projectedNames(agent)] : [], ...this.scopeReader.inspect(request) }
  }

  @Remote('claimReceipts')
  claimReceipts(request: ClaimReceiptQuery) {
    this.assertOperator()
    return this.journal.read(request)
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'bridgePlugin/operator-required': Record<string, never>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    bridgePlugin: BridgePlugin
  }
}
