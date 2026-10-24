import type { NativeAdapterConfiguration } from './adapter-configuration.ts'
import type { ChatPlanCatalog, ChatPersona } from './chat-plans.ts'
import type { NativeModelProvider } from './model-providers.ts'
import type { DshDeploymentModelSettings } from '../adapters/dsh-deployment.ts'
import type { DshPresetBinding } from '../adapters/dsh-jsonrpc.ts'

export interface NativeChatAuthorization {
  readonly version: string
  readonly grants: readonly {
    readonly conversationId: string
    readonly submitUses: number
    readonly sendUses: number
    readonly expiresAt: number | null
  }[]
}

export interface NativeChatAccess {
  readonly allow: readonly string[]
  readonly deny: readonly string[]
  readonly owner: string | null
}

export interface NativeChatConfiguration {
  readonly revisions: Readonly<Record<string, string>>
  readonly catalog: ChatPlanCatalog
  readonly personas: readonly ChatPersona[]
  readonly access: NativeChatAccess
  readonly adapters: NativeAdapterConfiguration
  readonly providers: readonly NativeModelProvider[]
  readonly authorization: NativeChatAuthorization
  readonly deployment: NativeChatDeploymentConfiguration
}

export interface NativeChatDeploymentConfiguration {
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
  target: null, modelSettings: null, namespace: 'qqaf'
})

export interface NativeChatDeploymentRuntime {
  prepare(configuration: NativeChatConfiguration): Promise<unknown>
  reconcile(configuration: NativeChatConfiguration): Promise<{
    readonly missingReasons: readonly string[]
    readonly presetBindings: readonly DshPresetBinding[]
    readonly verificationScope?: string
    readonly credentialValueIdentityVerified?: false
    readonly unverified?: readonly string[]
  }>
  apply(configuration: NativeChatConfiguration, signal: AbortSignal, targetRevision?: string): Promise<unknown>
}

export const DEFAULT_NATIVE_CHAT_AUTHORIZATION: NativeChatAuthorization = Object.freeze({
  version: '1', grants: Object.freeze([])
})

export function validateNativeChatAuthorization(input: unknown): NativeChatAuthorization {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  const invalid = (): never => { throw new TypeError('Invalid native chat authorization') }
  if (!record(input) || Object.keys(input).length !== 2
    || typeof input.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.version)
    || !Array.isArray(input.grants) || input.grants.length > 1_024) return invalid()
  const scopes = new Set<string>()
  const grants = input.grants.map(value => {
    if (!record(value) || Object.keys(value).length !== 4
      || typeof value.conversationId !== 'string' || !/^(group|private):[1-9][0-9]{0,15}$/.test(value.conversationId)
      || !Number.isSafeInteger(Number(value.conversationId.split(':')[1])) || scopes.has(value.conversationId)
      || ![value.submitUses, value.sendUses].every(amount => typeof amount === 'number'
        && Number.isSafeInteger(amount) && amount >= 0 && amount <= 1_000_000)
      || value.expiresAt !== null && (typeof value.expiresAt !== 'number'
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0)) return invalid()
    scopes.add(value.conversationId)
    return Object.freeze({ conversationId: value.conversationId,
      submitUses: value.submitUses as number, sendUses: value.sendUses as number,
      expiresAt: value.expiresAt as number | null })
  })
  return Object.freeze({ version: input.version, grants: Object.freeze(grants) })
}
