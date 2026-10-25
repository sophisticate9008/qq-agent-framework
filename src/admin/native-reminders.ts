import { FrameworkError, isRecord } from '../core/values.ts'
import { NATIVE_REMINDERS_PATH, NATIVE_REMINDER_HISTORY_PATH, type NativeReminderHistorySnapshot,
  type NativeRemindersSnapshot } from '../contracts/native-reminders.ts'
import type { NativeReminderService, NativeReminderReadOptions } from '../host/native-reminders.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

function invalid(): never { throw new AdminRequestError(400, 'invalid_reminder_request') }
function exact(input: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key))
}
function queryOptions(query: URLSearchParams, history = false): NativeReminderReadOptions & { readonly ruleId?: string } {
  if ([...query.keys()].some(key => !['conversationId', 'limit', 'after', ...(history ? ['ruleId'] : [])].includes(key))
    || [...query.keys()].some(key => query.getAll(key).length !== 1)) invalid()
  const limit = query.get('limit')
  if (limit !== null && !/^[1-9][0-9]{0,2}$/.test(limit)) invalid()
  return { ...(query.has('conversationId') ? { conversationId: query.get('conversationId')! } : {}),
    ...(query.has('after') ? { after: query.get('after')! } : {}), ...(limit === null ? {} : { limit: Number(limit) }),
    ...(history && query.has('ruleId') ? { ruleId: query.get('ruleId')! } : {}) }
}
async function operation<Value>(run: () => Value | Promise<Value>, signal?: AbortSignal): Promise<Value> {
  try { return await run() }
  catch (error) {
    if (error instanceof AdminRequestError) throw error
    if (signal?.aborted) throw new AdminRequestError(499, 'request_aborted')
    if (error instanceof FrameworkError) {
      if (error.code === 'REMINDER_WRITE_UNKNOWN') throw new AdminRequestError(500, 'reminder_write_unknown')
      if (error.code === 'REMINDER_NOT_FOUND') throw new AdminRequestError(404, 'reminder_not_found')
      if (['REMINDER_CONFLICT', 'STORE_CONFLICT', 'REMINDER_CANCELLED', 'REMINDER_UNKNOWN_REQUIRES_RECONCILIATION', 'REMINDER_CAPACITY_EXCEEDED'].includes(error.code))
        throw new AdminRequestError(409, error.code === 'STORE_CONFLICT' ? 'reminder_conflict' : error.code.toLowerCase())
      if (['REMINDER_INVALID', 'REMINDER_INVALID_QUERY', 'REMINDER_SCOPE_IMMUTABLE', 'REMINDER_TIME_IN_PAST'].includes(error.code)) invalid()
      if (['NATIVE_CHAT_ACCESS_DENIED', 'ACCESS_DENIED', 'REMINDER_ACCESS_DENIED'].includes(error.code)) throw new AdminRequestError(403, 'reminder_access_denied')
    }
    throw new AdminRequestError(503, 'reminders_unavailable')
  }
}

/** GET providers may open only an existing database read-only. Only POST asks for a writable service. */
export function createNativeReminderRoutes(options: {
  readonly read: (options: NativeReminderReadOptions) => NativeRemindersSnapshot | Promise<NativeRemindersSnapshot>
  readonly history: (options: NativeReminderReadOptions & { readonly ruleId?: string }) => NativeReminderHistorySnapshot | Promise<NativeReminderHistorySnapshot>
  readonly service: () => NativeReminderService | Promise<NativeReminderService>
}): readonly AdminRoute[] {
  return Object.freeze([
    { method: 'GET', pathname: NATIVE_REMINDERS_PATH, maxResponseBytes: 2_097_152,
      handle({ query }: Parameters<AdminRoute['handle']>[0]) { const readOptions = queryOptions(query); return operation(() => options.read(readOptions)) } },
    { method: 'GET', pathname: NATIVE_REMINDER_HISTORY_PATH, maxResponseBytes: 1_048_576,
      handle({ query }: Parameters<AdminRoute['handle']>[0]) { const readOptions = queryOptions(query, true); return operation(() => options.history(readOptions)) } },
    { method: 'POST', pathname: NATIVE_REMINDERS_PATH, maxRequestBytes: 32_768,
      async handle({ query, body, signal }: Parameters<AdminRoute['handle']>[0]) {
        if (query.size !== 0 || !isRecord(body)) invalid()
        if (body.action === 'create' && exact(body, ['action', 'configuration']))
          return operation(async () => (await options.service()).create(body.configuration, signal), signal)
        if (typeof body.id !== 'string' || typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision)) invalid()
        const { id, revision } = body
        if (body.action === 'update' && exact(body, ['action', 'id', 'revision', 'configuration']))
          return operation(async () => (await options.service()).update(id, revision, body.configuration, signal), signal)
        if (body.action === 'set-enabled' && exact(body, ['action', 'id', 'revision', 'enabled']) && typeof body.enabled === 'boolean') {
          const enabled = body.enabled
          return operation(async () => (await options.service()).setEnabled(id, revision, enabled, signal), signal)
        }
        if (body.action === 'cancel' && exact(body, ['action', 'id', 'revision']))
          return operation(async () => (await options.service()).cancel(id, revision, signal), signal)
        invalid()
      } }
  ] as const)
}
