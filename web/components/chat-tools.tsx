import { useDeferredValue, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import { chatToolsCategories, chatToolsEmptyMessage, chatToolsStateLabel, filterChatTools, parseChatTools } from '../lib/chat-tools.ts';
import { Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { VirtualTableBody } from './virtual-list.tsx';

import { useReadResource } from '../lib/use-read-resource.ts';

export function ChatTools({ api, connected }: { readonly api: ApiClient; readonly connected: boolean }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const deferredQuery = useDeferredValue(query);
  const resource = useReadResource(api, '/api/chat/tools', connected, parseChatTools);
  const snapshot = resource.snapshot;
  const current = connected ? { loading: resource.loading, error: resource.error
    ? `工具清单读取失败，请刷新重试。${snapshot ? ' 暂显示上次结果。' : ''}` : '' } : null;
  const categories = useMemo(() => snapshot ? chatToolsCategories(snapshot) : [], [snapshot]);
  const selectedCategory = categories.some(item => item.id === category) ? category : 'all';
  const items = useMemo(() => snapshot ? filterChatTools(snapshot, deferredQuery, selectedCategory) : [], [snapshot, deferredQuery, selectedCategory]);

  return <Section id="chat-tools" title="聊天工具" scrollable className="[&>.panel-body]:p-0"
    description="查看当前聊天可见的工具；MCP 分类按名称区分，不代表由本框架提供。"
    actions={<Button variant="outline" size="sm" disabled={!connected || current?.loading === true} onClick={() => resource.refresh()}><RefreshCw className={current?.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新工具清单</Button>}>
    <div className="flex h-full min-h-0 flex-col">
      {(snapshot || current?.error) && <div className="grid shrink-0 gap-2 border-b p-4 text-xs leading-6">
        {snapshot && snapshot.items.length > 0 && <div className="flex min-w-0 flex-wrap gap-2"><select aria-label="工具分类" className="h-8 max-w-full rounded-lg border bg-background px-2 text-xs text-foreground" value={selectedCategory} onChange={event => setCategory(event.target.value)}><option value="all">全部工具（{snapshot.items.length}）</option>{categories.map(item => <option key={item.id} value={item.id}>{item.label}（{item.count}）</option>)}</select><Input className="min-w-0 flex-1 basis-40" aria-label="搜索聊天工具" placeholder="搜索工具名称或用途" value={query} onChange={event => setQuery(event.target.value)} /></div>}
        {current?.error && <p role="alert" className="text-destructive">{current.error}</p>}
        {snapshot && <div className="flex flex-wrap items-center gap-2"><StatusPill tone={snapshot.state === 'unavailable' && !snapshot.missingReasons.some(reason => reason === 'native_tool_scope_not_observed' || reason === 'saved_scope_unobserved') ? 'warning' : 'neutral'}>{snapshot.state === 'available' && snapshot.items.length === 0 ? '已读取' : chatToolsStateLabel(snapshot.state, snapshot.scope, snapshot.missingReasons)}</StatusPill>{snapshot.items.length > 0 && <span>{items.length} / {snapshot.items.length} 项{snapshot.limited ? '，结果有截断' : ''}</span>}{current?.loading && <span>正在更新，暂列上次结果</span>}</div>}
        {snapshot && snapshot.items.length > 0 && snapshot.missingReasons.includes('some_tool_scopes_unavailable') && <p className="text-muted-foreground">部分会话暂未加载，已列出可核对的工具。</p>}
      </div>}
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain" data-chat-tools-scroll role="region" aria-label="聊天工具清单">
        {!connected ? <p className="p-4 text-xs text-muted-foreground" role="status">连接工作台后查看聊天工具。</p> : !snapshot ? !current?.error && <p className="p-4 text-xs text-muted-foreground" role="status">正在读取聊天工具…</p>
          : items.length === 0 ? <p className="p-4 text-xs text-muted-foreground">{snapshot.items.length > 0 ? '没有匹配的工具，试试调整分类或搜索词。' : chatToolsEmptyMessage(snapshot)}</p>
            : <table className="w-full table-fixed text-left text-xs" aria-rowcount={items.length + 1}><colgroup><col className="w-2/5" /><col /></colgroup><thead className="sticky top-0 z-10 bg-muted"><tr><th className="px-3 py-2 font-medium">工具名称</th><th className="px-3 py-2 font-medium">用途</th></tr></thead><VirtualTableBody items={items} getItemKey={tool => tool.name} columns={2} estimateSize={40}>{tool => <tr data-chat-tool-name={tool.name} className="border-b"><td className="px-3 py-2.5"><span className="block truncate font-medium" title={tool.name}>{tool.name}</span></td><td className="px-3 py-2.5 text-muted-foreground"><span className="block truncate" title={tool.description ?? undefined}>{tool.description || '未提供用途说明'}</span></td></tr>}</VirtualTableBody></table>}
      </div>
    </div>
  </Section>;
}
