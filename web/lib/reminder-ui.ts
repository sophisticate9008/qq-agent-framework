import { validateNativeReminderConfiguration, type NativeReminderConfiguration, type NativeReminderOutcome, type NativeReminderSnapshot } from '../../src/contracts/native-reminders.ts';

export interface ReminderDraft {
  readonly conversationId: string; readonly text: string; readonly timeZone: string;
  readonly kind: 'once' | 'delay' | 'daily' | 'weekly'; readonly onceAt: string; readonly delayMinutes: string;
  readonly onceOriginalAt: number | null; readonly onceOriginalKey: string;
  readonly time: string; readonly dayOfWeek: string; readonly enabled: boolean;
}

function wallParts(at: number, timeZone: string): readonly number[] {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  return ['year', 'month', 'day', 'hour', 'minute'].map(type => Number(parts.find(part => part.type === type)?.value));
}

/** Repeated or skipped DST wall times require a different explicit time rather than an inferred offset. */
export function reminderWallTime(value: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('请选择完整的执行日期和时间。');
  const expected = match.slice(1).map(Number);
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0] = expected;
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) throw new Error('执行日期或时间无效。');
  const base = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sample = base + hours * 3_600_000;
    const [y = 0, m = 0, d = 0, h = 0, n = 0] = wallParts(sample, timeZone);
    offsets.add(Date.UTC(y, m - 1, d, h, n) - sample);
  }
  const candidates = [...offsets].map(offset => base - offset)
    .filter(at => wallParts(at, timeZone).every((part, index) => part === expected[index]));
  if (candidates.length === 0) throw new Error('该时区中不存在此日期或时间，请检查日期及夏令时切换。');
  if (candidates.length > 1) throw new Error('该时区的夏令时切换使此时间重复，请明确选择另一个执行时间。');
  const result = candidates[0];
  if (result === undefined) throw new Error('执行时间无效。');
  return result;
}

export function reminderDraft(configuration?: NativeReminderConfiguration): ReminderDraft {
  const timeZone = configuration?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const schedule = configuration?.schedule;
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0] = wallParts(schedule?.kind === 'once' ? schedule.at : Date.now() + 3_600_000, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  const onceAt = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
  return { conversationId: configuration?.conversationId ?? '', text: configuration?.text ?? '', timeZone,
    kind: schedule?.kind ?? 'delay', onceAt, onceOriginalAt: schedule?.kind === 'once' ? schedule.at : null,
    onceOriginalKey: schedule?.kind === 'once' ? `${timeZone}|${onceAt}` : '',
    delayMinutes: schedule?.kind === 'delay' ? String(schedule.delayMs / 60_000) : '60',
    time: schedule?.kind === 'daily' || schedule?.kind === 'weekly' ? `${pad(schedule.hour)}:${pad(schedule.minute)}` : '09:00',
    dayOfWeek: schedule?.kind === 'weekly' ? String(schedule.dayOfWeek) : '1', enabled: configuration?.enabled ?? false };
}

export function reminderConfiguration(draft: ReminderDraft): NativeReminderConfiguration {
  if (!/^\d{2}:\d{2}$/.test(draft.time)) throw new Error('请选择有效的时刻。');
  const [hour, minute] = draft.time.split(':').map(Number);
  const schedule = draft.kind === 'once' ? { kind: 'once' as const, at: draft.onceOriginalAt !== null && draft.onceOriginalKey === `${draft.timeZone.trim()}|${draft.onceAt}`
    ? draft.onceOriginalAt : reminderWallTime(draft.onceAt, draft.timeZone.trim()) }
    : draft.kind === 'delay' ? { kind: 'delay' as const, delayMs: Math.round(Number(draft.delayMinutes) * 60_000) }
      : draft.kind === 'daily' ? { kind: 'daily' as const, hour, minute }
        : { kind: 'weekly' as const, dayOfWeek: Number(draft.dayOfWeek), hour, minute };
  return validateNativeReminderConfiguration({ conversationId: draft.conversationId.trim(), text: draft.text.trim(), timeZone: draft.timeZone.trim(), schedule, enabled: draft.enabled });
}

export const reminderStateLabels: Readonly<Record<NativeReminderSnapshot['state'], string>> = {
  enabled: '已启用', disabled: '已停用', cancelled: '已取消', completed: '已完成', expired: '已过期', unknown: '发送结果待核对',
};
export const reminderOutcomeLabels: Readonly<Record<NativeReminderOutcome, string>> = {
  dispatching: '正在发送', confirmed: '已确认发送', rejected: '权限或发送条件不允许', failed: '发送失败', unknown: '发送结果未知，不自动重试', cancelled: '已取消',
};

export function reminderTime(at: number | null, timeZone: string): string {
  return at === null ? '暂无下一次执行' : new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
