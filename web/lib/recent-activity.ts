import { asRecord } from './api.ts';

export type ActivityState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type ActivityType = 'received' | 'processed' | 'sent' | 'timeout' | 'error' | 'runtime';

export interface ActivityEntry {
  readonly id: string;
  readonly at: number;
  readonly level: 'info' | 'warning' | 'error';
  readonly type: ActivityType;
  readonly conversationId: string | null;
  readonly summary: string;
  readonly content?: string | null;
}

export interface RecentActivitySnapshot {
  readonly source: 'native-chat';
  readonly retention: 'process';
  readonly capacity: 100;
  readonly state: ActivityState;
  readonly items: readonly ActivityEntry[];
}

const states: readonly string[] = ['stopped', 'starting', 'running', 'stopping', 'error'];
const types: readonly string[] = ['received', 'processed', 'sent', 'timeout', 'error', 'runtime'];
const levels: readonly string[] = ['info', 'warning', 'error'];

export function parseRecentActivity(value: unknown): RecentActivitySnapshot | null {
  const root = asRecord(value);
  if (root.source !== 'native-chat' || root.retention !== 'process' || root.capacity !== 100
    || typeof root.state !== 'string' || !states.includes(root.state)
    || !Array.isArray(root.items) || root.items.length > 100) return null;
  const ids = new Set<string>();
  const items: ActivityEntry[] = [];
  for (const value of root.items) {
    const entry = asRecord(value);
    if (typeof entry.id !== 'string' || entry.id.trim() === '' || entry.id.length > 256 || ids.has(entry.id)
      || typeof entry.at !== 'number' || !Number.isSafeInteger(entry.at) || entry.at < 0 || entry.at > 8_640_000_000_000_000
      || typeof entry.level !== 'string' || !levels.includes(entry.level)
      || typeof entry.type !== 'string' || !types.includes(entry.type)
      || entry.conversationId !== null && (typeof entry.conversationId !== 'string' || entry.conversationId.trim() === '' || entry.conversationId.length > 256)
      || typeof entry.summary !== 'string' || entry.summary.trim() === '' || entry.summary.length > 2048
      || entry.content !== undefined && entry.content !== null && (typeof entry.content !== 'string' || entry.content.length > 2000)) return null;
    ids.add(entry.id);
    items.push({ id: entry.id, at: entry.at, level: entry.level as ActivityEntry['level'], type: entry.type as ActivityType,
      conversationId: entry.conversationId as string | null, summary: entry.summary,
      content: (entry.type === 'received' || entry.type === 'sent') && typeof entry.content === 'string' ? entry.content : null });
  }
  return { source: 'native-chat', retention: 'process', capacity: 100, state: root.state as ActivityState, items };
}

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
