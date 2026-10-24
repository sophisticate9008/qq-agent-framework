import { createHash, createHmac } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { snapshot } from '../core/values.ts'
import type { JsonObject, JsonValue } from '../core/types.ts'
import { buildChatSessionDefinition } from '../host/chat-plans.ts'
import type { ChatSessionDefinition, ChatPlanReasoningEffort } from '../host/chat-plans.ts'
import { validateModelProviders } from '../host/model-providers.ts'
import type { NativeModelProvider } from '../host/model-providers.ts'
import type { DshPresetBinding } from './dsh-jsonrpc.ts'

export const DSH_DEPLOYMENT_SCHEMA = '0.2.1-rc.2' as const

export const DSH_DEPLOYMENT_EVIDENCE = Object.freeze([
  '@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1035-1083 (provider/model schema)',
  '@deepseek-ai/dsh-persona/lib/index.js:29-61 (scoped complete persona; strict interpolation)',
  '@deepseek-ai/dsh-web-app/presets/minimal.patch.yml:4-40 (insert/preset/isolation schema)',
  '@deepseek-ai/dsh-compaction-basic/lib/index.js:59-89,124-143 (capacity/pressure, not a hard token ceiling)',
  '@deepseek-ai/dsh-agent-preset-registry/lib/typert.remote-client.d.ts (list/read/select; no deploy)',
  '@deepseek-ai/dsh-web-app/cordis.patch.yml:1-7 (whole config replacement)',
])

export interface DshDeploymentPreset {
  readonly entryId: string
  readonly config: JsonObject
}

export interface DshDeploymentSnapshot {
  readonly profilePath: string
  readonly credentialsPath: string
  readonly schemaVersion: string
  readonly revision: string
  readonly providerEntryId: string
  readonly providerConfig: JsonObject
  readonly presets: readonly DshDeploymentPreset[]
  readonly credentialChecks: readonly {
    readonly ref: string
    readonly localValueMatches: boolean
    readonly liveConfigured: boolean
    readonly liveSource: string | null
    readonly targetPath: string | null
  }[]
  readonly configurationLoaded: boolean
}

export const DSH_DEPLOYMENT_VERIFICATION = Object.freeze({
  verificationScope: 'provider-preset-and-managed-file-provenance' as const,
  credentialValueIdentityVerified: false as const,
  unverified: Object.freeze(['credential_loaded_value_identity']),
})

export interface DshDeploymentModelSettings {
  readonly contextWindow: number
  readonly maxTokens: number
  readonly reasoningEfforts: false | Readonly<Partial<Record<ChatPlanReasoningEffort, string | null>>>
}

export interface DshDeploymentInput {
  readonly definition: ChatSessionDefinition
  readonly providers: readonly NativeModelProvider[]
  readonly target?: DshDeploymentSnapshot
  readonly modelSettings?: DshDeploymentModelSettings
  readonly namespace?: string
}

export interface DshSelectablePreset {
  readonly agentPreset: string
  readonly conversationKind: 'group' | 'private'
  readonly externalProvider: string
  readonly model: string
  readonly contextWindow: number
}

export interface DshDeploymentSummary {
  readonly ready: boolean
  readonly missingReasons: readonly string[]
  readonly selectablePresets: readonly DshSelectablePreset[]
  readonly limitations: readonly string[]
  readonly sourceRefs: readonly string[]
}

export interface DshDeploymentProposal {
  readonly profilePath: string
  readonly expectedRevision: string
  readonly patch: readonly JsonObject[]
  readonly credentials: readonly { readonly ref: string; readonly value: string }[]
  readonly expected: {
    readonly providerConfig: JsonObject
    readonly presets: readonly DshDeploymentPreset[]
  }
}

export type DshDeploymentReceipt =
  | { readonly status: 'conflict' }
  | { readonly status: 'committed'; readonly backupId: string; readonly readback: DshDeploymentSnapshot }

export type DshDeploymentApply = (proposal: DshDeploymentProposal, signal: AbortSignal) => Promise<DshDeploymentReceipt>

export type DshDeploymentResult =
  | ({ readonly status: 'verified'; readonly revision: string; readonly presetBindings: readonly DshPresetBinding[] } & typeof DSH_DEPLOYMENT_VERIFICATION)
  | { readonly status: 'not-ready' | 'conflict' | 'unknown'; readonly missingReasons: readonly string[] }

export interface DshDeploymentPreparation {
  readonly summary: DshDeploymentSummary
  preview(): { readonly providerUpdates: JsonObject; readonly presets: readonly DshDeploymentPreset[]; readonly credentialRefs: readonly string[] } | null
  reconcile(readback: DshDeploymentSnapshot): DshDeploymentResult
  apply(deploy: DshDeploymentApply, signal: AbortSignal): Promise<DshDeploymentResult>
}

function object(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 16_777_216
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateDshModelSettings(value: unknown): DshDeploymentModelSettings {
  if (!record(value) || Object.keys(value).some(key => !['contextWindow', 'maxTokens', 'reasoningEfforts'].includes(key))
    || typeof value.contextWindow !== 'number' || !positive(value.contextWindow)
    || typeof value.maxTokens !== 'number' || !positive(value.maxTokens) || value.maxTokens >= value.contextWindow) {
    throw new TypeError('Invalid DSH model settings')
  }
  const efforts = value.reasoningEfforts
  if (efforts !== false && (!record(efforts)
    || !Object.keys(efforts).some(level => level !== 'off')
    || Object.entries(efforts).some(([level, wire]) => !['off', 'low', 'medium', 'high', 'max'].includes(level)
      || wire === null && level !== 'off' || wire !== null && (typeof wire !== 'string' || wire.length === 0 || wire.length > 128)))) {
    throw new TypeError('Invalid DSH model settings')
  }
  return snapshot(value) as unknown as DshDeploymentModelSettings
}

export function validateDshDeploymentSnapshot(value: unknown): DshDeploymentSnapshot {
  if (!record(value) || Object.keys(value).some(key => !['profilePath', 'credentialsPath', 'schemaVersion', 'revision', 'providerEntryId', 'providerConfig', 'presets', 'credentialChecks', 'configurationLoaded'].includes(key))
    || typeof value.profilePath !== 'string' || value.profilePath.length > 4096 || !isAbsolute(value.profilePath) || value.profilePath.includes('\0')
    || typeof value.credentialsPath !== 'string' || value.credentialsPath.length > 4096 || !isAbsolute(value.credentialsPath) || value.credentialsPath.includes('\0')
    || value.schemaVersion !== DSH_DEPLOYMENT_SCHEMA || typeof value.revision !== 'string' || value.revision.length === 0 || value.revision.length > 256
    || typeof value.providerEntryId !== 'string' || !validId(value.providerEntryId) || !record(value.providerConfig)
    || value.providerConfig.providers !== undefined && !record(value.providerConfig.providers)
    || !Array.isArray(value.presets) || value.presets.length > 256
    || value.presets.some(preset => !record(preset) || Object.keys(preset).length !== 2 || typeof preset.entryId !== 'string'
      || !validId(preset.entryId) || !record(preset.config) || typeof preset.config.id !== 'string')
    || !Array.isArray(value.credentialChecks) || value.credentialChecks.length > 512
    || value.credentialChecks.some(check => !record(check) || Object.keys(check).length !== 5 || typeof check.ref !== 'string'
      || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(check.ref) || typeof check.localValueMatches !== 'boolean'
      || typeof check.liveConfigured !== 'boolean' || check.liveSource !== null && typeof check.liveSource !== 'string'
      || check.targetPath !== null && typeof check.targetPath !== 'string')
    || typeof value.configurationLoaded !== 'boolean') throw new TypeError('Invalid DSH deployment snapshot')
  try {
    const copied = snapshot(value)
    if (Buffer.byteLength(JSON.stringify(copied)) > 1_048_576) throw new TypeError('Invalid DSH deployment snapshot')
    return copied as unknown as DshDeploymentSnapshot
  } catch {
    throw new TypeError('Invalid DSH deployment snapshot')
  }
}

export function prepareDshDeployment(input: DshDeploymentInput): DshDeploymentPreparation {
  const missingReasons: string[] = []
  const metadata: DshSelectablePreset[] = []
  let proposal: DshDeploymentProposal | undefined
  let bindings: readonly DshPresetBinding[] = []
  let target: DshDeploymentSnapshot | undefined
  try {
    const source = input.definition
    const definition = buildChatSessionDefinition({
      id: source.planId, name: source.planId, description: '', instructions: source.instructions,
      personaId: source.personaId, provider: source.model.provider, model: source.model.name,
      reasoningEffort: source.model.reasoningEffort,
      ...(source.contextLimits === undefined ? {} : { contextLimits: source.contextLimits }),
    }, { id: source.personaId, name: source.personaId, ...source.persona })
    const providers = validateModelProviders(input.providers)
    const provider = providers.find(candidate => candidate.id === definition.model.provider)
    const settings = input.modelSettings === undefined ? undefined : validateDshModelSettings(input.modelSettings)
    const namespace = input.namespace ?? 'qqaf'
    target = input.target === undefined ? undefined : validateDshDeploymentSnapshot(input.target)
    if (!validId(namespace) || namespace.length > 16) missingReasons.push('invalid_namespace')
    if (!target) missingReasons.push('explicit_dsh_target_required')
    else if (!isAbsolute(target.profilePath) || !target.revision || !validId(target.providerEntryId)
      || target.schemaVersion !== DSH_DEPLOYMENT_SCHEMA || !object(target.providerConfig)) {
      missingReasons.push('unsupported_dsh_target_schema')
    }
    if (!provider || !provider.enabled || !provider.apiKey
      || !provider.models.some(model => model.id === definition.model.name)) missingReasons.push('provider_not_usable')
    if (!definition.contextLimits) missingReasons.push('context_limits_required')
    if (!settings || !positive(settings.contextWindow) || !positive(settings.maxTokens)
      || settings.maxTokens >= settings.contextWindow) missingReasons.push('model_capacity_required')
    if (settings && definition.contextLimits && (Math.max(definition.contextLimits.group, definition.contextLimits.private) > settings.contextWindow
      || Math.min(definition.contextLimits.group, definition.contextLimits.private) <= settings.maxTokens)) {
      missingReasons.push('context_capacity_incompatible')
    }
    if (settings) {
      const efforts = settings.reasoningEfforts
      if (efforts !== false && (efforts === null || typeof efforts !== 'object'
        || !Object.entries(efforts).some(([level]) => level !== 'off')
        || Object.entries(efforts).some(([level, wire]) => !['off', 'low', 'medium', 'high', 'max'].includes(level)
          || wire === null && level !== 'off' || wire !== null && (typeof wire !== 'string' || wire.length === 0 || wire.length > 128)))) {
        missingReasons.push('unsupported_reasoning_mapping')
      } else if (efforts === false ? definition.model.reasoningEffort !== 'off'
        : !Object.hasOwn(efforts, definition.model.reasoningEffort)) missingReasons.push('reasoning_effort_not_offered')
    }
    const prompt = [definition.persona.identity, definition.persona.style, definition.instructions].join('\n\n')
    if (/\{\{[\s\S]*?\}\}/.test(prompt)) missingReasons.push('literal_prompt_template_unsupported')
    if (missingReasons.length === 0 && target && provider && settings && definition.contextLimits) {
      const credentialVersion = createHmac('sha256', provider.apiKey).update(`qqaf-dsh:${provider.id}`).digest('hex')
      const digest = createHash('sha256').update(JSON.stringify({ definition, settings, type: provider.type, baseUrl: provider.baseUrl, namespace, credentialVersion })).digest('hex').slice(0, 24)
      const providerConfig = snapshot(target.providerConfig)
      const existingProviders = object(providerConfig.providers)
      if (providerConfig.providers !== undefined && !existingProviders) throw new TypeError('Invalid provider section')
      const nextProviders: JsonObject = { ...existingProviders }
      const presets: DshDeploymentPreset[] = []
      const insertions: JsonObject[] = []
      const credentials: Array<{ ref: string; value: string }> = []
      const nextBindings: DshPresetBinding[] = []
      for (const conversationKind of ['group', 'private'] as const) {
        const externalProvider = `${namespace}-${digest}-${conversationKind}`
        const agentPreset = externalProvider
        const credentialRef = `${namespace.toUpperCase()}_${digest.toUpperCase()}_${conversationKind.toUpperCase()}_KEY`
        const contextWindow = definition.contextLimits[conversationKind]
        const route: JsonObject = {
          api: provider.type === 'openai' ? 'openai-completions' : 'anthropic-messages',
          baseURL: provider.baseUrl, apiKeyEnv: credentialRef,
          models: [{ id: definition.model.name, contextWindow, maxTokens: settings.maxTokens,
            input: ['text'], reasoningEfforts: settings.reasoningEfforts }],
        }
        if (nextProviders[externalProvider] !== undefined && !isDeepStrictEqual(nextProviders[externalProvider], route)) {
          missingReasons.push('external_provider_conflict')
        }
        nextProviders[externalProvider] = route
        const preset: DshDeploymentPreset = {
          entryId: `${namespace}-preset-${digest}-${conversationKind}`,
          config: {
            id: agentPreset, name: `Native chat (${conversationKind})`,
            plugins: [
              { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: prompt, complete: true, includeRuntimeContext: false } },
              { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
                { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {
                  auto: true, headroomTokens: 0, maxTokens: settings.maxTokens,
                  summarizationProvider: externalProvider, summarizationModel: definition.model.name,
                } },
              ] },
            ],
          },
        }
        const existing = target.presets.filter(candidate => candidate.entryId === preset.entryId || candidate.config.id === agentPreset)
        if (existing.length > 0 && (existing.length !== 1 || !isDeepStrictEqual(existing[0], preset))) missingReasons.push('preset_conflict')
        else if (existing.length === 0) insertions.push({ id: preset.entryId, name: '@deepseek-ai/dsh-agent-preset', config: preset.config })
        presets.push(preset)
        credentials.push({ ref: credentialRef, value: provider.apiKey })
        metadata.push({ agentPreset, conversationKind, externalProvider, model: definition.model.name, contextWindow })
        nextBindings.push({ agentPreset, conversationKind, externalProvider, definition })
      }
      const nextConfig = { ...providerConfig, providers: nextProviders }
      const patch: JsonObject[] = [{ id: target.providerEntryId, config: nextConfig }]
      if (insertions.length > 0) patch.push({ insert: insertions })
      proposal = snapshot({
        profilePath: target.profilePath, expectedRevision: target.revision,
        patch,
        credentials, expected: { providerConfig: nextConfig, presets },
      })
      bindings = snapshot(nextBindings)
    }
  } catch {
    missingReasons.push('invalid_deployment_input')
  }
  const summary: DshDeploymentSummary = snapshot({
    ready: missingReasons.length === 0 && proposal !== undefined,
    missingReasons: [...new Set(missingReasons)], selectablePresets: metadata,
    limitations: [
      'Explicit schema-aware host deployment callback required; no automatic filesystem discovery, writes, reload or restart.',
      'Host must CAS the profile and credentials together, retain a private backup, merge effective rows, reload and read back live state without creating sessions.',
      'Context windows configure separate routes and automatic pressure compaction, not an exact per-message hard token ceiling.',
      'Generated presets provide text-only chat and compaction, not tools or additional capabilities; existing sessions are not updated.',
      'OpenAI means openai-completions, not Responses; model capacities and reasoning wire mappings must be operator supplied.',
      'Read-only credential metadata proves managed-file provenance, not loaded plaintext value identity; credentialValueIdentityVerified is always false.',
    ], sourceRefs: DSH_DEPLOYMENT_EVIDENCE,
  })
  const reconcile = (readback: DshDeploymentSnapshot): DshDeploymentResult => {
    if (!summary.ready || !proposal || !target) return { status: 'not-ready', missingReasons: summary.missingReasons }
    try {
      readback = validateDshDeploymentSnapshot(readback)
      const expectedProviders = object(proposal.expected.providerConfig.providers)!
      const actualProviders = object(readback.providerConfig.providers)
      if (readback.profilePath !== target.profilePath || readback.schemaVersion !== DSH_DEPLOYMENT_SCHEMA
        || readback.credentialsPath !== target.credentialsPath
        || readback.providerEntryId !== target.providerEntryId || !readback.revision || readback.configurationLoaded !== true
        || !actualProviders
        || metadata.some(preset => !isDeepStrictEqual(actualProviders[preset.externalProvider], expectedProviders[preset.externalProvider]))
        || proposal.expected.presets.some(preset => {
          const matches = readback.presets.filter(actual => actual.entryId === preset.entryId || actual.config.id === preset.config.id)
          return matches.length !== 1 || !isDeepStrictEqual(matches[0], preset)
        })
        || proposal.credentials.some(credential => {
          const checks = readback.credentialChecks.filter(check => check.ref === credential.ref)
          return checks.length !== 1 || checks[0]?.localValueMatches !== true || checks[0]?.liveConfigured !== true
            || checks[0]?.liveSource !== 'file' || checks[0]?.targetPath !== target.credentialsPath
        })) return { status: 'not-ready', missingReasons: ['dsh_live_verification_required'] }
      return snapshot({ status: 'verified', revision: readback.revision, presetBindings: bindings, ...DSH_DEPLOYMENT_VERIFICATION })
    } catch {
      return { status: 'not-ready', missingReasons: ['dsh_live_verification_required'] }
    }
  }
  let attempted = false
  return Object.freeze({
    summary, reconcile,
    preview() {
      if (!proposal) return null
      const providers = object(proposal.expected.providerConfig.providers)!
      const providerUpdates: JsonObject = {}
      for (const preset of metadata) providerUpdates[preset.externalProvider] = providers[preset.externalProvider]!
      return snapshot({ providerUpdates, presets: proposal.expected.presets, credentialRefs: proposal.credentials.map(credential => credential.ref) })
    },
    async apply(deploy: DshDeploymentApply, signal: AbortSignal): Promise<DshDeploymentResult> {
      if (!summary.ready || !proposal) return { status: 'not-ready', missingReasons: summary.missingReasons }
      if (attempted) return { status: 'not-ready', missingReasons: ['prepare_again_before_apply'] }
      if (signal.aborted) return { status: 'not-ready', missingReasons: ['deployment_aborted'] }
      attempted = true
      try {
        const receipt = await deploy(proposal, signal)
        if (receipt.status === 'conflict') return { status: 'conflict', missingReasons: ['deployment_revision_conflict'] }
        if (signal.aborted || !receipt.backupId || receipt.readback.revision === proposal.expectedRevision) {
          return { status: 'unknown', missingReasons: ['deployment_result_unknown'] }
        }
        const result = reconcile(receipt.readback)
        return result.status === 'verified' ? result : { status: 'unknown', missingReasons: result.missingReasons }
      } catch {
        return { status: 'unknown', missingReasons: ['deployment_result_unknown'] }
      }
    },
  })
}

export function reconcileDshDeployment(input: DshDeploymentInput, readback: DshDeploymentSnapshot): DshDeploymentResult {
  return prepareDshDeployment(input).reconcile(readback)
}
