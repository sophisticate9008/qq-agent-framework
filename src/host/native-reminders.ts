import { deliveryMessageId } from '../core/delivery.ts'
import { randomUUID } from 'node:crypto'
import type { EffectAdapter, EffectRequest, FeatureDefinition, FrameworkEvent } from '../core/types.ts'
import { FrameworkError, assert, errorCode, isRecord, snapshot } from '../core/values.ts'
import type { DurableStore, StoredRecord } from '../contracts/ports.ts'
import { parseNativeReminderOccurrence, validateNativeReminderConfiguration, type NativeReminderConfiguration,
  type NativeReminderHistorySnapshot, type NativeReminderOccurrence, type NativeReminderSnapshot,
  type NativeRemindersSnapshot } from '../contracts/native-reminders.ts'
import { digest, json, object } from './data.ts'
import { createTaskQueue } from './tasks.ts'
import { createCalendarTriggerService, nextCalendarTriggerAt } from './triggers.ts'
import { withDeadline } from './deadlines.ts'

const rulesNamespace = 'package.reminders.rules'
const historyNamespace = 'package.reminders.history'
const schedulerPrefix = 'package.reminders.scheduler.'
const windowMs = 5 * 60_000
const dst = Object.freeze({ overlap: 'earlier' as const, nonexistent: 'skip' as const })

interface StoredReminder {
  readonly schema: 1
  readonly id: string
  readonly owner: 'reminders'
  readonly generation: number
  readonly configuration: NativeReminderConfiguration
  readonly anchorAt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly cancelled: boolean
  readonly blockedBy: string | null
  readonly lastOccurrenceId: string | null
}
function fail(code: string): never { throw new FrameworkError(code, 'The reminder operation could not be completed.') }
function validId(value: unknown): value is string { return typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,99}$/.test(value) }
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_639_999_000_000_000 }
function currentTime(clock: () => number): number { const value = clock(); if (!timestamp(value)) fail('REMINDER_CLOCK_INVALID'); return value }
function readRule(record: StoredRecord): StoredReminder {
  const input = object(record.value)
  if (input.schema !== 1 || input.id !== record.key || !validId(input.id) || input.owner !== 'reminders'
    || !Number.isSafeInteger(input.generation) || Number(input.generation) < 1 || !timestamp(input.anchorAt)
    || !timestamp(input.createdAt) || !timestamp(input.updatedAt) || typeof input.cancelled !== 'boolean'
    || input.blockedBy !== null && !validId(input.blockedBy) || input.lastOccurrenceId !== null && !validId(input.lastOccurrenceId)) fail('REMINDER_STORED_INVALID')
  let configuration: NativeReminderConfiguration
  try { configuration = validateNativeReminderConfiguration(input.configuration) } catch { return fail('REMINDER_STORED_INVALID') }
  return snapshot({ ...input, configuration }) as unknown as StoredReminder
}
function readOccurrence(record: StoredRecord): NativeReminderOccurrence {
  const value = parseNativeReminderOccurrence(record.value)
  if (!value || value.id !== record.key) fail('REMINDER_STORED_INVALID')
  return value
}
function onceAt(rule: StoredReminder): number | null {
  const schedule = rule.configuration.schedule
  return schedule.kind === 'once' ? schedule.at : schedule.kind === 'delay' ? rule.anchorAt + schedule.delayMs : null
}
function project(store: Pick<DurableStore, 'read'>, record: StoredRecord, now: number): NativeReminderSnapshot {
  const rule = readRule(record)
  const lastRecord = rule.lastOccurrenceId === null ? null : store.read(historyNamespace, rule.lastOccurrenceId)
  if (rule.lastOccurrenceId !== null && !lastRecord) fail('REMINDER_STORED_INVALID')
  const last = lastRecord ? readOccurrence(lastRecord) : null
  if (last && (last.ruleId !== rule.id || last.conversationId !== rule.configuration.conversationId)) fail('REMINDER_STORED_INVALID')
  let state: NativeReminderSnapshot['state'] = rule.cancelled ? 'cancelled' : rule.blockedBy !== null
    || last?.status === 'unknown' || last?.status === 'dispatching' ? 'unknown' : rule.configuration.enabled ? 'enabled' : 'disabled'
  let nextAt: number | null = null
  if (state === 'enabled') {
    const at = onceAt(rule)
    if (at !== null) {
      if (last?.generation === rule.generation) state = 'completed'
      else if (at + windowMs <= now) state = 'expired'
      else nextAt = at
    } else {
      const schedule = rule.configuration.schedule
      if (schedule.kind === 'daily' || schedule.kind === 'weekly')
        nextAt = nextCalendarTriggerAt({ schedule, timeZone: rule.configuration.timeZone, dst },
          Math.max(now - 1, rule.anchorAt - 1, last?.generation === rule.generation ? last.scheduledAt : 0, 0))
    }
  }
  return snapshot({ schema: 1, id: rule.id, revision: record.revision, owner: 'reminders', generation: rule.generation,
    configuration: rule.configuration, state, nextAt, createdAt: rule.createdAt, updatedAt: rule.updatedAt, lastOccurrence: last })
}
export interface NativeReminderReadOptions {
  readonly conversationId?: string
  readonly limit?: number
  readonly after?: string
  readonly clock?: () => number
}
function pageOptions(options: NativeReminderReadOptions) {
  const limit = options.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 || options.after !== undefined && !validId(options.after)
    || options.conversationId !== undefined && !/^(?:group|private):[1-9][0-9]{0,31}$/.test(options.conversationId)) fail('REMINDER_INVALID_QUERY')
  return { limit, after: options.after }
}
/** These projections do not construct schedulers, recover records or write to a stopped database. */
export function readNativeReminders(store: Pick<DurableStore, 'read' | 'list'>, options: NativeReminderReadOptions = {}): NativeRemindersSnapshot {
  const { limit, after } = pageOptions(options)
  const records = store.list(rulesNamespace, { limit: limit + 1, ...(after === undefined ? {} : { after }) })
  const page = records.slice(0, limit)
  const now = currentTime(options.clock ?? Date.now)
  const rules = page.map(record => project(store, record, now)).filter(rule => options.conversationId === undefined || rule.configuration.conversationId === options.conversationId)
  return snapshot({ schema: 1, rules, nextCursor: records.length > limit ? page.at(-1)!.key : null })
}
export function readNativeReminderHistory(store: Pick<DurableStore, 'list'>, options: NativeReminderReadOptions & { readonly ruleId?: string } = {}): NativeReminderHistorySnapshot {
  const { limit, after } = pageOptions(options)
  if (options.ruleId !== undefined && !validId(options.ruleId)) fail('REMINDER_INVALID_QUERY')
  const records = store.list(historyNamespace, { limit: limit + 1, ...(after === undefined ? {} : { after }) })
  const page = records.slice(0, limit)
  const history = page.map(readOccurrence).filter(item => (options.ruleId === undefined || item.ruleId === options.ruleId)
    && (options.conversationId === undefined || item.conversationId === options.conversationId))
  return snapshot({ schema: 1, history, nextCursor: records.length > limit ? page.at(-1)!.key : null })
}
function schedulerStore(store: DurableStore): DurableStore {
  return {
    read(namespace, key) { return store.read(schedulerPrefix + namespace, key) },
    write(namespace, key, value, options) { return store.write(schedulerPrefix + namespace, key, value, options) },
    delete(namespace, key, revision) { return store.delete(schedulerPrefix + namespace, key, revision) },
    list(namespace, options) { return store.list(schedulerPrefix + namespace, options) },
    purgeExpired() { fail('REMINDER_GLOBAL_PURGE_FORBIDDEN') }, close() { /* Store ownership stays with the host. */ }
  }
}
export interface NativeReminderOptions {
  readonly store: DurableStore
  readonly clock?: () => number
  readonly intervalMs?: number
  readonly timeoutMs?: number
  readonly authorizeConfiguration: (conversationId: string, signal: AbortSignal) => void | Promise<void>
  readonly guard: (conversationId: string, signal: AbortSignal) => void | Promise<void>
  readonly dispatch: (event: FrameworkEvent, signal: AbortSignal) => Promise<{ readonly status: string; readonly errorCode?: string }>
  readonly authorizeToolRequest?: (request: EffectRequest, action: 'create' | 'update' | 'set-enabled' | 'cancel') => void | Promise<void>
  readonly onFault?: (code: string) => void
}

/** Explicit reminder rules are separate from proactive conversation and never grant messaging permission. */
export function createNativeReminderService(options: NativeReminderOptions) {
  const { store, clock = Date.now } = options
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 1_000
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 300_000
    && Number.isSafeInteger(intervalMs) && intervalMs >= 10 && intervalMs <= 60_000, 'REMINDER_INVALID_OPTIONS', 'Finite reminder deadlines are required.')
  let tasks: ReturnType<typeof createTaskQueue> | undefined
  let calendar: ReturnType<typeof createCalendarTriggerService> | undefined
  let lifetime = new AbortController()
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let starting: Promise<void> | undefined
  let lifecycleVersion = 0
  let running = false
  const active = new Map<string, AbortController>()
  function get(id: string): StoredRecord {
    if (!validId(id)) fail('REMINDER_INVALID')
    const record = store.read(rulesNamespace, id)
    if (!record) fail('REMINDER_NOT_FOUND')
    readRule(record)
    return record
  }
  function exact(id: string, revision: number): StoredRecord {
    if (!Number.isSafeInteger(revision) || revision < 1) fail('REMINDER_INVALID')
    const record = get(id)
    if (record.revision !== revision) fail('REMINDER_CONFLICT')
    return record
  }
  function unsettled(rule: StoredReminder): boolean {
    if (rule.blockedBy !== null) return true
    if (rule.lastOccurrenceId === null) return false
    const previous = store.read(historyNamespace, rule.lastOccurrenceId)
    if (!previous) fail('REMINDER_STORED_INVALID')
    return ['dispatching', 'unknown'].includes(readOccurrence(previous).status)
  }
  function save(id: string, rule: StoredReminder, expectedRevision: number | null): StoredRecord {
    try {
      const written = store.write(rulesNamespace, id, json(rule), { expectedRevision })
      const current = store.read(rulesNamespace, id)
      if (!current || written.revision !== current.revision || digest(current.value) !== digest(rule)) fail('REMINDER_WRITE_UNKNOWN')
      return current
    } catch (error) {
      if (errorCode(error) === 'STORE_CONFLICT') fail('REMINDER_CONFLICT')
      return fail('REMINDER_WRITE_UNKNOWN')
    }
  }
  function saved(previous: StoredReminder, updated: StoredRecord, now: number): NativeReminderSnapshot {
    try { interrupt(previous); return project(store, updated, now) }
    catch { return fail('REMINDER_WRITE_UNKNOWN') }
  }
  function metadata(id: string, changes: Partial<Pick<StoredReminder, 'lastOccurrenceId' | 'blockedBy'>>): void {
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = get(id)
      try { store.write(rulesNamespace, id, json({ ...readRule(record), ...changes, updatedAt: currentTime(clock) }), { expectedRevision: record.revision }); return }
      catch (error) { if (errorCode(error) !== 'STORE_CONFLICT') throw error }
    }
    fail('REMINDER_CONFLICT')
  }
  function terminal(id: string, status: Exclude<NativeReminderOccurrence['status'], 'dispatching'>, code: string | null, messageId: string | null = null): void {
    const record = store.read(historyNamespace, id)
    if (!record) fail('REMINDER_STORED_INVALID')
    const previous = readOccurrence(record)
    if (previous.status !== 'dispatching') return
    store.write(historyNamespace, id, json({ ...previous, status, errorCode: code, messageId, finishedAt: currentTime(clock) }), { expectedRevision: record.revision })
    metadata(previous.ruleId, { lastOccurrenceId: id, ...(status === 'unknown' ? { blockedBy: id } : {}) })
  }
  function currentRule(id: string, generation: number, signal: AbortSignal, occurrenceId?: string): StoredReminder {
    signal.throwIfAborted()
    const rule = readRule(get(id))
    if (!running || rule.generation !== generation || !rule.configuration.enabled || rule.cancelled || rule.blockedBy !== null) fail('REMINDER_INACTIVE')
    if (rule.lastOccurrenceId !== null) {
      const last = store.read(historyNamespace, rule.lastOccurrenceId)
      if (!last) fail('REMINDER_STORED_INVALID')
      const occurrence = readOccurrence(last)
      if (occurrence.status === 'unknown' || occurrence.status === 'dispatching' && occurrence.id !== occurrenceId) fail('REMINDER_UNKNOWN_REQUIRES_RECONCILIATION')
    }
    return rule
  }
  async function deliver(ruleId: string, generation: number, scheduledAt: number, signal: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, lifetime.signal, controller.signal])
    let rule = currentRule(ruleId, generation, combined)
    const id = `occurrence-${digest([ruleId, generation, scheduledAt])}`
    if (store.read(historyNamespace, id)) return
    const startedAt = currentTime(clock)
    const occurrence: NativeReminderOccurrence = { schema: 1, id, ruleId, generation,
      conversationId: rule.configuration.conversationId, scheduledAt, startedAt, finishedAt: null,
      status: 'dispatching', errorCode: null, messageId: null }
    try { store.write(historyNamespace, id, json(occurrence), { expectedRevision: null }) }
    catch (error) { if (errorCode(error) === 'STORE_CONFLICT' && store.read(historyNamespace, id)) return; throw error }
    metadata(ruleId, { lastOccurrenceId: id })
    active.set(ruleId, controller)
    let dispatching = false
    try {
      await options.guard(rule.configuration.conversationId, combined)
      rule = currentRule(ruleId, generation, combined, id)
      dispatching = true
      const result = await withDeadline({ signal: combined, timeoutMs, code: 'REMINDER_DISPATCH_TIMEOUT_UNKNOWN',
        run: signal => options.dispatch({ id, type: 'reminder.due', conversationId: rule.configuration.conversationId,
          data: { schema: 1, occurrenceId: id, ruleId, generation, scheduledAt } }, signal) })
      const outcome = store.read(historyNamespace, id)
      if (!outcome || readOccurrence(outcome).status === 'dispatching') terminal(id, result.status === 'rejected' ? 'rejected' : 'unknown',
        result.errorCode && /^[A-Z][A-Z_]{1,95}$/.test(result.errorCode) ? result.errorCode : 'REMINDER_DELIVERY_UNCONFIRMED')
    } catch (error) {
      terminal(id, dispatching ? 'unknown' : combined.aborted ? 'cancelled' : 'failed', errorCode(error, dispatching ? 'REMINDER_DELIVERY_UNKNOWN' : 'REMINDER_FIRE_DENIED'))
    } finally { if (active.get(ruleId) === controller) active.delete(ruleId) }
  }
  function synchronize(rule: StoredReminder): void {
    if (!running || !tasks || !calendar || rule.cancelled || !rule.configuration.enabled || rule.blockedBy !== null) return
    if (rule.lastOccurrenceId !== null) {
      const last = store.read(historyNamespace, rule.lastOccurrenceId)
      if (!last) fail('REMINDER_STORED_INVALID')
      if (['unknown', 'dispatching'].includes(readOccurrence(last).status)) return
    }
    const at = onceAt(rule)
    const taskId = `reminder:${rule.id}:${rule.generation}`
    if (at !== null) {
      if (!store.read(schedulerPrefix + 'tasks', taskId)) tasks.schedule({ id: taskId, kind: 'reminder.deliver',
        scope: rule.configuration.conversationId, dueAt: at, expiresAt: at + windowMs, maxAttempts: 1,
        payload: { ruleId: rule.id, generation: rule.generation, scheduledAt: at } })
    } else if (!store.read(schedulerPrefix + 'calendar-triggers', taskId)) {
      const schedule = rule.configuration.schedule
      if (schedule.kind === 'daily' || schedule.kind === 'weekly') calendar.register({ id: taskId,
        scope: rule.configuration.conversationId, timeZone: rule.configuration.timeZone, schedule, dst, misfire: 'skip', windowMs,
        payload: { ruleId: rule.id, generation: rule.generation } })
    }
  }
  function interrupt(rule: StoredReminder): void {
    active.get(rule.id)?.abort()
    if (!running) return
    const id = `reminder:${rule.id}:${rule.generation}`
    tasks?.cancel(id)
    calendar?.cancel(id)
  }
  async function tick(): Promise<void> {
    if (!running) return
    if (ticking) return ticking
    ticking = (async () => {
      const records = store.list(rulesNamespace, { limit: 257 })
      if (records.length > 256) fail('REMINDER_CAPACITY_EXCEEDED')
      for (const record of records) synchronize(readRule(record))
      await tasks?.runDue({ limit: 32 })
      if (running) await calendar?.tick({ limit: 32 })
    })()
    try { await ticking } finally { ticking = undefined }
  }
  function recover(): void {
    let after: string | undefined
    do {
      const page = store.list(historyNamespace, { limit: 256, ...(after === undefined ? {} : { after }) })
      for (const record of page) if (readOccurrence(record).status === 'dispatching') terminal(record.key, 'unknown', 'REMINDER_INTERRUPTED_UNKNOWN')
      after = page.length === 256 ? page.at(-1)!.key : undefined
    } while (after !== undefined)
    tasks?.recover()
    let cursor: string | undefined
    do { const page = calendar!.recoverInterrupted({ limit: 256, ...(cursor === undefined ? {} : { after: cursor }) }); cursor = page.next ?? undefined } while (cursor !== undefined)
  }
  async function configuration(input: unknown, signal: AbortSignal): Promise<NativeReminderConfiguration> {
    let value: NativeReminderConfiguration
    try { value = validateNativeReminderConfiguration(input) } catch { return fail('REMINDER_INVALID') }
    signal.throwIfAborted()
    await options.authorizeConfiguration(value.conversationId, signal)
    signal.throwIfAborted()
    return value
  }
  function validateFuture(value: NativeReminderConfiguration, now: number): void {
    if (value.schedule.kind === 'once' && value.schedule.at <= now) fail('REMINDER_TIME_IN_PAST')
    if (value.schedule.kind === 'delay' && !timestamp(now + value.schedule.delayMs)) fail('REMINDER_INVALID')
  }
  const feature = Object.freeze<FeatureDefinition>({ id: 'reminder', version: '1.0.0', apiVersion: 1,
    capabilities: ['messaging.send'], subscriptions: ['reminder.due'], setup(context) {
      context.on('reminder.due', async (execution, event) => {
        if (!isRecord(event.data) || !validId(event.data.occurrenceId) || !validId(event.data.ruleId)
          || !Number.isSafeInteger(event.data.generation)) fail('REMINDER_INVALID_EVENT')
        const id = event.data.occurrenceId
        const occurrenceRecord = store.read(historyNamespace, id)
        if (!occurrenceRecord) fail('REMINDER_INVALID_EVENT')
        const occurrence = readOccurrence(occurrenceRecord)
        if (event.id !== id || occurrence.ruleId !== event.data.ruleId || occurrence.generation !== event.data.generation
          || occurrence.conversationId !== event.conversationId || occurrence.status !== 'dispatching') fail('REMINDER_INVALID_EVENT')
        const signal = AbortSignal.any([execution.signal, lifetime.signal, active.get(occurrence.ruleId)?.signal ?? lifetime.signal])
        let sending = false
        try {
          let rule = currentRule(occurrence.ruleId, occurrence.generation, signal, id)
          await options.guard(event.conversationId, signal)
          rule = currentRule(occurrence.ruleId, occurrence.generation, signal, id)
          sending = true
          const receipt = await execution.send([{ type: 'text', text: rule.configuration.text }])
          terminal(id, receipt.status, receipt.status === 'confirmed' ? null : receipt.status === 'rejected' ? 'REMINDER_SEND_REJECTED' : 'REMINDER_SEND_UNKNOWN',
            deliveryMessageId(receipt))
        } catch (error) {
          const code = errorCode(error, sending ? 'REMINDER_SEND_UNKNOWN' : 'REMINDER_FIRE_DENIED')
          const denied = ['POLICY_DENIED', 'POLICY_EXHAUSTED', 'UNDECLARED_CAPABILITY', 'FEATURE_DISABLED', 'EXECUTION_CLOSED'].includes(code)
          terminal(id, sending && !denied ? 'unknown' : signal.aborted ? 'cancelled' : 'failed', code)
          throw error
        }
      })
    } })
  const service = Object.freeze({
    feature,
    eventValidators: Object.freeze({ 'reminder.due': (data: Record<string, unknown>) => data.schema === 1 && validId(data.occurrenceId)
      && validId(data.ruleId) && Number.isSafeInteger(data.generation) && timestamp(data.scheduledAt) }),
    read(id: string) { return project(store, get(id), currentTime(clock)) },
    list(readOptions: NativeReminderReadOptions = {}) { return readNativeReminders(store, { ...readOptions, clock }) },
    history(readOptions: NativeReminderReadOptions & { readonly ruleId?: string } = {}) { return readNativeReminderHistory(store, readOptions) },
    async create(input: unknown, signal: AbortSignal): Promise<NativeReminderSnapshot> {
      const value = await configuration(input, signal)
      const now = currentTime(clock)
      validateFuture(value, now)
      if (store.list(rulesNamespace, { limit: 257 }).length >= 256) fail('REMINDER_CAPACITY_EXCEEDED')
      const id = `reminder-${randomUUID()}`
      const rule: StoredReminder = { schema: 1, id, owner: 'reminders', generation: 1, configuration: value,
        anchorAt: now, createdAt: now, updatedAt: now, cancelled: false, blockedBy: null, lastOccurrenceId: null }
      const record = save(id, rule, null)
      return project(store, record, now)
    },
    async update(id: string, revision: number, input: unknown, signal: AbortSignal): Promise<NativeReminderSnapshot> {
      const value = await configuration(input, signal)
      const record = exact(id, revision)
      const previous = readRule(record)
      if (previous.cancelled) fail('REMINDER_CANCELLED')
      if (unsettled(previous)) fail('REMINDER_UNKNOWN_REQUIRES_RECONCILIATION')
      if (value.conversationId !== previous.configuration.conversationId) fail('REMINDER_SCOPE_IMMUTABLE')
      const now = currentTime(clock)
      validateFuture(value, now)
      const updated = save(id, { ...previous, configuration: value,
        generation: previous.generation + 1, anchorAt: now, updatedAt: now }, revision)
      return saved(previous, updated, now)
    },
    async setEnabled(id: string, revision: number, enabled: boolean, signal: AbortSignal): Promise<NativeReminderSnapshot> {
      if (typeof enabled !== 'boolean') fail('REMINDER_INVALID')
      signal.throwIfAborted()
      let record = exact(id, revision)
      let previous = readRule(record)
      if (previous.cancelled) fail('REMINDER_CANCELLED')
      if (enabled) { await options.authorizeConfiguration(previous.configuration.conversationId, signal); signal.throwIfAborted(); record = exact(id, revision); previous = readRule(record) }
      if (enabled && unsettled(previous)) fail('REMINDER_UNKNOWN_REQUIRES_RECONCILIATION')
      if (previous.configuration.enabled === enabled) return project(store, record, currentTime(clock))
      const now = currentTime(clock)
      if (enabled) validateFuture(previous.configuration, now)
      const updated = save(id, { ...previous, generation: previous.generation + 1,
        configuration: { ...previous.configuration, enabled }, anchorAt: now, updatedAt: now }, revision)
      return saved(previous, updated, now)
    },
    async cancel(id: string, revision: number, signal: AbortSignal): Promise<NativeReminderSnapshot> {
      signal.throwIfAborted()
      const record = exact(id, revision)
      const previous = readRule(record)
      if (previous.cancelled) return project(store, record, currentTime(clock))
      const now = currentTime(clock)
      const updated = save(id, { ...previous, cancelled: true,
        configuration: { ...previous.configuration, enabled: false }, updatedAt: now }, revision)
      return saved(previous, updated, now)
    },
    tick,
    async start(): Promise<void> {
      if (running) return
      if (starting) return starting
      const version = ++lifecycleVersion
      starting = (async () => {
        await stopping
        if (version !== lifecycleVersion) return
        lifetime = new AbortController(); stopping = undefined
        tasks = createTaskQueue({ store: schedulerStore(store), clock, handlerTimeoutMs: timeoutMs })
        calendar = createCalendarTriggerService({ store: schedulerStore(store), clock, callbackTimeoutMs: timeoutMs,
          callback: occurrence => deliver(String(occurrence.payload.ruleId), Number(occurrence.payload.generation), occurrence.scheduledAt, occurrence.signal) })
        tasks.register('reminder.deliver', task => deliver(String(task.payload.ruleId), Number(task.payload.generation), Number(task.payload.scheduledAt), task.signal))
        recover(); running = true
        timer = setInterval(() => { void tick().catch(error => { try { options.onFault?.(errorCode(error, 'REMINDER_TICK_FAILED')) } catch {} }) }, intervalMs)
        timer.unref()
      })()
      try { await starting } finally { starting = undefined }
    },
    stop(): Promise<void> {
      if (stopping) return stopping
      lifecycleVersion++
      running = false; lifetime.abort(); clearInterval(timer); timer = undefined
      for (const controller of active.values()) controller.abort()
      stopping = (async () => { await Promise.all([tasks?.stop(), calendar?.stop()]); await ticking; tasks = undefined; calendar = undefined })()
      return stopping
    },
    status() { return snapshot({ schema: 1, owner: 'reminders', running, active: active.size,
      toolConfigurationAvailable: options.authorizeToolRequest !== undefined }) }
  })
  function input(request: EffectRequest, keys: readonly string[]): Record<string, unknown> {
    if (!isRecord(request.input) || Object.keys(request.input).length !== keys.length
      || !keys.every(key => Object.hasOwn(request.input as object, key))) fail('REMINDER_INVALID')
    return request.input
  }
  async function tool(request: EffectRequest, action: 'create' | 'update' | 'set-enabled' | 'cancel'): Promise<void> {
    request.signal.throwIfAborted()
    if (!options.authorizeToolRequest) fail('REMINDER_TOOL_CONFIGURATION_UNAVAILABLE')
    await options.authorizeToolRequest(request, action)
    request.signal.throwIfAborted()
  }
  function owned(id: unknown, request: EffectRequest): string {
    if (!validId(id) || readRule(get(id)).configuration.conversationId !== request.scope.conversationId) fail('REMINDER_NOT_FOUND')
    return id
  }
  const effects: Readonly<Record<string, EffectAdapter>> = Object.freeze({
    'reminders.list': { async execute(request: EffectRequest) {
      input(request, [])
      await options.guard(request.scope.conversationId, request.signal)
      return json(service.list({ conversationId: request.scope.conversationId }))
    } },
    'reminders.create': { async execute(request: EffectRequest) {
      const value = input(request, ['text', 'timeZone', 'schedule', 'enabled'])
      await tool(request, 'create')
      return json(await service.create({ ...value, conversationId: request.scope.conversationId }, request.signal))
    } },
    'reminders.update': { async execute(request: EffectRequest) {
      const value = input(request, ['id', 'revision', 'configuration'])
      await tool(request, 'update')
      const id = owned(value.id, request)
      if (typeof value.revision !== 'number' || !isRecord(value.configuration) || Object.keys(value.configuration).some(key => key === 'conversationId')) fail('REMINDER_INVALID')
      return json(await service.update(id, Number(value.revision), { ...value.configuration, conversationId: request.scope.conversationId }, request.signal))
    } },
    'reminders.set-enabled': { async execute(request: EffectRequest) {
      const value = input(request, ['id', 'revision', 'enabled'])
      await tool(request, 'set-enabled')
      if (typeof value.revision !== 'number' || typeof value.enabled !== 'boolean') fail('REMINDER_INVALID')
      return json(await service.setEnabled(owned(value.id, request), Number(value.revision), value.enabled, request.signal))
    } },
    'reminders.cancel': { async execute(request: EffectRequest) {
      const value = input(request, ['id', 'revision'])
      await tool(request, 'cancel')
      if (typeof value.revision !== 'number') fail('REMINDER_INVALID')
      return json(await service.cancel(owned(value.id, request), Number(value.revision), request.signal))
    } }
  })
  return Object.freeze({ ...service, effects })
}

export type NativeReminderService = ReturnType<typeof createNativeReminderService>
