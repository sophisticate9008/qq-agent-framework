import { NATIVE_TOOL_CAPABILITY_CATALOG } from '../../src/contracts/native-tool-permissions.ts';
import { useDeferredValue, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { chatToolsCategories, chatToolsEmptyMessage, chatToolsStateLabel, filterChatTools, parseChatTools } from '../lib/chat-tools.ts';
import { Section } from './management.tsx';
import { DetailsWindow, ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { VirtualTableBody } from './virtual-list.tsx';

import { useReadResource } from '../lib/use-read-resource.ts';

export function ChatTools({ api, connected }: { readonly api: ApiClient; readonly connected: boolean }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('all');
  const deferredQuery = useDeferredValue(query);
  const resource = useReadResource(api, '/api/chat/tools', connected, parseChatTools);
  const snapshot = useMemo(() => resource.snapshot ? { ...resource.snapshot, items: resource.snapshot.items.filter(tool =>
    !NATIVE_TOOL_CAPABILITY_CATALOG.some(builtin => builtin.tool === tool.name)) } : null, [resource.snapshot]);
  const current = connected ? { loading: resource.loading, error: resource.error
    ? `工具清单读取失败，请刷新重试。${snapshot ? ' 暂显示上次结果。' : ''}` : '' } : null;
  const categories = useMemo(() => snapshot ? chatToolsCategories(snapshot) : [], [snapshot]);
  const selectedCategory = categories.some(item => item.id === category) ? category : 'all';
  const items = useMemo(() => snapshot ? filterChatTools(snapshot, deferredQuery, selectedCategory) : [], [snapshot, deferredQuery, selectedCategory]);
  const details = <ReadOnlyDetails title="扩展工具详情" description="工具读取结果与当前可用范围。"><TechnicalDetails fields={[{ label: '读取错误', value: resource.error ? errorMessage(resource.error) : null }, { label: '工具状态', value: snapshot?.state }, { label: '可用范围', value: snapshot?.scope }, { label: '待核对原因', value: snapshot?.missingReasons }, { label: '工具记录', value: snapshot?.items }]} /></ReadOnlyDetails>;

  if (snapshot?.state === 'available' && snapshot.items.length === 0 && !current?.error) return <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-xs text-muted-foreground"><span className="mr-auto">当前没有额外扩展工具。</span>{details}</div>;
  if (!snapshot || snapshot.items.length === 0) return <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-xs"><p role={current?.error ? 'alert' : 'status'} className={current?.error ? 'text-destructive' : 'text-muted-foreground'}>{current?.error || (snapshot ? chatToolsEmptyMessage(snapshot) : '正在读取扩展工具…')}</p><Button size="sm" variant="outline" disabled={!connected || current?.loading === true} onClick={resource.refresh}>重新读取</Button>{details}</div>;

  return <><div className="flex flex-wrap items-center gap-2 border-t pt-2 text-xs text-muted-foreground"><span className="mr-auto">扩展工具：{chatToolsStateLabel(snapshot.state, snapshot.scope, snapshot.missingReasons)} · {snapshot.items.length} 项{snapshot.limited ? '（部分结果）' : ''}</span><Button size="sm" variant="ghost" onClick={() => setOpen(true)}>工具读取详情</Button></div><DetailsWindow open={open} onOpenChange={setOpen} title="扩展工具详情" description="查看实际观察到的扩展工具，可按来源和名称筛选。"><Section id="chat-tools" title="扩展工具" className="rounded-none border-0 shadow-none [&>.panel-body]:p-0"
    actions={<>{details}<Button variant="outline" size="sm" disabled={!connected || current?.loading === true} onClick={() => resource.refresh()}><RefreshCw className={current?.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新读取</Button></>}>
    <div className="min-w-0">
      {(snapshot || current?.error) && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-2.5 py-1.5 text-xs leading-[1.45]">
        {snapshot && snapshot.items.length > 0 && <div className="flex min-w-0 flex-1 basis-64 flex-wrap gap-2"><select aria-label="工具分类" className="h-[27px] max-w-full rounded border bg-background px-2 text-sm text-foreground" value={selectedCategory} onChange={event => setCategory(event.target.value)}><option value="all">全部工具（{snapshot.items.length}）</option>{categories.map(item => <option key={item.id} value={item.id}>{item.label}（{item.count}）</option>)}</select><Input className="min-w-0 max-w-64 flex-1 basis-40" aria-label="搜索聊天工具" placeholder="搜索工具名称或用途" value={query} onChange={event => setQuery(event.target.value)} /></div>}
        {current?.error && <p role="alert" className="w-full text-destructive">{current.error}</p>}
        {snapshot && <div className="flex flex-wrap items-center gap-2"><span>{chatToolsStateLabel(snapshot.state, snapshot.scope, snapshot.missingReasons)}</span><span>{items.length} / {snapshot.items.length} 项{snapshot.limited ? '，结果有截断' : ''}</span>{current?.loading && <span>正在更新，暂列上次结果</span>}</div>}
        {snapshot && snapshot.items.length > 0 && snapshot.missingReasons.includes('some_tool_scopes_unavailable') && <p className="text-muted-foreground">部分会话暂未加载，已列出可核对的工具。</p>}
      </div>}
      <div className="tablewrap min-h-0 overscroll-contain" data-chat-tools-scroll role="region" aria-label="聊天工具清单">
        {!connected ? <p className="p-2.5 text-xs text-muted-foreground" role="status">连接工作台后查看聊天工具。</p> : !snapshot ? !current?.error && <p className="p-2.5 text-xs text-muted-foreground" role="status">正在读取聊天工具…</p>
          : items.length === 0 ? <p className="p-2.5 text-xs text-muted-foreground">{snapshot.items.length > 0 ? '没有匹配的工具，试试调整分类或搜索词。' : chatToolsEmptyMessage(snapshot)}</p>
            : <table className="w-full table-fixed text-left text-sm" aria-rowcount={items.length + 1}><colgroup><col className="w-1/3" /><col /></colgroup><thead className="sticky top-0 z-10 bg-muted text-xs"><tr><th className="px-2 py-1 font-medium">工具</th><th className="px-2 py-1 font-medium">用途</th></tr></thead><VirtualTableBody items={items} getItemKey={tool => tool.name} columns={2} estimateSize={30}>{tool => <tr data-chat-tool-name={tool.name} className="border-b"><td className="px-2 py-1 font-medium"><span className="block truncate" title={tool.name}>{tool.name.startsWith('mcp__') ? tool.name.split('__').slice(2).join('__') || tool.name : tool.name}</span></td><td className="px-2 py-1 text-muted-foreground"><span className="block truncate" title={tool.description ?? undefined}>{tool.description || '未提供用途说明'}</span></td></tr>}</VirtualTableBody></table>}
      </div>
    </div>
  </Section></DetailsWindow></>;
}
