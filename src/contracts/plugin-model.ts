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
  readonly contextRestartedFrom?: string
}
export interface PluginModelRunRequest extends PluginModelSessionKey {
  readonly prompt: string
  /** Canonical Base64 transport encoding; admitted as actual SDK image attachments. */
  readonly images?: readonly PluginModelImage[]
  readonly mode?: 'persistent' | 'stateless'
  readonly model?: PluginModelSelection
  readonly maxOutputChars?: number
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
export interface PluginModelImage {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly data: string
}
export type PluginModelRejectionCode = 'PLUGIN_MODEL_REJECTED' | 'PLUGIN_MODEL_IMAGE_UNSUPPORTED' | 'PLUGIN_MODEL_INVALID_IMAGES'
export const PLUGIN_MODEL_IMAGE_LIMITS = Object.freeze({ count: 4, bytesPerImage: 8 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 })
export function parsePluginModelImages(value: unknown): readonly PluginModelImage[] {
  if (!Array.isArray(value) || value.length > PLUGIN_MODEL_IMAGE_LIMITS.count) throw new TypeError('Invalid plugin model images')
  let total = 0
  return value.map((image: unknown): PluginModelImage => {
    if (!image || typeof image !== 'object' || Array.isArray(image)) throw new TypeError('Invalid plugin model image')
    const row = image as Record<string, unknown>
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(row.mediaType)) || typeof row.data !== 'string'
      || row.data.length < 4 || row.data.length > 4 * Math.ceil(PLUGIN_MODEL_IMAGE_LIMITS.bytesPerImage / 3)
      || Object.keys(row).some(key => key !== 'mediaType' && key !== 'data')
      || row.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(row.data)
      || row.data.endsWith('==') && !/[AQgw]==$/.test(row.data)
      || !row.data.endsWith('==') && row.data.endsWith('=') && !/[AEIMQUYcgkosw048]=$/.test(row.data)) throw new TypeError('Invalid plugin model image')
    const bytes = row.data.length / 4 * 3 - (row.data.endsWith('==') ? 2 : row.data.endsWith('=') ? 1 : 0)
    total += bytes
    if (bytes > PLUGIN_MODEL_IMAGE_LIMITS.bytesPerImage || total > PLUGIN_MODEL_IMAGE_LIMITS.totalBytes) throw new TypeError('Plugin model image capacity exceeded')
    return { mediaType: row.mediaType as PluginModelImage['mediaType'], data: row.data }
  })
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
    readonly images?: readonly PluginModelImage[]; readonly model?: PluginModelSelection; readonly signal: AbortSignal }): Promise<{
      readonly status: 'accepted' | 'rejected' | 'unknown'; readonly code?: PluginModelRejectionCode
    }>
  follow: (request: Parameters<AgentAdapter['follow']>[0] & { readonly requestId: string; readonly owner: string }) => ReturnType<AgentAdapter['follow']>
  /** Resolves after the loop is idle and the model-only tool restriction has been removed. */
  waitForIdle(sessionId: string, requestId: string, signal: AbortSignal): Promise<void>
  inspectRun(request: { readonly sessionId: string; readonly requestId: string; readonly owner: string; readonly signal: AbortSignal }): Promise<{
    readonly state: 'running' | 'completed' | 'failed' | 'unknown'
    readonly idle: boolean
    readonly usage: JsonObject
  }>
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
