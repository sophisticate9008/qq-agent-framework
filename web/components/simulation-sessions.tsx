import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { parseSimulationSessionSnapshot, parseSimulationSessionResetResult,
  type SimulationSession, type SimulationSessionResetRequest } from '../../src/contracts/simulation-sessions.ts';
import { ApiError, errorMessage, isRecord, type ApiClient } from '../lib/api.ts';
import { parseUsageSnapshot } from '../lib/activity.ts';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { DetailsWindow, TechnicalDetails } from './read-only-details.tsx';
import { EmptyState, Section, StatusPill } from './management.tsx';
import { UsageConversation, usageSessionSuffix } from './usage-conversation.ts';
import { VirtualTableBody } from './virtual-list.tsx';
import { Button } from './ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx';

const sessionsPath = '/api/chat/simulations/sessions';
type WriteState = 'idle' | 'saving' | 'error' | 'conflict' | 'unknown';
type ResetTarget = SimulationSession & { readonly sessionId: string; readonly bindingRevision: string };

function hasTarget(session: SimulationSession): session is ResetTarget {
  return session.resetAvailable && typeof session.sessionId === 'string' && typeof session.bindingRevision === 'string';
}

function rowKey(session: SimulationSession): string {
  return JSON.stringify([session.runId, session.key, session.sessionId, session.generation]);
}

function unavailableReason(session: SimulationSession): string {
  if (session.resetAvailable) return '';
  if (session.runtimeState === 'busy') return '模拟运行仍在使用，或占用状态待核对。';
  if (session.state === 'retired') return '这条绑定已解除。';
  if (session.state === 'creating') return '模型会话仍在建立中。';
  if (session.state === 'unknown') return '绑定状态尚未确认，请先核对模拟运行。';
  return '暂时无法安全解除绑定，请刷新后核对。';
}

const stateLabels: Readonly<Record<SimulationSession['state'], string>> = {
  ready: '已绑定', creating: '建立中', unknown: '待核对', retired: '已解除',
};

export function SimulationSessions({ api, connected, active, onUsage }: {
  readonly api: ApiClient;
  readonly connected: boolean;
  readonly active: boolean;
  readonly onUsage: () => void;
}) {
  const write = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const resource = useReadResource(api, sessionsPath, connected && active, parseSimulationSessionSnapshot,
    { intervalMs: 10_000, pollWhen: () => write.current === null });
  const [details, setDetails] = useState<SimulationSession | null>(null);
  const [target, setTarget] = useState<ResetTarget | null>(null);
  const [removeLedger, setRemoveLedger] = useState(false);
  const [state, setState] = useState<WriteState>('idle');
  const [phase, setPhase] = useState<'checking' | 'unbinding' | 'ledger' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [ledgerUnconfirmed, setLedgerUnconfirmed] = useState(false);
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    epoch.current++;
    write.current?.abort();
    write.current = null;
    setDetails(null);
    setTarget(null);
    setState('idle');
    setWriting(false);
    setNotice('');
    setLedgerUnconfirmed(false);
    return () => { epoch.current++; write.current?.abort(); };
  }, [api, connected]);

  function openReset(session: SimulationSession): void {
    if (write.current || resource.error || !hasTarget(session)) return;
    setTarget(session);
    setRemoveLedger(false);
    setState('idle');
    setPhase(null);
    setError('');
  }

  function closeReset(): void {
    if (state === 'saving') return;
    const refresh = state === 'conflict' || state === 'unknown';
    setTarget(null);
    setState('idle');
    setError('');
    if (refresh) resource.refresh();
  }

  async function reset(): Promise<void> {
    const selected = target;
    const deleteLedger = removeLedger;
    if (!selected || write.current || state !== 'idle' && state !== 'error'
      || !connection.current.connected || connection.current.api !== api || resource.error
      || !resource.snapshot?.sessions.some(row => rowKey(row) === rowKey(selected)
        && row.bindingRevision === selected.bindingRevision && row.resetAvailable)) return;
    const controller = new AbortController();
    const startedEpoch = epoch.current;
    write.current = controller;
    const current = () => !controller.signal.aborted && epoch.current === startedEpoch && write.current === controller
      && connection.current.api === api && connection.current.connected;
    setWriting(true);
    setState('saving');
    setError('');
    setLedgerUnconfirmed(false);
    let submitted = false;
    let unbound = false;
    try {
      let revision: string | null = null;
      if (deleteLedger) {
        setPhase('checking');
        const query = new URLSearchParams({ conversationId: selected.ledgerConversationId, sessionId: selected.sessionId, limit: '1' });
        const usage = parseUsageSnapshot(await readResource(api, `/api/chat/usage?${query}`, controller.signal));
        if (!current()) return;
        if (!usage?.native || usage.limited || usage.coverage?.partial
          || usage.conversations.some(row => row.key !== selected.ledgerConversationId || row.sessionId !== selected.sessionId)
          || usage.conversations[0] && !usage.conversations[0].revision) throw new Error('simulation_ledger_unavailable');
        revision = usage.conversations[0]?.revision ?? null;
      }
      if (!current()) return;
      setPhase('unbinding');
      submitted = true;
      const request: SimulationSessionResetRequest = {
        runId: selected.runId, key: selected.key, sessionId: selected.sessionId,
        generation: selected.generation, bindingRevision: selected.bindingRevision, confirm: true,
      };
      const result = parseSimulationSessionResetResult(await writeResource(api, `${sessionsPath}/reset`, request, controller.signal));
      if (!current()) return;
      if (!result || result.runId !== selected.runId || result.key !== selected.key
        || result.previousSessionId !== selected.sessionId || result.previousGeneration !== selected.generation) {
        throw new ApiError('simulation_session_reset_unknown', 504);
      }
      unbound = true;
      setTarget(null);
      let deletionUnknown = false;
      if (revision) {
        setPhase('ledger');
        setNotice('模拟会话已解除绑定，正在删除该模型会话的账本。');
        try {
          const deleted = await writeResource(api, '/api/chat/usage/session/delete', {
            conversationId: selected.ledgerConversationId, sessionId: selected.sessionId, revision,
          }, controller.signal);
          if (!current()) return;
          if (!isRecord(deleted) || deleted.ok !== true || typeof deleted.affected !== 'number'
            || !Number.isSafeInteger(deleted.affected) || deleted.affected < 0
            || typeof deleted.operationId !== 'string' || deleted.operationId.length === 0
            || deleted.conversationId !== undefined && deleted.conversationId !== selected.ledgerConversationId
            || deleted.sessionId !== undefined && deleted.sessionId !== selected.sessionId) throw new ApiError('simulation_ledger_delete_unknown', 504);
        } catch {
          if (!current()) return;
          deletionUnknown = true;
        }
      }
      if (!current()) return;
      setState('idle');
      setLedgerUnconfirmed(deletionUnknown);
      setNotice(deletionUnknown ? '已解除绑定，账本未确认删除，请到用量页核对。'
        : deleteLedger ? revision ? '模拟会话已解除绑定，并删除了该模型会话的账本。' : '模拟会话已解除绑定，此模型会话没有已记录账本。'
          : '模拟会话已解除绑定，聊天历史与用量账本保留。');
      resource.refresh();
      if (deletionUnknown) toast.warning('已解除绑定，账本未确认删除，请到用量页核对');
      else toast.success('模拟会话已解除绑定');
    } catch (failure) {
      if (!current()) return;
      if (unbound) {
        setTarget(null);
        setState('idle');
        setLedgerUnconfirmed(true);
        setNotice('已解除绑定，账本未确认删除，请到用量页核对。');
        resource.refresh();
      } else if (!submitted) {
        setState('error');
        setError('暂时无法核对该模拟会话账本，尚未解除绑定。可取消“同时删除此会话账本”以保留账本。');
      } else if (failure instanceof ApiError && (failure.status === 409 || /conflict|revision|stale/.test(failure.code))) {
        setState('conflict');
        setError('模拟运行或绑定已变化，请关闭弹窗并刷新后重新选择。');
      } else if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && !/unknown/.test(failure.code)) {
        setState('error');
        setError(errorMessage(failure));
      } else {
        setState('unknown');
        setError('暂时无法确认是否已解除绑定，请勿重复提交；关闭弹窗并刷新核对。');
      }
    } finally {
      if (current()) { setWriting(false); setPhase(null); }
      if (write.current === controller) write.current = null;
    }
  }

  if (!connected) return null;
  return <Section id="simulation-session-bindings" title="模拟会话" className="[&>.panel-header]:hidden [&>.panel-body]:p-0">
    <div className="flex flex-wrap items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground"><span>当前配置下实际建立的模拟会话绑定</span><Button size="sm" variant="outline" className="ml-auto" disabled={resource.loading || writing} onClick={resource.refresh}><RefreshCw className={resource.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新</Button></div>
    {notice && <div className="mx-2.5 mb-2 flex flex-wrap items-center gap-2 rounded border p-2 text-xs" role="status"><span>{notice}</span>{ledgerUnconfirmed && <Button size="sm" variant="outline" onClick={onUsage}>到用量页核对</Button>}</div>}
    {resource.error && <p className="px-2.5 pb-2 text-xs text-destructive" role="alert">模拟会话读取失败，请刷新后核对；已有结果暂不可操作。</p>}
    {!resource.snapshot && resource.loading && <p className="px-2.5 py-4 text-xs text-muted-foreground">正在读取模拟会话绑定…</p>}
    {resource.snapshot?.sessions.length === 0 && <EmptyState title={resource.snapshot.unavailableRuns > 0 || resource.snapshot.limited ? "暂无已读取的模拟绑定" : "暂无模拟会话绑定"} description={resource.snapshot.unavailableRuns > 0 || resource.snapshot.limited ? "读取范围尚不完整，请刷新后核对其他模拟运行。" : "当前配置所属的模拟运行中，没有可展示的实际绑定。"} />}
    {resource.snapshot && resource.snapshot.sessions.length > 0 && <div className="tablewrap overscroll-contain border-y" tabIndex={0} role="region" aria-label="模拟会话绑定列表"><table className="w-full min-w-[48rem] text-left text-[11px]" aria-rowcount={resource.snapshot.sessions.length + 1}><thead className="bg-muted text-muted-foreground"><tr><th className="px-2 py-1 font-medium">会话</th><th className="px-2 py-1 font-medium">模拟运行</th><th className="px-2 py-1 font-medium">模型会话</th><th className="px-2 py-1 font-medium">状态</th><th className="px-2 py-1 font-medium">管理状态</th><th className="px-2 py-1 text-right font-medium">操作</th></tr></thead><VirtualTableBody items={resource.snapshot.sessions} getItemKey={rowKey} columns={6} estimateSize={32}>{session => <tr key={rowKey(session)} data-simulation-run={session.runId} className="hover:bg-muted/30"><td className="px-2 py-0.5"><UsageConversation conversationKey={session.ledgerConversationId} sessionId={session.sessionId} /></td><td className="px-2 py-0.5 font-mono" title={session.runId}>{session.runId.replace(/^qq-/, '').slice(-8)}</td><td className="px-2 py-0.5 font-mono" title={session.sessionId ?? undefined}>{session.sessionId ? usageSessionSuffix(session.sessionId).slice(1) : '尚未建立'}</td><td className="whitespace-nowrap px-2 py-0.5"><StatusPill tone={session.state === 'ready' ? 'success' : 'neutral'}>{stateLabels[session.state]}</StatusPill></td><td className="px-2 py-0.5 text-muted-foreground">{session.resetAvailable ? '已停止，可解除绑定' : unavailableReason(session)}</td><td className="px-2 py-0.5"><div className="flex items-center justify-end gap-0.5 [&>button]:h-6 [&>button]:px-1.5 [&>button]:text-[11px]"><Button size="sm" variant="ghost" onClick={() => setDetails(session)}>详情</Button><span title={unavailableReason(session) || undefined}><Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px] text-destructive" disabled={writing || Boolean(resource.error) || !hasTarget(session)} onClick={() => openReset(session)}><RotateCcw className="size-3.5" />解除绑定</Button></span></div></td></tr>}</VirtualTableBody></table></div>}
    {resource.snapshot && (resource.snapshot.limited || resource.snapshot.unavailableRuns > 0) && <p className="px-2.5 py-2 text-xs text-muted-foreground" role="status">{resource.snapshot.limited ? '结果达到读取上限。' : ''}{resource.snapshot.unavailableRuns > 0 ? ` ${resource.snapshot.unavailableRuns} 个模拟运行暂时无法读取，未当作空绑定。` : ''}</p>}
    <DetailsWindow open={details !== null} onOpenChange={open => { if (!open) setDetails(null); }} title="模拟会话详情" description="查看实际模拟运行与模型会话绑定。">{details && <div className="grid gap-3"><UsageConversation conversationKey={details.ledgerConversationId} sessionId={details.sessionId} showRun /><p className="text-xs text-muted-foreground">{details.resetAvailable ? '模拟运行已停止，可解除此绑定。' : unavailableReason(details)}</p><TechnicalDetails fields={[{ label: '模拟运行', value: details.runId }, { label: '原 QQ 会话', value: details.originalConversationId }, { label: '完整模型会话 ID', value: details.sessionId }, { label: '绑定状态', value: stateLabels[details.state] }, { label: '绑定版本', value: details.bindingRevision }, { label: '第几次建立对话', value: details.generation }, { label: '管理限制', value: details.resetUnavailableReason }]} /><Button variant="outline" onClick={onUsage}>用量统计</Button></div>}</DetailsWindow>
    <Dialog open={target !== null} onOpenChange={open => { if (!open) closeReset(); }}><DialogContent showCloseButton={state !== 'saving'}><DialogHeader><DialogTitle>解除这条模拟会话的绑定？</DialogTitle><DialogDescription>解除所选模拟运行中的模型会话绑定。聊天历史保留，可选择是否同时删除这个模型会话的用量账本。</DialogDescription></DialogHeader>{target && <div className="grid gap-3 text-xs"><UsageConversation conversationKey={target.ledgerConversationId} sessionId={target.sessionId} showRun /><code className="break-all">{target.sessionId}</code><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={removeLedger} disabled={state === 'saving' || state === 'conflict' || state === 'unknown'} onChange={event => { setRemoveLedger(event.target.checked); if (state === 'error') { setState('idle'); setError(''); } }} /><span><strong className="font-medium">同时删除此会话账本</strong><span className="mt-1 block text-xs text-muted-foreground">删除该模型会话已记录的用量与费用，无法撤销。不勾选时保留账本。</span></span></label></div>}{error && <p className="text-xs leading-5 text-destructive" role="alert">{error}</p>}<DialogFooter><Button variant="outline" disabled={state === 'saving'} onClick={closeReset}>{state === 'conflict' || state === 'unknown' ? '关闭并刷新' : '取消'}</Button><Button variant="destructive" disabled={state === 'saving' || state === 'conflict' || state === 'unknown' || !target} onClick={() => void reset()}>{state === 'saving' && <LoaderCircle className="size-3.5 animate-spin" />}{state === 'saving' ? phase === 'checking' ? '正在核对账本' : '正在解除' : removeLedger ? '确认解除并删除账本' : '确认解除绑定'}</Button></DialogFooter></DialogContent></Dialog>
  </Section>;
}
