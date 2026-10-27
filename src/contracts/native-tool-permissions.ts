import { NATIVE_TOOL_CAPABILITY_CATALOG, isNativeToolCapability, type NativeToolCapability } from './native-tool-capabilities.ts'
// Compatibility exports for existing consumers; capability definitions live independently of grants.
export { NATIVE_TOOL_CAPABILITY_CATALOG, isNativeToolCapability, type NativeToolCapability } from './native-tool-capabilities.ts'
import { NATIVE_REVISION_PATTERN } from './native-revisions.ts'

export const NATIVE_TOOL_PERMISSIONS_PATH = '/api/chat/tool-permissions'
export const NATIVE_TOOL_PERMISSION_LIMIT = 1_024
export const NATIVE_TOOL_PERMISSION_MAX_USES = 1_000_000

export interface NativeToolPermissionInput {
  readonly id: string
  readonly conversationId: string
  readonly capabilities: readonly NativeToolCapability[]
  readonly maxUses: Readonly<Partial<Record<NativeToolCapability, number | null>>>
  readonly expiresAt: number | null
}
export interface NativeToolPermissionGrant extends NativeToolPermissionInput {
  readonly createdAt: number
  readonly revokedAt: number | null
}
export interface NativeToolPermissionsConfiguration {
  readonly schema: 1
  readonly grants: readonly NativeToolPermissionGrant[]
}
export interface NativeToolPermissionRuntime {
  readonly state: 'not-running' | 'applied' | 'pending' | 'unknown'
  readonly appliedRevision: string | null
}
export interface NativeToolPermissionsSnapshot extends NativeToolPermissionsConfiguration {
  readonly revision: string
  readonly runtime: NativeToolPermissionRuntime
}
export type NativeToolPermissionsRequest = { readonly revision: string; readonly action: 'grant'; readonly grant: NativeToolPermissionInput }
  | { readonly revision: string; readonly action: 'revoke'; readonly id: string }

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 }
export function isNativeToolPermissionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
}
export function parseNativeToolPermissionInput(value: unknown): NativeToolPermissionInput | null {
  if (!record(value) || !exact(value, ['id', 'conversationId', 'capabilities', 'maxUses', 'expiresAt'])
    || !isNativeToolPermissionId(value.id) || typeof value.conversationId !== 'string'
    || !/^(?:group|private):[1-9][0-9]{0,31}$/.test(value.conversationId)
    || !Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.length > NATIVE_TOOL_CAPABILITY_CATALOG.length
    || !value.capabilities.every(isNativeToolCapability) || new Set(value.capabilities).size !== value.capabilities.length
    || !record(value.maxUses) || Object.keys(value.maxUses).length !== value.capabilities.length
    || !Object.keys(value.maxUses).every(key => (value.capabilities as readonly unknown[]).includes(key))
    || value.expiresAt !== null && !timestamp(value.expiresAt)) return null
  const capabilities = value.capabilities as NativeToolCapability[]
  const limits = value.maxUses
  if (!capabilities.every(capability => limits[capability] === null || typeof limits[capability] === 'number'
    && Number.isSafeInteger(limits[capability]) && limits[capability] >= 1 && limits[capability] <= NATIVE_TOOL_PERMISSION_MAX_USES)) return null
  return Object.freeze({ id: value.id, conversationId: value.conversationId, capabilities: Object.freeze([...capabilities]),
    maxUses: Object.freeze(Object.fromEntries(capabilities.map(capability => [capability, limits[capability]]))) as NativeToolPermissionInput['maxUses'], expiresAt: value.expiresAt })
}
export function parseNativeToolPermissionGrant(value: unknown): NativeToolPermissionGrant | null {
  if (!record(value) || !exact(value, ['id', 'conversationId', 'capabilities', 'maxUses', 'expiresAt', 'createdAt', 'revokedAt'])
    || !timestamp(value.createdAt) || value.revokedAt !== null && (!timestamp(value.revokedAt) || value.revokedAt < value.createdAt)) return null
  const grant = parseNativeToolPermissionInput({ id: value.id, conversationId: value.conversationId, capabilities: value.capabilities,
    maxUses: value.maxUses, expiresAt: value.expiresAt })
  return grant ? Object.freeze({ ...grant, createdAt: value.createdAt, revokedAt: value.revokedAt }) : null
}
export function parseNativeToolPermissionsConfiguration(value: unknown): NativeToolPermissionsConfiguration | null {
  if (!record(value) || !exact(value, ['schema', 'grants']) || value.schema !== 1 || !Array.isArray(value.grants)
    || value.grants.length > NATIVE_TOOL_PERMISSION_LIMIT) return null
  const grants = value.grants.map(parseNativeToolPermissionGrant)
  if (grants.some(grant => grant === null) || new Set(grants.map(grant => grant?.id)).size !== grants.length) return null
  return Object.freeze({ schema: 1, grants: Object.freeze(grants as NativeToolPermissionGrant[]) })
}
export function parseNativeToolPermissionRuntime(value: unknown): NativeToolPermissionRuntime | null {
  if (!record(value) || !exact(value, ['state', 'appliedRevision']) || !['not-running', 'applied', 'pending', 'unknown'].includes(String(value.state))
    || value.appliedRevision !== null && (typeof value.appliedRevision !== 'string' || !NATIVE_REVISION_PATTERN.test(value.appliedRevision))
    || value.state === 'applied' && value.appliedRevision === null || value.state === 'not-running' && value.appliedRevision !== null) return null
  return { state: value.state as NativeToolPermissionRuntime['state'], appliedRevision: value.appliedRevision as string | null }
}
export function parseNativeToolPermissionsSnapshot(value: unknown): NativeToolPermissionsSnapshot | null {
  if (!record(value) || !exact(value, ['schema', 'revision', 'grants', 'runtime']) || typeof value.revision !== 'string' || !NATIVE_REVISION_PATTERN.test(value.revision)) return null
  const configuration = parseNativeToolPermissionsConfiguration({ schema: value.schema, grants: value.grants })
  const runtime = parseNativeToolPermissionRuntime(value.runtime)
  return configuration && runtime && (runtime.state !== 'applied' || runtime.appliedRevision === value.revision)
    ? { ...configuration, revision: value.revision, runtime } : null
}
export function parseNativeToolPermissionsRequest(value: unknown): NativeToolPermissionsRequest | null {
  if (!record(value) || typeof value.revision !== 'string' || !NATIVE_REVISION_PATTERN.test(value.revision)) return null
  if (value.action === 'revoke' && exact(value, ['revision', 'action', 'id']) && isNativeToolPermissionId(value.id))
    return { revision: value.revision, action: 'revoke', id: value.id }
  if (value.action !== 'grant' || !exact(value, ['revision', 'action', 'grant'])) return null
  const grant = parseNativeToolPermissionInput(value.grant)
  return grant ? { revision: value.revision, action: 'grant', grant } : null
}
