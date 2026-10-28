import { inspectRegisteredToolInventory } from './tool-inventory.js'
import { inspectSdkExecution } from './execution-evidence.js'
import { DSH_EXECUTION_EVIDENCE_PROTOCOL, type DshExecutionEvidenceRequest } from './execution-evidence-protocol.js'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
import { installWorkAttachmentTool } from './work-attachments.js'
import { createReplyDecisionRepair } from './reply-decision-repair.js'

export default class BridgePlugin extends TypertRemoteService {
  static inject = ['agents', 'agentPresets', 'tools', 'typertGateway']
  private readonly journal = createClaimReceiptJournal()
  private readonly scopeReader
  private readonly migrations
  private readonly frameworkTools
  private readonly work

  constructor(ctx: Context) {
    super(ctx, 'bridgePlugin')
    const replyRepair = createReplyDecisionRepair({ current: agent => ctx.agents.get(SessionId(agent.id)) === agent,
      hasReplyLease: agent => {
        const current = ctx.agents.get(SessionId(agent.id))
        return current === agent && this.frameworkTools.projectedNames(current).includes('qaf_reply')
      } })
    this.frameworkTools = createFrameworkToolChannel({ issuerEpoch: this.journal.issuerEpoch,
      getAgent: id => ctx.agents.get(SessionId(id)), onReplyAttempt: (agent, claim) => replyRepair.attempted(agent, claim) })
    function fullAccessService(agent?: Agent) {
      // This optional SDK service is deliberately not a plugin-wide default.
      const service: unknown = (agent?.ctx ?? ctx).get('permissionPresets')
      if (!service || typeof service !== 'object' || !('resolve' in service) || typeof service.resolve !== 'function'
        || !('set' in service) || typeof service.set !== 'function' || !('current' in service) || typeof service.current !== 'function')
        throw new TypeError('The SDK child permission service is unavailable')
      const spec: unknown = service.resolve('danger-full-access')
      if (!spec || typeof spec !== 'object' || !('sandbox' in spec) || spec.sandbox !== 'danger-full-access'
        || !('approval' in spec) || spec.approval !== 'never') throw new TypeError('The SDK full-access preset is not the required permission scope')
      const set = service.set.bind(service)
      const current = service.current.bind(service)
      return { set, current }
    }
    this.work = createWorkChannel({
      fullAccessAvailable: () => { try { fullAccessService(); return true } catch { return false } },
      applyFullAccess: agent => {
        const service = fullAccessService(agent)
        service.set(agent.session, 'danger-full-access')
        if (service.current(agent.session) !== 'danger-full-access') throw new TypeError('The SDK child permission scope was not applied')
      }, readAsset: async (asset, signal) => {
      const attachments = ctx.get('attachments')
      if (!attachments) throw new TypeError('SDK attachment storage is unavailable')
      // GIF work images are stored byte-for-byte using the SDK file store; readImage
      // addresses the separate normalized raster store and would lose the original animation.
      if (asset.kind === 'image' && asset.mediaType !== 'image/gif') {
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
      const data = Buffer.concat(chunks)
      if (asset.kind === 'image') {
        if (asset.mediaType !== 'image/gif' || data.length !== asset.bytes || data.length < 13
          || !['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))
          || data.readUInt16LE(6) !== asset.width || data.readUInt16LE(8) !== asset.height)
          throw new TypeError('Stored work GIF metadata changed')
      }
      return data
    }, journal: createWorkJournal(join(resolveDshHome(), 'storages', 'qaf-work')), issuerEpoch: this.journal.issuerEpoch, getAgent: id => ctx.agents.get(SessionId(id)),
      runtime: () => ctx.get('subagents'), hasPreset: async id => (await ctx.agentPresets.list()).some(preset => preset.id === id),
      continuationAvailable: () => ctx.get('sessionPersistence') !== undefined && ctx.get('sessionQuery') !== undefined })
    const attachmentTools = new Map<string, () => void>()
    ctx.on('agent/created', ({ agent }): undefined => {
      this.work.admitCreatedChild(agent)
      if (!this.work.hasAttachmentLease(agent.session.id) || attachmentTools.has(agent.session.id)) return undefined
      attachmentTools.set(agent.session.id, installWorkAttachmentTool(agent, {
        assertLease: () => {
          if (!this.work.hasAttachmentLease(agent.session.id) || ctx.agents.get(agent.id) !== agent)
            throw new TypeError('The work attachment lease is unavailable')
        },
        commit: asset => this.work.registerAttachment(agent.session.id, asset),
      }))
      return undefined
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.work.recordDisposedChild(agent)
      attachmentTools.get(agent.session.id)?.(); attachmentTools.delete(agent.session.id)
    })
    ctx.effect(() => () => { for (const dispose of attachmentTools.values()) dispose(); attachmentTools.clear() })
    ctx.on('subagent/start', event => this.work.recordStart(event.id))
    ctx.on('subagent/end', event => this.work.recordEnd(event))
    ctx.effect(() => () => this.work.close())
    ctx.effect(() => () => this.frameworkTools.close())
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') { this.frameworkTools.clearClaim(agent); replyRepair.clear(agent) }
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      if (!agent || agent.session !== session) return
      if (event.type === 'assistant/message') {
        this.frameworkTools.recordToolCalls(agent, event.data.turn, event.data.message.content)
        replyRepair.assistant(agent, event.data.turn, event.data.message.content)
      }
      if (event.type === 'turn/end') { this.frameworkTools.endTurn(agent, event.data.turn); replyRepair.clear(agent) }
    })
    ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => replyRepair.stopping(agent, turn, signal))
    this.migrations = createMigrationJournal({ directory: join(resolveDshHome(), 'storages', 'qaf-session-migrations'),
      issuerEpoch: this.journal.issuerEpoch, prepare: (request, signal) => prepareSdkMigration(ctx, request, signal) })
    this.scopeReader = createDshToolScopeReader({ sessionId: SessionId, agents: ctx.agents,
      agentPresets: ctx.agentPresets, tools: { schemas: agent => {
        const projected = new Set(this.frameworkTools.projectedNames(agent))
        return ctx.tools.schemas(agent).filter(schema => !projected.has(schema.name))
      } } })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      replyRepair.claimed(agent, message, turn)
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
    return { protocol: BRIDGE_PLUGIN_PROTOCOL, pluginVersion: '1.0.0', sdkVersion: '0.2.1-rc.2',
      issuerEpoch: this.journal.issuerEpoch, authentication: 'dsh-owner-peer', retention: RECEIPT_LIMITS,
      migrationProtocol: MIGRATION_PROTOCOL, migrationApiVersion: 2,
      frameworkToolProtocol: 'qq-agent-framework.tools/1',
      workProtocol: 'qq-agent-framework.work/1', executionEvidenceProtocol: DSH_EXECUTION_EVIDENCE_PROTOCOL,
      methods: ['bridgePlugin/inspectToolInventory', 'bridgePlugin/describe', 'bridgePlugin/inspectScope', 'bridgePlugin/claimReceipts',
        'bridgePlugin/forkPreview', 'bridgePlugin/forkWithPreset', 'bridgePlugin/inspectMigration',
        'bridgePlugin/installFrameworkTools', 'bridgePlugin/withdrawFrameworkTools',
        'bridgePlugin/pollFrameworkTools', 'bridgePlugin/completeFrameworkTool', 'bridgePlugin/inspectFrameworkTools',
        'bridgePlugin/verifyWork', 'bridgePlugin/startWork', 'bridgePlugin/inspectWork', 'bridgePlugin/followupWork', 'bridgePlugin/interruptWork', 'bridgePlugin/readWorkAsset', 'bridgePlugin/inspectExecution', 'bridgePlugin/inspectSessionStorage'],
      claimMeaning: 'inbox-claimed-not-completed', durableReceipts: false, externalToolAuthorizationVerified: false }
  }

  @Remote('inspectToolInventory')
  inspectToolInventory() {
    this.assertOperator()
    return { protocol: BRIDGE_PLUGIN_PROTOCOL, issuerEpoch: this.journal.issuerEpoch, ...inspectRegisteredToolInventory(this.ctx) }
  }

  @Remote('inspectSessionStorage')
  async inspectSessionStorage(request: { sessionId: string }) {
    const invocation = this.assertOperator()
    if (!request || Object.keys(request).length !== 1 || typeof request.sessionId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(request.sessionId)) throw new TypeError('Invalid session identity')
    const persistence = this.ctx.get('sessionPersistence')
    if (!persistence) throw new TypeError('Session persistence is unavailable')
    const stored = await persistence.stat(SessionId(request.sessionId), { signal: invocation.signal })
    if (!stored) return { sessionId: request.sessionId, exists: false }
    // Backend-specific location is used only by trusted, offline local maintenance.
    const backend: unknown = persistence
    if (!backend || typeof backend !== 'object' || !('locate' in backend) || typeof backend.locate !== 'function'
      || !('root' in backend) || typeof backend.root !== 'string') throw new TypeError('Session storage cannot be maintained locally')
    const location: unknown = backend.locate(stored.header)
    if (!location || typeof location !== 'object' || !('kind' in location) || location.kind !== 'jsonl'
      || !('path' in location) || typeof location.path !== 'string') throw new TypeError('Unsupported session storage')
    return { sessionId: request.sessionId, exists: true, root: backend.root, filename: location.path }
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
