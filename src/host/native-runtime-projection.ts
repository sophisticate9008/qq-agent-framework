import { extensionMetadata, type ExtensionMetadata } from '../contracts/extension-metadata.ts'
import { snapshot } from '../core/values.ts'
import { NATIVE_EDITABLE_RESOURCE_IDS, type NativeRuntimeProjection, type NativeRuntimeFeatureProjection } from '../contracts/native-runtime-projection.ts'
export interface NativeRuntimeProjectionSource {
  status(): Promise<{ readonly state: NativeRuntimeProjection['state']; readonly chatReady: boolean; readonly missingReasons: readonly string[] }>
  host(): { readonly engine: { describe(): { readonly features: readonly (ExtensionMetadata & {
    readonly id: string; readonly version: string; readonly status: NativeRuntimeFeatureProjection['status'];
    readonly capabilities: readonly string[]; readonly subscriptions: readonly string[]
  })[] } } } | undefined
}

/** Describe installation and readiness without evaluating a conversation's policy or creating state. */
export async function readNativeRuntimeProjection(runtime?: NativeRuntimeProjectionSource): Promise<NativeRuntimeProjection> {
  const status = runtime ? await runtime.status() : undefined
  const described = runtime?.host()?.engine.describe().features ?? []
  const features: NativeRuntimeFeatureProjection[] = []
  let bytes = 0
  for (const feature of described.slice(0, 256)) {
    const projected: NativeRuntimeFeatureProjection = { id: feature.id, version: feature.version, ...extensionMetadata(feature), status: feature.status,
      declared: true, installed: feature.status === 'active', ready: feature.status === 'active' && status?.chatReady === true,
      authorized: null, capabilities: [...feature.capabilities], subscriptions: [...feature.subscriptions] }
    const size = Buffer.byteLength(JSON.stringify(projected))
    if (bytes + size > 64 * 1024) break
    bytes += size
    features.push(projected)
  }
  const featuresLimited = described.length > features.length
  const capabilities = new Map<string, NativeRuntimeProjection['capabilities'][number]>()
  for (const feature of features) for (const id of feature.capabilities) {
    const previous = capabilities.get(id)
    capabilities.set(id, { id, declared: true, installed: feature.installed || previous?.installed === true,
      ready: feature.ready || previous?.ready === true, authorized: null })
  }
  return snapshot<NativeRuntimeProjection>({ schema: 1, source: 'native-chat', coverage: 'current-native-host', state: status?.state ?? 'not-connected',
    chatReady: status?.chatReady ?? false, missingReasons: status?.missingReasons ?? ['native_runtime_not_connected'], features,
    capabilities: [...capabilities.values()].slice(0, 512), editableResources: NATIVE_EDITABLE_RESOURCE_IDS.map(id => ({ id, editable: true })),
    featuresLimited, capabilitiesLimited: featuresLimited || capabilities.size > 512, authorizationEvaluated: false })
}

/** Compatibility response; editable resource declarations remain separate in the shared projection. */
export function nativeRuntimeFeatureResponse(projection: NativeRuntimeProjection) {
  const installed = projection.features.some(feature => feature.id === 'agent-relay' && feature.installed)
  const capabilities: { id: string; declared: boolean; installed: boolean }[] = NATIVE_EDITABLE_RESOURCE_IDS.map(id => ({ id, declared: true, installed }))
  const seen = new Set<string>(NATIVE_EDITABLE_RESOURCE_IDS)
  for (const capability of projection.capabilities) if (!seen.has(capability.id)) {
    capabilities.push({ id: capability.id, declared: true, installed: capability.installed })
    seen.add(capability.id)
  }
  return { runtimeConnected: projection.chatReady, editableResources: true, capabilities: capabilities.slice(0, 512),
    features: projection.features.map(feature => ({ id: feature.id, version: feature.version, status: feature.status, declared: feature.declared, installed: feature.installed, capabilities: feature.capabilities, ...extensionMetadata(feature), ...(feature.displayName ? { name: feature.displayName } : {}) })),
    featuresLimited: projection.featuresLimited, capabilitiesLimited: projection.capabilitiesLimited || capabilities.length > 512,
    authorizationEvaluated: false, projection }
}
