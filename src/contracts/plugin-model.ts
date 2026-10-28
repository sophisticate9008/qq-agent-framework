import type { AgentAdapter } from './ports.ts'
import type { JsonObject } from './data.ts'

export interface PluginModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}
export interface PluginModelDescription extends PluginModelSelection {
  readonly providerName: string
  readonly modelName: string
}
export interface PluginModelSessionKey {
  readonly name?: string
  /** Separate plugin context for this concrete QQ address; never follows its QQ binding. */
  readonly conversationId?: string
}
export interface PluginModelBindingKey extends PluginModelSessionKey {
  readonly expectedRevision?: number | null
}
export interface PluginModelBinding {
  readonly revision: number
  readonly busy: boolean
  readonly owner: string
  readonly name: string
  readonly conversationId: string | null
  readonly sessionId: string
  readonly source: 'created' | 'existing'
  readonly model: PluginModelSelection | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastUsedAt: number | null
  readonly state: 'ready' | 'creating' | 'unknown'
}
export interface PluginModelRunRequest extends PluginModelSessionKey {
  readonly prompt: string
  readonly mode?: 'persistent' | 'stateless'
  readonly model?: PluginModelSelection
  readonly maxOutputChars?: number
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
export interface PluginModelRunResult {
  readonly requestId: string
  readonly sessionId: string
  readonly text: string
  readonly usage: JsonObject | null
}
export interface PluginModelManagedSession {
  readonly sessionId: string
  readonly owner: string
  readonly name: string
  readonly conversationId: string | null
  readonly mode: 'persistent' | 'stateless'
  readonly createdAt: number
}
export interface PluginModelClient {
  models(signal?: AbortSignal): Promise<readonly PluginModelDescription[]>
  list(): readonly PluginModelBinding[]
  bind(request: PluginModelBindingKey & { readonly sessionId: string; readonly signal?: AbortSignal }): Promise<PluginModelBinding>
  unbind(key?: PluginModelBindingKey): Promise<boolean>
  create(request?: PluginModelBindingKey & { readonly model?: PluginModelSelection; readonly signal?: AbortSignal }): Promise<PluginModelBinding>
  run(request: PluginModelRunRequest): Promise<PluginModelRunResult>
}
/** Host-owned transport; credentials and QQ identities never enter plugin requests. */
export interface PluginModelBackend {
  models(signal: AbortSignal): Promise<readonly PluginModelDescription[]>
  inspect(sessionId: string, signal: AbortSignal): Promise<{ readonly exists: boolean }>
  create(request: { readonly sessionId: string; readonly owner: string; readonly model: PluginModelSelection; readonly signal: AbortSignal }): Promise<void>
  start(request: { readonly sessionId: string; readonly requestId: string; readonly owner: string; readonly prompt: string;
    readonly model?: PluginModelSelection; readonly signal: AbortSignal }): Promise<{ readonly status: 'accepted' | 'rejected' | 'unknown' }>
  follow: AgentAdapter['follow']
  /** Resolves after the loop is idle and the model-only tool restriction has been removed. */
  waitForIdle(sessionId: string, requestId: string, signal: AbortSignal): Promise<void>
  cancel?: AgentAdapter['cancel']
}

export function pluginModelIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
}
export function parsePluginModelSelection(value: unknown): PluginModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid plugin model selection')
  const row = value as Record<string, unknown>
  if (!pluginModelIdentifier(row.provider) || !pluginModelIdentifier(row.model)
    || row.reasoningEffort !== undefined && !pluginModelIdentifier(row.reasoningEffort)
    || Object.keys(row).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) throw new TypeError('Invalid plugin model selection')
  return { provider: row.provider, model: row.model, ...(row.reasoningEffort === undefined ? {} : { reasoningEffort: row.reasoningEffort }) }
}
