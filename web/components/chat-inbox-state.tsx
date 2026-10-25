import { inboxDeadline, inboxStateLabel, type ChatInboxItem } from '../lib/chat-inbox.ts';
import { StatusPill } from './management.tsx';

export function ChatInboxState({ item, known, stale, imported = false }: {
  readonly item?: ChatInboxItem; readonly known: boolean; readonly stale: boolean; readonly imported?: boolean;
}) {
  const deadline = inboxDeadline(item);
  if (imported) return <span className="text-muted-foreground">迁入档案只读</span>;
  return <div className="grid gap-1 text-[11px]" data-inbox-state={known && !stale ? item?.state ?? 'none' : 'unconfirmed'}>
    <StatusPill tone={item?.state === 'blocked' || stale ? 'warning' : 'neutral'}>{!known || stale ? '收件状态待确认' : inboxStateLabel(item)}</StatusPill>
    {known && item && <span className="text-muted-foreground">{stale ? '上次读取：' : ''}{item.pending} 条待处理{item.expired > 0 ? `，${item.expired} 条已过期` : ''}</span>}
    {known && deadline && <span className="text-muted-foreground">处理期限 <time dateTime={deadline.iso}>{deadline.label}</time></span>}
    {known && item?.state === 'blocked' && <span className="max-w-52 text-muted-foreground">执行结果待核对；收件保持隔离，不会自动重放。</span>}
    {known && item?.lastError && item.state !== 'blocked' && <span className="max-w-52 text-muted-foreground">最近收件未完成，请核对任务执行日志。</span>}
  </div>;
}
