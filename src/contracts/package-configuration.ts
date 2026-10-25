export type PackageConfigurationValue = null | string | number | boolean | readonly PackageConfigurationValue[]
  | { readonly [key: string]: PackageConfigurationValue }

export type PackageConfigurationField = {
  readonly id: string
  readonly path: readonly string[]
  readonly label: string
  readonly description: string
} & (
  | { readonly kind: 'boolean' }
  | { readonly kind: 'integer'; readonly minimum: number; readonly maximum: number; readonly unit?: string }
  | { readonly kind: 'string-list'; readonly maximumEntries: number; readonly maximumLength: number }
)

export interface PackageConfigurationDescriptor {
  readonly id: string
  readonly owner: string
  readonly schemaVersion: number
  readonly title: string
  readonly description: string
  readonly application: 'live' | 'restart'
  readonly fields: readonly PackageConfigurationField[]
}

export interface PackageConfigurationSnapshot<Value = PackageConfigurationValue> {
  readonly schema: 1
  readonly id: string
  readonly revision: string
  readonly schemaVersion: number
  readonly source: 'default' | 'stored'
  readonly application: 'live' | 'restart'
  readonly configuration: Value
}

export const PACKAGE_CONFIGURATION_PATH = '/api/chat/packages/configuration'

export interface StoredPackageConfiguration {
  readonly schema: 1
  readonly id: string
  readonly schemaVersion: number
  readonly configuration: PackageConfigurationValue
}

export interface PackageConfigurationMetadata {
  readonly schema: 1
  readonly id: string
  readonly revision: string
  readonly schemaVersion: number
  readonly targetSchemaVersion: number
  readonly source: 'stored' | 'default'
  readonly application: 'live' | 'restart'
}

export interface PackageConfigurationDocument {
  readonly revision: string
  readonly exists: boolean
  readonly value: StoredPackageConfiguration
}

export interface PackageConfigurationStore {
  read(id: string, fallback: StoredPackageConfiguration): Promise<PackageConfigurationDocument>
  compareAndSet(id: string, expectedRevision: string, fallback: StoredPackageConfiguration,
    next: StoredPackageConfiguration, signal: AbortSignal): Promise<PackageConfigurationDocument>
}

export function isPackageConfigurationValue(input: unknown): input is PackageConfigurationValue {
  const pending: { readonly value: unknown; readonly depth: number }[] = [{ value: input, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++nodes > 20_000 || depth > 64) return false
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || typeof value === 'number' && Number.isFinite(value)) continue
    if (typeof value !== 'object') return false
    const array = Array.isArray(value)
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
    const keys = Reflect.ownKeys(value)
    if (array && Object.keys(value).length !== value.length) return false
    for (const key of keys) {
      if (array && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)
        || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false
      pending.push({ value: descriptor.value, depth: depth + 1 })
    }
  }
  return true
}

export type PackageConfigurationListEntry = { readonly descriptor: PackageConfigurationDescriptor } & (
  | { readonly state: 'ready'; readonly revision: string; readonly source: 'default' | 'stored'; readonly errorCode: null }
  | { readonly state: 'unavailable'; readonly revision: string | null; readonly source: 'default' | 'stored' | null; readonly errorCode: string }
)
export interface PackageConfigurationListSnapshot { readonly schema: 1; readonly packages: readonly PackageConfigurationListEntry[] }
function configurationRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function configurationKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function configurationIdentifier(value: unknown): value is string { return typeof value === 'string' && value.length <= 100 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value) }
function configurationRevision(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function configurationText(value: unknown, maximum: number, empty = false): value is string { return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) }
function configurationInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) }
export function parsePackageConfigurationDescriptor(value: unknown): PackageConfigurationDescriptor | null {
  if (!configurationRecord(value) || !configurationKeys(value, ['id', 'owner', 'schemaVersion', 'title', 'description', 'application', 'fields'])
    || !configurationIdentifier(value.id) || !configurationIdentifier(value.owner) || !configurationInteger(value.schemaVersion) || value.schemaVersion < 1 || value.schemaVersion > 1000
    || !configurationText(value.title, 128) || !configurationText(value.description, 2000, true) || !['live', 'restart'].includes(String(value.application))
    || !Array.isArray(value.fields) || value.fields.length > 128 || Object.keys(value.fields).length !== value.fields.length) return null
  const seen = new Set<string>(); const paths = new Set<string>()
  for (const field of value.fields) {
    if (!configurationRecord(field) || !configurationIdentifier(field.id) || seen.has(field.id) || !Array.isArray(field.path) || field.path.length === 0 || field.path.length > 8
      || Object.keys(field.path).length !== field.path.length || !field.path.every(part => typeof part === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(part) && !['__proto__', 'constructor', 'prototype'].includes(part))
      || !configurationText(field.label, 128) || !configurationText(field.description, 2000, true)) return null
    const path = JSON.stringify(field.path); if (paths.has(path)) return null; paths.add(path)
    seen.add(field.id)
    const keys = ['id', 'path', 'label', 'description', 'kind']
    if (field.kind === 'boolean') { if (!configurationKeys(field, keys)) return null }
    else if (field.kind === 'integer') {
      if (!configurationKeys(field, [...keys, 'minimum', 'maximum', ...(Object.hasOwn(field, 'unit') ? ['unit'] : [])])
        || !configurationInteger(field.minimum) || !configurationInteger(field.maximum) || field.minimum > field.maximum || field.unit !== undefined && !configurationText(field.unit, 128, true)) return null
    } else if (field.kind === 'string-list') {
      if (!configurationKeys(field, [...keys, 'maximumEntries', 'maximumLength']) || !configurationInteger(field.maximumEntries) || field.maximumEntries < 1 || field.maximumEntries > 1024
        || !configurationInteger(field.maximumLength) || field.maximumLength < 1 || field.maximumLength > 4096) return null
    } else return null
  }
  return value as unknown as PackageConfigurationDescriptor
}
export function parsePackageConfigurationList(value: unknown): PackageConfigurationListSnapshot | null {
  if (!configurationRecord(value) || !configurationKeys(value, ['schema', 'packages']) || value.schema !== 1 || !Array.isArray(value.packages) || value.packages.length > 256 || Object.keys(value.packages).length !== value.packages.length) return null
  const packages: PackageConfigurationListEntry[] = []; const seen = new Set<string>()
  for (const item of value.packages) {
    if (!configurationRecord(item) || !configurationKeys(item, ['descriptor', 'state', 'revision', 'source', 'errorCode'])) return null
    const descriptor = parsePackageConfigurationDescriptor(item.descriptor)
    if (!descriptor || seen.has(descriptor.id) || !['ready', 'unavailable'].includes(String(item.state)) || item.revision !== null && !configurationRevision(item.revision)
      || item.source !== null && !['stored', 'default'].includes(String(item.source)) || (item.revision === null) !== (item.source === null)) return null
    if (item.state === 'ready' ? !configurationRevision(item.revision) || item.source === null || item.errorCode !== null : typeof item.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(item.errorCode)) return null
    seen.add(descriptor.id); packages.push({ ...item, descriptor } as PackageConfigurationListEntry)
  }
  return { schema: 1, packages }
}
export function parsePackageConfigurationSnapshot(value: unknown): PackageConfigurationSnapshot | null {
  if (!configurationRecord(value) || !configurationKeys(value, ['schema', 'id', 'revision', 'schemaVersion', 'source', 'application', 'configuration']) || value.schema !== 1
    || !configurationIdentifier(value.id) || !configurationRevision(value.revision) || !configurationInteger(value.schemaVersion) || value.schemaVersion < 1 || value.schemaVersion > 1000
    || !['default', 'stored'].includes(String(value.source)) || !['live', 'restart'].includes(String(value.application)) || !isPackageConfigurationValue(value.configuration)) return null
  return value as unknown as PackageConfigurationSnapshot
}
