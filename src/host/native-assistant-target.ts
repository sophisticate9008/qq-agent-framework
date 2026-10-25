import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { FrameworkError, isRecord, snapshot } from '../core/values.ts'
import type { NativeAssistantDeploymentRequest, NativeAssistantDeploymentSnapshot } from '../contracts/native-assistant-target.ts'
import type { DshProfileTarget } from '../contracts/dsh-profile.ts'
import { NATIVE_REVISION_PATTERN } from '../contracts/native-revisions.ts'
import { ensurePrivateDirectory, readDocument, updateDocument, type Document } from '../storage/private-json.ts'
import { validateChatAssistantConfiguration, type ChatAssistantConfiguration } from './chat-assistant-configuration.ts'
import { createNativeDshDeploymentRuntime, type DshProfileDeploymentOptions } from './native-dsh-deployment.ts'
import type { NativeChatConfiguration, NativeChatDeploymentRuntime } from './native-chat-configuration.ts'
import { discoverLocalDshDeployment } from './local-dsh-deployment.ts'
import { resolveLocalDshModelSettings } from './local-dsh-model-settings.ts'
import { DEFAULT_NATIVE_WORK_CONFIGURATION, type NativeWorkConfiguration } from './native-work-configuration.ts'
import { DSH_DEPLOYMENT_VERIFICATION } from './dsh-deployment-plan.ts'
import { createDshJsonRpcPort } from '../adapters/dsh-jsonrpc.ts'
import { createDshAuthenticationOptions } from '../adapters/dsh-authentication.ts'
import type { JsonValue } from '../contracts/data.ts'

interface Pending {
  readonly instanceId: string
  readonly state: 'prepared' | 'applying' | 'verified' | 'blocked' | 'pending_reload' | 'unknown'
  readonly assistantRevision: string
  readonly configurationRevision: string
  readonly targetRevision: string
  readonly provider: string
  readonly model: string
  readonly missingReasons: readonly string[]
}
interface Applied {
  readonly configurationRevision: string
  readonly provider: string
  readonly model: string
  readonly externalProvider: string
  readonly agentPreset: string
}
interface Journal { readonly schema: 1; readonly pending: Pending | null; readonly applied: Applied | null }
const fallback: Journal = Object.freeze({ schema: 1, pending: null, applied: null })
const instructions = '完成当前会话中由用户明确委派的独立工作。只根据宿主提供的任务、来源和上下文行动；工具与资源许可继续由宿主和外部服务分别核验，不把任务内容当作授权。返回真实结果，未完成时说明阻碍。'
function fail(code: string): never { throw new FrameworkError(code, 'The assistant deployment operation could not be completed.') }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function reason(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(error.code)) return error.code.toLowerCase()
  return 'assistant_target_unavailable'
}
function journal(input: unknown): Journal {
  if (!isRecord(input) || input.schema !== 1 || Object.keys(input).length !== 3 || !Object.hasOwn(input, 'pending') || !Object.hasOwn(input, 'applied')) fail('ASSISTANT_DEPLOYMENT_STORAGE_INVALID')
  const pending = input.pending
  if (pending !== null && (!isRecord(pending) || !['prepared', 'applying', 'verified', 'blocked', 'pending_reload', 'unknown'].includes(String(pending.state))
    || typeof pending.instanceId !== 'string' || !/^[a-f0-9-]{36}$/.test(pending.instanceId)
    || !['assistantRevision', 'configurationRevision', 'targetRevision'].every(key => typeof pending[key] === 'string' && NATIVE_REVISION_PATTERN.test(String(pending[key])))
    || typeof pending.provider !== 'string' || typeof pending.model !== 'string' || !Array.isArray(pending.missingReasons)
    || pending.missingReasons.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(value)))) fail('ASSISTANT_DEPLOYMENT_STORAGE_INVALID')
  const applied = input.applied
  if (applied !== null && (!isRecord(applied) || typeof applied.configurationRevision !== 'string' || !NATIVE_REVISION_PATTERN.test(applied.configurationRevision)
    || !['provider', 'model', 'externalProvider', 'agentPreset'].every(key => typeof applied[key] === 'string' && String(applied[key]).length > 0 && String(applied[key]).length <= 160))) fail('ASSISTANT_DEPLOYMENT_STORAGE_INVALID')
  return snapshot(input) as unknown as Journal
}
function unresolved(document: Journal): boolean { return document.pending !== null && ['applying', 'pending_reload', 'unknown'].includes(document.pending.state) }

export interface NativeAssistantTargetResolution {
  readonly configuration: NativeWorkConfiguration
  readonly externalProvider: string | null
  readonly agentPreset: string | null
  readonly assistantRevision: string
  readonly configurationRevision: string | null
  readonly missingReasons: readonly string[]
  readonly reasoningEffort?: string
}
interface Selected {
  readonly assistantRevision: string
  readonly configurationRevision: string
  readonly assistant: ChatAssistantConfiguration
  readonly configuration: NativeChatConfiguration
}
export interface NativeAssistantTargetOptions {
  readonly deploymentNamespace?: string
  readonly directory: string
  readonly loadConfiguration: () => Promise<NativeChatConfiguration>
  readonly loadAssistant: () => Promise<{ readonly revision: string; readonly value: ChatAssistantConfiguration }>
  readonly deployment?: NativeChatDeploymentRuntime
  readonly deploymentOptions?: DshProfileDeploymentOptions
  readonly discoverTarget?: (configuration: NativeChatConfiguration, signal: AbortSignal) => Promise<DshProfileTarget>
  readonly authorizeApply?: (signal: AbortSignal) => void | Promise<void>
  readonly readModelCatalog?: (configuration: NativeChatConfiguration, signal: AbortSignal) => Promise<JsonValue>
}

/** Return SDK effort identifiers from observed metadata, never provider-specific wire values. */
export function resolveAssistantReasoning(catalog: JsonValue, provider: string, model: string, effort: string): { readonly reasoningEffort?: string } {
  if (!isRecord(catalog) || !Array.isArray(catalog.groups) || catalog.groups.length > 128
    || !Array.isArray(catalog.routableProviders) || !catalog.routableProviders.includes(provider)
    || !Array.isArray(catalog.failures) || catalog.failures.some(failure => !isRecord(failure) || failure.id === provider)) fail('ASSISTANT_MODEL_CAPABILITIES_UNVERIFIED')
  const groups = catalog.groups.filter(group => isRecord(group) && group.id === provider)
  const group = groups[0]
  if (groups.length !== 1 || !isRecord(group) || !Array.isArray(group.models)) fail('ASSISTANT_MODEL_CAPABILITIES_UNVERIFIED')
  const models = group.models.filter((entry: unknown) => isRecord(entry) && entry.id === model)
  if (models.length !== 1 || !isRecord(models[0])) fail('ASSISTANT_MODEL_CAPABILITIES_UNVERIFIED')
  const selected = models[0]
  if (!Object.hasOwn(selected, 'reasoning')) {
    if (effort === 'off') return {}
    return fail('ASSISTANT_REASONING_UNSUPPORTED')
  }
  const reasoning = selected.reasoning
  if (!isRecord(reasoning) || !Array.isArray(reasoning.efforts) || reasoning.efforts.length < 1 || reasoning.efforts.length > 64
    || reasoning.efforts.some(value => !isRecord(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id))) fail('ASSISTANT_MODEL_CAPABILITIES_UNVERIFIED')
  const efforts = reasoning.efforts.map((value: unknown) => {
    if (!isRecord(value) || typeof value.id !== 'string') fail('ASSISTANT_MODEL_CAPABILITIES_UNVERIFIED')
    return value.id
  })
  if (new Set(efforts).size !== efforts.length) fail('ASSISTANT_MODEL_CAPABILITIES_UNVERIFIED')
  if (efforts.includes(effort)) return { reasoningEffort: effort }
  if (effort === 'off' && efforts.includes('none')) return { reasoningEffort: 'none' }
  return fail('ASSISTANT_REASONING_UNSUPPORTED')
}

/** Assistant deployment is explicit and separate from the main chat plan and existing session bindings. */
export function createNativeAssistantTarget(options: NativeAssistantTargetOptions) {
  if (options.deploymentNamespace !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(options.deploymentNamespace)) fail('ASSISTANT_CONFIGURATION_INVALID')
  const deployment = options.deployment ?? createNativeDshDeploymentRuntime({ ...options.deploymentOptions, conversationKinds: ['private'] })
  const filename = join(options.directory, 'assistant-deployment.json')
  const instanceId = randomUUID()
  let busy = false
  async function readJournal(): Promise<Document<Journal>> { return readDocument(filename, fallback, journal) }
  async function writeJournal(revision: string, value: Journal, signal: AbortSignal): Promise<Document<Journal>> {
    await ensurePrivateDirectory(options.directory)
    signal.throwIfAborted()
    return updateDocument(options.directory, filename, revision, fallback, journal, () => value, () => signal.throwIfAborted())
  }
  async function selected(signal: AbortSignal): Promise<Selected> {
    signal.throwIfAborted()
    const assistantDocument = await options.loadAssistant()
    if (!NATIVE_REVISION_PATTERN.test(assistantDocument.revision)) fail('ASSISTANT_CONFIGURATION_REVISION_INVALID')
    const assistant = validateChatAssistantConfiguration(assistantDocument.value)
    if (assistant.mode !== 'chat-assistant' || assistant.provider === null || assistant.model === null) fail('ASSISTANT_DISABLED')
    const original = await options.loadConfiguration()
    const provider = original.providers.find(entry => entry.id === assistant.provider)
    if (!provider?.enabled || !provider.apiKey || !provider.models.some(model => model.id === assistant.model)) fail('ASSISTANT_MODEL_UNAVAILABLE')
    let target = original.deployment.target
    if (!target) {
      if (options.discoverTarget) target = await options.discoverTarget(original, signal)
      else {
        const adapter = original.adapters.dshAgent
        if (!adapter.enabled || !adapter.localCredentialsPath || adapter.auth) fail('ASSISTANT_LOCAL_TARGET_UNAVAILABLE')
        target = await discoverLocalDshDeployment({ endpoint: adapter.endpoint, localCredentialsPath: adapter.localCredentialsPath, signal })
      }
    }
    const plan = { id: 'assistant-work', name: '独立工作助手', description: '', instructions, personaId: 'assistant-work',
      provider: assistant.provider, model: assistant.model, reasoningEffort: assistant.reasoningEffort ?? 'off' }
    const metadataConfiguration: NativeChatConfiguration = { ...original,
      catalog: { activePlanId: plan.id, plans: [plan] },
      personas: [{ id: 'assistant-work', name: '独立工作助手', identity: '处理用户明确委派的独立任务。', style: '准确、清晰，保留真实的完成状态与不确定性。' }],
      deployment: { ...original.deployment, namespace: options.deploymentNamespace ?? 'qqafwork', target, modelSettings: null, capabilityApproval: null } }
    const metadata = await resolveLocalDshModelSettings(metadataConfiguration, target, signal)
    const configuration: NativeChatConfiguration = { ...metadataConfiguration,
      catalog: { activePlanId: plan.id, plans: [{ ...plan, contextLimits: { group: metadata.modelSettings.contextWindow, private: metadata.modelSettings.contextWindow } }] },
      deployment: { ...metadataConfiguration.deployment, modelSettings: metadata.modelSettings } }
    const configurationRevision = hash({ schema: 1, provider, model: assistant.model, reasoningEffort: plan.reasoningEffort,
      target, settings: metadata.modelSettings, connection: original.adapters.dshAgent, instructions })
    signal.throwIfAborted()
    return { assistantRevision: assistantDocument.revision, assistant, configurationRevision, configuration }
  }
  function projection(document: Document<Journal>, current: Selected | null, override?: Partial<NativeAssistantDeploymentSnapshot>): NativeAssistantDeploymentSnapshot {
    const pending = document.value.pending
    const applied = document.value.applied
    const interrupted = pending?.state === 'applying' && (pending.instanceId !== instanceId || !busy)
    const changed = pending?.state === 'verified' && current !== null && applied?.configurationRevision !== current.configurationRevision
    return snapshot({ schema: 1, state: interrupted ? 'unknown' : changed ? 'blocked' : pending?.state ?? 'blocked', assistantRevision: current?.assistantRevision ?? pending?.assistantRevision ?? '0'.repeat(64),
      configurationRevision: current?.configurationRevision ?? pending?.configurationRevision ?? null,
      targetRevision: pending?.targetRevision ?? null, operationRevision: document.revision,
      provider: current?.assistant.provider ?? pending?.provider ?? applied?.provider ?? null,
      model: current?.assistant.model ?? pending?.model ?? applied?.model ?? null,
      agentPreset: applied?.agentPreset ?? null, externalProvider: applied?.externalProvider ?? null,
      fullAccess: false, missingReasons: interrupted ? ['assistant_deployment_interrupted_unknown'] : changed ? ['assistant_deployment_configuration_changed']
        : pending?.missingReasons ?? ['assistant_deployment_not_applied'], ...override })
  }
  async function exclusive<Value>(run: () => Promise<Value>): Promise<Value> {
    if (busy) fail('ASSISTANT_DEPLOYMENT_BUSY')
    busy = true
    try { return await run() } finally { busy = false }
  }
  function expected(current: Selected, request: Pick<NativeAssistantDeploymentRequest, 'assistantRevision' | 'configurationRevision'>): void {
    if (current.assistantRevision !== request.assistantRevision || current.configurationRevision !== request.configurationRevision) fail('ASSISTANT_CONFIGURATION_CONFLICT')
  }
  async function verified(current: Selected) {
    const result = await deployment.reconcile(current.configuration)
    const matches = result.presetBindings.filter(binding => binding.conversationKind === 'private'
      && binding.definition.model.provider === current.assistant.provider && binding.definition.model.name === current.assistant.model
      && binding.definition.model.reasoningEffort === (current.assistant.reasoningEffort ?? 'off'))
    if (result.missingReasons.length > 0 || matches.length !== 1 || !matches[0]?.externalProvider
      || result.verificationScope !== DSH_DEPLOYMENT_VERIFICATION.verificationScope || result.credentialValueIdentityVerified !== false
      || !result.unverified?.includes('credential_loaded_value_identity')) return { reasons: result.missingReasons.length ? result.missingReasons : ['assistant_deployment_target_unverified'], applied: null }
    const binding = matches[0]
    return { reasons: [] as readonly string[], applied: { configurationRevision: current.configurationRevision,
      provider: current.assistant.provider!, model: current.assistant.model!, externalProvider: binding.externalProvider!, agentPreset: binding.agentPreset } }
  }
  return Object.freeze({
    async resolve(signal: AbortSignal): Promise<NativeAssistantTargetResolution> {
      let current: Selected | null = null
      try {
        current = await selected(signal)
        const document = await readJournal()
        if (unresolved(document.value)) fail('ASSISTANT_DEPLOYMENT_RECONCILIATION_REQUIRED')
        if (document.value.applied?.configurationRevision !== current.configurationRevision) fail('ASSISTANT_DEPLOYMENT_NOT_APPLIED')
        const live = await verified(current)
        if (!live.applied) return { configuration: DEFAULT_NATIVE_WORK_CONFIGURATION, externalProvider: null, agentPreset: null,
          assistantRevision: current.assistantRevision, configurationRevision: current.configurationRevision, missingReasons: live.reasons }
        if (live.applied.agentPreset !== document.value.applied.agentPreset || live.applied.externalProvider !== document.value.applied.externalProvider) fail('ASSISTANT_DEPLOYMENT_TARGET_UNVERIFIED')
        let catalog: JsonValue
        if (options.readModelCatalog) catalog = await options.readModelCatalog(current.configuration, signal)
        else {
          const adapter = current.configuration.adapters.dshAgent
          const port = createDshJsonRpcPort({ endpoint: adapter.endpoint, ...createDshAuthenticationOptions(adapter), timeoutMs: 3_000 })
          try { catalog = await port.readModelCatalog(signal) } finally { await port.close() }
        }
        const reasoning = resolveAssistantReasoning(catalog, live.applied.externalProvider, current.assistant.model!, current.assistant.reasoningEffort ?? 'off')
        return snapshot({ configuration: { ...DEFAULT_NATIVE_WORK_CONFIGURATION, enabled: true, provider: current.assistant.provider,
          model: current.assistant.model, agentPreset: live.applied.agentPreset, fullAccess: false,
          ...(current.assistant.reasoningEffort === null ? {} : { reasoningEffort: current.assistant.reasoningEffort }) },
          externalProvider: live.applied.externalProvider, agentPreset: live.applied.agentPreset,
          assistantRevision: current.assistantRevision, configurationRevision: current.configurationRevision, missingReasons: [], ...reasoning })
      } catch (error) { return { configuration: DEFAULT_NATIVE_WORK_CONFIGURATION, externalProvider: null, agentPreset: null,
        assistantRevision: current?.assistantRevision ?? '0'.repeat(64), configurationRevision: current?.configurationRevision ?? null, missingReasons: [reason(error)] } }
    },
    async status(signal: AbortSignal): Promise<NativeAssistantDeploymentSnapshot> {
      const document = await readJournal()
      try { return projection(document, await selected(signal)) }
      catch (error) { return projection(document, null, { state: 'blocked', missingReasons: [reason(error)] }) }
    },
    async prepare(assistantRevision: string, signal: AbortSignal): Promise<NativeAssistantDeploymentSnapshot> {
      return exclusive(async () => {
        const document = await readJournal()
        if (unresolved(document.value)) return projection(document, null, { state: document.value.pending!.state, missingReasons: ['assistant_deployment_reconciliation_required'] })
        let current: Selected
        try { current = await selected(signal) } catch (error) { return projection(document, null, { state: 'blocked', missingReasons: [reason(error)] }) }
        if (current.assistantRevision !== assistantRevision) fail('ASSISTANT_CONFIGURATION_CONFLICT')
        const preview = await deployment.prepare(current.configuration)
        if (preview.state !== 'prepared') return projection(document, current, { state: 'blocked', missingReasons: preview.missingReasons ?? ['assistant_deployment_not_ready'] })
        const pending: Pending = { state: 'prepared', instanceId, assistantRevision, configurationRevision: current.configurationRevision,
          targetRevision: preview.targetRevision, provider: current.assistant.provider!, model: current.assistant.model!, missingReasons: [] }
        const saved = await writeJournal(document.revision, { ...document.value, pending }, signal)
        return projection(saved, current)
      })
    },
    async apply(request: NativeAssistantDeploymentRequest, signal: AbortSignal): Promise<NativeAssistantDeploymentSnapshot> {
      return exclusive(async () => {
        const document = await readJournal()
        if (document.revision !== request.operationRevision) fail('ASSISTANT_DEPLOYMENT_CONFLICT')
        if (unresolved(document.value)) fail('ASSISTANT_DEPLOYMENT_RECONCILIATION_REQUIRED')
        if (document.value.pending?.state !== 'prepared') fail('ASSISTANT_DEPLOYMENT_PREVIEW_REQUIRED')
        const current = await selected(signal)
        expected(current, request)
        if (document.value.pending.targetRevision !== request.targetRevision
          || document.value.pending.configurationRevision !== current.configurationRevision) fail('ASSISTANT_DEPLOYMENT_CONFLICT')
        const preview = await deployment.prepare(current.configuration)
        if (preview.state !== 'prepared' || preview.targetRevision !== request.targetRevision) fail('ASSISTANT_DEPLOYMENT_CONFLICT')
        await options.authorizeApply?.(signal); signal.throwIfAborted()
        const fresh = await selected(signal); expected(fresh, request)
        const inFlight = await writeJournal(document.revision, { ...document.value, pending: { ...document.value.pending, state: 'applying' } }, signal)
        let result: Awaited<ReturnType<NativeChatDeploymentRuntime['apply']>>
        try { result = await deployment.apply(current.configuration, signal, request.targetRevision) }
        catch { result = { schema: 1, state: 'unknown', missingReasons: ['assistant_deployment_result_unknown'] } }
        let state: Pending['state'] = result.state === 'verified' ? 'verified' : result.state === 'pending_reload' ? 'pending_reload'
          : result.state === 'unknown' ? 'unknown' : 'blocked'
        let applied = inFlight.value.applied
        let reasons = result.missingReasons
        if (state === 'verified') {
          const live = await verified(await selected(signal))
          if (live.applied?.configurationRevision !== current.configurationRevision) { state = 'unknown'; reasons = ['assistant_deployment_configuration_changed'] }
          else { applied = live.applied; reasons = [] }
        }
        const pending: Pending = { ...inFlight.value.pending!, state, missingReasons: reasons }
        const saved = await writeJournal(inFlight.revision, { schema: 1, pending, applied }, new AbortController().signal)
        return projection(saved, current, { state: result.state === 'conflict' ? 'conflict' : state })
      })
    },
    async reconcile(request: Omit<NativeAssistantDeploymentRequest, 'targetRevision'>, signal: AbortSignal): Promise<NativeAssistantDeploymentSnapshot> {
      return exclusive(async () => {
        const document = await readJournal()
        if (document.revision !== request.operationRevision) fail('ASSISTANT_DEPLOYMENT_CONFLICT')
        const current = await selected(signal); expected(current, request)
        if (document.value.pending?.configurationRevision !== current.configurationRevision) fail('ASSISTANT_CONFIGURATION_CONFLICT')
        const live = await verified(current)
        if (!live.applied) return projection(document, current, { state: document.value.pending.state === 'applying' ? 'unknown' : document.value.pending.state, missingReasons: live.reasons })
        const saved = await writeJournal(document.revision, { schema: 1, pending: { ...document.value.pending, state: 'verified', missingReasons: [] }, applied: live.applied }, signal)
        return projection(saved, current)
      })
    }
  })
}
export type NativeAssistantTarget = ReturnType<typeof createNativeAssistantTarget>
