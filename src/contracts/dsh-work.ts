import type { TextContent } from './messages.ts'

export interface DshWorkMediaReference {
  readonly type: 'media-reference'
  readonly kind: 'image' | 'file'
  readonly attachmentId: string
  readonly bytes: number
  readonly name?: string
  readonly mediaType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly width?: number
  readonly height?: number
}
export type DshWorkOutput = Readonly<TextContent> | DshWorkMediaReference

export interface DshWorkAddress {
  readonly issuerEpoch: string
  readonly id: string
  readonly parentSessionId: string
  readonly childId: string
  readonly generation: number
}
export interface DshWorkTarget {
  /** Only the authenticated, owner-admitted child lease may request this scope. */
  readonly fullAccess?: boolean
  readonly parentSessionId: string
  readonly modelProvider: string
  readonly model: string
  readonly agentPreset: string
  readonly reasoningEffort?: string
}
export interface DshWorkStart extends DshWorkAddress, DshWorkTarget {
  readonly task: string
  readonly context: string
  readonly timeoutMs: number
}
export interface DshWorkUsageStep {
  readonly eventId: string
  readonly turn: string
  readonly step: number
  readonly at: number
  readonly provider: string
  readonly model: string
  readonly status: 'completed' | 'failed'
  readonly usage: Readonly<Partial<Record<'inputTokens' | 'outputTokens' | 'totalTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens', number>>>
}
export function isDshWorkUsage(value: unknown): value is readonly DshWorkUsageStep[] {
  if (!Array.isArray(value) || value.length > 256 || Buffer.byteLength(JSON.stringify(value)) > 131072) return false
  const text = (input: unknown) => typeof input === 'string' && input.length > 0 && input.length <= 256 && !/[\x00-\x1f\x7f]/.test(input)
  const count = (input: unknown) => typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
  return value.every(input => {
    if (!input || typeof input !== 'object') return false
    const row = input as Record<string, unknown>
    if (Object.keys(row).sort().join(',') !== 'at,eventId,model,provider,status,step,turn,usage'
      || ![row.eventId, row.turn, row.provider, row.model].every(text) || !count(row.step) || !count(row.at)
      || !['completed', 'failed'].includes(String(row.status)) || !row.usage || typeof row.usage !== 'object' || Array.isArray(row.usage)) return false
    return Object.entries(row.usage).every(([key, countValue]) => ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].includes(key) && count(countValue))
  })
}

export interface DshWorkSnapshot extends DshWorkAddress {
  readonly schema: 1
  readonly fullAccess?: boolean
  readonly usage?: readonly DshWorkUsageStep[]
  readonly state: 'starting' | 'running' | 'completed' | 'unknown'
  readonly result: { readonly stopReason: string; readonly output: readonly DshWorkOutput[] } | null
  readonly error: string | null
}

/** Strict wire projection; unknown SDK blocks cannot become display text. */
export function isDshWorkOutput(value: unknown): value is DshWorkOutput {
  if (!value || typeof value !== 'object' || !('type' in value)) return false
  const block = value as Record<string, unknown>
  if (block.type === 'text') return Object.keys(block).sort().join(',') === 'text,type' && typeof block.text === 'string'
  if (block.type !== 'media-reference' || !['image', 'file'].includes(String(block.kind))
    || Object.keys(block).some(key => !['type', 'kind', 'attachmentId', 'bytes', 'name', 'mediaType', 'width', 'height'].includes(key))
    || typeof block.attachmentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(block.attachmentId)
    || !Number.isSafeInteger(block.bytes) || Number(block.bytes) < 1 || Number(block.bytes) > 8 * 1024 * 1024
    || block.name !== undefined && (typeof block.name !== 'string' || block.name.length < 1 || block.name.length > 160 || /[/\\\p{Cc}]/u.test(block.name))) return false
  return block.kind === 'file'
    ? typeof block.name === 'string' && block.mediaType === undefined && block.width === undefined && block.height === undefined
    : ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(block.mediaType))
      && Number.isSafeInteger(block.width) && Number(block.width) >= 1 && Number(block.width) <= 32768
      && Number.isSafeInteger(block.height) && Number(block.height) >= 1 && Number(block.height) <= 32768
}
