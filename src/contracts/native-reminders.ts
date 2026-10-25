export const NATIVE_REMINDERS_PATH = '/api/chat/reminders'
export const NATIVE_REMINDER_HISTORY_PATH = '/api/chat/reminders/history'

export type NativeReminderSchedule = { readonly kind: 'once'; readonly at: number }
  | { readonly kind: 'delay'; readonly delayMs: number }
  | { readonly kind: 'daily'; readonly hour: number; readonly minute: number }
  | { readonly kind: 'weekly'; readonly dayOfWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7; readonly hour: number; readonly minute: number }

export interface NativeReminderConfiguration {
  readonly conversationId: string
  readonly text: string
  readonly timeZone: string
  readonly schedule: NativeReminderSchedule
  readonly enabled: boolean
}
export type NativeReminderOutcome = 'dispatching' | 'confirmed' | 'rejected' | 'failed' | 'unknown' | 'cancelled'
export interface NativeReminderOccurrence {
  readonly schema: 1
  readonly id: string
  readonly ruleId: string
  readonly generation: number
  readonly conversationId: string
  readonly scheduledAt: number
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly status: NativeReminderOutcome
  readonly errorCode: string | null
  readonly messageId: string | null
}
export interface NativeReminderSnapshot {
  readonly schema: 1
  readonly id: string
  readonly revision: number
  readonly owner: 'reminders'
  readonly generation: number
  readonly configuration: NativeReminderConfiguration
  readonly state: 'enabled' | 'disabled' | 'cancelled' | 'completed' | 'expired' | 'unknown'
  readonly nextAt: number | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastOccurrence: NativeReminderOccurrence | null
}
export interface NativeRemindersSnapshot {
  readonly schema: 1
  readonly rules: readonly NativeReminderSnapshot[]
  readonly nextCursor: string | null
}
export interface NativeReminderHistorySnapshot {
  readonly schema: 1
  readonly history: readonly NativeReminderOccurrence[]
  readonly nextCursor: string | null
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}
function timestamp(value: unknown): value is number { return integer(value, 0, 8_639_999_000_000_000) }
function id(value: unknown): value is string { return typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,99}$/.test(value) }
function invalid(): never { throw new TypeError('INVALID_NATIVE_REMINDER') }

export function validateNativeReminderConfiguration(input: unknown): NativeReminderConfiguration {
  if (!record(input) || !keys(input, ['conversationId', 'text', 'timeZone', 'schedule', 'enabled'])
    || typeof input.conversationId !== 'string' || !/^(?:group|private):[1-9][0-9]{0,31}$/.test(input.conversationId)
    || typeof input.text !== 'string' || input.text.trim().length === 0 || input.text.length > 4_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)
    || typeof input.timeZone !== 'string' || input.timeZone.length === 0 || input.timeZone.length > 100
    || typeof input.enabled !== 'boolean' || !record(input.schedule)) invalid()
  let timeZone: string
  try { timeZone = new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone }).resolvedOptions().timeZone }
  catch { invalid() }
  const candidate = input.schedule
  let schedule: NativeReminderSchedule
  if (candidate.kind === 'once' && keys(candidate, ['kind', 'at']) && timestamp(candidate.at)) schedule = { kind: 'once', at: candidate.at }
  else if (candidate.kind === 'delay' && keys(candidate, ['kind', 'delayMs']) && integer(candidate.delayMs, 1_000, 366 * 86_400_000))
    schedule = { kind: 'delay', delayMs: candidate.delayMs }
  else if ((candidate.kind === 'daily' || candidate.kind === 'weekly')
    && integer(candidate.hour, 0, 23) && integer(candidate.minute, 0, 59)) {
    if (candidate.kind === 'daily' && keys(candidate, ['kind', 'hour', 'minute'])) schedule = { kind: 'daily', hour: candidate.hour, minute: candidate.minute }
    else if (candidate.kind === 'weekly' && keys(candidate, ['kind', 'dayOfWeek', 'hour', 'minute']) && integer(candidate.dayOfWeek, 1, 7))
      schedule = { kind: 'weekly', dayOfWeek: candidate.dayOfWeek as 1 | 2 | 3 | 4 | 5 | 6 | 7, hour: candidate.hour, minute: candidate.minute }
    else invalid()
  } else invalid()
  return Object.freeze({ conversationId: input.conversationId, text: input.text, timeZone, schedule: Object.freeze(schedule), enabled: input.enabled })
}

export function parseNativeReminderOccurrence(input: unknown): NativeReminderOccurrence | null {
  if (!record(input) || !keys(input, ['schema', 'id', 'ruleId', 'generation', 'conversationId', 'scheduledAt', 'startedAt', 'finishedAt', 'status', 'errorCode', 'messageId'])
    || input.schema !== 1 || !id(input.id) || !id(input.ruleId) || !integer(input.generation, 1)
    || typeof input.conversationId !== 'string' || !/^(?:group|private):[1-9][0-9]{0,31}$/.test(input.conversationId)
    || !timestamp(input.scheduledAt) || !timestamp(input.startedAt) || input.finishedAt !== null && !timestamp(input.finishedAt)
    || !['dispatching', 'confirmed', 'rejected', 'failed', 'unknown', 'cancelled'].includes(String(input.status))
    || input.errorCode !== null && (typeof input.errorCode !== 'string' || !/^[A-Z][A-Z_]{1,95}$/.test(input.errorCode))
    || input.messageId !== null && (typeof input.messageId !== 'string' || input.messageId.length === 0 || input.messageId.length > 160)
    || input.status === 'confirmed' && input.messageId === null
    || input.status === 'dispatching' && (input.finishedAt !== null || input.messageId !== null)
    || input.status !== 'dispatching' && input.finishedAt === null) return null
  return Object.freeze({ ...input }) as unknown as NativeReminderOccurrence
}

export function parseNativeReminderSnapshot(input: unknown): NativeReminderSnapshot | null {
  if (!record(input) || !keys(input, ['schema', 'id', 'revision', 'owner', 'generation', 'configuration', 'state', 'nextAt', 'createdAt', 'updatedAt', 'lastOccurrence'])
    || input.schema !== 1 || !id(input.id) || !integer(input.revision, 1) || input.owner !== 'reminders' || !integer(input.generation, 1)
    || !['enabled', 'disabled', 'cancelled', 'completed', 'expired', 'unknown'].includes(String(input.state))
    || input.nextAt !== null && (!timestamp(input.nextAt) || input.state !== 'enabled') || !timestamp(input.createdAt) || !timestamp(input.updatedAt)) return null
  const lastOccurrence = input.lastOccurrence === null ? null : parseNativeReminderOccurrence(input.lastOccurrence)
  if (input.lastOccurrence !== null && (!lastOccurrence || lastOccurrence.ruleId !== input.id)) return null
  try { return Object.freeze({ ...input, configuration: validateNativeReminderConfiguration(input.configuration), lastOccurrence }) as unknown as NativeReminderSnapshot }
  catch { return null }
}

export function parseNativeRemindersSnapshot(input: unknown): NativeRemindersSnapshot | null {
  if (!record(input) || !keys(input, ['schema', 'rules', 'nextCursor']) || input.schema !== 1 || !Array.isArray(input.rules)
    || input.rules.length > 256 || input.nextCursor !== null && !id(input.nextCursor)) return null
  const rules = input.rules.map(parseNativeReminderSnapshot)
  if (rules.some(rule => rule === null) || new Set(rules.map(rule => rule?.id)).size !== rules.length) return null
  return Object.freeze({ schema: 1, rules: Object.freeze(rules as NativeReminderSnapshot[]), nextCursor: input.nextCursor as string | null })
}

export function parseNativeReminderHistorySnapshot(input: unknown): NativeReminderHistorySnapshot | null {
  if (!record(input) || !keys(input, ['schema', 'history', 'nextCursor']) || input.schema !== 1 || !Array.isArray(input.history)
    || input.history.length > 256 || input.nextCursor !== null && !id(input.nextCursor)) return null
  const history = input.history.map(parseNativeReminderOccurrence)
  if (history.some(item => item === null) || new Set(history.map(item => item?.id)).size !== history.length) return null
  return Object.freeze({ schema: 1, history: Object.freeze(history as NativeReminderOccurrence[]), nextCursor: input.nextCursor as string | null })
}
