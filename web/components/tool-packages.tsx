import { useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Package } from 'lucide-react';
import { QQ_CAPABILITIES, QQ_CAPABILITY_CATEGORIES } from '../../src/contracts/qq-capabilities.ts';
import type { PresentedInventoryTool } from '../lib/chat-tools.ts';
import { DetailsWindow, TechnicalDetails } from './read-only-details.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';

const capabilities = new Map(QQ_CAPABILITIES.map(item => [`qq.${item.id}`, item]));
const categories = [
  ...QQ_CAPABILITY_CATEGORIES,
  { id: 'sessions', label: '会话管理', description: '查询、创建、切换和解除 QQ 与插件的会话绑定' },
  { id: 'other', label: '其他能力', description: '通过能力目录按需查询和调用' },
];
const sessionLabels: Readonly<Record<string, string>> = {
  qaf_session_resolve: '查询会话绑定', qaf_session_list: '列出会话绑定', qaf_session_bind: '切换会话绑定',
  qaf_session_create: '创建插件会话', qaf_session_unbind: '解除会话绑定',
};
export function directoryToolLabel(tool: PresentedInventoryTool): string | undefined {
  if (!toolPackage(tool)) return undefined;
  return sessionLabels[tool.name] ?? capabilities.get(tool.name)?.description;
}
/** Ownership comes from registration metadata; known IDs only select a display category. */
export function toolPackage(tool: PresentedInventoryTool): string | null {
  if (tool.category.kind !== 'framework' || tool.registrationSource?.ownerName !== '框架能力目录') return null;
  return capabilities.get(tool.name)?.category ?? (tool.name.startsWith('qaf_session_') ? 'sessions'
    : tool.name.startsWith('qaf_qzone_') ? 'qzone' : 'other');
}
export function toolPackageSearchText(tool: PresentedInventoryTool): string {
  const category = categories.find(item => item.id === toolPackage(tool));
  return category ? `${category.label} ${category.description}` : '';
}
const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();

export function ToolPackages({ items, allItems, label, renderDetails }: {
  readonly items: readonly PresentedInventoryTool[];
  readonly allItems: readonly PresentedInventoryTool[];
  readonly label: (tool: PresentedInventoryTool) => string;
  readonly renderDetails: (tool: PresentedInventoryTool) => ReactNode;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const packages = categories.map(category => ({ ...category,
    tools: items.filter(tool => toolPackage(tool) === category.id),
    all: allItems.filter(tool => toolPackage(tool) === category.id),
  })).filter(category => category.tools.length > 0);
  const current = packages.find(category => category.id === opened);
  const selectedTool = current?.tools.find(tool => tool.id === selected);
  const visible = current?.tools.filter(tool => normalize(`${label(tool)} ${tool.name} ${tool.description ?? ''}`).includes(normalize(query))) ?? [];
  const definition = selectedTool ? capabilities.get(selectedTool.name) : undefined;
  return <>
    <div className="flex items-center justify-between gap-2 px-0.5 pb-2 text-xs"><h3 className="font-semibold">按需能力包</h3><span className="text-muted-foreground">按用途查看 · {packages.length} 个分类</span></div>
    <div role="list" aria-label="按需能力包" className="grid grid-cols-1 gap-2 @min-[570px]:grid-cols-2 @min-[860px]:grid-cols-3 @min-[1150px]:grid-cols-4">
      {packages.map(category => <div key={category.id} role="listitem" className="min-w-0">
        <button type="button" aria-haspopup="dialog" className="group flex h-full w-full min-w-0 flex-col gap-2 rounded-lg border border-blue-500/15 bg-gradient-to-br from-blue-500/[0.06] to-card p-3 text-left transition-colors hover:border-blue-500/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setOpened(category.id); setQuery(''); setSelected(null); }}>
          <span className="flex w-full items-center gap-2"><span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400"><Package className="size-3.5" /></span><span className="min-w-0 flex-1 text-[13px] font-semibold">{category.label}</span><span className="shrink-0 text-xs tabular-nums text-muted-foreground">{category.tools.length === category.all.length ? category.all.length : `${category.tools.length}/${category.all.length}`} 项</span></span>
          <span className="text-xs leading-[18px] text-muted-foreground">{category.description}</span>
          <span className="line-clamp-1 text-[11px] text-muted-foreground/80">{category.tools.slice(0, 3).map(label).join(' · ')}</span>
          <span className="mt-auto flex w-full items-center justify-between border-t border-blue-500/10 pt-2 text-xs"><span className="text-muted-foreground">通过目录调用</span><span className="flex items-center gap-1 font-medium text-blue-600 dark:text-blue-400">查看能力<ArrowRight className="size-3" /></span></span>
        </button>
      </div>)}
    </div>
    <DetailsWindow open={Boolean(current)} onOpenChange={open => { if (!open) { setOpened(null); setSelected(null); } }} title={selectedTool ? label(selectedTool) : current?.label ?? '能力包'} description={selectedTool ? `${current?.label} · 能力说明` : current?.description ?? '按用途查找能力。'}>
      {selectedTool ? <div className="grid gap-3">
        <Button variant="ghost" size="xs" className="justify-self-start" onClick={() => setSelected(null)}><ArrowLeft className="size-3.5" />返回能力列表</Button>
        <p className="rounded-md bg-blue-500/5 px-2.5 py-2 text-xs text-muted-foreground">这项能力通过目录按需调用，无需单独加载到每轮对话。</p>
        {definition && <TechnicalDetails fields={[{ label: '操作类型', value: definition.write ? '写入或执行操作' : '读取信息' }, { label: '参数定义', value: definition.inputSchema }]} />}
        {renderDetails(selectedTool)}
      </div> : <div className="grid gap-2">
        <div className="sticky -top-3 z-10 flex items-center gap-2 bg-background py-2"><Input aria-label="搜索包内能力" placeholder="搜索名称、用途或接口标识" value={query} onChange={event => setQuery(event.target.value)} /><span aria-live="polite" className="shrink-0 text-xs tabular-nums text-muted-foreground">{visible.length} / {current?.all.length ?? 0}</span></div>
        {current && current.tools.length !== current.all.length && <p className="text-xs text-muted-foreground">当前沿用页面筛选结果，清除页面筛选可查看全部能力。</p>}
        <div role="list" aria-label="包内能力" className="overflow-hidden rounded-md border">
          {visible.map(tool => <div role="listitem" key={tool.id} className="border-b last:border-b-0 odd:bg-muted/25"><button type="button" className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => setSelected(tool.id)}>
            <span className="min-w-0 flex-1"><span className="block text-xs font-medium">{label(tool)}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground" title={tool.name}>{tool.name}</span></span><ArrowRight className="size-3 shrink-0 text-muted-foreground" />
          </button></div>)}
          {!visible.length && <p role="status" className="p-3 text-xs text-muted-foreground">没有匹配的能力。</p>}
        </div>
      </div>}
    </DetailsWindow>
  </>;
}
