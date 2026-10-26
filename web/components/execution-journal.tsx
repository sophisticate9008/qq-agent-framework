import { DetailsWindow, ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { ExecutionManagement } from './execution-management.tsx';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Clipboard, LoaderCircle, RefreshCw } from 'lucide-react';
import { ApiError, type ApiClient } from '../lib/api.ts';
import { executionCancelLabel, executionContinuationLabel, executionConversationLabel, executionJournalCollectionLimit, executionJournalPath, executionLateLabel, executionNoticeLabel, executionPresentation, mergeExecutionJournalPages, parseExecutionJournalPage, type ExecutionJournalEntry, type ExecutionJournalPage } from '../lib/execution-journal.ts';
import { Field, Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { HelpTip } from './help-tip.tsx';
import { VirtualTableBody } from './virtual-list.tsx';

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError && (error.status === 404 || error.code === 'runtime_not_connected')) return '当前服务尚未提供执行日志。不可用不代表没有任务，也不能据此确认任务已停止。';
  if (error instanceof ApiError && error.status === 403) return '当前连接没有读取执行日志的权限。';
  return '暂时无法确认执行日志，请手动重新读取；读取失败不会改变任何任务。';
}

function timeLabel(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function executionKey(record: ExecutionJournalEntry): string {
  return record.id;
}

function technicalFields(record: ExecutionJournalEntry): readonly { readonly label: string; readonly value: string }[] {
  return [
    { label: '执行标识', value: record.id },
    { label: '会话标识', value: record.binding.conversationId },
    { label: '外部会话标识', value: record.binding.sessionId },
    { label: '请求标识', value: record.requestId },
    { label: '策略快照标识', value: record.policyRevision },
    ...(record.userMessage ? [{ label: '用户消息标识', value: record.userMessage.messageId }, { label: '受理证据标识', value: record.userMessage.eventId }] : []),
    ...(record.turn ? [{ label: '轮次标识', value: record.turn.id }, { label: '轮次归属证据标识', value: record.turn.evidenceId }] : []),
    ...(record.lastEventId ? [{ label: '最近事件标识', value: record.lastEventId }] : []),
    ...(record.lateOutcome ? [{ label: '迟到终态证据标识', value: record.lateOutcome.eventId }] : []),
  ];
}

export function ExecutionJournal({ api, connected, embedded = false }: { readonly api: ApiClient; readonly connected: boolean; readonly embedded?: boolean }) {
  const [page, setPage] = useState<ExecutionJournalPage | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const [loading, setLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [pagingBlocked, setPagingBlocked] = useState(false);
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const moreController = useRef<AbortController | null>(null);
  const loadedApi = useRef(api);
  const seenCursors = useRef(new Set<string>());
  const pages = useRef(0);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const selection = useRef(selectedId);
  selection.current = selectedId;

  useEffect(() => {
    const request = ++epoch.current;
    const controller = new AbortController();
    readController.current?.abort();
    moreController.current?.abort();
    readController.current = controller;
    moreController.current = null;
    const current = () => !controller.signal.aborted && epoch.current === request && connection.current.api === api && connection.current.connected;
    if (loadedApi.current !== api || !connected) { setPage(null); setSelectedId(null); setDetailsOpen(false); setManageOpen(false); }
    loadedApi.current = api;
    setLoading(connected);
    setMoreLoading(false);
    setError('');
    setNotice('');
    setCopyStatus('');
    setPagingBlocked(false);
    seenCursors.current.clear();
    pages.current = 0;
    if (connected) void api.get(executionJournalPath(), controller.signal).then(value => {
      if (!current()) return;
      const parsed = parseExecutionJournalPage(value);
      if (!parsed) throw new Error('invalid_execution_journal');
      setPage(parsed);
      setSelectedId(previous => previous ?? parsed.items[0]?.id ?? null);
      pages.current = 1;
    }).catch(error => { if (current()) setError(readErrorMessage(error)); })
      .finally(() => { if (current()) { readController.current = null; setLoading(false); } });
    return () => {
      epoch.current += 1;
      controller.abort();
      moreController.current?.abort();
      readController.current = null;
      moreController.current = null;
    };
  }, [api, connected, reload]);

  async function loadMore(): Promise<void> {
    if (!connected || connection.current.api !== api || !connection.current.connected || !page?.next || loading || moreLoading || readController.current || moreController.current || pagingBlocked) return;
    if (pages.current >= 1000 || page.items.length >= executionJournalCollectionLimit) {
      setPagingBlocked(true);
      setNotice('已到本页读取上限，仍可能有未加载记录；不将当前列表当作完整日志。');
      return;
    }
    const after = page.next;
    const request = epoch.current;
    const controller = new AbortController();
    moreController.current = controller;
    seenCursors.current.add(after);
    const current = () => !controller.signal.aborted && epoch.current === request && moreController.current === controller && connection.current.api === api && connection.current.connected;
    setMoreLoading(true);
    setError('');
    try {
      const value = await api.get(executionJournalPath(after), controller.signal);
      if (!current()) return;
      const parsed = parseExecutionJournalPage(value);
      if (!parsed) throw new Error('invalid_execution_journal');
      const merged = mergeExecutionJournalPages(page, parsed);
      if (merged.page.items.length > executionJournalCollectionLimit) {
        setPagingBlocked(true);
        setNotice('后续记录超出本页读取上限，已保留当前列表；仍有记录未加载，不代表完整日志。');
        return;
      }
      pages.current += 1;
      setPage(merged.page);
      setSelectedId(previous => previous ?? merged.page.items[0]?.id ?? null);
      if (merged.changed) setNotice(`分页期间有 ${merged.changed} 条已读记录发生变化，已保留较新状态；各页不是同一时刻的快照。`);
      if (parsed.next !== null && (parsed.next <= after || seenCursors.current.has(parsed.next))) {
        setPagingBlocked(true);
        setNotice('后续位置未前进，已停止继续加载。当前列表不是完整日志，请重新读取核对。');
      }
    } catch (error) {
      if (current()) setError(readErrorMessage(error));
    } finally {
      if (current()) { moreController.current = null; setMoreLoading(false); }
    }
  }

  function cancelRead(): void {
    epoch.current += 1;
    readController.current?.abort();
    moreController.current?.abort();
    readController.current = null;
    moreController.current = null;
    setLoading(false);
    setMoreLoading(false);
    setNotice('已取消本次读取等待；这不会停止外部任务，当前记录未重新确认。');
  }

  function reloadJournal(): void {
    if (!connected || loading || moreLoading) return;
    epoch.current += 1;
    readController.current?.abort();
    moreController.current?.abort();
    readController.current = null;
    moreController.current = null;
    setLoading(true);
    setReload(value => value + 1);
  }

  async function copyIdentifier(label: string, value: string): Promise<void> {
    const request = epoch.current;
    const current = () => request === epoch.current && connection.current.api === api && connection.current.connected && selection.current === selectedId;
    try {
      if (!navigator.clipboard) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(value);
      if (current()) setCopyStatus(`已复制${label}`);
    } catch { if (current()) setCopyStatus('复制未完成，可以在技术详情中手动选中标识复制。'); }
  }

  const available = connected && loadedApi.current === api ? page : null;
  const filtered = useMemo(() => {
    const query = deferredFilter.trim().toLocaleLowerCase();
    const items = available?.items ?? [];
    if (!query) return items;
    return items.filter(item => [executionConversationLabel(item.binding.conversationId), executionPresentation(item).label,
      executionContinuationLabel(item), executionCancelLabel(item.cancelStatus), executionNoticeLabel(item.noticeStatus),
      item.id, item.binding.conversationId, item.binding.sessionId, item.requestId, item.turn?.id ?? '']
      .some(text => text.toLocaleLowerCase().includes(query)));
  }, [available, deferredFilter]);
  const selected = available?.items.find(item => item.id === selectedId) ?? null;
  const selectionUnconfirmed = available !== null && selectedId !== null && selected === null;
  const selectedState = selected ? executionPresentation(selected) : null;

  const journalActions = <><HelpTip label="执行记录保留">已结束记录默认保留 7 天，容量紧张时优先回收较旧记录。未完成记录继续保留。点击会话可查看完整处理结果。</HelpTip><Button size="sm" variant="outline" disabled={!connected || loading || moreLoading} onClick={reloadJournal}><RefreshCw className="size-3.5" />重新读取日志</Button>{(loading || moreLoading) && <Button size="sm" variant="ghost" onClick={cancelRead}>取消读取</Button>}</>;

  return <Section id={nativeFormMetadata.journal.id} title={nativeFormMetadata.journal.title} className={embedded ? 'rounded-none border-0 shadow-none [&>.panel-header]:hidden' : undefined} 
    actions={embedded ? undefined : journalActions}>
    <div data-execution-journal>
      <div className="grid gap-2">
        {embedded && !available && <div className="flex flex-wrap justify-end gap-2">{journalActions}</div>}
        {!connected && <p role="status" className="text-xs text-muted-foreground">连接后才能核对任务执行日志。</p>}
        {(loading || moreLoading) && <p role="status" className="flex items-center gap-2 text-xs"><LoaderCircle className="size-3.5 animate-spin" />正在读取日志{available ? '；当前显示上次读取的状态' : ''}</p>}
        {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}{available ? ' 当前保留的记录尚未重新确认。' : ''}</p>}
        {notice && <p role="status" className="text-xs leading-5 text-muted-foreground">{notice}</p>}
        {available && <>
          <div className="flex flex-wrap items-end justify-between gap-3"><Field label={nativeFormMetadata.journal.fields.filter} className="max-w-64"><Input id="execution-journal-filter" placeholder="会话、状态或已知技术标识" maxLength={160} value={filter} onChange={event => setFilter(event.target.value)} /></Field><span className="text-xs text-muted-foreground">已读取 {available.items.length} 条 · 当前匹配 {filtered.length} 条</span>{embedded && <div className="ml-auto flex flex-wrap items-center gap-2">{journalActions}</div>}</div>
          {available.partial && <p role="status" className="text-xs text-status-warning">服务仅提供部分记录；缺失状态保持未知，不以成功或空日志代替。</p>}
          <div className={embedded ? 'max-h-96 overflow-auto overscroll-contain' : 'max-h-96 overflow-auto overscroll-contain rounded-lg border'} data-execution-journal-scroll role="region" tabIndex={0} aria-label="执行记录列表" aria-busy={loading || moreLoading}>
            <table className="w-full min-w-[36rem] text-left text-[11px]" aria-rowcount={filtered.length + 1}>
              <thead className={embedded ? 'sr-only' : 'sticky top-0 z-10 bg-muted'}><tr className="border-b text-muted-foreground"><th scope="col" className="px-2 py-1 font-medium">时间</th><th scope="col" className="px-2 py-1 font-medium">状态</th><th scope="col" className="px-2 py-1 font-medium">所属会话</th><th scope="col" className="px-2 py-1 font-medium">处理摘要</th><th scope="col" className="px-2 py-1 font-medium">操作</th></tr></thead>
              <VirtualTableBody items={filtered} getItemKey={executionKey} estimateSize={22} columns={5}>{(item, index) => {
                const state = executionPresentation(item);
                return <tr data-execution-row={index} className={item.id === selectedId ? 'bg-accent/50' : 'odd:bg-muted/15 even:bg-muted/45 hover:bg-accent/30 focus-within:bg-accent/30'}>
                  <td className="whitespace-nowrap px-2 py-px leading-[18px]"><time dateTime={new Date(item.admittedAt).toISOString()} title={timeLabel(item.admittedAt)}>{new Date(item.admittedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time></td>
                  <td className="px-2 py-px leading-[18px]"><span className={`whitespace-nowrap ${state.tone === 'warning' ? 'text-status-warning' : state.tone === 'success' ? 'text-status-success' : 'text-muted-foreground'}`}>{state.label}</span></td>
                  <td className="whitespace-nowrap px-2 py-px leading-[18px]">{executionConversationLabel(item.binding.conversationId)}</td>
                  <td className="max-w-80 px-2 py-px leading-[18px]"><span className="block truncate" title={`${state.explanation} ${executionContinuationLabel(item)}`}>{state.explanation}</span></td>
                  <td className="px-2 py-px leading-[18px]"><Button size="xs" variant="ghost" className="h-[18px] min-h-0 px-1 py-0 text-xs text-primary" aria-label={`查看执行记录 ${index + 1}`} aria-pressed={item.id === selectedId} onClick={() => { setSelectedId(item.id); setCopyStatus(''); setDetailsOpen(true); }}>详情</Button></td>
                </tr>;
              }}</VirtualTableBody>
            </table>
            {filtered.length === 0 && <p className="p-5 text-xs text-muted-foreground">{available.items.length ? '已读取的记录中没有匹配项。' : '本批次没有执行记录，不代表没有其他执行或历史。'}{available.next ? '仍可继续加载后续记录。' : ''}</p>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{available.next ? '尚有未读取的后续位置。' : '本次分页暂未提供后续位置；不代表任务均已结束。'}</p>{available.next && <Button size="sm" variant="outline" disabled={loading || moreLoading || pagingBlocked} onClick={() => void loadMore()}>继续加载执行记录</Button>}</div>
          {selectionUnconfirmed && <p role="status" className="text-xs leading-5 text-muted-foreground" data-execution-selection-unconfirmed>所选执行尚未在本次已读取批次中确认；未加载不代表记录不存在。可继续加载或主动选择另一条记录，不会把旧状态当成新结果。</p>}
          <DetailsWindow open={detailsOpen && selected !== null} onOpenChange={setDetailsOpen} title="处理记录详情" description="查看这轮处理、超时与发送结果。">{selected && selectedState && <div className="p-1" data-execution-detail>
            <div className="flex flex-wrap items-center gap-2"><h3 className="text-xs font-medium">{executionConversationLabel(selected.binding.conversationId)} · 所选执行</h3><StatusPill tone={selectedState.tone}>{selectedState.label}</StatusPill></div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{selectedState.explanation}</p>
            <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><div><dt className="text-muted-foreground">该会话后续</dt><dd className="mt-1">{executionContinuationLabel(selected)}。{selected.isolated ? '其他会话可独立处理，不会自动换会话或清空上下文。' : '这不代表已有其他调用授权。'}</dd></div>
              <div><dt className="text-muted-foreground">本次总期限</dt><dd className="mt-1">{timeLabel(selected.deadlineAt)}（进度不会续期）</dd></div>
              <div><dt className="text-muted-foreground">协作停止</dt><dd className="mt-1">{executionCancelLabel(selected.cancelStatus)}</dd></div>
              <div><dt className="text-muted-foreground">超时提醒</dt><dd className="mt-1">{executionNoticeLabel(selected.noticeStatus)}</dd></div>
              <div><dt className="text-muted-foreground">已观察进度事件</dt><dd className="mt-1">{selected.progressEvents} 次（不是重试次数）</dd></div>
              <div><dt className="text-muted-foreground">会话代次</dt><dd className="mt-1">第 {selected.binding.generation} 代，仅归属本次绑定</dd></div></dl>
            {executionLateLabel(selected) && <p className="mt-3 text-xs leading-5 text-muted-foreground">{executionLateLabel(selected)}</p>}
            {selected.lastError && <p className="mt-3 text-xs text-muted-foreground">此记录包含异常标记；不会直接展示上游错误原文或据此重试。</p>}
            <div className="mt-3"><ReadOnlyDetails title="处理记录技术详情" label="技术详情" description="标识和原始原因码，可选中文本复制。"><TechnicalDetails fields={[...technicalFields(selected), { label: '技术原因', value: selected.lastError ?? '无' }]} /></ReadOnlyDetails>{selected.isolated && <Button size="sm" variant="outline" onClick={() => { setDetailsOpen(false); setManageOpen(true); }}>处理未完成任务</Button>}</div>
          </div>}</DetailsWindow>
          <DetailsWindow open={manageOpen && selected !== null} onOpenChange={setManageOpen} title="处理未完成任务" description="核对这轮处理的结果，再选择恢复操作。">{selected && <ExecutionManagement key={selected.id} api={api} connected={connected} entry={selected} onRead={reloadJournal} />}</DetailsWindow>
        </>}
      </div>
    </div>
  </Section>;
}
