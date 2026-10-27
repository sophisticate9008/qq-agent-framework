import { validExtensionMetadata } from '../../src/contracts/extension-metadata.ts';
import { ExtensionTools } from '../components/extension-tools.tsx';
import { groupExtensionTools, parseToolInventory, type PresentedInventoryTool } from '../lib/chat-tools.ts';
import type { NativePackageSnapshot } from '../../src/contracts/native-packages.ts';
import { useDeferredValue, useState } from 'react';
import { parseNativeRuntimeProjection, type NativeRuntimeProjection, type NativeRuntimeFeatureProjection } from '../../src/contracts/native-runtime-projection.ts';
import { PackageConfigurationManager } from '../components/package-configuration-manager.tsx';
import { NativeBootstrapSummary } from '../components/native-bootstrap-summary.tsx';
import { ArrowRight, Layers3, Puzzle, RefreshCw, Wrench } from 'lucide-react';
import { ChatTools } from '../components/chat-tools.tsx';
import { ConnectPrompt, PageHeading, StatusPill } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.tsx';
import { ReadOnlyDetails, TechnicalDetails } from '../components/read-only-details.tsx';
import { asRecord, errorMessage } from '../lib/api.ts';
import { featureStatusLabel, readDeclaredCapabilities } from '../lib/feature-labels.ts';
import { nativePackageStateLabels, parseNativeToolRuntimeStatus } from '../lib/native-tool-status.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import type { PageId, PageProps } from '../lib/types.ts';

interface CapabilityState {
  readonly id: string;
  readonly installed: boolean;
}

interface FeatureState {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly capabilities: readonly string[] | null;
  readonly toolNames: readonly string[];
}

interface ExtensionRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly origin: '本地扩展包' | '本地功能扩展';
  readonly feature?: FeatureState;
  readonly actual?: NativeRuntimeFeatureProjection;
  readonly runtimePackage?: NativePackageSnapshot;
  readonly toolNames: readonly string[];
  readonly tools: readonly PresentedInventoryTool[];
}

interface NativeFeatures {
  readonly runtimeConnected: boolean;
  readonly editableResources: boolean;
  readonly capabilities: readonly CapabilityState[];
  readonly features: readonly FeatureState[];
  readonly projection: NativeRuntimeProjection | null;
}

function parseFeature(value: unknown): FeatureState | null {
  const record = asRecord(value);
  if (typeof record.id !== 'string' || !validExtensionMetadata(record)) return null;
  return {
    id: record.id,
    name: typeof record.displayName === 'string' ? record.displayName : typeof record.name === 'string' && record.name.trim() ? record.name.trim() : record.id,
    description: typeof record.description === 'string' ? record.description : '',
    status: typeof record.status === 'string' ? record.status : 'unknown',
    capabilities: readDeclaredCapabilities(record.capabilities),
    toolNames: Array.isArray(record.toolNames) ? record.toolNames as string[] : [],
  };
}

function parseFeatures(value: unknown): NativeFeatures | null {
  const record = asRecord(value);
  if (typeof record.runtimeConnected !== 'boolean' || typeof record.editableResources !== 'boolean'
    || !Array.isArray(record.capabilities) || !Array.isArray(record.features)) return null;
  const capabilities = record.capabilities.map(item => {
    const capability = asRecord(item);
    return typeof capability.id === 'string' && typeof capability.installed === 'boolean'
      ? { id: capability.id, installed: capability.installed }
      : null;
  });
  const projection = record.projection === undefined ? null : parseNativeRuntimeProjection(record.projection);
  if (record.projection !== undefined && !projection) return null;
  const features = record.features.map(parseFeature);
  if (capabilities.some(capability => capability === null) || features.some(feature => feature === null)) return null;
  return {
    projection,
    runtimeConnected: record.runtimeConnected,
    editableResources: record.editableResources,
    capabilities: capabilities as CapabilityState[],
    features: features as FeatureState[],
  };
}

const builtinIds = ['agent-relay', 'framework-tools', 'reminder', 'reminders', 'memory', 'media', 'native-services', 'chat-input', 'chat-output'];
const builtinServices: Readonly<Record<string, { readonly name: string; readonly description: string; readonly page?: PageId }>> = {
  'chat-input': { name: '唤醒与续聊', description: '私聊、@、昵称、引用与会话续聊；在人设中调整。', page: 'persona' },
  'chat-output': { name: '回复呈现与 Markdown 转图', description: '框架内置 Markdown 图片渲染、短回复分条与长纯文本转发。', page: 'overview' },
  media: { name: '媒体读取与视频观察', description: '按需读取图片、文件与视频抽样画面；视频观察在首页开启，音频需转写服务。', page: 'overview' },
  reminders: { name: '提醒服务', description: '提供提醒与定时触发，供扩展包注册业务工具。' },
  memory: { name: '记忆与偏好', description: '提供带来源与范围的记忆，供扩展包注册业务工具。' },
  'native-services': { name: '会话与后台工作', description: '提供工作状态、执行记录与会话互动；模型提问在 QQ 内回复。', page: 'sessions' },
};
const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
const cardGridClass = 'grid min-w-0 w-full max-w-[1280px] grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] items-start gap-3';
const iconTones = [
  'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
  'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
  'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
  'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
] as const;

function FeatureIcon({ id, kind }: { readonly id: string; readonly kind: 'tools' | 'extension' | 'service' }) {
  const tone = [...id].reduce((total, character) => total + character.charCodeAt(0), 0) % iconTones.length;
  const Icon = kind === 'tools' ? Wrench : kind === 'service' ? Layers3 : Puzzle;
  return <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${iconTones[tone]}`}><Icon aria-hidden="true" className="size-4" /></span>;
}

function shortDescription(value: string, limit = 120): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function toolProviderDescription(extension: ExtensionRow | undefined, tools: readonly PresentedInventoryTool[]): string {
  if (extension?.description.trim()) return shortDescription(extension.description);
  const descriptions = [...new Set(tools.map(tool => tool.description?.split(/[。！？\n]/, 1)[0]?.trim()).filter((value): value is string => Boolean(value)))];
  return descriptions.length > 0 ? shortDescription(descriptions.slice(0, 3).map(value => shortDescription(value, 60)).join('；')) : '提供已登记的扩展工具。';
}

export function FeaturesPage(props: PageProps) {
  const { api, connected, connect } = props;
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [toolQuery, setToolQuery] = useState('');
  const toolSearch = normalize(useDeferredValue(toolQuery));
  const directory = useReadResource(api, '/api/chat/features', connected, parseFeatures);
  const runtime = useReadResource(api, '/api/chat/runtime', connected, parseNativeToolRuntimeStatus);
  const inventory = useReadResource(api, '/api/chat/tool-inventory', connected, parseToolInventory);
  const features = directory.snapshot;
  const loading = directory.loading || runtime.loading || inventory.loading;
  const loadError = directory.error ? errorMessage(directory.error) : '';
  const packages = runtime.snapshot?.packages.filter(item => Object.hasOwn(builtinServices, item.id)) ?? [];
  const relay = features?.projection?.features.find(feature => feature.id === 'agent-relay');
  const extensionIds = [...new Set([
    ...(runtime.snapshot?.packages.map(item => item.id) ?? []),
    ...(features?.features.map(item => item.id) ?? []),
  ])].filter(id => !builtinIds.includes(id));
  const localExtensions: ExtensionRow[] = extensionIds.map(id => {
    const feature = features?.features.find(item => item.id === id);
    const actual = features?.projection?.features.find(item => item.id === id);
    const runtimePackage = runtime.snapshot?.packages.find(item => item.id === id);
    return { id, feature, actual, runtimePackage,
      name: runtimePackage?.displayName ?? actual?.displayName ?? feature?.name ?? id,
      description: runtimePackage?.description?.trim() || actual?.description?.trim() || feature?.description.trim() || '此扩展尚未填写用途说明。',
      toolNames: runtimePackage?.toolNames ?? actual?.toolNames ?? feature?.toolNames ?? [],
      origin: runtimePackage ? '本地扩展包' : '本地功能扩展', tools: [] };
  });
  const grouped = groupExtensionTools(inventory.snapshot, localExtensions);
  const extensions: ExtensionRow[] = localExtensions.map(extension => ({ ...extension, tools: grouped.toolsByExtension.get(extension.id) ?? [] }));
  const packageNames = new Map([...(runtime.snapshot?.packages ?? []).map(item => [item.id, item.displayName ?? builtinServices[item.id]?.name ?? item.id] as const), ...extensions.map(item => [item.id, item.name] as const)]);
  const inventoryUnavailable = Boolean(inventory.error) || !inventory.snapshot || inventory.snapshot.state === 'unavailable' || inventory.snapshot.state === 'not-connected';
  const { frameworkInventory, dshInventory, unknownInventory } = grouped;
  const extensionToolGroups = grouped.registeredExtensions.map(provider => {
    const extension = extensions.find(item => item.id === provider.id);
    const tools = provider.tools.filter(tool => !toolSearch || normalize(`${provider.name} ${provider.id} ${extension?.name ?? ''} ${extension?.description ?? ''} ${tool.name} ${tool.description ?? ''}`).includes(toolSearch));
    return { provider, extension, tools };
  }).filter(group => group.tools.length > 0);
  const filteredExtensions = extensions.filter(item => !normalize(deferredQuery) || normalize(`${item.name} ${item.id} ${item.description} ${item.toolNames.join(' ')} ${item.tools.map(tool => `${tool.name} ${tool.description ?? ''}`).join(' ')}`).includes(normalize(deferredQuery)));
  const refresh = () => { directory.refresh(); runtime.refresh(); inventory.refresh(); };
  const refreshButton = <Button variant="outline" size="sm" onClick={refresh} disabled={loading}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新状态</Button>;

  if (!connected) return <div className="page-stack" data-page="features"><PageHeading title="功能与扩展" description="查看自带功能与后续添加的扩展。" /><ConnectPrompt connect={connect} /></div>;

  return <div className="page-stack" data-page="features">
    <PageHeading title="功能与扩展" description="查看框架自带功能与后续添加的扩展。" actions={<>
      {Boolean(unknownInventory?.items.length) && <ReadOnlyDetails title="工具来源详情" label="来源详情" description="尚未识别归属的注册记录。"><ChatTools connected={connected} inventory={unknownInventory} error={inventory.error} loading={inventory.loading} refresh={inventory.refresh} title="来源待核对" showHeading /></ReadOnlyDetails>}
    </>} />
    <Tabs defaultValue="framework" className="min-w-0 gap-2">
      <TabsList aria-label="功能分类" className="h-auto w-full flex-wrap justify-start"><TabsTrigger value="framework">框架内置</TabsTrigger><TabsTrigger value="dsh">DSH 自带</TabsTrigger><TabsTrigger value="extension-tools">扩展工具</TabsTrigger><TabsTrigger value="extensions">扩展功能</TabsTrigger></TabsList>
      <TabsContent value="extension-tools" keepMounted className="grid min-w-0 grid-cols-1 gap-2 [&[hidden]]:hidden">
        <section id="extension-dsh-tools" aria-label="扩展注入 DSH" className="grid min-w-0 grid-cols-1 gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs"><Input className="min-w-0 max-w-80 flex-1 basis-48" aria-label="搜索扩展工具" placeholder="搜索组件、工具或用途" value={toolQuery} onChange={event => setToolQuery(event.target.value)} /><span className="mr-auto text-muted-foreground">{grouped.registeredExtensions.length} 个组件 · {grouped.registeredExtensions.reduce((count, provider) => count + new Set(provider.tools.map(tool => tool.name)).size, 0)} 项工具{inventory.snapshot?.limited ? ' · 部分结果' : ''}</span><Button size="sm" variant="outline" onClick={inventory.refresh} disabled={inventory.loading}><RefreshCw className={inventory.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新清单</Button></div>
          {inventoryUnavailable ? <p role="alert" className="text-xs text-destructive">扩展工具清单暂时无法核对，已有记录保留。</p> : inventory.snapshot?.state === 'partial' && <p className="text-xs text-muted-foreground">部分注册范围尚未读取，当前组件与工具可能不完整。</p>}
          <div className={cardGridClass}>{extensionToolGroups.map(({ provider, extension, tools }) => <article key={provider.id} aria-label={provider.name} className="min-w-0 overflow-hidden rounded-lg border bg-card">
            <header className="flex items-start gap-2.5 px-3 pt-3"><FeatureIcon id={provider.id} kind="tools" /><div className="min-w-0 flex-1"><div className="flex items-start gap-2"><h3 className="min-w-0 flex-1 break-words text-[13px] font-semibold leading-5">{provider.name}</h3><span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{new Set(tools.map(tool => tool.name)).size} 项工具</span></div><p className="text-[11px] leading-4 text-muted-foreground">{extension?.origin ?? '外部工具服务'}</p></div></header>
            <div className="px-3 py-2"><p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{toolProviderDescription(extension, provider.tools)}</p></div>
            <div className="px-3 pb-2"><ExtensionTools compact tools={tools} declaredNames={[]} conflicts={grouped.conflicts.filter(conflict => tools.some(tool => tool.name === conflict.name))} ownerNames={packageNames} sources={inventory.snapshot?.sources} unavailable={inventoryUnavailable} /></div>
            {Boolean(extension?.runtimePackage?.dependencies?.length) && <footer className="flex flex-wrap items-center gap-1 border-t px-3 py-2 text-[11px] text-muted-foreground"><span>依赖</span>{extension?.runtimePackage?.dependencies?.map(id => <span key={id} className="rounded bg-muted px-1.5 py-0.5">{packageNames.get(id) ?? id}</span>)}</footer>}
          </article>)}{extensionToolGroups.length === 0 && <p className="col-span-full py-3 text-xs text-muted-foreground">{inventory.loading && !inventory.snapshot ? '正在读取扩展工具…' : toolSearch ? '没有匹配的扩展工具。' : inventoryUnavailable ? '连接 DSH 并刷新后查看扩展注入的工具。' : '当前没有已登记的扩展工具。'}</p>}</div>
        </section>
      </TabsContent>
      <TabsContent value="extensions" keepMounted className="grid min-w-0 grid-cols-1 gap-2 [&[hidden]]:hidden">
        <section id="local-extensions" aria-label="扩展功能" className="grid min-w-0 grid-cols-1 gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs"><Input className="min-w-0 max-w-80 flex-1 basis-48" aria-label="搜索扩展包" placeholder="搜索名称、用途或标识" value={query} onChange={event => setQuery(event.target.value)} /><span className="mr-auto text-muted-foreground">{filteredExtensions.length} / {extensions.length} 项扩展{features?.projection?.featuresLimited || inventory.snapshot?.limited ? ' · 部分结果' : ''}</span><ReadOnlyDetails title="扩展包设置" label="扩展设置" description="按扩展包提供的配置字段保存设置。"><PackageConfigurationManager api={api} connected={connected} setDirty={props.setDirty} excludeIds={builtinIds} /></ReadOnlyDetails><NativeBootstrapSummary api={api} connected={connected} />{refreshButton}</div>
          {(directory.error || runtime.error) && <p role="alert" className="text-xs text-destructive">扩展状态读取失败，已保留上次结果。请刷新后核对。</p>}
          {(inventory.error || inventory.snapshot?.state === 'unavailable') ? <p role="alert" className="text-xs text-destructive">工具清单暂时无法核对，扩展列表与已有记录保留。</p>
            : inventory.snapshot?.state === 'partial' ? <p className="text-xs text-muted-foreground">部分工具来源尚未读取，包含工具与扩展来源列表可能不完整。</p>
              : inventory.snapshot?.state === 'not-connected' && <p className="text-xs text-muted-foreground">DSH 尚未连接，工具登记与会话加载状态待核对。</p>}
          <div className={cardGridClass}>{filteredExtensions.map(item => {
            const state = item.runtimePackage ? runtime.error ? '状态待核对' : nativePackageStateLabels[item.runtimePackage.state]
                : directory.error ? '状态待核对' : item.actual?.installed ? item.actual.ready ? '运行中' : '已接入，聊天未就绪' : featureStatusLabel(item.feature?.status ?? 'unknown');
            const conflicts = grouped.conflicts.filter(conflict => conflict.owners.includes(item.id));
            const dependencies = item.runtimePackage?.dependencies;
            const toolCount = new Set([...item.toolNames, ...item.tools.map(tool => tool.name)]).size;
            return <article key={item.id} aria-label={item.name} className="min-w-0 overflow-hidden rounded-lg border bg-card">
              <header className="flex items-start gap-2.5 px-3 pt-3"><FeatureIcon id={item.id} kind="extension" /><div className="min-w-0 flex-1"><div className="flex items-start gap-2"><h3 className="min-w-0 flex-1 break-words text-[13px] font-semibold leading-5">{item.name}</h3><span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{toolCount} 项工具</span></div><p className="text-[11px] leading-4 text-muted-foreground">{item.origin}</p></div></header>
              <div className="px-3 py-2"><p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{shortDescription(item.description)}</p></div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-3 text-[11px]"><span className="text-muted-foreground">版本 {item.runtimePackage?.version ?? item.actual?.version ?? '未报告'}</span><StatusPill tone={(item.runtimePackage ? !runtime.error && item.runtimePackage.state === 'running' : !directory.error && item.actual?.ready) ? 'success' : 'neutral'}>{state}</StatusPill>{conflicts.length > 0 && <span className="text-destructive">{conflicts.length} 项工具归属冲突</span>}</div>
              <footer className="flex flex-wrap items-center gap-1 border-t px-3 py-1.5"><div className="mr-auto flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-muted-foreground">{dependencies?.map(id => <span key={id} className="rounded bg-muted px-1.5 py-0.5">依赖 {packageNames.get(id) ?? id}</span>)}</div><ReadOnlyDetails title={item.name} description="扩展用途、包含工具、运行依赖与状态。"><div className="grid min-w-0 grid-cols-1 gap-3">
                <p className="whitespace-pre-wrap leading-relaxed">{item.description}</p>
                {item.runtimePackage && <section className="grid gap-1.5"><h3 className="text-xs font-medium">运行依赖</h3>{dependencies === undefined ? <p className="text-xs text-muted-foreground">此包未报告运行依赖关系。</p> : dependencies.length === 0 ? <p className="text-xs text-muted-foreground">未声明运行依赖。</p> : <ul className="m-0 list-none divide-y rounded border px-2 text-xs">{dependencies.map(id => <li key={id} className="py-1.5"><span className="font-medium">{packageNames.get(id) ?? id}</span><span className="ml-2 break-all text-muted-foreground">{id}</span></li>)}</ul>}</section>}
                <ExtensionTools tools={item.tools} declaredNames={item.toolNames} conflicts={conflicts} ownerNames={packageNames} sources={inventory.snapshot?.sources} unavailable={inventoryUnavailable} />
                <TechnicalDetails fields={[{ label: item.runtimePackage ? '包标识' : '功能标识', value: item.id }, { label: '扩展类型', value: item.origin }, { label: '运行状态', value: state }, { label: '版本', value: item.runtimePackage?.version ?? item.actual?.version }, { label: '活动资源', value: item.runtimePackage?.resources.filter(resource => resource.state === 'active').length }, { label: '声明能力', value: item.feature?.capabilities ?? item.actual?.capabilities }, { label: '包运行记录', value: item.runtimePackage }, { label: '功能记录', value: item.feature }, { label: '接入状态', value: item.actual }, { label: '工具清单状态', value: inventory.snapshot?.state }, { label: '工具核对原因', value: inventory.snapshot?.missingReasons }, { label: '读取错误', value: loadError || (runtime.error ? errorMessage(runtime.error) : inventory.error ? errorMessage(inventory.error) : null) }]} />
              </div></ReadOnlyDetails></footer>
            </article>;
          })}{filteredExtensions.length === 0 && <p className="col-span-full py-3 text-xs text-muted-foreground">{loading && !extensions.length ? '正在读取扩展包…' : extensions.length ? '没有匹配的扩展包。' : directory.error || runtime.error ? '扩展包列表暂时无法核对。' : '当前没有已登记的扩展。'}</p>}</div>
        </section>
      </TabsContent>
      <TabsContent value="framework" keepMounted className="grid min-w-0 grid-cols-1 gap-2 [&[hidden]]:hidden">
        <ChatTools connected={connected} inventory={frameworkInventory} error={inventory.error} loading={inventory.loading} refresh={inventory.refresh} title="框架注入 DSH" showHeading sectionId="chat-tools" />
        <section id="framework-services" aria-label="框架功能" className="grid min-w-0 grid-cols-1 gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs"><h2 className="mr-auto text-[13px] font-semibold">框架功能</h2>{refreshButton}</div>
          {(directory.error || runtime.error) && <p role="alert" className="text-xs text-destructive">服务状态读取失败，已保留上次结果；请刷新后核对。</p>}
          <div className={cardGridClass}>
            {relay && <article className="min-w-0 overflow-hidden rounded-lg border bg-card"><header className="flex items-center gap-2.5 px-3 pt-3"><FeatureIcon id="agent-relay" kind="service" /><h3 className="text-[13px] font-semibold">聊天收发</h3></header><p className="px-3 py-2 text-xs leading-5 text-muted-foreground">框架处理 QQ 消息与连续对话，按回复配置分条、引用、转发并记录发送回执。</p><footer className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-1.5"><StatusPill tone={relay.ready && !directory.error ? 'success' : 'warning'}>{directory.error ? '状态待核对' : relay.ready ? '聊天已就绪' : featureStatusLabel(relay.status)}</StatusPill><Button size="xs" variant="ghost" onClick={() => props.navigate('adapters')}>查看连接<ArrowRight className="size-3" /></Button></footer></article>}
            {packages.map(item => { const info = builtinServices[item.id]; const page = info.page; return <article key={item.id} className="min-w-0 overflow-hidden rounded-lg border bg-card"><header className="flex items-center gap-2.5 px-3 pt-3"><FeatureIcon id={item.id} kind="service" /><h3 className="text-[13px] font-semibold">{info.name}</h3></header><p className="px-3 py-2 text-xs leading-5 text-muted-foreground">{info.description}</p><footer className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-1.5"><StatusPill tone={item.state === 'running' && !runtime.error ? 'success' : 'warning'}>{runtime.error ? '状态待核对' : item.state === 'running' ? '服务运行中' : nativePackageStateLabels[item.state]}</StatusPill>{page && <Button size="xs" variant="ghost" onClick={() => props.navigate(page)}>设置<ArrowRight className="size-3" /></Button>}</footer></article>; })}
            {!relay && packages.length === 0 && <p className="col-span-full py-3 text-xs text-muted-foreground">{loading ? '正在读取服务状态…' : '当前没有可核对的运行服务，启动聊天后重新读取。'}</p>}
          </div>
        </section>
      </TabsContent>
      <TabsContent value="dsh" keepMounted className="grid min-w-0 grid-cols-1 gap-2 [&[hidden]]:hidden">
    <section id="dsh-builtin-tools" aria-label="DSH 自带工具目录" className="grid gap-2">
      <p className="px-0.5 text-xs text-muted-foreground">DSH 自带工具由 DSH 自身提供与管理，其原生工具和 MCP 接入服务在此独立展示。</p>
      <ChatTools connected={connected} inventory={dshInventory} error={inventory.error} loading={inventory.loading} refresh={inventory.refresh} title="DSH 自带" showHeading />
    </section>
      </TabsContent>
    </Tabs>
  </div>;
}
