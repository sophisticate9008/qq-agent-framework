export interface NativeRuntimeFeatureProjection {
  readonly id: string
  readonly version: string
  readonly status: 'installing' | 'active' | 'stopping' | 'stopped' | 'failed'
  readonly declared: true
  readonly installed: boolean
  readonly ready: boolean
  readonly authorized: null
  readonly capabilities: readonly string[]
  readonly subscriptions: readonly string[]
}
export interface NativeRuntimeCapabilityProjection {
  readonly id: string
  readonly declared: true
  readonly installed: boolean
  readonly ready: boolean
  readonly authorized: null
}
export interface NativeRuntimeProjection {
  readonly schema: 1
  readonly source: 'native-chat'
  readonly coverage: 'current-native-host'
  readonly state: 'not-connected' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  readonly chatReady: boolean
  readonly missingReasons: readonly string[]
  readonly features: readonly NativeRuntimeFeatureProjection[]
  readonly capabilities: readonly NativeRuntimeCapabilityProjection[]
  readonly editableResources: readonly { readonly id: string; readonly editable: true }[]
  readonly featuresLimited: boolean
  readonly capabilitiesLimited: boolean
  readonly authorizationEvaluated: false
}
const resourceIds = ['chat-plans', 'personas', 'model-settings', 'access-policy'] as const
export const NATIVE_EDITABLE_RESOURCE_IDS = Object.freeze(resourceIds)
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function name(value: unknown): value is string { return typeof value === 'string' && value.length <= 100 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value) }
function names(value: unknown, limit: number): value is string[] { return Array.isArray(value) && value.length <= limit && value.every(name) && new Set(value).size === value.length }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
export function parseNativeRuntimeProjection(input: unknown): NativeRuntimeProjection | null {
  if (!record(input) || !exact(input, ['schema', 'source', 'coverage', 'state', 'chatReady', 'missingReasons', 'features', 'capabilities', 'editableResources', 'featuresLimited', 'capabilitiesLimited', 'authorizationEvaluated'])
    || input.schema !== 1 || input.source !== 'native-chat' || input.coverage !== 'current-native-host'
    || !['not-connected', 'stopped', 'starting', 'running', 'stopping', 'error'].includes(String(input.state))
    || typeof input.chatReady !== 'boolean' || input.chatReady && input.state !== 'running'
    || !Array.isArray(input.missingReasons) || input.missingReasons.length > 256 || !input.missingReasons.every(reason => typeof reason === 'string' && reason.length > 0 && reason.length <= 256)
    || !Array.isArray(input.features) || input.features.length > 256 || !Array.isArray(input.capabilities) || input.capabilities.length > 512
    || !Array.isArray(input.editableResources) || input.editableResources.length !== 4
    || typeof input.featuresLimited !== 'boolean' || typeof input.capabilitiesLimited !== 'boolean' || input.authorizationEvaluated !== false) return null
  const features: NativeRuntimeFeatureProjection[] = []
  const seen = new Set<string>()
  for (const feature of input.features) {
    if (!record(feature) || !exact(feature, ['id', 'version', 'status', 'declared', 'installed', 'ready', 'authorized', 'capabilities', 'subscriptions'])
      || !name(feature.id) || seen.has(feature.id) || typeof feature.version !== 'string' || feature.version.length > 100 || feature.version.length === 0
      || !['installing', 'active', 'stopping', 'stopped', 'failed'].includes(String(feature.status)) || feature.declared !== true
      || feature.installed !== (feature.status === 'active') || feature.ready !== (feature.installed && input.chatReady)
      || feature.authorized !== null || !names(feature.capabilities, 128) || !names(feature.subscriptions, 128)) return null
    seen.add(feature.id)
    features.push(feature as unknown as NativeRuntimeFeatureProjection)
  }
  const capabilities: NativeRuntimeCapabilityProjection[] = []
  seen.clear()
  for (const capability of input.capabilities) {
    if (!record(capability) || !exact(capability, ['id', 'declared', 'installed', 'ready', 'authorized'])
      || !name(capability.id) || seen.has(capability.id) || capability.declared !== true || typeof capability.installed !== 'boolean'
      || capability.ready !== (capability.installed && input.chatReady) || capability.authorized !== null
      || !features.some(feature => feature.capabilities.includes(String(capability.id)))
      || capability.installed !== features.some(feature => feature.installed && feature.capabilities.includes(String(capability.id)))) return null
    seen.add(capability.id)
    capabilities.push(capability as unknown as NativeRuntimeCapabilityProjection)
  }
  for (const [index, resource] of input.editableResources.entries()) if (!record(resource)
    || !exact(resource, ['id', 'editable']) || resource.id !== resourceIds[index] || resource.editable !== true) return null
  return { schema: 1, source: 'native-chat', coverage: 'current-native-host', state: input.state as NativeRuntimeProjection['state'],
    chatReady: input.chatReady, missingReasons: input.missingReasons as string[], features, capabilities,
    editableResources: input.editableResources as NativeRuntimeProjection['editableResources'],
    featuresLimited: input.featuresLimited, capabilitiesLimited: input.capabilitiesLimited, authorizationEvaluated: false }
}
