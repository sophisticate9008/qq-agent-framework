import { NATIVE_REVISION_PATTERN } from './native-revisions.ts'

export const NATIVE_TOOL_PERMISSIONS_PATH = '/api/chat/tool-permissions'
export const NATIVE_TOOL_CAPABILITY_CATALOG = Object.freeze([
  { capability: 'native.role.read', tool: 'qaf_role_reference', name: '读取当前人设绑定的角色参考图' },
  { capability: 'native.media.inspect', tool: 'qaf_media_inspect', name: '查看媒体状态' },
  { capability: 'native.media.read', tool: 'qaf_media_read', name: '读取当前会话媒体' },
  { capability: 'reminders.list', tool: 'qaf_reminder_list', name: '查看当前会话提醒' },
  { capability: 'reminders.create', tool: 'qaf_reminder_create', name: '创建当前会话提醒' },
  { capability: 'reminders.update', tool: 'qaf_reminder_update', name: '更正当前会话提醒' },
  { capability: 'reminders.set-enabled', tool: 'qaf_reminder_set_enabled', name: '启停当前会话提醒' },
  { capability: 'reminders.cancel', tool: 'qaf_reminder_cancel', name: '取消当前会话提醒' },
  { capability: 'memory.query', tool: 'qaf_memory_query', name: '查询当前会话记忆' },
  { capability: 'memory.propose', tool: 'qaf_memory_propose', name: '提出当前会话记忆建议' },
  { capability: 'native.work.start', tool: 'qaf_work_start', name: '接受主人独立工作委派' },
  { capability: 'native.work.status', tool: 'qaf_work_status', name: '查看当前会话工作状态' },
  { capability: 'native.work.followup', tool: 'qaf_work_followup', name: '按主人要求追加或调整工作' },
  { capability: 'native.work.interrupt', tool: 'qaf_work_interrupt', name: '按主人要求停止工作' },
  { capability: 'native.work.reconcile', tool: 'qaf_work_reconcile', name: '按主人要求核对未知工作' }
] as const)
export type NativeToolCapability = typeof NATIVE_TOOL_CAPABILITY_CATALOG[number]['capability']
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
export function isNativeToolCapability(value: unknown): value is NativeToolCapability {
  return NATIVE_TOOL_CAPABILITY_CATALOG.some(item => item.capability === value)
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
