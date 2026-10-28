import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Plus, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { parsePluginSessionBinding, parsePluginSessionModels, parsePluginSessionSnapshot, parsePluginSessionManagementRequest,
  type PluginSessionManagementRequest } from '../../src/contracts/plugin-sessions.ts';
import type { PluginModelBinding, PluginModelDescription, PluginModelManagedSession } from '../../src/contracts/plugin-model.ts';
import { ApiError, errorMessage, isRecord, type ApiClient } from '../lib/api.ts';
import { describeConversationKey } from '../lib/activity.ts';
import type { ManagedSession } from '../lib/session-management.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { DetailsWindow, TechnicalDetails } from './read-only-details.tsx';
import { EmptyState, Section, StatusPill } from './management.tsx';
import { VirtualTableBody } from './virtual-list.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx';

const path = '/api/chat/plugin-sessions';
type Action = PluginSessionManagementRequest['action'];
type WriteState = 'idle' | 'saving' | 'error' | 'conflict' | 'unknown';
interface Target { readonly action: Action; readonly binding: PluginModelBinding | null }
const bindingKey = (row: Pick<PluginModelBinding, 'owner' | 'name' | 'conversationId'>) => JSON.stringify([row.owner, row.name, row.conversationId]);
const modelKey = (model: PluginModelDescription) => JSON.stringify([model.provider, model.model, model.reasoningEffort ?? null]);
const stateLabel = (binding: PluginModelBinding) => binding.state === 'unknown' ? '待核对' : binding.state === 'creating' ? '建立中' : binding.busy ? '占用中' : '已绑定';
const scopeLabel = (conversationId: string | null) => conversationId ? `${describeConversationKey(conversationId).label} ${describeConversationKey(conversationId).identifier}` : '插件独立会话';
const formatTime = (time: number | null) => time === null ? '尚未使用' : new Date(time).toLocaleString('zh-CN', { hour12: false });
const selectClass = 'h-[27px] min-w-0 rounded border border-input bg-background px-2 text-xs';

function managementError(error: unknown): string {
  if (error instanceof ApiError) {
    if (/binding_conflict/.test(error.code)) return '绑定已变化，请关闭弹窗并刷新后重新选择。';
    if (/session_busy/.test(error.code)) return '此模型会话正在使用，请结束当前执行后再操作。';
    if (/unsettled/.test(error.code)) return '会话仍有未确认的执行或创建操作，请先核对实际状态。';
    if (/session_not_found/.test(error.code)) return '没有找到这个 DSH 会话，请核对完整会话 ID。';
    if (error.code === 'plugin_sessions_unavailable') return '插件模型服务尚未接入，请启动聊天后刷新。';
    if (/unavailable/.test(error.code)) return '插件模型服务或所选模型暂时不可用，请核对连接状态。';
  }
  return errorMessage(error);
}

export function PluginSessions({ api, connected, active, qqSessions, qqSessionsLimited }: {
  readonly api: ApiClient;
  readonly connected: boolean;
  readonly active: boolean;
  readonly qqSessions: readonly ManagedSession[];
  readonly qqSessionsLimited: boolean;
}) {
  const write = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const resource = useReadResource(api, path, connected && active, parsePluginSessionSnapshot,
    { intervalMs: 10_000, pollWhen: () => write.current === null });
  const [target, setTarget] = useState<Target | null>(null);
  const models = useReadResource(api, `${path}/models`, connected && active && target?.action === 'create', parsePluginSessionModels);
  const [details, setDetails] = useState<PluginModelBinding | null>(null);
  const [filter, setFilter] = useState('');
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('default');
  const [scope, setScope] = useState<'none' | 'group' | 'private'>('none');
  const [scopeId, setScopeId] = useState('');
  const [source, setSource] = useState<'qq' | 'managed' | 'id'>('qq');
  const [qqSource, setQQSource] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [modelChoice, setModelChoice] = useState('');
  const [state, setState] = useState<WriteState>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const locked = state === 'saving' || state === 'conflict' || state === 'unknown';
  const bindings = resource.snapshot?.bindings ?? [];
  const managedSessions = resource.snapshot?.managedSessions ?? [];
  const boundSessionIds = new Set(bindings.map(row => row.sessionId));
  const unbound = managedSessions.filter(row => !boundSessionIds.has(row.sessionId));
  const visibleUnbound = unbound.filter(row => !filter.trim() || `${row.owner} ${row.name} ${row.sessionId} ${row.conversationId ?? ''}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  const filtered = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return bindings.filter(row => !query || `${row.owner} ${row.name} ${row.conversationId ?? ''} ${row.sessionId} ${row.model?.model ?? ''}`.toLocaleLowerCase().includes(query));
  }, [bindings, filter]);
  const references = (session: string) => [
    ...bindings.filter(row => row.sessionId === session).map(row => `${row.owner} / ${row.name}（${scopeLabel(row.conversationId)}）`),
    ...qqSessions.filter(row => row.sessionId === session).map(row => scopeLabel(row.key)),
  ];

  useEffect(() => {
    epoch.current++;
    write.current?.abort();
    write.current = null;
    setTarget(null); setDetails(null); setState('idle'); setError(''); setNotice('');
    return () => { epoch.current++; write.current?.abort(); };
  }, [api, connected]);

  function open(action: Action, binding: PluginModelBinding | null = null) {
    if (write.current || resource.error || !resource.snapshot) return;
    setTarget({ action, binding });
    setOwner(binding?.owner ?? ''); setName(binding?.name ?? 'default');
    const match = binding?.conversationId ? /^(group|private):(.+)$/.exec(binding.conversationId) : null;
    setScope(match?.[1] === 'group' ? 'group' : match?.[1] === 'private' ? 'private' : 'none');
    setScopeId(match?.[2] ?? ''); setSessionId(''); setQQSource(''); setSource('qq');
    setModelChoice(''); setState('idle'); setError('');
  }
  function openManaged(row: PluginModelManagedSession) {
    if (write.current || resource.error || !resource.snapshot) return;
    open('bind');
    setOwner(row.owner);
    setName(row.name);
    const scopeMatch = row.conversationId ? /^(group|private):(.+)$/.exec(row.conversationId) : null;
    setScope(scopeMatch?.[1] === 'group' ? 'group' : scopeMatch?.[1] === 'private' ? 'private' : 'none');
    setScopeId(scopeMatch?.[2] ?? '');
    // Preserve any newer binding with the same plugin key; explicit replacement uses that row's CAS revision.
    const existing = bindings.find(binding => bindingKey(binding) === bindingKey(row));
    setTarget({ action: 'bind', binding: existing ?? null });
    setSource('managed');
    setSessionId(row.sessionId);
  }
  function close() {
    if (state === 'saving') return;
    if (state === 'unknown' || state === 'conflict') resource.refresh();
    setTarget(null); setState('idle'); setError('');
  }
  async function submit() {
    const chosen = target;
    if (!chosen || write.current || locked || !connected || resource.error || !resource.snapshot) return;
    const conversationId = scope === 'none' ? undefined : `${scope}:${scopeId}`;
    const current = resource.snapshot.bindings.find(row => bindingKey(row) === bindingKey({ owner, name, conversationId: conversationId ?? null }));
    if (chosen.binding ? !current || current.revision !== chosen.binding.revision || chosen.action !== 'reconcile' && (current.busy || current.state !== 'ready') : current !== undefined) {
      setState('conflict'); setError('绑定已变化，请关闭弹窗并刷新后重新选择。'); return;
    }
    const base = { owner, name, ...(conversationId ? { conversationId } : {}), revision: chosen.binding?.revision ?? null, confirm: true as const };
    let request: PluginSessionManagementRequest;
    if (chosen.action === 'unbind' || chosen.action === 'reconcile') request = { ...base, action: chosen.action };
    else if (chosen.action === 'bind') {
      const qq = source === 'qq' ? qqSessions.find(row => row.key === qqSource) : undefined;
      if (source === 'managed' && !managedSessions.some(row => row.sessionId === sessionId)) { setState('error'); setError('已创建的会话列表已变化，请重新选择。'); return; }
      if (source === 'qq' && !qq) { setState('error'); setError('请选择一个已加载的 QQ 会话。'); return; }
      request = { ...base, action: 'bind', sessionId: qq?.sessionId ?? sessionId,
        ...(qq ? { qqConversationId: qq.key } : {}) };
    } else {
      const selected = models.snapshot?.find(row => modelKey(row) === modelChoice);
      if (modelChoice && !selected) { setState('error'); setError('所选模型已变化，请重新选择。'); return; }
      request = { ...base, action: 'create', ...(selected ? { model: { provider: selected.provider, model: selected.model,
        ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) } } : {}) };
    }
    if (!parsePluginSessionManagementRequest(request)) {
      setState('error'); setError('插件标识、用途或目标会话 ID 格式无效，请使用字母、数字及常见标识符分隔符。'); return;
    }
    const controller = new AbortController();
    const generation = epoch.current;
    write.current = controller;
    const live = () => !controller.signal.aborted && epoch.current === generation && connection.current.api === api
      && connection.current.connected && write.current === controller;
    setState('saving'); setError('');
    try {
      let reconciled: PluginModelBinding | null = null;
      const response = await writeResource(api, path, request, controller.signal);
      if (!live()) return;
      if (!isRecord(response) || response.schema !== 1 || response.ok !== true || response.action !== chosen.action || response.historyPreserved !== true)
        throw new ApiError('plugin_session_operation_unknown', 504);
      if (chosen.action === 'unbind') {
        if (response.owner !== owner || response.name !== name || response.conversationId !== (conversationId ?? null))
          throw new ApiError('plugin_session_operation_unknown', 504);
      } else {
        const binding = parsePluginSessionBinding(response.binding);
        if (!binding || binding.owner !== owner || binding.name !== name || binding.conversationId !== (conversationId ?? null)
          || chosen.action !== 'reconcile' && binding.state !== 'ready' || request.action === 'bind' && binding.sessionId !== request.sessionId)
          throw new ApiError('plugin_session_operation_unknown', 504);
        if (chosen.action === 'reconcile') {
          if (response.executionRepeated !== false) throw new ApiError('plugin_session_operation_unknown', 504);
          reconciled = binding;
        }
      }
      const message = chosen.action === 'reconcile' ? reconciled?.state === 'ready' ? '已核对原会话，绑定恢复可用，未重复执行。' : '已核对原会话，证据仍不足，继续保留待核对状态。' : chosen.action === 'unbind' ? '已解除插件会话绑定，模型历史保留。' : chosen.action === 'create' ? '已新建并绑定插件会话。' : '已更换插件会话绑定。';
      setTarget(null); setState('idle'); setNotice(message); resource.refresh();
      if (chosen.action === 'reconcile' && reconciled?.state !== 'ready') toast.warning(message);
      else toast.success(message);
    } catch (failure) {
      if (!live()) return;
      if (failure instanceof ApiError && failure.status === 409) { setState('conflict'); setError(managementError(failure)); }
      else if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) { setState('error'); setError(managementError(failure)); }
      else { setState('unknown'); setError(`操作结果尚未确认，请关闭弹窗并刷新核对。${managementError(failure)}`); }
    } finally { if (write.current === controller) write.current = null; }
  }
  const available = connected && !resource.error && resource.snapshot !== null && state !== 'saving' && !resource.loading;
  const targetTitle = target?.action === 'reconcile' ? '核对插件会话状态' : target?.action === 'unbind' ? '解除插件会话绑定？' : target?.action === 'bind' ? '绑定已有会话' : '新建并绑定插件会话';
  if (!connected) return null;
  return <Section id="plugin-session-bindings" title="插件会话" className="[&>.panel-header]:hidden [&>.panel-body]:p-0">
    <div className="flex flex-wrap items-center gap-2 px-2.5 py-2"><div className="relative w-64 max-w-full"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={filter} onChange={event => setFilter(event.target.value)} className="pl-8" placeholder="搜索插件、群号或会话 ID" aria-label="搜索插件会话" /></div><span className="mr-auto text-xs text-muted-foreground">{bindings.length} 条绑定</span><Button size="sm" variant="outline" disabled={!available} onClick={() => open('bind')}>绑定已有会话</Button><Button size="sm" variant="outline" disabled={!available} onClick={() => open('create')}><Plus className="size-3.5" />新建会话</Button><Button size="sm" variant="outline" disabled={resource.loading || state === 'saving'} onClick={resource.refresh}><RefreshCw className={resource.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新</Button></div>
    {notice && <p className="px-2.5 pb-2 text-xs" role="status">{notice}</p>}
    {resource.error && <p className="px-2.5 pb-2 text-xs text-destructive" role="alert">插件会话读取失败：{managementError(resource.error)} 已保留上次结果，暂不可操作。</p>}
    {resource.loading && !resource.snapshot && <p className="px-2.5 py-4 text-xs text-muted-foreground">正在读取插件会话…</p>}
    {resource.snapshot && filtered.length === 0 && <EmptyState title={bindings.length ? '没有匹配的插件绑定' : '暂无插件绑定'} description={managedSessions.length ? '已创建的会话保留在下方列表中，可选择绑定。' : bindings.length ? '可以搜索插件标识、会话名称、群号或完整模型会话 ID。' : '插件第一次持久调用时会自动建立会话，也可在此新建或绑定已有会话。'} />}
    {filtered.length > 0 && <div className="tablewrap overscroll-contain border-y" tabIndex={0} role="region" aria-label="插件会话绑定列表"><table className="w-full min-w-[58rem] text-left text-[11px]"><thead className="bg-muted text-muted-foreground"><tr>{['插件', '用途', '范围', '模型', '会话', '状态', '最近使用', '操作'].map(label => <th key={label} className="px-2 py-1 font-medium last:text-right">{label}</th>)}</tr></thead><VirtualTableBody items={filtered} getItemKey={bindingKey} columns={8} estimateSize={32}>{row => <tr key={bindingKey(row)} className="hover:bg-muted/30"><td className="max-w-40 truncate px-2 py-0.5" title={row.owner}>{row.owner}</td><td className="px-2 py-0.5">{row.name}</td><td className="whitespace-nowrap px-2 py-0.5">{scopeLabel(row.conversationId)}</td><td className="max-w-36 truncate px-2 py-0.5" title={row.model ? `${row.model.provider} / ${row.model.model}` : undefined}>{row.model?.model ?? '已有会话配置'}</td><td className="px-2 py-0.5"><Button size="sm" variant="ghost" className="h-6 px-1 text-[11px] font-mono" title={row.sessionId} onClick={() => setDetails(row)}>{row.sessionId.slice(-10)}</Button></td><td className="whitespace-nowrap px-2 py-0.5"><StatusPill tone={row.busy ? 'warning' : row.state === 'ready' ? 'success' : 'neutral'}>{stateLabel(row)}</StatusPill></td><td className="whitespace-nowrap px-2 py-0.5 text-muted-foreground">{formatTime(row.lastUsedAt)}</td><td className="px-2 py-0.5"><div className="flex items-center justify-end gap-0.5 [&>button]:h-6 [&>button]:px-1.5 [&>button]:text-[11px]"><Button size="sm" variant="ghost" onClick={() => setDetails(row)}>详情</Button>{(row.state !== 'ready' || row.busy) && <Button size="sm" variant="ghost" disabled={!available} onClick={() => open('reconcile', row)}>核对状态</Button>}<Button size="sm" variant="ghost" disabled={!available || row.busy || row.state !== 'ready'} onClick={() => open('bind', row)}>更换绑定</Button><Button size="sm" variant="ghost" disabled={!available || row.busy || row.state !== 'ready'} onClick={() => open('create', row)}>新建并绑定</Button><Button size="sm" variant="ghost" className="text-destructive" disabled={!available || row.busy || row.state !== 'ready'} onClick={() => open('unbind', row)}>解绑</Button></div></td></tr>}</VirtualTableBody></table></div>}
    {resource.snapshot?.managedSessions !== undefined && <div className="border-t"><div className="flex flex-wrap items-center gap-2 px-2.5 py-2 text-xs"><strong className="font-medium">未绑定会话</strong><span className="text-muted-foreground">{unbound.length} 个已创建会话尚无插件绑定，包含单次调用和解除绑定后保留的会话。</span></div>{visibleUnbound.length === 0 ? <p className="px-2.5 pb-3 text-xs text-muted-foreground">{unbound.length ? '没有匹配的未绑定会话。' : '暂无未绑定会话。'}</p> : <div className="tablewrap overscroll-contain border-y" tabIndex={0} role="region" aria-label="未绑定插件会话"><table className="w-full min-w-[48rem] text-left text-[11px]"><thead className="bg-muted text-muted-foreground"><tr>{['插件', '用途', '类型', '完整会话 ID', '建立时间', '操作'].map(label => <th key={label} className="px-2 py-1 font-medium last:text-right">{label}</th>)}</tr></thead><VirtualTableBody items={visibleUnbound} getItemKey={row => row.sessionId} columns={6} estimateSize={32}>{row => <tr key={row.sessionId} className="hover:bg-muted/30"><td className="px-2 py-0.5">{row.owner}</td><td className="px-2 py-0.5">{row.name}</td><td className="whitespace-nowrap px-2 py-0.5 text-muted-foreground">{row.mode === 'stateless' ? '单次调用' : '持久会话'}</td><td className="max-w-80 break-all px-2 py-0.5 font-mono">{row.sessionId}</td><td className="whitespace-nowrap px-2 py-0.5 text-muted-foreground">{formatTime(row.createdAt)}</td><td className="px-2 py-0.5 text-right"><Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={!available} onClick={() => openManaged(row)}>绑定已有会话</Button></td></tr>}</VirtualTableBody></table></div>}</div>}
    <DetailsWindow open={details !== null} onOpenChange={open => { if (!open) setDetails(null); }} title="插件会话详情" description="插件与具体模型会话的绑定关系。">{details && <div className="grid gap-3"><TechnicalDetails fields={[{ label: '插件', value: details.owner }, { label: '用途', value: details.name }, { label: '范围', value: scopeLabel(details.conversationId) }, { label: '完整会话 ID', value: details.sessionId }, { label: '模型', value: details.model ? `${details.model.provider} / ${details.model.model}` : '沿用已有会话配置' }, { label: '状态', value: stateLabel(details) }, { label: '建立时间', value: formatTime(details.createdAt) }, { label: '最近使用', value: formatTime(details.lastUsedAt) }, { label: '绑定版本', value: details.revision }, ...(details.contextRestartedFrom ? [{ label: '旧会话已不存在，重建前的会话', value: details.contextRestartedFrom }] : [])]} /><div className="text-xs leading-6"><strong>共享此会话的绑定</strong>{references(details.sessionId).map(reference => <p key={reference}>{reference}</p>)}{qqSessionsLimited && <p className="text-muted-foreground">QQ 会话尚未加载完整，可能还有其他共享绑定。</p>}</div><Button variant="outline" onClick={() => void navigator.clipboard.writeText(details.sessionId).then(() => toast.success('已复制会话 ID'), () => toast.error('复制失败，请手动选取会话 ID'))}>复制会话 ID</Button></div>}</DetailsWindow>
    <Dialog open={target !== null} onOpenChange={open => { if (!open) close(); }}><DialogContent showCloseButton={state !== 'saving'}><DialogHeader><DialogTitle>{targetTitle}</DialogTitle><DialogDescription>{target?.action === 'reconcile' ? '只核对原会话和原执行的现有证据，不重复执行。证据不足时继续保留待核对状态。' : target?.action === 'unbind' ? '解除后，插件下次持久调用会创建新会话。当前模型历史保留。' : target?.action === 'bind' ? '选择 QQ 或插件已有会话，或输入完整 DSH 会话 ID。共享同一会话时，各入口继续使用同一段模型上下文。' : '选择插件、用途和范围，创建一个新的模型会话。已有模型历史保留。'}</DialogDescription></DialogHeader>
      {target && <div className="grid gap-3 text-xs"><div className="grid grid-cols-2 gap-2"><label className="grid gap-1">插件标识<Input value={owner} maxLength={256} disabled={locked || target.binding !== null} onChange={event => setOwner(event.target.value)} placeholder="插件稳定标识" /></label><label className="grid gap-1">会话用途<Input value={name} maxLength={256} disabled={locked || target.binding !== null} onChange={event => setName(event.target.value)} placeholder="default" /></label></div><div className="flex gap-2"><label className="grid flex-1 gap-1">会话范围<select className={selectClass} value={scope} disabled={locked || target.binding !== null} onChange={event => setScope(event.target.value as typeof scope)}><option value="none">插件独立会话</option><option value="group">按 QQ 群区分</option><option value="private">按 QQ 私聊区分</option></select></label>{scope !== 'none' && <label className="grid flex-1 gap-1">{scope === 'group' ? '群号' : 'QQ 号'}<Input value={scopeId} maxLength={32} disabled={locked || target.binding !== null} onChange={event => setScopeId(event.target.value)} inputMode="numeric" /></label>}</div>
        {target.binding && <p className="break-all rounded border bg-muted/20 p-2 text-muted-foreground">当前会话：{target.binding.sessionId}</p>}
        {target.action === 'bind' && <><div className="flex gap-2"><Button size="sm" variant={source === 'qq' ? 'secondary' : 'outline'} disabled={locked} onClick={() => setSource('qq')}>QQ 已有会话</Button><Button size="sm" variant={source === 'managed' ? 'secondary' : 'outline'} disabled={locked} onClick={() => { setSource('managed'); if (!managedSessions.some(row => row.sessionId === sessionId)) setSessionId(''); }}>插件已有会话</Button><Button size="sm" variant={source === 'id' ? 'secondary' : 'outline'} disabled={locked} onClick={() => setSource('id')}>输入会话 ID</Button></div>{source === 'qq' ? <label className="grid gap-1">选择 QQ 会话<select className={selectClass} value={qqSource} disabled={locked} onChange={event => setQQSource(event.target.value)}><option value="">请选择已加载的会话</option>{qqSessions.map(row => <option key={row.key} value={row.key}>{scopeLabel(row.key)} · {row.sessionId.slice(-10)}</option>)}</select>{qqSessionsLimited && <span className="text-muted-foreground">当前为已加载的 QQ 绑定，可回到 QQ 页签继续加载，或直接输入会话 ID。</span>}</label> : source === 'managed' ? <label className="grid gap-1">选择已创建的插件会话<select className={selectClass} value={sessionId} disabled={locked} onChange={event => setSessionId(event.target.value)}><option value="">请选择已创建的会话</option>{managedSessions.map(row => <option key={row.sessionId} value={row.sessionId}>{row.owner} / {row.name} · {row.sessionId.slice(-10)}{row.mode === 'stateless' ? ' · 单次调用' : ''}</option>)}</select></label> : <label className="grid gap-1">DSH 会话 ID<Input value={sessionId} maxLength={256} disabled={locked} onChange={event => setSessionId(event.target.value)} placeholder="输入完整模型会话 ID" /></label>}</>}
        {target.action === 'create' && <label className="grid gap-1">模型<span className="text-muted-foreground">插件新建会话使用自身消息与历史，不载入 QQ 人设或聊天方案。</span><select className={selectClass} value={modelChoice} disabled={locked || models.loading || Boolean(models.error)} onChange={event => setModelChoice(event.target.value)}><option value="">使用框架默认模型</option>{models.snapshot?.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.providerName} / {model.modelName}</option>)}</select>{models.loading && <span className="text-muted-foreground">正在读取可用模型…</span>}{models.error && <span className="text-destructive" role="alert">模型列表读取失败：{managementError(models.error)}<Button size="sm" variant="ghost" onClick={models.refresh}>重试读取</Button></span>}</label>}
      </div>}{error && <p className="text-xs leading-5 text-destructive" role="alert">{error}</p>}<DialogFooter><Button variant="outline" disabled={state === 'saving'} onClick={close}>{state === 'conflict' || state === 'unknown' ? '关闭并刷新' : '取消'}</Button><Button variant={target?.action === 'unbind' ? 'destructive' : 'default'} disabled={locked || !owner || !name || scope !== 'none' && !/^[1-9]\d{0,31}$/.test(scopeId) || target?.action === 'bind' && !(source === 'qq' ? qqSource : sessionId) || target?.action === 'create' && (models.loading || Boolean(models.error))} onClick={() => void submit()}>{state === 'saving' && <LoaderCircle className="size-3.5 animate-spin" />}{state === 'saving' ? '正在处理' : target?.action === 'reconcile' ? '核对状态' : target?.action === 'unbind' ? '确认解绑' : target?.action === 'bind' ? '确认绑定' : '创建并绑定'}</Button></DialogFooter></DialogContent></Dialog>
  </Section>;
}
