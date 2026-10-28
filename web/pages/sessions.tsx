import { AutomaticMaintenanceStatus } from '../components/automatic-maintenance-status.tsx';
import { WorkRecords } from '../components/work-records.tsx';
import { SimulationSessions } from '../components/simulation-sessions.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.tsx';
import { SessionDeleteDialog } from '../components/session-delete-dialog.tsx';
import { parseNativeInboxSummary } from '../../src/contracts/native-inbox.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { DetailsWindow, ReadOnlyDetails, TechnicalDetails } from '../components/read-only-details.tsx';
import { inboxStateLabel } from '../lib/chat-inbox.ts';
import { ChatInboxState } from '../components/chat-inbox-state.tsx';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, LoaderCircle, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { ConnectPrompt, EmptyState, PageHeading, Section } from '../components/management.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx';
import { Input } from '../components/ui/input.tsx';
import { VirtualTableBody } from '../components/virtual-list.tsx';
import { ConversationMediaDiagnostics } from '../components/conversation-media-diagnostics.tsx';
import { ConversationDiagnostics } from '../components/conversation-diagnostics.tsx';
import { ExecutionJournal } from '../components/execution-journal.tsx';
import { ChatInteractions } from '../components/chat-interactions.tsx';
import { ApiError, errorMessage, isRecord } from '../lib/api.ts';
import { describeConversationKey, parseUsageSnapshot } from '../lib/activity.ts';
import { hasSessionResetTarget, parseSessionResetResult, parseSessionSnapshot, type ManagedSession, type SessionSnapshot } from '../lib/session-management.ts';
import type { PageProps } from '../lib/types.ts';
import { mergeSessionPages, sessionCollectionLimit, sessionPagePath } from '../lib/session-pages.ts';

type ResetState = 'idle' | 'saving' | 'conflict' | 'unknown' | 'error';

function resetError(error: unknown): ResetState {
  if (error instanceof ApiError && (error.status === 409 || /conflict|stale|revision/.test(error.code))) return 'conflict';
  if (error instanceof ApiError && (error.status >= 500 || /unknown/.test(error.code))) return 'unknown';
  return error instanceof ApiError && error.status >= 400 && error.status < 500 ? 'error' : 'unknown';
}

function resetMessage(state: ResetState, error: string): string {
  if (state === 'conflict') return error || '会话列表已在其他位置变化。请重新读取列表，再检查并确认当前绑定。';
  if (state === 'unknown') return '暂时无法确认重置是否完成。请勿再次提交；关闭窗口后手动刷新当前状态。';
  return error;
}

function sessionError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'session_reset_requires_stopped') return '请先在连接设置中停止聊天，再刷新会话列表。';
    if (error.code === 'session_reset_busy') return '此会话正在处理消息，或已有维护操作在进行，请稍后再试。';
    if (error.code === 'session_reset_execution_unsettled') return '尚未确认这条会话的处理或发送已结束，请稍后再试。';
    if (error.code === 'session_reset_conflict') return '这条会话绑定已变化，请刷新后重新选择。';
  }
  if (error instanceof ApiError && error.code === 'runtime_not_connected') {
    return '原生聊天宿主尚未接入，会话管理当前不可用。';
  }
  return errorMessage(error);
}

export function SessionsPage(props: PageProps) {
  const { api, connected, connect } = props;
  const inbox = useReadResource(api, '/api/chat/inbox', connected, parseNativeInboxSummary, { intervalMs: 5_000 });
  const inboxItems = useMemo(() => new Map(inbox.snapshot?.items.map(item => [item.conversationId, item]) ?? []), [inbox.snapshot]);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedSession | null>(null);
  const [diagnosticKey, setDiagnosticKey] = useState<string | null>(null);
  const [mediaKey, setMediaKey] = useState<string | null>(null);
  const [detailTarget, setDetailTarget] = useState<ManagedSession | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sessionView, setSessionView] = useState('qq');
  const deferredFilter = useDeferredValue(filter);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reloadVersion, setReloadVersion] = useState(0);
  const [notice, setNotice] = useState('');
  const [resetTarget, setResetTarget] = useState<ManagedSession | null>(null);
  const [resetState, setResetState] = useState<ResetState>('idle');
  const [resetErrorText, setResetErrorText] = useState('');
  const [deleteLedgerOnReset, setDeleteLedgerOnReset] = useState(false);
  const [resetPhase, setResetPhase] = useState<'reading-ledger' | 'unbinding' | 'deleting-ledger' | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [pagingBlocked, setPagingBlocked] = useState(false);
  const lifecycle = useRef(0);
  const moreController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const cursors = useRef(new Set<string>());
  const selectedSession = useRef<ManagedSession | null>(null);
  const loadedApi = useRef(api);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };

  const loadSessions = useCallback(async (signal: AbortSignal, epoch: number): Promise<void> => {
    const page = parseSessionSnapshot(await readResource(api, sessionPagePath(), signal));
    if (signal.aborted || lifecycle.current !== epoch || connection.current.api !== api || !connection.current.connected) return;
    if (!page) throw new Error('invalid_sessions_response');
    const next = { ...mergeSessionPages(null, page).snapshot, source: page.source, historyReadOnly: page.historyReadOnly, deleteAvailable: page.deleteAvailable };
    cursors.current.clear();
    setSnapshot(next);
    setSelectedKey(current => current ?? next.sessions[0]?.key ?? null);
    setMoreError('');
    setPagingBlocked(false);
    setLoadError('');
  }, [api]);

  useEffect(() => {
    const epoch = ++lifecycle.current;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && lifecycle.current === epoch && connection.current.api === api && connection.current.connected;
    moreController.current?.abort();
    moreController.current = null;
    writeController.current?.abort();
    writeController.current = null;
    setMoreLoading(false);
    setMoreError('');
    setPagingBlocked(false);
    setResetTarget(null);
    setDiagnosticKey(null);
    setMediaKey(null);
    setDetailTarget(null);
    setDeleteTarget(null);
    setResetState('idle');
    setDeleteLedgerOnReset(false);
    setResetPhase(null);
    if (loadedApi.current !== api) {
      loadedApi.current = api;
      setSnapshot(null);
      setSelectedKey(null);
      selectedSession.current = null;
    }
    if (!connected) {
      setSnapshot(null);
      setSelectedKey(null);
      selectedSession.current = null;
      setLoadError('');
      setLoading(false);
      return () => { controller.abort(); lifecycle.current += 1; };
    }
    setLoading(true);
    setLoadError('');
    void loadSessions(controller.signal, epoch).catch(error => {
      if (current()) {
        setSnapshot(null);
        setSelectedKey(null);
        setLoadError(sessionError(error));
      }
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => { controller.abort(); lifecycle.current += 1; moreController.current?.abort(); writeController.current?.abort(); };
  }, [connected, loadSessions, reloadVersion]);

  async function loadMore(): Promise<void> {
    const cursor = snapshot?.next;
    if (!snapshot || !cursor || loading || moreController.current || pagingBlocked) return;
    if (snapshot.sessions.length >= sessionCollectionLimit || cursors.current.size >= 1000) {
      setPagingBlocked(true);
      setMoreError('已达到本次读取的容量上限，服务端仍有后续记录；当前不是全量结果，请刷新后按需读取。');
      return;
    }
    const controller = new AbortController();
    const epoch = lifecycle.current;
    moreController.current = controller;
    const current = () => !controller.signal.aborted && lifecycle.current === epoch && moreController.current === controller
      && connection.current.api === api && connection.current.connected;
    setMoreLoading(true);
    setMoreError('');
    try {
      const page = parseSessionSnapshot(await readResource(api, sessionPagePath(cursor), controller.signal));
      if (!current()) return;
      if (!page) throw new Error('invalid_sessions_response');
      if (page.next === cursor || page.next && cursors.current.has(page.next)) {
        setPagingBlocked(true);
        setMoreError('分页游标未前进或出现循环，已停止继续读取；当前不是全量结果，请刷新核对。');
        return;
      }
      const merged = mergeSessionPages(snapshot, page);
      if (merged.snapshot.sessions.length > sessionCollectionLimit) {
        setPagingBlocked(true);
        setMoreError('服务端仍有后续记录，但已达到本次读取容量上限；当前不是全量结果。');
        return;
      }
      cursors.current.add(cursor);
      setSnapshot({ ...merged.snapshot, source: page.source ?? snapshot.source,
        deleteAvailable: page.deleteAvailable ?? snapshot.deleteAvailable, historyReadOnly: page.historyReadOnly ?? snapshot.historyReadOnly });
      setSelectedKey(current => current ?? merged.snapshot.sessions[0]?.key ?? null);
      if (merged.changed > 0) setNotice(`分页期间发现 ${merged.changed} 条已加载绑定发生变化，已更新显示；分页不是一致快照，请刷新核对。`);
    } catch (error) {
      if (current()) setMoreError(`继续加载失败，已保留当前记录和游标：${sessionError(error)}`);
    } finally {
      if (current()) { moreController.current = null; setMoreLoading(false); }
    }
  }

  function cancelMore(): void {
    moreController.current?.abort();
    moreController.current = null;
    setMoreLoading(false);
    setMoreError('已取消继续加载，当前记录与下一页游标保持不变。');
  }

  const filteredSessions = useMemo(() => {
    if (!snapshot) return [];
    const query = deferredFilter.normalize('NFKC').trim().toLocaleLowerCase();
    if (!query) return snapshot.sessions;
    return snapshot.sessions.filter(session => {
      const identity = describeConversationKey(session.key);
      return [identity.label, identity.identifier, session.owner ? '主人' : '', session.key]
        .join(' ').toLocaleLowerCase().includes(query);
    });
  }, [deferredFilter, snapshot]);
  const loadedSelected = snapshot?.sessions.find(session => session.key === selectedKey) ?? null;
  if (loadedSelected) selectedSession.current = loadedSelected;
  const selected = loadedSelected ?? (selectedSession.current?.key === selectedKey ? selectedSession.current : null);
  const selectionUnconfirmed = selected !== null && loadedSelected === null;

  function reload(): void {
    lifecycle.current += 1;
    moreController.current?.abort();
    moreController.current = null;
    setNotice('');
    setReloadVersion(version => version + 1);
  }

  function openReset(session: ManagedSession): void {
    if (!connection.current.connected || snapshot?.resetAvailable !== true || !hasSessionResetTarget(session)
      || selectionUnconfirmed || loading || moreLoading || writeController.current) return;
    setResetTarget(session);
    setResetState('idle');
    setResetErrorText('');
    setDeleteLedgerOnReset(false);
    setResetPhase(null);
  }

  function closeReset(): void {
    if (resetState === 'saving') return;
    const refreshRequired = resetState === 'conflict' || resetState === 'unknown';
    setResetTarget(null);
    setResetState('idle');
    setResetErrorText('');
    setDeleteLedgerOnReset(false);
    setResetPhase(null);
    if (refreshRequired) reload();
  }

  async function resetSession(): Promise<void> {
    if (!connection.current.connected || connection.current.api !== api || !snapshot || snapshot.resetAvailable !== true
      || selectionUnconfirmed || loading || moreLoading || !resetTarget || !hasSessionResetTarget(resetTarget)
      || !snapshot.sessions.some(session => session.key === resetTarget.key && session.sessionId === resetTarget.sessionId
        && session.generation === resetTarget.generation && session.bindingRevision === resetTarget.bindingRevision)
      || resetState !== 'idle' && resetState !== 'error' || writeController.current) return;
    const controller = new AbortController();
    const target = resetTarget;
    const removeLedger = deleteLedgerOnReset;
    const epoch = lifecycle.current;
    writeController.current = controller;
    const current = () => !controller.signal.aborted && lifecycle.current === epoch && writeController.current === controller
      && connection.current.api === api && connection.current.connected;
    setResetState('saving');
    setResetErrorText('');
    let resetSubmitted = false;
    let bindingReleased = false;
    try {
      let ledgerRevision: string | null = null;
      if (removeLedger) {
        setResetPhase('reading-ledger');
        const query = new URLSearchParams({ conversationId: target.key, sessionId: target.sessionId, limit: '1' });
        const usage = parseUsageSnapshot(await readResource(api, `/api/chat/usage?${query}`, controller.signal));
        if (!current()) return;
        if (!usage?.native || usage.limited || usage.coverage?.partial
          || usage.conversations.some(row => row.key !== target.key || row.sessionId !== target.sessionId)) {
          throw new Error('session_ledger_unavailable');
        }
        const ledger = usage.conversations[0];
        if (ledger) {
          if (!ledger.revision) throw new Error('session_ledger_unavailable');
          ledgerRevision = ledger.revision;
        }
      }
      if (!current()) return;
      setResetPhase('unbinding');
      resetSubmitted = true;
      const result = parseSessionResetResult(await writeResource(api, '/api/chat/sessions/reset', {
        key: target.key,
        sessionId: target.sessionId,
        generation: target.generation,
        bindingRevision: target.bindingRevision,
        confirm: true,
      }, controller.signal), target);
      if (!current()) return;
      if (!result) throw new ApiError('session_reset_unknown', 504);
      bindingReleased = true;
      setResetTarget(null);
      setSnapshot(null);
      setSelectedKey(null);
      selectedSession.current = null;
      setLoading(true);
      let ledgerUnconfirmed = false;
      if (ledgerRevision) {
        setResetPhase('deleting-ledger');
        setNotice('已解除绑定，正在删除所选模型会话的账本。');
        try {
          const deleted = await writeResource(api, '/api/chat/usage/session/delete', {
            conversationId: target.key, sessionId: target.sessionId, revision: ledgerRevision,
          }, controller.signal);
          if (!current()) return;
          if (!isRecord(deleted) || deleted.ok !== true || typeof deleted.affected !== 'number'
            || !Number.isSafeInteger(deleted.affected) || deleted.affected < 0
            || typeof deleted.operationId !== 'string' || deleted.operationId.length === 0
            || deleted.conversationId !== undefined && deleted.conversationId !== target.key
            || deleted.sessionId !== undefined && deleted.sessionId !== target.sessionId) {
            throw new ApiError('usage_session_delete_unknown', 504);
          }
        } catch {
          if (!current()) return;
          ledgerUnconfirmed = true;
        }
      }
      if (!current()) return;
      setResetState('idle');
      setResetPhase(null);
      setNotice(ledgerUnconfirmed ? '已解除绑定，账本未确认删除，请到用量页核对。'
        : removeLedger ? ledgerRevision ? '已解除绑定并删除该模型会话账本，下次聊天将新建上下文。' : '已解除绑定；此模型会话没有已记录账本，下次聊天将新建上下文。'
          : '已解除这条会话的当前绑定；旧记录、历史和用量保留，下次聊天将新建上下文。');
      try {
        await loadSessions(controller.signal, epoch);
      } catch (error) {
        if (current()) setLoadError(sessionError(error));
      } finally {
        if (current()) setLoading(false);
      }
      if (current()) {
        if (ledgerUnconfirmed) toast.warning('已解除绑定，账本未确认删除，请到用量页核对');
        else toast.success('下次聊天将重新开始');
      }
    } catch (error) {
      if (!current()) return;
      if (bindingReleased) {
        setResetTarget(null);
        setResetState('idle');
        setNotice('已解除绑定，账本未确认删除，请到用量页核对。');
        setLoading(false);
        return;
      }
      const state = resetSubmitted ? resetError(error) : 'error';
      setResetState(state);
      setResetPhase(null);
      setResetErrorText(resetSubmitted ? sessionError(error)
        : '暂时无法核对该会话账本，尚未解除绑定。可取消“同时删除此会话账本”以保留账本，或关闭窗口后刷新重试。');
    } finally { if (writeController.current === controller) writeController.current = null; }
  }

  async function copySessionId(sessionId: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(sessionId);
      toast.success('技术会话 ID 已复制');
    } catch {
      toast.error('无法复制，请手动选择文本。');
    }
  }

  const navigateToUsage = (): void => props.navigate('usage');

  if (!connected) return <div className="page-stack" data-page="sessions"><PageHeading title="会话与执行记录" description="查看会话绑定、原执行证据、QQ 互动与独立工作。" /><ConnectPrompt connect={connect} /></div>;

  return <div className="page-stack" data-page="sessions">
    <PageHeading title="会话与执行记录" description={snapshot?.source === 'imported' ? '查看迁入的原有会话记录；尚未由新聊天接管。' : '查看会话、原执行证据、QQ 互动与独立工作。'} actions={<><AutomaticMaintenanceStatus api={api} connected={connected} />{sessionView === 'qq' && <Button variant="outline" onClick={reload} disabled={loading || resetState === 'saving'}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新</Button>}</>} />
    <Tabs value={sessionView} onValueChange={value => setSessionView(String(value))} className="gap-2"><TabsList aria-label="会话来源" className="h-[34px] justify-start"><TabsTrigger value="qq">QQ 会话</TabsTrigger><TabsTrigger value="simulation">模拟会话</TabsTrigger></TabsList><TabsContent value="qq" keepMounted className="[&[hidden]]:hidden">
    {snapshot?.source === 'imported' && <p className="rounded-lg border px-4 py-3 text-xs leading-6 text-muted-foreground" role="status">已迁入原有会话记录，尚未由新聊天接管。这里只读查看，不代表原有挂起提问或工具审批已经恢复。</p>}
    {inbox.error && <p role="status" className="rounded-lg border p-3 text-xs text-muted-foreground">收件队列暂时无法读取，已保留上次结果供核对；不会按空队列处理。</p>}
    {notice && <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-5 text-foreground" role="status"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" /><span>{notice}</span></div>}
    {loading && !snapshot ? <Section id="session-bindings" title="会话绑定"><div className="flex min-h-32 items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取真实会话绑定</div></Section>
      : loadError && !snapshot ? <Section id="sessions-unavailable" title="原生会话不可用" description={loadError} actions={<Button variant="outline" onClick={reload}>重试</Button>}><EmptyState locked title="没有可读取的原生会话" description="当前状态不会按零条会话显示。接入原生聊天宿主后再试。" /></Section>
      : snapshot && <div className="min-w-0">
        <Section id="session-bindings" title="会话" className="[&>.panel-body]:p-0">
          <div className="flex flex-wrap items-center gap-2 px-2.5 py-2"><div className="relative w-64 max-w-full"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input id="session-filter" value={filter} onChange={event => setFilter(event.target.value)} className="pl-8" placeholder="筛选群聊、私聊或 QQ 号" aria-label="筛选会话" /></div><span className="text-xs text-muted-foreground">已加载 {snapshot.sessions.length} 条绑定{snapshot.next ? ' · 仍有后续位置' : ''}</span>{inbox.snapshot && inbox.snapshot.blockedConversations > 0 && <Badge variant="outline" className="ml-auto text-status-warning">{inbox.snapshot.blockedConversations} 条收件待核对</Badge>}</div>
          {snapshot.resetAvailable !== true && <div className="mx-2.5 mb-2 flex flex-wrap items-center gap-2 text-xs leading-5 text-muted-foreground" data-session-read-only><span>{snapshot.source === 'imported' ? '迁入档案只读，不能从这里重置原有会话。' : snapshot.resetUnavailableReason === 'runtime_not_stopped' ? '请先停止聊天，再刷新列表，即可为单条会话重新开始对话。' : '当前暂不能安全重置；请先停止聊天并刷新核对。'}</span>{snapshot.source !== 'imported' && <Button size="sm" variant="outline" onClick={() => props.navigate('adapters')}>连接设置</Button>}</div>}
          {selectionUnconfirmed && selected && <div className="mx-2.5 mb-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-status-warning" data-session-unconfirmed data-selected-session={selected.key}><span>上次所选会话尚未在本批次确认，不可解除绑定；请继续加载或选择已加载行。</span><ReadOnlyDetails title="待核对的会话"><TechnicalDetails fields={[{ label: '会话', value: selected.key }, { label: '模型会话标识', value: selected.sessionId }]} /><Button size="sm" variant="outline" onClick={() => void copySessionId(selected.sessionId)}>复制标识</Button></ReadOnlyDetails><Button size="sm" variant="ghost" onClick={navigateToUsage}>用量统计</Button></div>}
          {snapshot.sessions.length === 0 ? <EmptyState title={snapshot.next ? "当前批次没有可显示绑定" : "暂无会话绑定"} description={snapshot.next ? "服务端仍有后续记录，可继续加载；当前批次可能只有尚未就绪的会话。" : "聊天宿主已返回空列表；收到新的有效对话后可能建立绑定。"} />
            : filteredSessions.length === 0 ? <EmptyState title="没有匹配的会话" description={snapshot.next ? "只筛选当前已加载记录；后续页仍可能有匹配项，可继续加载，不会修改服务端数据。" : "调整筛选词后再试；筛选不会修改服务端数据。"} />
              : <div id="session-details" className="tablewrap overscroll-contain border-y" tabIndex={0} role="region" aria-label="会话绑定列表"><table aria-rowcount={filteredSessions.length + 1} className="w-full min-w-[54rem] text-left text-[11px]"><thead className="sticky top-0 z-10 border-b bg-muted text-muted-foreground"><tr><th className="px-2 py-1 font-medium">会话</th><th className="px-2 py-1 font-medium">类型</th><th className="px-2 py-1 font-medium">身份</th><th className="px-2 py-1 font-medium">收件处理</th><th className="px-2 py-1 font-medium">队列</th><th className="px-2 py-1 font-medium">最近记录</th><th className="px-2 py-1 text-right font-medium">操作</th></tr></thead><VirtualTableBody items={filteredSessions} getItemKey={session => session.key} columns={7} estimateSize={30}>{session => {
                const identity = describeConversationKey(session.key);
                const queue = inboxItems.get(session.key);
                return <tr key={session.key} data-session-key={session.key} data-selected-session={selectedKey === session.key ? session.key : undefined} className={selectedKey === session.key ? 'bg-accent/45' : 'hover:bg-muted/30'}>
                  <td className="px-2 py-0.5"><Button size="sm" variant="ghost" className="-ml-2 h-6 max-w-44 px-2 text-[11px] font-medium text-primary tabular-nums" aria-pressed={selectedKey === session.key} title={session.key} onClick={() => { setSelectedKey(session.key); setDetailTarget(session); }}><span className="truncate">{identity.identifier}</span></Button></td>
                  <td className="whitespace-nowrap px-2 py-0.5">{identity.label}</td>
                  <td className="whitespace-nowrap px-2 py-0.5">{session.owner ? <Badge variant="secondary">主人</Badge> : <span className="text-muted-foreground">普通会话</span>}</td>
                  <td className="whitespace-nowrap px-2 py-0.5 text-muted-foreground">{inbox.error || !inbox.snapshot ? '状态待更新' : inboxStateLabel(queue)}</td>
                  <td className="px-2 py-0.5 tabular-nums text-muted-foreground">{inbox.error || !inbox.snapshot ? '未知' : queue?.pending ?? 0}</td>
                  <td className="whitespace-nowrap px-2 py-0.5 text-muted-foreground" title="会话绑定未提供最近记录时间，请查看执行日志">未提供</td>
                  <td className="px-2 py-0.5"><div className="flex items-center justify-end gap-0.5 [&>button]:h-6 [&>button]:px-1.5 [&>button]:text-[11px]"><Button size="sm" variant="ghost" onClick={() => { setSelectedKey(session.key); setDiagnosticKey(session.key); }}>检查未回复</Button><Button size="sm" variant="ghost" onClick={() => setMediaKey(session.key)}>媒体</Button><Button size="sm" variant="ghost" onClick={() => { setSelectedKey(session.key); setDetailTarget(session); }}>详情</Button><Button id={selectedKey === session.key ? 'session-reset-open' : undefined} size="sm" variant="ghost" className="text-destructive" disabled={snapshot.resetAvailable !== true || !hasSessionResetTarget(session) || selectionUnconfirmed || loading || moreLoading || resetState === 'saving'} onClick={() => { setSelectedKey(session.key); openReset(session); }}><RotateCcw className="size-3.5" />解除绑定</Button><Button size="sm" variant="ghost" className="text-destructive" disabled title="请到 DSH 删除模型会话">删除</Button></div></td>
                </tr>;
              }}</VirtualTableBody></table></div>}
          <div className="flex flex-wrap items-center gap-2 bg-muted/20 px-2.5 py-2" data-session-pagination><p className="mr-auto text-xs leading-5 text-muted-foreground">搜索仅筛选已加载的会话。删除模型会话请到 DSH。</p>{snapshot.next && <Button id="session-load-more" size="sm" variant="outline" disabled={loading || moreLoading || pagingBlocked} onClick={() => void loadMore()}>{moreLoading && <LoaderCircle className="size-3.5 animate-spin" />}{moreLoading ? "正在加载下一批" : "继续加载会话"}</Button>}{moreLoading && <Button id="session-load-cancel" size="sm" variant="ghost" onClick={cancelMore}>取消加载</Button>}</div>
          {moreError && <p className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-300" role="status">{moreError}</p>}
        </Section>
      </div>}
    </TabsContent><TabsContent value="simulation" keepMounted className="[&[hidden]]:hidden"><SimulationSessions api={api} connected={connected} active={sessionView === 'simulation'} onUsage={navigateToUsage} /></TabsContent></Tabs>
    <DetailsWindow open={detailTarget !== null} onOpenChange={open => { if (!open) setDetailTarget(null); }} title="会话详情" description={detailTarget ? `${describeConversationKey(detailTarget.key).label} ${describeConversationKey(detailTarget.key).identifier}` : '当前会话绑定'}>{detailTarget && <div className="grid gap-3"><ChatInboxState item={inboxItems.get(detailTarget.key)} known={inbox.snapshot !== null} stale={inbox.error !== null} /><TechnicalDetails fields={[{ label: '所属会话', value: detailTarget.key }, { label: '模型会话标识', value: detailTarget.sessionId }, { label: '绑定版本', value: detailTarget.bindingRevision }, { label: '第几次建立对话', value: detailTarget.generation }]} /><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void copySessionId(detailTarget.sessionId)}>复制会话标识</Button><Button variant="outline" onClick={navigateToUsage}>用量统计</Button></div></div>}</DetailsWindow>
    <DetailsWindow open={mediaKey !== null} onOpenChange={open => { if (!open) setMediaKey(null); }} title="媒体与引用记录" description={mediaKey ? `${describeConversationKey(mediaKey).label} ${describeConversationKey(mediaKey).identifier}` : '媒体读取记录'}>{mediaKey && <ConversationMediaDiagnostics api={api} connected={connected} conversationId={mediaKey} />}</DetailsWindow>
    <DetailsWindow open={diagnosticKey !== null} onOpenChange={open => { if (!open) setDiagnosticKey(null); }} title="检查未回复原因" description={diagnosticKey ? `${describeConversationKey(diagnosticKey).label} ${describeConversationKey(diagnosticKey).identifier}` : '会话检查'}>{diagnosticKey && <ConversationDiagnostics {...props} conversationId={diagnosticKey} />}</DetailsWindow>
    <Section title="相关记录" className="[&>.panel-body]:p-0">
      <Tabs defaultValue="executions" className="gap-0">
        <TabsList aria-label="会话相关记录" className="h-[34px] w-full justify-start bg-muted/30 px-2"><TabsTrigger value="executions">执行日志</TabsTrigger><TabsTrigger value="interactions">QQ 互动</TabsTrigger><TabsTrigger value="work">独立工作</TabsTrigger></TabsList>
        <TabsContent value="executions" keepMounted className="[&[hidden]]:hidden"><ExecutionJournal api={api} connected={connected} embedded /></TabsContent>
        <TabsContent value="interactions" keepMounted className="[&[hidden]]:hidden"><ChatInteractions key={reloadVersion} api={api} connected={connected} embedded /></TabsContent>
        <TabsContent value="work" keepMounted className="[&[hidden]]:hidden"><WorkRecords api={api} connected={connected} embedded /></TabsContent>
      </Tabs>
    </Section>
    <SessionDeleteDialog api={api} target={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={reload} />
    <Dialog open={resetTarget !== null} onOpenChange={open => { if (!open) closeReset(); }}>
      <DialogContent showCloseButton={resetState !== 'saving' && resetState !== 'conflict' && resetState !== 'unknown'}>
        <DialogHeader><DialogTitle>解除这条会话的绑定？</DialogTitle><DialogDescription>下次聊天将开始一段新对话。旧聊天历史保留；可选择是否同时删除这个模型会话的用量账本。</DialogDescription></DialogHeader>
        {resetTarget && <div className="grid gap-3"><div className="rounded-lg border border-destructive/25 bg-destructive/5 px-2 py-1 text-xs leading-5"><strong className="block text-destructive">{describeConversationKey(resetTarget.key).label}：{describeConversationKey(resetTarget.key).identifier}</strong><code className="block break-all text-muted-foreground" title={resetTarget.sessionId}>{resetTarget.sessionId}</code><span className="text-muted-foreground">只解除这一条绑定，账本按下方选项处理；结果未知时不会自动重试。</span></div><label className="flex items-start gap-2 text-sm"><input id="session-reset-delete-ledger" type="checkbox" className="mt-0.5 size-4 accent-primary" checked={deleteLedgerOnReset} disabled={resetState === 'saving' || resetState === 'conflict' || resetState === 'unknown'} onChange={event => { setDeleteLedgerOnReset(event.target.checked); if (resetState === 'error') { setResetState('idle'); setResetErrorText(''); } }} /><span><strong className="font-medium">同时删除此会话账本</strong><span className="mt-1 block text-xs leading-5 text-muted-foreground">删除这个模型会话已记录的用量与费用，无法撤销。不勾选时保留账本；之后新产生的用量继续记录。</span></span></label>{resetState !== 'idle' && resetState !== 'saving' && <p className="text-xs leading-5 text-destructive" role="alert">{resetMessage(resetState, resetErrorText)}</p>}</div>}
        <DialogFooter>{resetState !== 'conflict' && resetState !== 'unknown' && <Button variant="outline" onClick={closeReset} disabled={resetState === 'saving'}>取消</Button>}{(resetState === 'conflict' || resetState === 'unknown') && <Button variant="outline" onClick={closeReset}>关闭并刷新</Button>}<Button id="session-reset-submit" variant="destructive" disabled={snapshot?.resetAvailable !== true || selectionUnconfirmed || !resetTarget || !hasSessionResetTarget(resetTarget) || resetState === 'saving' || resetState === 'conflict' || resetState === 'unknown'} onClick={() => void resetSession()}>{resetState === 'saving' && <LoaderCircle className="size-3.5 animate-spin" />}{resetState === 'saving' ? resetPhase === 'reading-ledger' ? '正在核对账本' : '正在解除' : deleteLedgerOnReset ? '确认解除并删除账本' : '确认解除绑定'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
