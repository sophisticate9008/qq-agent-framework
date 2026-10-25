import type { NativeDeploymentPreparationResult, NativeDeploymentApplyResult, NativeDeploymentReconciliationResult } from '../contracts/native-deployment.ts'
import type { DshProfileInspection, DshProfileFilePort } from '../contracts/dsh-profile.ts'
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { JsonObject, JsonValue } from '../contracts/data.ts'
import { snapshot } from '../core/values.ts'
import { buildChatSessionDefinition } from './chat-plans.ts'
import { createChatCapabilityService, validateChatCapabilityApprovalRequest, validateChatCapabilityCompositionApproval } from './chat-capabilities.ts'
import type { ChatCapabilityApprovalRequest, ChatCapabilityCompositionApproval, ChatCapabilityDeclaration, ResolveChatCapabilityApproval } from './chat-capabilities.ts'
import type { NativeChatConfiguration, NativeChatDeploymentRuntime } from './native-chat-configuration.ts'
import { nativeAuthorizationMode } from './native-access.ts'
import { discoverLocalDshDeployment } from './local-dsh-deployment.ts'
import { createDshAuthenticationOptions } from '../adapters/dsh-authentication.ts'
import { prepareDshDeployment, DSH_DEPLOYMENT_VERIFICATION } from './dsh-deployment-plan.ts'
import type { DshDeploymentPreparation, DshDeploymentSnapshot } from './dsh-deployment-plan.ts'
import { createDshJsonRpcPort } from '../adapters/dsh-jsonrpc.ts'
import type { DshPresetBinding } from '../adapters/dsh-jsonrpc.ts'
import { createDshProfileFilePort, DshProfileFileError as ProfileError } from '../adapters/dsh-profile-files.ts'
import { readStaticDshProfile, staticDshProfileValues } from '../adapters/dsh-static-profile.ts'

const parse = readStaticDshProfile
const values = staticDshProfileValues
function fail(code: string): never { throw new ProfileError(code) }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function object(value: JsonValue | undefined): JsonObject | undefined { return record(value) ? value as JsonObject : undefined }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function dynamic(value: JsonValue): boolean {
  return Array.isArray(value) ? value.some(dynamic) : record(value) && (Object.hasOwn(value, '__jsExpr') || Object.values(value).some(dynamic))
}
interface PreparedProfile {
  readonly identity: string
  readonly read: DshProfileInspection
  readonly preparation: DshDeploymentPreparation
  readonly capabilityApprovalRequest: ChatCapabilityApprovalRequest | null
}
export interface DshProfileDeploymentOptions {
  readonly verificationTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly resolveCapabilityApproval?: ResolveChatCapabilityApproval
  readonly files?: DshProfileFilePort
  readonly conversationKinds?: readonly ('group' | 'private')[]
}
function configurationIdentity(configuration: NativeChatConfiguration): string {
  return digest(configuration)
}

async function prepareProfile(configuration: NativeChatConfiguration, signal: AbortSignal, files: DshProfileFilePort, options: DshProfileDeploymentOptions): Promise<PreparedProfile> {
  const target = configuration.deployment.target
  if (!target) fail('explicit_dsh_target_required')
  const plan = configuration.catalog.plans.find(candidate => candidate.id === configuration.catalog.activePlanId)
  const persona = configuration.personas.find(candidate => candidate.id === plan?.personaId)
  if (!plan || !persona) fail('active_chat_plan_required')
  const read = await files.read(target)
  const definition = buildChatSessionDefinition(plan, persona)
  let capabilityDeclaration: ChatCapabilityDeclaration | undefined
  if (definition.capabilitySelection) {
    if (!configuration.adapters.dshAgent.enabled) fail('dsh_agent_not_enabled')
    const client = createDshJsonRpcPort({ endpoint: configuration.adapters.dshAgent.endpoint,
      ...createDshAuthenticationOptions(configuration.adapters.dshAgent), timeoutMs: 3_000 })
    try {
      capabilityDeclaration = await createChatCapabilityService({ client }).readDeclaration(definition.capabilitySelection, signal)
    } catch {
      fail('capability_source_unverified')
    } finally { await client.close() }
  }
  const preparation = prepareDshDeployment({
    definition, providers: configuration.providers, target: read.snapshot,
    modelSettings: configuration.deployment.modelSettings ?? undefined, namespace: configuration.deployment.namespace,
    ...(options.conversationKinds === undefined ? {} : { conversationKinds: options.conversationKinds }),
    ...(capabilityDeclaration ? { capabilityDeclaration } : {}),
  })
  const composition = preparation.preview()?.capabilityComposition
  const capabilityApprovalRequest = composition ? validateChatCapabilityApprovalRequest({ schema: 1, source: composition.source,
    compositionRevision: composition.revision, target: { profilePath: target.profilePath, credentialsPath: target.credentialsPath,
      layerPaths: target.layerPaths ?? [], schemaVersion: target.schemaVersion } }) : null
  return { identity: configurationIdentity(configuration), read, preparation, capabilityApprovalRequest }
}

function subset(actual: JsonValue | undefined, expected: JsonValue): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => subset(actual[index], item))
  if (record(expected)) return record(actual) && Object.entries(expected).every(([key, value]) => subset(actual[key], value))
  return isDeepStrictEqual(actual, expected)
}

async function liveSnapshot(configuration: NativeChatConfiguration, prepared: PreparedProfile, signal: AbortSignal, files: DshProfileFilePort): Promise<DshDeploymentSnapshot> {
  const preview = prepared.preparation.preview()
  if (!preview || !configuration.adapters.dshAgent.enabled) fail('dsh_live_verification_required')
  const port = createDshJsonRpcPort({ endpoint: configuration.adapters.dshAgent.endpoint,
    ...createDshAuthenticationOptions(configuration.adapters.dshAgent), timeoutMs: 3_000 })
  try {
    const inspection = await port.inspectDeployment({ agentPresets: preview.presets.map(preset => String(preset.config.id)), credentialRefs: preview.credentialRefs, signal })
    const settings = object(inspection.settings)
    const namespaces = settings?.namespaces
    if (!Array.isArray(namespaces)) fail('dsh_live_schema_mismatch')
    const section = namespaces.map(object).filter(row => row?.ns === prepared.read.snapshot.providerEntryId)
    const credentialSections = namespaces.map(object).filter(row => row?.ns === prepared.read.credentialEntryId)
    const credentialConfig = credentialSections.length === 1 ? object(credentialSections[0]?.value) : undefined
    let explicitCredentialPath = typeof credentialConfig?.path === 'string' && isAbsolute(credentialConfig.path)
      ? credentialConfig.path
      : credentialConfig?.path === undefined && typeof credentialConfig?.dshHome === 'string' && isAbsolute(credentialConfig.dshHome)
        ? join(credentialConfig.dshHome, '.credentials.yaml') : undefined
    if (credentialSections.length === 0 && prepared.read.credentialEntryId
      && configuration.adapters.dshAgent.localCredentialsPath && !configuration.adapters.dshAgent.auth) {
      const effectiveConfig = prepared.read.credentialEntryConfig
      if (!effectiveConfig || dynamic(effectiveConfig) || effectiveConfig.path !== prepared.read.target.credentialsPath) {
        fail('dsh_credential_target_unverified')
      }
      try {
        const discovered = await discoverLocalDshDeployment({
          endpoint: configuration.adapters.dshAgent.endpoint,
          localCredentialsPath: configuration.adapters.dshAgent.localCredentialsPath,
          signal,
        })
        if (discovered.credentialsPath !== prepared.read.target.credentialsPath
          || discovered.profilePath !== prepared.read.target.profilePath
          || discovered.schemaVersion !== prepared.read.target.schemaVersion
          || !isDeepStrictEqual(discovered.layerPaths, prepared.read.target.layerPaths ?? [])) {
          fail('dsh_credential_target_unverified')
        }
        const current = await files.read(discovered)
        if (current.snapshot.revision !== prepared.read.snapshot.revision) fail('dsh_credential_target_unverified')
        explicitCredentialPath = discovered.credentialsPath
      } catch {
        fail('dsh_credential_target_unverified')
      }
    }
    if (!prepared.read.credentialEntryId || explicitCredentialPath !== prepared.read.target.credentialsPath) fail('dsh_credential_target_unverified')
    const liveConfig = section.length === 1 ? object(section[0]?.value) : undefined
    const liveProviders = object(liveConfig?.providers)
    const roster = object(inspection.roster)?.presets
    if (!liveConfig || !liveProviders || !Array.isArray(roster)) fail('pending_reload')
    for (const [route, expected] of Object.entries(preview.providerUpdates)) if (!subset(liveProviders[route], expected)) fail('pending_reload')
    for (const preset of preview.presets) {
      const rows = roster.map(object).filter(row => row?.id === preset.config.id)
      const documents = inspection.documents.map(object).filter(doc => doc?.agentPreset === preset.config.id)
      if (rows.length !== 1 || rows[0]?.broken !== undefined || documents.length !== 1 || typeof documents[0]?.content !== 'string'
        || !isDeepStrictEqual(values(parse(documents[0].content)), preset.config.plugins)) fail('pending_reload')
    }
    const credentials = object(inspection.credentials)
    const definitionProvider = configuration.catalog.plans.find(plan => plan.id === configuration.catalog.activePlanId)?.provider
    const desiredKey = configuration.providers.find(candidate => candidate.id === definitionProvider)?.apiKey
    const credentialMatches = await files.matchCredentials(prepared.read.target, prepared.read.snapshot.revision,
      preview.credentialRefs.map(ref => ({ ref, value: desiredKey ?? '' })))
    const credentialChecks = preview.credentialRefs.map(ref => {
      const live = object(credentials?.[ref])
      return { ref, localValueMatches: desiredKey !== undefined && credentialMatches.find(candidate => candidate.ref === ref)?.matches === true,
        liveConfigured: live?.configured === true && live?.writable === true, liveSource: typeof live?.source === 'string' ? live.source : null,
        targetPath: explicitCredentialPath }
    })
    if (credentialChecks.some(check => !check.localValueMatches || !check.liveConfigured || check.liveSource !== 'file')) {
      fail('dsh_credential_file_source_unverified')
    }
    return snapshot({ ...prepared.read.snapshot, credentialChecks, configurationLoaded: true })
  } finally {
    await port.close()
  }
}

function reason(error: unknown): string {
  return error instanceof ProfileError ? error.code : 'dsh_profile_operation_failed'
}

export function createNativeDshDeploymentRuntime(options: DshProfileDeploymentOptions = {}): NativeChatDeploymentRuntime {
  const files = options.files ?? createDshProfileFilePort()
  const timeoutMs = options.verificationTimeoutMs ?? 5_000
  const pollMs = options.pollIntervalMs ?? 250
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 5_000
    || options.resolveCapabilityApproval !== undefined && typeof options.resolveCapabilityApproval !== 'function') throw new TypeError('Invalid DSH deployment options')
  let staged: PreparedProfile | undefined
  let applying = false
  const requireApproval = async (configuration: NativeChatConfiguration, prepared: PreparedProfile, signal: AbortSignal): Promise<void> => {
    const request = prepared.capabilityApprovalRequest
    if (!request || nativeAuthorizationMode(configuration.authorization) === 'whitelist') return
    if (!options.resolveCapabilityApproval) fail('capability_owner_approval_required')
    const candidate = await options.resolveCapabilityApproval(request, signal)
    let approval: ChatCapabilityCompositionApproval
    try { approval = validateChatCapabilityCompositionApproval(candidate) } catch { fail('capability_owner_approval_required') }
    if (!isDeepStrictEqual(approval.source, request.source) || !isDeepStrictEqual(approval.target, request.target)
      || approval.compositionRevision !== request.compositionRevision) fail('capability_approval_conflict')
    signal.throwIfAborted()
  }
  const reconcile = async (configuration: NativeChatConfiguration, signal = AbortSignal.timeout(timeoutMs)): Promise<NativeDeploymentReconciliationResult> => {
    try {
      const prepared = await prepareProfile(configuration, signal, files, options)
      if (!prepared.preparation.summary.ready) return { schema: 1, missingReasons: prepared.preparation.summary.missingReasons, presetBindings: [] }
      await requireApproval(configuration, prepared, signal)
      const readback = await liveSnapshot(configuration, prepared, signal, files)
      if (prepared.capabilityApprovalRequest) {
        const current = await prepareProfile(configuration, signal, files, options)
        if (current.read.snapshot.revision !== prepared.read.snapshot.revision
          || !current.preparation.summary.ready
          || !isDeepStrictEqual(current.preparation.preview(), prepared.preparation.preview())) fail('capability_composition_changed')
        await requireApproval(configuration, current, signal)
      }
      const result = prepared.preparation.reconcile(readback)
      if (result.status !== 'verified') return { schema: 1, missingReasons: result.missingReasons, presetBindings: [] }
      return { schema: 1, missingReasons: [], presetBindings: result.presetBindings, ...DSH_DEPLOYMENT_VERIFICATION,
        capabilityComposition: prepared.preparation.preview()?.capabilityComposition ?? null }
    } catch (error) {
      return { schema: 1, missingReasons: [reason(error)], presetBindings: [] as readonly DshPresetBinding[] }
    }
  }
  return Object.freeze({
    async prepare(configuration: NativeChatConfiguration): Promise<NativeDeploymentPreparationResult> {
      if (applying) return { schema: 1, state: 'blocked', missingReasons: ['deployment_busy'] }
      staged = undefined
      try {
        staged = await prepareProfile(configuration, AbortSignal.timeout(timeoutMs), files, options)
        const fields = { schema: 1 as const, targetRevision: staged.read.snapshot.revision,
          preview: staged.preparation.preview(), capabilityApprovalRequest: staged.capabilityApprovalRequest, ...DSH_DEPLOYMENT_VERIFICATION }
        return staged.preparation.summary.ready
          ? snapshot({ ...fields, state: 'prepared', summary: { ...staged.preparation.summary, ready: true as const } })
          : snapshot({ ...fields, state: 'blocked', summary: staged.preparation.summary,
            missingReasons: staged.preparation.summary.missingReasons })
      } catch (error) {
        return { schema: 1, state: 'blocked', missingReasons: [reason(error)] }
      }
    },
    reconcile,
    async apply(configuration: NativeChatConfiguration, signal: AbortSignal, expectedTargetRevision?: string): Promise<NativeDeploymentApplyResult> {
      if (applying) return { schema: 1, state: 'blocked', missingReasons: ['deployment_busy'] }
      const prepared = staged
      staged = undefined
      if (!prepared || prepared.identity !== configurationIdentity(configuration)) return { schema: 1, state: 'blocked', missingReasons: ['deployment_preview_required'] }
      if (expectedTargetRevision !== prepared.read.snapshot.revision) return { schema: 1, state: 'conflict', missingReasons: ['deployment_preview_revision_conflict'] }
      if (signal.aborted) return { schema: 1, state: 'blocked', missingReasons: ['deployment_aborted'] }
      applying = true
      let backupId: string | undefined
      try {
        if (prepared.capabilityApprovalRequest) {
          try {
            await requireApproval(configuration, prepared, signal)
            const current = await prepareProfile(configuration, signal, files, options)
            if (current.read.snapshot.revision !== prepared.read.snapshot.revision) return { schema: 1, state: 'conflict', missingReasons: ['deployment_revision_conflict'] }
            if (!current.preparation.summary.ready
              || !isDeepStrictEqual(current.preparation.preview(), prepared.preparation.preview())) fail('capability_composition_changed')
          } catch (error) { return { schema: 1, state: 'blocked', missingReasons: [reason(error)] } }
        }
        let writeFailure: string | undefined
        await prepared.preparation.apply(async proposal => {
          try {
            backupId = await files.write(prepared.read.target, proposal, signal, id => { backupId = id })
            const readback = await files.read(prepared.read.target)
            return { status: 'committed', backupId, readback: readback.snapshot }
          } catch (error) {
            writeFailure = reason(error)
            return { status: 'conflict' }
          }
        }, signal)
        if (writeFailure) return { schema: 1, state: writeFailure === 'deployment_revision_conflict' ? 'conflict' : 'unknown',
          ...(backupId ? { backupId } : {}), missingReasons: [writeFailure] }
        if (!backupId) return { schema: 1, state: 'blocked', missingReasons: prepared.preparation.summary.missingReasons }
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        do {
          const result = await reconcile(configuration, deadline)
          if (result.missingReasons.length === 0) return { schema: 1, state: 'verified', backupId, missingReasons: [], ...DSH_DEPLOYMENT_VERIFICATION }
          if (deadline.aborted) break
          await delay(pollMs, undefined, { signal: deadline }).catch(() => undefined)
        } while (!deadline.aborted)
        return { schema: 1, state: 'pending_reload', backupId, missingReasons: ['pending_reload'] }
      } catch {
        return backupId ? { schema: 1, state: 'pending_reload', backupId, missingReasons: ['deployment_result_unknown'] }
          : { schema: 1, state: 'unknown', missingReasons: ['deployment_result_unknown'] }
      } finally {
        applying = false
      }
    },
  })
}
