import { isNativeEventCursor, isNativeEventFilter } from '../contracts/native-events.ts'
import type { NativeExecutionRecoveryView } from '../contracts/native-execution-recovery.ts'
import type { NativeExecutionRecoveryPlan } from '../host/native-execution-recovery.ts'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import {
  CHAT_PLAN_REASONING_EFFORTS,
  validateChatPlanCatalog,
  validateChatPersonas,
  type ChatPlanReasoningEffort
} from '../host/chat-plans.ts'
import { publicModelProviders } from '../host/model-providers.ts'
import {
  publicAdapterConfiguration,
  type AdapterConnectionStatus,
  type AdapterRuntimePort
} from '../host/adapter-configuration.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'
import { createHostAdminRoutes } from './host.ts'
import {
  validateNativeChatAuthorization,
  type NativeChatAuthorization, type NativeChatDeploymentConfiguration,
  type NativeChatDeploymentRuntime, type NativeChatDeploymentRuntimeInput
} from '../host/native-chat-configuration.ts'
import { isNativeChatRuntime, type NativeChatRuntime } from '../host/native-chat-runtime.ts'
import type { NativeUsageQuery } from '../host/native-usage.ts'
import { createNativeUsageProjection } from '../host/native-usage-projection.ts'
import type { NativeHistoryReader, NativeUsageReader } from '../host/native-history.ts'
import { FrameworkError, reference } from '../core/values.ts'
import { checkedNativeDeploymentRuntime } from '../host/native-deployment-runtime.ts'
import { nativeAuthorizationProjection } from '../host/native-access.ts'
import { createNativeInteractionRoutes } from './native-interactions.ts'
import { createPackageConfigurationRoutes } from './package-configuration.ts'
import { createNativeApplicationRoutes } from './native-application.ts'
import { createNativeReminderRoutes } from './native-reminders.ts'
import { createNativeAssistantDeploymentRoutes } from './native-assistant-target.ts'
import type { NativeAssistantTarget } from '../host/native-assistant-target.ts'
import { createNativeToolPermissionRoutes } from './native-tool-permissions.ts'
import { createNativeMemoryRoutes } from './native-memory.ts'
import { createNativeAppearanceRoutes } from './native-appearance.ts'
import { createNativeUsageMaintenanceRoutes } from './native-usage-maintenance.ts'
import { createNativeWorkRoutes } from './native-work.ts'
import type { PackageConfigurationRegistry } from '../host/package-configuration.ts'
import { readNativeRuntimeProjection, nativeRuntimeFeatureResponse } from '../host/native-runtime-projection.ts'
import { createNativeApplicationStorage } from '../storage/native-application.ts'
import { nativeApplicationRequiresReconciliation } from '../contracts/native-application.ts'
import type { NativeInteractions } from '../host/native-interactions.ts'
import { readImportedChatSessions } from '../host/imported-chat-sessions.ts'
import { createNativeToolsRoutes, type NativeToolsReader } from './native-tools.ts'
import { discoverLocalDsh } from '../host/local-dsh-discovery.ts'
import { discoverLocalDshDeployment } from '../host/local-dsh-deployment.ts'
import { readLocalDshModelCapabilities, resolveLocalDshModelSettings, type LocalDshModelCapabilities } from '../host/local-dsh-model-settings.ts'
import { validateChatAssistantConfiguration,
  chatAssistantConfigurationResponse, type ChatAssistantConfiguration } from '../host/chat-assistant-configuration.ts'
import { createNativeSessionMigrationRoutes } from './native-session-migration.ts'
import { createNativeSessionManagementRoutes } from './native-session-management.ts'
import { nativeSessionBindingRevision, readNativeSessionManagement } from '../host/native-session-management.ts'
import { createNativeChatLifecycle } from './native-chat-lifecycle.ts'

import { revision, ensurePrivateDirectory, withDirectoryWriteLock, acquireDirectoryLock, type Document } from './private-json-storage.ts'
import { validateStoredAccess, validateStoredDeployment, validateStoredExecution,
  updateNativeChatAuthorization, readNativeChatConfiguration, NativeConfigurationRepository,
  type StoredPlans, type StoredPersonas, type StoredAccess, type StoredAdapters, type StoredProviders,
  type StoredExecution, type StoredDeployment } from './native-configuration-repository.ts'
import { NATIVE_CONFIGURATION_REVISION_KEYS, NATIVE_REVISION_PATTERN } from '../contracts/native-revisions.ts'

export { NativeConfigurationRepository, prepareNativeChatAuthorization, readNativeChatConfiguration,
  createNativeAccessPersistence, readNativeAdapterConfiguration, setNativeChatCapabilityApproval } from './native-configuration-repository.ts'

const REVISION_PATTERN = NATIVE_REVISION_PATTERN

export interface NativeRuntimeRouteOptions {
  readonly directory: string
  readonly adapterRuntime?: AdapterRuntimePort
  readonly chatRuntime?: NativeChatRuntime
  readonly deploymentRuntime?: NativeChatDeploymentRuntimeInput
  readonly interactions?: () => NativeInteractions | undefined
  readonly tools?: NativeToolsReader
  readonly assistantTarget?: NativeAssistantTarget
  readonly packageConfigurationRegistry?: PackageConfigurationRegistry
}

const adapterControls = new Map<string, Promise<unknown>>()
const nativeControls = new Map<string, Promise<void>>()
const nativeStopRequests = new Map<string, { readonly maintenance: boolean;
  readonly task: Promise<Awaited<ReturnType<NativeChatRuntime['status']>>> }>()

function requestError(statusCode: number, code: string): never {
  throw new AdminRequestError(statusCode, code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function parseRevision(value: unknown): string {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) requestError(400, 'invalid_chat_request')
  return value
}

function executionRecoveryView(plan: NativeExecutionRecoveryPlan): NativeExecutionRecoveryView {
  return { schema: 1, executionId: plan.executionId, revision: plan.revision, conversationId: plan.binding.conversationId,
    sourceSessionId: plan.binding.sessionId, sourceGeneration: plan.binding.generation, childSessionId: plan.childSessionId,
    state: plan.state, missingReasons: plan.missingReasons, restartRequired: true, automaticReplayAvailable: false }
}

function requireEmptyQuery(query: URLSearchParams): void {
  if ([...query.keys()].length !== 0) requestError(400, 'invalid_query')
}

export function recordNativeAccessApplication(directory: string, previousAccessRevision: string,
  revisions: Readonly<Record<string, string>>): Promise<void> {
  return new NativeConfigurationRepository(directory).recordAccessApplication(previousAccessRevision, revisions)
}

export async function applyNativeAccessRuntime(directory: string, runtime: NativeChatRuntime,
  previousRevision: string, nextRevision: string, signal: AbortSignal): Promise<'live' | 'saved'> {
  await runtime.applyAccessChange(previousRevision, nextRevision, signal)
  const current = await runtime.status()
  if (current.state !== 'running' || !current.activeRevisions) return 'saved'
  await recordNativeAccessApplication(directory, previousRevision, current.activeRevisions)
  return 'live'
}

interface AdapterRuntimeStatus {
  readonly assembled: boolean
  readonly running: boolean
  readonly applyAvailable: boolean
}

async function adapterRuntimeStatus(port: AdapterRuntimePort | undefined): Promise<AdapterRuntimeStatus> {
  if (port === undefined) return { assembled: false, running: false, applyAvailable: false }
  try {
    const status: unknown = await port.status()
    if (!isRecord(status) || !hasExactKeys(status, ['running']) || typeof status.running !== 'boolean') {
      requestError(503, 'adapter_runtime_status_unavailable')
    }
    return { assembled: true, running: status.running, applyAvailable: typeof port.connect === 'function' }
  } catch {
    requestError(503, 'adapter_runtime_status_unavailable')
  }
}

async function adapterConnectionStatus(port: AdapterRuntimePort | undefined, chatRuntime?: NativeChatRuntime): Promise<AdapterConnectionStatus | undefined> {
  if (port?.connectionStatus === undefined) return undefined
  try {
    const status: unknown = await port.connectionStatus()
    if (!isRecord(status) || !hasExactKeys(status, ['state', 'selfId', 'lastError', 'received', 'dropped', 'chatReady'])
      || !['disconnected', 'connecting', 'connected', 'reconnecting', 'error'].includes(String(status.state))
      || status.selfId !== null && (typeof status.selfId !== 'string' || !/^[1-9][0-9]{0,31}$/.test(status.selfId))
      || status.lastError !== null && typeof status.lastError !== 'string'
      || ![status.received, status.dropped].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      || typeof status.chatReady !== 'boolean'
      || status.chatReady && (!isNativeChatRuntime(chatRuntime) || port !== chatRuntime.adapterRuntime
        || status.state !== 'connected' || status.selfId === null)) requestError(503, 'adapter_runtime_status_unavailable')
    return Object.freeze({
      state: status.state as AdapterConnectionStatus['state'], selfId: status.selfId as string | null,
      lastError: status.lastError === null ? null
        : /^(?:onebot_ws_[a-z0-9_]{1,64}|adapter_runtime_(?:aborted|closed|busy))$/.test(String(status.lastError))
          ? String(status.lastError) : 'adapter_connection_error',
      received: status.received as number, dropped: status.dropped as number, chatReady: status.chatReady
    })
  } catch {
    requestError(503, 'adapter_runtime_status_unavailable')
  }
}

function adaptersResponse(
  document: Document<StoredAdapters>,
  status: AdapterRuntimeStatus,
  connection?: AdapterConnectionStatus
): Record<string, unknown> {
  return {
    revision: document.revision, adapters: publicAdapterConfiguration(document.value.adapters), status,
    ...(connection === undefined ? {} : { connection })
  }
}

async function controlAdapterRuntime<Value>(
  directory: string,
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<Value>
): Promise<Value> {
  if (adapterControls.has(directory) || nativeControls.has(directory)) requestError(409, 'adapter_runtime_busy')
  if (signal.aborted) requestError(499, 'request_aborted')
  const controller = new AbortController()
  let rejectDeadline: ((error: AdminRequestError) => void) | undefined
  const deadline = new Promise<never>((_resolvePromise, rejectPromise) => { rejectDeadline = rejectPromise })
  const cancel = (): void => {
    controller.abort()
    rejectDeadline?.(new AdminRequestError(499, 'request_aborted'))
  }
  signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => {
    controller.abort()
    rejectDeadline?.(new AdminRequestError(504, 'adapter_runtime_timeout'))
  }, 5_000)
  const pending = (async () => {
    const release = await acquireDirectoryLock(directory)
    try {
      if (controller.signal.aborted) requestError(499, 'request_aborted')
      return await operation(controller.signal)
    } catch (error: unknown) {
      if (error instanceof AdminRequestError) throw error
      requestError(503, 'adapter_connection_failed')
    } finally {
      await release()
    }
  })()
  adapterControls.set(directory, pending)
  void pending.finally(() => {
    if (adapterControls.get(directory) === pending) adapterControls.delete(directory)
  }).catch(() => undefined)
  try {
    return await Promise.race([pending, deadline])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}

function plansResponse(document: Document<StoredPlans>): Record<string, unknown> {
  return { revision: document.revision, activePlanId: document.value.activePlanId, plans: document.value.plans }
}

function providersResponse(document: Document<StoredProviders>): Record<string, unknown> {
  return { revision: document.revision, providers: publicModelProviders(document.value.providers) }
}

function personasResponse(document: Document<StoredPersonas>): Record<string, unknown> {
  return { revision: document.revision, personas: document.value.personas }
}

function accessResponse(document: Document<StoredAccess>): Record<string, unknown> {
  return {
    revision: document.revision,
    allow: document.value.allow,
    deny: document.value.deny,
    owner: document.value.owner
  }
}

function modelResponse(document: Document<StoredPlans>): Record<string, unknown> {
  const active = document.value.activePlanId === null
    ? undefined
    : document.value.plans.find(plan => plan.id === document.value.activePlanId)
  return {
    revision: document.revision,
    activePlanId: active?.id ?? null,
    provider: active?.provider ?? null,
    model: active?.model ?? null,
    reasoningEffort: active?.reasoningEffort ?? null
  }
}

function parsePlansRequest(body: Record<string, unknown> | null): { revision: string; value: StoredPlans } {
  if (!isRecord(body) || !hasExactKeys(body, ['revision', 'activePlanId', 'plans'])) {
    requestError(400, 'invalid_chat_request')
  }
  try {
    const catalog = validateChatPlanCatalog({ activePlanId: body.activePlanId, plans: body.plans })
    return {
      revision: parseRevision(body.revision),
      value: Object.freeze({ schema: 1, activePlanId: catalog.activePlanId, plans: catalog.plans })
    }
  } catch (error: unknown) {
    if (error instanceof AdminRequestError) throw error
    requestError(400, 'invalid_chat_request')
  }
}

function parsePersonasRequest(body: Record<string, unknown> | null): { revision: string; value: StoredPersonas } {
  if (!isRecord(body) || !hasExactKeys(body, ['revision', 'personas'])) requestError(400, 'invalid_chat_request')
  try {
    return {
      revision: parseRevision(body.revision),
      value: Object.freeze({ schema: 1, personas: validateChatPersonas(body.personas) })
    }
  } catch (error: unknown) {
    if (error instanceof AdminRequestError) throw error
    requestError(400, 'invalid_chat_request')
  }
}

function parseAccessRequest(body: Record<string, unknown> | null): { revision: string; value: StoredAccess } {
  if (!isRecord(body) || !hasExactKeys(body, ['revision', 'allow', 'deny', 'owner'])) {
    requestError(400, 'invalid_chat_request')
  }
  try {
    return {
      revision: parseRevision(body.revision),
      value: validateStoredAccess({ schema: 1, allow: body.allow, deny: body.deny, owner: body.owner })
    }
  } catch (error: unknown) {
    if (error instanceof AdminRequestError) throw error
    requestError(400, 'invalid_chat_request')
  }
}

function parseModelRequest(body: Record<string, unknown> | null): {
  readonly revision: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: ChatPlanReasoningEffort
} {
  if (!isRecord(body) || !hasExactKeys(body, ['revision', 'provider', 'model', 'reasoningEffort'])
    || typeof body.provider !== 'string' || typeof body.model !== 'string'
    || typeof body.reasoningEffort !== 'string'
    || !(CHAT_PLAN_REASONING_EFFORTS as readonly string[]).includes(body.reasoningEffort)) {
    requestError(400, 'invalid_chat_request')
  }
  return {
    revision: parseRevision(body.revision),
    provider: body.provider,
    model: body.model,
    reasoningEffort: body.reasoningEffort as ChatPlanReasoningEffort
  }
}

function validAdapterRuntimePort(value: unknown): value is AdapterRuntimePort {
  return isRecord(value) && typeof value.status === 'function'
    && ['connect', 'disconnect', 'connectionStatus'].every(key => !Object.hasOwn(value, key)
      || typeof value[key] === 'function')
}

export function createNativeRuntimeRoutes(options: NativeRuntimeRouteOptions): readonly AdminRoute[] {
  if (!isRecord(options) || !Object.hasOwn(options, 'directory')
    || !Object.keys(options).every(key => ['directory', 'adapterRuntime', 'chatRuntime', 'deploymentRuntime', 'interactions', 'tools', 'assistantTarget', 'packageConfigurationRegistry'].includes(key))
    || typeof options.directory !== 'string'
    || options.directory.length === 0 || options.directory.includes('\0') || !isAbsolute(options.directory)
    || options.chatRuntime !== undefined && !isNativeChatRuntime(options.chatRuntime)
    || options.interactions !== undefined && typeof options.interactions !== 'function'
    || options.tools !== undefined && typeof options.tools !== 'function'
    || options.adapterRuntime !== undefined && !validAdapterRuntimePort(options.adapterRuntime)) {
    throw new TypeError('Native runtime routes require an absolute directory and an optional runtime status port.')
  }
  const directory = resolve(options.directory)
  const repository = new NativeConfigurationRepository(directory)
  let initialized: Promise<void> | undefined
  const ready = () => initialized ??= ensurePrivateDirectory(directory)
  const adapterRuntime = options.adapterRuntime
  const chatRuntime = options.chatRuntime

  async function assistantResponse(revision: string, configuration: ChatAssistantConfiguration, signal: AbortSignal) {
    if (!options.assistantTarget) return chatAssistantConfigurationResponse(revision, configuration)
    const target = await options.assistantTarget.resolve(AbortSignal.any([signal, AbortSignal.timeout(5_000)]))
    const work = chatRuntime?.workStatus() ?? { available: false, missingReasons: ['assistant_runtime_not_connected'] }
    const missingReasons = [...new Set([...target.missingReasons, ...work.missingReasons])]
    const executionAvailable = target.configuration.enabled && work.available && missingReasons.length === 0
    return { revision, configuration, executionAvailable,
      missingReasons: executionAvailable ? [] : missingReasons.length > 0 ? missingReasons : ['assistant_target_unavailable'] }
  }

  async function modelCapabilities(provider: string, model: string, signal: AbortSignal): Promise<LocalDshModelCapabilities> {
    const unavailable = (reason: string): LocalDshModelCapabilities => ({ provider, model,
      state: 'unavailable', reasoningEfforts: [], missingReasons: [reason] })
    const deadline = AbortSignal.timeout(5_000)
    const controlSignal = AbortSignal.any([signal, deadline])
    try {
      controlSignal.throwIfAborted()
      const providers = await repository.readProviders()
      const selected = providers.value.providers.find(candidate => candidate.id === provider)
      if (!selected?.enabled) return unavailable('model_provider_unavailable')
      if (!selected.models.some(candidate => candidate.id === model)) return unavailable('model_not_configured')
      const adapters = await repository.readAdapterDocument()
      const adapter = adapters.value.adapters.dshAgent
      if (!adapter.enabled || !adapter.localCredentialsPath) return unavailable('local_dsh_connection_required')
      const target = await discoverLocalDshDeployment({ endpoint: adapter.endpoint,
        localCredentialsPath: adapter.localCredentialsPath, signal: controlSignal })
      const capabilities = await readLocalDshModelCapabilities(selected, model, target, controlSignal)
      const currentProviders = await repository.readProviders()
      const currentAdapters = await repository.readAdapterDocument()
      controlSignal.throwIfAborted()
      if (providers.revision !== currentProviders.revision || adapters.revision !== currentAdapters.revision) {
        return unavailable('chat_configuration_changed')
      }
      return capabilities
    } catch {
      if (signal.aborted) requestError(499, 'request_aborted')
      return unavailable(deadline.aborted ? 'model_capabilities_timeout' : 'model_capabilities_read_failed')
    }
  }

  const routes: AdminRoute[] = [
    {
      method: 'GET', pathname: '/api/chat/assistant',
      async handle({ query, signal }) {
        requireEmptyQuery(query)
        const document = await repository.readAssistant()
        return assistantResponse(document.revision, document.value, signal)
      }
    },
    {
      method: 'POST', pathname: '/api/chat/assistant', maxRequestBytes: 4_096,
      async handle({ query, body, signal }) {
        requireEmptyQuery(query)
        if (!isRecord(body) || !hasExactKeys(body, ['revision', 'configuration'])) requestError(400, 'invalid_chat_assistant')
        const expected = parseRevision(body.revision)
        let value: Readonly<ChatAssistantConfiguration>
        try { value = validateChatAssistantConfiguration(body.configuration) }
        catch { requestError(400, 'invalid_chat_assistant') }
        await ready()
        const document = await repository.replaceAssistant(expected, value, signal, modelCapabilities)
        return assistantResponse(document.revision, document.value, signal)
      }
    },
    {
      method: 'GET', pathname: '/api/chat/model-capabilities',
      async handle({ query, signal }): Promise<LocalDshModelCapabilities> {
        const provider = query.get('provider')
        const model = query.get('model')
        if ([...query.keys()].some(key => key !== 'provider' && key !== 'model')
          || query.getAll('provider').length !== 1 || query.getAll('model').length !== 1
          || provider === null || model === null || !reference(provider) || !reference(model)
          || provider.length > 128 || model.length > 128) requestError(400, 'invalid_query')
        return modelCapabilities(provider, model, signal)
      }
    },
    {
      method: 'GET', pathname: '/api/chat/activity',
      handle({ query }) {
        requireEmptyQuery(query)
        if (chatRuntime === undefined) requestError(503, 'runtime_not_connected')
        return chatRuntime.activity()
      }
    },
    {
      method: 'GET', pathname: '/api/chat/plans',
      async handle({ query }) {
        requireEmptyQuery(query)
        return plansResponse(await repository.readPlans())
      }
    },
    {
      method: 'POST', pathname: '/api/chat/plans',
      async handle({ query, body }) {
        requireEmptyQuery(query)
        await ready()
        const request = parsePlansRequest(body)
        return plansResponse(await repository.replacePlans(request.revision, request.value))
      }
    },
    {
      method: 'GET', pathname: '/api/chat/personas',
      async handle({ query }) {
        requireEmptyQuery(query)
        return personasResponse(await repository.readPersonas())
      }
    },
    {
      method: 'POST', pathname: '/api/chat/personas',
      async handle({ query, body }) {
        requireEmptyQuery(query)
        await ready()
        const request = parsePersonasRequest(body)
        return personasResponse(await repository.replacePersonas(request.revision, request.value.personas))
      }
    },
    {
      method: 'GET', pathname: '/api/chat/model',
      async handle({ query }) {
        requireEmptyQuery(query)
        return modelResponse(await repository.readPlans())
      }
    },
    {
      method: 'POST', pathname: '/api/chat/model',
      async handle({ query, body }) {
        requireEmptyQuery(query)
        await ready()
        const request = parseModelRequest(body)
        return modelResponse(await repository.updateActiveModel(request.revision, {
          provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort
        }))
      }
    },
    {
      method: 'GET', pathname: '/api/chat/providers',
      async handle({ query }) {
        requireEmptyQuery(query)
        return providersResponse(await repository.readProviders())
      }
    },
    {
      method: 'POST', pathname: '/api/chat/providers',
      async handle({ query, body }) {
        requireEmptyQuery(query)
        await ready()
        if (!isRecord(body) || !hasExactKeys(body, ['revision', 'providers'])
          || typeof body.revision !== 'string' || !REVISION_PATTERN.test(body.revision)) {
          requestError(400, 'invalid_model_providers')
        }
        return providersResponse(await repository.updateProviders(body.revision, body.providers))
      }
    },
    {
      method: 'GET', pathname: '/api/chat/access',
      async handle({ query }) {
        requireEmptyQuery(query)
        return accessResponse(await repository.readAccess())
      }
    },
    {
      method: 'POST', pathname: '/api/chat/access',
      async handle({ query, body, signal }) {
        requireEmptyQuery(query)
        await ready()
        const request = parseAccessRequest(body)
        const document = await repository.replaceAccess(request.revision, request.value)
        let application: 'live' | 'saved' | 'reload-required' = 'saved'
        if (chatRuntime && document.revision !== request.revision) {
          try { application = await applyNativeAccessRuntime(directory, chatRuntime, request.revision, document.revision, signal) }
          catch { application = 'reload-required' }
        }
        return { ...accessResponse(document), application }
      }
    },
    {
      method: 'GET', pathname: '/api/chat/status',
      async handle({ query }) {
        requireEmptyQuery(query)
        return chatRuntime === undefined ? { runtimeConnected: false } : chatRuntime.status()
      }
    },
    {
      method: 'GET', pathname: '/api/chat/features',
      maxResponseBytes: 4_194_304,
      async handle({ query }) {
        requireEmptyQuery(query)
        return nativeRuntimeFeatureResponse(await readNativeRuntimeProjection(chatRuntime))
      }
    },
    {
      method: 'GET', pathname: '/api/chat/inbox',
      async handle({ query }) {
        requireEmptyQuery(query)
        if (!chatRuntime) requestError(503, 'runtime_not_connected')
        try { return chatRuntime.inboxSummary() }
        catch (error) {
          if (error instanceof AdminRequestError) throw error
          requestError(503, isRecord(error) && error.code === 'STORE_NOT_FOUND' ? 'runtime_not_connected' : 'native_history_unavailable')
        }
      }
    },
    {
      method: 'GET', pathname: '/api/chat/sessions',
      maxResponseBytes: 1_048_576,
      async handle({ query }) {
        if (chatRuntime?.isClosed()) requestError(503, 'native_history_unavailable')
        const host = chatRuntime?.host()
        if (!host && chatRuntime?.activity().state === 'stopped') {
          const parameters = new URLSearchParams(query)
          const limit = integerQuery(parameters, 'limit', 100, 1_000)
          const after = parameters.get('after')
          if (parameters.getAll('after').length > 1 || after !== null && !reference(after)) requestError(400, 'invalid_query')
          parameters.delete('after')
          requireEmptyQuery(parameters)
          const access = await repository.readAccess()
          try {
            const managed = readNativeSessionManagement({ directory, state: 'stopped', owner: access.value.owner,
              limit, ...(after === null ? {} : { after }) })
            if (managed !== null) return managed
          } catch (error) {
            if (error instanceof AdminRequestError) throw error
            requestError(503, 'native_history_unavailable')
          }
        }
        if (host === undefined && chatRuntime?.activity().state === 'stopped') {
          const filenames = ['native-chat.sqlite', 'native-chat.sqlite-wal', 'native-chat.sqlite-shm',
            'native-chat.sqlite-journal', '.native-chat-runtime.lock']
          const present = await Promise.all(filenames.map(async filename => {
            try { await lstat(join(directory, filename)); return true }
            catch (error) {
              if (isRecord(error) && error.code === 'ENOENT') return false
              requestError(503, 'native_history_unavailable')
            }
          }))
          if (present.every(value => !value) && chatRuntime.activity().state === 'stopped') {
            const imported = readImportedChatSessions(directory)
            if (imported !== null) {
              const parameters = new URLSearchParams(query)
              const limit = integerQuery(parameters, 'limit', 100, 1_000)
              if (parameters.getAll('after').length === 1 && parameters.get('after') === '') parameters.delete('after')
              const after = parameters.get('after')
              if (parameters.getAll('after').length > 1 || after !== null && !reference(after)) requestError(400, 'invalid_query')
              parameters.delete('after')
              requireEmptyQuery(parameters)
              const offset = after === null ? 0 : imported.sessions.findIndex(session => session.key === after) + 1
              if (after !== null && offset === 0) requestError(400, 'invalid_query')
              const sessions = imported.sessions.slice(offset, offset + limit)
              return { ...imported, sessions,
                next: offset + sessions.length < imported.sessions.length ? sessions.at(-1)!.key : null }
            }
          }
        }
        const page = host && chatRuntime
          ? await hostRoute(chatRuntime, '/api/host/sessions').handle({ query, body: null, signal: new AbortController().signal })
          : historyRead(chatRuntime, history => {
            const parameters = new URLSearchParams(query)
            const limit = integerQuery(parameters, 'limit', 100, 1_000)
            const after = parameters.get('after')
            if (after !== null && (!reference(after) || parameters.getAll('after').length !== 1)) requestError(400, 'invalid_query')
            parameters.delete('after')
            requireEmptyQuery(parameters)
            const items = history.sessions.list({ limit, ...(after === null ? {} : { after }) })
            return { items, next: items.length === limit ? items.at(-1)!.conversationId : null }
          })
        if (!isRecord(page) || !Array.isArray(page.items)) requestError(500, 'native_session_metadata_invalid')
        const owner = host ? (await readNativeChatConfiguration(directory)).access.owner
          : (await repository.readAccess()).value.owner
        const sessions = page.items.filter(item => isRecord(item) && item.state === 'ready').map(item => {
          const entry = item as Record<string, unknown>
          try {
            return { key: entry.conversationId, sessionId: entry.sessionId, generation: entry.generation,
              bindingRevision: nativeSessionBindingRevision(entry), owner: entry.conversationId === `private:${owner}` }
          } catch { requestError(500, 'native_session_metadata_invalid') }
        })
        return { ...page, sessions, revision: revision(Buffer.from(JSON.stringify({ sessions, items: page.items }))), resetAvailable: false,
          ...(!host ? { native: true, historyReadOnly: true } : {}) }
      }
    },
    {
      method: 'GET', pathname: '/api/chat/usage',
      maxResponseBytes: 4_194_304,
      async handle({ query }) {
        const host = chatRuntime?.host()
        if (host === undefined) return historyRead(chatRuntime, history => ({
          ...createNativeUsageProjection({ usage: history.usage }).summary(usageQuery(query)),
          historyReadOnly: true, policy: null, metrics: null, outbox: null }))
        const usage = chatRuntime?.usage()
        if (usage === undefined) requestError(503, 'runtime_not_connected')
        const policy = host.policy.describe()
        return { ...createNativeUsageProjection({ usage }).summary(usageQuery(query)),
          policy: { paused: policy.paused, grants: policy.grants.slice(0, 1_000), limited: policy.grants.length > 1_000 },
          metrics: host.metrics(), outbox: host.outbox.metrics() }
      }
    },
    {
      method: 'GET', pathname: '/api/chat/usage/series',
      maxResponseBytes: 4_194_304,
      handle({ query }) {
        return usageRead(chatRuntime, usage => {
          if (query.has('hours') || query.has('buckets')) {
            const parameters = new URLSearchParams(query)
            const hours = integerQuery(parameters, 'hours', 24, 2_160)
            const buckets = integerQuery(parameters, 'buckets', 48, 120)
            return createNativeUsageProjection({ usage }).series(hours, buckets, usageQuery(parameters))
          }
          const parameters = new URLSearchParams(query)
          const bucket = parameters.get('bucketMs')
          if (parameters.getAll('bucketMs').length > 1 || bucket !== null && !/^[1-9][0-9]{0,8}$/.test(bucket)) {
            requestError(400, 'invalid_query')
          }
          if (bucket !== null && (Number(bucket) < 60_000 || Number(bucket) > 86_400_000)) requestError(400, 'invalid_query')
          parameters.delete('bucketMs')
          return usage.series(usageQuery(parameters), bucket === null ? undefined : Number(bucket))
        })
      }
    },
    {
      method: 'GET', pathname: '/api/chat/usage/turns',
      maxResponseBytes: 4_194_304,
      handle({ query }) {
        return usageRead(chatRuntime, usage => {
          if (query.has('key')) {
            const parameters = new URLSearchParams(query)
            if (parameters.getAll('key').length !== 1) requestError(400, 'invalid_query')
            const key = parameters.get('key')!
            if (!reference(key)) requestError(400, 'invalid_query')
            parameters.delete('key')
            return createNativeUsageProjection({ usage }).conversation(key, usageQuery(parameters))
          }
          return usage.list(usageQuery(query))
        })
      }
    },
    {
      method: 'GET', pathname: '/api/chat/usage/recent',
      maxResponseBytes: 1_048_576,
      handle({ query }) {
        return usageRead(chatRuntime, usage => createNativeUsageProjection({ usage }).recent(usageQuery(query)))
      }
    },
    {
      method: 'POST', pathname: '/api/chat/usage/reset',
      handle() {
        if (chatRuntime) requestError(405, 'usage_reset_not_enabled')
        requestError(503, 'runtime_not_connected')
      }
    },
    {
      method: 'GET', pathname: '/api/chat/adapters',
      async handle({ query }) {
        requireEmptyQuery(query)
        const document = await repository.readAdapterDocument()
        const status = await adapterRuntimeStatus(adapterRuntime)
        return adaptersResponse(document, status, await adapterConnectionStatus(adapterRuntime, chatRuntime))
      }
    },
    {
      method: 'POST', pathname: '/api/chat/adapters',
      async handle({ query, body, signal }) {
        requireEmptyQuery(query)
        await ready()
        if (!isRecord(body) || !hasExactKeys(body, ['revision', 'adapters'])
          || typeof body.revision !== 'string' || !REVISION_PATTERN.test(body.revision)) {
          requestError(400, 'invalid_adapter_configuration')
        }
        const expectedRevision = body.revision
        const changes = body.adapters
        return nativeControl(directory, async () => {
          const { document, protocolChanged } = await repository.updateAdapters(expectedRevision, changes)
          const connection = await adapterConnectionStatus(adapterRuntime, chatRuntime)
          if (chatRuntime && (protocolChanged || document.value.adapters.onebotWs.enabled && connection?.state !== 'connected')) {
            await withDirectoryWriteLock(directory, async () => {
              const latest = await repository.readAdapterDocument()
              if (latest.revision !== document.revision) return
              await chatRuntime.synchronizeProtocol(latest.value.adapters, signal).catch(() => undefined)
            })
          }
          return adaptersResponse(document, await adapterRuntimeStatus(adapterRuntime), await adapterConnectionStatus(adapterRuntime, chatRuntime))
        })
      }
    },
    {
      method: 'POST', pathname: '/api/chat/adapters/discover-dsh',
      async handle({ query, body, signal }) {
        requireEmptyQuery(query)
        if (!isRecord(body) || !hasExactKeys(body, ['revision'])
          || typeof body.revision !== 'string' || !REVISION_PATTERN.test(body.revision)) requestError(400, 'invalid_adapter_configuration')
        const expected = body.revision as string
        return nativeControl(directory, async () => {
          await ready()
          const current = await repository.readAdapterDocument()
          if (current.revision !== expected) requestError(409, 'chat_revision_conflict')
          let discovered: Awaited<ReturnType<typeof discoverLocalDsh>>
          try { discovered = await discoverLocalDsh({ signal, preferredEndpoint: current.value.adapters.dshAgent.endpoint }) }
          catch { requestError(503, 'local_dsh_not_found') }
          const { document } = await repository.updateAdapters(expected, { dshAgent: {
            enabled: true, endpoint: discovered.endpoint, localCredentialsPath: discovered.credentialsPath, clearAuth: true
          } })
          return adaptersResponse(document, await adapterRuntimeStatus(adapterRuntime), await adapterConnectionStatus(adapterRuntime, chatRuntime))
        })
      }
    },
    {
      method: 'POST', pathname: '/api/chat/adapters/connect',
      async handle({ query, body, signal }) {
        requireEmptyQuery(query)
        if (!isRecord(body) || !hasExactKeys(body, ['revision'])
          || typeof body.revision !== 'string' || !REVISION_PATTERN.test(body.revision)) {
          requestError(400, 'invalid_adapter_configuration')
        }
        if (adapterRuntime?.connect === undefined) requestError(503, 'adapter_runtime_unavailable')
        await ready()
        const document = await controlAdapterRuntime(directory, signal, async controlSignal => {
          const document = await repository.readAdapterDocument()
          if (document.revision !== body.revision) requestError(409, 'chat_revision_conflict')
          await adapterRuntime.connect?.(document.value.adapters, controlSignal)
          return document
        })
        return adaptersResponse(document, await adapterRuntimeStatus(adapterRuntime), await adapterConnectionStatus(adapterRuntime, chatRuntime))
      }
    },
    {
      method: 'POST', pathname: '/api/chat/adapters/disconnect',
      async handle({ query, body, signal }) {
        requireEmptyQuery(query)
        if (!isRecord(body) || !hasExactKeys(body, [])) requestError(400, 'invalid_adapter_configuration')
        if (adapterRuntime?.disconnect === undefined) requestError(503, 'adapter_runtime_unavailable')
        await ready()
        const document = await controlAdapterRuntime(directory, signal, async controlSignal => {
          if (controlSignal.aborted) requestError(499, 'request_aborted')
          await adapterRuntime.disconnect?.()
          return repository.readAdapterDocument()
        })
        return adaptersResponse(document, await adapterRuntimeStatus(adapterRuntime), await adapterConnectionStatus(adapterRuntime, chatRuntime))
      }
    }
  ]
  routes.push(...createPackageConfigurationRoutes({ directory, registry: options.packageConfigurationRegistry }))
  if (options.assistantTarget) routes.push(...createNativeAssistantDeploymentRoutes({ target: options.assistantTarget,
    runExclusive: run => nativeControl(directory, run) }))
  routes.push(...createNativeInteractionRoutes(options.interactions ?? (() => undefined)))
  routes.push(...createNativeToolsRoutes({ state: () => chatRuntime?.activity().state ?? 'stopped',
    ...(options.tools === undefined ? {} : { read: options.tools }) }))
  if (chatRuntime !== undefined) {
    routes.push(...nativeChatControlRoutes(directory, chatRuntime, options.deploymentRuntime === undefined ? undefined : checkedNativeDeploymentRuntime(options.deploymentRuntime)))
    routes.push(...createNativeSessionManagementRoutes({ directory, state: () => chatRuntime.activity().state })
      .map(route => ({ ...route, handle: (request: Parameters<AdminRoute['handle']>[0]) =>
        nativeControl(directory, async () => route.handle(request)) })))
    routes.push(...createNativeSessionMigrationRoutes({ runtime: chatRuntime,
      readRevisions: async () => (await readNativeChatConfiguration(directory)).revisions,
      control: operation => nativeControl(directory, operation) }))
  } else routes.push({ method: 'POST', pathname: '/api/chat/sessions/reset',
    handle() { requestError(503, 'runtime_not_connected') } })
  const documents = new Set(['plans', 'personas', 'model', 'providers', 'access', 'adapters', 'authorization', 'deployment', 'execution', 'usage/pricing']
    .map(name => `/api/chat/${name}`))
  routes.push(...createNativeAppearanceRoutes({ directory }))
  if (chatRuntime) routes.push(...createNativeUsageMaintenanceRoutes({
    list: query => chatRuntime.listUsageMaintenance(query),
    read: id => chatRuntime.readUsageMaintenance(id), export: (scope, source) => chatRuntime.exportUsage(scope, source),
    mutate: (input, signal) => { signal.throwIfAborted(); return chatRuntime.maintainUsage(input) } }))
  return Object.freeze(routes.map(route => Object.freeze(route.method === 'POST' && documents.has(route.pathname)
    ? { ...route, maxRequestBytes: 128 * 1024 } : route)))
}

function integerQuery(query: URLSearchParams, key: string, fallback: number, maximum: number): number {
  const value = query.get(key)
  if (query.getAll(key).length > 1 || value !== null && (!/^[1-9][0-9]{0,5}$/.test(value)
    || Number(value) > maximum)) requestError(400, 'invalid_query')
  query.delete(key)
  return value === null ? fallback : Number(value)
}

function hostRoute(runtime: NativeChatRuntime, pathname: string): AdminRoute {
  const host = runtime.host()
  if (!host) requestError(503, 'runtime_not_connected')
  const route = createHostAdminRoutes(host).find(candidate => candidate.pathname === pathname)
  if (!route) requestError(404, 'not_found')
  return route
}

function historyRead<Result>(runtime: NativeChatRuntime | undefined, read: (history: NativeHistoryReader) => Result): Result {
  if (!runtime) requestError(503, 'runtime_not_connected')
  try { return runtime.readHistory(read) }
  catch (error) {
    if (error instanceof AdminRequestError) throw error
    if (isRecord(error) && ['USAGE_INVALID_QUERY', 'EXECUTION_INVALID_QUERY'].includes(String(error.code))) requestError(400, 'invalid_query')
    requestError(503, isRecord(error) && error.code === 'STORE_NOT_FOUND' ? 'runtime_not_connected' : 'native_history_unavailable')
  }
}

function usageRead<Result>(runtime: NativeChatRuntime | undefined, read: (usage: NativeUsageReader) => Result): Result {
  const usage = runtime?.usage()
  return usage ? read(usage) : historyRead(runtime, history => read(history.usage))
}

function startRevisions(body: Record<string, unknown> | null, withTarget = false): Readonly<Record<string, string>> {
  const keys = NATIVE_CONFIGURATION_REVISION_KEYS
  if (!isRecord(body) || !hasExactKeys(body, withTarget ? ['revisions', 'targetRevision'] : ['revisions'])
    || withTarget && (typeof body.targetRevision !== 'string' || !REVISION_PATTERN.test(body.targetRevision))
    || !isRecord(body.revisions)
    || !hasExactKeys(body.revisions, keys) || !Object.values(body.revisions).every(value =>
      typeof value === 'string' && REVISION_PATTERN.test(value))) requestError(400, 'invalid_runtime_revisions')
  return body.revisions as Readonly<Record<string, string>>
}

async function nativeControl<Value>(directory: string, operation: () => Promise<Value>, stopping = false): Promise<Value> {
  if (nativeControls.has(directory) || adapterControls.has(directory) || !stopping && nativeStopRequests.has(directory)) {
    requestError(409, 'native_chat_busy')
  }
  let release: (() => void) | undefined
  const settled = new Promise<void>(resolvePromise => { release = resolvePromise })
  nativeControls.set(directory, settled)
  try { return await operation() } finally {
    if (nativeControls.get(directory) === settled) nativeControls.delete(directory)
    release?.()
  }
}

export function withNativeChatControl<Value>(directory: string, operation: () => Promise<Value>): Promise<Value> {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute runtime directory is required')
  return nativeControl(resolve(directory), operation)
}

type NativeRuntimeStatus = Awaited<ReturnType<NativeChatRuntime['status']>>
const nativeLifecycles = new WeakMap<NativeChatRuntime, ReturnType<typeof createNativeChatLifecycle<NativeRuntimeStatus>>>()

function nativeChatLifecycle(directory: string, runtime: NativeChatRuntime) {
  const existing = nativeLifecycles.get(runtime)
  if (existing) return existing
  const repository = new NativeConfigurationRepository(directory)
  const lifecycle = createNativeChatLifecycle({ runtime,
    read: () => repository.readRunningIntent(),
    write: (previous, value) => repository.writeRunningIntent(previous.revision, value),
    runExclusive: (operation, purpose) => nativeControl(directory, async () => {
      await ensurePrivateDirectory(directory)
      const release = await acquireDirectoryLock(directory, '.native-chat-lifecycle.lock')
      try { return await operation() } finally { await release() }
    }, purpose === 'stop')
  })
  nativeLifecycles.set(runtime, lifecycle)
  return lifecycle
}

export function stopNativeChatRuntime(directory: string, runtime: NativeChatRuntime, maintenance = false): Promise<Awaited<ReturnType<NativeChatRuntime['status']>>> {
  const key = resolve(directory)
  const existing = nativeStopRequests.get(key)
  if (existing) {
    if (!existing.maintenance || maintenance) return existing.task
    return existing.task.then(() => stopNativeChatRuntime(key, runtime, false), () => stopNativeChatRuntime(key, runtime, false))
  }
  const task = (async () => {
    const pending = nativeControls.get(key)
    if (pending && (await runtime.status()).state === 'starting') {
      const repository = new NativeConfigurationRepository(key)
      if (!maintenance) await repository.clearRunningIntent()
      // Cancel the owned startup once, then wait for its existing control operation to settle.
      const results = await Promise.allSettled([runtime.stop(), pending])
      if (!maintenance) await repository.clearRunningIntent()
      const stopped = results[0]!
      if (stopped.status === 'rejected') throw stopped.reason
      return runtime.status()
    }
    return nativeChatLifecycle(key, runtime).stop(maintenance)
  })().finally(() => { if (nativeStopRequests.get(key)?.task === task) nativeStopRequests.delete(key) })
  nativeStopRequests.set(key, { maintenance, task })
  return task
}

export async function restoreNativeChatRunningIntent(directory: string, runtime: NativeChatRuntime, signal: AbortSignal) {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute runtime directory is required')
  signal.throwIfAborted()
  const journal = await createNativeApplicationStorage(directory).read().catch(() => {
    throw new FrameworkError('NATIVE_APPLICATION_STORAGE_UNAVAILABLE', 'The application history could not be verified before restoring chat.')
  })
  if (journal.value.records.some(record => nativeApplicationRequiresReconciliation(record.snapshot))) {
    throw new FrameworkError('NATIVE_APPLICATION_RECONCILIATION_REQUIRED', 'An unfinished application must be reconciled before restoring chat.')
  }
  signal.throwIfAborted()
  return nativeChatLifecycle(resolve(directory), runtime).restore(signal)
}

export function createNativeRuntimeApplicationPorts(options: {
  readonly directory: string
  readonly runtime: NativeChatRuntime
  readonly deploymentRuntime?: NativeChatDeploymentRuntimeInput
}) {
  const directory = resolve(options.directory)
  const runtime = options.runtime
  const repository = new NativeConfigurationRepository(directory)
  const deploymentRuntime = options.deploymentRuntime === undefined ? undefined : checkedNativeDeploymentRuntime(options.deploymentRuntime)
  async function autoPrepareDeployment(expected: string, signal: AbortSignal) {
      if (!deploymentRuntime) requestError(503, 'trusted_deployment_runtime_unavailable')
      return nativeControl(directory, async () => {
        if (!(await runtime.status()).canApplyDeployment) requestError(409, 'native_chat_busy')
        const configuration = await readNativeChatConfiguration(directory)
        if (configuration.revisions.deployment !== expected) requestError(409, 'chat_revision_conflict')
        const adapter = configuration.adapters.dshAgent
        if (!adapter.enabled || !adapter.localCredentialsPath) requestError(409, 'local_dsh_connection_required')
        if (!configuration.catalog.activePlanId) requestError(400, 'no_active_plan')
        let deployment: NativeChatDeploymentConfiguration
        try {
          const target = await discoverLocalDshDeployment({ endpoint: adapter.endpoint,
            localCredentialsPath: adapter.localCredentialsPath, signal })
          const resolved = await resolveLocalDshModelSettings(configuration, target, signal)
          deployment = { ...configuration.deployment, target, modelSettings: resolved.modelSettings }
        } catch (error) {
          if (signal.aborted) requestError(499, 'request_aborted')
          if (isRecord(error) && error.code === 'LOCAL_DSH_MODEL_SETTINGS_MISSING') requestError(422, 'local_dsh_model_settings_missing')
          if (isRecord(error) && error.code === 'LOCAL_DSH_MODEL_INPUT_UNAVAILABLE') requestError(422, 'local_dsh_model_input_unavailable')
          if (isRecord(error) && error.code === 'LOCAL_DSH_MODEL_REASONING_UNAVAILABLE') requestError(422, 'local_dsh_model_reasoning_unavailable')
          if (isRecord(error) && error.code === 'LOCAL_DSH_REASONING_MAPPING_UNSUPPORTED') requestError(422, 'local_dsh_reasoning_mapping_unsupported')
          requestError(503, 'local_dsh_deployment_not_found')
        }
        if (signal.aborted) requestError(499, 'request_aborted')
        const document = await repository.replaceResolvedDeployment(configuration.revisions, deployment, signal)
        const current = await readNativeChatConfiguration(directory)
        if (current.revisions.deployment !== document.revision) requestError(409, 'chat_revision_conflict')
        const prepared = await deploymentResult(() => deploymentRuntime.prepare(current), 'local_dsh_preparation_failed')
        if (!isRecord(prepared)) requestError(503, 'local_dsh_preparation_failed')
        return { revision: document.revision, deployment: document.value.deployment,
          revisions: current.revisions, prepared: { ...prepared, revisions: current.revisions } }
      })
  }
  return Object.freeze({
    readConfiguration: () => repository.read(),
    start: (revisions: Readonly<Record<string, string>>, signal: AbortSignal) => nativeChatLifecycle(directory, runtime).start(revisions, signal),
    stop: (maintenance = false) => stopNativeChatRuntime(directory, runtime, maintenance),
    autoPrepareDeployment
  })
}

function nativeChatControlRoutes(directory: string, runtime: NativeChatRuntime,
  deploymentRuntime: NativeChatDeploymentRuntime | undefined): AdminRoute[] {
  const repository = new NativeConfigurationRepository(directory)
  const application = createNativeRuntimeApplicationPorts({ directory, runtime, deploymentRuntime })
  const lifecycle = nativeChatLifecycle(directory, runtime)
  const routes: AdminRoute[] = [
    { method: 'GET', pathname: '/api/chat/runtime', async handle({ query }) {
      requireEmptyQuery(query)
      return { ...await runtime.status(), lifecycle: await lifecycle.describe() }
    } },
    { method: 'GET', pathname: '/api/chat/runtime/baseline', maxResponseBytes: 1_048_576, handle({ query }) {
      requireEmptyQuery(query)
      return runtime.configurationBaseline()
    } },
    { method: 'POST', pathname: '/api/chat/runtime/start', async handle({ query, body, signal }) {
      requireEmptyQuery(query)
      const revisions = startRevisions(body)
      try { return await lifecycle.start(revisions, signal) } catch (error) {
        if (isRecord(error) && error.code === 'NATIVE_CHAT_LIFECYCLE_WRITE_FAILED') requestError(503, 'native_chat_lifecycle_write_failed')
        if (isRecord(error) && error.code === 'NATIVE_CHAT_LIFECYCLE_START_UNVERIFIED') requestError(503, 'native_chat_start_unverified')
        if (error instanceof AdminRequestError) throw error
        if (isRecord(error) && error.code === 'NATIVE_CHAT_REVISION_CONFLICT') requestError(409, 'chat_revision_conflict')
        if (isRecord(error) && error.code === 'NATIVE_CHAT_BUSY') requestError(409, 'native_chat_busy')
        requestError(503, 'native_chat_start_failed')
      }
    } },
    { method: 'POST', pathname: '/api/chat/runtime/stop', async handle({ query, body }) {
      requireEmptyQuery(query)
      if (!isRecord(body) || !(hasExactKeys(body, []) || hasExactKeys(body, ['maintenance']) && body.maintenance === true)) requestError(400, 'invalid_chat_request')
      try { return await stopNativeChatRuntime(directory, runtime, body.maintenance === true) }
      catch (error) {
        if (isRecord(error) && error.code === 'NATIVE_CHAT_LIFECYCLE_WRITE_FAILED') requestError(503, 'native_chat_lifecycle_write_failed')
        if (error instanceof AdminRequestError) throw error
        if (isRecord(error) && typeof error.code === 'string' && error.code.includes('UNKNOWN')) requestError(503, 'native_chat_stop_unknown')
        requestError(503, 'native_chat_stop_failed')
      }
    } },
    { method: 'GET', pathname: '/api/chat/authorization', async handle({ query }) {
      requireEmptyQuery(query)
      await ensurePrivateDirectory(directory)
      const document = await repository.readAuthorization()
      return { revision: document.revision, ...nativeAuthorizationProjection(document.value.authorization, document.source) }
    } },
    { method: 'POST', pathname: '/api/chat/authorization', async handle({ query, body }) {
      requireEmptyQuery(query)
      if (!isRecord(body) || !hasExactKeys(body, ['revision', 'version', 'grants',
        ...(Object.hasOwn(body, 'mode') ? ['mode'] : []), ...(Object.hasOwn(body, 'forwardAllow') ? ['forwardAllow'] : [])])) requestError(400, 'invalid_chat_authorization')
      const expected = parseRevision(body.revision)
      let value: NativeChatAuthorization
      try { value = validateNativeChatAuthorization({ version: body.version,
        ...(Object.hasOwn(body, 'mode') ? { mode: body.mode } : {}),
        ...(Object.hasOwn(body, 'forwardAllow') ? { forwardAllow: body.forwardAllow } : {}), grants: body.grants }) }
      catch { requestError(400, 'invalid_chat_authorization') }
      return nativeControl(directory, async () => {
        const document = await updateNativeChatAuthorization(directory, expected, value)
        return { revision: document.revision, ...nativeAuthorizationProjection(document.value.authorization, 'stored'),
          migrationBackup: document.migrationBackup }
      })
    } },
    { method: 'GET', pathname: '/api/chat/execution', async handle({ query }) {
      requireEmptyQuery(query)
      await ensurePrivateDirectory(directory)
      const document = await repository.readExecution()
      return { revision: document.revision, policy: document.value.policy }
    } },
    { method: 'POST', pathname: '/api/chat/execution', async handle({ query, body }) {
      requireEmptyQuery(query)
      if (!isRecord(body) || !hasExactKeys(body, ['revision', 'policy'])) requestError(400, 'invalid_execution_policy')
      const expected = parseRevision(body.revision)
      let value: StoredExecution
      try { value = validateStoredExecution({ schema: 1, policy: body.policy }) }
      catch { requestError(400, 'invalid_execution_policy') }
      await ensurePrivateDirectory(directory)
      const document = await repository.replaceExecution(expected, value.policy)
      return { revision: document.revision, policy: document.value.policy }
    } },
    { method: 'GET', pathname: '/api/chat/executions/recovery', handle({ query }) {
      const id = query.get('id')
      if (id === null || !REVISION_PATTERN.test(id) || [...query.keys()].length !== 1) requestError(400, 'invalid_query')
      const plan = runtime.readExecutionRecovery(id)
      return { native: true, item: plan ? executionRecoveryView(plan) : null, automaticReplayAvailable: false }
    } },
    ...(['preview', 'commit'] as const).map(action => ({ method: 'POST' as const, pathname: `/api/chat/executions/recovery/${action}`,
      async handle({ query, body, signal }: Parameters<AdminRoute['handle']>[0]) {
        requireEmptyQuery(query)
        if (!isRecord(body) || !hasExactKeys(body, action === 'commit' ? ['executionId', 'revision', 'confirm'] : ['executionId'])
          || typeof body.executionId !== 'string' || !REVISION_PATTERN.test(body.executionId)
          || action === 'commit' && (body.confirm !== true || typeof body.revision !== 'string' || !REVISION_PATTERN.test(body.revision))) requestError(400, 'invalid_execution_recovery')
        const executionId = body.executionId
        const revision = action === 'commit' ? body.revision as string : undefined
        return nativeControl(directory, async () => {
          try { return executionRecoveryView(await runtime.recoverExecution(executionId, signal, revision)) }
          catch (error) {
            if (signal.aborted) requestError(499, 'request_aborted')
            const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
            if (code === 'EXECUTION_NOT_FOUND') requestError(404, 'execution_not_found')
            if (/^(?:EXECUTION_RECOVERY|NATIVE_EXECUTION_RECOVERY)_[A-Z_]+$/.test(code)) requestError(409, code.toLowerCase())
            requestError(503, 'execution_recovery_unavailable')
          }
        })
      }
    })),
    { method: 'GET', pathname: '/api/chat/events', handle({ query }) {
      const parsed = new URLSearchParams(query)
      const limit = integerQuery(parsed, 'limit', 100, 256)
      const epoch = parsed.get('epoch')
      const sequence = parsed.get('after')
      const after = epoch === null && sequence === null ? undefined : { epoch, sequence: Number(sequence) }
      if (after && (sequence === null || !/^(?:0|[1-9][0-9]{0,15})$/.test(sequence) || !isNativeEventCursor(after))
        || parsed.getAll('epoch').length > 1 || parsed.getAll('after').length > 1) requestError(400, 'invalid_query')
      parsed.delete('epoch'); parsed.delete('after')
      const filter: Record<string, unknown> = {}
      for (const key of ['conversationId', 'accountId', 'protocolId', 'sessionId', 'executionId', 'requestId', 'workId', 'toolCallId']) {
        if (parsed.has(key)) { if (parsed.getAll(key).length !== 1) requestError(400, 'invalid_query'); filter[key] = parsed.get(key); parsed.delete(key) }
      }
      for (const [key, target] of [['kind', 'kinds'], ['source', 'sources'], ['status', 'statuses']] as const) {
        if (parsed.has(key)) { filter[target] = parsed.getAll(key); parsed.delete(key) }
      }
      requireEmptyQuery(parsed)
      if (!isNativeEventFilter(filter) || after && !isNativeEventCursor(after)) requestError(400, 'invalid_query')
      return runtime.readEvents({ limit, filter, ...(after ? { after } : {}) })
    } },
    { method: 'GET', pathname: '/api/chat/media', handle({ query }) {
      const parsed = new URLSearchParams(query)
      const limit = integerQuery(parsed, 'limit', 100, 100)
      const conversationId = parsed.get('conversationId')
      if (conversationId === null || !/^(?:group|private):[1-9][0-9]{0,31}$/.test(conversationId)
        || [...parsed.keys()].length !== 1) requestError(400, 'invalid_query')
      return runtime.mediaDiagnostics(conversationId, limit)
    } },
    { method: 'GET', pathname: '/api/chat/diagnostics', async handle({ query }) {
      const conversationId = query.get('conversationId')
      if (conversationId === null || !/^(?:group|private):[1-9][0-9]{0,31}$/.test(conversationId)
        || [...query.keys()].length !== 1) requestError(400, 'invalid_query')
      return runtime.diagnostics(conversationId)
    } },
    { method: 'POST', pathname: '/api/chat/executions/reconcile', async handle({ query, body, signal }) {
      requireEmptyQuery(query)
      if (!isRecord(body) || !hasExactKeys(body, ['executionId', 'confirm']) || body.confirm !== true
        || typeof body.executionId !== 'string' || !REVISION_PATTERN.test(body.executionId)) requestError(400, 'invalid_execution_reconciliation')
      const executionId = body.executionId
      return nativeControl(directory, async () => {
        try { return await runtime.reconcileExecution(executionId, signal) }
        catch (error) {
          if (signal.aborted) requestError(499, 'request_aborted')
          if (isRecord(error) && error.code === 'EXECUTION_NOT_FOUND') requestError(404, 'execution_not_found')
          if (isRecord(error) && error.code === 'NATIVE_EXECUTION_RECONCILIATION_UNAVAILABLE') requestError(409, 'execution_reconciliation_requires_running_runtime')
          requestError(503, 'execution_reconciliation_unavailable')
        }
      })
    } },
    { method: 'GET', pathname: '/api/chat/executions', maxResponseBytes: 4_194_304, handle({ query }) {
      const parsed = new URLSearchParams(query)
      const id = parsed.get('id')
      if (id !== null) {
        if (!REVISION_PATTERN.test(id) || [...parsed.keys()].length !== 1) requestError(400, 'invalid_query')
        const controller = runtime.executions()
        const row = controller ? controller.get(id) : historyRead(runtime, history => history.executions.get(id))
        const item = row ? (({ policy: _policy, ...publicRow }) => publicRow)(row) : null
        return { native: true, item, manualCancelAvailable: false, ...(!controller ? { historyReadOnly: true } : {}) }
      }
      const limit = integerQuery(parsed, 'limit', 100, 1_000)
      const after = parsed.get('after')
      if (after !== null && (!REVISION_PATTERN.test(after) || parsed.getAll('after').length !== 1)) requestError(400, 'invalid_query')
      parsed.delete('after')
      requireEmptyQuery(parsed)
      const executions = runtime.executions()
      const options = { limit, ...(after === null ? {} : { after }) }
      const rows = executions ? executions.list(options) : historyRead(runtime, history => history.executions.list(options))
      return { native: true, items: rows.map(({ policy: _policy, ...row }) => row),
        next: rows.length === limit ? rows.at(-1)!.cursor : null, manualCancelAvailable: false,
        ...(!executions ? { historyReadOnly: true } : {}) }
    } },
    { method: 'GET', pathname: '/api/chat/deployment', async handle({ query }) {
      requireEmptyQuery(query)
      await ensurePrivateDirectory(directory)
      const document = await repository.readDeployment()
      return { revision: document.revision, deployment: document.value.deployment }
    } },
    { method: 'POST', pathname: '/api/chat/deployment', async handle({ query, body }) {
      requireEmptyQuery(query)
      if (!isRecord(body) || !hasExactKeys(body, ['revision', 'deployment'])) requestError(400, 'invalid_chat_deployment')
      const expected = parseRevision(body.revision)
      let value: StoredDeployment
      try { value = validateStoredDeployment({ schema: 1, deployment: body.deployment }) }
      catch {
        if (isRecord(body.deployment) && Object.hasOwn(body.deployment, 'capabilityApproval')) requestError(400, 'invalid_capability_approval')
        requestError(400, 'invalid_chat_deployment')
      }
      await ensurePrivateDirectory(directory)
      const document = await repository.replaceDeployment(expected, value.deployment)
      return { revision: document.revision, deployment: document.value.deployment }
    } },
    { method: 'POST', pathname: '/api/chat/deployment/auto-prepare', async handle({ query, body, signal }) {
      requireEmptyQuery(query)
      if (!isRecord(body) || !hasExactKeys(body, ['revision'])) requestError(400, 'invalid_chat_deployment')
      const expected = parseRevision(body.revision)
      return application.autoPrepareDeployment(expected, signal)
    } },
    { method: 'GET', pathname: '/api/chat/usage/pricing', handle({ query }) {
      requireEmptyQuery(query)
      const usage = runtime.usage()
      return usage ? usage.pricing() : historyRead(runtime, history => history.usage.pricing())
    } },
    { method: 'POST', pathname: '/api/chat/usage/pricing', handle({ query, body }) {
      requireEmptyQuery(query)
      if (!isRecord(body) || !hasExactKeys(body, ['revision', 'prices'])
        || body.revision !== null && (typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision) || body.revision < 1)) {
        requestError(400, 'invalid_usage_pricing')
      }
      const usage = runtime.usage()
      if (!usage) requestError(503, 'runtime_not_connected')
      try { return usage.setPricing(body.prices, body.revision as number | null) }
      catch (error) {
        if (isRecord(error) && error.code === 'STORE_CONFLICT') requestError(409, 'usage_pricing_revision_conflict')
        if (isRecord(error) && error.code === 'USAGE_INVALID_PRICING') requestError(400, 'invalid_usage_pricing')
        requestError(500, 'usage_pricing_operation_unknown')
      }
    } }
  ]
  for (const operation of ['prepare', 'reconcile', 'apply'] as const) routes.push({
    method: 'POST', pathname: `/api/chat/deployment/${operation}`, async handle({ query, body, signal }) {
      requireEmptyQuery(query)
      const revisions = startRevisions(body, operation === 'apply')
      if (!deploymentRuntime) requestError(503, 'trusted_deployment_runtime_unavailable')
      return nativeControl(directory, async () => {
        const configuration = await readNativeChatConfiguration(directory)
        if (Object.keys(revisions).some(key => revisions[key] !== configuration.revisions[key])) requestError(409, 'chat_revision_conflict')
        if (operation === 'apply' && !(await runtime.status()).canApplyDeployment) requestError(409, 'native_chat_busy')
        if (signal.aborted) requestError(499, 'request_aborted')
        return deploymentResult(async () => operation === 'prepare' ? deploymentRuntime.prepare(configuration)
          : operation === 'reconcile' ? publicDeploymentResolution(await deploymentRuntime.reconcile(configuration))
            : deploymentRuntime.apply(configuration, signal, body!.targetRevision as string))
      })
    }
  })
  routes.push(...createNativeReminderRoutes({ read: options => runtime.readReminders(options),
    history: options => runtime.readReminderHistory(options), service: () => runtime.reminderService() }))
  routes.push(...createNativeToolPermissionRoutes({ directory,
    runtime: revision => runtime.toolPermissionStatus(revision), onChanged: revision => runtime.applyToolPermissions(revision) }))
  routes.push(...createNativeWorkRoutes({ read: id => runtime.readWork(id), list: query => runtime.listWork(query) }))
  routes.push(...createNativeMemoryRoutes({ read: options => runtime.readMemory(options),
    entry: id => runtime.readMemoryEntry(id), service: () => runtime.memoryService() }))
  routes.push(...createNativeApplicationRoutes({ directory, runtime, ports: {
    status: () => runtime.status(),
    stop: async signal => { signal.throwIfAborted(); await application.stop(true); return runtime.status() },
    prepare: (revision, signal) => application.autoPrepareDeployment(revision, signal),
    apply: (revisions, targetRevision, signal) => nativeControl(directory, async () => {
      if (!deploymentRuntime) requestError(503, 'trusted_deployment_runtime_unavailable')
      const configuration = await repository.read()
      if (NATIVE_CONFIGURATION_REVISION_KEYS.some(key => revisions[key] !== configuration.revisions[key])) requestError(409, 'chat_revision_conflict')
      if (!(await runtime.status()).canApplyDeployment) requestError(409, 'native_chat_busy')
      signal.throwIfAborted()
      return deploymentResult(() => deploymentRuntime.apply(configuration, signal, targetRevision))
    }),
    reconcileDeployment: (revisions, signal) => nativeControl(directory, async () => {
      if (!deploymentRuntime) requestError(503, 'trusted_deployment_runtime_unavailable')
      const configuration = await repository.read()
      if (NATIVE_CONFIGURATION_REVISION_KEYS.some(key => revisions[key] !== configuration.revisions[key])) requestError(409, 'chat_revision_conflict')
      signal.throwIfAborted()
      const result = await deploymentResult(() => deploymentRuntime.reconcile(configuration))
      const current = await repository.read()
      if (NATIVE_CONFIGURATION_REVISION_KEYS.some(key => revisions[key] !== current.revisions[key])) requestError(409, 'chat_revision_conflict')
      signal.throwIfAborted()
      return result
    }),
    previewMigration: (revisions, signal) => nativeControl(directory, () => runtime.previewSessionMigration(revisions, signal)),
    migrate: (request, signal) => nativeControl(directory, () => runtime.migrateSessions(request, signal)),
    start: async (revisions, signal) => { await application.start(revisions, signal); return runtime.status() }
  } }))
  for (const name of ['metrics', 'storage', 'sessions', 'tasks', 'outbox', 'replies']) routes.push({
    method: 'GET', pathname: `/api/host/${name}`,
    ...(name === 'sessions' ? { maxResponseBytes: 1_048_576 } : {}),
    handle(context) { return hostRoute(runtime, `/api/host/${name}`).handle(context) }
  })
  return routes
}

async function deploymentResult<Value>(operation: () => Promise<Value>, code = 'deployment_runtime_response_invalid'): Promise<Value> {
  try { return await operation() }
  catch (error) {
    if (isRecord(error) && typeof error.code === 'string' && /^NATIVE_DEPLOYMENT_.*_INVALID$/.test(error.code)) {
      requestError(503, code)
    }
    throw error
  }
}

function publicDeploymentResolution(result: Awaited<ReturnType<NativeChatDeploymentRuntime['reconcile']>>) {
  return { verified: result.missingReasons.length === 0 && result.presetBindings.length > 0,
    missingReasons: result.missingReasons,
    verificationScope: result.verificationScope ?? null,
    credentialValueIdentityVerified: false,
    unverified: result.unverified ?? ['credential_loaded_value_identity'],
    presets: result.presetBindings.map(binding => ({ agentPreset: binding.agentPreset })) }
}

function usageQuery(query: URLSearchParams): NativeUsageQuery {
  const numeric = ['limit', 'since', 'until']
  const textual = ['after', 'conversationId', 'provider', 'model']
  if ([...query.keys()].some(key => ![...numeric, ...textual].includes(key))
    || [...query.keys()].some(key => query.getAll(key).length !== 1)) requestError(400, 'invalid_query')
  const result: Record<string, string | number> = {}
  for (const key of numeric) {
    const value = query.get(key)
    if (value === null) continue
    if (!/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))
      || key === 'limit' && (Number(value) < 1 || Number(value) > 1_000)) requestError(400, 'invalid_query')
    result[key] = Number(value)
  }
  for (const key of textual) {
    const value = query.get(key)
    if (value === null) continue
    if (value.length === 0 || value.length > 1_024 || /[\u0000-\u001f\u007f]/.test(value)) requestError(400, 'invalid_query')
    result[key] = value
  }
  if (typeof result.since === 'number' && typeof result.until === 'number' && result.since >= result.until) requestError(400, 'invalid_query')
  return result
}
