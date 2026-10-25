import { RefreshCw } from 'lucide-react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { chatInteractionConversationLabel, chatInteractionStatusLabel, parseChatInteractions } from '../lib/chat-interactions.ts';
import { Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';
import { VirtualList } from './virtual-list.tsx';

import { useReadResource } from '../lib/use-read-resource.ts';

export function ChatInteractions({ api, connected }: { readonly api: ApiClient; readonly connected: boolean }) {
  const resource = useReadResource(api, '/api/chat/interactions', connected, parseChatInteractions, { intervalMs: 5_000 });
  const snapshot = resource.snapshot;
  const current = connected ? { busy: resource.loading, error: resource.error
    ? `暂时无法更新 QQ 互动记录。${errorMessage(resource.error)} 以下保留上次读取的记录。` : '' } : null;
  if (!current) return null;
  if (!snapshot && resource.error) return <Section id="chat-interactions" title="QQ 提问与确认" description="互动状态当前无法读取，不代表没有等待主人回复的记录。提问和工具确认仍在所属 QQ 会话内处理。" actions={<Button size="sm" variant="outline" disabled={resource.loading} onClick={resource.refresh}>刷新互动记录</Button>}><p role="status" className="text-xs text-muted-foreground">没有可核实的互动快照，当前状态保持未知；这里不提供答复或审批操作。</p></Section>;
  if (!snapshot || snapshot.items.length === 0) return null;

  return <Section id="chat-interactions" title="QQ 提问与确认" scrollable className="[&>.panel-body]:p-0"
    description="提问与确认在 QQ 内回复；这里只读显示当前进程记录，不提交答复或审批。"
    actions={<Button variant="outline" size="sm" disabled={current.busy} onClick={() => resource.refresh()}><RefreshCw className={current.busy ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新互动记录</Button>}>
    <div className="h-full min-h-0 overflow-auto overscroll-contain" data-chat-interactions-scroll>
      {current.error && <p className="border-b p-4 text-xs text-destructive" role="alert">{current.error}</p>}
      {!snapshot.available && <p className="border-b p-4 text-xs text-muted-foreground" role="status">以下为已保存的观察记录，不代表聊天当前已接通。</p>}
      <VirtualList items={snapshot.items} getItemKey={item => item.id} estimateSize={220}>{item => <div data-chat-interaction-id={item.id} className="grid min-w-0 gap-3 border-b p-4 text-xs leading-6">
        <div className="flex flex-wrap items-center justify-between gap-2"><strong>{chatInteractionConversationLabel(item.conversationId)} · {item.kind === 'question' ? '提问' : '工具确认'}</strong><StatusPill tone={item.status === 'unknown' ? 'warning' : 'neutral'}>{chatInteractionStatusLabel(item.status)}</StatusPill></div>
        <p className="break-words whitespace-pre-wrap">{item.summary || (item.kind === 'question' ? '模型请求答复。' : '工具请求本次操作确认。')}</p>
        <p className="text-muted-foreground">有效期至 <time dateTime={new Date(item.expiresAt).toISOString()}>{new Date(item.expiresAt).toLocaleString('zh-CN', { hour12: false })}</time></p>
        {item.toolName && <p className="break-all">工具：{item.toolName}</p>}
        {item.questions.length > 0 && <div className="grid max-h-40 gap-3 overflow-auto rounded-md border p-3">{item.questions.map(question => <div key={question.id}><p className="break-words whitespace-pre-wrap">{question.text}</p>{question.options.length > 0 && <p className="mt-1 break-words text-muted-foreground">选项：{question.options.join(' / ')}</p>}</div>)}</div>}
      </div>}</VirtualList>
    </div>
  </Section>;
}
