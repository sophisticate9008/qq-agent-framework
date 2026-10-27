/** Product origin and transport are independent of the DSH registration scope. */
export interface NativeToolRegistrationSource {
  readonly origin: 'framework-builtin' | 'dsh-builtin' | 'extension'
  readonly ownerId: string
  readonly ownerName: string
  readonly transport: 'native' | 'mcp'
}
/** Read-only registration inventory. Registration and observed session visibility are independent. */
export interface NativeToolInventoryModule {
  readonly name: string
  readonly kind: 'package' | 'local' | 'builtin' | 'unknown'
  readonly state: 'loaded' | 'configured'
}
export interface NativeToolInventorySource {
  readonly id: string
  readonly kind: 'dsh-global' | 'dsh-preset' | 'framework'
  readonly label: string
  readonly agentPreset: string | null
  readonly modules: readonly NativeToolInventoryModule[]
}
export interface NativeToolInventoryItem {
  readonly registrationSource?: NativeToolRegistrationSource
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly sourceId: string
  readonly registration: 'registered' | 'declared'
  readonly loadedInSession: boolean | null
}
export interface NativeToolInventory {
  readonly schema: 1
  readonly state: 'available' | 'partial' | 'not-connected' | 'unavailable'
  readonly items: readonly NativeToolInventoryItem[]
  readonly sources: readonly NativeToolInventorySource[]
  readonly limited: boolean
  readonly missingReasons: readonly string[]
  readonly externalToolAuthorizationVerified: false
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid tool inventory')
  return value as Record<string, unknown>
}
function text(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}
function requireValue(value: unknown): asserts value { if (!value) throw new TypeError('Invalid tool inventory') }
export function parseNativeToolInventory(input: unknown): NativeToolInventory {
  const value = record(input)
  requireValue(value.schema === 1 && ['available', 'partial', 'not-connected', 'unavailable'].includes(String(value.state))
    && Array.isArray(value.items) && value.items.length <= 1024 && Array.isArray(value.sources) && value.sources.length <= 129
    && typeof value.limited === 'boolean' && value.externalToolAuthorizationVerified === false
    && Array.isArray(value.missingReasons) && value.missingReasons.length <= 32 && value.missingReasons.every(reason => text(reason)))
  const sources = value.sources.map(raw => {
    const source = record(raw)
    requireValue(text(source.id, 300) && ['dsh-global', 'dsh-preset', 'framework'].includes(String(source.kind)) && text(source.label)
      && (source.agentPreset === null || text(source.agentPreset)) && Array.isArray(source.modules) && source.modules.length <= 256)
    const modules = source.modules.map(rawModule => {
      const module = record(rawModule)
      requireValue(text(module.name) && ['package', 'local', 'builtin', 'unknown'].includes(String(module.kind))
        && ['loaded', 'configured'].includes(String(module.state)))
      return { name: module.name, kind: module.kind, state: module.state } as NativeToolInventoryModule
    })
    return { id: source.id, kind: source.kind, label: source.label, agentPreset: source.agentPreset, modules } as NativeToolInventorySource
  })
  const sourceIds = new Set(sources.map(source => source.id))
  requireValue(sourceIds.size === sources.length)
  const items = value.items.map(raw => {
    const item = record(raw)
    requireValue(text(item.id, 600) && text(item.name) && text(item.sourceId, 300) && sourceIds.has(item.sourceId)
      && (item.description === null || typeof item.description === 'string' && item.description.length <= 2000)
      && ['registered', 'declared'].includes(String(item.registration)) && (item.loadedInSession === null || typeof item.loadedInSession === 'boolean'))
    let registrationSource: NativeToolRegistrationSource | undefined
    if (item.registrationSource !== undefined) {
      const source = record(item.registrationSource)
      requireValue(['framework-builtin', 'dsh-builtin', 'extension'].includes(String(source.origin))
        && text(source.ownerId, 128) && /^[a-zA-Z0-9_.:@/-]+$/.test(source.ownerId)
        && text(source.ownerName, 80) && source.ownerName.trim().length > 0
        && ['native', 'mcp'].includes(String(source.transport)))
      registrationSource = { origin: source.origin, ownerId: source.ownerId, ownerName: source.ownerName, transport: source.transport } as NativeToolRegistrationSource
    }
    return { ...(registrationSource ? { registrationSource } : {}), id: item.id, name: item.name, description: item.description, sourceId: item.sourceId,
      registration: item.registration, loadedInSession: item.loadedInSession } as NativeToolInventoryItem
  })
  requireValue(new Set(items.map(item => item.id)).size === items.length)
  return { schema: 1, state: value.state as NativeToolInventory['state'], items, sources, limited: value.limited,
    missingReasons: [...value.missingReasons] as string[], externalToolAuthorizationVerified: false }
}
