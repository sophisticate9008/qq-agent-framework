import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Clipboard, LoaderCircle, RefreshCw, RotateCcw, Search, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import { ConnectPrompt, EmptyState, PageHeading, Section, StatusPill } from '../components/management.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx';
import { Input } from '../components/ui/input.tsx';
import { VirtualTableBody } from '../components/virtual-list.tsx';
import { ApiError, errorMessage } from '../lib/api.ts';
import { describeConversationKey, parseSessionResetResult, parseSessionSnapshot, type ManagedSession, type SessionSnapshot } from '../lib/activity.ts';
import type { PageProps } from '../lib/types.ts';
import { mergeSessionPages, sessionCollectionLimit, sessionPagePath } from '../lib/session-pages.ts';

type ResetState = 'idle' | 'saving' | 'conflict' | 'unknown' | 'error';

function resetError(error: unknown): ResetState {
  if (error instanceof ApiError && (error.status === 409 || /conflict|stale|revision/.test(error.code))) return 'conflict';
  if (error instanceof ApiError && (error.status >= 500 || /unknown/.test(error.code))) return 'unknown';
  return error instanceof ApiError && error.status >= 400 && error.status < 500 ? 'error' : 'unknown';
}

function resetMessage(state: ResetState, error: string): string {
  if (state === 'conflict') return '会话列表已在其他位置变化。请重新读取列表，再检查并确认当前绑定。';
  if (state === 'unknown') return '暂时无法确认重置是否完成。请勿再次提交；关闭窗口后手动刷新当前状态。';
  return error;
}

function sessionError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'runtime_not_connected') {
    return '原生聊天宿主尚未接入，会话管理当前不可用。';
  }
  return errorMessage(error);
}

export function SessionsPage(props: PageProps) {
  const { api, connected, connect } = props;
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reloadVersion, setReloadVersion] = useState(0);
  const [notice, setNotice] = useState('');
  const [resetTarget, setResetTarget] = useState<ManagedSession | null>(null);
  const [confirmKey, setConfirmKey] = useState('');
  const [resetState, setResetState] = useState<ResetState>('idle');
  const [resetErrorText, setResetErrorText] = useState('');
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
    const page = parseSessionSnapshot(await api.get(sessionPagePath(), signal));
    if (signal.aborted || lifecycle.current !== epoch || connection.current.api !== api || !connection.current.connected) return;
    if (!page) throw new Error('invalid_sessions_response');
    const next = mergeSessionPages(null, page).snapshot;
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
    setResetState('idle');
    setConfirmKey('');
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
      const page = parseSessionSnapshot(await api.get(sessionPagePath(cursor), controller.signal));
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
      setSnapshot(merged.snapshot);
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
    if (snapshot?.resetAvailable !== true || selectionUnconfirmed || loading || moreLoading) return;
    setResetTarget(session);
    setConfirmKey('');
    setResetState('idle');
    setResetErrorText('');
  }

  function closeReset(): void {
    if (resetState === 'saving') return;
    const refreshRequired = resetState === 'conflict' || resetState === 'unknown';
    setResetTarget(null);
    setConfirmKey('');
    setResetState('idle');
    setResetErrorText('');
    if (refreshRequired) reload();
  }

  async function resetSession(): Promise<void> {
    if (!snapshot || snapshot.resetAvailable !== true || selectionUnconfirmed || loading || moreLoading || !resetTarget || confirmKey !== resetTarget.key || resetState !== 'idle' && resetState !== 'error' || writeController.current) return;
    const controller = new AbortController();
    const epoch = lifecycle.current;
    writeController.current = controller;
    const current = () => !controller.signal.aborted && lifecycle.current === epoch && writeController.current === controller
      && connection.current.api === api && connection.current.connected;
    setResetState('saving');
    setResetErrorText('');
    try {
      const result = parseSessionResetResult(await api.post('/api/chat/sessions/reset', {
        key: resetTarget.key,
        sessionId: resetTarget.sessionId,
        revision: resetTarget.bindingRevision ?? snapshot.revision,
        confirm: true,
      }, controller.signal), resetTarget.key, resetTarget.sessionId);
      if (!current()) return;
      if (!result) throw new ApiError('session_reset_unknown', 504);
      setResetTarget(null);
      setResetState('idle');
      setConfirmKey('');
      setSnapshot(null);
      setSelectedKey(null);
      selectedSession.current = null;
      setNotice('原生聊天宿主的会话绑定已移除；外部任务是否停止、外部会话是否归档仍需单独核对。');
      setLoading(true);
      try {
        await loadSessions(controller.signal, epoch);
      } catch (error) {
        if (current()) setLoadError(sessionError(error));
      } finally {
        if (current()) setLoading(false);
      }
      if (current()) toast.success('会话绑定已移除');
    } catch (error) {
      if (!current()) return;
      const state = resetError(error);
      setResetState(state);
      setResetErrorText(errorMessage(error));
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

  if (!connected) return <div className="page-stack" data-page="sessions"><PageHeading title="会话管理" description="查看原生聊天宿主保存的真实会话绑定。" /><ConnectPrompt connect={connect} /></div>;

  return <div className="page-stack" data-page="sessions">
    <PageHeading title="会话管理" description="查看原生宿主的真实聊天绑定；未接入原生宿主时本页明确不可用。" actions={<Button variant="outline" onClick={reload} disabled={loading || resetState === 'saving'}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新</Button>} />
    {notice && <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-5 text-foreground" role="status"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" /><span>{notice}</span></div>}
    {loading && !snapshot ? <Section id="session-bindings" title="会话绑定"><div className="flex min-h-52 items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取真实会话绑定</div></Section>
      : loadError && !snapshot ? <Section id="sessions-unavailable" title="原生会话不可用" description={loadError} actions={<Button variant="outline" onClick={reload}>重试</Button>}><EmptyState locked title="没有可读取的原生会话" description="当前状态不会按零条会话显示。接入原生聊天宿主后再试。" /></Section>
      : snapshot && <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.62fr)_minmax(19rem,0.38fr)]">
        <Section id="session-bindings" title="会话绑定" description={`已加载 ${snapshot.sessions.length} 条绑定${snapshot.next ? "，仍有后续未加载" : "；本次分页读取结束"}。`} actions={<StatusPill tone={snapshot.next ? "warning" : "success"}>{snapshot.next ? "部分结果" : "真实分页结果"}</StatusPill>}>
          <div className="relative mb-4 max-w-sm"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input id="session-filter" value={filter} onChange={event => setFilter(event.target.value)} className="pl-8" placeholder="筛选群聊、私聊或 QQ 号" aria-label="筛选会话" /></div>
          {snapshot.resetAvailable !== true && <p className="mb-3 text-xs leading-5 text-muted-foreground" data-session-read-only>当前数据源只读，未提供可确认安全的重置能力；不会打开重置确认或提交重置请求。</p>}
          {snapshot.sessions.length === 0 ? <EmptyState title={snapshot.next ? "当前批次没有可显示绑定" : "暂无会话绑定"} description={snapshot.next ? "服务端仍有后续记录，可继续加载；当前批次可能只有尚未就绪的会话。" : "聊天宿主已返回空列表；收到新的有效对话后可能建立绑定。"} />
            : filteredSessions.length === 0 ? <EmptyState title="没有匹配的会话" description={snapshot.next ? "只筛选当前已加载记录；后续页仍可能有匹配项，可继续加载，不会修改服务端数据。" : "调整筛选词后再试；筛选不会修改服务端数据。"} />
              : <div className="h-96 overflow-auto overscroll-contain rounded-lg border" tabIndex={0} role="region" aria-label="会话绑定列表"><table aria-rowcount={filteredSessions.length + 1} className="w-full min-w-[32rem] text-left text-xs"><thead className="sticky top-0 z-10 border-b bg-muted text-muted-foreground"><tr><th className="px-3 py-2.5 font-medium">类型</th><th className="px-3 py-2.5 font-medium">QQ 标识</th><th className="px-3 py-2.5 font-medium">身份</th><th className="px-3 py-2.5 text-right font-medium">操作</th></tr></thead><VirtualTableBody items={filteredSessions} getItemKey={session => session.key} columns={4} estimateSize={57}>{session => {
                const identity = describeConversationKey(session.key);
                return <tr key={session.key} data-session-key={session.key} className={selectedKey === session.key ? 'bg-accent/45' : 'hover:bg-muted/30'}><td className="px-3 py-3"><Badge variant="outline">{identity.label}</Badge></td><td className="px-3 py-3 font-medium tabular-nums">{identity.identifier}</td><td className="px-3 py-3">{session.owner ? <Badge variant="secondary">主人</Badge> : <span className="text-muted-foreground">普通会话</span>}</td><td className="px-3 py-3 text-right"><Button size="sm" variant="ghost" onClick={() => setSelectedKey(session.key)}>查看</Button></td></tr>;
              }}</VirtualTableBody></table></div>}
          <div className="mt-3 flex flex-wrap items-center gap-2" data-session-pagination><p className="mr-auto text-[11px] leading-5 text-muted-foreground">分页不是一致快照，读取期间绑定可能变化；刷新会重新读取首批，筛选仅作用于已加载记录。</p>{snapshot.next && <Button id="session-load-more" size="sm" variant="outline" disabled={loading || moreLoading || pagingBlocked} onClick={() => void loadMore()}>{moreLoading && <LoaderCircle className="size-3.5 animate-spin" />}{moreLoading ? "正在加载下一批" : "继续加载会话"}</Button>}{moreLoading && <Button id="session-load-cancel" size="sm" variant="ghost" onClick={cancelMore}>取消加载</Button>}</div>
          {moreError && <p className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-300" role="status">{moreError}</p>}
        </Section>
        <Section id="session-details" title="绑定详情" description="这里只显示已知绑定，不包含或推测聊天历史。">
          {selectionUnconfirmed && <p className="mb-3 text-xs leading-5 text-amber-700 dark:text-amber-300" data-session-unconfirmed>所选绑定尚未在本次已加载记录中确认，详情保留上次观察；请继续加载或刷新核对，当前不可执行重置。</p>}
          {!selected ? <EmptyState title="选择一条会话" description="从列表中选择群聊或私聊，查看当前绑定并执行单会话操作。" /> : (() => {
            const identity = describeConversationKey(selected.key);
            return <div className="grid gap-5" data-selected-session={selected.key}><div className="flex items-start gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"><UsersRound className="size-5" /></span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm font-medium">{identity.label} {identity.identifier}</strong>{selected.owner && <Badge variant="secondary">主人</Badge>}</div><p className="mt-1 text-xs text-muted-foreground">会话范围：{selected.key}</p></div></div><details className="rounded-lg border px-3 py-2.5"><summary className="cursor-pointer text-xs font-medium">技术会话 ID</summary><div className="mt-3 flex items-start gap-2"><code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2.5 py-2 text-[11px] select-all">{selected.sessionId}</code><Button size="icon-sm" variant="outline" onClick={() => void copySessionId(selected.sessionId)} title="复制技术会话 ID" aria-label="复制技术会话 ID"><Clipboard className="size-3.5" /></Button></div></details><div className="grid gap-2 border-t pt-4"><Button variant="outline" onClick={navigateToUsage}>打开用量统计</Button><Button id="session-reset-open" variant="destructive" disabled={snapshot.resetAvailable !== true || selectionUnconfirmed || loading || moreLoading} onClick={() => openReset(selected)}><RotateCcw className="size-3.5" />重置这条会话</Button></div></div>;
          })()}
        </Section>
      </div>}
    <Dialog open={resetTarget !== null} onOpenChange={open => { if (!open) closeReset(); }}>
      <DialogContent showCloseButton={resetState !== 'saving' && resetState !== 'conflict' && resetState !== 'unknown'}>
        <DialogHeader><DialogTitle>重置所选会话绑定？</DialogTitle><DialogDescription>此操作会移除所选会话关联及其上下文，外部工作是否停止无法确认。原生宿主重置还可能打断正在创建的会话，建议没有重要任务时操作。</DialogDescription></DialogHeader>
        {resetTarget && <div className="grid gap-3"><div className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs leading-5"><strong className="block text-destructive">所选会话范围：{resetTarget.key}</strong><span className="text-muted-foreground">每次只提交这一条绑定，不会批量清空；未知结果不会自动重试。</span></div><label className="grid gap-2"><span className="field-label">输入所选会话范围以确认</span><Input id="session-reset-confirm" autoFocus value={confirmKey} onChange={event => { setConfirmKey(event.target.value); if (resetState === 'error') setResetState('idle'); }} disabled={resetState === 'saving' || resetState === 'conflict' || resetState === 'unknown'} placeholder={resetTarget.key} autoComplete="off" /></label>{resetState !== 'idle' && resetState !== 'saving' && <p className="text-xs leading-5 text-destructive" role="alert">{resetMessage(resetState, resetErrorText)}</p>}</div>}
        <DialogFooter>{resetState !== 'conflict' && resetState !== 'unknown' && <Button variant="outline" onClick={closeReset} disabled={resetState === 'saving'}>取消</Button>}{(resetState === 'conflict' || resetState === 'unknown') && <Button variant="outline" onClick={closeReset}>关闭并刷新</Button>}<Button id="session-reset-submit" variant="destructive" disabled={snapshot?.resetAvailable !== true || selectionUnconfirmed || !resetTarget || confirmKey !== resetTarget.key || resetState === 'saving' || resetState === 'conflict' || resetState === 'unknown'} onClick={() => void resetSession()}>{resetState === 'saving' && <LoaderCircle className="size-3.5 animate-spin" />}{resetState === 'saving' ? '正在重置' : '确认重置'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
