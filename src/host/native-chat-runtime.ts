import { readDshToolInventory, unavailableToolInventory } from '../adapters/dsh-tool-inventory.ts'
import { withFrameworkToolInventory } from './native-tool-inventory.ts'
import { startNativeOperationRetention } from './native-operation-retention.ts'
import { unbindNativeSession, assertNativeSessionIdle } from './native-session-actions.ts'
import type { NativeSessionResetTarget } from './native-session-management.ts'
import { createNativeUsageProjection } from './native-usage-projection.ts'
import { openReadonlySqliteStore } from '../storage/sqlite-readonly.ts'
import type { AccountScope } from '../contracts/account-scope.ts'
import { normalizeAccountScope } from '../core/account-scope.ts'
import { assertAccountStore, bindAccountStore } from '../storage/account-scope.ts'
import { mapOneBotConnectionObservation } from './native-event-mapping.ts'
import { createNativeUsageMaintenance } from './native-usage-maintenance.ts'
import type { NativeUsageMaintenanceRequest, NativeUsageMaintenanceScope } from '../contracts/native-usage-maintenance.ts'
import { createNativeInteractionAssembly } from './native-interaction-assembly.ts'
import { createNativeExecutionRecovery, readNativeExecutionRecovery } from './native-execution-recovery.ts'
import { projectNativeDiagnostics } from './native-diagnostics.ts'
import { readNativeMediaDiagnostics, recordNativeQuoteRead } from './native-media-diagnostics.ts'
import type { NativeMediaDiagnostics } from '../contracts/native-media-diagnostics.ts'
import { readChatInputConfiguration } from './chat-input-configuration.ts'
import { createNativeExecutionReconciliation } from './native-execution-reconciliation.ts'
import { drainNativeRun, type NativeRunningRunResources } from './native-run-resources.ts'
import { createNativeAgentCoordinator } from './native-agent-coordinator.ts'
import { createNativeWorkFeedback } from './native-work-feedback.ts'
import { createNativeReplyFreshness } from './native-reply-freshness.ts'
import { createFfmpegVideoObserver } from '../adapters/ffmpeg-video.ts'
import { validateNativeMediaConfiguration } from '../contracts/native-media-configuration.ts'
import { createNativeOutputService, createNativeOutputPackage } from './native-output.ts'
import { createNativeMarkdownService } from './native-markdown.ts'
import { createBuiltinMarkdownRenderer } from '../rendering/builtin-markdown.ts'
import { createNativeInboundController } from './native-inbound.ts'
import { deriveDshMigrationTargetSelection } from '../adapters/dsh-migration-selection.ts'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { createDshAdapter } from '../adapters/dsh.ts'
import { createDshJsonRpcPort, type DshPresetBinding } from '../adapters/dsh-jsonrpc.ts'
import { createOneBotActionPort, ONEBOT_READ_ACTIONS } from '../adapters/onebot-actions.ts'
import { createOneBotMediaReader } from '../adapters/onebot-media.ts'
import type { NativeMediaTranscriber } from '../contracts/native-media.ts'
import { ONEBOT_PROTOCOL_EVENT_TYPES, validateOneBotProtocolEventData } from '../adapters/onebot-events.ts'
import { createOneBotTransport } from '../adapters/onebot.ts'
import { classifyOneBotResponse } from '../adapters/onebot-response.ts'
import { createContextStore } from '../core/context.ts'
import { isRecord, FrameworkError, errorCode, snapshot } from '../core/values.ts'
import { createNativeDurableStore as createSqliteStore } from './native-retention.ts'
type SqliteStore = ReturnType<typeof createSqliteStore>
import { type AdapterRuntimePort, type NativeAdapterConfiguration } from './adapter-configuration.ts'
import { createBridgeHost } from './bridge.ts'
import { buildChatSessionDefinition, type ChatSessionDefinition } from './chat-plans.ts'
import { withDeadline } from './deadlines.ts'
import type { NativeChatConfiguration } from './native-chat-configuration.ts'
import { createOneBotConnectionManager } from './onebot-connection.ts'
import type { InboundMessage } from './types.ts'
import type { AgentEvent } from './types.ts'
import { createNativeUsage, type NativeUsageTokens } from './native-usage.ts'
import { digest, json, object } from './data.ts'
import { createNativeExecutionController } from './native-execution.ts'
import { createNativeExecutionClaims } from './native-execution-claims.ts'
import { createNativeExecutionPolicyActions } from './native-execution-actions.ts'
import { createNativeBootstrapMount, type LoadedNativeBootstrap, type NativeBootstrapMount } from './native-bootstrap.ts'
import { readNativeHistory, type NativeHistoryReader } from './native-history.ts'
import { captureNativeConfigurationBaseline, inspectNativeConfigurationCompatibility,
  nativeSessionMigrationEligibility, readNativeConfigurationBaseline, synchronizeNativeChatConfiguration } from './native-chat-compatibility.ts'
import { createNativeMessageSources } from './native-message-sources.ts'
import { nativeAuthorizationFallback, nativeAuthorizationMode, nativeChatGrantAvailable, nativeChatGrantId, nativeWhitelistCapabilities } from './native-access.ts'
import { createNativeActivity, nativeActivityContent } from './native-activity.ts'
import { createNativeInteractions } from './native-interactions.ts'
import type { createNativeInteractionMessages } from './native-interaction-messages.ts'
import { readDshToolCatalog } from '../adapters/dsh-tool-catalog.ts'
import { createDshAuthenticationOptions } from '../adapters/dsh-authentication.ts'
import { commitNativeSessionMigration, previewNativeSessionMigration,
  type NativeSessionMigrationCommit, type NativeSessionMigrationResult } from './native-session-migration.ts'
import { readMigrationAuthorizationIdentity } from './native-session-migration-state.ts'
import { createLifecycleHooks, type LifecycleCheckpoint, type LifecycleHookDefinition } from './lifecycle-hooks.ts'
import { createControlCommands, type ControlCommandDefinition } from './control-commands.ts'
import { createDurableTransport } from './outbox.ts'
import { applyNativeAccessGrants, rememberNativeAccessGrants, restoredNativeAccessGrants } from './native-access-application.ts'
import type { JsonObject } from '../core/types.ts'
import { composeAgentInputPreparation } from './input-preparation.ts'
import { prepareNativeChatInput } from './native-chat-input.ts'
import { createNativeQuotedContext } from './native-quoted-context.ts'
import { readScopedProtocolMessage } from './native-protocol-message.ts'
import { normalizeContent } from '../core/content.ts'
import { createNativeInbox } from './native-inbox.ts'
import { createNativeMediaRegistry } from './native-media.ts'
import { analyzeNativeConfigurationImpact } from './native-configuration-impact.ts'
import { createNativeConfigurationGuard } from './native-configuration-guard.ts'
import { createNativePackages } from './native-packages.ts'
import { createChatInputNativePackage, createMediaNativePackage, createRemindersNativePackage, createMemoryNativePackage,
  type NativeChatInputPackageService, type NativeMediaPackageService, type NativeMemoryPackageService } from './default-native-packages.ts'
import type { PackageConfigurationRegistry } from './package-configuration.ts'
import { createNativePackageConfigurationRegistry } from './native-package-configuration.ts'
import { createNativeFrameworkTools, NATIVE_TOOL_EVENT, validateNativeToolEvent } from './native-framework-tools.ts'
import { createNativeReminderRuntime } from './native-reminder-runtime.ts'
import type { NativeReminderReadOptions } from './native-reminders.ts'
import { createNativeToolPolicy } from './native-tool-policy.ts'
import { createNativeMemoryRuntime } from './native-memory-runtime.ts'
import type { NativeMemoryReadOptions, NativeMemorySource } from '../contracts/native-memory.ts'
import { createNativeMemoryCommand } from './native-memory-commands.ts'
import { createNativeMemoryEffects } from './native-memory-effects.ts'
import type { NativeAssistantTargetResolution, NativeAssistantWorkPreparation } from './native-assistant-target.ts'
import { createNativeWorkExecutor } from './native-work.ts'
import { createNativeWorkHistoryReader } from './native-work-history.ts'
import { createDshNativeWorkBackend } from './dsh-native-work.ts'
import { createNativeWorkAssets } from './native-work-assets.ts'
import { createNativeWorkDelivery } from './native-work-delivery.ts'
import { createNativeWorkEffects, NATIVE_WORK_TOOLS } from './native-work-tools.ts'
import { createOneBotStickerPort } from '../adapters/onebot-stickers.ts'
import { createNativeStickerService, NATIVE_STICKER_TOOLS } from './native-sticker-tools.ts'
import { createOneBotConversationPort } from '../adapters/onebot-conversation.ts'
import { createNativeConversationService, NATIVE_CONVERSATION_TOOLS } from './native-conversation-tools.ts'
import { createNativeServicesPackage } from './native-services.ts'

export interface NativeChatDeploymentResolution {
  readonly missingReasons: readonly string[]
  readonly presetBindings: readonly DshPresetBinding[]
  readonly verificationScope?: string
  readonly credentialValueIdentityVerified?: false
  readonly unverified?: readonly string[]
}

export interface NativeChatRuntimeOptions {
  readonly accountScope?: AccountScope
  readonly expectedSelfId?: string
  readonly directory: string
  readonly loadConfiguration: () => Promise<NativeChatConfiguration>
  readonly resolveDeployment: (configuration: NativeChatConfiguration, definition: ChatSessionDefinition)
    => Promise<NativeChatDeploymentResolution>
  readonly resolveWorkTarget?: (signal: AbortSignal) => Promise<NativeAssistantTargetResolution>
  readonly prepareWorkTarget?: (signal: AbortSignal) => Promise<NativeAssistantWorkPreparation>
  readonly readWorkEnabled?: (signal: AbortSignal) => Promise<boolean>
  readonly readWorkIdentity?: (signal: AbortSignal) => Promise<{ readonly nickname: string; readonly model: string | null } | null>
  readonly mediaTranscriber?: NativeMediaTranscriber
  readonly packageConfigurationRegistry?: PackageConfigurationRegistry
  readonly bootstrap?: LoadedNativeBootstrap
  readonly prepareAuthorization?: () => Promise<void>
  readonly lifecycleHooks?: readonly LifecycleHookDefinition[]
  readonly controlCommands?: readonly ControlCommandDefinition[]
}

export type NativeChatRuntime = ReturnType<typeof createNativeChatRuntime>
type BridgeHost = ReturnType<typeof createBridgeHost>
type RuntimeState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
const nativeRuntimes = new WeakSet<object>()

export function isNativeChatRuntime(value: unknown): value is NativeChatRuntime {
  return value !== null && typeof value === 'object' && nativeRuntimes.has(value)
}

function failure(code: string): never {
  throw new FrameworkError(code, 'Native chat runtime operation did not complete safely.')
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function sameRevisions(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key])
}

function allowed(configuration: NativeChatConfiguration, conversationId: string): boolean {
  return configuration.access.allow.includes(conversationId) && !configuration.access.deny.includes(conversationId)
}

function compatibleConfiguration(previous: NativeChatConfiguration, next: NativeChatConfiguration): boolean {
  return analyzeNativeConfigurationImpact(previous, next).canContinue
}

function configuredDefinition(configuration: NativeChatConfiguration): ChatSessionDefinition | null {
  const plan = configuration.catalog.plans.find(value => value.id === configuration.catalog.activePlanId)
  const persona = configuration.personas.find(value => value.id === plan?.personaId)
  return plan && persona ? buildChatSessionDefinition(plan, persona) : null
}

export function createNativeChatRuntime(options: NativeChatRuntimeOptions) {
  if (!isAbsolute(options.directory) || options.directory.includes('\0')
    || typeof options.loadConfiguration !== 'function' || typeof options.resolveDeployment !== 'function') {
    throw new TypeError('Native chat requires an absolute private directory and explicit configuration loaders.')
  }
  const accountScope = options.accountScope === undefined ? undefined : normalizeAccountScope(options.accountScope)
  const expectedSelfId = options.expectedSelfId ?? accountScope?.accountId
  if (expectedSelfId !== undefined && (!/^[1-9][0-9]{0,31}$/.test(expectedSelfId)
    || accountScope && accountScope.accountId !== expectedSelfId)) throw new TypeError('The expected QQ identity must match its account scope.')
  function readHistorySnapshot<Result>(read: (history: NativeHistoryReader) => Result): Result {
    return readNativeHistory(options.directory, read, accountScope)
  }
  function verifyPersistedAccount() {
    let reader: ReturnType<typeof openReadonlySqliteStore>
    try { reader = openReadonlySqliteStore(join(options.directory, 'native-chat.sqlite')) }
    catch (error) { if (error instanceof FrameworkError && error.code === 'STORE_NOT_FOUND') return; throw error }
    try { assertAccountStore(reader, accountScope) } finally { reader.close() }
  }
  let state: RuntimeState = 'stopped'
  const packageConfigurationRegistry = options.packageConfigurationRegistry ?? createNativePackageConfigurationRegistry({ directory: options.directory,
    contributions: options.bootstrap?.packageConfigurations })
  let markdown: ReturnType<typeof createNativeMarkdownService> | undefined
  const output = createNativeOutputService(packageConfigurationRegistry, { renderMarkdown(request) {
    if (!markdown) failure('NATIVE_MARKDOWN_UNAVAILABLE')
    return markdown.render(request)
  } })
  const activity = createNativeActivity()
  const interactions = createNativeInteractions({ state: () => state,
    sensitiveValues: () => active ? [...active.providers.map(provider => provider.apiKey),
      active.adapters.onebotHttp.secret, active.adapters.onebotWs.secret, active.adapters.dshAgent.auth,
      active.adapters.onebotWebhook.hmac].filter((value): value is string => typeof value === 'string' && value.length > 0) : [] })
  let stopInteractions: (() => Promise<void>) | undefined
  let releaseInteractions: (() => void) | undefined
  let interactionMessages: ReturnType<typeof createNativeInteractionMessages> | undefined
  let media: ReturnType<typeof createNativeMediaRegistry> | undefined
  let packages: ReturnType<typeof createNativePackages> | undefined
  let packageUnknown = false
  let inputPackage: NativeChatInputPackageService | undefined
  let memoryPackage: NativeMemoryPackageService | undefined
  let work: ReturnType<typeof createNativeWorkExecutor> | undefined
  let stickers: ReturnType<typeof createNativeStickerService> | undefined
  let workMissingReasons: readonly string[] = ['native_work_backend_unavailable']
  let workAssets: ReturnType<typeof createNativeWorkAssets> | undefined
  let frameworkTools: ReturnType<typeof createNativeFrameworkTools> | undefined
  let quotedContext: ReturnType<typeof createNativeQuotedContext> | undefined
  let inbox: ReturnType<typeof createNativeInbox> | undefined
  let host: BridgeHost | undefined
  let store: SqliteStore | undefined
  let usage: ReturnType<typeof createNativeUsage> | undefined
  let usageFaults = 0
  let lastUsageError: string | null = null
  let dsh: ReturnType<typeof createDshJsonRpcPort> | undefined
  let active: NativeChatConfiguration | undefined
  let activePresetBindings: readonly DshPresetBinding[] = []
  let verifiedDeployment: Awaited<ReturnType<typeof options.resolveDeployment>> | undefined
  let lifetime: AbortController | undefined
  let starting: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let adapterOperation = false
  let migrationOperation: Promise<NativeSessionMigrationResult> | undefined
  let closed = false
  let closePromise: Promise<void> | undefined
  let lastError: string | null = null
  let releaseLease: (() => Promise<void>) | undefined
  let deployedProviders = new Map<string, string>()
  let executions: ReturnType<typeof createNativeExecutionController> | undefined
  let claims: ReturnType<typeof createNativeExecutionClaims> | undefined
  let claimTimer: ReturnType<typeof setInterval> | undefined
  let claimOffset = 0
  let pluginEpoch: string | null = null
  let bootstrapMount: NativeBootstrapMount | undefined
  let bootstrapUnknown = false
  let messageSources: ReturnType<typeof createNativeMessageSources> | undefined
  let workFeedback: ReturnType<typeof createNativeWorkFeedback> | undefined
  let replyFreshness: ReturnType<typeof createNativeReplyFreshness> | undefined
  const managerDefinitions = [...(options.lifecycleHooks ?? []), ...(options.bootstrap?.lifecycleHooks ?? [])]
  const controlDefinitions = [...(options.controlCommands ?? []), ...(options.bootstrap?.controlCommands ?? [])]
  const managerHooks = createLifecycleHooks(managerDefinitions)
  let lifecycleHooks = managerHooks
  let activeIdentity: string | undefined
  let applyingAccess = false
  const controlLifetime = new AbortController()
  const operationRetention = startNativeOperationRetention(options.directory, controlLifetime.signal)
  let controlStore: SqliteStore | undefined
  let controlCommands: ReturnType<typeof createControlCommands> | undefined
  let preparingControl: Promise<ReturnType<typeof createControlCommands>> | undefined
  const configurationGuard = createNativeConfigurationGuard({
    current: () => ({ state, signal: lifetime?.signal, configuration: active, bindings: activePresetBindings }),
    loadConfiguration: options.loadConfiguration, resolveDeployment: options.resolveDeployment, definition: configuredDefinition
  })
  const frozenRecoveryConversations = new Set<string>()
  let recoveringExecution = false
  let recoveryPending: Promise<void> | undefined
  const guard: typeof configurationGuard.check = async (...args) => {
    if (frozenRecoveryConversations.has(args[0])) failure('NATIVE_EXECUTION_RECOVERY_RESTART_REQUIRED')
    await configurationGuard.check(...args)
    if (frozenRecoveryConversations.has(args[0])) failure('NATIVE_EXECUTION_RECOVERY_RESTART_REQUIRED')
  }
  const toolPolicy = createNativeToolPolicy({ directory: options.directory, currentHost: () => host, access: () => active?.access,
    capabilities: () => frameworkTools?.feature.capabilities ?? [],
    available: () => (state === 'starting' || state === 'running') && frameworkTools?.describe().available === true,
    signal: () => lifetime?.signal })
  const reminders = createNativeReminderRuntime({ directory: options.directory,
    currentHost: () => host, running: () => state === 'running' && lifetime?.signal.aborted === false,
    async authorizeConfiguration(conversationId, signal) {
      if (closed) failure('NATIVE_CHAT_CLOSED')
      signal.throwIfAborted()
      const configuration = await options.loadConfiguration()
      signal.throwIfAborted()
      if (!allowed(configuration, conversationId)) failure('REMINDER_ACCESS_DENIED')
    },
    guard: (conversationId, signal) => guard(conversationId, signal, true, 'delivery'),
    async authorizeToolRequest(request) {
      if (!messageSources) failure('NATIVE_MESSAGE_SOURCE_MISSING')
      await messageSources.reader.requireOwner(request.scope, request.signal)
    } })
  async function memorySource(source: NativeMemorySource, signal: AbortSignal, owner: boolean) {
    if (source.kind === 'operator' || !messageSources) failure('MEMORY_SOURCE_INVALID')
    const binding = host?.sessions.get(source.conversationId)
    const scope = { ...(accountScope ? { accountScope } : {}), conversationId: source.conversationId, eventId: source.messageId,
      featureId: 'memory', version: '1.0.0', ...(binding ? { sessionId: binding.sessionId, generation: binding.generation } : {}) }
    const proof = await (owner ? messageSources.reader.requireOwner(scope, signal) : messageSources.reader.lookup(scope, signal))
    if (proof.userId !== source.userId || proof.sourceMessageId !== source.messageId) failure('MEMORY_SOURCE_INVALID')
  }
  const memory = createNativeMemoryRuntime({ directory: options.directory,
    async authorizeSource(source, _scope, signal) { await memorySource(source, signal, source.kind === 'owner-message') },
    async authorizeOwner(authority, signal) {
      if (closed) failure('NATIVE_CHAT_CLOSED')
      signal.throwIfAborted()
      if (authority.kind !== 'operator') await memorySource(authority, signal, true)
    },
    authorizeRead: (conversationId, _userId, signal) => guard(conversationId, signal, true, 'resource') })
  controlDefinitions.push(createNativeMemoryCommand({ service: () => memory.service(), owner: () => active?.access.owner ?? null,
    async withSource(message, signal, run) {
      await guard(message.conversationId, signal, true, 'resource')
      if (!messageSources || !active || message.userId !== active.access.owner) failure('MEMORY_OWNER_REQUIRED')
      const receivedAt = Date.now()
      const release = messageSources.capture(message, { receivedAt, expiresAt: receivedAt + 10_000, signal })
      try { await run() } finally { release() }
    } }))

  function checkpoint(point: LifecycleCheckpoint, data: JsonObject, signal: AbortSignal): Promise<void> {
    const selected = point === 'message.normalized' && state !== 'running' ? managerHooks : lifecycleHooks
    return withDeadline({ signal, timeoutMs: 2_000, code: 'NATIVE_CHAT_HOOK_TIMEOUT',
      run: combined => selected.run(point, data, combined) }).catch(error => {
      if (signal.aborted || ['runtime.starting', 'message.admitted', 'agent.submitting', 'send.before'].includes(point)) throw error
    })
  }

  function getControlCommands(): Promise<ReturnType<typeof createControlCommands>> {
    return preparingControl ??= (async () => {
      const directory = await lstat(options.directory)
      if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) failure('NATIVE_CHAT_STORAGE_INVALID')
      controlLifetime.signal.throwIfAborted()
      controlStore = createSqliteStore({ filename: join(options.directory, 'native-control.sqlite'), maxRecords: 16_384 })
      bindAccountStore(controlStore, accountScope)
      const transport = createDurableTransport({ store: controlStore, accountScope, transport: { async send(request) {
        const configuration = await options.loadConfiguration()
        const protocol = observeConnection()
        if (closed || protocol.state !== 'connected' || protocol.selfId === null
          || !configuration.adapters.onebotHttp.enabled) failure('NATIVE_CONTROL_PROTOCOL_UNAVAILABLE')
        await verifyHttpIdentity(protocol.selfId, configuration, request.signal)
        const latest = await options.loadConfiguration()
        if (latest.revisions.adapters !== configuration.revisions.adapters) failure('NATIVE_CHAT_CONFIGURATION_CHANGED')
        request.signal.throwIfAborted()
        return createOneBotTransport({ endpoint: configuration.adapters.onebotHttp.endpoint,
          accessToken: configuration.adapters.onebotHttp.secret, timeoutMs: 5_000 }).send(request)
      } } })
      controlCommands = createControlCommands({ store: controlStore, accountScope, commands: controlDefinitions.map(command => ({
        ...command, async handle(context: Parameters<typeof command.handle>[0]) {
          inbound.controlReceived(context.message)
          await command.handle(context)
        }
      })), signal: controlLifetime.signal, async send(request) {
        const replay = controlStore!.read('outbox', digest(request.idempotencyKey)) !== null
        const content = nativeActivityContent(request.content)
        try {
          const receipt = await transport.send({ ...request, ...(accountScope ? { scope: { accountScope, persona: { id: 'native-control', version: '1' } } } : {}) })
          if (!replay) activity.record(receipt.status === 'confirmed' ? 'send_confirmed'
            : receipt.status === 'rejected' ? 'send_rejected' : 'send_unknown', request.conversationId, content)
          return receipt
        } catch (error) {
          if (!replay) activity.record('send_unknown', request.conversationId, undefined, {}, safeCode(error))
          throw error
        }
      } })
      return controlCommands
    })()
  }

  const inbound = createNativeInboundController({ resources: {
    get state() { return state }, get closed() { return closed }, get host() { return host },
    get lifetime() { return lifetime }, get configuration() { return active }, get media() { return media },
    get executions() { return executions }, get inbox() { return inbox }, get messageSources() { return messageSources },
    get interactionMessages() { return interactionMessages }, get quotedContext() { return quotedContext },
    get inputPackage() { return inputPackage }, feedbackBusy: conversationId => workFeedback?.busy(conversationId) ?? false
  }, accountScope, expectedSelfId, activity, controlDefinitions, getControlCommands, checkpoint, guard, safeCode,
    onDispatched: (requestId, accepted) => replyFreshness?.settled(requestId, accepted) })
  const connection = createOneBotConnectionManager({ ...inbound.handlers, ...(accountScope ? { accountId: accountScope.accountId } : {}) })
  let lastObservedConnection = ''
  function observeConnection() {
    const current = connection.connectionStatus()
    const signature = digest([current.state, current.selfId, current.accountOnline ?? null, current.accountGood ?? null])
    if (signature !== lastObservedConnection) {
      lastObservedConnection = signature
      const observation = mapOneBotConnectionObservation(current, current.selfId ?? undefined)
      if (observation) activity.observe(observation)
    }
    return current
  }

  function safeCode(error: unknown): string {
    const code = errorCode(error, 'NATIVE_CHAT_FAILED')
    return /^(?:[A-Z][A-Z0-9_]{1,80}|onebot_ws_[a-z0-9_]{1,64}|adapter_runtime_[a-z0-9_]{1,64})$/.test(code)
      ? code : 'NATIVE_CHAT_FAILED'
  }



  async function inspect(observeStorageFailure = false) {
    let storageUnavailable = false
    try { verifyPersistedAccount() }
    catch (error) {
      if (!observeStorageFailure || !(error instanceof FrameworkError) || !error.code.startsWith('STORE_')) throw error
      storageUnavailable = true
    }
    const configuration = await options.loadConfiguration()
    const definition = configuredDefinition(configuration)
    const missingReasons: string[] = []
    if (storageUnavailable) missingReasons.push('persisted_configuration_unavailable')
    if (!definition) missingReasons.push('active_plan_or_persona_missing')
    if (!configuration.adapters.onebotWs.enabled) missingReasons.push('onebot_ws_not_enabled')
    if (!configuration.adapters.onebotHttp.enabled) missingReasons.push('onebot_http_not_enabled')
    if (!configuration.adapters.dshAgent.enabled) missingReasons.push('dsh_agent_not_enabled')
    if (configuration.adapters.dshAgent.auth === '' && !configuration.adapters.dshAgent.localCredentialsPath) missingReasons.push('dsh_auth_missing')
    if (!configuration.access.allow.some(scope => allowed(configuration, scope))) missingReasons.push('access_allow_missing')
    if (configuration.authorizationSource === 'missing-with-history') missingReasons.push('authorization_document_missing_with_history')
    if (nativeAuthorizationMode(configuration.authorization) === 'counted'
      && !configuration.authorization.grants.some(grant => allowed(configuration, grant.conversationId)
      && grant.submitUses > 0 && grant.sendUses > 0 && (grant.expiresAt === null || grant.expiresAt > Date.now()))) {
      missingReasons.push('explicit_authorization_missing')
    }
    if (definition) {
      const provider = configuration.providers.find(value => value.id === definition.model.provider)
      if (!provider?.enabled || !provider.models.some(model => model.id === definition.model.name)) {
        missingReasons.push('provider_model_missing_or_disabled')
      }
    }
    const deployment = observeStorageFailure && state === 'running' && verifiedDeployment ? verifiedDeployment
      : definition ? await options.resolveDeployment(configuration, definition)
      : { missingReasons: [], presetBindings: [] }
    missingReasons.push(...deployment.missingReasons)
    if (definition && deployment.presetBindings.length === 0 && deployment.missingReasons.length === 0) {
      missingReasons.push('trusted_dsh_binding_missing')
    }
    return { configuration, definition, deployment, missingReasons }
  }

  async function status() {
    const current = await inspect(true)
    const migrationCandidate = {
      definition: current.definition, persona: current.configuration.personas.find(value => value.id === current.definition?.personaId) ?? null,
      endpoint: current.configuration.adapters.dshAgent.endpoint, bindings: current.deployment.presetBindings }
    const configurationCompatibility = inspectNativeConfigurationCompatibility(options.directory, migrationCandidate)
    const migrationReasons = [...nativeSessionMigrationEligibility(readNativeConfigurationBaseline(options.directory), migrationCandidate, true)]
    if (nativeAuthorizationMode(current.configuration.authorization) !== 'whitelist') migrationReasons.push('migration_counted_mode_unsupported')
    const protocol = observeConnection()
    const socketConnected = protocol.state === 'connected' && protocol.selfId !== null
    const protocolConnected = socketConnected && protocol.accountOnline !== false && protocol.accountGood !== false
    const configurationIssues = [...current.missingReasons, ...configurationCompatibility.reasons]
    const missingReasons = [...configurationIssues]
    const configurationImpact = active ? analyzeNativeConfigurationImpact(active, current.configuration,
      { previousBindings: activePresetBindings, nextBindings: current.deployment.presetBindings }) : null
    if (configurationImpact && !configurationImpact.canContinue) missingReasons.push('configuration_changed')
    if (state !== 'running') missingReasons.push('runtime_not_started')
    if (!socketConnected) missingReasons.push('onebot_protocol_not_connected')
    else if (protocol.accountOnline === false) missingReasons.push('onebot_account_offline')
    else if (protocol.accountGood === false) missingReasons.push('onebot_account_unhealthy')
    const metrics = host?.metrics() ?? null
    if (state === 'running' && metrics?.startupState !== 'ready') missingReasons.push('host_not_ready')
    if (state === 'running' && metrics && metrics.unhealthyFollows > 0) missingReasons.push('agent_follow_unavailable')
    if (executions?.metrics().faulted) missingReasons.push('execution_controller_unavailable')
    if (packageUnknown) missingReasons.push('package_cleanup_unknown')
    if (state === 'running' && pluginEpoch === null) missingReasons.push('execution_correlation_unavailable')
    if (state === 'running' && !host?.policy.describe().grants.some(grant => nativeChatGrantAvailable(grant)
      && allowed(current.configuration, grant.conversationId))) missingReasons.push('authorization_budget_unavailable')
    const chatReady = state === 'running' && missingReasons.length === 0 && host !== undefined && dsh !== undefined
    const taskDelegationAvailable = chatReady && work !== undefined && pluginEpoch !== null
      && (options.readWorkEnabled ? await options.readWorkEnabled(controlLifetime.signal) : workMissingReasons.length === 0)
    return snapshot({ state, chatReady, runtimeConnected: chatReady, protocolConnected,
      configurationIssues, configurationCompatibility, configurationImpact, guard: configurationGuard.describe(),
      packages: packages?.describe() ?? [], frameworkTools: frameworkTools?.describe() ?? null,
      reminders: reminders.status(),
      memory: memory.status(),
      sessionMigration: { eligible: !closed && state === 'stopped' && !adapterOperation && !starting && !stopping
        && current.missingReasons.length === 0 && migrationReasons.length === 0,
        availability: 'requires-preview', requiresPreview: true, missingReasons: migrationReasons },
      canStart: !closed && !starting && !stopping && !adapterOperation && !bootstrapUnknown && !packageUnknown && releaseLease === undefined
        && (state === 'stopped' || state === 'error') && configurationIssues.length === 0,
      canApplyDeployment: !closed && !starting && !stopping && !adapterOperation && releaseLease === undefined
        && (state === 'stopped' || state === 'error'),
      missingReasons: [...new Set(missingReasons)], revisions: current.configuration.revisions,
      activeRevisions: active?.revisions ?? null, lastError,
      connection: { ...protocol, chatReady }, host: metrics,
      ingress: { ...inbound.status(), queue: inbox?.summary() ?? null },
      usage: { available: usage !== undefined, faults: usageFaults, lastError: lastUsageError },
      execution: { available: executions !== undefined, policy: current.configuration.execution,
        metrics: executions?.metrics() ?? null, correlationVerified: pluginEpoch !== null },
      chatAccess: { mode: nativeAuthorizationMode(current.configuration.authorization),
        quota: nativeAuthorizationMode(current.configuration.authorization) === 'whitelist' ? 'none' : 'counted',
        authorizationSource: current.configuration.authorizationSource ?? 'stored', denyOverridesAllow: true,
        groupScope: 'conversation-not-member-filter', privateScope: 'direct-conversation' },
      taskDelegationAvailable,
      toolDelegation: { available: true, selected: current.definition?.capabilitySelection ?? null,
        currentCompositionReady: current.definition?.capabilitySelection ? current.missingReasons.length === 0 : null,
        scopeVerification: 'on-demand-per-turn', baselineMeaning: 'observed-inventory-not-source-attribution',
        requiredForOrdinaryChat: nativeAuthorizationMode(current.configuration.authorization) === 'counted',
        externalToolAuthorizationVerified: false, declarationRevisionVerified: false },
      bootstrap: bootstrapUnknown ? { ...(bootstrapMount?.metadata() ?? options.bootstrap?.metadata), state: 'unknown', unsettledLifecycle: true }
        : bootstrapMount?.metadata() ?? (options.bootstrap ? { ...options.bootstrap.metadata, state: 'not-started' } : null),
      readinessScope: current.deployment.verificationScope ?? 'verified-protocol-dsh-configuration-and-local-file-provenance',
      credentialValueIdentityVerified: false,
      unverified: current.deployment.unverified ?? ['credential_loaded_value_identity'],
      lifecycleHooks: { manager: managerHooks.describe(), chat: lifecycleHooks.describe() },
      controlCommands: controlCommands?.metrics() ?? { commands: controlDefinitions.length, pendingRaw: 0, inflight: 0,
        records: 0, closed: controlLifetime.signal.aborted },
      modelExecutionVerified: false })
  }

  function bindingForSession(sessionId: string) {
    return host?.sessions.findBySessionId(sessionId) ?? undefined
  }

  function recordUsage(event: AgentEvent) {
    if (!usage || !active || (event.type !== 'completed' && event.type !== 'failed')) return
    const binding = bindingForSession(event.sessionId)
    if (!binding) return
    const data = event.data ?? {}
    if (data.terminal === true || !(typeof data.turn === 'string' && data.turn.length > 0
      || typeof data.turn === 'number' && Number.isSafeInteger(data.turn) && data.turn >= 0)) return
    const turnId = String(data.turn)
    const sourceSteps = Array.isArray(data.usageSteps) ? data.usageSteps : []
    const definition = configuredDefinition(active)!
    const steps = sourceSteps.length > 0 ? sourceSteps : [null]
    for (const input of steps.slice(0, 256)) {
      const step = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : null
      const source = step?.usage !== null && typeof step?.usage === 'object' && !Array.isArray(step.usage) ? step.usage : null
      const count = (key: string): number | null => {
        const value = source?.[key]
        return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
      }
      const tokens: NativeUsageTokens = { input: count('inputTokens'), output: count('outputTokens'),
        cacheRead: count('cacheReadTokens'), cacheWrite: count('cacheWriteTokens'), total: count('totalTokens'),
        reasoning: count('reasoningTokens') }
      const externalProvider = step && typeof step.provider === 'string' ? step.provider : definition.model.provider
      usage.append({ conversationId: binding.conversationId, sessionId: binding.sessionId!, generation: binding.generation,
        turnId, stepId: step && typeof step.eventId === 'string' ? step.eventId : null,
        stepNumber: step && typeof step.step === 'number' && Number.isSafeInteger(step.step) ? step.step : null,
        coverage: data.usageComplete === true && sourceSteps.length <= 256 ? 'complete' : sourceSteps.length > 0 ? 'partial' : 'unknown',
        provider: deployedProviders.get(externalProvider) ?? externalProvider, externalProvider,
        model: step && typeof step.model === 'string' ? step.model : definition.model.name,
        status: event.type, tokens, reportedCost: null })
    }
  }

  function applyAuthorization(configuration: NativeChatConfiguration, identity: string) {
    if (!host || !store) failure('NATIVE_CHAT_NOT_ASSEMBLED')
    const authorization = configuration.authorization
    const key = authorization.version
    const signature = fingerprint(authorization)
    const previous = store.read('native-chat.authorization', key)
    if (previous && (typeof previous.value !== 'object' || previous.value === null
      || Array.isArray(previous.value) || previous.value.signature !== signature)) failure('NATIVE_CHAT_AUTHORIZATION_VERSION_CONFLICT')
    if (!previous) store.write('native-chat.authorization', key, { signature }, { expectedRevision: null })
    const desired = new Set<string>()
    if (nativeAuthorizationMode(authorization) === 'whitelist') {
      const capabilities = nativeWhitelistCapabilities(configuration)
      const signature = fingerprint([identity, authorization.version, configuration.revisions.access,
        configuration.revisions.execution, capabilities])
      const prior = store.read('native-chat.whitelist-policy', 'current')
      const metadata = prior ? object(prior.value) : null
      if (metadata && (metadata.schema !== 1 || typeof metadata.signature !== 'string'
        || !/^[a-f0-9]{64}$/.test(metadata.signature) || !Number.isSafeInteger(metadata.generation)
        || Number(metadata.generation) < 1)) failure('NATIVE_CHAT_WHITELIST_POLICY_INVALID')
      const generation = metadata?.signature === signature ? Number(metadata.generation) : Number(metadata?.generation ?? 0) + 1
      if (!Number.isSafeInteger(generation)) failure('NATIVE_CHAT_WHITELIST_POLICY_INVALID')
      if (metadata?.signature !== signature) store.write('native-chat.whitelist-policy', 'current',
        { schema: 1, signature, generation }, { expectedRevision: prior?.revision ?? null })
      const restored = restoredNativeAccessGrants(store, configuration, identity, host)
      const mapping: Record<string, string> = {}
      for (const conversationId of configuration.access.allow) {
        if (!allowed(configuration, conversationId)) continue
        const id = restored?.[conversationId] ?? nativeChatGrantId(configuration, identity, conversationId, generation)
        mapping[conversationId] = id
        desired.add(id)
        if (store.read('policy.grants', id)) continue
        const capabilities = nativeWhitelistCapabilities(configuration, conversationId)
        host.policy.grant({ ...(accountScope ? { accountScope } : {}), id, featureId: 'agent-relay', conversationId,
          capabilities: [...capabilities], maxUses: Object.fromEntries(capabilities.map(capability => [capability, null])), expiresAt: null })
      }
      rememberNativeAccessGrants(store, configuration, identity, mapping)
    }
    for (const grant of host.policy.describe().grants) {
      if ((grant.id.startsWith('native-chat:') || grant.id.startsWith('native-chat-whitelist:'))
        && !desired.has(grant.id)) host.policy.revoke(grant.id)
    }
  }

  async function applyAccessChange(_previousRevision: string, nextRevision: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (closed || starting || stopping || applyingAccess) failure('NATIVE_CHAT_BUSY')
    if (state === 'stopped') return
    if (state !== 'running' || !active || !host || !store || !activeIdentity) failure('NATIVE_CHAT_ACCESS_RELOAD_REQUIRED')
    const previous = active
    const currentHost = host
    applyingAccess = true
    try {
      const saved = await options.loadConfiguration()
      signal.throwIfAborted()
      if (active !== previous || host !== currentHost || state !== 'running'
        || saved.revisions.access !== nextRevision) failure('NATIVE_CHAT_REVISION_CONFLICT')
      // Access is a live gate. Keep every other running configuration domain intact;
      // unrelated drafts and earlier unsynchronized access saves do not require reload.
      const next: NativeChatConfiguration = { ...previous, access: saved.access,
        revisions: { ...previous.revisions, access: saved.revisions.access } }
      applyNativeAccessGrants({ store, host: currentHost, previous, next, identity: activeIdentity })
      active = snapshot(next)
      await toolPolicy.sync(signal)
    } finally { applyingAccess = false }
    await checkpoint('access.changed', { previousRevision: previous.revisions.access, revision: nextRevision,
      allowedConversations: active!.access.allow.length }, signal).catch(() => {})
  }

  async function verifyHttpIdentity(selfId: string, configuration: NativeChatConfiguration, signal: AbortSignal) {
    if (expectedSelfId !== undefined && selfId !== expectedSelfId) failure('NATIVE_ACCOUNT_IDENTITY_MISMATCH')
    await withDeadline({ signal, timeoutMs: 5_000, code: 'NATIVE_CHAT_HTTP_VERIFY_TIMEOUT', async run(combined) {
      const endpoint = configuration.adapters.onebotHttp
      const base = new URL(endpoint.endpoint.endsWith('/') ? endpoint.endpoint : `${endpoint.endpoint}/`)
      const response = await fetch(new URL('get_login_info', base), { method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', ...(endpoint.secret === '' ? {} : { authorization: `Bearer ${endpoint.secret}` }) }, body: '{}' })
      const reader = response.body?.getReader()
      if (!response.ok || !reader) { await response.body?.cancel(); failure('NATIVE_CHAT_HTTP_IDENTITY_UNVERIFIED') }
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.length
          if (bytes > 65_536) failure('NATIVE_CHAT_HTTP_IDENTITY_UNVERIFIED')
          chunks.push(chunk.value)
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (classifyOneBotResponse(body) !== 'confirmed' || !body || typeof body !== 'object'
          || !('data' in body) || !body.data || typeof body.data !== 'object'
          || !('user_id' in body.data) || String(body.data.user_id) !== selfId) failure('NATIVE_CHAT_HTTP_IDENTITY_UNVERIFIED')
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    } })
  }

  async function cleanup() {
    frozenRecoveryConversations.clear()
    const resources = { lifetime, host, dsh, work, workFeedback, claims, executions, bootstrap: bootstrapMount,
      tools: frameworkTools, packages, inbox, quotedContext, reminders, memory,
      releaseInteractions, closeInteractions: stopInteractions, claimTimer,
      clearIngress: inbound.clear, drainConfiguration: configurationGuard.drain, drainPolicy: toolPolicy.drain }
    releaseInteractions = undefined
    stopInteractions = undefined
    interactionMessages = undefined
    messageSources = undefined
    workFeedback = undefined
    replyFreshness?.clear()
    replyFreshness = undefined
    media = undefined
    stickers = undefined
    inputPackage = undefined
    memoryPackage = undefined
    quotedContext = undefined
    inbox = undefined
    claimTimer = undefined
    const result = await drainNativeRun(resources)
    await markdown?.close().catch(error => { result.errors.push(error) })
    frameworkTools = undefined
    work = undefined
    workAssets = undefined
    markdown = undefined
    dsh = undefined
    claims = undefined
    pluginEpoch = null
    packageUnknown ||= result.packageUnknown
    bootstrapUnknown ||= result.bootstrapUnknown
    if (!bootstrapUnknown && !packageUnknown) {
      await releaseLease?.()
      releaseLease = undefined
    }
    if (bootstrapUnknown) failure('NATIVE_CHAT_BOOTSTRAP_UNKNOWN')
    if (result.errors.length) throw result.errors[0]
  }

  async function acquireLease() {
    if (releaseLease) failure('NATIVE_CHAT_LEASE_HELD')
    const filename = join(options.directory, '.native-chat-runtime.lock')
    const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      .catch(() => failure('NATIVE_CHAT_LEASE_HELD'))
    const held = await handle.stat()
    releaseLease = async () => {
      await handle.close()
      const current = await lstat(filename).catch(() => null)
      if (current && current.dev === held.dev && current.ino === held.ino) await unlink(filename)
    }
  }

  function migrate(revisions: Readonly<Record<string, string>>, signal: AbortSignal,
    input?: NativeSessionMigrationCommit): Promise<NativeSessionMigrationResult> {
    if (closed || state !== 'stopped' || starting || stopping || adapterOperation || migrationOperation || releaseLease) failure('NATIVE_CHAT_BUSY')
    signal.throwIfAborted()
    adapterOperation = true
    const operation = (async () => {
      let migrationDsh: ReturnType<typeof createDshJsonRpcPort> | undefined
      let ownsLease = false
      try {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        const selected = await inspect()
        if (!sameRevisions(revisions, selected.configuration.revisions)) failure('NATIVE_CHAT_REVISION_CONFLICT')
        if (selected.missingReasons.length > 0 || !selected.definition) failure('NATIVE_CHAT_CONFIGURATION_INCOMPLETE')
        const configuration = selected.configuration
        const definition = selected.definition
        const persona = configuration.personas.find(value => value.id === definition.personaId)
        if (!persona) failure('NATIVE_CHAT_CONFIGURATION_INCOMPLETE')
        const directory = await lstat(options.directory)
        const filename = join(options.directory, 'native-chat.sqlite')
        const database = await lstat(filename)
        if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700
          || !database.isFile() || database.isSymbolicLink() || database.nlink !== 1 || (database.mode & 0o777) !== 0o600) {
          failure('NATIVE_CHAT_STORAGE_INVALID')
        }
        await acquireLease()
        ownsLease = true
        store ??= createSqliteStore({ filename })
        bindAccountStore(store, accountScope)
        migrationDsh = createDshJsonRpcPort({ endpoint: configuration.adapters.dshAgent.endpoint,
          ...createDshAuthenticationOptions(configuration.adapters.dshAgent), sessionDefinition: definition,
          presetBindings: selected.deployment.presetBindings, timeoutMs: 5_000 })
        if (!migrationDsh.sessionMigration) failure('NATIVE_SESSION_MIGRATION_UNSUPPORTED')
        const candidate = { definition, persona, endpoint: configuration.adapters.dshAgent.endpoint,
          bindings: selected.deployment.presetBindings }
        const migrationPort = migrationDsh
        const migrationOptions = { store, configuration, candidate, port: migrationDsh.sessionMigration, signal: deadline,
          async resolveTargetSelection(conversationId: string, targetPreset: string, signal: AbortSignal) {
            const kind = conversationId.startsWith('group:') ? 'group' : 'private'
            const matches = selected.deployment.presetBindings.filter(binding => binding.agentPreset === targetPreset
              && (binding.conversationKind === undefined || binding.conversationKind === kind)
              && digest(binding.definition) === digest(definition))
            if (matches.length !== 1) failure('NATIVE_SESSION_MIGRATION_PRESET_AMBIGUOUS')
            const [catalog, inspection] = await Promise.all([
              migrationPort.readModelCatalog(signal),
              migrationPort.inspectDeployment({ agentPresets: [targetPreset], credentialRefs: [], signal })
            ])
            signal.throwIfAborted()
            return deriveDshMigrationTargetSelection({ provider: matches[0].externalProvider ?? definition.model.provider,
              model: definition.model.name, reasoningEffort: definition.model.reasoningEffort, agentPreset: targetPreset,
              catalog, settings: inspection.settings, presetDocument: inspection.documents[0] ?? null })
          },
          async recheck() {
            deadline.throwIfAborted()
            if (closed || state !== 'stopped' || starting || stopping || !releaseLease) failure('NATIVE_CHAT_BUSY')
            const latest = await inspect()
            if (!sameRevisions(revisions, latest.configuration.revisions)) failure('NATIVE_CHAT_REVISION_CONFLICT')
            if (latest.missingReasons.length > 0 || digest(latest.definition) !== digest(definition)
              || digest(latest.deployment.presetBindings) !== digest(selected.deployment.presetBindings)) {
              failure('NATIVE_CHAT_DEPLOYMENT_CHANGED')
            }
          },
          finalize() {
            if (!captureNativeConfigurationBaseline(store!, candidate, [...configuration.providers.map(provider => provider.apiKey),
              configuration.adapters.onebotHttp.secret, configuration.adapters.onebotWs.secret,
              configuration.adapters.dshAgent.auth, configuration.adapters.onebotWebhook.hmac])) {
              failure('NATIVE_SESSION_MIGRATION_BASELINE_UNAVAILABLE')
            }
          } }
        return input ? await commitNativeSessionMigration(migrationOptions, input) : await previewNativeSessionMigration(migrationOptions)
      } finally {
        try { await migrationDsh?.close() } finally {
          if (ownsLease) { await (releaseLease as (() => Promise<void>) | undefined)?.(); releaseLease = undefined }
          adapterOperation = false
        }
      }
    })()
    migrationOperation = operation
    void operation.finally(() => { if (migrationOperation === operation) migrationOperation = undefined }).catch(() => undefined)
    return operation
  }

  async function start(revisions: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void> {
    if (closed) failure('NATIVE_CHAT_CLOSED')
    if (starting || stopping || adapterOperation || state === 'running') failure('NATIVE_CHAT_BUSY')
    if (lifecycleHooks !== managerHooks && lifecycleHooks.describe().pendingRaw > 0) failure('NATIVE_CHAT_HOOK_PENDING_UNKNOWN')
    signal.throwIfAborted()
    state = 'starting'
    activity.record('starting')
    lastError = null
    const controller = new AbortController()
    lifetime = controller
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 30_000)
    let ownsResources = false
    const operation = (async () => {
      try {
        await options.prepareAuthorization?.()
        controller.signal.throwIfAborted()
        const selected = await withDeadline({ signal: controller.signal, timeoutMs: 15_000,
          code: 'NATIVE_CHAT_CONFIGURATION_TIMEOUT', run: () => inspect() })
        if (!sameRevisions(revisions, selected.configuration.revisions)) failure('NATIVE_CHAT_REVISION_CONFLICT')
        if (selected.missingReasons.length > 0 || !selected.definition) failure('NATIVE_CHAT_CONFIGURATION_INCOMPLETE')
        controller.signal.throwIfAborted()
        const configuration = selected.configuration
        const definition = selected.definition
        const metadata = await lstat(options.directory)
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) failure('NATIVE_CHAT_STORAGE_INVALID')
        await acquireLease()
        ownsResources = true
        const filename = join(options.directory, 'native-chat.sqlite')
        const database = await lstat(filename).catch((error: unknown) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
          throw error
        })
        if (database && (!database.isFile() || database.isSymbolicLink() || database.nlink !== 1
          || (database.mode & 0o777) !== 0o600)) failure('NATIVE_CHAT_STORAGE_INVALID')
        if (!database && (await nativeAuthorizationFallback(options.directory)).source === 'missing-with-history') failure('NATIVE_CHAT_STORAGE_INVALID')
        store ??= createSqliteStore({ filename })
        bindAccountStore(store, accountScope)
        usage ??= createNativeUsage({ store })
        const persona = configuration.personas.find(value => value.id === definition.personaId)!
        const configurationState = synchronizeNativeChatConfiguration(store, {
          definition, persona, endpoint: configuration.adapters.dshAgent.endpoint, bindings: selected.deployment.presetBindings,
        }, [...configuration.providers.map(provider => provider.apiKey),
          configuration.adapters.onebotHttp.secret, configuration.adapters.onebotWs.secret,
          configuration.adapters.dshAgent.auth, configuration.adapters.onebotWebhook.hmac])
        const { identity, contentIdentity, personaMetadata } = configurationState
        active = configuration
        activePresetBindings = snapshot(selected.deployment.presetBindings)
        verifiedDeployment = snapshot(selected.deployment)
        deployedProviders = new Map(selected.deployment.presetBindings.map(binding =>
          [binding.externalProvider ?? binding.definition.model.provider, binding.definition.model.provider]))
        dsh = createDshJsonRpcPort({ endpoint: configuration.adapters.dshAgent.endpoint,
          ...createDshAuthenticationOptions(configuration.adapters.dshAgent), sessionDefinition: definition,
          presetBindings: selected.deployment.presetBindings, timeoutMs: 5_000,
          async resolvePromptImage(request) {
            const binding = bindingForSession(request.sessionId)
            const registry = media
            if (!binding || !registry) failure('NATIVE_MEDIA_UNAVAILABLE')
            if (active?.deployment.modelSettings?.inputModalities?.includes('image') === false) return null
            const image = await registry.readForPrompt({ assetId: request.assetId, conversationId: binding.conversationId, signal: request.signal })
            await guard(binding.conversationId, request.signal, true, 'resource')
            const current = bindingForSession(request.sessionId)
            if (!current || current.conversationId !== binding.conversationId || current.generation !== binding.generation) failure('SESSION_STALE')
            return image
          } })
        const sourceAgent = createDshAdapter(dsh, { onObservation(observation) {
          const sessionId = observation.correlation.sessionId
          const binding = sessionId ? bindingForSession(sessionId) : null
          activity.observe({ ...observation, correlation: { ...observation.correlation,
            ...(binding ? { conversationId: binding.conversationId, generation: binding.generation } : {}),
            ...(accountScope ? { protocolId: accountScope.protocolId, accountId: accountScope.accountId } : {}) } })
        } })
        const agent = createNativeAgentCoordinator({ sourceAgent, dsh, store, controller, definition, configuration, identity,
          presetBindings: selected.deployment.presetBindings, activity, bindingForSession, admittedAt: inbound.admittedAt, checkpoint, guard,
          onReplySuppressed: requestId => workFeedback?.suppressed(requestId),
          onReplyFailed: (requestId, known) => workFeedback?.delivered(requestId, { status: known ? 'rejected' : 'unknown' }),
          resources: { get lifetime() { return lifetime }, get configuration() { return active }, get host() { return host },
            get executions() { return executions }, get claims() { return claims }, get frameworkTools() { return frameworkTools },
            get messageSources() { return messageSources }, get pluginEpoch() { return pluginEpoch } },
          recordUsage(event) { try { recordUsage(event) } catch (error) {
            usageFaults++; lastUsageError = safeCode(error); activity.record('usage_error')
          } } })
        const context = createContextStore()
        const outgoingPersona = configurationState.personaScope
        const personaReference = context.registerPersona({ ...contentIdentity.persona, version: personaMetadata.scopeVersion })
        messageSources = createNativeMessageSources({ accountScope, owner: configuration.access.owner, signal: controller.signal,
          validateExecution(execution, source) {
            if (lifetime !== controller || controller.signal.aborted || state !== 'running') failure('NATIVE_CHAT_STOPPED')
            const binding = host?.sessions.get(source.conversationId)
            const current = executions?.forConversation(source.conversationId)
            if (!binding || binding.sessionId !== execution.sessionId
              || binding.generation !== execution.generation) failure('SESSION_STALE')
            if (!current || !executions?.active().some(record => record.id === current.id)
              || current.requestId !== execution.requestId || current.binding.conversationId !== source.conversationId
              || current.binding.sessionId !== execution.sessionId || current.binding.generation !== execution.generation
              || current.admittedAt !== source.receivedAt || current.deadlineAt !== source.expiresAt
              || current.deadlineReached || Date.now() >= current.deadlineAt || current.isolated !== true
              || current.cancelStatus !== 'not-requested'
              || !(current.status === 'submitting' && current.externalStatus === 'submitting'
                || current.status === 'running' && current.externalStatus === 'accepted')) failure('NATIVE_MESSAGE_SOURCE_EXECUTION_INVALID')
          },
          async validate(scope, signal) {
            if (lifetime !== controller || state !== 'running') failure('NATIVE_CHAT_STOPPED')
            await guard(scope.conversationId, signal, true, 'resource')
            if (lifetime !== controller || state !== 'running') failure('NATIVE_CHAT_STOPPED')
            if (scope.sessionId !== undefined || scope.generation !== undefined) {
              const binding = host?.sessions.get(scope.conversationId)
              if (!binding || scope.sessionId !== binding.sessionId || scope.generation !== binding.generation) failure('SESSION_STALE')
            }
          } })
        bootstrapMount = options.bootstrap ? await createNativeBootstrapMount({ bootstrap: options.bootstrap,
          context: { directory: options.directory, store, context, persona: personaReference, signal: controller.signal,
            messageSources: messageSources.reader } }) : undefined
        if (lifecycleHooks !== managerHooks) lifecycleHooks.close()
        lifecycleHooks = createLifecycleHooks([...managerDefinitions, ...(bootstrapMount?.lifecycleHooks ?? [])])
        await checkpoint('runtime.starting', { state: 'starting', planId: definition.planId }, controller.signal)
        await connection.connect(configuration.adapters, controller.signal)
        const selfId = observeConnection().selfId
        if (!selfId) failure('NATIVE_CHAT_PROTOCOL_UNVERIFIED')
        await verifyHttpIdentity(selfId, configuration, controller.signal)
        markdown = createNativeMarkdownService({ directory: options.directory, store, accountId: selfId,
          renderer: createBuiltinMarkdownRenderer(), signal: controller.signal,
          onMaintenanceFault(code) { lastError = code; activity.record('error') },
          binding(conversationId) { const binding = host?.sessions.get(conversationId); return binding?.sessionId
            ? { sessionId: binding.sessionId, generation: binding.generation } : null },
          authorize: (conversationId, signal) => guard(conversationId, signal, true, 'resource') })
        const bootstrapOnebotOptions: import('./native-bootstrap.ts').NativeBootstrapOneBotOptions | undefined = bootstrapMount?.onebotOptions
        const sourceTransport = createOneBotTransport({ endpoint: configuration.adapters.onebotHttp.endpoint,
          accessToken: configuration.adapters.onebotHttp.secret, timeoutMs: 30_000,
          ...bootstrapOnebotOptions,
          forward: { group: true, private: true, ...bootstrapOnebotOptions?.forward,
            senderId: selfId, senderName: persona.name.slice(0, 100) },
          resolveAsset(request) {
            if (request.assetId.startsWith('markdown-asset-')) {
              if (!markdown) failure('NATIVE_MARKDOWN_UNAVAILABLE')
              return markdown.resolve(request)
            }
            if (request.assetId.startsWith('media-')) {
              if (!media) failure('NATIVE_MEDIA_UNAVAILABLE')
              const binding = host?.sessions.get(request.conversationId)
              if (!binding || binding.sessionId !== request.sessionId || binding.generation !== request.generation) failure('SESSION_STALE')
              return media.resolveOutgoing(request)
            }
            if (request.assetId.startsWith('work-asset-')) {
              if (!workAssets) failure('WORK_ASSET_UNAVAILABLE')
              return workAssets.resolve(request)
            }
            const onebotOptions: Pick<import('../adapters/onebot.ts').OneBotTransportOptions, 'resolveAsset'> | undefined = bootstrapMount?.onebotOptions
            const resolver = onebotOptions && 'resolveAsset' in onebotOptions ? onebotOptions.resolveAsset : undefined
            if (!resolver) failure('NATIVE_ASSET_UNAVAILABLE')
            return resolver(request)
          } })
        const reminderService = reminders.service()
        const workEffects = createNativeWorkEffects({ executor: () => work, sources: () => messageSources?.reader })
        const conversationEffects = createNativeConversationService({
          port: createOneBotConversationPort({ endpoint: configuration.adapters.onebotHttp.endpoint,
            ...(configuration.adapters.onebotHttp.secret ? { accessToken: configuration.adapters.onebotHttp.secret } : {}) }),
          messagePort: createOneBotActionPort({ endpoint: configuration.adapters.onebotHttp.endpoint,
            ...(configuration.adapters.onebotHttp.secret ? { accessToken: configuration.adapters.onebotHttp.secret } : {}) }),
          register: (asset, signal) => { if (!media) failure('NATIVE_MEDIA_UNAVAILABLE'); return media.register(asset, signal) },
          selfId, store: store!, sources: () => messageSources?.reader,
          authorize: (conversationId, signal) => guard(conversationId, signal, true, 'resource') })
        const memoryEffects = createNativeMemoryEffects({ service: () => memoryPackage, sources: () => messageSources?.reader })
        if (['native.media.inspect', 'native.media.read', 'native.stickers.list', ...Object.keys(conversationEffects), ...Object.keys(reminderService.effects), ...Object.keys(memoryEffects), ...Object.keys(workEffects)].some(name => bootstrapMount?.bridgeOptions.effectAdapters?.[name])) {
          failure('NATIVE_CHAT_RESERVED_CAPABILITY')
        }
        if ([...ONEBOT_PROTOCOL_EVENT_TYPES, NATIVE_TOOL_EVENT, ...Object.keys(reminderService.eventValidators)].some(type => bootstrapMount?.bridgeOptions.eventValidators?.[type])) {
          failure('NATIVE_CHAT_RESERVED_PROTOCOL_EVENT')
        }
        const protocolValidators = Object.fromEntries(ONEBOT_PROTOCOL_EVENT_TYPES.map(type => [type, (data: JsonObject) => {
          const selfId = observeConnection().selfId
          return selfId !== null && data.selfId === selfId && data.accountId === selfId
            && validateOneBotProtocolEventData(type, data)
        }]))
        host = createBridgeHost({ store, accountScope, agent, context, persona: personaReference,
          ...bootstrapMount?.bridgeOptions,
          onAgentDelivery: (requestId, receipt) => workFeedback?.delivered(requestId, receipt),
          shouldSendAgentMessage: async event => !await replyFreshness?.hold(event),
          eventValidators: { ...bootstrapMount?.bridgeOptions.eventValidators, ...protocolValidators, ...reminderService.eventValidators, [NATIVE_TOOL_EVENT]: validateNativeToolEvent },
          effectAdapters: { ...bootstrapMount?.bridgeOptions.effectAdapters, ...reminderService.effects, ...memoryEffects, ...workEffects, ...conversationEffects,
            'native.stickers.list': { execute(request) {
              if (!stickers) failure('NATIVE_STICKERS_UNAVAILABLE')
              return stickers.list.execute(request)
            } }, 'native.media.inspect': { execute(request) {
            if (!media) failure('NATIVE_MEDIA_UNAVAILABLE')
            return media.inspect.execute(request)
          } }, 'native.media.read': { execute(request) {
            if (!media) failure('NATIVE_MEDIA_UNAVAILABLE')
            return media.read.execute(request)
          } } },
          agentInputPreparation: composeAgentInputPreparation([
            { id: 'native-context', order: 0, capabilities: [], async prepare(execution, event) {
              if (!host || !active) failure('NATIVE_CHAT_STOPPED')
              const history = host.history.snapshot(event.conversationId, { afterSequence: 0, limit: 100 })
              const unread = host.history.snapshot(event.conversationId, { limit: 100 })
              // Inputs queued after this batch belong to a later submission, not this read cursor.
              const through = history.messages.find(item => item.id === event.id)?.sequence ?? history.latestSequence
              const visibleHistory = history.messages.filter(item => item.sequence <= through)
              const binding = host.sessions.get(event.conversationId)
              const unsentReplyMessageIds = binding && event.userId
                ? replyFreshness?.prepare(binding, event.userId, event.id) : undefined
              const owner = active.access.owner
              const quotedMessages = await quotedContext?.read({ conversationId: event.conversationId,
                content: normalizeContent(event.data.content) }, visibleHistory, execution.signal)
              inbound.preparedReadCursor(digest([event.conversationId, event.id, 'prompt']), through)
              return prepareNativeChatInput(event, visibleHistory, { owner, partial: unread.partial, unsentReplyMessageIds,
                attachImages: active.deployment.modelSettings?.inputModalities?.includes('image') !== false,
                unread: { ids: unread.messages.filter(item => item.sequence <= through && item.actor !== 'assistant' && item.actor !== 'system').map(item => item.id), readThrough: unread.readThrough,
                  through, partial: unread.partial },
                quotedMessages, tools: await frameworkTools?.context(event.conversationId, execution.signal),
                output: { ...await output.context(execution.signal), forwardAuthorized: !host.policy.describe().paused && host.policy.describe().grants.some(grant =>
                  grant.active && grant.featureId === 'agent-relay' && grant.conversationId === event.conversationId
                  && grant.capabilities.includes('messaging.forward') && (grant.expiresAt === null || grant.expiresAt > Date.now())
                  && (grant.maxUses['messaging.forward'] === null || (grant.maxUses['messaging.forward'] ?? 0) > (grant.used['messaging.forward'] ?? 0))) },
                participation: inbound.participation(digest([event.conversationId, event.id, 'prompt'])) })
            } },
            ...(bootstrapMount?.bridgeOptions.agentInputPreparation
              ? [{ id: 'bootstrap-input', order: 100, ...bootstrapMount.bridgeOptions.agentInputPreparation }] : [])
          ]),
          agentMessagePreparation: { capabilities: bootstrapMount?.bridgeOptions.agentMessagePreparation?.capabilities ?? [],
            async prepare(execution, event) {
              if (await replyFreshness?.hold(event)) return null
              const prepared = bootstrapMount?.bridgeOptions.agentMessagePreparation
                ? await bootstrapMount.bridgeOptions.agentMessagePreparation.prepare(execution, event) : event.data.content
              return prepared === null ? null : output.prepare(prepared, event, execution.signal)
            } },
          splitAgentMessage: output.split,
          followPool: { maxSessions: 16, isIdle: binding => executions?.forConversation(binding.conversationId) === null },
          transport: { capabilities: () => sourceTransport.capabilities!(), async send(request) {
            const activityContent = nativeActivityContent(request.content)
            try {
              await checkpoint('send.before', { conversationId: request.conversationId, idempotencyKey: request.idempotencyKey,
                content: json(request.content) }, request.signal)
              await guard(request.conversationId, request.signal, false, 'delivery')
              const receipt = await sourceTransport.send(request)
              await checkpoint('send.after', { conversationId: request.conversationId, status: receipt.status,
                idempotencyKey: request.idempotencyKey }, request.signal).catch(() => {})
              activity.record(receipt.status === 'confirmed' ? 'send_confirmed'
                : receipt.status === 'rejected' ? 'send_rejected' : 'send_unknown', request.conversationId, activityContent)
              return receipt
            } catch (error) {
              activity.record('send_failed', request.conversationId, activityContent)
              throw error
            }
          } },
          authorizeIncoming: async (message: InboundMessage, signal: AbortSignal) => {
            try {
              await guard(message.conversationId, signal, false, 'admission')
              return !message.isSelf && (!message.directed || executions?.forConversation(message.conversationId) === null && !workFeedback?.busy(message.conversationId))
            } catch { return false }
          }, taskTickMs: 25, replyTimeoutNotice: null, replyRecovery: 'record-only',
          replyTimeoutMs: configuration.execution.turnTimeoutMs, eventTimeoutMs: configuration.execution.turnTimeoutMs,
          timeouts: { createSessionMs: configuration.execution.turnTimeoutMs, followMs: 15_000,
            submitMs: configuration.execution.turnTimeoutMs, sendMs: 15_000, startMs: 15_000 },
          onFault(code) {
            lastError = safeCode(new FrameworkError(code, 'Native host operation failed.'))
            activity.record(code === 'AGENT_SUBMIT_TIMEOUT_UNKNOWN' ? 'submit_timeout' : code.includes('TIMEOUT') ? 'deadline' : 'error',
              null, undefined, {}, code)
          } })
        const authorizationIdentity = readMigrationAuthorizationIdentity(store, identity)
        applyAuthorization(configuration, authorizationIdentity)
        activeIdentity = authorizationIdentity
        await bootstrapMount?.install(host)
        const executionFault = (code: string) => {
          lastError = safeCode(new FrameworkError(code, 'Execution state is unavailable.')); state = 'error'
          activity.record('error')
        }
        executions = createNativeExecutionController({ store, policy: configuration.execution, onFault: executionFault,
          ...createNativeExecutionPolicyActions({ policy: host.policy, transport: host.outbox,
            persona: { id: contentIdentity.contextId, version: personaMetadata.scopeVersion }, cancel: sourceAgent.cancel,
            async guard(request) {
              await guard(request.execution.binding.conversationId, request.signal)
              const binding = host?.sessions.get(request.execution.binding.conversationId)
              if (!binding || binding.sessionId !== request.execution.binding.sessionId
                || binding.generation !== request.execution.binding.generation) failure('SESSION_STALE')
            } }) })
        executions.start()
        const readProtocol = createOneBotActionPort({ endpoint: configuration.adapters.onebotHttp.endpoint,
          ...(configuration.adapters.onebotHttp.secret ? { accessToken: configuration.adapters.onebotHttp.secret } : {}),
          allowedActions: ONEBOT_READ_ACTIONS })
        media = createNativeMediaRegistry({ store: store!, accountId: selfId,
          protocol: readProtocol, transcriber: options.mediaTranscriber,
          videoObserver: createFfmpegVideoObserver({ directory: options.directory }),
          async observeVideo(signal) { signal.throwIfAborted(); const saved = await packageConfigurationRegistry.read('media');
            signal.throwIfAborted(); return validateNativeMediaConfiguration(saved.configuration).observeVideo },
          contentReader: createOneBotMediaReader({ actions: readProtocol,
            trustedOrigins: [new URL(configuration.adapters.onebotHttp.endpoint).origin], maxBytes: 8 * 1024 * 1024, timeoutMs: 15000 }),
          authorize: (conversationId, signal) => guard(conversationId, signal, true, 'resource') })
        stickers = createNativeStickerService({
          port: createOneBotStickerPort({ endpoint: configuration.adapters.onebotHttp.endpoint,
            ...(configuration.adapters.onebotHttp.secret ? { accessToken: configuration.adapters.onebotHttp.secret } : {}) }),
          register: media.register, authorize: (conversationId, signal) => guard(conversationId, signal, true, 'resource') })
        packages = createNativePackages({ packages: [createChatInputNativePackage({ directory: options.directory,
          async readPersona() {
            const latest = await options.loadConfiguration()
            const plan = latest.catalog.plans.find(item => item.id === latest.catalog.activePlanId)
            return latest.personas.find(item => item.id === plan?.personaId)
          } }),
          createMediaNativePackage({ registry: media }), createRemindersNativePackage({ service: reminderService }),
          createMemoryNativePackage({ service: memory.start() }), createNativeOutputPackage(output), createNativeServicesPackage({ ports: {
            agent: { status: () => ({ available: state === 'running' && dsh !== undefined && pluginEpoch !== null,
              missingReasons: state === 'running' && dsh && pluginEpoch ? [] : ['native_agent_not_ready'] }),
              binding(conversationId) { const binding = host?.sessions.get(conversationId); return binding?.sessionId
                ? { conversationId, sessionId: binding.sessionId, generation: binding.generation } : null } },
            interactions: { snapshot: () => interactions.snapshot() },
            executions: { read: id => executions?.get(id) ?? null, list: query => executions?.list(query) ?? [] },
            tools: { catalog: signal => runtime.tools(signal) },
            work: { status: () => runtime.workStatus(), read: id => runtime.readWork(id), list: query => runtime.listWork(query) }
          } }), ...(bootstrapMount?.packageDefinitions ?? [])], signal: controller.signal,
          configurationRegistry: packageConfigurationRegistry, stateStore: store,
          ...(options.bootstrap ? { bootstrapContent: {
            identity: options.bootstrap.metadata.contentIdentity ?? { fingerprint: options.bootstrap.metadata.codeFingerprint, coverage: 'entry-only' as const, files: 1 },
            packageIds: bootstrapMount?.packageDefinitions.map(definition => definition.manifest.id) ?? [],
            verify: signal => options.bootstrap!.verifyContent?.(signal) ?? Promise.resolve()
          } } : {}) })
        const packageStates = await packages.start()
        packageUnknown = packageStates.some(item => item.state === 'unknown')
        if (packageStates.some(item => item.state !== 'running')) failure('NATIVE_CHAT_PACKAGE_START_FAILED')
        await bootstrapMount?.bindPackages(host, packages)
        inputPackage = packages.service('chat-input', 1) as NativeChatInputPackageService
        media = packages.service('media', 1) as NativeMediaPackageService
        memoryPackage = packages.service('memory', 1) as NativeMemoryPackageService
        host.engine.install(reminderService.feature)
        quotedContext = createNativeQuotedContext({ protocol: { getMessage: request => readScopedProtocolMessage({
          ...request, port: readProtocol, store: store!, selfId, ...(accountScope ? { accountScope } : {}) }) }, selfId, register: media.register,
          observe(conversationId, result) { if (store) recordNativeQuoteRead(store, conversationId, result) },
          authorize: (conversationId, signal) => guard(conversationId, signal, true, 'resource') })
        await dsh.verify(controller.signal)
        if (!dsh.bridgePlugin) failure('NATIVE_CHAT_CORRELATION_PLUGIN_UNAVAILABLE')
        const plugin = await dsh.bridgePlugin.describe(controller.signal).catch(() => failure('NATIVE_CHAT_CORRELATION_PLUGIN_UNAVAILABLE'))
        pluginEpoch = plugin.issuerEpoch
        claims = createNativeExecutionClaims({ store, port: dsh.bridgePlugin, issuerEpoch: pluginEpoch, executions,
          signal: controller.signal, onFault: executionFault, onCorrelationFault(code) {
            if (controller.signal.aborted || lifetime !== controller) return
            pluginEpoch = null
            lastError = safeCode(new FrameworkError(code, 'Trusted turn correlation is unavailable.'))
            activity.record('error')
          } })
        const workTarget = options.resolveWorkTarget ? await options.resolveWorkTarget(controller.signal) : null
        workMissingReasons = workTarget?.missingReasons ?? ['native_work_target_unavailable']
        // Register the host once; availability and the selected model are resolved for each task.
        if (plugin.workProtocol === 'qq-agent-framework.work/1' && dsh.work && options.resolveWorkTarget) {
          const workHost = host
          const resolveTarget = options.resolveWorkTarget
          const workPort = dsh.work
          const workInteractions = dsh
          workAssets = createNativeWorkAssets({ directory: options.directory, store, accountId: selfId, port: workPort,
            parent(sessionId) { const binding = bindingForSession(sessionId); return binding ?? null },
            authorize: (conversationId, signal) => guard(conversationId, signal, true, 'resource') })
          const createBackend = (resolveBackendTarget: Parameters<typeof createDshNativeWorkBackend>[0]['resolveTarget']) => createDshNativeWorkBackend({ port: workPort, issuerEpoch: pluginEpoch!,
            generation: sessionId => bindingForSession(sessionId)?.generation ?? null,
            resolveTarget: resolveBackendTarget, registerResultAsset: workAssets!.register,
            recordUsage(observed) {
              if (!usage || !store) return
              try {
                const record = store.read('native-work.executions', observed.address.id)
                if (!record || !isRecord(record.value)) failure('NATIVE_WORK_USAGE_BINDING_MISSING')
                const saved = record.value
                if (saved.childId !== observed.address.childId || saved.parentSessionId !== observed.address.parentSessionId
                  || saved.generation !== observed.address.generation || typeof saved.conversationId !== 'string') failure('NATIVE_WORK_USAGE_BINDING_MISMATCH')
                const workConfiguration = isRecord(saved.configuration) ? saved.configuration : null
                for (const step of observed.steps) {
                  const count = (key: keyof typeof step.usage): number | null => step.usage[key] ?? null
                  createNativeUsage({ store, clock: () => step.at }).append({ conversationId: saved.conversationId,
                    sessionId: observed.address.childId, generation: observed.address.generation, turnId: step.turn,
                    stepId: step.eventId, stepNumber: step.step, coverage: 'complete', status: step.status,
                    provider: observed.provider ?? (typeof workConfiguration?.provider === 'string' ? workConfiguration.provider : step.provider),
                    externalProvider: step.provider, model: step.model, tokens: { input: count('inputTokens'), output: count('outputTokens'),
                      cacheRead: count('cacheReadTokens'), cacheWrite: count('cacheWriteTokens'), total: count('totalTokens'), reasoning: count('reasoningTokens') }, reportedCost: null })
                }
              } catch (error) { usageFaults++; lastUsageError = safeCode(error); activity.record('usage_error') }
            } })
          const checkedTarget = (resolved: NativeAssistantTargetResolution, configuration: NativeAssistantTargetResolution['configuration']) => {
            if (resolved.missingReasons.length || !resolved.externalProvider || !resolved.agentPreset
              || digest(configuration) !== digest(resolved.configuration)) failure('NATIVE_WORK_TARGET_UNVERIFIED')
            return { modelProvider: resolved.externalProvider, model: resolved.configuration.model!, agentPreset: resolved.agentPreset,
              ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) }
          }
          const backend = createBackend(async (configuration, signal) => {
              const resolved = await resolveTarget(signal)
              return checkedTarget(resolved, configuration)
            })
          work = createNativeWorkExecutor({ store, onObservation(event) { activity.observe({ ...event, correlation: { ...event.correlation,
              ...(accountScope ? { protocolId: accountScope.protocolId, accountId: accountScope.accountId } : {}) } }) }, messageSources: messageSources.reader, backend,
            registerChild(binding) { return workInteractions.registerInteractionSession(binding.childId) },
            ...(options.prepareWorkTarget ? { prepareAdmission: async (signal: AbortSignal) => {
              const prepared = await options.prepareWorkTarget!(signal)
              if (prepared.resolution.missingReasons.length || !prepared.resolution.configuration.enabled) failure('NATIVE_WORK_PREPARATION_REJECTED')
              checkedTarget(prepared.resolution, prepared.resolution.configuration)
              return { configuration: prepared.resolution.configuration, assertCurrent: prepared.assertCurrent,
                backend: createBackend(async (configuration, currentSignal) => {
                  await prepared.assertCurrent(currentSignal)
                  return checkedTarget(prepared.resolution, configuration)
                }) }
            } } : {}),
            async loadConfiguration() { return (await resolveTarget(controller.signal)).configuration },
            async authorize(scope, signal) {
              await guard(scope.conversationId, signal, true, 'resource')
              const binding = workHost.sessions.get(scope.conversationId)
              if (!binding || binding.sessionId !== scope.sessionId || binding.generation !== scope.generation) failure('SESSION_STALE')
            },
            isCurrentParent(binding) {
              const current = workHost.sessions.get(binding.conversationId)
              return lifetime === controller && !controller.signal.aborted && current?.sessionId === binding.sessionId
                && current.generation === binding.generation
            },
            onProgress: view => workFeedback?.progress(view),
            onResult: createNativeWorkDelivery({ host: workHost, store, persona: outgoingPersona,
              present: (result, signal) => workFeedback ? workFeedback.result(result, signal) : Promise.resolve({ status: 'rejected' }),
              owner: () => active?.access.owner ?? null,
              guard: (conversationId, signal) => guard(conversationId, signal, true, 'delivery') }),
            onFault(code) { lastError = code; activity.record('error') } })
        }
        if (plugin.frameworkToolProtocol === 'qq-agent-framework.tools/1' && dsh.frameworkTools) {
          frameworkTools = createNativeFrameworkTools({ host, store, onObservation: activity.observe, port: dsh.frameworkTools, issuerEpoch: pluginEpoch,
            tools: [...NATIVE_STICKER_TOOLS, ...NATIVE_CONVERSATION_TOOLS, ...(work ? NATIVE_WORK_TOOLS : [])],
            async toolDescriptions(signal): Promise<Readonly<Record<string, string>>> {
              const identity = await options.readWorkIdentity?.(signal)
              signal.throwIfAborted()
              const start = NATIVE_WORK_TOOLS.find(tool => tool.definition.name === 'qaf_work_start')!
              return identity ? { qaf_work_start: `${start.definition.description}\n当前配置的助手：${JSON.stringify(identity)}。此配置说明覆盖历史回复中对助手身份或可调用性的猜测。` } : {}
            },
            async unavailableCapabilities(signal) {
              if (!work || !options.resolveWorkTarget) return NATIVE_WORK_TOOLS.map(tool => tool.definition.capability)
              // Visibility needs the local mode only. Work execution resolves and verifies its target before use.
              signal.throwIfAborted()
              const enabled = options.readWorkEnabled ? await options.readWorkEnabled(signal)
                : workTarget?.configuration.enabled === true && workTarget.missingReasons.length === 0
              signal.throwIfAborted()
              return enabled ? [] : NATIVE_WORK_TOOLS.map(tool => tool.definition.capability)
            },
            signal: controller.signal, async guard(scope, signal) {
              await guard(scope, signal, true, 'resource')
              await toolPolicy.sync(signal)
            },
            async resolveScope(call, signal) {
              const binding = bindingForSession(call.sessionId)
              if (!binding || binding.generation !== call.generation || !executions || !claims || !host || !messageSources) return null
              let execution = executions.forConversation(binding.conversationId)
              if (!execution || execution.requestId !== call.requestId) return null
              await claims.poll(execution.id)
              await guard(binding.conversationId, signal, true, 'resource')
              execution = executions.forConversation(binding.conversationId)
              if (!execution || execution.requestId !== call.requestId || execution.binding.generation !== call.generation
                || execution.binding.sessionId !== call.sessionId || execution.turn?.id !== String(call.turn)
                || execution.userMessage?.messageId !== call.userMessageId || execution.deadlineReached
                || execution.cancelStatus !== 'not-requested' || !['submitting', 'running'].includes(execution.status)) return null
              const source = host.history.snapshot(binding.conversationId, { afterSequence: 0, limit: 100 }).messages.find(item =>
                digest([binding.conversationId, item.id, 'prompt']) === call.requestId)
              if (!source) return null
              const scope = { ...(accountScope ? { accountScope } : {}), eventId: source.id, conversationId: binding.conversationId, sessionId: call.sessionId,
                generation: call.generation, featureId: 'framework-tools', version: '1.0.0' }
              await messageSources.reader.lookup(scope, signal)
              const eventId = digest(['framework-tool', plugin.issuerEpoch, call.sessionId, call.generation, call.id])
              await messageSources.alias(scope, eventId, signal)
              return { ...scope, eventId }
            } })
          host.engine.install(frameworkTools.feature)
          await toolPolicy.sync(controller.signal)
        }
        await host.start()
        await frameworkTools?.recoverPending(controller.signal)
        const interactionAssembly = createNativeInteractionAssembly({ interactions, port: dsh, signal: controller.signal,
          epoch: fingerprint([identity, Date.now(), configuration.revisions]), persona: outgoingPersona, bindingForSession,
          guard: (conversationId, signal) => guard(conversationId, signal, true, 'interaction'), resources: {
            get host() { return host }, get work() { return work }, get executions() { return executions },
            get owner() { return active?.access.owner ?? null }
          } })
        interactionMessages = interactionAssembly.messages
        releaseInteractions = interactionAssembly.release
        stopInteractions = await interactionAssembly.connect()
        await bootstrapMount?.start(host, controller.signal)
        controller.signal.throwIfAborted()
        if (host.metrics().startupState !== 'ready' || host.metrics().faults > 0) failure('NATIVE_CHAT_HOST_NOT_READY')
        const latest = await options.loadConfiguration()
        if (!sameRevisions(configuration.revisions, latest.revisions)) failure('NATIVE_CHAT_REVISION_CONFLICT')
        captureNativeConfigurationBaseline(store!, { definition, persona, endpoint: configuration.adapters.dshAgent.endpoint,
          bindings: selected.deployment.presetBindings }, [...configuration.providers.map(provider => provider.apiKey),
          configuration.adapters.onebotHttp.secret, configuration.adapters.onebotWs.secret,
          configuration.adapters.dshAgent.auth, configuration.adapters.onebotWebhook.hmac])
        const inboxRecheckedAt = new Map<string, number>()
        const inboxRechecking = new Set<string>()
        inbox = createNativeInbox({ store: store!, coalesceMs: 120,
          readiness(conversationId) {
            if (state !== 'running' || controller.signal.aborted || !host || !executions) return 'blocked'
            if (workFeedback?.busy(conversationId)) return 'busy'
            const execution = executions.forConversation(conversationId)
            if (execution) {
              const uncertain = execution.deadlineReached || execution.status === 'unknown'
                || execution.externalStatus === 'unknown' || execution.cancelStatus !== 'not-requested'
              // Observe the old execution in the background. No prompt, replay, cancellation or session reset.
              if (uncertain && !inboxRechecking.has(conversationId) && inboxRechecking.size < 4
                && Date.now() - (inboxRecheckedAt.get(conversationId) ?? 0) >= 5_000) {
                inboxRecheckedAt.set(conversationId, Date.now())
                inboxRechecking.add(conversationId)
                void withDeadline({ signal: controller.signal, timeoutMs: 5_000, code: 'NATIVE_INBOX_OBSERVATION_TIMEOUT',
                  run: signal => reconcileExecution(execution.id, signal) }).catch(() => undefined)
                  .finally(() => { inboxRechecking.delete(conversationId) })
              }
              return 'busy'
            }
            inboxRecheckedAt.delete(conversationId)
            const reply = host.replies.get(conversationId)
            if (reply?.status === 'waiting') return 'busy'
            // An expired reply watchdog is historical; only a live execution owns model admission.
            return 'ready'
          },
          async deliver(entries) {
            const entry = entries.at(-1)!
            const definition = active ? configuredDefinition(active) : undefined
            const persona = active?.personas.find(value => value.id === definition?.personaId)
            const { effective } = await inbound.readInputConfiguration(entry.message.conversationId, persona?.name)
            const mandatory = entries.some(item => item.trigger === 'mention' || item.message.conversationId.startsWith('private:'))
            if (!mandatory && entries.some(item => item.trigger === 'reply' && !effective.wakeOnReply
              || item.trigger === 'continuation' && effective.continuationMs === 0
              || item.trigger === 'nickname' && !effective.names.some(name => item.message.content.some(part =>
                part.type === 'text' && part.text.toLocaleLowerCase().includes(name.toLocaleLowerCase()))))) {
              return { status: 'rejected', errorCode: 'NATIVE_CHAT_INPUT_DISABLED' }
            }
            const admittedAt = Math.min(...entries.map(item => item.admittedAt))
            const trigger = entries.find(item => item.trigger === 'mention' || item.trigger === 'private')?.trigger
              ?? entries.find(item => item.trigger === 'nickname' || item.trigger === 'reply')?.trigger ?? 'continuation'
            inbound.setParticipation(digest([entry.message.conversationId, entry.message.id, 'prompt']),
              trigger === 'mention' || trigger === 'private' ? 'direct' : trigger)
            return inbound.dispatchIncoming(entry.message, entry.message, admittedAt, controller.signal)
          },
          onFault: executionFault,
        })
        inbox.recover()
        replyFreshness = createNativeReplyFreshness({ host, store,
          async hasWaitingFrom(conversationId, userId, messageId) {
            if (!inbox?.hasWaitingFrom(conversationId, userId, messageId)) return false
            const { effective } = await inbound.readInputConfiguration(conversationId)
            return inbox?.hasWaitingFrom(conversationId, userId, messageId, entry =>
              conversationId.startsWith('private:') || entry.trigger === 'mention' || entry.trigger === 'private'
              || entry.trigger === 'reply' && effective.wakeOnReply
              || entry.trigger === 'continuation' && effective.continuationMs > 0
              || entry.trigger === 'nickname' && effective.names.some(name => entry.message.content.some(part =>
                part.type === 'text' && part.text.toLocaleLowerCase().includes(name.toLocaleLowerCase())))) ?? false
          },
          onDeferred: conversationId => activity.record('reply_deferred', conversationId) })
        workFeedback = createNativeWorkFeedback({ host, store, signal: controller.signal,
          currentOwner: () => active?.access.owner ?? null,
          guard: (conversationId, signal) => guard(conversationId, signal, true, 'delivery'),
          ready: conversationId => state === 'running' && !inbound.isProcessing(conversationId)
            && executions?.forConversation(conversationId) === null && !inbox?.hasPending(conversationId)
            && host?.replies.get(conversationId)?.status !== 'waiting',
          onFault: code => { lastError = code; activity.record('error', null, undefined, {}, code) } })
        const runningResources: NativeRunningRunResources = { lifetime: controller, host, dsh, work, claims, executions,
          workFeedback, bootstrap: bootstrapMount, tools: frameworkTools, packages, inbox, quotedContext, reminders, memory, releaseInteractions,
          closeInteractions: stopInteractions, claimTimer, clearIngress: inbound.clear, drainConfiguration: configurationGuard.drain, drainPolicy: toolPolicy.drain }
        runningResources.lifetime.signal.throwIfAborted()
        state = 'running'
        await reminderService.start()
        await checkpoint('runtime.ready', { state: 'running', planId: definition.planId }, controller.signal)
        activity.record('running')
        const reportedTimeouts = new Set<string>()
        claimTimer = setInterval(() => {
          if (state !== 'running' || controller.signal.aborted || !executions || !claims) return
          try {
            const pending = executions.active()
            try {
              const ids = new Set(pending.map(execution => execution.id))
              for (const id of reportedTimeouts) if (!ids.has(id)) reportedTimeouts.delete(id)
              for (const execution of pending) if (execution.deadlineReached && !reportedTimeouts.has(execution.id)) {
                activity.record('execution_timeout', execution.binding.conversationId)
                reportedTimeouts.add(execution.id)
              }
            } catch {}
            for (let offset = 0; offset < Math.min(4, pending.length); offset++) {
              const execution = pending[(claimOffset + offset) % pending.length]
              void claims.poll(execution.id)
            }
            claimOffset = pending.length === 0 ? 0 : (claimOffset + 4) % pending.length
            executions.tick()
            void inbox?.tick()
          } catch (error) { executionFault(safeCode(error)) }
        }, 250)
      } catch (error) {
        lastError = safeCode(error)
        if (lastError.includes('BOOTSTRAP') && lastError.includes('UNKNOWN')) bootstrapUnknown = true
        controller.abort()
        if (ownsResources) await cleanup().catch(() => undefined)
        state = 'error'
        activity.record('start_failed')
        throw new FrameworkError(lastError, 'Native chat did not start. Check runtime status.')
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
    })()
    starting = operation
    try { await operation } finally { if (starting === operation) starting = undefined }
  }

  async function stop() {
    if (migrationOperation) failure('NATIVE_CHAT_BUSY')
    if (stopping) return stopping
    lifetime?.abort()
    state = 'stopping'
    activity.record('stopping')
    const operation = (async () => {
      await starting?.catch(() => undefined)
      await recoveryPending
      try {
        await checkpoint('runtime.stopping', { state: 'stopping' }, new AbortController().signal).catch(() => {})
        await withDeadline({ signal: new AbortController().signal, timeoutMs: 20_000,
          code: 'NATIVE_CHAT_STOP_UNKNOWN', run: cleanup })
        state = 'stopped'
        await checkpoint('runtime.stopped', { state: 'stopped' }, new AbortController().signal).catch(() => {})
        if (lifecycleHooks !== managerHooks) lifecycleHooks.close()
        if (lifecycleHooks.describe().pendingRaw === 0) lifecycleHooks = managerHooks
        activity.record('stopped')
      } catch (error) {
        state = 'error'
        lastError = safeCode(error)
        activity.record('stop_failed')
        throw error
      }
    })()
    stopping = operation
    await operation
    if (stopping === operation) stopping = undefined
  }

  const adapterRuntime: AdapterRuntimePort = Object.freeze({
    status: () => connection.status(),
    async connectionStatus() {
      if (state !== 'running') return connection.connectionStatus()
      const runtime = await status()
      return runtime.connection
    },
    async connect(configuration: NativeAdapterConfiguration, signal: AbortSignal) {
      if (!['stopped', 'error', 'running'].includes(state) || starting || stopping || adapterOperation || closed
        || migrationOperation || state === 'error' && releaseLease !== undefined) failure('NATIVE_CHAT_BUSY')
      // A connection repair must not apply a different configuration to a live chat.
      if (state === 'running' && (!active || digest(configuration) !== digest(active.adapters))) failure('NATIVE_CHAT_CONFIGURATION_CHANGED')
      adapterOperation = true
      try { await connection.connect(configuration, signal) } finally { adapterOperation = false }
    },
    async disconnect() {
      if (!['stopped', 'error'].includes(state) || starting || stopping || adapterOperation || closed
        || migrationOperation || releaseLease !== undefined) failure('NATIVE_CHAT_BUSY')
      adapterOperation = true
      try { await connection.disconnect() } finally { adapterOperation = false }
    }
  })

  async function reconcileExecution(id: string, signal: AbortSignal) {
    const currentHost = host
    const currentExecutions = executions
    const currentStore = store
    const generation = lifetime
    const port = dsh?.bridgePlugin
    if (closed || state !== 'running' || !currentHost || !currentExecutions || !currentStore || !generation || generation.signal.aborted || !port) {
      failure('NATIVE_EXECUTION_RECONCILIATION_UNAVAILABLE')
    }
    const combined = AbortSignal.any([signal, generation.signal])
    const description = await port.describe(combined)
    combined.throwIfAborted()
    const service = createNativeExecutionReconciliation({ store: currentStore, port, issuerEpoch: description.issuerEpoch,
      executions: currentExecutions, signal: combined, isCurrentBinding(binding) {
        const current = currentHost.sessions.get(binding.conversationId)
        return !closed && state === 'running' && lifetime === generation && host === currentHost && !combined.aborted
          && current?.sessionId === binding.sessionId && current.generation === binding.generation
      } })
    const result = await service.reconcile(id, combined)
    if (result.state === 'released') {
      combined.throwIfAborted()
      const reply = currentHost.replies.get(result.execution.binding.conversationId)
      if (reply && ['waiting', 'timed-out'].includes(reply.status)
        && digest([result.execution.binding.conversationId, reply.requestId, 'prompt']) === result.execution.requestId) {
        currentHost.replies.suppress(result.execution.binding, reply.requestId)
      }
      activity.record('execution_reconciled', result.execution.binding.conversationId)
    }
    return { ...result, restartRequired: pluginEpoch !== description.issuerEpoch }
  }

  async function recoverExecution(id: string, signal: AbortSignal, revision?: string) {
    const currentHost = host
    const currentExecutions = executions
    const currentStore = store
    const currentLifetime = lifetime
    const port = dsh
    if (state !== 'running' || closed || recoveringExecution || !currentHost || !currentExecutions || !currentStore || !currentLifetime
      || !port?.bridgePlugin || !port.sessionMigration) failure('NATIVE_EXECUTION_RECOVERY_UNAVAILABLE')
    const execution = currentExecutions.get(id)
    if (!execution) failure('EXECUTION_NOT_FOUND')
    const conversationId = execution.binding.conversationId
    recoveringExecution = true
    let completeRecovery!: () => void
    recoveryPending = new Promise<void>(resolve => { completeRecovery = resolve })
    const previouslyFrozen = frozenRecoveryConversations.has(conversationId)
    frozenRecoveryConversations.add(conversationId)
    const combined = AbortSignal.any([signal, currentLifetime.signal, controlLifetime.signal])
    let preserveFreeze = previouslyFrozen || revision !== undefined
    try {
      const description = await port.bridgePlugin.describe(combined)
      const service = createNativeExecutionRecovery({ store: currentStore, evidencePort: port.bridgePlugin,
        migrationPort: port.sessionMigration, issuerEpoch: description.issuerEpoch, executions: currentExecutions, signal: combined,
        async resolvePreset(binding, checkSignal) {
          checkSignal.throwIfAborted()
          const definition = active && configuredDefinition(active)
          const kind = binding.conversationId.startsWith('group:') ? 'group' : 'private'
          const selected = activePresetBindings.filter(item => definition && digest(item.definition) === digest(definition)
            && (item.conversationKind === undefined || item.conversationKind === kind))
          if (selected.length !== 1) failure('EXECUTION_RECOVERY_PRESET_UNAVAILABLE')
          return selected[0]!.agentPreset
        },
        async recheck(binding, checkSignal) {
          if (state !== 'running' || host !== currentHost || lifetime !== currentLifetime || closed) failure('NATIVE_EXECUTION_RECOVERY_UNAVAILABLE')
          await configurationGuard.check(binding.conversationId, checkSignal, true, 'resource')
          const actual = currentHost.sessions.get(binding.conversationId)
          if (!actual || actual.sessionId !== binding.sessionId || actual.generation !== binding.generation) failure('EXECUTION_RECOVERY_BINDING_CHANGED')
          if (!currentHost.policy.describe().grants.some(grant => grant.conversationId === binding.conversationId && nativeChatGrantAvailable(grant))) failure('EXECUTION_RECOVERY_AUTHORIZATION_UNAVAILABLE')
        } })
      const result = revision === undefined ? await service.preview(id, combined) : await service.commit(id, revision, combined)
      if (result.state === 'completed') {
        const reply = currentHost.replies.get(conversationId)
        if (reply && digest([conversationId, reply.requestId, 'prompt']) === execution.requestId) currentHost.replies.suppress(execution.binding, reply.requestId)
        pluginEpoch = null
        preserveFreeze = true
        activity.record('execution_recovered', conversationId)
      }
      return result
    } finally {
      recoveringExecution = false
      completeRecovery()
      recoveryPending = undefined
      if (!preserveFreeze) frozenRecoveryConversations.delete(conversationId)
    }
  }

  async function diagnostics(conversationId: string) {
    const current = await status()
    const configuration = await options.loadConfiguration()
    const persona = configuration.personas.find(item => item.id === configuration.catalog.plans.find(plan => plan.id === configuration.catalog.activePlanId)?.personaId)
    const input = await readChatInputConfiguration(options.directory, conversationId, persona?.name, persona?.wake).catch(() => null)
    let history: ReturnType<NativeHistoryReader['diagnostics']> | null = null
    let historyState: 'present' | 'absent' | 'unavailable' = 'present'
    try { history = readHistorySnapshot(value => value.diagnostics(conversationId)) }
    catch (error) { historyState = error instanceof FrameworkError && error.code === 'STORE_NOT_FOUND' ? 'absent' : 'unavailable' }
    const binding = host?.sessions.get(conversationId)
    const appliedDefinition = active && configuredDefinition(active)
    const appliedLimit = appliedDefinition?.contextLimits?.[conversationId.startsWith('group:') ? 'group' : 'private']
    const context = current.chatReady && binding && appliedLimit ? {
      source: 'active-session' as const, limit: appliedLimit, headroomTokens: null, modelWindow: null, maxOutput: null
    } : null
    return { ...projectNativeDiagnostics({ conversationId, running: state === 'running', globalReasons: current.missingReasons,
      accessAllowed: allowed(configuration, conversationId), authorized: host ? host.policy.describe().grants.some(grant =>
        grant.conversationId === conversationId && nativeChatGrantAvailable(grant)) : null,
      input: input?.effective ?? null, history, historyState,
      pendingInteractions: interactions.snapshot().items.filter(item => item.conversationId === conversationId
        && ['pending', 'submitting', 'unknown'].includes(item.status)).length }), context }
  }

  async function mediaDiagnostics(conversationId: string, limit = 100): Promise<NativeMediaDiagnostics> {
    let observeVideo = false
    try { observeVideo = validateNativeMediaConfiguration((await packageConfigurationRegistry.read('media')).configuration).observeVideo } catch {}
    const settings = { conversationId, limit, running: state === 'running' && media !== undefined, transcriber: options.mediaTranscriber !== undefined, observeVideo }
    const empty = readNativeMediaDiagnostics({ read: () => null, list: () => [] }, settings)
    try { return store ? readNativeMediaDiagnostics(store, settings) : readHistorySnapshot(value => value.media(settings)) }
    catch (error) { return { ...empty, coverage: error instanceof FrameworkError && error.code === 'STORE_NOT_FOUND' ? 'absent' : 'unavailable' } }
  }

  const runtime = Object.freeze({ status, start, stop, adapterRuntime, applyAccessChange, reconcileExecution, recoverExecution, diagnostics, mediaDiagnostics,
    retentionStatus() { const value = store?.retentionStatus() ?? { enabled: true, retentionDays: 7, state: 'pending', lastRunAt: null, removed: 0, totalRecords: null, maxRecords: null, reason: null }; return operationRetention.status() ? { ...value, state: 'attention', reason: operationRetention.status() } : value },
    applicationSignal() { return controlLifetime.signal },
    isClosed() { return closed },
    previewSessionMigration(revisions: Readonly<Record<string, string>>, signal: AbortSignal) {
      return migrate(revisions, signal)
    },
    migrateSessions(input: NativeSessionMigrationCommit, signal: AbortSignal) {
      return migrate(input.revisions, signal, input)
    },
    async synchronizeProtocol(configuration: NativeAdapterConfiguration, signal: AbortSignal): Promise<void> {
      if (closed || !['stopped', 'error'].includes(state) || starting || stopping || adapterOperation || releaseLease !== undefined) return
      if (configuration.onebotWs.enabled) await adapterRuntime.connect?.(configuration, signal)
      else await adapterRuntime.disconnect?.()
    },
    activity() { return activity.read(state) },
    interactions() { return closed ? undefined : interactions },
    async toolInventory(signal: AbortSignal) {
      signal.throwIfAborted()
      const currentDsh = dsh
      let temporary: ReturnType<typeof createDshJsonRpcPort> | undefined
      try {
        if (closed) return withFrameworkToolInventory(unavailableToolInventory('native_chat_closed', 'not-connected'))
        if (!currentDsh) {
          const configuration = await options.loadConfiguration()
          signal.throwIfAborted()
          temporary = createDshJsonRpcPort({ endpoint: configuration.adapters.dshAgent.endpoint,
            ...createDshAuthenticationOptions(configuration.adapters.dshAgent), timeoutMs: 4_500 })
        }
        const inventory = await readDshToolInventory((currentDsh ?? temporary)?.bridgePlugin, signal)
        let sessionNames: ReadonlySet<string> | undefined
        if (currentDsh && state === 'running') {
          try {
            const observed = await runtime.tools(AbortSignal.any([signal, AbortSignal.timeout(1000)]))
            if (observed.state === 'available' && !observed.limited && !observed.missingReasons.includes('some_tool_scopes_unavailable')) {
              sessionNames = new Set(observed.items.map(item => item.name))
            }
          } catch { signal.throwIfAborted() }
        }
        signal.throwIfAborted()
        return withFrameworkToolInventory(inventory, frameworkTools?.inventory(), sessionNames)
      } catch {
        signal.throwIfAborted()
        return withFrameworkToolInventory(unavailableToolInventory('tool_inventory_connection_unavailable'), frameworkTools?.inventory())
      } finally { await temporary?.close() }
    },
    async tools(signal: AbortSignal) {
      const generation = lifetime
      const currentHost = host
      const configuration = active
      const liveSessions: { sessionId: string; agentPreset: string; conversationId: string; generation: number }[] = []
      let limited = false
      if (state === 'running' && !closed && currentHost && configuration) {
        const definition = configuredDefinition(configuration)
        const bindings = currentHost.sessions.list({ limit: 1_000 })
        limited = bindings.length >= 1_000
        const seen = new Set<string>()
        for (const binding of bindings) {
          if (binding.state !== 'ready') continue
          const kind = binding.conversationId.startsWith('group:') ? 'group' : 'private'
          const matches = activePresetBindings.filter(candidate => definition && digest(candidate.definition) === digest(definition)
            && (candidate.conversationKind === undefined || candidate.conversationKind === kind))
          if (!binding.sessionId || matches.length !== 1 || seen.has(binding.sessionId)) {
            return { state: 'unavailable' as const, scope: null, items: [], limited,
              missingReasons: ['native_tool_session_binding_unverified'], externalToolAuthorizationVerified: false as const }
          }
          if (liveSessions.length >= 128) { limited = true; break }
          seen.add(binding.sessionId)
          liveSessions.push({ sessionId: binding.sessionId, agentPreset: matches[0]!.agentPreset,
            conversationId: binding.conversationId, generation: binding.generation })
        }
      }
      const catalog = await readDshToolCatalog({ running: state === 'running' && !closed, scopes: [],
        sessions: liveSessions.map(binding => ({ sessionId: binding.sessionId, agentPreset: binding.agentPreset })),
        port: dsh?.bridgePlugin, signal: generation ? AbortSignal.any([signal, generation.signal]) : signal })
      if (generation !== lifetime || currentHost !== host || configuration !== active
        || liveSessions.some(observed => {
          const binding = currentHost?.sessions.get(observed.conversationId)
          return !binding || binding.sessionId !== observed.sessionId || binding.generation !== observed.generation
        })) failure('NATIVE_CHAT_CONFIGURATION_CHANGED')
      return { ...catalog, limited: limited || catalog.limited }
    },
    configurationBaseline() {
      try {
        if (closed) failure('NATIVE_CHAT_CLOSED')
        verifyPersistedAccount()
        return readNativeConfigurationBaseline(options.directory)
      } catch {
        return { schema: 1 as const, state: 'unavailable' as const, capturedAt: null, values: null,
          unavailableReason: 'storage-unavailable' as const }
      }
    },
    async verifyProtocolIdentity(expected: string, signal: AbortSignal) {
      if (closed || state !== 'stopped' || starting || stopping || adapterOperation || migrationOperation) failure('NATIVE_CHAT_BUSY')
      if (!/^[1-9][0-9]{0,31}$/.test(expected)) failure('NATIVE_ACCOUNT_IDENTITY_MISMATCH')
      const configuration = await options.loadConfiguration()
      const current = connection.connectionStatus()
      if (current.state !== 'connected') {
        if (!adapterRuntime.connect) failure('NATIVE_CONTROL_PROTOCOL_UNAVAILABLE')
        await adapterRuntime.connect(configuration.adapters, signal)
      }
      const connected = connection.connectionStatus()
      if (connected.state !== 'connected' || connected.selfId !== expected) failure('NATIVE_ACCOUNT_IDENTITY_MISMATCH')
      await verifyHttpIdentity(expected, configuration, signal)
      const latest = await options.loadConfiguration()
      if (latest.revisions.adapters !== configuration.revisions.adapters || state !== 'stopped') failure('NATIVE_CHAT_CONFIGURATION_CHANGED')
      return { verified: true as const, selfId: expected, evidence: digest(['onebot-handshake', expected, configuration.revisions.adapters]) }
    },
    assertDeletionReady() {
      if (closed || starting || stopping || inbound.status().activeConversations > 0
        || (executions?.metrics().rawPending ?? 0) > 0 || (executions?.metrics().pendingActions ?? 0) > 0) failure('SESSION_MANAGEMENT_BUSY')
      if (store) for (const namespace of ['host.execution-conversations', 'native-work.executions']) {
        let after: string | undefined
        while (true) {
          const page = store.list(namespace, { limit: 1000, ...(after ? { after } : {}) })
          if (page.some(row => namespace === 'host.execution-conversations' || !isRecord(row.value)
            || !['completed', 'failed'].includes(String(row.value.status)) || ['delivering', 'unknown'].includes(String(row.value.delivery)))) failure('SESSION_MANAGEMENT_BUSY')
          if (page.length < 1000) break
          after = page.at(-1)!.key
        }
      }
    },
    assertSessionIdle(target: NativeSessionResetTarget) {
      if (closed || starting || stopping || inbound.isProcessing(target.key)) failure('SESSION_MANAGEMENT_BUSY')
      if (store) assertNativeSessionIdle(store, target)
      else {
        const reader = openReadonlySqliteStore(join(options.directory, 'native-chat.sqlite'))
        try { assertNativeSessionIdle(reader, target) } finally { reader.close() }
      }
    },
    async unbindSession(target: NativeSessionResetTarget) {
      if (closed || state !== 'running' || starting || stopping || !store || !lifetime || inbound.isProcessing(target.key)) failure('SESSION_MANAGEMENT_BUSY')
      const currentStore = store
      const currentLifetime = lifetime
      const execution = executions?.forConversation(target.key)
      if (execution && execution.binding.sessionId === target.sessionId && execution.binding.generation === target.generation) {
        // Refresh only the addressed outstanding execution. Historical timeout labels
        // are not evidence that DSH is still running, and unbinding must not replay it.
        try {
          await withDeadline({ signal: currentLifetime.signal, timeoutMs: 6_000, code: 'SESSION_MANAGEMENT_EXECUTION_UNSETTLED',
            run: signal => reconcileExecution(execution.id, signal) })
        } catch { failure('SESSION_MANAGEMENT_EXECUTION_UNSETTLED') }
      }
      if (closed || state !== 'running' || starting || stopping || store !== currentStore || lifetime !== currentLifetime
        || inbound.isProcessing(target.key)) failure('SESSION_MANAGEMENT_BUSY')
      // Recheck the binding and admission synchronously after the observation.
      return unbindNativeSession(currentStore, target)
    },
    host() { return closed ? undefined : host },
    usage() { return closed ? undefined : usage },
    inboxSummary() {
      if (closed) failure('NATIVE_CHAT_CLOSED')
      return inbox?.summary() ?? readHistorySnapshot(history => history.inbox.summary())
    },
    readReminders(readOptions: NativeReminderReadOptions = {}) { return reminders.read(readOptions) },
    readReminderHistory(readOptions: NativeReminderReadOptions & { readonly ruleId?: string } = {}) { return reminders.history(readOptions) },
    reminderService() { return reminders.service() },
    workStatus() { return { available: state === 'running' && work !== undefined && pluginEpoch !== null,
      missingReasons: state !== 'running' ? ['native_chat_not_running'] : !work ? (workMissingReasons.length ? workMissingReasons : ['native_work_backend_unavailable']) : pluginEpoch === null ? ['native_work_channel_unknown'] : [] } },
    readUsageMaintenance(id: string) {
      if (closed) failure('NATIVE_CHAT_CLOSED')
      try { return store ? createNativeUsageMaintenance({ store }).get(id) : readHistorySnapshot(history => history.usageMaintenance.get(id)) }
      catch (error) { if (error instanceof FrameworkError && error.code === 'STORE_NOT_FOUND') return null; throw error }
    },
    listUsageMaintenance(query: Parameters<ReturnType<typeof createNativeUsageMaintenance>['list']>[0] = {}) {
      if (closed) failure('NATIVE_CHAT_CLOSED')
      try { return store ? createNativeUsageMaintenance({ store }).list(query) : readHistorySnapshot(history => history.usageMaintenance.list(query)) }
      catch (error) {
        if (error instanceof FrameworkError && error.code === 'STORE_NOT_FOUND') return { schema: 1 as const, operations: [], next: null, partial: false }
        throw error
      }
    },
    exportUsage(scope: NativeUsageMaintenanceScope, source: 'active' | 'archive') {
      if (closed) failure('NATIVE_CHAT_CLOSED')
      return store ? createNativeUsageMaintenance({ store }).export(scope, source) : readHistorySnapshot(history => history.usageMaintenance.export(scope, source))
    },
    clearUsageLedger(expectedRevision: string) {
      if (closed || starting || stopping) failure('NATIVE_USAGE_MAINTENANCE_BUSY')
      const writer = store ?? createSqliteStore({ filename: join(options.directory, 'native-chat.sqlite'), requireExisting: true })
      try {
        bindAccountStore(writer, accountScope)
        const current = createNativeUsageProjection({ usage: createNativeUsage({ store: writer }) }).summary({ limit: 200 })
        if (current.revision !== expectedRevision) failure('USAGE_MAINTENANCE_CONFLICT')
        return createNativeUsageMaintenance({ store: writer }).clearLedger()
      } finally { if (writer !== store) writer.close() }
    },
    maintainUsage(input: NativeUsageMaintenanceRequest) {
      if (closed || starting || stopping) failure('NATIVE_USAGE_MAINTENANCE_BUSY')
      const writer = store ?? createSqliteStore({ filename: join(options.directory, 'native-chat.sqlite'), requireExisting: true })
      try {
        bindAccountStore(writer, accountScope)
        const service = createNativeUsageMaintenance({ store: writer })
        return input.action === 'preview' ? service.preview(input) : service.confirm(input)
      } finally { if (writer !== store) writer.close() }
    },
    readExecutionRecovery(id: string) {
      if (closed) failure('NATIVE_CHAT_CLOSED')
      if (store) return readNativeExecutionRecovery(store, id)
      try { return readHistorySnapshot(history => history.executionRecovery(id)) }
      catch (error) { if (error instanceof FrameworkError && error.code === 'STORE_NOT_FOUND') return null; throw error }
    },
    readWork(id: string) {
      if (closed) failure('NATIVE_CHAT_CLOSED')
      if (store) return createNativeWorkHistoryReader(store).read(id)
      try { return readHistorySnapshot(history => history.work.read(id)) }
      catch (error) { if (error instanceof FrameworkError && error.code === 'STORE_NOT_FOUND') return null; throw error }
    },
    listWork(query: { readonly conversationId?: string; readonly limit?: number; readonly after?: string } = {}) {
      if (closed) failure('NATIVE_CHAT_CLOSED')
      if (store) return createNativeWorkHistoryReader(store).list(query)
      try { return readHistorySnapshot(history => history.work.list(query)) }
      catch (error) { if (error instanceof FrameworkError && error.code === 'STORE_NOT_FOUND') return { records: [], next: null }; throw error }
    },
    readMemory(readOptions: NativeMemoryReadOptions = {}) { return memory.read(readOptions) },
    readMemoryEntry(id: string) { return memory.entry(id) },
    memoryService() { return memory.service() },
    toolPermissionStatus(revision: string) { return toolPolicy.status(revision) },
    async applyToolPermissions(revision: string) {
      if (closed) failure('NATIVE_CHAT_CLOSED')
      const signal = lifetime?.signal
      if (signal && state === 'running' && frameworkTools) {
        await toolPolicy.sync(signal)
        await frameworkTools.refresh(signal)
      }
      return toolPolicy.status(revision)
    },
    readEvents(query: Parameters<typeof activity.events>[0] = {}) { observeConnection(); return activity.events(query) },
    subscribeEvents(query: Parameters<typeof activity.subscribeEvents>[0] = {}) { return activity.subscribeEvents(query) },
    executions() { return closed ? undefined : executions },
    readHistory<Result>(read: (history: NativeHistoryReader) => Result): Result {
      if (closed) failure('NATIVE_CHAT_CLOSED')
      if (starting || stopping) failure('NATIVE_HISTORY_BUSY')
      return readHistorySnapshot(read)
    },
    close(): Promise<void> {
      if (closePromise) return closePromise
      closed = true
      closePromise = Promise.resolve().then(async () => {
        const errors: unknown[] = []
        async function phase(operations: readonly (() => unknown | Promise<unknown>)[]) {
          const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)))
          for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
        }
        controlLifetime.abort()
        let controlStopped: { readonly pendingRaw: number } | undefined
        await phase([async () => {
          await preparingControl?.catch(() => undefined)
          controlStopped = await controlCommands?.stop()
        }])
        await migrationOperation?.catch(() => undefined)
        let runDrained = false
        await phase([async () => { await stop(); runDrained = true }])
        await phase([() => reminders.close(), () => memory.close(), () => connection.close()])
        await phase([observeConnection, () => activity.closeEvents(),
          () => lifecycleHooks.close(), () => managerHooks.close()])
        const heldStore = controlStore
        await phase([() => {
          if (controlCommands && (!controlStopped || controlStopped.pendingRaw > 0)) {
            void controlCommands.drain().then(() => heldStore?.close(), () => heldStore?.close()).catch(() => undefined)
          } else heldStore?.close()
        }, () => {
          // Unsettled run callbacks retain their store and recovery evidence.
          if (runDrained) { store?.close(); store = undefined }
        }])
        if (errors.length) throw errors[0]
      })
      return closePromise
    }
  })
  nativeRuntimes.add(runtime)
  return runtime
}
