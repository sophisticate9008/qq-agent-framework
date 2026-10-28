import { isRecord } from './values.ts'
import { parsePluginModelSelection, pluginModelIdentifier } from './plugin-model.ts'
import type { PluginModelBinding, PluginModelDescription, PluginModelSelection } from './plugin-model.ts'

export interface PluginSessionSnapshot {
  readonly schema: 1
  readonly bindings: readonly PluginModelBinding[]
}
interface ManagementTarget {
  readonly owner: string
  readonly name?: string
  readonly conversationId?: string
  readonly revision: number | null
  readonly confirm: true
}
export type PluginSessionManagementRequest = ManagementTarget & (
  { readonly action: 'bind'; readonly sessionId: string; readonly qqConversationId?: string }
  | { readonly action: 'create'; readonly model?: PluginModelSelection }
  | { readonly action: 'unbind' }
)
const conversation = (value: unknown): value is string => typeof value === 'string' && /^(group|private):[1-9]\d{0,31}$/.test(value)
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function parsePluginSessionManagementRequest(value: unknown): PluginSessionManagementRequest | null {
  if (!isRecord(value) || !pluginModelIdentifier(value.owner) || value.confirm !== true
    || value.name !== undefined && !pluginModelIdentifier(value.name)
    || value.conversationId !== undefined && !conversation(value.conversationId)
    || value.revision !== null && (!timestamp(value.revision) || value.revision < 1)) return null
  const base = { owner: value.owner, ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId }), revision: value.revision, confirm: true as const }
  const keys = ['action', 'owner', 'name', 'conversationId', 'revision', 'confirm']
  if (value.action === 'unbind') {
    return value.revision === null || Object.keys(value).some(key => !keys.includes(key)) ? null : { ...base, action: 'unbind' }
  }
  if (value.action === 'bind') {
    if (!pluginModelIdentifier(value.sessionId) || value.qqConversationId !== undefined && !conversation(value.qqConversationId)
      || Object.keys(value).some(key => ![...keys, 'sessionId', 'qqConversationId'].includes(key))) return null
    return { ...base, action: 'bind', sessionId: value.sessionId,
      ...(value.qqConversationId === undefined ? {} : { qqConversationId: value.qqConversationId }) }
  }
  if (value.action !== 'create' || Object.keys(value).some(key => ![...keys, 'model'].includes(key))) return null
  try { return { ...base, action: 'create', ...(value.model === undefined ? {} : { model: parsePluginModelSelection(value.model) }) } }
  catch { return null }
}

export function parsePluginSessionBinding(value: unknown): PluginModelBinding | null {
  if (!isRecord(value) || !pluginModelIdentifier(value.owner) || !pluginModelIdentifier(value.name)
    || value.conversationId !== null && !conversation(value.conversationId) || !pluginModelIdentifier(value.sessionId)
    || value.source !== 'created' && value.source !== 'existing' || !['ready', 'creating', 'unknown'].includes(String(value.state))
    || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || value.lastUsedAt !== null && !timestamp(value.lastUsedAt)
    || !timestamp(value.revision) || value.revision < 1 || typeof value.busy !== 'boolean') return null
  try {
    return { owner: value.owner, name: value.name, conversationId: value.conversationId, sessionId: value.sessionId,
      source: value.source, state: value.state as PluginModelBinding['state'], model: value.model === null ? null : parsePluginModelSelection(value.model),
      createdAt: value.createdAt, updatedAt: value.updatedAt, lastUsedAt: value.lastUsedAt, revision: value.revision,
      busy: value.busy }
  } catch { return null }
}
export function parsePluginSessionSnapshot(value: unknown): PluginSessionSnapshot | null {
  if (!isRecord(value) || value.schema !== 1 || !Array.isArray(value.bindings) || value.bindings.length > 4096) return null
  const bindings: PluginModelBinding[] = []
  const keys = new Set<string>()
  for (const row of value.bindings) {
    const parsed = parsePluginSessionBinding(row)
    if (!parsed) return null
    const key = JSON.stringify([parsed.owner, parsed.name, parsed.conversationId])
    if (keys.has(key)) return null
    keys.add(key)
    bindings.push(parsed)
  }
  return { schema: 1, bindings }
}
export function parsePluginSessionModels(value: unknown): readonly PluginModelDescription[] | null {
  if (!isRecord(value) || value.schema !== 1 || !Array.isArray(value.models) || value.models.length > 4096) return null
  const models: PluginModelDescription[] = []
  for (const model of value.models) {
    if (!isRecord(model) || typeof model.providerName !== 'string' || model.providerName.length > 256
      || typeof model.modelName !== 'string' || model.modelName.length > 256) return null
    try {
      const selected = parsePluginModelSelection({ provider: model.provider, model: model.model,
        ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }) })
      models.push({ ...selected, providerName: model.providerName, modelName: model.modelName })
    } catch { return null }
  }
  return models
}
