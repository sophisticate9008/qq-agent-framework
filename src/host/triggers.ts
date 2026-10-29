import { setImmediate as nextTurn } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { Clock, JsonObject } from '../core/types.ts';
import { assert, errorCode, isRecord, reference, snapshot } from '../core/values.ts';
import { digest, json, object } from './data.ts';
import { withDeadline } from './deadlines.ts';
import type { DurableStore, StoredRecord } from './types.ts';

export type CalendarMisfirePolicy = 'skip' | 'coalesce';
export type CalendarOverlapPolicy = 'earlier' | 'later';
export interface CalendarDstPolicy {
  overlap: CalendarOverlapPolicy;
  nonexistent: 'skip';
}
export interface DailyCalendarSchedule {
  kind: 'daily';
  hour: number;
  minute: number;
}
export interface WeeklyCalendarSchedule {
  kind: 'weekly';
  dayOfWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  hour: number;
  minute: number;
}
export interface OnceCalendarSchedule {
  kind: 'once';
  at: number;
}
export type CalendarSchedule = OnceCalendarSchedule | DailyCalendarSchedule | WeeklyCalendarSchedule;
export interface CalendarTriggerInput {
  id: string;
  scope: string;
  timeZone: string;
  schedule: CalendarSchedule;
  dst: CalendarDstPolicy;
  misfire: CalendarMisfirePolicy;
  windowMs: number;
  payload: JsonObject;
  enabled?: boolean;
}
export interface CalendarTriggerUpdate {
  enabled?: boolean;
  scope?: string;
  timeZone?: string;
  schedule?: CalendarSchedule;
  dst?: CalendarDstPolicy;
  misfire?: CalendarMisfirePolicy;
  windowMs?: number;
  payload?: JsonObject;
}
export interface CalendarTriggerOccurrence {
  readonly id: string;
  readonly ruleId: string;
  readonly generation: number;
  readonly scope: string;
  readonly scheduledAt: number;
  readonly deadlineAt: number;
  readonly coalescedCount: number;
  readonly payload: JsonObject;
  readonly signal: AbortSignal;
}
export type CalendarTriggerCallback = (occurrence: CalendarTriggerOccurrence) => void | Promise<void>;
export type CalendarOccurrenceStatus = 'running' | 'completed' | 'failed' | 'unknown';
export interface CalendarTriggerMetadata {
  cursor: string;
  id: string;
  scope: string;
  timeZone: string;
  schedule: CalendarSchedule;
  dst: CalendarDstPolicy;
  misfire: CalendarMisfirePolicy;
  windowMs: number;
  generation: number;
  enabled: boolean;
  cancelled: boolean;
  activeFrom: number;
  evaluatedThrough: number;
}
export interface CalendarOccurrenceMetadata {
  cursor: string;
  id: string;
  ruleId: string;
  generation: number;
  scheduledAt: number;
  deadlineAt: number;
  coalescedCount: number;
  status: CalendarOccurrenceStatus;
  errorCode: string | null;
}

interface StoredRule extends Omit<CalendarTriggerInput, 'enabled'> {
  schema: 1;
  generation: number;
  enabled: boolean;
  cancelled: boolean;
  activeFrom: number;
  evaluatedThrough: number;
  createdAt: number;
  updatedAt: number;
}

interface StoredOccurrence {
  schema: 1;
  id: string;
  ruleId: string;
  generation: number;
  scheduledAt: number;
  deadlineAt: number;
  coalescedCount: number;
  payloadDigest: string;
  status: CalendarOccurrenceStatus;
  errorCode: string | null;
  /** Actual claim time; absent in historical records, never inferred from scheduledAt. */
  startedAt?: number;
  updatedAt: number;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const ruleNamespace = 'calendar-triggers';
const occurrenceNamespace = 'calendar-trigger-occurrences';
const minuteMs = 60_000;
const dayMs = 86_400_000;
const maxWindowMs = 8 * dayMs;
const maxPayloadBytes = 64 * 1024;
const formatters = new Map<string, Intl.DateTimeFormat>();
// These caches contain only calendar calculations, never rule state or execution evidence.
const resolvedLocalTimes = new Map<string, number | null>();
const nextScheduledTimes = new Map<string, number | null>();

function cacheTime(cache: Map<string, number | null>, key: string, value: number | null, limit: number) {
  if (cache.size >= limit) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
    formatters.set(timeZone, value);
  }
  return value;
}

function canonicalTimeZone(value: unknown) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 100,
    'INVALID_CALENDAR_TRIGGER', 'A valid IANA time zone is required.');
  try {
    return formatter(value).resolvedOptions().timeZone;
  } catch {
    assert(false, 'INVALID_CALENDAR_TRIGGER', 'A valid IANA time zone is required.');
  }
}

function finiteTimestamp(value: unknown, code = 'INVALID_STORED_DATA'): asserts value is number {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime()),
    code, 'A finite calendar timestamp is required.');
}

function localParts(timestamp: number, timeZone: string): LocalParts {
  const values: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(timestamp)) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  const result = {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
  assert(Object.values(result).every(Number.isSafeInteger), 'INVALID_CALENDAR_TIME', 'The calendar time could not be resolved.');
  return result;
}

function sameLocal(left: LocalParts, right: LocalParts) {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute;
}

function localEpoch(parts: LocalParts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function resolveLocal(parts: LocalParts, timeZone: string, overlap: CalendarOverlapPolicy) {
  const key = JSON.stringify([timeZone, overlap, parts.year, parts.month, parts.day, parts.hour, parts.minute]);
  if (resolvedLocalTimes.has(key)) return resolvedLocalTimes.get(key)!;
  const target = localEpoch(parts);
  const candidates = new Set<number>();
  for (let sample = target - 2 * dayMs; sample <= target + 2 * dayMs; sample += 3 * 60 * minuteMs) {
    const candidate = target - (localEpoch(localParts(sample, timeZone)) - sample);
    if (sameLocal(localParts(candidate, timeZone), parts)) candidates.add(candidate);
  }
  const ordered = [...candidates].sort((left, right) => left - right);
  return cacheTime(resolvedLocalTimes, key, overlap === 'earlier' ? ordered[0] ?? null : ordered.at(-1) ?? null, 4096);
}

function validateSchedule(value: unknown): CalendarSchedule {
  if (isRecord(value) && value.kind === 'once') {
    finiteTimestamp(value.at, 'INVALID_CALENDAR_TRIGGER');
    return snapshot({ kind: 'once', at: value.at });
  }
  assert(isRecord(value) && (value.kind === 'daily' || value.kind === 'weekly')
    && Number.isSafeInteger(value.hour) && Number(value.hour) >= 0 && Number(value.hour) <= 23
    && Number.isSafeInteger(value.minute) && Number(value.minute) >= 0 && Number(value.minute) <= 59,
  'INVALID_CALENDAR_TRIGGER', 'An absolute instant or fixed daily or weekly calendar time is required.');
  if (value.kind === 'weekly') {
    assert(Number.isSafeInteger(value.dayOfWeek) && Number(value.dayOfWeek) >= 1 && Number(value.dayOfWeek) <= 7,
      'INVALID_CALENDAR_TRIGGER', 'Weekly dayOfWeek must use ISO Monday=1 through Sunday=7.');
    return snapshot({ kind: 'weekly', dayOfWeek: value.dayOfWeek as WeeklyCalendarSchedule['dayOfWeek'],
      hour: Number(value.hour), minute: Number(value.minute) });
  }
  return snapshot({ kind: 'daily', hour: Number(value.hour), minute: Number(value.minute) });
}

function validateDst(value: unknown): CalendarDstPolicy {
  assert(isRecord(value) && (value.overlap === 'earlier' || value.overlap === 'later') && value.nonexistent === 'skip',
    'INVALID_CALENDAR_TRIGGER', 'DST overlap and nonexistent-time policies are required.');
  return snapshot({ overlap: value.overlap, nonexistent: 'skip' });
}

function validatePayload(value: unknown) {
  const payload = snapshot(value);
  assert(isRecord(payload) && Buffer.byteLength(JSON.stringify(payload)) <= maxPayloadBytes,
    'INVALID_CALENDAR_TRIGGER', 'Trigger payload must be a bounded JSON object.');
  return payload as JsonObject;
}

function normalizedInput(value: CalendarTriggerInput): Required<CalendarTriggerInput> {
  const copy = snapshot(value);
  assert(reference(copy.id) && reference(copy.scope)
    && (copy.misfire === 'skip' || copy.misfire === 'coalesce')
    && Number.isSafeInteger(copy.windowMs) && copy.windowMs >= minuteMs && copy.windowMs <= maxWindowMs
    && (copy.enabled === undefined || typeof copy.enabled === 'boolean'),
  'INVALID_CALENDAR_TRIGGER', 'A bounded, scoped calendar trigger is required.');
  return snapshot({
    id: copy.id,
    scope: copy.scope,
    timeZone: canonicalTimeZone(copy.timeZone),
    schedule: validateSchedule(copy.schedule),
    dst: validateDst(copy.dst),
    misfire: copy.misfire,
    windowMs: copy.windowMs,
    payload: validatePayload(copy.payload),
    enabled: copy.enabled ?? true
  });
}

function rule(record: StoredRecord): StoredRule {
  const value = object(record.value);
  assert(value.schema === 1 && reference(value.id) && value.id === record.key && reference(value.scope)
    && typeof value.timeZone === 'string' && (value.misfire === 'skip' || value.misfire === 'coalesce')
    && Number.isSafeInteger(value.windowMs) && Number(value.windowMs) >= minuteMs && Number(value.windowMs) <= maxWindowMs
    && Number.isSafeInteger(value.generation) && Number(value.generation) >= 1
    && typeof value.enabled === 'boolean' && typeof value.cancelled === 'boolean',
  'INVALID_STORED_DATA', 'Stored calendar trigger data is invalid.');
  finiteTimestamp(value.activeFrom);
  finiteTimestamp(value.createdAt);
  finiteTimestamp(value.updatedAt);
  assert(typeof value.evaluatedThrough === 'number' && Number.isSafeInteger(value.evaluatedThrough) && value.evaluatedThrough >= -1,
    'INVALID_STORED_DATA', 'Stored calendar trigger progress is invalid.');
  return {
    schema: 1,
    id: value.id,
    scope: value.scope,
    timeZone: canonicalTimeZone(value.timeZone),
    schedule: validateSchedule(value.schedule),
    dst: validateDst(value.dst),
    misfire: value.misfire,
    windowMs: value.windowMs,
    payload: validatePayload(value.payload),
    generation: value.generation,
    enabled: value.enabled,
    cancelled: value.cancelled,
    activeFrom: value.activeFrom,
    evaluatedThrough: value.evaluatedThrough,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  } as StoredRule;
}

function occurrence(record: StoredRecord): StoredOccurrence {
  const value = object(record.value);
  assert(value.schema === 1 && reference(value.id) && value.id === record.key && reference(value.ruleId)
    && Number.isSafeInteger(value.generation) && Number(value.generation) >= 1
    && Number.isSafeInteger(value.coalescedCount) && Number(value.coalescedCount) >= 0
    && typeof value.payloadDigest === 'string' && /^[a-f0-9]{64}$/.test(value.payloadDigest)
    && ['running', 'completed', 'failed', 'unknown'].includes(String(value.status))
    && (value.errorCode === null || typeof value.errorCode === 'string'),
  'INVALID_STORED_DATA', 'Stored calendar occurrence data is invalid.');
  finiteTimestamp(value.scheduledAt);
  finiteTimestamp(value.deadlineAt);
  finiteTimestamp(value.updatedAt);
  if (value.startedAt !== undefined) finiteTimestamp(value.startedAt);
  assert(value.deadlineAt > value.scheduledAt, 'INVALID_STORED_DATA', 'Stored calendar occurrence window is invalid.');
  return value as unknown as StoredOccurrence;
}

function isoDay(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (value === 0 ? 7 : value) as WeeklyCalendarSchedule['dayOfWeek'];
}

function scheduledBetween(value: Pick<StoredRule, 'schedule' | 'timeZone' | 'dst'>, from: number, through: number) {
  if (value.schedule.kind === 'once') {
    return value.schedule.at >= from && value.schedule.at <= through ? [value.schedule.at] : [];
  }
  const first = localParts(Math.max(0, from - dayMs), value.timeZone);
  const last = localParts(through + dayMs, value.timeZone);
  const start = Date.UTC(first.year, first.month - 1, first.day);
  const end = Date.UTC(last.year, last.month - 1, last.day);
  const result: number[] = [];
  for (let date = start; date <= end; date += dayMs) {
    const point = new Date(date);
    const year = point.getUTCFullYear();
    const month = point.getUTCMonth() + 1;
    const day = point.getUTCDate();
    if (value.schedule.kind === 'weekly' && isoDay(year, month, day) !== value.schedule.dayOfWeek) continue;
    const resolved = resolveLocal({ year, month, day, hour: value.schedule.hour, minute: value.schedule.minute },
      value.timeZone, value.dst.overlap);
    if (resolved !== null && resolved >= from && resolved <= through) result.push(resolved);
  }
  return [...new Set(result)].sort((left, right) => left - right);
}

function nextScheduledAt(value: Pick<StoredRule, 'schedule' | 'timeZone' | 'dst'>, from: number): number | null {
  if (value.schedule.kind === 'once') return value.schedule.at >= from ? value.schedule.at : null;
  const schedule = value.schedule;
  const key = JSON.stringify([value.timeZone, value.dst.overlap, schedule.kind,
    schedule.kind === 'weekly' ? schedule.dayOfWeek : null, schedule.hour, schedule.minute, from]);
  if (nextScheduledTimes.has(key)) return nextScheduledTimes.get(key)!;
  const through = from + 16 * dayMs;
  finiteTimestamp(through, 'INVALID_CALENDAR_TIME');
  return cacheTime(nextScheduledTimes, key, scheduledBetween(value, from, through)[0] ?? null, 1024);
}

/** Read-only next occurrence calculation shared by management projections and the scheduler. */
export function nextCalendarTriggerAt(input: Pick<CalendarTriggerInput, 'schedule' | 'timeZone' | 'dst'>, after: number): number | null {
  finiteTimestamp(after, 'INVALID_CALENDAR_TIME')
  const value = { schedule: validateSchedule(input.schedule), timeZone: canonicalTimeZone(input.timeZone), dst: validateDst(input.dst) }
  return nextScheduledAt(value, after + 1)
}

function occurrenceId(ruleId: string, generation: number, scheduledAt: number) {
  return `calendar:${digest({ ruleId, generation, scheduledAt })}`;
}

export function createCalendarTriggerService({ store, callback, clock = Date.now, maxScan = 1000,
  callbackTimeoutMs = 30_000, maxPendingCallbacks = 16, retentionMs = 30 * dayMs, retainUnknown = false, isReady }:
  { store: DurableStore; callback: CalendarTriggerCallback; clock?: Clock; maxScan?: number;
    callbackTimeoutMs?: number; maxPendingCallbacks?: number; retentionMs?: number; retainUnknown?: boolean;
    isReady?: (ruleId: string) => boolean }) {
  assert(store && typeof store === 'object' && typeof callback === 'function',
    'INVALID_CALENDAR_OPTIONS', 'A durable store and callback are required.');
  assert(Number.isSafeInteger(maxScan) && maxScan >= 1 && maxScan <= 10_000
    && Number.isSafeInteger(callbackTimeoutMs) && callbackTimeoutMs >= 10 && callbackTimeoutMs <= 3_600_000
    && Number.isSafeInteger(maxPendingCallbacks) && maxPendingCallbacks >= 1 && maxPendingCallbacks <= 256
    && Number.isSafeInteger(retentionMs) && retentionMs >= minuteMs && retentionMs <= 366 * dayMs,
  'INVALID_CALENDAR_OPTIONS', 'Finite scan, callback, pending, and retention limits are required.');
  const active = new Map<string, { controller: AbortController; ruleId: string; generation: number }>();
  let pendingCallbacks = 0;
  let stopped = false;
  let cursor: string | undefined;
  let ticking: Promise<Readonly<{ scanned: number; attempted: number; completed: number; failed: number;
    unknown: number; skipped: number; backpressured: number }>> | null = null;

  function currentTime() {
    const value = clock();
    finiteTimestamp(value, 'CALENDAR_CLOCK_INVALID');
    return value;
  }

  function editable() {
    assert(!stopped, 'CALENDAR_TRIGGER_STOPPED', 'The calendar trigger service is stopped.');
  }

  function abortRule(ruleId: string, generation: number) {
    for (const entry of active.values()) {
      if (entry.ruleId === ruleId && entry.generation === generation) entry.controller.abort();
    }
  }

  function persistTerminal(record: StoredRecord, status: Exclude<CalendarOccurrenceStatus, 'running'>, failure: string | null) {
    const now = currentTime();
    try {
      store.write(occurrenceNamespace, record.key, json({ ...occurrence(record), status, errorCode: failure, updatedAt: now }),
        { expectedRevision: record.revision, expiresAt: retainUnknown && status === 'unknown' ? null : now + retentionMs });
    } catch (error) {
      if (errorCode(error) !== 'STORE_CONFLICT') throw error;
    }
  }

  function advance(record: StoredRecord, through: number) {
    const value = rule(record);
    if (through <= value.evaluatedThrough) return;
    try {
      store.write(ruleNamespace, record.key, json({ ...value, evaluatedThrough: through, updatedAt: currentTime() }),
        { expectedRevision: record.revision });
    } catch (error) {
      if (errorCode(error) !== 'STORE_CONFLICT') throw error;
    }
  }

  async function invoke(record: StoredRecord, value: StoredRule, scheduledAt: number, coalescedCount: number) {
    const startedAt = currentTime();
    const deadlineAt = Math.min(scheduledAt + value.windowMs, startedAt + callbackTimeoutMs);
    const controller = new AbortController();
    active.set(record.key, { controller, ruleId: value.id, generation: value.generation });
    const timeoutMs = Math.max(1, Math.ceil(deadlineAt - startedAt));
    try {
      await withDeadline({ signal: controller.signal, timeoutMs, code: 'CALENDAR_CALLBACK_TIMEOUT_UNKNOWN', run: signal => {
        pendingCallbacks++;
        let result: void | Promise<void>;
        try {
          result = callback(Object.freeze({
            id: record.key,
            ruleId: value.id,
            generation: value.generation,
            scope: value.scope,
            scheduledAt,
            deadlineAt,
            coalescedCount,
            payload: snapshot(value.payload),
            signal
          }));
        } catch (error) {
          pendingCallbacks--;
          throw error;
        }
        const raw = Promise.resolve(result);
        raw.then(() => { pendingCallbacks--; }, () => { pendingCallbacks--; });
        return raw;
      } });
      persistTerminal(record, 'completed', null);
      return 'completed' as const;
    } catch (error) {
      const failure = errorCode(error, 'CALENDAR_CALLBACK_FAILED');
      const status = failure.includes('UNKNOWN') ? 'unknown' as const : 'failed' as const;
      persistTerminal(record, status, failure);
      return status;
    } finally {
      active.delete(record.key);
    }
  }

  function prepare(value: StoredRule, scheduledAt: number, coalescedCount: number) {
    const id = occurrenceId(value.id, value.generation, scheduledAt);
    const existing = store.read(occurrenceNamespace, id);
    if (existing) {
      const previous = occurrence(existing);
      assert(previous.ruleId === value.id && previous.generation === value.generation && previous.scheduledAt === scheduledAt,
        'INVALID_STORED_DATA', 'Stored calendar occurrence identity conflicts.');
      return null;
    }
    const now = currentTime();
    try {
      return store.write(occurrenceNamespace, id, json({
        schema: 1,
        id,
        ruleId: value.id,
        generation: value.generation,
        scheduledAt,
        deadlineAt: scheduledAt + value.windowMs,
        coalescedCount,
        payloadDigest: digest(value.payload),
        status: 'running',
        errorCode: null,
        startedAt: now,
        updatedAt: now
      }), { expectedRevision: null });
    } catch (error) {
      if (errorCode(error) !== 'STORE_CONFLICT') throw error;
      return null;
    }
  }

  async function runTick(limit: number) {
    await Promise.resolve();
    const now = currentTime();
    const report = { scanned: 0, attempted: 0, completed: 0, failed: 0, unknown: 0,
      skipped: 0, backpressured: 0 };
    let yieldedAt = performance.now();
    while (!stopped && report.scanned < maxScan && report.attempted < limit) {
      if (report.scanned > 0 && (report.scanned % 64 === 0 || performance.now() - yieldedAt >= 4)) {
        await nextTurn();
        yieldedAt = performance.now();
        if (stopped) break;
      }
      const batch = store.list(ruleNamespace, cursor === undefined ? { limit: 1 } : { limit: 1, after: cursor });
      if (!batch.length) {
        cursor = undefined;
        break;
      }
      const record = batch[0];
      cursor = record.key;
      report.scanned++;
      const value = rule(record);
      if (!value.enabled || value.cancelled || value.evaluatedThrough >= now) continue;
      const unevaluatedFrom = Math.max(value.activeFrom, value.evaluatedThrough + 1);
      const first = nextScheduledAt(value, unevaluatedFrom);
      // Nothing can be replayed within an empty interval. Persist progress when an actual
      // occurrence is handled or skipped, so rollback/restart still cannot revive it.
      if (first === null || first > now) continue;
      const from = Math.max(unevaluatedFrom, now - value.windowMs + 1);
      const due = scheduledBetween(value, from, now).filter(scheduledAt => scheduledAt + value.windowMs > now);
      if (!due.length) {
        advance(record, now);
        continue;
      }
      if (isReady && !isReady(value.id)) continue;
      const scheduledAt = due[due.length - 1];
      report.skipped += due.length - 1;
      if (pendingCallbacks >= maxPendingCallbacks) {
        report.backpressured++;
        continue;
      }
      const intent = prepare(value, scheduledAt, value.misfire === 'coalesce' ? due.length - 1 : 0);
      if (!intent) {
        advance(record, now);
        continue;
      }
      report.attempted++;
      const status = await invoke(intent, value, scheduledAt, value.misfire === 'coalesce' ? due.length - 1 : 0);
      report[status]++;
      advance(record, now);
    }
    return snapshot(report);
  }

  return Object.freeze({
    register(input: CalendarTriggerInput) {
      editable();
      const value = normalizedInput(input);
      const now = currentTime();
      store.write(ruleNamespace, value.id, json({
        schema: 1,
        ...value,
        generation: 1,
        cancelled: false,
        activeFrom: now,
        evaluatedThrough: Math.max(-1, now - 1),
        createdAt: now,
        updatedAt: now
      }), { expectedRevision: null });
      return value.id;
    },
    update(id: string, changes: CalendarTriggerUpdate) {
      editable();
      assert(reference(id) && changes !== null && typeof changes === 'object' && !Array.isArray(changes),
        'INVALID_CALENDAR_TRIGGER', 'A trigger id and update are required.');
      const current = store.read(ruleNamespace, id);
      assert(current, 'CALENDAR_TRIGGER_NOT_FOUND', 'The calendar trigger does not exist.');
      const previous = rule(current);
      assert(!previous.cancelled, 'CALENDAR_TRIGGER_CANCELLED', 'A cancelled calendar trigger cannot be updated.');
      const keys = Object.keys(changes);
      assert(keys.length > 0 && keys.every(key => ['scope', 'timeZone', 'schedule', 'dst', 'misfire', 'windowMs', 'payload', 'enabled'].includes(key)),
        'INVALID_CALENDAR_TRIGGER', 'The calendar trigger update is invalid.');
      const value = normalizedInput({
        id,
        scope: changes.scope ?? previous.scope,
        timeZone: changes.timeZone ?? previous.timeZone,
        schedule: changes.schedule ?? previous.schedule,
        dst: changes.dst ?? previous.dst,
        misfire: changes.misfire ?? previous.misfire,
        windowMs: changes.windowMs ?? previous.windowMs,
        payload: changes.payload ?? previous.payload,
        enabled: changes.enabled ?? previous.enabled
      });
      const now = currentTime();
      store.write(ruleNamespace, id, json({ ...previous, ...value, generation: previous.generation + 1,
        activeFrom: now, evaluatedThrough: Math.max(-1, now - 1), updatedAt: now }), { expectedRevision: current.revision });
      abortRule(id, previous.generation);
      return previous.generation + 1;
    },
    setEnabled(id: string, enabled: boolean) {
      editable();
      assert(reference(id) && typeof enabled === 'boolean', 'INVALID_CALENDAR_TRIGGER', 'A trigger id and enabled state are required.');
      const current = store.read(ruleNamespace, id);
      assert(current, 'CALENDAR_TRIGGER_NOT_FOUND', 'The calendar trigger does not exist.');
      const previous = rule(current);
      assert(!previous.cancelled, 'CALENDAR_TRIGGER_CANCELLED', 'A cancelled calendar trigger cannot be enabled.');
      if (previous.enabled === enabled) return false;
      const now = currentTime();
      store.write(ruleNamespace, id, json({ ...previous, enabled, generation: previous.generation + 1,
        activeFrom: now, evaluatedThrough: Math.max(-1, now - 1), updatedAt: now }), { expectedRevision: current.revision });
      abortRule(id, previous.generation);
      return true;
    },
    cancel(id: string) {
      editable();
      assert(reference(id), 'INVALID_CALENDAR_TRIGGER', 'A trigger id is required.');
      const current = store.read(ruleNamespace, id);
      if (!current) return false;
      const previous = rule(current);
      if (previous.cancelled) return false;
      const now = currentTime();
      store.write(ruleNamespace, id, json({ ...previous, enabled: false, cancelled: true,
        generation: previous.generation + 1, updatedAt: now }), { expectedRevision: current.revision });
      abortRule(id, previous.generation);
      return true;
    },
    tick({ limit = 16 }: { limit?: number } = {}) {
      editable();
      assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
        'INVALID_CALENDAR_LIMIT', 'A finite trigger limit is required.');
      if (ticking) return ticking;
      ticking = runTick(limit);
      const settled = () => { ticking = null; };
      ticking.then(settled, settled);
      return ticking;
    },
    recoverInterrupted({ limit = 100, after }: { limit?: number; after?: string } = {}) {
      editable();
      assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000 && (after === undefined || reference(after)),
        'INVALID_CALENDAR_LIMIT', 'A finite recovery page is required.');
      const batch = store.list(occurrenceNamespace, after === undefined ? { limit } : { limit, after });
      let recovered = 0;
      for (const record of batch) {
        const value = occurrence(record);
        if (value.status !== 'running' || active.has(record.key)) continue;
        persistTerminal(record, 'unknown', 'CALENDAR_TRIGGER_INTERRUPTED_UNKNOWN');
        recovered++;
      }
      return snapshot({ recovered, next: batch.length === limit ? batch.at(-1)!.key : null });
    },
    list({ limit = 100, after }: { limit?: number; after?: string } = {}): readonly CalendarTriggerMetadata[] {
      assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000,
        'INVALID_CALENDAR_LIMIT', 'A finite trigger list limit is required.');
      return snapshot(store.list(ruleNamespace, after === undefined ? { limit } : { limit, after }).map(record => {
        const value = rule(record);
        return { cursor: record.key, id: value.id, scope: value.scope, timeZone: value.timeZone,
          schedule: value.schedule, dst: value.dst, misfire: value.misfire, windowMs: value.windowMs,
          generation: value.generation, enabled: value.enabled, cancelled: value.cancelled,
          activeFrom: value.activeFrom, evaluatedThrough: value.evaluatedThrough };
      }));
    },
    listOccurrences({ limit = 100, after }: { limit?: number; after?: string } = {}): readonly CalendarOccurrenceMetadata[] {
      assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000,
        'INVALID_CALENDAR_LIMIT', 'A finite occurrence list limit is required.');
      return snapshot(store.list(occurrenceNamespace, after === undefined ? { limit } : { limit, after }).map(record => {
        const value = occurrence(record);
        return { cursor: record.key, id: value.id, ruleId: value.ruleId, generation: value.generation,
          scheduledAt: value.scheduledAt, deadlineAt: value.deadlineAt, coalescedCount: value.coalescedCount,
          status: value.status, errorCode: value.errorCode };
      }));
    },
    metrics() {
      return snapshot({ pendingCallbacks, activeCallbacks: active.size, stopped });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const entry of active.values()) entry.controller.abort();
      await ticking;
    }
  });
}
