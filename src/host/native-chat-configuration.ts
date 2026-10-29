import type { NativeAdapterConfiguration } from './adapter-configuration.ts'
import type { ChatPlanCatalog, ChatPersona } from './chat-plans.ts'
import type { NativeModelProvider } from './model-providers.ts'
import type { DshDeploymentModelSettings } from '../contracts/dsh-model-settings.ts'
import type { NativeDeploymentPreparationResult, NativeDeploymentReconciliationResult, NativeDeploymentApplyResult } from '../contracts/native-deployment.ts'
import type { NativeExecutionPolicy } from './native-execution.ts'
import type { ChatCapabilityCompositionApproval } from './chat-capabilities.ts'

export interface NativeChatAuthorization {
  readonly version: string
  readonly mode?: 'whitelist' | 'counted'
  readonly forwardAllow?: readonly string[]
  readonly grants: readonly {
    readonly conversationId: string
    readonly submitUses: number
    readonly sendUses: number
    readonly forwardUses?: number
    readonly cancelUses?: number
    readonly toolDelegationUses?: number
    readonly expiresAt: number | null
  }[]
}

export type { NativeChatAccess } from '../contracts/native-access.ts'
import type { NativeChatAccess } from '../contracts/native-access.ts'

export interface NativeChatConfiguration {
  readonly revisions: Readonly<Record<string, string>>
  readonly catalog: ChatPlanCatalog
  readonly personas: readonly ChatPersona[]
  readonly access: NativeChatAccess
  readonly adapters: NativeAdapterConfiguration
  readonly providers: readonly NativeModelProvider[]
  readonly authorization: NativeChatAuthorization
  readonly authorizationSource?: 'stored' | 'new-default' | 'missing-with-history'
  readonly deployment: NativeChatDeploymentConfiguration
  readonly execution: NativeExecutionPolicy
}

export interface NativeChatDeploymentConfiguration {
  readonly capabilityApproval?: ChatCapabilityCompositionApproval | null
  readonly target: {
    readonly profilePath: string
    readonly credentialsPath: string
    readonly layerPaths?: readonly string[]
    readonly schemaVersion: '0.2.1-rc.2'
  } | null
  readonly modelSettings: DshDeploymentModelSettings | null
  readonly namespace: string
}

export const DEFAULT_NATIVE_CHAT_DEPLOYMENT: NativeChatDeploymentConfiguration = Object.freeze({
  target: null, modelSettings: null, namespace: 'qqbf'
})

export interface NativeChatDeploymentRuntime {
  prepare(configuration: NativeChatConfiguration): Promise<NativeDeploymentPreparationResult>
  reconcile(configuration: NativeChatConfiguration): Promise<NativeDeploymentReconciliationResult>
  apply(configuration: NativeChatConfiguration, signal: AbortSignal, targetRevision?: string): Promise<NativeDeploymentApplyResult>
}

/** Untrusted integration boundary; outputs are decoded before use. */
export interface NativeChatDeploymentRuntimeInput {
  prepare(configuration: NativeChatConfiguration): Promise<unknown>
  reconcile(configuration: NativeChatConfiguration): Promise<unknown>
  apply(configuration: NativeChatConfiguration, signal: AbortSignal, targetRevision?: string): Promise<unknown>
}

export const DEFAULT_NATIVE_CHAT_AUTHORIZATION: NativeChatAuthorization = Object.freeze({
  version: 'whitelist-1', mode: 'whitelist', grants: Object.freeze([])
})

export const LEGACY_NATIVE_CHAT_AUTHORIZATION: NativeChatAuthorization = Object.freeze({
  version: '1', grants: Object.freeze([])
})

export function validateNativeChatAuthorization(input: unknown): NativeChatAuthorization {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  const invalid = (): never => { throw new TypeError('Invalid native chat authorization') }
  if (!record(input) || Object.keys(input).length !== 2 + Number(Object.hasOwn(input, 'mode')) + Number(Object.hasOwn(input, 'forwardAllow'))
    || !Object.keys(input).every(key => ['version', 'mode', 'grants', 'forwardAllow'].includes(key))
    || Object.hasOwn(input, 'mode') && input.mode !== 'whitelist' && input.mode !== 'counted'
    || typeof input.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.version)
    || !Array.isArray(input.grants) || input.grants.length > 1_024
    || input.mode === 'whitelist' && input.grants.length !== 0) return invalid()
  if (Object.hasOwn(input, 'forwardAllow') && (input.mode !== 'whitelist' || !Array.isArray(input.forwardAllow)
    || input.forwardAllow.length > 1024 || new Set(input.forwardAllow).size !== input.forwardAllow.length
    || !input.forwardAllow.every(scope => typeof scope === 'string' && /^(group|private):[1-9][0-9]{0,15}$/.test(scope)
      && Number.isSafeInteger(Number(scope.split(':')[1]))))) return invalid()
  const scopes = new Set<string>()
  const grants = input.grants.map(value => {
    if (!record(value) || Object.keys(value).length !== 4 + Number(Object.hasOwn(value, 'forwardUses')) + Number(Object.hasOwn(value, 'cancelUses')) + Number(Object.hasOwn(value, 'toolDelegationUses'))
      || !Object.keys(value).every(key => ['conversationId', 'submitUses', 'sendUses', 'expiresAt', 'forwardUses', 'cancelUses', 'toolDelegationUses'].includes(key))
      || typeof value.conversationId !== 'string' || !/^(group|private):[1-9][0-9]{0,15}$/.test(value.conversationId)
      || !Number.isSafeInteger(Number(value.conversationId.split(':')[1])) || scopes.has(value.conversationId)
      || ![value.submitUses, value.sendUses].every(amount => typeof amount === 'number'
        && Number.isSafeInteger(amount) && amount >= 0 && amount <= 1_000_000)
      || Object.hasOwn(value, 'forwardUses') && (typeof value.forwardUses !== 'number'
        || !Number.isSafeInteger(value.forwardUses) || value.forwardUses < 0 || value.forwardUses > 1_000_000)
      || Object.hasOwn(value, 'cancelUses') && (typeof value.cancelUses !== 'number'
        || !Number.isSafeInteger(value.cancelUses) || value.cancelUses < 0 || value.cancelUses > 1_000_000)
      || Object.hasOwn(value, 'toolDelegationUses') && (typeof value.toolDelegationUses !== 'number'
        || !Number.isSafeInteger(value.toolDelegationUses) || value.toolDelegationUses < 0 || value.toolDelegationUses > 1_000_000)
      || value.expiresAt !== null && (typeof value.expiresAt !== 'number'
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0)) return invalid()
    scopes.add(value.conversationId)
    return Object.freeze({ conversationId: value.conversationId,
      submitUses: value.submitUses as number, sendUses: value.sendUses as number,
      ...(Object.hasOwn(value, 'forwardUses') ? { forwardUses: value.forwardUses as number } : {}),
      ...(Object.hasOwn(value, 'cancelUses') ? { cancelUses: value.cancelUses as number } : {}),
      ...(Object.hasOwn(value, 'toolDelegationUses') ? { toolDelegationUses: value.toolDelegationUses as number } : {}),
      expiresAt: value.expiresAt as number | null })
  })
  return Object.freeze({ version: input.version,
    ...(Object.hasOwn(input, 'forwardAllow') ? { forwardAllow: Object.freeze([...(input.forwardAllow as string[])]) } : {}),
    ...(Object.hasOwn(input, 'mode') ? { mode: input.mode as 'whitelist' | 'counted' } : {}), grants: Object.freeze(grants) })
}
