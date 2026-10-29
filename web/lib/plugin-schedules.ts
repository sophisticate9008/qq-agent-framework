import type { PluginScheduleHistoryItem, PluginScheduleItem, PluginSchedulePlan, PluginScheduleState } from '../../src/contracts/plugin-schedules.ts';
import { ApiError, errorMessage } from './api.ts';

export const pluginSchedulesPath = '/api/chat/schedules';
export const scheduleKey = (item: Pick<PluginScheduleItem, 'owner' | 'id'>) => JSON.stringify([item.owner, item.id]);
export const scheduleTitle = (item: PluginScheduleItem) => item.presentation?.title ?? '插件任务';
export const scheduleOwner = (item: PluginScheduleItem) => item.presentation?.ownerLabel ?? '已登记插件';

const states: Readonly<Record<PluginScheduleState, string>> = {
  enabled: '待执行', disabled: '未启用', paused: '已暂停', cancelled: '已取消', running: '执行中',
  completed: '调度已结束', failed: '执行异常', unknown: '结果待核对', expired: '已过期',
};
export function scheduleStateLabel(item: PluginScheduleItem): string {
  if (item.managementState === 'unknown') return '操作待核对';
  if (item.managementState === 'skipping') return '正在跳过';
  return states[item.state];
}
export function scheduleHistoryStateLabel(state: PluginScheduleHistoryItem['status']): string {
  return { running: '执行中', completed: '调度已结束', failed: '执行异常', unknown: '结果待核对' }[state];
}
export function scheduleTone(state: PluginScheduleState): 'success' | 'warning' | 'neutral' | 'info' {
  return state === 'failed' || state === 'unknown' ? 'warning' : state === 'running' ? 'info' : state === 'completed' ? 'success' : 'neutral';
}
export function scheduleTime(time: number | null, full = false): string {
  if (time === null) return '—';
  return new Date(time).toLocaleString('zh-CN', { ...(full ? { year: 'numeric' } : {}), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(full ? { second: '2-digit' } : {}), hour12: false });
}
export function scheduleDuration(item: PluginScheduleHistoryItem): string {
  if (item.startedAt === null || !['completed', 'failed'].includes(item.status) || item.updatedAt < item.startedAt) return '—';
  const seconds = (item.updatedAt - item.startedAt) / 1_000;
  return seconds < 60 ? `${seconds.toFixed(1)} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
}
export function schedulePlanLabel(plan: PluginSchedulePlan): string {
  if (plan.kind === 'once') return `单次 · ${scheduleTime(plan.at, true)}`;
  const time = `${String(plan.hour).padStart(2, '0')}:${String(plan.minute).padStart(2, '0')}`;
  return plan.kind === 'daily' ? `每天 ${time}` : `每周${'一二三四五六日'[plan.dayOfWeek - 1]} ${time}`;
}
export function scheduleManagementError(error: unknown): string {
  if (error instanceof ApiError) {
    if (/conflict|revision|stale/i.test(error.code)) return '日程或管理状态已变化，请刷新后重新选择。';
    if (/unsupported|not_supported|skip_unavailable/i.test(error.code)) return '此任务当前不支持该操作，请刷新状态核对。';
    if (/unknown|unsettled/i.test(error.code)) return '原操作的结果尚未确认，请查看详情并核对，暂不提交新的操作。';
    if (/running|busy|skipping/i.test(error.code)) return '此任务仍在处理，请核对执行状态后再操作。';
    if (/unavailable/i.test(error.code)) return '日程服务或所属插件暂时不可用，请检查运行状态。';
  }
  return errorMessage(error);
}
export function scheduleListPath(after: string | null, owner = ''): string {
  const query = new URLSearchParams({ limit: '100' });
  if (after) query.set('after', after);
  if (owner) query.set('owner', owner);
  return `${pluginSchedulesPath}?${query}`;
}
export function scheduleHistoryPath(after: string | null, owner = ''): string {
  const query = new URLSearchParams({ limit: '100' });
  if (after) query.set('after', after);
  if (owner) query.set('owner', owner);
  return `${pluginSchedulesPath}/history?${query}`;
}
