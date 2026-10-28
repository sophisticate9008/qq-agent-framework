import { useDeferredValue, useId, useMemo, useState } from 'react';
import { Blocks, RefreshCw, Wrench } from 'lucide-react';
import { NATIVE_TOOL_CAPABILITY_CATALOG } from '../../src/contracts/native-tool-capabilities.ts';
import type { NativeToolInventory } from '../../src/contracts/native-tool-inventory.ts';
import { inventoryToolCategory, presentToolInventory, registrationOriginLabel, registrationTransportLabel, toolNameNamespace, type PresentedInventoryTool } from '../lib/chat-tools.ts';
import { errorMessage } from '../lib/api.ts';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { directoryToolLabel, toolPackage, toolPackageSearchText, ToolPackages } from './tool-packages.tsx';
import { StatusPill } from './management.tsx';

type InventoryTool = NativeToolInventory['items'][number];
type InventorySource = NativeToolInventory['sources'][number];
const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
const TOOL_PAGE_SIZE = 36;
const loadedLabel = (loaded: boolean | null) => loaded === true ? '当前已加载' : loaded === false ? '未在当前会话加载' : '尚未观察';
const moduleLabels: Readonly<Record<InventorySource['modules'][number]['kind'], string>> = { package: '安装模块', local: '本地插件', builtin: 'DSH 内置模块', unknown: '未标类型' };
function SourceModules({ source }: { readonly source: InventorySource }) {
  return source.modules.length ? <ul className="m-0 list-none divide-y rounded border px-2">{source.modules.map((module, index) => <li key={`${module.name}:${index}`} className="flex items-start justify-between gap-2 py-1 text-xs"><span className="min-w-0 flex-1 break-all">{module.name}</span><span className="shrink-0 text-muted-foreground">{moduleLabels[module.kind]} · {module.state === 'loaded' ? '已加载' : '已配置'}</span></li>)}</ul> : <p className="text-xs text-muted-foreground">此来源未提供模块记录。</p>;
}
const toolLabels: Readonly<Record<string, string>> = {
  generate_image: '生成图片', image_status: '图片任务状态', self_image: '自我形象与提示词', self_portrait: '自拍与换装',
  snowluma_status: 'QQ 网关状态', qq_status: 'QQ 登录状态', qq_collect_sticker: '收藏表情',
  qq_get_active_members: '活跃成员', qq_get_forward_msg: '查看合并转发', qq_get_group_history: '群聊历史',
  qq_get_group_members: '群成员', qq_get_message_detail: '查看消息详情', qq_get_message_images: '查看消息图片',
  qq_get_my_recent_messages: '自己最近的消息', qq_get_prompt: '查看聊天设置', qq_get_recent_messages: '最近消息',
  qq_get_self_image: '查看默认形象', qq_get_sticker_image: '查看表情图片', qq_get_unread_messages: '未读消息',
  qq_list_groups: '群聊列表', qq_list_stickers: '收藏表情列表', qq_mark_read: '标记已读',
  qq_memory_append: '记录记忆', qq_memory_clear: '清空记忆', qq_memory_query: '查询记忆', qq_memory_remove: '删除记忆',
  qq_reply: '引用回复', qq_report_feedback: '反馈问题', qq_send_burst: '分条发送消息', qq_send_group_message: '发送群消息',
  qq_send_message: '发送消息', qq_send_poke: '拍一拍', qq_send_private_message: '发送私聊消息', qq_send_sticker: '发送表情',
  qq_set_wake_config: '设置会话唤醒', qq_social_state: '查看会话参与状态', qq_sticker_note: '记录表情备注', qq_wait_for_messages: '等待会话消息',
  web_fetch: '读取网页', web_search: '联网搜索', list_mcp_resource_templates: '资源模板', list_mcp_resources: '资源列表',
  read_mcp_resource: '读取资源', working_directory: '工作目录', exec: '执行命令', exec_command: '执行命令',
  read_file: '读取文件', write_file: '写入文件', edit_file: '编辑文件', apply_patch: '修改文件',
};
const dshToolDescriptions: Readonly<Record<string, { readonly name: string; readonly summary: string }>> = {
  send_message: { name: '给子助手发消息', summary: '向 DSH 子助手追加消息或调整任务。' },
  interrupt_agent: { name: '停止子助手', summary: '中断 DSH 子助手正在执行的任务。' },
  list_agents: { name: '查看子助手', summary: '查看 DSH 子助手及其运行状态。' },
  subagent_fork: { name: '派生子助手', summary: '从当前 DSH 会话派生子助手执行任务。' },
  schedule_create: { name: '创建 DSH 定时任务', summary: '为 DSH 会话创建定时任务。' },
  schedule_update: { name: '修改 DSH 定时任务', summary: '更新 DSH 会话的定时任务。' },
  schedule_delete: { name: '删除 DSH 定时任务', summary: '删除 DSH 会话的定时任务。' },
  schedule_list: { name: '查看 DSH 定时任务', summary: '列出 DSH 会话的定时任务。' },
  read_image: { name: '读取本机图片', summary: '通过 DSH 文件工具读取本机图片。' },
  read: { name: '读取本机文件', summary: '读取 DSH 工作环境中的文件。' },
  write: { name: '写入本机文件', summary: '向 DSH 工作环境写入文件。' },
  edit: { name: '编辑本机文件', summary: '修改 DSH 工作环境中的文件内容。' },
  ask_user_question: { name: '向用户提问', summary: '由 DSH 发起问题，回复方式由接入宿主处理。' },
};
export function toolLabel(name: string, source?: InventoryTool['registrationSource']): string {
  if (source?.origin === 'dsh-builtin' && dshToolDescriptions[name]) return dshToolDescriptions[name].name;
  const shortName = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name;
  return NATIVE_TOOL_CAPABILITY_CATALOG.find(item => item.tool === name)?.name ?? toolLabels[shortName] ?? shortName;
}
function toolDescription(tool: PresentedInventoryTool): string {
  if (tool.registrationSource?.origin === 'dsh-builtin' && dshToolDescriptions[tool.name]) return dshToolDescriptions[tool.name].summary;
  return (tool.category.kind === 'framework' ? NATIVE_TOOL_CAPABILITY_CATALOG.find(item => item.tool === tool.name)?.summary : null) || tool.description || '未提供用途说明';
}
export function registrationLabel(tool: Pick<InventoryTool, 'registration'>): string { return tool.registration === 'registered' ? '已注册' : '已声明'; }
export function toolLoadedLabel(tool: PresentedInventoryTool): string {
  if (toolPackage(tool)) return '通过目录按需调用';
  return tool.registrations.some(registration => registration.loadedInSession !== tool.registrations[0]?.loadedInSession)
    ? '加载状态待核对' : loadedLabel(tool.loadedInSession);
}
function inventoryStateLabel(state: NativeToolInventory['state']): string {
  return { available: '已读取注册清单', partial: '部分注册范围未读取', 'not-connected': 'DSH 未连接', unavailable: '注册清单读取失败' }[state];
}

function ToolDetails({ tool, sources, error }: { readonly tool: PresentedInventoryTool; readonly sources: ReadonlyMap<string, InventorySource>; readonly error: unknown }) {
  return <div className="grid gap-3"><p className="whitespace-pre-wrap leading-relaxed">{tool.description || toolDescription(tool)}</p><TechnicalDetails fields={[{ label: '工具名称', value: tool.name }, { label: '注册状态', value: registrationLabel(tool) }, { label: '当前会话', value: error ? '状态待核对' : toolLoadedLabel(tool) }, { label: '提供来源', value: registrationOriginLabel(tool.registrationSource) }, { label: '所属组件', value: tool.category.label }, { label: '归属标识', value: tool.registrationSource?.ownerId }, { label: '归属名称', value: tool.registrationSource?.ownerName }, { label: '接入方式', value: registrationTransportLabel(tool.registrationSource) }, { label: '名称命名空间', value: toolNameNamespace(tool.name) }, { label: '注册记录', value: tool.registrations.length }]} /><h3 className="text-xs font-medium">注册与加载证据</h3>{tool.registrations.map(registration => {
              const source = sources.get(registration.sourceId);
              return <div key={registration.id} className="grid gap-1.5 rounded border p-2"><TechnicalDetails fields={[{ label: '注册范围名称', value: source?.label }, { label: '注册归属', value: inventoryToolCategory(registration, source).label }, { label: '归属标识', value: registration.registrationSource?.ownerId }, { label: '接入方式', value: registrationTransportLabel(registration.registrationSource) }, { label: '注册范围', value: source?.kind === 'dsh-global' ? 'DSH 全局' : source?.kind === 'dsh-preset' ? 'DSH 预设' : source?.kind === 'framework' ? '框架桥投影' : null }, { label: '关联预设', value: source?.agentPreset }, { label: '注册状态', value: registrationLabel(registration) }, { label: '当前会话', value: error ? '状态待核对' : loadedLabel(registration.loadedInSession) }]} />{source && source.modules.length > 0 && <><p className="text-xs text-muted-foreground">此范围已配置或已加载的模块；工具的注册归属与接入方式按各自元数据单独记录。</p><SourceModules source={source} /></>}</div>;
            })}<TechnicalDetails fields={[{ label: '原始注册记录', value: tool.registrations }]} /><p className="text-xs text-muted-foreground">{toolPackage(tool) ? '通过能力目录查询参数和调用；权限由实际调用入口核验。' : '工具实际调用按所属会话权限核验。当前会话尚未观察时，可在 QQ 开始对话后刷新清单。'}</p></div>;
}
const displayLabel = (tool: PresentedInventoryTool) => directoryToolLabel(tool) ?? toolLabel(tool.name, tool.registrationSource);

export function ChatTools({ connected, inventory, error, loading, refresh, title, showHeading = false, sectionId }: {
  readonly connected: boolean; readonly inventory: NativeToolInventory | null;
  readonly error: unknown; readonly loading: boolean; readonly refresh: () => void; readonly title: string;
  readonly showHeading?: boolean;
  readonly sectionId?: string;
}) {
  const generatedId = useId();
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('all');
  const [loadingFilter, setLoadingFilter] = useState('all');
  const [page, setPage] = useState<{ readonly items: readonly PresentedInventoryTool[] | null; readonly limit: number }>({ items: null, limit: TOOL_PAGE_SIZE });
  const deferredQuery = useDeferredValue(query);
  const resource = { snapshot: inventory, error, loading, refresh };
  const snapshot = resource.snapshot;
  const sources = useMemo(() => new Map(snapshot?.sources.map(source => [source.id, source]) ?? []), [snapshot]);
  const presentation = useMemo(() => presentToolInventory(snapshot), [snapshot]);
  const selectedCategory = presentation.categories.some(category => category.id === categoryId) ? categoryId : 'all';
  const items = useMemo(() => presentation.items.filter(tool => {
    const registrationSources = tool.registrations.map(registration => sources.get(registration.sourceId)?.label ?? '').join(' ');
    return (selectedCategory === 'all' || tool.category.id === selectedCategory)
      && (loadingFilter === 'all' || loadingFilter === 'directory' && toolPackage(tool) !== null || loadingFilter === 'loaded' && tool.loadedInSession === true || loadingFilter === 'unloaded' && !toolPackage(tool) && tool.loadedInSession === false || loadingFilter === 'unobserved' && tool.loadedInSession === null)
      && (!normalize(deferredQuery) || normalize(`${displayLabel(tool)} ${tool.name} ${toolDescription(tool)} ${tool.category.label} ${toolPackageSearchText(tool)} ${registrationSources} ${registrationLabel(tool)} ${toolLoadedLabel(tool)}`).includes(normalize(deferredQuery)));
  }), [presentation, sources, selectedCategory, loadingFilter, deferredQuery]);
  const visibleLimit = page.items === items ? page.limit : TOOL_PAGE_SIZE;
  const directItems = items.filter(tool => !toolPackage(tool));
  const packageItems = items.filter(tool => toolPackage(tool));
  const visibleItems = directItems.slice(0, visibleLimit);
  const registeredCount = presentation.items.filter(tool => tool.registration === 'registered').length;
  const declaredCount = presentation.items.length - registeredCount;
  const loadedCount = presentation.items.filter(tool => tool.loadedInSession === true).length;
  const unobservedCount = presentation.items.filter(tool => tool.loadedInSession === null).length;
  const countsBySource = useMemo(() => {
    const result = new Map<string, number>();
    for (const tool of snapshot?.items ?? []) result.set(tool.sourceId, (result.get(tool.sourceId) ?? 0) + 1);
    return result;
  }, [snapshot]);

  return <section id={sectionId ?? generatedId} aria-label={title} className="@container grid min-w-0 gap-2">
    {showHeading && <div className="px-0.5 pt-1"><h2 className="text-sm font-semibold">{title}</h2></div>}
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs">
      {!showHeading && <h2 className="sr-only">{title}</h2>}
      <Input className="min-w-0 max-w-80 flex-1 basis-48" aria-label="搜索聊天工具" placeholder="搜索能力包、工具名或用途" value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label="所属组件" className="h-[27px] max-w-full rounded border bg-background px-2 text-xs text-foreground" value={selectedCategory} onChange={event => setCategoryId(event.target.value)}><option value="all">全部组件</option>{presentation.categories.map(category => <option key={category.id} value={category.id}>{category.label}（{category.count}）</option>)}</select>
      <select aria-label="工具加载状态" className="h-[27px] max-w-full rounded border bg-background px-2 text-xs text-foreground" value={loadingFilter} onChange={event => setLoadingFilter(event.target.value)}><option value="all">全部调用方式与状态</option><option value="directory">通过目录按需调用</option><option value="loaded">当前已加载</option><option value="unloaded">当前未加载</option><option value="unobserved">尚未观察／待核对</option></select>
      <span className="mr-auto whitespace-nowrap text-muted-foreground" aria-live="polite">{snapshot ? `${items.length} / ${presentation.items.length} 项工具` : '清单待读取'}</span>
      <ReadOnlyDetails title="工具来源与插件" label="来源详情" description="查看工具提供方、插件及完整注册范围。"><div className="grid gap-3"><p>框架提供的功能分为内置与后续扩展。DSH 自带工具在独立页签中展示。MCP 与原生接入只表示接入方式，归属、组件和注册位置在详情中记录。</p><p>同归属、同名、说明和接入方式一致的登记合并展示，分别保留注册与加载记录。已注册表示工具定义已经登记；已声明表示已有定义，运行注册尚未确认。会话已加载与未加载来自实际观察；缺少观察时显示尚未观察，多条记录不一致时显示加载状态待核对。</p><p>清单只读取已登记的工具与模块。注册范围中的模块记录独立保留，具体工具归属使用自身的来源元数据；注册与加载状态不代表调用已经通过权限核验。</p><h3 className="text-xs font-medium">完整注册范围</h3>{snapshot?.sources.map(source => <div key={source.id} className="grid gap-1.5"><div className="flex items-center justify-between gap-2 text-xs"><h4 className="font-medium">{source.label}</h4><span className="text-muted-foreground">{countsBySource.get(source.id) ?? 0} 条登记</span></div><TechnicalDetails fields={[{ label: '注册范围', value: source.kind === 'dsh-global' ? 'DSH 全局' : source.kind === 'dsh-preset' ? 'DSH 预设' : '框架桥投影' }, { label: '关联预设', value: source.agentPreset }]} /><SourceModules source={source} /></div>)}<TechnicalDetails fields={[{ label: '读取状态', value: snapshot ? inventoryStateLabel(snapshot.state) : null }, { label: '已注册工具', value: snapshot ? registeredCount : null }, { label: '仅声明工具', value: snapshot ? declaredCount : null }, { label: resource.error ? '上次观察已加载' : '当前已加载', value: snapshot ? loadedCount : null }, { label: '尚未观察或待核对', value: snapshot ? unobservedCount : null }, { label: '原始登记数量', value: snapshot?.items.length }, { label: '结果截断', value: snapshot?.limited }, { label: '注册范围记录', value: snapshot?.sources }, { label: '待核对原因', value: snapshot?.missingReasons }, { label: '读取错误', value: resource.error ? errorMessage(resource.error) : null }]} /></div></ReadOnlyDetails>
      <Button variant="outline" size="xs" disabled={!connected || resource.loading} onClick={resource.refresh}><RefreshCw className={resource.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新清单</Button>
    </div>
    {Boolean(resource.error) && <p role="alert" className="border-b px-2.5 py-1.5 text-xs text-destructive">工具清单读取失败，请刷新重试。{snapshot && '暂列上次结果，加载状态待核对。'}</p>}
    {snapshot && (snapshot.state !== 'available' || snapshot.limited) && <p role="status" className="border-b px-2.5 py-1.5 text-xs text-muted-foreground">{inventoryStateLabel(snapshot.state)}{snapshot.limited ? ' · 结果有截断' : ''}，可在来源详情查看记录。</p>}
    <div className="min-h-0" data-chat-tools-scroll role="region" aria-label="聊天工具清单" aria-busy={resource.loading}>
      {!connected ? <p className="p-2.5 text-xs text-muted-foreground" role="status">连接工作台后查看工具清单。</p> : !snapshot ? !resource.error && <p className="p-2.5 text-xs text-muted-foreground" role="status">正在读取工具清单…</p>
        : items.length === 0 ? <p className="p-2.5 text-xs text-muted-foreground">{snapshot.items.length ? '没有匹配的工具，试试调整来源、加载状态或搜索词。' : snapshot.state === 'not-connected' ? 'DSH 尚未连接，连接后刷新注册工具。' : snapshot.state === 'unavailable' ? '注册清单暂时无法读取，可在详情查看原因。' : '当前分类没有已登记工具。'}</p>
          : <div className="grid gap-3">
            {packageItems.length > 0 && <div><ToolPackages items={packageItems} allItems={presentation.items} label={displayLabel} renderDetails={tool => <ToolDetails tool={tool} sources={sources} error={resource.error} />} /></div>}
            {packageItems.length > 0 && directItems.length > 0 && <h3 className="px-0.5 text-xs font-semibold">直接提供的工具 <span className="ml-1 font-normal text-muted-foreground">{directItems.length} 项</span></h3>}
            <div role="list" className="grid grid-cols-1 items-start gap-3 @min-[570px]:grid-cols-2 @min-[860px]:grid-cols-3 @min-[1150px]:grid-cols-4">{visibleItems.map(tool => {
              const label = displayLabel(tool);
              const framework = tool.category.kind === 'framework';
              const Icon = framework ? Blocks : Wrench;
              return <article key={tool.id} role="listitem" data-chat-tool-name={tool.name} className="min-w-0 rounded-lg border bg-card p-3 shadow-xs">
                <div className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className={framework ? 'flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'flex size-7 shrink-0 items-center justify-center rounded-md bg-teal-500/10 text-teal-700 dark:text-teal-400'}><Icon className="size-3.5" /></span>
                  <h3 className="min-w-0 truncate text-[13px] font-semibold leading-5" title={label}>{label}</h3>
                  {tool.registration === 'declared' && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">已声明</span>}
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-[18px] text-muted-foreground" title={toolDescription(tool)}>{toolDescription(tool)}</p>
                <p className="mt-1.5 truncate text-[11px] text-muted-foreground/80" title={tool.category.label}>{tool.category.label}</p>
                <div className="mt-2.5 flex items-center justify-between gap-1 border-t pt-2">
                  <StatusPill tone={!resource.error && tool.loadedInSession === true ? 'success' : 'neutral'}>{resource.error ? '状态待核对' : toolLoadedLabel(tool)}</StatusPill>
                  <ReadOnlyDetails title={label} label="说明" description="工具完整说明、注册归属、接入方式与当前加载状态。"><ToolDetails tool={tool} sources={sources} error={resource.error} /></ReadOnlyDetails>
                </div>
              </article>;
            })}</div>
            {visibleItems.length < directItems.length && <div className="flex items-center justify-center gap-3 border-t px-2.5 py-2 text-xs"><span className="text-muted-foreground">已显示 {visibleItems.length} / {directItems.length} 项</span><Button variant="outline" size="xs" onClick={() => setPage({ items, limit: visibleLimit + TOOL_PAGE_SIZE })}>加载更多（{Math.min(TOOL_PAGE_SIZE, directItems.length - visibleItems.length)}）</Button></div>}
          </div>}
    </div>
  </section>;
}
