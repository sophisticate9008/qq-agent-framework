/** Revision-set schema shared by native configuration consumers and browser clients. */
export const NATIVE_CONFIGURATION_REVISION_SCHEMA = 1 as const

export const NATIVE_CONFIGURATION_REVISION_KEYS = Object.freeze([
  'plans', 'personas', 'access', 'adapters', 'providers', 'authorization', 'deployment', 'execution'
] as const)

export type NativeConfigurationRevisionKey = typeof NATIVE_CONFIGURATION_REVISION_KEYS[number]
export type NativeConfigurationRevisions = Readonly<Record<NativeConfigurationRevisionKey, string>>

export const NATIVE_REVISION_PATTERN = /^[a-f0-9]{64}$/

export function isNativeConfigurationRevisions(value: unknown): value is NativeConfigurationRevisions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = value as Record<string, unknown>
  return Object.keys(entries).length === NATIVE_CONFIGURATION_REVISION_KEYS.length
    && NATIVE_CONFIGURATION_REVISION_KEYS.every(key => Object.hasOwn(entries, key)
      && typeof entries[key] === 'string' && NATIVE_REVISION_PATTERN.test(entries[key]))
}
