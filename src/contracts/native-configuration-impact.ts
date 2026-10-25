import type { NativeConfigurationRevisionKey } from './native-revisions.ts'
import type { NativeDeploymentPresetBinding } from './native-deployment.ts'

export type NativeConfigurationDependency = 'definition' | 'persona-name' | 'provider' | 'adapters'
  | 'deployment' | 'bindings' | 'owner' | 'access' | 'authorization' | 'execution'

export interface NativeConfigurationImpact {
  readonly schema: 1
  readonly state: 'verified' | 'unavailable'
  readonly action: 'none' | 'migrate' | 'restart'
  readonly canContinue: boolean
  readonly sessionMigrationRequired: boolean
  readonly immediatePolicyCheck: boolean
  readonly changedDependencies: readonly NativeConfigurationDependency[]
  readonly changedRevisions: readonly NativeConfigurationRevisionKey[]
  readonly ignoredCatalogRevisions: readonly NativeConfigurationRevisionKey[]
  readonly withdrawnConversations: readonly string[]
  readonly bindingsCompared: boolean
  readonly fingerprints: { readonly previous: string | null; readonly next: string | null }
  readonly reasons: readonly string[]
}

export interface NativeConfigurationImpactOptions {
  /** Supply both snapshots when the caller has independently reconciled live deployment bindings. */
  readonly previousBindings?: readonly NativeDeploymentPresetBinding[]
  readonly nextBindings?: readonly NativeDeploymentPresetBinding[]
}


import { NATIVE_CONFIGURATION_REVISION_KEYS, NATIVE_REVISION_PATTERN } from './native-revisions.ts'
import { isNativeAccessScope } from './native-access.ts'

const dependencies: readonly NativeConfigurationDependency[] = ['definition', 'persona-name', 'provider', 'adapters',
  'deployment', 'bindings', 'owner', 'access', 'authorization', 'execution']

export function parseNativeConfigurationImpact(input: unknown): NativeConfigurationImpact | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const oneOf = (entry: unknown, allowed: readonly string[]): entry is string => typeof entry === 'string' && allowed.includes(entry)
  const names = (entry: unknown, allowed: readonly string[]): entry is readonly string[] => Array.isArray(entry)
    && entry.length <= allowed.length && new Set(entry).size === entry.length && entry.every(name => oneOf(name, allowed))
  if (value.schema !== 1 || !oneOf(value.state, ['verified', 'unavailable']) || !oneOf(value.action, ['none', 'migrate', 'restart'])
    || typeof value.canContinue !== 'boolean' || typeof value.sessionMigrationRequired !== 'boolean'
    || typeof value.immediatePolicyCheck !== 'boolean' || typeof value.bindingsCompared !== 'boolean'
    || !names(value.changedDependencies, dependencies) || !names(value.changedRevisions, NATIVE_CONFIGURATION_REVISION_KEYS)
    || !names(value.ignoredCatalogRevisions, ['plans', 'personas', 'providers'])
    || !value.ignoredCatalogRevisions.every(key => (value.changedRevisions as readonly string[]).includes(key))
    || !Array.isArray(value.withdrawnConversations) || value.withdrawnConversations.length > 2_048
    || !value.withdrawnConversations.every(scope => isNativeAccessScope(scope))
    || !Array.isArray(value.reasons) || value.reasons.length > 64
    || !value.reasons.every(reason => typeof reason === 'string' && reason.length <= 256)
    || value.fingerprints === null || typeof value.fingerprints !== 'object' || Array.isArray(value.fingerprints)) return null
  const fingerprints = value.fingerprints as Record<string, unknown>
  const hash = (entry: unknown) => typeof entry === 'string' && NATIVE_REVISION_PATTERN.test(entry)
  if (![fingerprints.previous, fingerprints.next].every(entry => entry === null || hash(entry))) return null
  if (value.state === 'unavailable' && (value.action !== 'restart' || value.canContinue || !value.immediatePolicyCheck)
    || value.state === 'verified' && (value.canContinue !== (value.action === 'none') || !hash(fingerprints.previous) || !hash(fingerprints.next))
    || value.action === 'migrate' && !value.sessionMigrationRequired) return null
  return { schema: 1, state: value.state as NativeConfigurationImpact['state'], action: value.action as NativeConfigurationImpact['action'],
    canContinue: value.canContinue, sessionMigrationRequired: value.sessionMigrationRequired, immediatePolicyCheck: value.immediatePolicyCheck,
    changedDependencies: value.changedDependencies as readonly NativeConfigurationDependency[],
    changedRevisions: value.changedRevisions as readonly NativeConfigurationRevisionKey[],
    ignoredCatalogRevisions: value.ignoredCatalogRevisions as readonly NativeConfigurationRevisionKey[],
    withdrawnConversations: value.withdrawnConversations as readonly string[], bindingsCompared: value.bindingsCompared,
    fingerprints: { previous: fingerprints.previous as string | null, next: fingerprints.next as string | null },
    reasons: value.reasons as readonly string[] }
}
