export type { AdminActivityState as ActivityState, AdminActivityType as ActivityType, AdminActivityEntry as ActivityEntry, AdminActivitySnapshot as RecentActivitySnapshot } from '../../src/contracts/admin-activity.ts';
import { parseAdminActivitySnapshot, type AdminActivityType as ActivityType, type AdminActivityState as ActivityState } from '../../src/contracts/admin-activity.ts';

export const parseRecentActivity = parseAdminActivitySnapshot;

export function activityTypeLabel(type: ActivityType): string {
  return { received: '收到消息', processed: '消息处理', sent: '发送回执', timeout: '处理超时', error: '发生异常', runtime: '运行状态' }[type];
}

export function activityTypeShortLabel(type: ActivityType): string {
  return { received: '收到', processed: '处理', sent: '发送', timeout: '超时', error: '异常', runtime: '状态' }[type];
}

export function activityConversationLabel(conversationId: string | null): string {
  if (conversationId === null) return '系统';
  const match = /^(group|private):([1-9][0-9]{0,19})$/.exec(conversationId);
  return match ? `${match[1] === 'group' ? '群聊' : '私聊'} ${match[2]}` : '会话';
}

export function activityStateLabel(state: ActivityState): string {
  return { stopped: '当前聊天宿主未启动；此处不读取其他桥接进程日志', starting: '聊天宿主正在启动', running: '聊天宿主运行中', stopping: '聊天宿主正在停止', error: '聊天宿主异常，请检查运行状态' }[state];
}
