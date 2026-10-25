import type { NativeInboxSummary } from '../../src/contracts/native-inbox.ts';
export type ChatInboxItem = NativeInboxSummary['items'][number];
export function inboxStateLabel(item: ChatInboxItem | undefined): string {
  if (!item) return '无排队记录';
  return item.state === 'blocked' ? '已隔离，待核对' : item.state === 'dispatching' ? '正在处理' : item.state === 'pending' ? '正在排队' : '收件空闲';
}
export function inboxDeadline(item: ChatInboxItem | undefined): { readonly label: string; readonly iso: string } | null {
  if (item?.deadlineAt === null || item?.deadlineAt === undefined) return null;
  const date = new Date(item.deadlineAt);
  return Number.isFinite(date.getTime()) ? { iso: date.toISOString(), label: date.toLocaleTimeString('zh-CN', { hour12: false }) } : null;
}
