import { NATIVE_APPEARANCE_FILE, EMPTY_NATIVE_APPEARANCE, parseNativeAppearanceConfiguration } from '../contracts/native-appearance.ts'
import { validateNativeChatAccess } from '../contracts/native-access.ts'
import { opendir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isRecord } from '../core/values.ts'
import { validateChatPlanCatalog, validateChatPersonas, type ChatPlan, type ChatPersona, type ChatPlanCatalog, type ChatPlanReasoningEffort } from '../host/chat-plans.ts'
import { validateModelProviders, updateModelProviders, type NativeModelProvider } from '../host/model-providers.ts'
import { createDefaultAdapterConfiguration, validateAdapterConfiguration, updateAdapterConfiguration, type NativeAdapterConfiguration } from '../host/adapter-configuration.ts'
import { DEFAULT_NATIVE_CHAT_DEPLOYMENT, validateNativeChatAuthorization, type NativeChatAccess,
  type NativeChatAuthorization, type NativeChatConfiguration, type NativeChatDeploymentConfiguration } from '../host/native-chat-configuration.ts'
import { validateDshModelSettings } from '../adapters/dsh-deployment.ts'
import { DEFAULT_NATIVE_EXECUTION_POLICY, validateNativeExecutionPolicy, type NativeExecutionPolicy } from '../host/native-execution.ts'
import { validateChatCapabilityCompositionApproval, type ChatCapabilityCompositionApproval } from '../host/chat-capabilities.ts'
import { DEFAULT_CHAT_ASSISTANT_CONFIGURATION, validateChatAssistantConfiguration, chatAssistantTargetAvailable, type ChatAssistantConfiguration } from '../host/chat-assistant-configuration.ts'
import { nativeAuthorizationFallback, nativeAuthorizationMode, nativeAuthorizationSignature,
  readNativeAuthorizationVersion } from '../host/native-access.ts'
import { isNativeConfigurationRevisions } from '../contracts/native-revisions.ts'
import { AdminRequestError } from './errors.ts'
import { DEFAULT_NATIVE_CHAT_RUNNING_INTENT, NATIVE_CHAT_LIFECYCLE_FILE, validateNativeChatRunningIntent,
  type NativeChatRunningIntent } from './native-chat-lifecycle.ts'
import { ensurePrivateDirectory, readDocument, withDirectoryWriteLock, writeDocumentLocked,
  updateDocument, type Document } from './private-json-storage.ts'


function requestError(statusCode: number, code: string): never {
  throw new AdminRequestError(statusCode, code)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

export interface StoredPlans {
  readonly schema: 1
  readonly activePlanId: string | null
  readonly plans: readonly ChatPlan[]
}

export interface StoredPersonas {
  readonly schema: 1
  readonly personas: readonly ChatPersona[]
}

export interface StoredAccess {
  readonly schema: 1
  readonly allow: readonly string[]
  readonly deny: readonly string[]
  readonly owner: string | null
}

export interface StoredAdapters {
  readonly schema: 1
  readonly adapters: NativeAdapterConfiguration
}

export interface StoredProviders {
  readonly schema: 1
  readonly providers: readonly NativeModelProvider[]
}

export interface StoredAuthorization { readonly schema: 1; readonly authorization: NativeChatAuthorization }
export interface StoredDeployment { readonly schema: 1; readonly deployment: NativeChatDeploymentConfiguration }
export interface StoredExecution { readonly schema: 1; readonly policy: NativeExecutionPolicy }
export const DEFAULT_DEPLOYMENT: StoredDeployment = { schema: 1, deployment: DEFAULT_NATIVE_CHAT_DEPLOYMENT }
export const DEFAULT_EXECUTION: StoredExecution = { schema: 1, policy: DEFAULT_NATIVE_EXECUTION_POLICY }

export const DEFAULT_PLANS: StoredPlans = Object.freeze({ schema: 1, activePlanId: null, plans: Object.freeze([]) })
export const DEFAULT_PERSONAS: StoredPersonas = Object.freeze({ schema: 1, personas: Object.freeze([]) })
export const DEFAULT_ACCESS: StoredAccess = Object.freeze({
  schema: 1,
  allow: Object.freeze([]),
  deny: Object.freeze([]),
  owner: null
})
export const DEFAULT_ADAPTERS: StoredAdapters = Object.freeze({ schema: 1, adapters: createDefaultAdapterConfiguration() })
export const DEFAULT_PROVIDERS: StoredProviders = Object.freeze({ schema: 1, providers: Object.freeze([]) })
export function validateStoredPlans(value: unknown): StoredPlans {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'activePlanId', 'plans']) || value.schema !== 1) {
    throw new TypeError('Invalid plans document')
  }
  const catalog = validateChatPlanCatalog({ activePlanId: value.activePlanId, plans: value.plans })
  return Object.freeze({ schema: 1, activePlanId: catalog.activePlanId, plans: catalog.plans })
}

export function validateStoredPersonas(value: unknown): StoredPersonas {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'personas']) || value.schema !== 1) {
    throw new TypeError('Invalid personas document')
  }
  return Object.freeze({ schema: 1, personas: validateChatPersonas(value.personas) })
}

export function validateStoredAccess(value: unknown): StoredAccess {
  const access = validateNativeChatAccess(value, { maximumDigits: 20, allowOverlap: false, storedSchema: true })
  return Object.freeze({ schema: 1, ...access })
}

export function validateStoredAdapters(value: unknown): StoredAdapters {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'adapters']) || value.schema !== 1) {
    throw new TypeError('Invalid adapters document')
  }
  return Object.freeze({ schema: 1, adapters: validateAdapterConfiguration(value.adapters) })
}

export function validateStoredProviders(value: unknown): StoredProviders {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'providers']) || value.schema !== 1) {
    throw new TypeError('Invalid providers document')
  }
  return Object.freeze({ schema: 1, providers: validateModelProviders(value.providers) })
}

export function validateStoredAuthorization(value: unknown): StoredAuthorization {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'authorization']) || value.schema !== 1) {
    throw new TypeError('Invalid authorization document')
  }
  return { schema: 1, authorization: validateNativeChatAuthorization(value.authorization) }
}

export function validateStoredDeployment(value: unknown): StoredDeployment {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'deployment']) || value.schema !== 1
    || !isRecord(value.deployment) || !['target', 'modelSettings', 'namespace'].every(key => Object.hasOwn(value.deployment as object, key))
    || !Object.keys(value.deployment).every(key => ['target', 'modelSettings', 'namespace', 'capabilityApproval'].includes(key))) {
    throw new TypeError('Invalid deployment document')
  }
  const input = value.deployment
  if (typeof input.namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.namespace)
    || input.target !== null && (!isRecord(input.target)
      || !['profilePath', 'credentialsPath', 'schemaVersion'].every(key => Object.hasOwn(input.target as object, key))
      || !Object.keys(input.target).every(key => ['profilePath', 'credentialsPath', 'layerPaths', 'schemaVersion'].includes(key))
      || typeof input.target.profilePath !== 'string' || input.target.profilePath.length > 4_096
      || !isAbsolute(input.target.profilePath) || /[\u0000-\u001f\u007f]/.test(input.target.profilePath)
      || typeof input.target.credentialsPath !== 'string' || input.target.credentialsPath.length > 4_096
      || !isAbsolute(input.target.credentialsPath) || /[\u0000-\u001f\u007f]/.test(input.target.credentialsPath)
      || input.target.layerPaths !== undefined && (!Array.isArray(input.target.layerPaths) || input.target.layerPaths.length > 16
        || !input.target.layerPaths.every(path => typeof path === 'string' && path.length <= 4_096
          && isAbsolute(path) && !/[\u0000-\u001f\u007f]/.test(path)))
      || input.target.schemaVersion !== '0.2.1-rc.2')) throw new TypeError('Invalid deployment target')
  return { schema: 1, deployment: {
    namespace: input.namespace,
    target: input.target === null ? null : {
      profilePath: (input.target as Record<string, unknown>).profilePath as string,
      credentialsPath: (input.target as Record<string, unknown>).credentialsPath as string,
      ...((input.target as Record<string, unknown>).layerPaths === undefined ? {}
        : { layerPaths: (input.target as Record<string, unknown>).layerPaths as readonly string[] }),
      schemaVersion: '0.2.1-rc.2'
    },
    modelSettings: input.modelSettings === null ? null : validateDshModelSettings(input.modelSettings),
    ...(Object.hasOwn(input, 'capabilityApproval') ? { capabilityApproval: input.capabilityApproval === null
      ? null : validateChatCapabilityCompositionApproval(input.capabilityApproval) } : {})
  } }
}

export function validateStoredExecution(value: unknown): StoredExecution {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'policy']) || value.schema !== 1) throw new TypeError('Invalid execution document')
  return { schema: 1, policy: validateNativeExecutionPolicy(value.policy) }
}

export async function readNativeChatConfigurationUnlocked(directory: string): Promise<NativeChatConfiguration> {
  const plans = await readDocument(join(directory, 'chat-plans.json'), DEFAULT_PLANS, validateStoredPlans)
  const personas = await readDocument(join(directory, 'chat-personas.json'), DEFAULT_PERSONAS, validateStoredPersonas)
  const access = await readDocument(join(directory, 'chat-access.json'), DEFAULT_ACCESS, validateStoredAccess)
  const adapters = await readDocument(join(directory, 'chat-adapters.json'), DEFAULT_ADAPTERS, validateStoredAdapters)
  const providers = await readDocument(join(directory, 'chat-providers.json'), DEFAULT_PROVIDERS, validateStoredProviders)
  const authorization = await readAuthorizationDocument(directory)
  const deployment = await readDocument(join(directory, 'chat-deployment.json'), DEFAULT_DEPLOYMENT, validateStoredDeployment)
  const execution = await readDocument(join(directory, 'chat-execution.json'), DEFAULT_EXECUTION, validateStoredExecution)
  return {
    revisions: { plans: plans.revision, personas: personas.revision, access: access.revision,
      adapters: adapters.revision, providers: providers.revision, authorization: authorization.revision,
      deployment: deployment.revision, execution: execution.revision },
    catalog: { activePlanId: plans.value.activePlanId, plans: plans.value.plans },
    personas: personas.value.personas, access: access.value, adapters: adapters.value.adapters,
    providers: providers.value.providers, authorization: authorization.value.authorization,
    authorizationSource: authorization.source,
    deployment: deployment.value.deployment, execution: execution.value.policy
  }
}

export async function readAuthorizationDocument(directory: string) {
  const fallback = await nativeAuthorizationFallback(directory)
  const document = await readDocument(join(directory, 'chat-authorization.json'),
    { schema: 1 as const, authorization: fallback.authorization }, validateStoredAuthorization)
  return { ...document, source: document.exists ? 'stored' as const : fallback.source }
}

export async function prepareNativeChatAuthorization(directory: string): Promise<void> {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute runtime directory is required')
  await ensurePrivateDirectory(directory)
  await withDirectoryWriteLock(directory, async () => {
    const current = await readAuthorizationDocument(directory)
    if (current.exists || current.source !== 'new-default') return
    await writeDocumentLocked(directory, join(directory, 'chat-authorization.json'), current.revision,
      current.value, validateStoredAuthorization, current.value)
  })
}

export async function backupNativeChatAuthorization(directory: string, document: Document<StoredAuthorization>): Promise<string | null> {
  if (!document.exists) return null
  const backupDirectory = join(directory, 'chat-authorization-backups')
  await ensurePrivateDirectory(backupDirectory)
  const filename = join(backupDirectory, `${document.revision}.json`)
  const prior = await readDocument(filename, document.value, validateStoredAuthorization)
  if (prior.exists) {
    if (prior.revision !== document.revision || !prior.content.equals(document.content)) requestError(500, 'chat_authorization_backup_invalid')
    return document.revision
  }
  let entries = 0
  for await (const _entry of await opendir(backupDirectory)) {
    entries++
    if (entries >= 64) requestError(503, 'chat_authorization_backup_limit')
  }
  await writeDocumentLocked(backupDirectory, filename, prior.revision, document.value,
    validateStoredAuthorization, document.value, document.content)
  return document.revision
}

export async function readNativeChatConfiguration(directory: string): Promise<NativeChatConfiguration> {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute runtime directory is required')
  await ensurePrivateDirectory(directory)
  return withDirectoryWriteLock(directory, () => readNativeChatConfigurationUnlocked(directory))
}

export function createNativeAccessPersistence(directory: string) {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute runtime directory is required')
  const filename = join(directory, 'chat-access.json')
  const project = (document: Document<StoredAccess>) => ({ revision: document.revision,
    value: { allow: document.value.allow, deny: document.value.deny, owner: document.value.owner } })
  return Object.freeze({
    async read() {
      await ensurePrivateDirectory(directory)
      return project(await readDocument(filename, DEFAULT_ACCESS, validateStoredAccess))
    },
    async compareAndSet(expectedRevision: string, next: NativeChatAccess, signal: AbortSignal) {
      signal.throwIfAborted()
      await ensurePrivateDirectory(directory)
      const document = await updateDocument(directory, filename, expectedRevision, DEFAULT_ACCESS,
        validateStoredAccess, () => validateStoredAccess({ schema: 1, ...next }), () => signal.throwIfAborted())
      return project(document)
    }
  })
}

export async function readNativeAdapterConfiguration(directory: string): Promise<Readonly<NativeAdapterConfiguration>> {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute runtime directory is required')
  const document = await readDocument(join(directory, 'chat-adapters.json'), DEFAULT_ADAPTERS, validateStoredAdapters)
  return document.value.adapters
}

export async function setNativeChatCapabilityApproval(directory: string, revisions: Readonly<Record<string, string>>,
  approval: ChatCapabilityCompositionApproval | null, signal: AbortSignal): Promise<NativeChatConfiguration> {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute runtime directory is required')
  if (!isNativeConfigurationRevisions(revisions)) requestError(400, 'invalid_runtime_revisions')
  const expected = { ...revisions }
  let captured: ChatCapabilityCompositionApproval | null
  try { captured = approval === null ? null : validateChatCapabilityCompositionApproval(approval) }
  catch { requestError(400, 'invalid_capability_approval') }
  signal.throwIfAborted()
  await ensurePrivateDirectory(directory)
  return withDirectoryWriteLock(directory, async () => {
    const current = await readNativeChatConfigurationUnlocked(directory)
    signal.throwIfAborted()
    if (Object.keys(expected).some(key => expected[key] !== current.revisions[key])) requestError(409, 'chat_revision_conflict')
    await writeDocumentLocked(directory, join(directory, 'chat-deployment.json'), current.revisions.deployment,
      DEFAULT_DEPLOYMENT, validateStoredDeployment, { schema: 1, deployment: { ...current.deployment, capabilityApproval: captured } })
    return readNativeChatConfigurationUnlocked(directory)
  })
}

export async function updateNativeChatAuthorization(directory: string, expectedRevision: string,
  authorization: NativeChatAuthorization) {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute runtime directory is required')
  const value = validateNativeChatAuthorization(authorization)
  await ensurePrivateDirectory(directory)
  return withDirectoryWriteLock(directory, async () => {
    const current = await readAuthorizationDocument(directory)
    if (current.revision !== expectedRevision) requestError(409, 'chat_revision_conflict')
    const transition = current.source === 'missing-with-history' || current.exists
      && nativeAuthorizationMode(current.value.authorization) !== nativeAuthorizationMode(value)
    if (transition && (value.mode === undefined || value.version === current.value.authorization.version)) {
      requestError(409, 'chat_authorization_new_mode_version_required')
    }
    if (transition || value.mode !== undefined || current.value.authorization.mode !== undefined) {
      let used: string | null
      try { used = readNativeAuthorizationVersion(directory, value.version) }
      catch { requestError(503, 'chat_authorization_history_unavailable') }
      if (used !== null && (transition || value.version !== current.value.authorization.version
        || used !== nativeAuthorizationSignature(value))) requestError(409, 'chat_authorization_version_conflict')
    }
    const backupRevision = transition ? await backupNativeChatAuthorization(directory, current) : null
    const document = await writeDocumentLocked(directory, join(directory, 'chat-authorization.json'), current.revision,
      current.value, validateStoredAuthorization, { schema: 1, authorization: value })
    return { ...document, migrationBackup: backupRevision === null ? null : { revision: backupRevision } }
  })
}

function assertPersonaReferences(plans: readonly ChatPlan[], personas: readonly ChatPersona[]): void {
  const ids = new Set(personas.map(persona => persona.id))
  if (plans.some(plan => !ids.has(plan.personaId))) requestError(409, 'persona_in_use_or_missing')
}

function assertPlanModelReferences(
  next: StoredPlans,
  current: StoredPlans,
  providers: readonly NativeModelProvider[]
): void {
  for (const plan of next.plans) {
    const provider = providers.find(entry => entry.id === plan.provider)
    if (provider?.enabled && provider.models.some(model => model.id === plan.model)) continue
    const previous = current.plans.find(entry => entry.id === plan.id)
    const unchanged = previous?.provider === plan.provider && previous.model === plan.model
    const newlyActive = next.activePlanId === plan.id && current.activePlanId !== plan.id
    if (!unchanged || newlyActive) requestError(409, 'provider_model_missing_or_disabled')
  }
}

function assertProviderReferences(
  next: readonly NativeModelProvider[],
  current: readonly NativeModelProvider[],
  plans: readonly ChatPlan[],
  assistant: ChatAssistantConfiguration
): void {
  for (const plan of plans) {
    const previous = current.find(entry => entry.id === plan.provider)
    if (previous === undefined) continue
    const provider = next.find(entry => entry.id === plan.provider)
    if (provider === undefined || previous.enabled && !provider.enabled
      || previous.models.some(model => model.id === plan.model)
        && !provider.models.some(model => model.id === plan.model)) {
      requestError(409, 'provider_model_in_use')
    }
  }
  // A retained assistant target remains a reference even while assistant mode is off.
  // Existing unavailable targets may be preserved; a catalog edit cannot remove a valid target.
  const previous = current.find(entry => entry.id === assistant.provider)
  if (previous) {
    const provider = next.find(entry => entry.id === assistant.provider)
    if (!provider || previous.enabled && !provider.enabled
      || previous.models.some(model => model.id === assistant.model)
        && !provider.models.some(model => model.id === assistant.model)) requestError(409, 'assistant_target_in_use')
  }
}

/** File-backed native configuration operations, usable without creating HTTP routes. */
export class NativeConfigurationRepository {
  readonly directory: string

  constructor(directory: string) {
    if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute runtime directory is required')
    this.directory = directory
  }

  read(): Promise<NativeChatConfiguration> {
    return readNativeChatConfiguration(this.directory)
  }

  async readPlans(): Promise<Document<StoredPlans>> {
    await ensurePrivateDirectory(this.directory)
    return readDocument(join(this.directory, 'chat-plans.json'), DEFAULT_PLANS, validateStoredPlans)
  }

  async readPersonas(): Promise<Document<StoredPersonas>> {
    await ensurePrivateDirectory(this.directory)
    return readDocument(join(this.directory, 'chat-personas.json'), DEFAULT_PERSONAS, validateStoredPersonas)
  }

  async readProviders(): Promise<Document<StoredProviders>> {
    await ensurePrivateDirectory(this.directory)
    return readDocument(join(this.directory, 'chat-providers.json'), DEFAULT_PROVIDERS, validateStoredProviders)
  }

  async replacePlans(expectedRevision: string, catalog: ChatPlanCatalog): Promise<Document<StoredPlans>> {
    const value = validateStoredPlans({ schema: 1, ...catalog })
    await ensurePrivateDirectory(this.directory)
    return updateDocument(this.directory, join(this.directory, 'chat-plans.json'), expectedRevision,
      DEFAULT_PLANS, validateStoredPlans, () => value, async (next, current) => {
        const personas = await this.readPersonas()
        assertPersonaReferences(next.plans, personas.value.personas)
        const providers = await this.readProviders()
        assertPlanModelReferences(next, current, providers.value.providers)
      })
  }

  async replacePersonas(expectedRevision: string, personas: readonly ChatPersona[]): Promise<Document<StoredPersonas>> {
    const value = validateStoredPersonas({ schema: 1, personas })
    await ensurePrivateDirectory(this.directory)
    return updateDocument(this.directory, join(this.directory, 'chat-personas.json'), expectedRevision,
      DEFAULT_PERSONAS, validateStoredPersonas, () => value, async next => {
        const plans = await this.readPlans()
        assertPersonaReferences(plans.value.plans, next.personas)
        const appearance = await readDocument(join(this.directory, NATIVE_APPEARANCE_FILE), EMPTY_NATIVE_APPEARANCE, input => {
          const configuration = parseNativeAppearanceConfiguration(input)
          if (!configuration) requestError(500, 'appearance_configuration_invalid')
          return configuration
        })
        const ids = new Set(next.personas.map(persona => persona.id))
        if (appearance.value.bindings.some(binding => binding.assetId !== null && !ids.has(binding.personaId)))
          requestError(409, 'persona_in_use_by_appearance')
      })
  }

  async updateActiveModel(expectedRevision: string, selection: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort: ChatPlanReasoningEffort
  }): Promise<Document<StoredPlans>> {
    await ensurePrivateDirectory(this.directory)
    return updateDocument(this.directory, join(this.directory, 'chat-plans.json'), expectedRevision,
      DEFAULT_PLANS, validateStoredPlans, current => {
        if (current.activePlanId === null) requestError(409, 'no_active_plan')
        const plans = current.plans.map(plan => plan.id === current.activePlanId ? { ...plan, ...selection } : plan)
        try { return validateStoredPlans({ schema: 1, activePlanId: current.activePlanId, plans }) }
        catch { requestError(400, 'invalid_chat_request') }
      }, async (next, current) => {
        const providers = await this.readProviders()
        assertPlanModelReferences(next, current, providers.value.providers)
      })
  }

  async updateProviders(expectedRevision: string, patch: unknown): Promise<Document<StoredProviders>> {
    await ensurePrivateDirectory(this.directory)
    return updateDocument(this.directory, join(this.directory, 'chat-providers.json'), expectedRevision,
      DEFAULT_PROVIDERS, validateStoredProviders, current => {
        try { return Object.freeze({ schema: 1, providers: updateModelProviders(current.providers, patch) }) }
        catch { requestError(400, 'invalid_model_providers') }
      }, async (next, current) => {
        const plans = await this.readPlans()
        const assistant = await readDocument(join(this.directory, 'chat-assistant.json'),
          DEFAULT_CHAT_ASSISTANT_CONFIGURATION, validateChatAssistantConfiguration)
        assertProviderReferences(next.providers, current.providers, plans.value.plans, assistant.value)
      })
  }

  async readAccess(): Promise<Document<StoredAccess>> {
    await ensurePrivateDirectory(this.directory)
    return readDocument(join(this.directory, 'chat-access.json'), DEFAULT_ACCESS, validateStoredAccess)
  }

  async readAdapterDocument(): Promise<Document<StoredAdapters>> {
    await ensurePrivateDirectory(this.directory)
    return readDocument(join(this.directory, 'chat-adapters.json'), DEFAULT_ADAPTERS, validateStoredAdapters)
  }

  async updateAdapters(expectedRevision: string, patch: unknown) {
    await ensurePrivateDirectory(this.directory)
    let protocolChanged = false
    const document = await updateDocument(this.directory, join(this.directory, 'chat-adapters.json'), expectedRevision,
      DEFAULT_ADAPTERS, validateStoredAdapters, current => {
        try {
          const adapters = updateAdapterConfiguration(current.adapters, patch)
          protocolChanged = !isDeepStrictEqual(adapters.onebotWs, current.adapters.onebotWs)
          return Object.freeze({ schema: 1, adapters })
        } catch { requestError(400, 'invalid_adapter_configuration') }
      })
    return { document, protocolChanged }
  }

  async readAssistant() {
    await ensurePrivateDirectory(this.directory)
    return readDocument(join(this.directory, 'chat-assistant.json'), DEFAULT_CHAT_ASSISTANT_CONFIGURATION, validateChatAssistantConfiguration)
  }

  async replaceAssistant(expectedRevision: string, configuration: ChatAssistantConfiguration, signal: AbortSignal,
    readCapabilities: (provider: string, model: string, signal: AbortSignal) => Promise<{
      readonly state: 'available' | 'unavailable'; readonly reasoningEfforts: readonly ChatPlanReasoningEffort[]
    }>) {
    const value = validateChatAssistantConfiguration(configuration)
    await ensurePrivateDirectory(this.directory)
    return updateDocument(this.directory, join(this.directory, 'chat-assistant.json'), expectedRevision,
      DEFAULT_CHAT_ASSISTANT_CONFIGURATION, validateChatAssistantConfiguration, () => value, async (next, current) => {
        const providers = await this.readProviders()
        if (!chatAssistantTargetAvailable(next, providers.value.providers)) requestError(409, 'provider_model_missing_or_disabled')
        if (next.mode === 'chat-assistant' && next.provider !== null && next.model !== null && next.reasoningEffort !== null) {
          const capabilities = await readCapabilities(next.provider, next.model, signal)
          const preserving = current.mode === next.mode && current.provider === next.provider
            && current.model === next.model && current.reasoningEffort === next.reasoningEffort
          if (capabilities.state === 'available' && !capabilities.reasoningEfforts.includes(next.reasoningEffort)) {
            requestError(409, 'assistant_reasoning_unsupported')
          }
          if (capabilities.state !== 'available' && !preserving) requestError(409, 'assistant_reasoning_unavailable')
        }
        signal.throwIfAborted()
      })
  }

  async readExecution() {
    await ensurePrivateDirectory(this.directory)
    return readDocument(join(this.directory, 'chat-execution.json'), DEFAULT_EXECUTION, validateStoredExecution)
  }

  async replaceExecution(expectedRevision: string, policy: NativeExecutionPolicy) {
    const value = validateStoredExecution({ schema: 1, policy })
    await ensurePrivateDirectory(this.directory)
    return updateDocument(this.directory, join(this.directory, 'chat-execution.json'), expectedRevision,
      DEFAULT_EXECUTION, validateStoredExecution, () => value)
  }

  async readDeployment() {
    await ensurePrivateDirectory(this.directory)
    return readDocument(join(this.directory, 'chat-deployment.json'), DEFAULT_DEPLOYMENT, validateStoredDeployment)
  }

  async replaceDeployment(expectedRevision: string, configuration: NativeChatDeploymentConfiguration) {
    const value = validateStoredDeployment({ schema: 1, deployment: configuration })
    await ensurePrivateDirectory(this.directory)
    return updateDocument(this.directory, join(this.directory, 'chat-deployment.json'), expectedRevision,
      DEFAULT_DEPLOYMENT, validateStoredDeployment, (current): StoredDeployment => {
        if (Object.hasOwn(value.deployment, 'capabilityApproval')
          && !isDeepStrictEqual(value.deployment.capabilityApproval ?? null, current.deployment.capabilityApproval ?? null)) {
          requestError(400, 'invalid_capability_approval')
        }
        const { capabilityApproval: _provided, ...deployment } = value.deployment
        return { schema: 1, deployment: { ...deployment, ...(Object.hasOwn(current.deployment, 'capabilityApproval')
          ? { capabilityApproval: current.deployment.capabilityApproval } : {}) } }
      })
  }

  async replaceAccess(expectedRevision: string, access: NativeChatAccess): Promise<Document<StoredAccess>> {
    const value = validateStoredAccess({ schema: 1, ...access })
    await ensurePrivateDirectory(this.directory)
    return updateDocument(this.directory, join(this.directory, 'chat-access.json'), expectedRevision,
      DEFAULT_ACCESS, validateStoredAccess, () => value)
  }

  async replaceResolvedDeployment(expectedRevisions: Readonly<Record<string, string>>, value: NativeChatDeploymentConfiguration,
    signal: AbortSignal) {
    if (!isNativeConfigurationRevisions(expectedRevisions)) requestError(400, 'invalid_runtime_revisions')
    const deployment = validateStoredDeployment({ schema: 1, deployment: value })
    await ensurePrivateDirectory(this.directory)
    return withDirectoryWriteLock(this.directory, async () => {
      signal.throwIfAborted()
      const current = await readNativeChatConfigurationUnlocked(this.directory)
      if (Object.keys(expectedRevisions).some(key => current.revisions[key] !== expectedRevisions[key])) {
        requestError(409, 'chat_revision_conflict')
      }
      return writeDocumentLocked(this.directory, join(this.directory, 'chat-deployment.json'), expectedRevisions.deployment,
        DEFAULT_DEPLOYMENT, validateStoredDeployment, deployment)
    })
  }

  async readAuthorization() {
    await ensurePrivateDirectory(this.directory)
    return readAuthorizationDocument(this.directory)
  }

  clearRunningIntent(): Promise<void> {
    return withDirectoryWriteLock(this.directory, async () => {
      const previous = await this.readRunningIntent()
      await writeDocumentLocked(this.directory, join(this.directory, NATIVE_CHAT_LIFECYCLE_FILE), previous.revision,
        DEFAULT_NATIVE_CHAT_RUNNING_INTENT, validateNativeChatRunningIntent,
        { schema: 1, desiredRunning: false, revisions: previous.value.revisions, updatedAt: Date.now() })
    })
  }

  readRunningIntent() {
    return readDocument(join(this.directory, NATIVE_CHAT_LIFECYCLE_FILE), DEFAULT_NATIVE_CHAT_RUNNING_INTENT, validateNativeChatRunningIntent)
  }

  writeRunningIntent(previousRevision: string, value: NativeChatRunningIntent) {
    return withDirectoryWriteLock(this.directory, () => writeDocumentLocked(this.directory,
      join(this.directory, NATIVE_CHAT_LIFECYCLE_FILE), previousRevision,
      DEFAULT_NATIVE_CHAT_RUNNING_INTENT, validateNativeChatRunningIntent, value))
  }

  recordAccessApplication(previousAccessRevision: string, revisions: Readonly<Record<string, string>>): Promise<void> {
    return withDirectoryWriteLock(this.directory, async () => {
      const document = await this.readRunningIntent()
      if (!document.exists || !document.value.desiredRunning || !document.value.revisions) return
      const previous = document.value.revisions
      if (previous.access !== previousAccessRevision
        || Object.keys(previous).some(key => key !== 'access' && previous[key] !== revisions[key])) {
        requestError(409, 'chat_revision_conflict')
      }
      await writeDocumentLocked(this.directory, join(this.directory, NATIVE_CHAT_LIFECYCLE_FILE), document.revision,
        DEFAULT_NATIVE_CHAT_RUNNING_INTENT, validateNativeChatRunningIntent,
        { ...document.value, revisions: { ...revisions }, updatedAt: Date.now() })
    })
  }

  prepareAuthorization(): Promise<void> {
    return prepareNativeChatAuthorization(this.directory)
  }

  updateAuthorization(expectedRevision: string, authorization: NativeChatAuthorization) {
    return updateNativeChatAuthorization(this.directory, expectedRevision, authorization)
  }

  accessPersistence(): ReturnType<typeof createNativeAccessPersistence> {
    return createNativeAccessPersistence(this.directory)
  }

  readAdapters(): Promise<Readonly<NativeAdapterConfiguration>> {
    return readNativeAdapterConfiguration(this.directory)
  }

  setCapabilityApproval(revisions: Readonly<Record<string, string>>, approval: ChatCapabilityCompositionApproval | null,
    signal: AbortSignal): Promise<NativeChatConfiguration> {
    return setNativeChatCapabilityApproval(this.directory, revisions, approval, signal)
  }
}
