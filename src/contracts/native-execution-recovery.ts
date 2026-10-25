export interface NativeExecutionRecoveryView {
  readonly schema: 1
  readonly executionId: string
  readonly revision: string
  readonly conversationId: string
  readonly sourceSessionId: string
  readonly sourceGeneration: number
  readonly childSessionId: string | null
  readonly state: 'available' | 'requested' | 'unknown' | 'confirmed' | 'completed'
  readonly missingReasons: readonly string[]
  readonly restartRequired: true
  readonly automaticReplayAvailable: false
}
export function parseNativeExecutionRecoveryView(input: unknown): NativeExecutionRecoveryView | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const keys = ['schema', 'executionId', 'revision', 'conversationId', 'sourceSessionId', 'sourceGeneration', 'childSessionId', 'state', 'missingReasons', 'restartRequired', 'automaticReplayAvailable']
  const reference = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
  const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || value.schema !== 1
    || !hash(value.executionId) || !hash(value.revision) || typeof value.conversationId !== 'string' || !/^(?:group|private):[1-9][0-9]{0,31}$/.test(value.conversationId)
    || !reference(value.sourceSessionId) || typeof value.sourceGeneration !== 'number' || !Number.isSafeInteger(value.sourceGeneration) || value.sourceGeneration < 1
    || value.childSessionId !== null && (!reference(value.childSessionId) || value.childSessionId === value.sourceSessionId)
    || !['available', 'requested', 'unknown', 'confirmed', 'completed'].includes(String(value.state))
    || ['confirmed', 'completed'].includes(String(value.state)) && value.childSessionId === null
    || !Array.isArray(value.missingReasons) || value.missingReasons.length > 16 || !value.missingReasons.every(reason => typeof reason === 'string' && /^execution_[a-z_]{1,128}$/.test(reason))
    || value.restartRequired !== true || value.automaticReplayAvailable !== false) return null
  return { schema: 1, executionId: value.executionId, revision: value.revision, conversationId: value.conversationId,
    sourceSessionId: value.sourceSessionId, sourceGeneration: value.sourceGeneration, childSessionId: value.childSessionId as string | null,
    state: value.state as NativeExecutionRecoveryView['state'], missingReasons: [...value.missingReasons] as string[], restartRequired: true, automaticReplayAvailable: false }
}
