import { RefreshCw } from 'lucide-react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { chatInteractionConversationLabel, chatInteractionStatusLabel, parseChatInteractions } from '../lib/chat-interactions.ts';
import { EmptyState, Section } from './management.tsx';
import { Button } from './ui/button.tsx';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { VirtualList } from './virtual-list.tsx';

import { useReadResource } from '../lib/use-read-resource.ts';

export function ChatInteractions({ api, connected, embedded = false }: { readonly api: ApiClient; readonly connected: boolean; readonly embedded?: boolean }) {
  const resource = useReadResource(api, '/api/chat/interactions', connected, parseChatInteractions, { intervalMs: 5_000 });
  const snapshot = resource.snapshot;
  const current = connected ? { busy: resource.loading, error: resource.error
    ? `暂时无法更新 QQ 互动记录。${errorMessage(resource.error)} 以下保留上次读取的记录。` : '' } : null;
  if (!current) return null;
  if (!snapshot && resource.error) return <div className="flex flex-wrap items-center gap-2 text-xs"><p role="alert" className="text-destructive">QQ 互动记录读取失败，等待状态仍未确认。</p><Button size="sm" variant="outline" disabled={resource.loading} onClick={resource.refresh}>重新读取</Button><ReadOnlyDetails title="互动记录读取详情"><TechnicalDetails fields={[{ label: '读取错误', value: errorMessage(resource.error) }]} /></ReadOnlyDetails></div>;

  return <Section id="chat-interactions" title="QQ 互动记录" className={embedded ? 'rounded-none border-0 shadow-none [&>.panel-header]:border-0 [&>.panel-header]:bg-transparent [&>.panel-header>div:first-child]:hidden [&>.panel-body]:p-0' : '[&>.panel-body]:p-0'}
    actions={<><span className="text-xs text-muted-foreground">请在所属 QQ 会话答复</span><Button variant="outline" size="sm" disabled={current.busy} onClick={resource.refresh}><RefreshCw className={current.busy ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新</Button></>}>
    <div className="max-h-80 min-h-0 overflow-auto overscroll-contain" data-chat-interactions-scroll>
      {current.error && <p className="border-b px-2 py-1 text-xs text-destructive" role="alert">{current.error}</p>}
      {!snapshot && <p className="px-2.5 py-3 text-xs text-muted-foreground" role="status">正在读取 QQ 互动记录…</p>}
      {snapshot?.items.length === 0 && <EmptyState title="暂无 QQ 互动记录" description="当前返回的互动列表为空；模型提问在所属 QQ 会话回复。" />}
      {snapshot && !snapshot.available && <p className="border-b px-2 py-1 text-xs text-muted-foreground" role="status">以下为已保存记录，聊天连接尚未确认。</p>}
      <VirtualList items={snapshot?.items ?? []} getItemKey={item => item.id} estimateSize={32}>{item => <div data-chat-interaction-id={item.id} className="flex min-h-8 min-w-0 items-center gap-2 border-b px-2.5 py-0.5 text-xs">
        <strong className="shrink-0 font-medium">{chatInteractionConversationLabel(item.conversationId)}</strong><span className="shrink-0 text-xs text-muted-foreground">{item.kind === 'question' ? '提问' : '工具确认'}</span>
        <p className="min-w-0 flex-1 truncate">{item.summary || (item.kind === 'question' ? '模型请求答复' : '工具确认记录')}</p>
        <span className={`shrink-0 text-xs ${item.status === 'unknown' ? 'text-status-warning' : 'text-muted-foreground'}`}>{chatInteractionStatusLabel(item.status)}</span>
        <ReadOnlyDetails title="QQ 互动详情" description={chatInteractionConversationLabel(item.conversationId)}><div className="grid gap-3"><p className="whitespace-pre-wrap break-words">{item.summary || '未提供摘要'}</p><p className="text-xs text-muted-foreground">{chatInteractionStatusLabel(item.status)} · 有效期至 {new Date(item.expiresAt).toLocaleString('zh-CN', { hour12: false })}</p>{item.questions.map(question => <div key={question.id}><p className="whitespace-pre-wrap break-words">{question.text}</p>{question.options.length > 0 && <p className="mt-1 text-xs text-muted-foreground">选项：{question.options.join(' / ')}</p>}</div>)}<TechnicalDetails fields={[{ label: '互动标识', value: item.id }, { label: '工具', value: item.toolName ?? '无' }]} /></div></ReadOnlyDetails>
      </div>}</VirtualList>
    </div>
  </Section>;
}
