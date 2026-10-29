import { isRecord, reference } from './values.ts';

export interface PluginSchedulePresentation {
  readonly title: string;
  readonly description: string;
  readonly ownerLabel: string;
}
export type PluginSchedulePlan = { readonly kind: 'once'; readonly at: number }
  | { readonly kind: 'daily'; readonly hour: number; readonly minute: number }
  | { readonly kind: 'weekly'; readonly dayOfWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7; readonly hour: number; readonly minute: number };
export type PluginScheduleState = 'enabled' | 'disabled' | 'paused' | 'cancelled' | 'running' | 'completed' | 'failed' | 'unknown' | 'expired';
export interface PluginScheduleBusinessSummary { readonly stage: string; readonly summary: string }
export interface PluginScheduleHistoryItem {
  readonly cursor: string;
  readonly id: string;
  readonly owner: string;
  readonly ruleId: string;
  readonly presentation: PluginSchedulePresentation | null;
  readonly generation: number;
  readonly scheduledAt: number;
  readonly startedAt: number | null;
  readonly deadlineAt: number;
  readonly updatedAt: number;
  readonly coalescedCount: number;
  readonly status: 'running' | 'completed' | 'failed' | 'unknown';
  readonly errorCode: string | null;
  readonly business: PluginScheduleBusinessSummary | null;
}
export interface PluginScheduleItem {
  readonly cursor: string;
  readonly owner: string;
  readonly id: string;
  readonly handler: string;
  /** Opaque rule + management revision. Always send the exact displayed value. */
  readonly revision: string;
  readonly ruleRevision: number;
  readonly generation: number;
  readonly presentation: PluginSchedulePresentation | null;
  readonly schedule: PluginSchedulePlan;
  readonly timeZone: string;
  readonly windowMs: number;
  readonly activeFrom: number;
  readonly evaluatedThrough: number;
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly cancelled: boolean;
  readonly state: PluginScheduleState;
  readonly nextAt: number | null;
  readonly lastOccurrence: PluginScheduleHistoryItem | null;
  readonly business: PluginScheduleBusinessSummary | null;
  readonly managementState: 'ready' | 'skipping' | 'unknown';
  readonly actions: { readonly canPause: boolean; readonly canSkip: boolean };
}
export interface PluginScheduleSnapshot {
  readonly schema: 1;
  readonly available: boolean;
  readonly running: boolean;
  readonly items: readonly PluginScheduleItem[];
  readonly next: string | null;
  readonly summary: { readonly total: number; readonly paused: number; readonly pending: number; readonly running: number; readonly failed: number; readonly unknown: number };
  readonly limits: { readonly rules: number; readonly history: number };
}
export interface PluginScheduleHistorySnapshot {
  readonly schema: 1;
  readonly items: readonly PluginScheduleHistoryItem[];
  readonly next: string | null;
}
export interface PluginScheduleBusinessDetails {
  readonly stage: string;
  readonly summary: string;
  readonly sessionId: string | null;
  readonly canSkip: boolean;
  readonly steps?: readonly { readonly label: string; readonly state: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'unknown' }[];
  readonly result: { readonly title: string; readonly body: string;
    readonly images: readonly { readonly dataUrl: string; readonly alt: string }[] } | null;
}
export interface PluginScheduleDetail {
  readonly schema: 1;
  readonly item: PluginScheduleItem;
  readonly occurrence: PluginScheduleHistoryItem | null;
  readonly details: PluginScheduleBusinessDetails | null;
  readonly detailsAvailable: boolean;
  readonly detailsError: string | null;
}
export type PluginScheduleManagementRequest = {
  readonly owner: string; readonly id: string; readonly revision: string;
} & ({ readonly action: 'set-paused'; readonly paused: boolean } | { readonly action: 'skip' });
export interface PluginScheduleManagementResponse {
  readonly schema: 1; readonly ok: true;
  readonly action: PluginScheduleManagementRequest['action'];
  readonly item: PluginScheduleItem;
}
export interface PluginScheduleReadOptions { readonly owner?: string; readonly id?: string; readonly limit?: number; readonly after?: string }

const exact = (value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []) =>
  keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const timestamp = (value: unknown): value is number => count(value, 8_640_000_000_000_000);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000]/u.test(value);
const nullableReference = (value: unknown): value is string | null => value === null || reference(value);
const cursor = nullableReference;
const revision = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,15}:(?:0|[1-9]\d{0,15})$/.test(value)
  && value.split(':').every(part => count(Number(part)));
export function isPluginScheduleListCursor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^([0-8]):(none|0|[1-9]\d{0,15}):([a-f0-9]{64})$/.exec(value);
  return match !== null && (match[2] === 'none' || timestamp(Number(match[2])));
}
export function isPluginScheduleHistoryCursor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(0|[1-9]\d{0,15}):(calendar:[a-f0-9]{64})$/.exec(value);
  return match !== null && timestamp(Number(match[1]));
}

export function parsePluginSchedulePresentation(value: unknown): PluginSchedulePresentation | null {
  if (!isRecord(value) || !exact(value, ['title', 'description', 'ownerLabel'])
    || !text(value.title, 160) || !value.title.trim() || !text(value.description, 1000)
    || !text(value.ownerLabel, 120) || !value.ownerLabel.trim()) return null;
  return { title: value.title, description: value.description, ownerLabel: value.ownerLabel };
}
export function parsePluginScheduleBusinessSummary(value: unknown): PluginScheduleBusinessSummary | null {
  return isRecord(value) && exact(value, ['stage', 'summary']) && text(value.stage, 160) && text(value.summary, 4000)
    ? { stage: value.stage, summary: value.summary } : null;
}
export function parsePluginSchedulePlan(value: unknown): PluginSchedulePlan | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'once') return exact(value, ['kind', 'at']) && timestamp(value.at) ? { kind: 'once', at: value.at } : null;
  if ((value.kind !== 'daily' && value.kind !== 'weekly') || !count(value.hour, 23) || !count(value.minute, 59)) return null;
  if (value.kind === 'daily') return exact(value, ['kind', 'hour', 'minute']) ? { kind: 'daily', hour: value.hour, minute: value.minute } : null;
  return exact(value, ['kind', 'dayOfWeek', 'hour', 'minute']) && count(value.dayOfWeek, 7) && value.dayOfWeek >= 1
    ? { kind: 'weekly', dayOfWeek: value.dayOfWeek as 1 | 2 | 3 | 4 | 5 | 6 | 7, hour: value.hour, minute: value.minute } : null;
}
export function parsePluginScheduleHistoryItem(value: unknown): PluginScheduleHistoryItem | null {
  if (!isRecord(value) || !exact(value, ['cursor', 'id', 'owner', 'ruleId', 'presentation', 'generation', 'scheduledAt', 'startedAt', 'deadlineAt', 'updatedAt', 'coalescedCount', 'status', 'errorCode', 'business'])
    || ![value.cursor, value.id, value.owner, value.ruleId].every(reference) || !count(value.generation) || value.generation < 1
    || !timestamp(value.scheduledAt) || !timestamp(value.deadlineAt) || value.deadlineAt <= value.scheduledAt
    || value.startedAt !== null && !timestamp(value.startedAt) || !timestamp(value.updatedAt) || !count(value.coalescedCount, 1000)
    || !['running', 'completed', 'failed', 'unknown'].includes(String(value.status))
    || value.errorCode !== null && !text(value.errorCode, 128)) return null;
  const business = value.business === null ? null : parsePluginScheduleBusinessSummary(value.business);
  const presentation = value.presentation === null ? null : parsePluginSchedulePresentation(value.presentation);
  if (value.business !== null && !business || value.presentation !== null && !presentation) return null;
  return { cursor: String(value.cursor), id: String(value.id), owner: String(value.owner), ruleId: String(value.ruleId),
    presentation, generation: value.generation, scheduledAt: value.scheduledAt, startedAt: value.startedAt as number | null, deadlineAt: value.deadlineAt, updatedAt: value.updatedAt,
    coalescedCount: value.coalescedCount, status: value.status as PluginScheduleHistoryItem['status'], errorCode: value.errorCode as string | null, business };
}
export function parsePluginScheduleItem(value: unknown): PluginScheduleItem | null {
  if (!isRecord(value) || !exact(value, ['cursor', 'owner', 'id', 'handler', 'revision', 'ruleRevision', 'generation', 'presentation', 'schedule',
    'timeZone', 'windowMs', 'activeFrom', 'evaluatedThrough', 'enabled', 'paused', 'cancelled', 'state', 'nextAt', 'lastOccurrence', 'business', 'managementState', 'actions'])
    || ![value.cursor, value.owner, value.id, value.handler].every(reference) || !revision(value.revision)
    || !count(value.ruleRevision) || value.ruleRevision < 1 || !count(value.generation) || value.generation < 1
    || !text(value.timeZone, 100) || !value.timeZone || !count(value.windowMs, 8 * 86_400_000) || value.windowMs < 60_000
    || !timestamp(value.activeFrom) || typeof value.evaluatedThrough !== 'number' || !Number.isSafeInteger(value.evaluatedThrough) || value.evaluatedThrough < -1
    || !['enabled', 'disabled', 'paused', 'cancelled', 'running', 'completed', 'failed', 'unknown', 'expired'].includes(String(value.state))
    || ![value.enabled, value.paused, value.cancelled].every(item => typeof item === 'boolean')
    || value.nextAt !== null && !timestamp(value.nextAt)
    || !['ready', 'skipping', 'unknown'].includes(String(value.managementState))
    || !isRecord(value.actions) || !exact(value.actions, ['canPause', 'canSkip'])
    || typeof value.actions.canPause !== 'boolean' || typeof value.actions.canSkip !== 'boolean') return null;
  const schedule = parsePluginSchedulePlan(value.schedule);
  const presentation = value.presentation === null ? null : parsePluginSchedulePresentation(value.presentation);
  const lastOccurrence = value.lastOccurrence === null ? null : parsePluginScheduleHistoryItem(value.lastOccurrence);
  const business = value.business === null ? null : parsePluginScheduleBusinessSummary(value.business);
  if (!schedule || value.presentation !== null && !presentation || value.lastOccurrence !== null && !lastOccurrence
    || lastOccurrence && (lastOccurrence.owner !== value.owner || lastOccurrence.ruleId !== value.id)
    || value.business !== null && !business || value.revision.split(':')[0] !== String(value.ruleRevision)) return null;
  return { cursor: String(value.cursor), owner: String(value.owner), id: String(value.id), handler: String(value.handler), revision: value.revision,
    ruleRevision: value.ruleRevision, generation: value.generation, presentation, schedule, timeZone: value.timeZone,
    windowMs: value.windowMs, activeFrom: value.activeFrom, evaluatedThrough: value.evaluatedThrough,
    enabled: value.enabled as boolean, paused: value.paused as boolean, cancelled: value.cancelled as boolean,
    state: value.state as PluginScheduleState, nextAt: value.nextAt as number | null, lastOccurrence, business,
    managementState: value.managementState as PluginScheduleItem['managementState'], actions: { canPause: value.actions.canPause, canSkip: value.actions.canSkip } };
}
export function parsePluginScheduleSnapshot(value: unknown): PluginScheduleSnapshot | null {
  if (!isRecord(value) || !exact(value, ['schema', 'available', 'running', 'items', 'next', 'summary', 'limits']) || value.schema !== 1
    || typeof value.available !== 'boolean' || typeof value.running !== 'boolean' || !Array.isArray(value.items) || value.items.length > 200
    || value.next !== null && !isPluginScheduleListCursor(value.next) || !isRecord(value.summary) || !exact(value.summary, ['total', 'paused', 'pending', 'running', 'failed', 'unknown'])
    || !Object.values(value.summary).every(item => count(item, 1000))
    || !isRecord(value.limits) || !exact(value.limits, ['rules', 'history'])
    || !count(value.limits.rules, 1000) || value.limits.rules < 1 || !count(value.limits.history, 1000) || value.limits.history < 1) return null;
  const items: PluginScheduleItem[] = [];
  const seen = new Set<string>();
  for (const item of value.items) {
    const parsed = parsePluginScheduleItem(item);
    if (!parsed || seen.has(parsed.cursor)) return null;
    seen.add(parsed.cursor); items.push(parsed);
  }
  const summary = value.summary as unknown as PluginScheduleSnapshot['summary'];
  if (summary.total < items.length || [summary.paused, summary.pending, summary.running, summary.failed, summary.unknown].some(count => count > summary.total)) return null;
  return { schema: 1, available: value.available, running: value.running, items, next: value.next,
    summary: { total: summary.total, paused: summary.paused, pending: summary.pending, running: summary.running, failed: summary.failed, unknown: summary.unknown },
    limits: { rules: value.limits.rules, history: value.limits.history } };
}
export function parsePluginScheduleHistorySnapshot(value: unknown): PluginScheduleHistorySnapshot | null {
  if (!isRecord(value) || !exact(value, ['schema', 'items', 'next']) || value.schema !== 1
    || !Array.isArray(value.items) || value.items.length > 200 || value.next !== null && !isPluginScheduleHistoryCursor(value.next)) return null;
  const items: PluginScheduleHistoryItem[] = [];
  const seen = new Set<string>();
  for (const row of value.items) {
    const item = parsePluginScheduleHistoryItem(row);
    if (!item || seen.has(item.id)) return null;
    seen.add(item.id); items.push(item);
  }
  return { schema: 1, items, next: value.next };
}
export function parsePluginScheduleBusinessDetails(value: unknown): PluginScheduleBusinessDetails | null {
  if (!isRecord(value) || !exact(value, ['stage', 'summary', 'sessionId', 'canSkip', 'result'], ['steps'])
    || !text(value.stage, 160) || !text(value.summary, 4000) || !nullableReference(value.sessionId) || typeof value.canSkip !== 'boolean') return null;
  let steps: PluginScheduleBusinessDetails['steps'];
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps) || value.steps.length > 32) return null;
    const parsed: NonNullable<PluginScheduleBusinessDetails['steps']>[number][] = [];
    for (const step of value.steps) {
      if (!isRecord(step) || !exact(step, ['label', 'state']) || !text(step.label, 160)
        || !['pending', 'running', 'completed', 'failed', 'skipped', 'unknown'].includes(String(step.state))) return null;
      parsed.push({ label: step.label, state: step.state as NonNullable<PluginScheduleBusinessDetails['steps']>[number]['state'] });
    }
    steps = parsed;
  }
  let result: PluginScheduleBusinessDetails['result'] = null;
  if (value.result !== null) {
    if (!isRecord(value.result) || !exact(value.result, ['title', 'body', 'images']) || !text(value.result.title, 200)
      || !text(value.result.body, 64_000) || !Array.isArray(value.result.images) || value.result.images.length > 4) return null;
    const images: { dataUrl: string; alt: string }[] = [];
    for (const image of value.result.images) {
      if (!isRecord(image) || !exact(image, ['dataUrl', 'alt']) || !text(image.alt, 500) || typeof image.dataUrl !== 'string'
        || image.dataUrl.length > 349_600 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl)) return null;
      const data = image.dataUrl.slice(image.dataUrl.indexOf(',') + 1);
      const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
      if (data.length % 4 !== 0 || data.length / 4 * 3 - padding > 256 * 1024) return null;
      images.push({ dataUrl: image.dataUrl, alt: image.alt });
    }
    result = { title: value.result.title, body: value.result.body, images };
  }
  return { stage: value.stage, summary: value.summary, sessionId: value.sessionId, canSkip: value.canSkip,
    ...(steps === undefined ? {} : { steps }), result };
}
export function parsePluginScheduleDetail(value: unknown): PluginScheduleDetail | null {
  if (!isRecord(value) || !exact(value, ['schema', 'item', 'occurrence', 'details', 'detailsAvailable', 'detailsError']) || value.schema !== 1
    || typeof value.detailsAvailable !== 'boolean' || value.detailsError !== null && !text(value.detailsError, 128)) return null;
  const item = parsePluginScheduleItem(value.item);
  const occurrence = value.occurrence === null ? null : parsePluginScheduleHistoryItem(value.occurrence);
  const details = value.details === null ? null : parsePluginScheduleBusinessDetails(value.details);
  if (!item || value.occurrence !== null && !occurrence || value.details !== null && !details
    || occurrence && (occurrence.owner !== item.owner || occurrence.ruleId !== item.id)) return null;
  return { schema: 1, item, occurrence, details, detailsAvailable: value.detailsAvailable, detailsError: value.detailsError as string | null };
}
export function parsePluginScheduleManagementRequest(value: unknown): PluginScheduleManagementRequest | null {
  if (!isRecord(value) || !reference(value.owner) || !reference(value.id) || !revision(value.revision)) return null;
  if (value.action === 'skip') return exact(value, ['action', 'owner', 'id', 'revision'])
    ? { action: 'skip', owner: value.owner, id: value.id, revision: value.revision } : null;
  if (value.action !== 'set-paused' || !exact(value, ['action', 'owner', 'id', 'revision', 'paused']) || typeof value.paused !== 'boolean') return null;
  return { action: 'set-paused', owner: value.owner, id: value.id, revision: value.revision, paused: value.paused };
}
export function parsePluginScheduleManagementResponse(value: unknown): PluginScheduleManagementResponse | null {
  if (!isRecord(value) || !exact(value, ['schema', 'ok', 'action', 'item']) || value.schema !== 1 || value.ok !== true
    || value.action !== 'set-paused' && value.action !== 'skip') return null;
  const item = parsePluginScheduleItem(value.item);
  return item ? { schema: 1, ok: true, action: value.action, item } : null;
}
