export const MIGRATION_PROTOCOL = 'qaf-session-migration/1' as const

export interface MigrationTargetSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly contextLimits: { readonly contextWindow: number; readonly maxTokens: number; readonly headroomTokens: number }
}

export function validMigrationTargetSelection(input: unknown): input is MigrationTargetSelection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const value = input as Record<string, unknown>
  const token = (item: unknown) => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(item)
  if (!token(value.provider) || !token(value.model) || value.reasoningEffort !== undefined && !token(value.reasoningEffort)
    || Object.keys(value).sort().join(',') !== (value.reasoningEffort === undefined ? 'contextLimits,model,provider' : 'contextLimits,model,provider,reasoningEffort')
    || !value.contextLimits || typeof value.contextLimits !== 'object' || Array.isArray(value.contextLimits)) return false
  const limits = value.contextLimits as Record<string, unknown>
  return Object.keys(limits).sort().join(',') === 'contextWindow,headroomTokens,maxTokens'
    && Number.isSafeInteger(limits.contextWindow) && Number(limits.contextWindow) >= 1024 && Number(limits.contextWindow) <= 10000000
    && Number.isSafeInteger(limits.maxTokens) && Number(limits.maxTokens) > 0
    && Number.isSafeInteger(limits.headroomTokens) && Number(limits.headroomTokens) >= 0
    && Number(limits.maxTokens) + Number(limits.headroomTokens) < Number(limits.contextWindow)
}

export interface ForkPreviewRequest {
  readonly migrationId: string
  readonly sourceSessionId: string
  readonly expectedPreset: string
  readonly targetPreset: string
  readonly targetSelection?: MigrationTargetSelection
}

export interface ForkPreviewResult extends ForkPreviewRequest {
  readonly migrationProtocol: typeof MIGRATION_PROTOCOL
  readonly issuerEpoch: string
  readonly state: 'available' | 'blocked'
  readonly sourceCursor: number | null
  readonly sourceDigest: string | null
  readonly targetRevision: string | null
  readonly missingReasons: readonly string[]
}

export interface ForkWithPresetRequest extends ForkPreviewRequest {
  readonly issuerEpoch: string
  readonly expectedCursor: number
  readonly expectedSourceDigest: string
  readonly expectedTargetRevision: string
}

export interface ForkWithPresetResult extends ForkWithPresetRequest {
  readonly migrationProtocol: typeof MIGRATION_PROTOCOL
  readonly state: 'completed' | 'rejected' | 'unknown' | 'not-found'
  readonly childSessionId: string | null
  readonly idempotency: 'created' | 'replayed' | 'conflict' | 'unknown' | 'not-found'
  readonly missingReasons: readonly string[]
}
