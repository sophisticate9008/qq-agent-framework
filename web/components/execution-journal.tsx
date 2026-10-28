import { DetailsWindow, ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { ExecutionManagement } from './execution-management.tsx';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { ApiError, type ApiClient } from '../lib/api.ts';
import { executionCancelLabel, executionContinuationLabel, executionConversationLabel, executionJournalCollectionLimit, executionJournalPath, executionLateLabel, executionNoticeLabel, executionPresentation, executionJournalPresentation, executionInputLabel, executionResultLabel, executionReplyReason, executionErrorLabel, mergeExecutionJournalPages, parseExecutionJournalPage, type ExecutionJournalEntry, type ExecutionJournalPage } from '../lib/execution-journal.ts';
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

function durationLabel(milliseconds: number | null | undefined): string {
  if (milliseconds == null) return '—';
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} 秒`;
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
  const [onlyIssues, setOnlyIssues] = useState(false);
  const deferredFilter = useDeferredValue(filter);
  const [loading, setLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
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
      if (parsed.next !== null && (parsed.next === after || seenCursors.current.has(parsed.next))) {
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

  const available = connected && loadedApi.current === api ? page : null;
  const filtered = useMemo(() => {
    const query = deferredFilter.trim().toLocaleLowerCase();
    const items = [...(available?.items ?? [])]
      .filter(item => !onlyIssues || executionJournalPresentation(item).tone === 'warning')
      .sort((a, b) => b.admittedAt - a.admittedAt || b.id.localeCompare(a.id));
    if (!query) return items;
    return items.filter(item => [executionConversationLabel(item.binding.conversationId), executionJournalPresentation(item).label,
      executionInputLabel(item), executionResultLabel(item), ...(item.summary?.tools?.names ?? []),
      executionContinuationLabel(item), executionCancelLabel(item.cancelStatus), executionNoticeLabel(item.noticeStatus),
      item.id, item.binding.conversationId, item.binding.sessionId, item.requestId, item.turn?.id ?? '']
      .some(text => text.toLocaleLowerCase().includes(query)));
  }, [available, deferredFilter, onlyIssues]);
  const selected = available?.items.find(item => item.id === selectedId) ?? null;
  const selectionUnconfirmed = available !== null && selectedId !== null && selected === null;
  const selectedState = selected ? executionJournalPresentation(selected) : null;

  const journalActions = <><HelpTip label="执行记录保留">已结束记录默认保留 7 天，容量紧张时优先回收较旧记录。未完成记录继续保留。列表按开始时间倒序排列，处理完成与消息送达分别记录；点击详情查看。</HelpTip><Button size="sm" variant="outline" disabled={!connected || loading || moreLoading} onClick={reloadJournal}><RefreshCw className="size-3.5" />刷新</Button>{(loading || moreLoading) && <Button size="sm" variant="ghost" onClick={cancelRead}>取消读取</Button>}</>;

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
          <div className="flex flex-wrap items-end justify-between gap-3"><Field label={nativeFormMetadata.journal.fields.filter} className="max-w-64"><Input id="execution-journal-filter" placeholder="搜索消息、回复、会话或状态" maxLength={160} value={filter} onChange={event => setFilter(event.target.value)} /></Field><Button size="sm" variant={onlyIssues ? 'secondary' : 'outline'} aria-pressed={onlyIssues} onClick={() => setOnlyIssues(value => !value)}>仅看异常</Button><span className="text-xs text-muted-foreground">{filtered.length} / {available.items.length} 条 · 最新在前</span>{embedded && <div className="ml-auto flex flex-wrap items-center gap-2">{journalActions}</div>}</div>
          {available.partial && <p role="status" className="text-xs text-status-warning">服务仅提供部分记录；缺失状态保持未知，不以成功或空日志代替。</p>}
          <div className={embedded ? 'max-h-96 overflow-auto overscroll-contain' : 'max-h-96 overflow-auto overscroll-contain rounded-lg border'} data-execution-journal-scroll role="region" tabIndex={0} aria-label="执行记录列表" aria-busy={loading || moreLoading}>
            <table className="w-full min-w-[64rem] table-fixed text-left text-[11px]" aria-rowcount={filtered.length + 1}>
              <colgroup><col className="w-[116px]" /><col className="w-[142px]" /><col /><col /><col className="w-[92px]" /><col className="w-[65px]" /><col className="w-[46px]" /></colgroup>
              <thead className="sticky top-0 z-10 bg-muted"><tr className="border-b text-muted-foreground">
                {['开始时间', '所属会话', '收到的内容', '回复与结果', '状态', '耗时', '操作'].map(label => <th key={label} scope="col" className="px-2 py-1 font-medium">{label}</th>)}
              </tr></thead>
              <VirtualTableBody items={filtered} getItemKey={executionKey} estimateSize={24} columns={7}>{(item, index) => {
                const state = executionJournalPresentation(item);
                const input = executionInputLabel(item);
                const result = executionResultLabel(item);
                return <tr data-execution-row={index} className={detailsOpen && item.id === selectedId ? 'bg-accent/50' : 'odd:bg-muted/15 even:bg-muted/45 hover:bg-accent/30 focus-within:bg-accent/30'}>
                  <td className="whitespace-nowrap px-2 py-0.5 leading-[18px] text-muted-foreground"><time dateTime={new Date(item.admittedAt).toISOString()} title={timeLabel(item.admittedAt)}>{new Date(item.admittedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time></td>
                  <td className="truncate px-2 py-0.5 leading-[18px]" title={executionConversationLabel(item.binding.conversationId)}>{executionConversationLabel(item.binding.conversationId)}</td>
                  <td className="px-2 py-0.5 leading-[18px]"><div className="flex min-w-0 items-center gap-1" title={input}>
                    {(item.summary?.mergedMessages ?? 0) > 1 && <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] text-primary">合并 {item.summary!.mergedMessages} 条</span>}
                    <span className={`truncate ${item.summary?.input.text ? '' : 'text-muted-foreground'}`}>{input}</span>
                  </div></td>
                  <td className="truncate px-2 py-0.5 leading-[18px]" title={result}><span className={item.summary?.reply.text ? 'font-medium' : 'text-muted-foreground'}>{result}</span></td>
                  <td className="px-2 py-0.5 leading-[18px]"><span className={`whitespace-nowrap ${state.tone === 'warning' ? 'text-status-warning' : state.tone === 'success' ? 'text-status-success' : 'text-muted-foreground'}`}>{state.label}</span></td>
                  <td className="whitespace-nowrap px-2 py-0.5 text-right tabular-nums leading-[18px] text-muted-foreground" title="从本轮受理到观察到结束，包含排队等待">{durationLabel(item.summary?.durationMs)}</td>
                  <td className="px-2 py-0.5 leading-[18px]"><Button size="xs" variant="ghost" className="h-[18px] min-h-0 px-1 py-0 text-xs text-primary" aria-label={`查看执行记录 ${index + 1}`} aria-pressed={item.id === selectedId} onClick={() => { setSelectedId(item.id); setDetailsOpen(true); }}>详情</Button></td>
                </tr>;
              }}</VirtualTableBody>
            </table>
            {filtered.length === 0 && <p className="p-5 text-xs text-muted-foreground">{available.items.length ? '已读取的记录中没有匹配项。' : '暂无处理记录。'}{available.next ? '仍可继续加载后续记录。' : ''}</p>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{available.next ? '还有更早记录' : available.partial ? '已加载服务提供的部分记录' : '已加载全部记录'}</p>{available.next && <Button size="sm" variant="outline" disabled={loading || moreLoading || pagingBlocked} onClick={() => void loadMore()}>加载更早记录</Button>}</div>
          {detailsOpen && selectionUnconfirmed && <p role="status" className="text-xs leading-5 text-muted-foreground" data-execution-selection-unconfirmed>这条记录不在当前列表中，请加载更早记录或重新选择。</p>}
          <DetailsWindow open={detailsOpen && selected !== null} onOpenChange={setDetailsOpen} title="本轮执行详情" description="收到什么、回复什么，以及实际发送结果。">{selected && selectedState && <div className="space-y-3 text-xs" data-execution-detail>
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{executionConversationLabel(selected.binding.conversationId)}</h3><StatusPill tone={selectedState.tone}>{selectedState.label}</StatusPill></div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground"><span>{timeLabel(selected.admittedAt)}</span>{selected.summary?.durationMs != null && <span>耗时 {durationLabel(selected.summary.durationMs)}（含排队）</span>}{(selected.summary?.mergedMessages ?? 0) > 1 && <span>合并 {selected.summary!.mergedMessages} 条消息</span>}</div>
            <section className="rounded-md border bg-muted/25 p-2.5"><h4 className="mb-1.5 font-medium text-muted-foreground">收到的内容</h4>
              {selected.summary?.input.senderId && <p className="mb-1 text-muted-foreground">{selected.summary.input.displayName ? `${selected.summary.input.displayName} · ` : ''}{selected.summary.input.senderId}</p>}
              <p className="whitespace-pre-wrap break-words leading-5 select-text">{selected.summary?.input.text ?? '这条记录没有保留可关联的输入摘要。'}</p>
            </section>
            <section className="rounded-md border border-primary/15 bg-primary/5 p-2.5"><h4 className="mb-1.5 font-medium">{selected.summary?.reply.text ? '已发送内容摘要' : '本轮结果'}</h4>
              <p className="whitespace-pre-wrap break-words leading-5 select-text">{executionResultLabel(selected)}</p>
              {selected.summary?.reply.text && selected.summary.reply.reason && <p className="mt-1 text-muted-foreground">{executionReplyReason(selected.summary.reply.reason)}</p>}
            </section>
            <p className={selectedState.tone === 'warning' ? 'text-status-warning' : 'text-muted-foreground'}>{selectedState.explanation}</p>
            {selected.summary && <dl aria-label="已记录的发送回执" className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md bg-muted/35 p-2.5">
              {([['confirmed', '已确认发送'], ['rejected', '未能发送'], ['unknown', '发送待确认'], ['pending', '等待发送结果']] as const).map(([key, label]) => <div key={key} className="flex justify-between gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{selected.summary!.delivery[key] === null ? '未留存' : `${selected.summary!.delivery[key]} 条`}</dd></div>)}
              {selected.summary.tools && <div className="col-span-2 flex justify-between gap-2 border-t pt-1.5"><dt className="text-muted-foreground">已完成的工具调用</dt><dd>{selected.summary.tools.count} 次</dd></div>}
            </dl>}
            {(!selected.summary || selected.summary.partial) && <p className="text-muted-foreground">部分明细未留存；缺失记录不代表未发送或未调用工具。</p>}
            {executionLateLabel(selected) && <p className="text-status-warning">{executionLateLabel(selected)}</p>}
            {executionErrorLabel(selected) && <p className="text-status-warning">{executionErrorLabel(selected)}</p>}
            <div className="flex flex-wrap items-center gap-2 border-t pt-2"><ReadOnlyDetails title="处理记录技术详情" label="技术详情" description="执行证据、标识和原始原因码，可选中文本复制。"><TechnicalDetails fields={[
              { label: '模型处理状态', value: executionPresentation(selected).label },
              { label: '后续处理', value: executionContinuationLabel(selected) },
              { label: '处理期限', value: timeLabel(selected.deadlineAt) },
              { label: '停止请求', value: executionCancelLabel(selected.cancelStatus) },
              { label: '超时提醒', value: executionNoticeLabel(selected.noticeStatus) },
              { label: '进度事件', value: selected.progressEvents },
              { label: '会话代次', value: selected.binding.generation },
              { label: '整体发送结果', value: selected.summary?.reply.outcome ?? '未记录' },
              { label: '未发送原因', value: selected.summary?.reply.reason ?? '未记录' },
              { label: '工具名称', value: selected.summary?.tools?.names.join('、') || '未记录' },
              ...technicalFields(selected), { label: '技术原因', value: selected.lastError ?? '无' },
            ]} /></ReadOnlyDetails>{selected.isolated && <Button size="sm" variant="outline" onClick={() => { setDetailsOpen(false); setManageOpen(true); }}>处理未完成任务</Button>}</div>
          </div>}</DetailsWindow>
          <DetailsWindow open={manageOpen && selected !== null} onOpenChange={setManageOpen} title="处理未完成任务" description="核对这轮处理的结果，再选择恢复操作。">{selected && <ExecutionManagement key={selected.id} api={api} connected={connected} entry={selected} onRead={reloadJournal} />}</DetailsWindow>
        </>}
      </div>
    </div>
  </Section>;
}
