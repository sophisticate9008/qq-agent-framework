import type { JsonObject } from './data.ts'
import { isChatSessionDefinition, type ChatSessionDefinition } from './chat-session.ts'
import type { ChatCapabilityApprovalRequest, ChatCapabilityComposition } from './chat-capabilities.ts'
import { isChatPlanCapabilitySelection, isChatPlanReference } from './chat-plans.ts'
import { NATIVE_REVISION_PATTERN } from './native-revisions.ts'

export const NATIVE_DEPLOYMENT_RESULT_SCHEMA = 1 as const

export interface NativeDeploymentVerification {
  readonly verificationScope?: string
  readonly credentialValueIdentityVerified?: false
  readonly unverified?: readonly string[]
}

export interface NativeDeploymentPresetBinding {
  readonly agentPreset: string
  readonly definition: ChatSessionDefinition
  readonly externalProvider?: string
  readonly conversationKind?: 'group' | 'private'
}

export interface NativeDeploymentSelectablePreset {
  readonly agentPreset: string
  readonly conversationKind: 'group' | 'private'
  readonly externalProvider: string
  readonly model: string
  readonly contextWindow: number
}

export interface NativeDeploymentSummary {
  readonly ready: boolean
  readonly missingReasons: readonly string[]
  readonly selectablePresets?: readonly NativeDeploymentSelectablePreset[]
  readonly limitations?: readonly string[]
  readonly sourceRefs?: readonly string[]
  readonly capabilityComposition?: ChatCapabilityComposition | null
}

export interface NativeDeploymentPreview {
  readonly providerUpdates?: JsonObject
  readonly presets?: readonly { readonly entryId: string; readonly config: JsonObject }[]
  readonly credentialRefs?: readonly string[]
  readonly capabilityComposition: ChatCapabilityComposition | null
}

interface NativeDeploymentPreparationFields extends NativeDeploymentVerification {
  /** Omitted only by legacy runtime integrations; decoders materialize schema 1. */
  readonly schema?: 1
  readonly targetRevision?: string
  readonly summary?: NativeDeploymentSummary
  readonly preview?: NativeDeploymentPreview | null
  readonly capabilityApprovalRequest?: ChatCapabilityApprovalRequest | null
  readonly missingReasons?: readonly string[]
}

export type NativeDeploymentPreparationResult =
  | (NativeDeploymentPreparationFields & { readonly state: 'prepared'; readonly targetRevision: string;
    readonly summary: NativeDeploymentSummary & { readonly ready: true }; readonly preview: NativeDeploymentPreview | null })
  | (NativeDeploymentPreparationFields & { readonly state: 'blocked'; readonly missingReasons: readonly string[] })

export type NativeDeploymentApplyResult = NativeDeploymentVerification & { readonly schema?: 1 } & (
  | { readonly state: 'verified'; readonly backupId: string; readonly missingReasons: readonly [] }
  | { readonly state: 'pending_reload'; readonly backupId: string; readonly missingReasons: readonly string[] }
  | { readonly state: 'blocked' | 'conflict' | 'unknown'; readonly backupId?: string; readonly missingReasons: readonly string[] }
)

export interface NativeDeploymentReconciliationResult extends NativeDeploymentVerification {
  readonly schema?: 1
  readonly missingReasons: readonly string[]
  readonly presetBindings: readonly NativeDeploymentPresetBinding[]
  readonly capabilityComposition?: ChatCapabilityComposition | null
}

/** Public management response omits session definitions and exposes only checked preset identities. */
export interface PublicNativeDeploymentReconciliationResult {
  readonly verified: boolean
  readonly missingReasons: readonly string[]
  readonly verificationScope: string | null
  readonly credentialValueIdentityVerified: false
  readonly unverified: readonly string[]
  readonly presets: readonly { readonly agentPreset: string }[]
}

export function parsePublicNativeDeploymentReconciliationResult(value: unknown): PublicNativeDeploymentReconciliationResult | null {
  if (!record(value) || typeof value.verified !== 'boolean' || value.schema !== undefined && value.schema !== 1
    || !Object.keys(value).every(key => ['schema', 'verified', 'missingReasons', 'verificationScope', 'credentialValueIdentityVerified', 'unverified', 'presets'].includes(key))
    || !Array.isArray(value.missingReasons) || value.missingReasons.length > 128
    || !value.missingReasons.every(reason => typeof reason === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(reason))
    || value.verificationScope !== null && (typeof value.verificationScope !== 'string' || value.verificationScope.length > 160)
    || value.credentialValueIdentityVerified !== false || !Array.isArray(value.unverified) || value.unverified.length > 32
    || !value.unverified.every(reason => typeof reason === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(reason))
    || !Array.isArray(value.presets) || value.presets.length > 256
    || !value.presets.every(preset => record(preset) && Object.keys(preset).length === 1 && isChatPlanReference(preset.agentPreset))
    || value.verified && (value.missingReasons.length > 0 || value.presets.length === 0)) return null
  return { verified: value.verified, missingReasons: value.missingReasons as string[], verificationScope: value.verificationScope as string | null,
    credentialValueIdentityVerified: false, unverified: value.unverified as string[],
    presets: value.presets.map(preset => ({ agentPreset: (preset as { agentPreset: string }).agentPreset })) }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 1_024
    && value.every(item => typeof item === 'string' && item.length <= 4_096)
}

function jsonObject(value: unknown): value is JsonObject {
  if (!record(value)) return false
  const pending: unknown[] = [value]
  let nodes = 0
  while (pending.length) {
    if (++nodes > 50_000) return false
    const item = pending.pop()
    if (item === null || typeof item === 'string' || typeof item === 'boolean'
      || typeof item === 'number' && Number.isFinite(item)) continue
    if (Array.isArray(item)) pending.push(...item)
    else if (record(item)) pending.push(...Object.values(item))
    else return false
  }
  return true
}

function composition(value: unknown): value is ChatCapabilityComposition {
  return record(value) && value.schema === 1 && isChatPlanCapabilitySelection(value.source)
    && typeof value.revision === 'string' && NATIVE_REVISION_PATTERN.test(value.revision)
    && value.externalToolAuthorizationVerified === false
}

function approvalRequest(value: unknown): value is ChatCapabilityApprovalRequest {
  if (!record(value) || value.schema !== 1 || !isChatPlanCapabilitySelection(value.source)
    || typeof value.compositionRevision !== 'string' || !NATIVE_REVISION_PATTERN.test(value.compositionRevision)
    || !record(value.target)) return false
  const target = value.target
  return [target.profilePath, target.credentialsPath].every(path => typeof path === 'string' && path.length <= 4_096
    && /^(?:\/|[A-Za-z]:[\\/])/.test(path) && !/[\u0000-\u001f\u007f]/.test(path))
    && strings(target.layerPaths) && target.layerPaths.length <= 16
    && target.schemaVersion === '0.2.1-rc.2'
}

function summary(value: unknown): NativeDeploymentSummary | null {
  if (!record(value) || typeof value.ready !== 'boolean' || !strings(value.missingReasons)
    || value.limitations !== undefined && !strings(value.limitations)
    || value.sourceRefs !== undefined && !strings(value.sourceRefs)
    || value.capabilityComposition != null && !composition(value.capabilityComposition)) return null
  if (value.selectablePresets !== undefined && (!Array.isArray(value.selectablePresets)
    || !value.selectablePresets.every(preset => record(preset) && isChatPlanReference(preset.agentPreset)
      && ['group', 'private'].includes(String(preset.conversationKind)) && typeof preset.externalProvider === 'string'
      && typeof preset.model === 'string' && typeof preset.contextWindow === 'number'
      && Number.isSafeInteger(preset.contextWindow) && preset.contextWindow > 0))) return null
  return { ready: value.ready, missingReasons: value.missingReasons,
    ...(value.limitations === undefined ? {} : { limitations: value.limitations as readonly string[] }),
    ...(value.sourceRefs === undefined ? {} : { sourceRefs: value.sourceRefs as readonly string[] }),
    ...(value.selectablePresets === undefined ? {} : { selectablePresets: value.selectablePresets as readonly NativeDeploymentSelectablePreset[] }),
    ...(value.capabilityComposition === undefined ? {} : { capabilityComposition: value.capabilityComposition as ChatCapabilityComposition | null }) }
}

function preview(value: unknown): NativeDeploymentPreview | null | undefined {
  if (value === null) return null
  if (!record(value) || !Object.hasOwn(value, 'capabilityComposition')
    || value.capabilityComposition !== null && !composition(value.capabilityComposition)
    || value.providerUpdates !== undefined && !jsonObject(value.providerUpdates)
    || value.credentialRefs !== undefined && !strings(value.credentialRefs)
    || value.presets !== undefined && (!Array.isArray(value.presets) || !value.presets.every(preset => record(preset)
      && typeof preset.entryId === 'string' && jsonObject(preset.config)))) return undefined
  return { capabilityComposition: value.capabilityComposition as ChatCapabilityComposition | null,
    ...(value.providerUpdates === undefined ? {} : { providerUpdates: value.providerUpdates as JsonObject }),
    ...(value.credentialRefs === undefined ? {} : { credentialRefs: value.credentialRefs as readonly string[] }),
    ...(value.presets === undefined ? {} : { presets: value.presets as readonly { readonly entryId: string; readonly config: JsonObject }[] }) }
}

function verification(value: Record<string, unknown>): NativeDeploymentVerification | null {
  if (value.verificationScope !== undefined && typeof value.verificationScope !== 'string'
    || value.credentialValueIdentityVerified !== undefined && value.credentialValueIdentityVerified !== false
    || value.unverified !== undefined && !strings(value.unverified)) return null
  return { ...(value.verificationScope === undefined ? {} : { verificationScope: value.verificationScope as string }),
    ...(value.credentialValueIdentityVerified === undefined ? {} : { credentialValueIdentityVerified: false as const }),
    ...(value.unverified === undefined ? {} : { unverified: value.unverified as readonly string[] }) }
}

/** Validate untrusted or legacy integration output once, before serving it to a client. */
export function parseNativeDeploymentPreparationResult(value: unknown): NativeDeploymentPreparationResult | null {
  if (!record(value) || value.schema !== undefined && value.schema !== 1
    || !['prepared', 'blocked'].includes(String(value.state))
    || value.targetRevision !== undefined && (typeof value.targetRevision !== 'string' || !NATIVE_REVISION_PATTERN.test(value.targetRevision))
    || value.missingReasons !== undefined && !strings(value.missingReasons)
    || value.capabilityApprovalRequest != null && !approvalRequest(value.capabilityApprovalRequest)) return null
  const details = verification(value)
  const parsedSummary = value.summary === undefined ? undefined : summary(value.summary)
  const parsedPreview = value.preview === undefined ? undefined : preview(value.preview)
  if (details === null || parsedSummary === null || value.preview !== undefined && parsedPreview === undefined) return null
  const fields = { schema: 1 as const, ...details,
    ...(value.targetRevision === undefined ? {} : { targetRevision: value.targetRevision as string }),
    ...(parsedSummary === undefined ? {} : { summary: parsedSummary }),
    ...(value.preview === undefined ? {} : { preview: parsedPreview! }),
    ...(value.capabilityApprovalRequest === undefined ? {} : { capabilityApprovalRequest: value.capabilityApprovalRequest as ChatCapabilityApprovalRequest | null }),
    ...(value.missingReasons === undefined ? {} : { missingReasons: value.missingReasons as readonly string[] }) }
  if (value.state === 'prepared') {
    if (typeof value.targetRevision !== 'string' || !parsedSummary?.ready || parsedPreview === undefined) return null
    return { ...fields, state: 'prepared', targetRevision: value.targetRevision,
      summary: { ...parsedSummary, ready: true }, preview: parsedPreview }
  }
  if (parsedSummary?.ready === true || value.missingReasons === undefined && parsedSummary === undefined) return null
  return { ...fields, state: 'blocked', missingReasons: fields.missingReasons ?? parsedSummary!.missingReasons }
}

export function parseNativeDeploymentApplyResult(value: unknown): NativeDeploymentApplyResult | null {
  if (!record(value) || value.schema !== undefined && value.schema !== 1
    || !['blocked', 'conflict', 'unknown', 'verified', 'pending_reload'].includes(String(value.state))
    || !strings(value.missingReasons) || value.backupId !== undefined && !isChatPlanReference(value.backupId)) return null
  const details = verification(value)
  if (details === null || value.state === 'verified' && (value.missingReasons.length !== 0 || typeof value.backupId !== 'string')
    || value.state === 'pending_reload' && typeof value.backupId !== 'string') return null
  if (value.state === 'verified') return { schema: 1, ...details, state: 'verified', backupId: value.backupId as string, missingReasons: [] }
  if (value.state === 'pending_reload') return { schema: 1, ...details, state: 'pending_reload', backupId: value.backupId as string,
    missingReasons: value.missingReasons }
  return { schema: 1, ...details, state: value.state as 'blocked' | 'conflict' | 'unknown', missingReasons: value.missingReasons,
    ...(value.backupId === undefined ? {} : { backupId: value.backupId as string }) }
}

export function parseNativeDeploymentReconciliationResult(value: unknown): NativeDeploymentReconciliationResult | null {
  if (!record(value) || value.schema !== undefined && value.schema !== 1 || !strings(value.missingReasons)
    || !Array.isArray(value.presetBindings) || value.presetBindings.length > 256
    || !value.presetBindings.every(binding => record(binding) && isChatPlanReference(binding.agentPreset)
      && isChatSessionDefinition(binding.definition)
      && (binding.externalProvider === undefined || typeof binding.externalProvider === 'string')
      && (binding.conversationKind === undefined || ['group', 'private'].includes(String(binding.conversationKind))))
    || value.capabilityComposition != null && !composition(value.capabilityComposition)) return null
  const details = verification(value)
  if (details === null) return null
  return { schema: 1, ...details, missingReasons: value.missingReasons,
    presetBindings: value.presetBindings as readonly NativeDeploymentPresetBinding[],
    ...(value.capabilityComposition === undefined ? {} : { capabilityComposition: value.capabilityComposition as ChatCapabilityComposition | null }) }
}
