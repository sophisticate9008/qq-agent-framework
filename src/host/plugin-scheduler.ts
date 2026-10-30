import { runImmediatePluginSchedule } from './plugin-scheduler-immediate.ts';
import type { Clock, JsonObject } from '../core/types.ts';
import type { DurableStore, StoredRecord } from '../contracts/ports.ts';
import { FrameworkError, assert, errorCode, identifier, isRecord, reference, snapshot } from '../core/values.ts';
import { digest, object } from './data.ts';
import { withDeadline } from './deadlines.ts';
import { parsePluginScheduleBusinessDetails, parsePluginScheduleBusinessSummary, parsePluginScheduleHistoryItem, parsePluginScheduleItem, parsePluginScheduleManagementRequest,
  parsePluginSchedulePlan, parsePluginSchedulePresentation, isPluginScheduleHistoryCursor, isPluginScheduleListCursor,
  type PluginScheduleBusinessDetails, type PluginScheduleBusinessSummary, type PluginScheduleDetail, type PluginScheduleHistoryItem,
  type PluginScheduleHistorySnapshot, type PluginScheduleItem, type PluginScheduleManagementRequest,
  type PluginSchedulePresentation, type PluginScheduleReadOptions, type PluginScheduleSnapshot } from '../contracts/plugin-schedules.ts';
export type { PluginScheduleBusinessDetails, PluginSchedulePresentation } from '../contracts/plugin-schedules.ts';
import { createCalendarTriggerService, nextCalendarTriggerAt, type CalendarDstPolicy,
  type CalendarMisfirePolicy, type CalendarOccurrenceStatus, type CalendarSchedule,
  type CalendarTriggerMetadata, type CalendarTriggerOccurrence } from './triggers.ts';

export interface PluginScheduleInput {
  readonly id: string;
  readonly handler: string;
  readonly payload: JsonObject;
  readonly schedule: CalendarSchedule;
  readonly timeZone?: string;
  readonly dst?: CalendarDstPolicy;
  readonly windowMs?: number;
  readonly misfire?: CalendarMisfirePolicy;
  readonly enabled?: boolean;
  readonly presentation?: PluginSchedulePresentation;
}
export interface PluginScheduledRule extends Required<Omit<PluginScheduleInput, 'presentation'>> {
  readonly presentation?: PluginSchedulePresentation;
  readonly cursor: string;
  readonly revision: number;
  readonly generation: number;
  readonly cancelled: boolean;
  readonly activeFrom: number;
  readonly evaluatedThrough: number;
  readonly nextAt: number | null;
  readonly state: 'enabled' | 'disabled' | 'cancelled' | 'running' | 'completed' | 'failed' | 'unknown' | 'expired';
}
export interface PluginScheduledOccurrence extends Omit<CalendarTriggerOccurrence, 'scope'> {
  readonly scope: string;
}
export interface PluginScheduledHistory {
  readonly cursor: string;
  readonly id: string;
  readonly ruleId: string;
  readonly generation: number;
  readonly scheduledAt: number;
  readonly status: CalendarOccurrenceStatus;
  readonly errorCode: string | null;
}
export type PluginScheduledHandler = (occurrence: PluginScheduledOccurrence) => void | Promise<void>;
export interface PluginSchedulerPage { readonly limit?: number; readonly after?: string }
export interface PluginSchedulerCas { readonly expectedRevision?: number }
export interface PluginSchedulerClient {
  registerHandler(kind: string, handler: PluginScheduledHandler): () => void;
  registerDetailsProvider(kind: string, provider: PluginScheduleDetailsProvider): () => void;
  schedule(input: PluginScheduleInput, options?: PluginSchedulerCas): PluginScheduledRule;
  list(options?: PluginSchedulerPage): readonly PluginScheduledRule[];
  cancel(id: string, options?: PluginSchedulerCas): boolean;
  history(options?: PluginSchedulerPage & { readonly id?: string }): readonly PluginScheduledHistory[];
}
export interface PluginScheduleDetailsProvider {
  readonly presentation?: PluginSchedulePresentation;
  readonly summarize?: (rule: PluginScheduledRule, occurrence: PluginScheduledHistory | undefined) => PluginScheduleBusinessSummary | null;
  readonly read: (rule: PluginScheduledRule, occurrence: PluginScheduledHistory | undefined, signal: AbortSignal)
    => PluginScheduleBusinessDetails | null | Promise<PluginScheduleBusinessDetails | null>;
  readonly canRunNow?: (rule: PluginScheduledRule) => boolean;
  readonly runNow?: (rule: PluginScheduledRule, occurrence: PluginScheduledOccurrence) => void | Promise<void>;
  readonly skip?: (rule: PluginScheduledRule, signal: AbortSignal) => void | Promise<void>;
}

const prefix = 'plugin-scheduler.';
const rulesNamespace = prefix + 'calendar-triggers';
const historyNamespace = prefix + 'calendar-trigger-occurrences';
const managementNamespace = prefix + 'management';
const presentationNamespace = prefix + 'presentation';
const retentionMs = 7 * 86_400_000;
const defaultDst = Object.freeze({ overlap: 'earlier' as const, nonexistent: 'skip' as const });

interface Envelope { owner: string; id: string; handler: string; payload: JsonObject }
interface HandlerEntry { handler: PluginScheduledHandler; lifetime: AbortSignal; controller: AbortController; check: () => void }
interface DetailsEntry { provider: PluginScheduleDetailsProvider; lifetime: AbortSignal; controller: AbortController; check: () => void }
interface Management { readonly schema: 1; readonly owner: string; readonly id: string; readonly paused: boolean;
  readonly operation: { readonly kind: 'skip' | 'run-now'; readonly state: 'running' | 'unknown' } | null }
function fail(code: string): never { throw new FrameworkError(code, '插件定时任务未能完成操作。'); }
function envelope(record: StoredRecord): Envelope {
  const value = object(record.value);
  const payload = object(value.payload);
  assert(reference(payload.owner) && reference(payload.id) && identifier(payload.handler) && isRecord(payload.payload),
    'PLUGIN_SCHEDULER_STORED_INVALID', 'Stored plugin schedule identity is invalid.');
  assert(record.key === digest([payload.owner, payload.id]) && value.scope === payload.owner,
    'PLUGIN_SCHEDULER_STORED_INVALID', 'Stored plugin schedule ownership is invalid.');
  return { owner: payload.owner, id: payload.id, handler: payload.handler, payload: object(payload.payload) };
}
function page(options: PluginSchedulerPage): { limit: number; after?: string } {
  const limit = options.limit ?? 100;
  assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000
    && (options.after === undefined || reference(options.after)), 'PLUGIN_SCHEDULER_INVALID_PAGE', 'A bounded schedule page is required.');
  return { limit, ...(options.after === undefined ? {} : { after: options.after }) };
}

function management(record: StoredRecord | null, owner: string, id: string): Management {
  if (!record) return { schema: 1, owner, id, paused: false, operation: null };
  const value = object(record.value);
  assert(value.schema === 1 && value.owner === owner && value.id === id && typeof value.paused === 'boolean'
    && (value.operation === null || isRecord(value.operation) && (value.operation.kind === 'skip' || value.operation.kind === 'run-now')
      && (value.operation.state === 'running' || value.operation.state === 'unknown')),
  'PLUGIN_SCHEDULER_STORED_INVALID', 'Stored schedule management state is invalid.');
  return value as unknown as Management;
}
function storedMetadata(record: StoredRecord): CalendarTriggerMetadata {
  const value = object(record.value);
  const schedule = parsePluginSchedulePlan(value.schedule);
  assert(value.schema === 1 && value.id === record.key && reference(value.scope) && schedule
    && typeof value.timeZone === 'string' && value.timeZone.length > 0 && value.timeZone.length <= 100
    && isRecord(value.dst) && (value.dst.overlap === 'earlier' || value.dst.overlap === 'later') && value.dst.nonexistent === 'skip'
    && (value.misfire === 'skip' || value.misfire === 'coalesce')
    && typeof value.windowMs === 'number' && Number.isSafeInteger(value.windowMs) && value.windowMs >= 60_000 && value.windowMs <= 8 * 86_400_000
    && typeof value.generation === 'number' && Number.isSafeInteger(value.generation) && value.generation >= 1
    && typeof value.enabled === 'boolean' && typeof value.cancelled === 'boolean'
    && typeof value.activeFrom === 'number' && Number.isSafeInteger(value.activeFrom) && value.activeFrom >= 0
    && typeof value.evaluatedThrough === 'number' && Number.isSafeInteger(value.evaluatedThrough) && value.evaluatedThrough >= -1,
  'PLUGIN_SCHEDULER_STORED_INVALID', 'Stored schedule metadata is invalid.');
  return { cursor: record.key, id: record.key, scope: value.scope, timeZone: value.timeZone, schedule,
    dst: { overlap: value.dst.overlap, nonexistent: 'skip' }, misfire: value.misfire, windowMs: value.windowMs,
    generation: value.generation, enabled: value.enabled, cancelled: value.cancelled,
    activeFrom: value.activeFrom, evaluatedThrough: value.evaluatedThrough };
}
function storedPresentation(record: StoredRecord | null): PluginSchedulePresentation | null {
  if (!record) return null;
  const value = object(record.value);
  const parsed = parsePluginSchedulePresentation(value.presentation);
  assert(value.schema === 1 && parsed, 'PLUGIN_SCHEDULER_STORED_INVALID', 'Stored schedule presentation is invalid.');
  return parsed;
}
function historyItem(record: StoredRecord, rule: StoredRecord, presentation: PluginSchedulePresentation | null = null): PluginScheduleHistoryItem {
  const value = object(record.value), identity = envelope(rule);
  assert(value.schema === 1 && value.ruleId === rule.key, 'PLUGIN_SCHEDULER_STORED_INVALID', 'Stored occurrence ownership is invalid.');
  const parsed = parsePluginScheduleHistoryItem({ cursor: record.key, id: record.key, owner: identity.owner,
    ruleId: identity.id, generation: value.generation, scheduledAt: value.scheduledAt, startedAt: value.startedAt ?? null, deadlineAt: value.deadlineAt,
    updatedAt: value.updatedAt, coalescedCount: value.coalescedCount, status: value.status, errorCode: value.errorCode, business: null, presentation, ...(value.trigger === 'manual' ? { trigger: 'manual' } : {}) });
  assert(parsed, 'PLUGIN_SCHEDULER_STORED_INVALID', 'Stored schedule occurrence is invalid.');
  return parsed;
}
function groupHistory(records: readonly StoredRecord[]) {
  const index = new Map<string, StoredRecord[]>();
  for (const record of records) {
    const ruleId = String(object(record.value).ruleId), entries = index.get(ruleId);
    if (entries) entries.push(record); else index.set(ruleId, [record]);
  }
  return index;
}
function responsePage<Value>(values: readonly Value[], limit: number) {
  const result: Value[] = [];
  let bytes = 0;
  for (const value of values) {
    if (result.length >= limit) break;
    const size = Buffer.byteLength(JSON.stringify(value));
    if (result.length && bytes + size > 1_750_000) break;
    bytes += size; result.push(value);
  }
  return result;
}
const scheduleRanks: Readonly<Record<PluginScheduleItem['state'], number>> = {
  running: 0, enabled: 1, unknown: 2, failed: 3, paused: 4, disabled: 5, completed: 6, expired: 7, cancelled: 8,
};
function compareSchedule(left: Pick<PluginScheduleItem, 'state' | 'nextAt' | 'cursor'>,
  right: { readonly rank: number; readonly nextAt: number | null; readonly cursor: string }) {
  return scheduleRanks[left.state] - right.rank || (left.nextAt ?? Infinity) - (right.nextAt ?? Infinity)
    || (left.cursor < right.cursor ? -1 : left.cursor > right.cursor ? 1 : 0);
}
function listCursor(item: PluginScheduleItem) { return `${scheduleRanks[item.state]}:${item.nextAt ?? 'none'}:${item.cursor}`; }

/** Read-only projection. Constructing and using it never recovers, registers, or starts a scheduler. */
export function createPluginScheduleReader(options: {
  readonly store: Pick<DurableStore, 'read' | 'list'>;
  readonly clock?: Clock;
  readonly running?: boolean;
  readonly canManage?: boolean;
  readonly maxRules?: number;
  readonly maxHistory?: number;
  readonly provider?: (owner: string, handler: string) => { readonly presentation?: PluginSchedulePresentation; readonly canSkip: boolean; readonly canRunNow?: (record: StoredRecord) => boolean } | undefined;
  readonly skipping?: (key: string) => boolean;
  readonly business?: (record: StoredRecord, occurrence: PluginScheduleHistoryItem | undefined,
    history: readonly StoredRecord[]) => PluginScheduleBusinessSummary | null;
}) {
  const { store, clock = Date.now } = options;
  function readOptions(query: PluginScheduleReadOptions) {
    const normalized = page(query);
    assert(normalized.limit <= 200 && (query.owner === undefined || reference(query.owner))
      && (query.id === undefined || reference(query.id) && query.owner !== undefined),
    'PLUGIN_SCHEDULER_INVALID_PAGE', 'A bounded owner and schedule filter is required.');
    return normalized;
  }
  function allRules() { return store.list(rulesNamespace, { limit: 1000 }); }
  function allHistory() { return store.list(historyNamespace, { limit: 1000 }); }
  function item(record: StoredRecord, occurrences: readonly StoredRecord[]): PluginScheduleItem {
    const identity = envelope(record), rule = storedMetadata(record);
    const controlRecord = store.read(managementNamespace, record.key), control = management(controlRecord, identity.owner, identity.id);
    const provider = options.provider?.(identity.owner, identity.handler);
    const presentation = storedPresentation(store.read(presentationNamespace, record.key)) ?? provider?.presentation ?? null;
    const history = occurrences.filter(row => object(row.value).ruleId === record.key).map(row => historyItem(row, record, presentation));
    const last = history.filter(row => row.generation === rule.generation)
      .sort((left, right) => right.scheduledAt - left.scheduledAt)[0] ?? null;
    const now = clock();
    const managementState: PluginScheduleItem['managementState'] = !control.operation ? 'ready'
      : control.operation.state === 'running' && options.skipping?.(record.key) ? control.operation.kind === 'run-now' ? 'running-now' : 'skipping' : 'unknown';
    let state: PluginScheduleItem['state'] = last?.status === 'running' ? 'running' : managementState === 'unknown' ? 'unknown'
      : rule.cancelled ? 'cancelled' : !rule.enabled ? 'disabled' : last?.status === 'unknown' ? 'unknown' : control.paused ? 'paused' : 'enabled';
    let nextAt: number | null = null;
    if (rule.schedule.kind === 'once' && !rule.cancelled && state !== 'running' && state !== 'unknown') {
      if (last?.status === 'completed' || last?.status === 'failed') state = last.status;
      else if (rule.schedule.at < rule.activeFrom || rule.schedule.at + rule.windowMs <= now || rule.schedule.at <= rule.evaluatedThrough) state = 'expired';
      else if (state === 'enabled') nextAt = rule.schedule.at;
    } else if (rule.schedule.kind !== 'once' && state === 'enabled') {
      nextAt = nextCalendarTriggerAt(rule, Math.max(now - 1, rule.evaluatedThrough, rule.activeFrom - 1, 0));
      if (last?.status === 'failed') state = 'failed';
    }
    const canSkip = Boolean(options.canManage && provider?.canSkip && managementState === 'ready' && rule.schedule.kind === 'once'
      && !rule.cancelled && !last && rule.schedule.at >= rule.activeFrom && rule.schedule.at + rule.windowMs > now
      && rule.schedule.at > rule.evaluatedThrough);
    const parsed = parsePluginScheduleItem({ cursor: record.key, owner: identity.owner, id: identity.id, handler: identity.handler,
      revision: `${record.revision}:${controlRecord?.revision ?? 0}`, ruleRevision: record.revision, generation: rule.generation,
      presentation, schedule: rule.schedule, timeZone: rule.timeZone, windowMs: rule.windowMs, activeFrom: rule.activeFrom,
      evaluatedThrough: rule.evaluatedThrough, enabled: rule.enabled, paused: control.paused, cancelled: rule.cancelled,
      state, nextAt, lastOccurrence: last, business: options.business?.(record, last ?? undefined, occurrences) ?? null, managementState,
      actions: { canPause: Boolean(options.canManage && !rule.cancelled && managementState === 'ready'), canSkip,
        canRunNow: Boolean(options.running && options.canManage && managementState === 'ready' && !control.paused && rule.enabled && !rule.cancelled
          && !history.some(row => row.status === 'running') && provider?.canRunNow?.(record)) } });
    assert(parsed, 'PLUGIN_SCHEDULER_STORED_INVALID', 'The schedule projection is invalid.');
    return snapshot(parsed);
  }
  return Object.freeze({
    list(query: PluginScheduleReadOptions = {}): PluginScheduleSnapshot {
      const { limit, after } = readOptions(query);
      assert(after === undefined || isPluginScheduleListCursor(after), 'PLUGIN_SCHEDULER_INVALID_PAGE', 'The schedule cursor is invalid.');
      const history = groupHistory(allHistory());
      const filtered = allRules().filter(record => {
        const identity = envelope(record);
        return (query.owner === undefined || identity.owner === query.owner) && (query.id === undefined || identity.id === query.id);
      });
      const items = filtered.map(record => item(record, history.get(record.key) ?? []))
        .sort((left, right) => compareSchedule(left, { rank: scheduleRanks[right.state], nextAt: right.nextAt, cursor: right.cursor }));
      const parts = after?.split(':');
      const boundary = parts ? { rank: Number(parts[0]), nextAt: parts[1] === 'none' ? null : Number(parts[1]), cursor: parts[2]! } : null;
      const eligible = items.filter(row => boundary === null || compareSchedule(row, boundary) > 0);
      const selected = responsePage(eligible, limit);
      return snapshot({ schema: 1, available: true, running: options.running ?? false, items: selected,
        next: eligible.length > selected.length ? listCursor(selected.at(-1)!) : null,
        summary: { total: items.length, paused: items.filter(row => row.paused).length,
          pending: items.filter(row => row.state === 'enabled' && row.nextAt !== null).length,
          running: items.filter(row => row.state === 'running').length, failed: items.filter(row => row.state === 'failed').length,
          unknown: items.filter(row => row.state === 'unknown').length },
        limits: { rules: options.maxRules ?? 512, history: options.maxHistory ?? 1000 } });
    },
    history(query: PluginScheduleReadOptions = {}): PluginScheduleHistorySnapshot {
      const { limit, after } = readOptions(query);
      assert(after === undefined || isPluginScheduleHistoryCursor(after), 'PLUGIN_SCHEDULER_INVALID_PAGE', 'The occurrence cursor is invalid.');
      const owned = new Map(allRules().filter(record => {
        const identity = envelope(record);
        return (query.owner === undefined || identity.owner === query.owner) && (query.id === undefined || identity.id === query.id);
      }).map(record => [record.key, record]));
      const history = allHistory(), index = groupHistory(history);
      const boundaryAt = after === undefined ? null : Number(after.slice(0, after.indexOf(':')));
      const boundaryKey = after === undefined ? null : after.slice(after.indexOf(':') + 1);
      const eligible = history.filter(record => owned.has(String(object(record.value).ruleId)))
        .map(record => ({ record, row: historyItem(record, owned.get(String(object(record.value).ruleId))!) }))
        .filter(({ row }) => boundaryAt === null || row.scheduledAt < boundaryAt
          || row.scheduledAt === boundaryAt && row.cursor > boundaryKey!)
        .sort((left, right) => right.row.scheduledAt - left.row.scheduledAt
          || (left.row.cursor < right.row.cursor ? -1 : left.row.cursor > right.row.cursor ? 1 : 0))
        .map(entry => entry.record);
      const selected = responsePage(eligible.slice(0, limit).map(record => {
        const rule = owned.get(String(object(record.value).ruleId))!, identity = envelope(rule);
        const presentation = storedPresentation(store.read(presentationNamespace, rule.key))
          ?? options.provider?.(identity.owner, identity.handler)?.presentation ?? null;
        const row = historyItem(record, rule, presentation);
        return { ...row, business: options.business?.(rule, row, index.get(rule.key) ?? []) ?? null };
      }), limit);
      return snapshot({ schema: 1, items: selected,
        next: eligible.length > selected.length ? `${selected.at(-1)!.scheduledAt}:${selected.at(-1)!.cursor}` : null });
    },
    detail(owner: string, id: string, occurrenceId?: string): PluginScheduleDetail {
      assert(reference(owner) && reference(id) && (occurrenceId === undefined || reference(occurrenceId)),
        'PLUGIN_SCHEDULER_INVALID_ID', 'A schedule identity is required.');
      const record = store.read(rulesNamespace, digest([owner, id]));
      assert(record, 'PLUGIN_SCHEDULER_NOT_FOUND', 'The schedule was not found.');
      const identity = envelope(record);
      assert(identity.owner === owner && identity.id === id, 'PLUGIN_SCHEDULER_STORED_INVALID', 'The schedule identity is invalid.');
      const history = allHistory();
      const occurrenceRecord = occurrenceId === undefined ? null : store.read(historyNamespace, occurrenceId);
      assert(occurrenceId === undefined || occurrenceRecord && object(occurrenceRecord.value).ruleId === record.key,
        'PLUGIN_SCHEDULER_NOT_FOUND', 'The occurrence was not found in this schedule.');
      const projected = item(record, history);
      return snapshot({ schema: 1, item: projected, occurrence: occurrenceRecord ? historyItem(occurrenceRecord, record, projected.presentation) : null,
        details: null, detailsAvailable: false, detailsError: null });
    },
  });
}

export function emptyPluginScheduleSnapshot(): PluginScheduleSnapshot {
  return { schema: 1, available: false, running: false, items: [], next: null,
    summary: { total: 0, paused: 0, pending: 0, running: 0, failed: 0, unknown: 0 }, limits: { rules: 512, history: 1000 } };
}

/** One timer and durable calendar, with callback ownership fixed by the trusted host. */
export function createPluginSchedulerService(options: {
  readonly store: DurableStore;
  readonly clock?: Clock;
  readonly intervalMs?: number;
  readonly callbackTimeoutMs?: number;
  readonly maxRules?: number;
  readonly maxHistory?: number;
  readonly onFault?: (code: string) => void;
}) {
  const { store, clock = Date.now } = options;
  const intervalMs = options.intervalMs ?? 1000;
  const maxRules = options.maxRules ?? 512;
  const maxHistory = options.maxHistory ?? 1000;
  assert(Number.isSafeInteger(intervalMs) && intervalMs >= 10 && intervalMs <= 60_000
    && Number.isSafeInteger(maxRules) && maxRules >= 1 && maxRules <= 1000
    && Number.isSafeInteger(maxHistory) && maxHistory >= 1 && maxHistory <= 1000,
    'PLUGIN_SCHEDULER_INVALID_OPTIONS', 'Finite plugin scheduling limits are required.');
  const handlers = new Map<string, HandlerEntry>();
  const detailProviders = new Map<string, DetailsEntry>();
  const skipOperations = new Set<string>();
  const skipControllers = new Map<string, AbortController>();
  const skipPending = new Map<string, Promise<void>>();
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let lastCleanupAt: number | undefined;
  const calendarStore: DurableStore = {
    ...store,
    read: (namespace, key) => store.read(prefix + namespace, key),
    write: (namespace, key, value, writeOptions) => {
      if (namespace === 'calendar-trigger-occurrences' && writeOptions?.expectedRevision === null) {
        const intent = object(value), ruleId = String(intent.ruleId);
        const record = store.read(rulesNamespace, ruleId);
        if (!record) fail('STORE_CONFLICT');
        const currentRule = storedMetadata(record);
        if (currentRule.generation !== intent.generation || !currentRule.enabled || currentRule.cancelled) fail('STORE_CONFLICT');
        const identity = envelope(record), override = store.read(managementNamespace, ruleId);
        const control = management(override, identity.owner, identity.id);
        if (control.paused || control.operation) fail('STORE_CONFLICT');
        if (store.compareAndSetBatch) {
          const result = store.compareAndSetBatch([
            { kind: 'check', namespace: rulesNamespace, key: ruleId, expectedRevision: record.revision },
            { kind: 'check', namespace: managementNamespace, key: ruleId, expectedRevision: override?.revision ?? null },
            { kind: 'write', namespace: historyNamespace, key, expectedRevision: null, value,
              ...(writeOptions.expiresAt === undefined ? {} : { expiresAt: writeOptions.expiresAt }) },
          ]).at(-1);
          assert(result, 'PLUGIN_SCHEDULER_STORED_INVALID', 'The occurrence claim was not stored.');
          return result;
        }
      }
      return store.write(prefix + namespace, key, value, writeOptions);
    },
    delete: (namespace, key, revision) => store.delete(prefix + namespace, key, revision),
    list: (namespace, query) => store.list(prefix + namespace, query),
  };
  function historyRows() { return store.list(historyNamespace, { limit: 1000 }); }
  function rows() { return store.list(rulesNamespace, { limit: 1000 }); }
  function entryFor(record: StoredRecord) {
    const value = envelope(record);
    return handlers.get(digest([value.owner, value.handler]));
  }
  function ready(id: string) {
    if (!running || historyRows().length >= maxHistory) return false;
    const record = store.read(rulesNamespace, id);
    if (!record) return false;
    const identity = envelope(record);
    const control = management(store.read(managementNamespace, id), identity.owner, identity.id);
    if (control.paused || control.operation) return false;
    const entry = entryFor(record);
    if (!entry || entry.lifetime.aborted) return false;
    try { entry.check(); return true; } catch { return false; }
  }
  function createCalendar() {
    return createCalendarTriggerService({ store: calendarStore, clock, retentionMs, retainUnknown: true,
      ...(options.callbackTimeoutMs === undefined ? {} : { callbackTimeoutMs: options.callbackTimeoutMs }),
      isReady: ready,
      async callback(occurrence) {
        const record = store.read(rulesNamespace, occurrence.ruleId);
        if (!record) fail('PLUGIN_SCHEDULER_RULE_MISSING');
        const value = envelope(record);
        const entry = entryFor(record);
        if (!entry) fail('PLUGIN_SCHEDULER_HANDLER_UNAVAILABLE');
        entry.check();
        const signal = AbortSignal.any([occurrence.signal, entry.lifetime, entry.controller.signal]);
        signal.throwIfAborted();
        try {
          await entry.handler(Object.freeze({ ...occurrence, ruleId: value.id, scope: value.owner,
            payload: snapshot(value.payload), signal }));
          if (signal.aborted) fail('PLUGIN_SCHEDULER_CALLBACK_ABORTED_UNKNOWN');
        } catch (error) {
          if (signal.aborted) fail('PLUGIN_SCHEDULER_CALLBACK_ABORTED_UNKNOWN');
          throw error;
        }
      } });
  }
  let calendar = createCalendar();
  function metadata(record: StoredRecord): CalendarTriggerMetadata {
    return storedMetadata(record);
  }
  function presentationFor(record: StoredRecord) {
    const identity = envelope(record);
    return storedPresentation(store.read(presentationNamespace, record.key))
      ?? detailProviders.get(digest([identity.owner, identity.handler]))?.provider.presentation ?? undefined;
  }
  function projection(record: StoredRecord, knownHistory?: readonly StoredRecord[]): PluginScheduledRule {
    const value = envelope(record);
    const rule = metadata(record);
    const history = (knownHistory ?? historyRows()).filter(row => object(row.value).ruleId === record.key
      && object(row.value).generation === rule.generation).sort((left, right) => Number(object(right.value).scheduledAt) - Number(object(left.value).scheduledAt));
    const last = history[0] ? object(history[0].value) : undefined;
    const now = clock();
    let state: PluginScheduledRule['state'] = rule.cancelled ? 'cancelled' : !rule.enabled ? 'disabled'
      : last?.status === 'running' ? 'running' : last?.status === 'unknown' ? 'unknown' : 'enabled';
    let nextAt: number | null = null;
    if (state === 'enabled') {
      if (rule.schedule.kind === 'once') {
        if (last?.status === 'completed' || last?.status === 'failed') state = last.status;
        else if (rule.schedule.at < rule.activeFrom || rule.schedule.at + rule.windowMs <= now) state = 'expired';
        else nextAt = rule.schedule.at;
      } else nextAt = nextCalendarTriggerAt(rule, Math.max(now - 1, rule.evaluatedThrough, rule.activeFrom - 1, 0));
    }
    const presentation = presentationFor(record);
    return snapshot({ ...rule, id: value.id, revision: record.revision, handler: value.handler,
      payload: value.payload, state, nextAt, ...(presentation ? { presentation } : {}) });
  }
  function providerFor(owner: string, handler: string) {
    const entry = detailProviders.get(digest([owner, handler]));
    if (!entry || entry.lifetime.aborted || entry.controller.signal.aborted) return undefined;
    try { entry.check(); return entry; } catch { return undefined; }
  }
  function reader() {
    return createPluginScheduleReader({ store, clock, running, canManage: true, maxRules, maxHistory,
      skipping: key => skipOperations.has(key),
      provider(owner, handler) {
        const entry = providerFor(owner, handler);
        return entry ? { ...(entry.provider.presentation ? { presentation: entry.provider.presentation } : {}), canSkip: Boolean(entry.provider.skip),
          canRunNow: record => { try { return Boolean(entry.provider.runNow && entry.provider.canRunNow?.(projection(record))); } catch { return false; } } } : undefined;
      },
      business(record, occurrence, history) {
        const identity = envelope(record), entry = providerFor(identity.owner, identity.handler);
        if (!entry?.provider.summarize) return null;
        try {
          const value = entry.provider.summarize(projection(record, history), occurrence ? {
            cursor: occurrence.cursor, id: occurrence.id, ruleId: occurrence.ruleId, generation: occurrence.generation,
            scheduledAt: occurrence.scheduledAt, status: occurrence.status, errorCode: occurrence.errorCode } : undefined);
          return value === null ? null : parsePluginScheduleBusinessSummary(value);
        } catch { return null; }
      } });
  }
  function cleanup(force = false) {
    const now = clock();
    // Capacity-sensitive registration still cleans immediately. Background collection
    // needs no per-second scan, and clock rollback starts a fresh maintenance interval.
    if (!force && lastCleanupAt !== undefined && now >= lastCleanupAt && now - lastCleanupAt < 60_000) return;
    const history = historyRows();
    for (const record of rows()) {
      const value = object(record.value);
      const schedule = object(value.schedule);
      if (!value.cancelled && schedule.kind !== 'once') continue;
      const identity = envelope(record);
      if (management(store.read(managementNamespace, record.key), identity.owner, identity.id).operation) continue;
      const retainAfter = value.cancelled ? Number(value.updatedAt)
        : Math.max(Number(value.activeFrom), Number(schedule.at) + Number(value.windowMs));
      if (retainAfter + retentionMs > now) continue;
      if (history.some(row => object(row.value).ruleId === record.key)) continue;
      if (skipOperations.has(record.key)) continue;
      if (store.delete(rulesNamespace, record.key, record.revision)) {
        for (const namespace of [managementNamespace, presentationNamespace]) {
          const metadata = store.read(namespace, record.key);
          if (metadata) store.delete(namespace, record.key, metadata.revision);
        }
      }
    }
    // Also collect metadata left behind by a process interruption after rule deletion.
    for (const namespace of [managementNamespace, presentationNamespace]) for (const record of store.list(namespace, { limit: 1000 })) {
      if (!store.read(rulesNamespace, record.key) && !skipOperations.has(record.key)) store.delete(namespace, record.key, record.revision);
    }
    lastCleanupAt = now;
  }
  async function tick(): Promise<void> {
    if (!running) return;
    if (ticking) return ticking;
    ticking = (async () => { cleanup(); await calendar.tick({ limit: 32 }); })();
    try { await ticking; } finally { ticking = undefined; }
  }
  function managedTarget(request: PluginScheduleManagementRequest) {
    assert(reference(request.owner) && reference(request.id), 'PLUGIN_SCHEDULER_INVALID_ID', 'A schedule identity is required.');
    const key = digest([request.owner, request.id]), record = store.read(rulesNamespace, key);
    assert(record, 'PLUGIN_SCHEDULER_NOT_FOUND', 'The schedule was not found.');
    const identity = envelope(record);
    assert(identity.owner === request.owner && identity.id === request.id, 'PLUGIN_SCHEDULER_STORED_INVALID', 'The schedule identity is invalid.');
    const override = store.read(managementNamespace, key), control = management(override, identity.owner, identity.id);
    assert(request.revision === `${record.revision}:${override?.revision ?? 0}`, 'PLUGIN_SCHEDULER_CONFLICT', 'The schedule changed. Refresh its state first.');
    assert(!control.operation, 'PLUGIN_SCHEDULER_MANAGEMENT_UNKNOWN', 'The previous schedule management operation has not settled.');
    assert(!storedMetadata(record).cancelled, 'PLUGIN_SCHEDULER_CONFLICT', 'A cancelled schedule cannot be changed.');
    assert(store.compareAndSetBatch, 'PLUGIN_SCHEDULER_MANAGEMENT_UNAVAILABLE', 'Atomic management requires CAS batch support.');
    return { key, record, identity, override, control, batch: store.compareAndSetBatch };
  }
  async function readDetail(owner: string, id: string, occurrenceId: string | undefined, signal: AbortSignal): Promise<PluginScheduleDetail> {
    const base = reader().detail(owner, id, occurrenceId), record = store.read(rulesNamespace, base.item.cursor);
    assert(record, 'PLUGIN_SCHEDULER_NOT_FOUND', 'The schedule was not found.');
    const identity = envelope(record), entry = providerFor(identity.owner, identity.handler);
    if (!entry) return base;
    try {
      const occurrence = base.occurrence ? { cursor: base.occurrence.cursor, id: base.occurrence.id,
        ruleId: base.occurrence.ruleId, generation: base.occurrence.generation, scheduledAt: base.occurrence.scheduledAt,
        status: base.occurrence.status, errorCode: base.occurrence.errorCode } : undefined;
      const details = await withDeadline({ signal: AbortSignal.any([signal, entry.lifetime, entry.controller.signal]),
        timeoutMs: 5_000, code: 'PLUGIN_SCHEDULER_DETAILS_TIMEOUT',
        run: providerSignal => entry.provider.read(projection(record), occurrence, providerSignal) });
      entry.check();
      const parsed = details === null ? null : parsePluginScheduleBusinessDetails(details);
      assert(details === null || parsed, 'PLUGIN_SCHEDULER_DETAILS_INVALID', 'The plugin returned invalid schedule details.');
      const response: PluginScheduleDetail = { ...base, details: parsed, detailsAvailable: true };
      assert(Buffer.byteLength(JSON.stringify(response)) <= 2 * 1024 * 1024,
        'PLUGIN_SCHEDULER_DETAILS_LIMIT', 'The schedule details exceed their response limit.');
      return snapshot(response);
    } catch (error) {
      signal.throwIfAborted();
      return snapshot({ ...base, detailsAvailable: true, detailsError: errorCode(error, 'PLUGIN_SCHEDULER_DETAILS_UNAVAILABLE') });
    }
  }
  async function manage(request: PluginScheduleManagementRequest, signal: AbortSignal): Promise<PluginScheduleItem> {
    assert(parsePluginScheduleManagementRequest(request), 'PLUGIN_SCHEDULER_INVALID_MANAGEMENT', 'A strict schedule management operation is required.');
    signal.throwIfAborted();
    const target = managedTarget(request), { key, record, identity, override, control, batch } = target;
    if (request.action === 'set-paused') {
      if (control.paused !== request.paused) batch([
        { kind: 'check', namespace: rulesNamespace, key, expectedRevision: record.revision },
        { kind: 'write', namespace: managementNamespace, key, expectedRevision: override?.revision ?? null,
          value: { schema: 1, owner: identity.owner, id: identity.id, paused: request.paused, operation: null } },
      ]);
      return reader().detail(identity.owner, identity.id).item;
    }
    if (request.action === 'run-now') {
      const view = reader().detail(identity.owner, identity.id).item;
      const entry = providerFor(identity.owner, identity.handler), handler = entry?.provider.runNow;
      assert(running && !stopping && view.actions.canRunNow && entry && handler && entryFor(record) && skipPending.size < 32 && historyRows().length < maxHistory,
        'PLUGIN_SCHEDULER_RUN_UNAVAILABLE', 'The plugin cannot safely execute this schedule now.');
      entry.check(); signal.throwIfAborted();
      const controller = new AbortController();
      const work = runImmediatePluginSchedule({ store, record, override, rule: storedMetadata(record), identity, paused: control.paused,
        revision: request.revision, clock, timeoutMs: options.callbackTimeoutMs ?? 30_000,
        signal: AbortSignal.any([entry.lifetime, entry.controller.signal, controller.signal]),
        run: async occurrence => { entry.check(); await handler(projection(record), occurrence); entry.check(); occurrence.signal.throwIfAborted(); } });
      skipOperations.add(key); skipControllers.set(key, controller); skipPending.set(key, work);
      void work.catch(error => { try { options.onFault?.(errorCode(error, 'PLUGIN_SCHEDULER_RUN_UNKNOWN')); } catch {} })
        .finally(() => { skipOperations.delete(key); skipControllers.delete(key); skipPending.delete(key); });
      return reader().detail(identity.owner, identity.id).item;
    }
    const view = reader().detail(identity.owner, identity.id).item;
    const entry = providerFor(identity.owner, identity.handler);
    const skip = entry?.provider.skip;
    const rule = storedMetadata(record);
    assert(running && view.actions.canSkip && entry && skip && rule.schedule.kind === 'once',
      'PLUGIN_SCHEDULER_SKIP_UNAVAILABLE', 'Only an unstarted one-time schedule with plugin skip support can be skipped.');
    // Read-only business eligibility is checked before creating a durable intent.
    // A clear refusal must not manufacture an unknown write operation.
    try {
      const details = await withDeadline({ signal: AbortSignal.any([signal, entry.lifetime, entry.controller.signal]),
        timeoutMs: 5_000, code: 'PLUGIN_SCHEDULER_SKIP_CHECK_UNAVAILABLE',
        run: providerSignal => entry.provider.read(projection(record), undefined, providerSignal) });
      const parsed = parsePluginScheduleBusinessDetails(details);
      assert(parsed?.canSkip, 'PLUGIN_SCHEDULER_SKIP_UNAVAILABLE', 'The plugin business record cannot currently be skipped.');
      entry.check();
    } catch {
      signal.throwIfAborted();
      fail('PLUGIN_SCHEDULER_SKIP_UNAVAILABLE');
    }
    signal.throwIfAborted();
    managedTarget(request); // Recheck the complete CAS identity after the asynchronous read.
    assert(running && !stopping && providerFor(identity.owner, identity.handler) === entry
      && reader().detail(identity.owner, identity.id).item.actions.canSkip,
    'PLUGIN_SCHEDULER_SKIP_UNAVAILABLE', 'The schedule can no longer be skipped.');
    const occurrenceKey = `calendar:${digest({ ruleId: key, generation: rule.generation, scheduledAt: rule.schedule.at })}`;
    const claimed = batch([
      { kind: 'check', namespace: rulesNamespace, key, expectedRevision: record.revision },
      { kind: 'check', namespace: historyNamespace, key: occurrenceKey, expectedRevision: null },
      { kind: 'write', namespace: managementNamespace, key, expectedRevision: override?.revision ?? null,
        value: { schema: 1, owner: identity.owner, id: identity.id, paused: control.paused, operation: { kind: 'skip', state: 'running' } } },
    ]).at(-1);
    assert(claimed, 'PLUGIN_SCHEDULER_STORED_INVALID', 'The skip management intent was not stored.');
    const controller = new AbortController();
    skipControllers.set(key, controller); skipOperations.add(key);
    const work = (async () => {
      try {
        await withDeadline({ signal: AbortSignal.any([signal, entry.lifetime, entry.controller.signal, controller.signal]),
          timeoutMs: 30_000, code: 'PLUGIN_SCHEDULER_SKIP_UNKNOWN', run: skipSignal => skip(projection(record), skipSignal) });
        entry.check();
        // Business state is settled before cancellation. Neither a new rule generation
        // nor a concurrent manager can be overwritten by this operation's old snapshot.
        batch([
          { kind: 'write', namespace: rulesNamespace, key, expectedRevision: record.revision,
            value: { ...object(record.value), enabled: false, cancelled: true, generation: rule.generation + 1, updatedAt: clock() } },
          { kind: 'write', namespace: managementNamespace, key, expectedRevision: claimed.revision,
            value: { schema: 1, owner: identity.owner, id: identity.id, paused: control.paused, operation: null } },
        ]);
      } catch {
        try { store.write(managementNamespace, key,
          { schema: 1, owner: identity.owner, id: identity.id, paused: control.paused, operation: { kind: 'skip', state: 'unknown' } },
          { expectedRevision: claimed.revision }); } catch { /* Keep the original durable intent if evidence cannot be updated. */ }
        fail('PLUGIN_SCHEDULER_SKIP_UNKNOWN');
      } finally { skipOperations.delete(key); skipControllers.delete(key); skipPending.delete(key); }
    })();
    skipPending.set(key, work);
    await work;
    return reader().detail(identity.owner, identity.id).item;
  }
  return Object.freeze({
    listManaged: (query: PluginScheduleReadOptions = {}) => reader().list(query),
    managedHistory: (query: PluginScheduleReadOptions = {}) => reader().history(query),
    readDetail,
    manage,
    forPlugin(owner: string, lifetime: AbortSignal, assertActive?: () => void): PluginSchedulerClient {
      assert(reference(owner), 'PLUGIN_SCHEDULER_INVALID_OWNER', 'A trusted plugin identity is required.');
      const check = () => { lifetime.throwIfAborted(); assertActive?.(); lifetime.throwIfAborted(); };
      function read(id: string) {
        assert(reference(id), 'PLUGIN_SCHEDULER_INVALID_ID', 'A schedule identity is required.');
        const record = store.read(rulesNamespace, digest([owner, id]));
        if (record && envelope(record).owner !== owner) fail('PLUGIN_SCHEDULER_STORED_INVALID');
        return record;
      }
      function cas(record: StoredRecord | null, request: PluginSchedulerCas) {
        if (request.expectedRevision !== undefined && (!Number.isSafeInteger(request.expectedRevision)
          || request.expectedRevision < 1 || record?.revision !== request.expectedRevision)) fail('PLUGIN_SCHEDULER_CONFLICT');
      }
      return Object.freeze({
        registerHandler(kind, handler) {
          check();
          assert(identifier(kind) && typeof handler === 'function', 'PLUGIN_SCHEDULER_INVALID_HANDLER', 'A named callback is required.');
          const key = digest([owner, kind]);
          const previous = handlers.get(key);
          if (previous && !previous.lifetime.aborted) fail('PLUGIN_SCHEDULER_DUPLICATE_HANDLER');
          const entry = { handler, lifetime, controller: new AbortController(), check };
          handlers.set(key, entry);
          const unregister = () => { if (handlers.get(key) === entry) handlers.delete(key); entry.controller.abort(); lifetime.removeEventListener('abort', unregister); };
          lifetime.addEventListener('abort', unregister, { once: true });
          return unregister;
        },
        registerDetailsProvider(kind, provider) {
          check();
          assert(identifier(kind) && provider && typeof provider.read === 'function'
            && (provider.skip === undefined || typeof provider.skip === 'function')
            && (provider.summarize === undefined || typeof provider.summarize === 'function')
            && (provider.canRunNow === undefined || typeof provider.canRunNow === 'function')
            && (provider.runNow === undefined || typeof provider.runNow === 'function')
            && Boolean(provider.runNow) === Boolean(provider.canRunNow),
          'PLUGIN_SCHEDULER_INVALID_PROVIDER', 'A read-only schedule details provider is required.');
          const presentation = provider.presentation === undefined ? undefined : parsePluginSchedulePresentation(provider.presentation);
          assert(provider.presentation === undefined || presentation, 'PLUGIN_SCHEDULER_INVALID_PRESENTATION', 'A bounded schedule presentation is required.');
          const key = digest([owner, kind]), previous = detailProviders.get(key);
          if (previous && !previous.lifetime.aborted) fail('PLUGIN_SCHEDULER_DUPLICATE_PROVIDER');
          const entry: DetailsEntry = { provider: { read: provider.read,
            ...(provider.runNow ? { runNow: provider.runNow, canRunNow: provider.canRunNow } : {}),
            ...(provider.skip ? { skip: provider.skip } : {}), ...(provider.summarize ? { summarize: provider.summarize } : {}),
            ...(presentation ? { presentation: snapshot(presentation) } : {}) }, lifetime, controller: new AbortController(), check };
          detailProviders.set(key, entry);
          const unregister = () => { if (detailProviders.get(key) === entry) detailProviders.delete(key);
            entry.controller.abort(); lifetime.removeEventListener('abort', unregister); };
          lifetime.addEventListener('abort', unregister, { once: true });
          // Backfill display metadata for already-persisted rules without changing
          // their generation. This also keeps friendly names available while stopped.
          try {
            if (presentation) for (const record of rows()) {
              const identity = envelope(record);
              if (identity.owner !== owner || identity.handler !== kind || store.read(presentationNamespace, record.key)) continue;
              try { store.write(presentationNamespace, record.key, { schema: 1, presentation: { ...presentation } }, { expectedRevision: null }); }
              catch (error) { if (errorCode(error) !== 'STORE_CONFLICT') throw error; }
            }
          } catch (error) { unregister(); throw error; }
          return unregister;
        },
        schedule(input, request = {}) {
          check();
          assert(reference(input.id) && identifier(input.handler) && isRecord(input.payload),
            'PLUGIN_SCHEDULER_INVALID_INPUT', 'A bounded identified plugin schedule is required.');
          cleanup(true);
          const current = read(input.id);
          cas(current, request);
          const presentation = input.presentation === undefined ? undefined : parsePluginSchedulePresentation(input.presentation);
          assert(input.presentation === undefined || presentation, 'PLUGIN_SCHEDULER_INVALID_PRESENTATION', 'A bounded schedule presentation is required.');
          function savePresentation() {
            const desiredPresentation = presentation ?? detailProviders.get(digest([owner, input.handler]))?.provider.presentation;
            if (!desiredPresentation) return;
            const key = digest([owner, input.id]), previous = store.read(presentationNamespace, key);
            if (previous && (!presentation || digest(object(previous.value).presentation) === digest(desiredPresentation))) return;
            store.write(presentationNamespace, key, { schema: 1, presentation: { ...desiredPresentation } }, { expectedRevision: previous?.revision ?? null });
          }
          const desired = { scope: owner, timeZone: input.timeZone ?? 'UTC', schedule: input.schedule,
            dst: input.dst ?? defaultDst, misfire: input.misfire ?? 'skip' as const, windowMs: input.windowMs ?? 300_000,
            payload: { owner, id: input.id, handler: input.handler, payload: input.payload }, enabled: input.enabled ?? true };
          if (current) {
            const previous = object(current.value);
            const keys = ['scope', 'timeZone', 'schedule', 'dst', 'misfire', 'windowMs', 'payload', 'enabled'] as const;
            if (!previous.cancelled && digest(Object.fromEntries(keys.map(key => [key, previous[key]]))) === digest(desired)) {
              savePresentation(); return projection(current);
            }
            if (request.expectedRevision === undefined || previous.cancelled) fail('PLUGIN_SCHEDULER_CONFLICT');
            calendar.update(current.key, desired);
          } else {
            if (rows().length >= maxRules) fail('PLUGIN_SCHEDULER_RULE_CAPACITY');
            calendar.register({ id: digest([owner, input.id]), ...desired });
          }
          savePresentation();
          return projection(read(input.id)!);
        },
        list(query = {}) {
          check();
          const { limit, after } = page(query);
          const history = groupHistory(historyRows());
          return snapshot(rows().filter(record => envelope(record).owner === owner && (after === undefined || record.key > after))
            .slice(0, limit).map(record => projection(record, history.get(record.key) ?? [])));
        },
        cancel(id, request = {}) {
          check();
          const record = read(id);
          cas(record, request);
          return record ? calendar.cancel(record.key) : false;
        },
        history(query = {}) {
          check();
          const { limit, after } = page(query);
          if (query.id !== undefined) assert(reference(query.id), 'PLUGIN_SCHEDULER_INVALID_ID', 'A schedule identity is required.');
          const owned = new Map(rows().filter(record => envelope(record).owner === owner)
            .map(record => [record.key, envelope(record).id]));
          return snapshot(historyRows().filter(record => {
            const value = object(record.value);
            return owned.has(String(value.ruleId)) && (query.id === undefined || owned.get(String(value.ruleId)) === query.id)
              && (after === undefined || record.key > after);
          }).slice(0, limit).map(record => {
            const value = object(record.value);
            return { cursor: record.key, id: record.key, ruleId: owned.get(String(value.ruleId))!,
              generation: Number(value.generation), scheduledAt: Number(value.scheduledAt),
              status: value.status as CalendarOccurrenceStatus, errorCode: value.errorCode === null ? null : String(value.errorCode) };
          }));
        },
      } satisfies PluginSchedulerClient);
    },
    tick,
    start() {
      if (running) return;
      if (stopping) fail('PLUGIN_SCHEDULER_STOPPING');
      let after: string | undefined;
      do {
        const result = calendar.recoverInterrupted({ limit: 1000, ...(after === undefined ? {} : { after }) });
        after = result.next ?? undefined;
      } while (after !== undefined);
      running = true;
      lastCleanupAt = undefined;
      timer = setInterval(() => { void tick().catch(error => { try { options.onFault?.(errorCode(error, 'PLUGIN_SCHEDULER_TICK_FAILED')); } catch {} }); }, intervalMs);
      timer.unref();
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      running = false;
      clearInterval(timer); timer = undefined;
      for (const controller of skipControllers.values()) controller.abort();
      stopping = (async () => { await calendar.stop(); await ticking; await Promise.allSettled([...skipPending.values()]); calendar = createCalendar(); })();
      const settled = () => { stopping = undefined; };
      stopping.then(settled, settled);
      return stopping;
    },
    status() { return snapshot({ running, handlers: handlers.size, rules: rows().length, history: historyRows().length, maxRules, maxHistory }); },
  });
}
export type PluginSchedulerService = ReturnType<typeof createPluginSchedulerService>;
