import type { Clock, JsonObject } from '../core/types.ts';
import type { DurableStore, StoredRecord } from '../contracts/ports.ts';
import { FrameworkError, assert, errorCode, identifier, isRecord, reference, snapshot } from '../core/values.ts';
import { digest, object } from './data.ts';
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
}
export interface PluginScheduledRule extends Required<PluginScheduleInput> {
  readonly cursor: string;
  readonly revision: number;
  readonly generation: number;
  readonly cancelled: boolean;
  readonly activeFrom: number;
  readonly evaluatedThrough: number;
  readonly nextAt: number | null;
  readonly state: 'enabled' | 'disabled' | 'cancelled' | 'completed' | 'failed' | 'unknown' | 'expired';
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
  schedule(input: PluginScheduleInput, options?: PluginSchedulerCas): PluginScheduledRule;
  list(options?: PluginSchedulerPage): readonly PluginScheduledRule[];
  cancel(id: string, options?: PluginSchedulerCas): boolean;
  history(options?: PluginSchedulerPage & { readonly id?: string }): readonly PluginScheduledHistory[];
}

const prefix = 'plugin-scheduler.';
const rulesNamespace = prefix + 'calendar-triggers';
const historyNamespace = prefix + 'calendar-trigger-occurrences';
const retentionMs = 7 * 86_400_000;
const defaultDst = Object.freeze({ overlap: 'earlier' as const, nonexistent: 'skip' as const });

interface Envelope { owner: string; id: string; handler: string; payload: JsonObject }
interface HandlerEntry { handler: PluginScheduledHandler; lifetime: AbortSignal; controller: AbortController; check: () => void }
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
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let lastCleanupAt: number | undefined;
  const calendarStore: DurableStore = {
    ...store,
    read: (namespace, key) => store.read(prefix + namespace, key),
    write: (namespace, key, value, writeOptions) => store.write(prefix + namespace, key, value, writeOptions),
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
    const found = calendar.list({ limit: 1000 }).find(value => value.id === record.key);
    if (!found) fail('PLUGIN_SCHEDULER_RULE_MISSING');
    return found;
  }
  function projection(record: StoredRecord): PluginScheduledRule {
    const value = envelope(record);
    const rule = metadata(record);
    const history = historyRows().filter(row => object(row.value).ruleId === record.key
      && object(row.value).generation === rule.generation).sort((left, right) => Number(object(right.value).scheduledAt) - Number(object(left.value).scheduledAt));
    const last = history[0] ? object(history[0].value) : undefined;
    const now = clock();
    let state: PluginScheduledRule['state'] = rule.cancelled ? 'cancelled' : !rule.enabled ? 'disabled'
      : last?.status === 'unknown' || last?.status === 'running' ? 'unknown' : 'enabled';
    let nextAt: number | null = null;
    if (state === 'enabled') {
      if (rule.schedule.kind === 'once') {
        if (last?.status === 'completed' || last?.status === 'failed') state = last.status;
        else if (rule.schedule.at < rule.activeFrom || rule.schedule.at + rule.windowMs <= now) state = 'expired';
        else nextAt = rule.schedule.at;
      } else nextAt = nextCalendarTriggerAt(rule, Math.max(now - 1, rule.evaluatedThrough, rule.activeFrom - 1, 0));
    }
    return snapshot({ ...rule, id: value.id, revision: record.revision, handler: value.handler,
      payload: value.payload, state, nextAt });
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
      const retainAfter = value.cancelled ? Number(value.updatedAt)
        : Math.max(Number(value.activeFrom), Number(schedule.at) + Number(value.windowMs));
      if (retainAfter + retentionMs > now) continue;
      if (history.some(row => object(row.value).ruleId === record.key)) continue;
      store.delete(rulesNamespace, record.key, record.revision);
    }
    lastCleanupAt = now;
  }
  async function tick(): Promise<void> {
    if (!running) return;
    if (ticking) return ticking;
    ticking = (async () => { cleanup(); await calendar.tick({ limit: 32 }); })();
    try { await ticking; } finally { ticking = undefined; }
  }
  return Object.freeze({
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
        schedule(input, request = {}) {
          check();
          assert(reference(input.id) && identifier(input.handler) && isRecord(input.payload),
            'PLUGIN_SCHEDULER_INVALID_INPUT', 'A bounded identified plugin schedule is required.');
          cleanup(true);
          const current = read(input.id);
          cas(current, request);
          const desired = { scope: owner, timeZone: input.timeZone ?? 'UTC', schedule: input.schedule,
            dst: input.dst ?? defaultDst, misfire: input.misfire ?? 'skip' as const, windowMs: input.windowMs ?? 300_000,
            payload: { owner, id: input.id, handler: input.handler, payload: input.payload }, enabled: input.enabled ?? true };
          if (current) {
            const previous = object(current.value);
            const keys = ['scope', 'timeZone', 'schedule', 'dst', 'misfire', 'windowMs', 'payload', 'enabled'] as const;
            if (!previous.cancelled && digest(Object.fromEntries(keys.map(key => [key, previous[key]]))) === digest(desired)) return projection(current);
            if (request.expectedRevision === undefined || previous.cancelled) fail('PLUGIN_SCHEDULER_CONFLICT');
            calendar.update(current.key, desired);
          } else {
            if (rows().length >= maxRules) fail('PLUGIN_SCHEDULER_RULE_CAPACITY');
            calendar.register({ id: digest([owner, input.id]), ...desired });
          }
          return projection(read(input.id)!);
        },
        list(query = {}) {
          check();
          const { limit, after } = page(query);
          return snapshot(rows().filter(record => envelope(record).owner === owner && (after === undefined || record.key > after))
            .slice(0, limit).map(projection));
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
      stopping = (async () => { await calendar.stop(); await ticking; calendar = createCalendar(); })();
      const settled = () => { stopping = undefined; };
      stopping.then(settled, settled);
      return stopping;
    },
    status() { return snapshot({ running, handlers: handlers.size, rules: rows().length, history: historyRows().length, maxRules, maxHistory }); },
  });
}
export type PluginSchedulerService = ReturnType<typeof createPluginSchedulerService>;
