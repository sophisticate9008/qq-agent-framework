export interface NativeDiagnosticContext {
  readonly source: 'active-session' | 'saved-plan'
  readonly limit: number
  readonly headroomTokens: number | null
  readonly modelWindow: number | null
  readonly maxOutput: number | null
}
export interface NativeDiagnosticCheck {
  readonly code: string
  readonly state: 'ready' | 'waiting' | 'blocked' | 'unknown'
  readonly summary: string
  readonly nextAction: string | null
  readonly href: string | null
}
export interface NativeConversationDiagnostics {
  readonly schema: 1
  readonly conversationId: string
  readonly observedAt: number
  readonly source: 'native-chat'
  readonly state: 'ready' | 'waiting' | 'blocked' | 'unknown'
  readonly checks: readonly NativeDiagnosticCheck[]
  readonly context?: NativeDiagnosticContext | null
  readonly input: { readonly mention: boolean; readonly reply: boolean; readonly nicknames: readonly string[]; readonly continuationMs: number } | null
  readonly coverage: { readonly history: 'complete' | 'partial' | 'absent' | 'unavailable'; readonly scannedPerNamespace: number; readonly live: boolean }
  readonly automaticReplayAvailable: false
}

export function parseNativeConversationDiagnostics(input: unknown): NativeConversationDiagnostics | null {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
  const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value)
  const integer = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
  const states = ['ready', 'waiting', 'blocked', 'unknown']
  if (!record(input) || !exact(input, ['schema', 'conversationId', 'observedAt', 'source', 'state', 'checks', 'input', 'coverage', 'automaticReplayAvailable', ...(Object.hasOwn(input, 'context') ? ['context'] : [])]) || input.schema !== 1
    || typeof input.conversationId !== 'string' || !/^(?:group|private):[1-9][0-9]{0,31}$/.test(input.conversationId) || !integer(input.observedAt, 8_640_000_000_000_000)
    || input.source !== 'native-chat' || !states.includes(String(input.state)) || input.automaticReplayAvailable !== false || !Array.isArray(input.checks) || input.checks.length < 1 || input.checks.length > 64
    || !record(input.coverage) || !exact(input.coverage, ['history', 'scannedPerNamespace', 'live']) || !['complete', 'partial', 'absent', 'unavailable'].includes(String(input.coverage.history))
    || !integer(input.coverage.scannedPerNamespace, 100_000) || typeof input.coverage.live !== 'boolean') return null
  const checks: NativeDiagnosticCheck[] = []
  for (const check of input.checks) {
    if (!record(check) || !exact(check, ['code', 'state', 'summary', 'nextAction', 'href']) || typeof check.code !== 'string' || !/^[a-z][a-z0-9_]{0,159}$/.test(check.code)
      || !states.includes(String(check.state)) || !text(check.summary, 2048) || check.nextAction !== null && !text(check.nextAction, 2048)
      || check.href !== null && (typeof check.href !== 'string' || !/^(?:#[a-z][a-z0-9-]{0,63}|\/[a-z][a-z0-9/-]{0,63})$/.test(check.href))) return null
    checks.push({ code: check.code, state: check.state as NativeDiagnosticCheck['state'], summary: check.summary, nextAction: check.nextAction as string | null, href: check.href as string | null })
  }
  const state = checks.some(check => check.state === 'blocked') ? 'blocked' : checks.some(check => check.state === 'unknown') ? 'unknown' : checks.some(check => check.state === 'waiting') ? 'waiting' : 'ready'
  if (state !== input.state) return null
  let participation: NativeConversationDiagnostics['input'] = null
  if (input.input !== null) {
    const value = input.input
    if (!record(value) || !exact(value, ['mention', 'reply', 'nicknames', 'continuationMs']) || typeof value.mention !== 'boolean' || typeof value.reply !== 'boolean'
      || !Array.isArray(value.nicknames) || value.nicknames.length > 32 || !value.nicknames.every(name => text(name, 256)) || !integer(value.continuationMs, 300_000)) return null
    participation = { mention: value.mention, reply: value.reply, nicknames: [...value.nicknames] as string[], continuationMs: value.continuationMs }
  }
  let context: NativeDiagnosticContext | null | undefined = input.context === null ? null : undefined
  if (input.context !== undefined && input.context !== null) {
    const value = input.context
    if (!record(value) || !exact(value, ['source', 'limit', 'headroomTokens', 'modelWindow', 'maxOutput']) || !['active-session', 'saved-plan'].includes(String(value.source))
      || !integer(value.limit, 16_777_216) || value.limit === 0 || value.headroomTokens !== null && !integer(value.headroomTokens, 8192)
      || value.modelWindow !== null && (!integer(value.modelWindow, 16_777_216) || value.modelWindow === 0 || value.limit > value.modelWindow)
      || value.maxOutput !== null && (!integer(value.maxOutput, 16_777_216) || value.maxOutput === 0)
      || typeof value.modelWindow === 'number' && typeof value.maxOutput === 'number' && value.maxOutput >= value.modelWindow) return null
    context = { source: value.source as NativeDiagnosticContext['source'], limit: value.limit, headroomTokens: value.headroomTokens as number | null, modelWindow: value.modelWindow as number | null, maxOutput: value.maxOutput as number | null }
  }
  return { ...(context === undefined ? {} : { context }), schema: 1, conversationId: input.conversationId, observedAt: input.observedAt, source: 'native-chat', state, checks, input: participation,
    coverage: { history: input.coverage.history as NativeConversationDiagnostics['coverage']['history'], scannedPerNamespace: input.coverage.scannedPerNamespace, live: input.coverage.live }, automaticReplayAvailable: false }
}
