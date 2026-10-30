import { ConversationTasks } from '../components/conversation-tasks.tsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, LoaderCircle, Pause, Play, RefreshCw, SkipForward } from 'lucide-react';
import {
  parsePluginScheduleHistorySnapshot, parsePluginScheduleManagementRequest, parsePluginScheduleManagementResponse, parsePluginScheduleSnapshot,
  type PluginScheduleHistoryItem, type PluginScheduleItem, type PluginScheduleManagementRequest,
} from '../../src/contracts/plugin-schedules.ts';
import { HelpTip } from '../components/help-tip.tsx';
import { ConnectPrompt, EmptyState, PageHeading, Section, StatusPill } from '../components/management.tsx';
import { DetailsWindow } from '../components/read-only-details.tsx';
import { ScheduleDetails, type ScheduleDetailTarget } from '../components/schedule-details.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.tsx';
import { ApiError, type ApiClient } from '../lib/api.ts';
import {
  pluginSchedulesPath, scheduleHistoryPath, scheduleHistoryStateLabel, scheduleKey, scheduleListPath,
  scheduleDuration, scheduleManagementError, scheduleOwner, scheduleStateLabel, scheduleTime, scheduleTitle, scheduleTone,
} from '../lib/plugin-schedules.ts';
import { writeResource } from '../lib/resource-reader.ts';
import type { PageProps } from '../lib/types.ts';
import { useReadResource } from '../lib/use-read-resource.ts';

type ControlAction = 'pause' | 'resume' | 'skip' | 'run-now';
type WriteState = 'idle' | 'saving' | 'error' | 'conflict' | 'unknown';
interface ControlTarget { readonly item: PluginScheduleItem; readonly action: ControlAction; readonly fromDetails?: boolean }
interface UnknownControl { readonly target: ControlTarget; readonly startedAt: number }
const uncertainControls = new WeakMap<ApiClient, ReadonlyMap<string, UnknownControl>>();
const actionLabels: Readonly<Record<ControlAction, string>> = { pause: '暂停日程', resume: '恢复日程', skip: '跳过本次', 'run-now': '立即执行' };
const maximumCachedSchedules = 1_000;
function remember<Key, Value>(cache: Map<Key, Value>, key: Key, value: Value): Map<Key, Value> {
  cache.delete(key); cache.set(key, value);
  while (cache.size > maximumCachedSchedules) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return cache;
}
const ruleStates: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: '全部调度状态' }, { value: 'enabled', label: '待执行' }, { value: 'running', label: '执行中' },
  { value: 'paused', label: '已暂停' }, { value: 'attention', label: '异常或待核对' }, { value: 'completed', label: '调度已结束' },
  { value: 'disabled', label: '未启用' }, { value: 'cancelled', label: '已取消' }, { value: 'expired', label: '已过期' },
];
const historyStates = ruleStates.filter(option => ['', 'running', 'attention', 'completed'].includes(option.value));

export function SchedulesPage({ api, connected, connect }: PageProps) {
  const [tab, setTab] = useState('tasks');
  const [owner, setOwner] = useState('');
  const [ruleState, setRuleState] = useState('');
  const [historyState, setHistoryState] = useState('');
  const [ruleAfter, setRuleAfter] = useState<string | null>(null);
  const [historyAfter, setHistoryAfter] = useState<string | null>(null);
  const [knownOwners, setKnownOwners] = useState<ReadonlyMap<string, string>>(new Map());
  const [knownRules, setKnownRules] = useState<ReadonlyMap<string, PluginScheduleItem>>(new Map());
  const rules = useReadResource(api, scheduleListPath(ruleAfter, owner), connected && tab !== 'tasks', parsePluginScheduleSnapshot);
  const history = useReadResource(api, scheduleHistoryPath(historyAfter, owner), connected && tab === 'history', parsePluginScheduleHistorySnapshot);
  const [details, setDetails] = useState<ScheduleDetailTarget | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [target, setTarget] = useState<ControlTarget | null>(null);
  const [writeState, setWriteState] = useState<WriteState>('idle');
  const [writeError, setWriteError] = useState('');
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [unknownView, setUnknownView] = useState(() => ({ api, items: uncertainControls.get(api) ?? new Map<string, UnknownControl>() }));
  const pending = unknownView.api === api ? unknownView.items : uncertainControls.get(api) ?? new Map<string, UnknownControl>();
  const controller = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const snapshot = rules.snapshot;
  const rows = useMemo(() => [...(snapshot?.items ?? [])].filter(item => {
    if (!ruleState) return true;
    if (ruleState === 'attention') return item.state === 'failed' || item.state === 'unknown' || item.managementState === 'unknown';
    return item.state === ruleState;
  }).sort((left, right) => (left.nextAt ?? Number.MAX_SAFE_INTEGER) - (right.nextAt ?? Number.MAX_SAFE_INTEGER)
      || scheduleTitle(left).localeCompare(scheduleTitle(right))), [snapshot, ruleState]);
  const historyRows = useMemo(() => [...(history.snapshot?.items ?? [])].filter(item => {
    if (!historyState) return true;
    return historyState === 'attention' ? item.status === 'failed' || item.status === 'unknown' : item.status === historyState;
  }).sort((left, right) => right.scheduledAt - left.scheduledAt), [history.snapshot, historyState]);
  const pluginOptions = [...knownOwners].sort((left, right) => left[1].localeCompare(right[1]));

  useEffect(() => {
    epoch.current++;
    controller.current?.abort(); controller.current = null;
    setTarget(null); setDetails(null); setWriteState('idle'); setWriteError(''); setNotice(''); setRowErrors(new Map()); setActiveKey(null);
    setOwner(''); setRuleAfter(null); setHistoryAfter(null); setKnownOwners(new Map()); setKnownRules(new Map());
    setUnknownView({ api, items: uncertainControls.get(api) ?? new Map() });
    return () => { epoch.current++; controller.current?.abort(); controller.current = null; };
  }, [api, connected]);

  useEffect(() => {
    if (!snapshot) return;
    setKnownOwners(previous => {
      const next = new Map(previous);
      for (const item of snapshot.items) remember(next, item.owner, scheduleOwner(item));
      return next;
    });
    setKnownRules(previous => {
      const next = new Map(previous);
      for (const item of snapshot.items) remember(next, scheduleKey(item), item);
      return next;
    });
  }, [snapshot]);
  useEffect(() => {
    if (!history.snapshot) return;
    setKnownOwners(previous => {
      const next = new Map(previous);
      for (const item of history.snapshot?.items ?? []) if (!next.has(item.owner)) remember(next, item.owner, item.presentation?.ownerLabel ?? '已登记插件');
      return next;
    });
  }, [history.snapshot]);
  useEffect(() => {
    if (!snapshot || rules.error || rules.loading || pending.size === 0) return;
    const next = new Map(pending);
    for (const [key, uncertain] of pending) {
      if (rules.updatedAt < uncertain.startedAt) continue;
      const current = snapshot.items.find(item => scheduleKey(item) === key);
      if (!current || current.managementState !== 'ready' || current.revision === uncertain.target.item.revision) continue;
      const confirmed = uncertain.target.action === 'run-now'
        ? current.lastOccurrence !== null && current.lastOccurrence.id !== uncertain.target.item.lastOccurrence?.id
        : uncertain.target.action === 'skip'
        ? current.nextAt !== uncertain.target.item.nextAt || current.cancelled && !uncertain.target.item.cancelled
        : current.paused === (uncertain.target.action === 'pause');
      if (confirmed) next.delete(key);
    }
    if (next.size === pending.size) return;
    uncertainControls.set(api, next); setUnknownView({ api, items: next });
    setRowErrors(previous => { const errors = new Map(previous); for (const key of pending.keys()) if (!next.has(key)) errors.delete(key); return errors; });
  }, [api, snapshot, rules.error, rules.loading, rules.updatedAt, pending]);

  function refresh() { rules.refresh(); if (tab === 'history') history.refresh(); }
  function changeOwner(value: string) { setOwner(value); setRuleAfter(null); setHistoryAfter(null); }
  function openControl(item: PluginScheduleItem, action: ControlAction, fromDetails = false) {
    if (controller.current || !fromDetails && (rules.error || rules.loading) || item.managementState !== 'ready' || pending.has(scheduleKey(item))
      || (action === 'run-now' ? !item.actions.canRunNow : action === 'skip' ? !item.actions.canSkip : !item.actions.canPause)) return;
    if (action !== 'skip') { void submitControl({ item, action, fromDetails }); return; }
    setTarget({ item, action, fromDetails }); setWriteState('idle'); setWriteError('');
  }
  function closeControl() {
    if (controller.current) return;
    if (writeState === 'unknown' || writeState === 'conflict') refresh();
    setTarget(null); setWriteState('idle'); setWriteError('');
  }
  async function submitControl(direct?: ControlTarget) {
    const chosen = direct ?? target;
    if (!chosen || controller.current || (!direct && (writeState === 'saving' || writeState === 'unknown' || writeState === 'conflict'))
      || !connected || !chosen.fromDetails && (rules.error || rules.loading) || pending.has(scheduleKey(chosen.item))) return;
    if ((uncertainControls.get(api)?.size ?? 0) >= maximumCachedSchedules) {
      const message = '待核对操作已达缓存上限，请先刷新核对已有操作。';
      setRowErrors(previous => remember(new Map(previous), scheduleKey(chosen.item), message));
      if (!direct) { setWriteState('error'); setWriteError(message); }
      return;
    }
    const currentItem = chosen.fromDetails ? chosen.item : rules.snapshot?.items.find(item => scheduleKey(item) === scheduleKey(chosen.item));
    if (!currentItem || currentItem.revision !== chosen.item.revision || currentItem.managementState !== 'ready'
      || (chosen.action === 'run-now' ? !currentItem.actions.canRunNow : chosen.action === 'skip' ? !currentItem.actions.canSkip : !currentItem.actions.canPause)) {
      const message = '日程或操作条件已变化，请刷新后重新选择。';
      setRowErrors(previous => remember(new Map(previous), scheduleKey(chosen.item), message));
      if (!direct) { setWriteState('conflict'); setWriteError(message); }
      return;
    }
    const body: PluginScheduleManagementRequest = chosen.action === 'skip' || chosen.action === 'run-now'
      ? { action: chosen.action, owner: chosen.item.owner, id: chosen.item.id, revision: chosen.item.revision }
      : { action: 'set-paused', paused: chosen.action === 'pause', owner: chosen.item.owner, id: chosen.item.id, revision: chosen.item.revision };
    if (!parsePluginScheduleManagementRequest(body)) {
      const message = '当前日程的操作信息未通过校验，请重新读取。';
      setRowErrors(previous => remember(new Map(previous), scheduleKey(chosen.item), message));
      if (!direct) { setWriteState('error'); setWriteError(message); }
      return;
    }
    const request = new AbortController();
    const generation = epoch.current;
    const startedAt = Date.now();
    controller.current = request;
    const live = () => !request.signal.aborted && controller.current === request && epoch.current === generation
      && connection.current.api === api && connection.current.connected;
    const key = scheduleKey(chosen.item);
    const lock = new Map(uncertainControls.get(api));
    lock.set(key, { target: chosen, startedAt });
    uncertainControls.set(api, lock); setUnknownView({ api, items: lock });
    setActiveKey(key); setRowErrors(previous => { const next = new Map(previous); next.delete(key); return next; });
    setWriteState('saving'); setWriteError(''); setNotice('');
    try {
      const response = parsePluginScheduleManagementResponse(await writeResource(api, pluginSchedulesPath, body, request.signal));
      if (!live()) return;
      if (!response || response.action !== body.action || scheduleKey(response.item) !== scheduleKey(chosen.item)
        || body.action === 'set-paused' && response.item.paused !== body.paused) throw new ApiError('plugin_schedule_result_unknown', 504);
      if (response.item.managementState !== 'ready' && !(body.action === 'run-now' && response.item.managementState === 'running-now')) throw new ApiError('plugin_schedule_result_unknown', 504);
      const next = new Map(uncertainControls.get(api)); next.delete(key);
      uncertainControls.set(api, next); setUnknownView({ api, items: next });
      setNotice(chosen.action === 'pause' ? '日程已暂停，暂停状态会保留。' : chosen.action === 'resume' ? '日程已恢复。' : chosen.action === 'run-now' ? '已启动本次执行，请在执行记录中查看进展。' : '本次已跳过。');
      setTarget(null); setWriteState('idle'); setDetailRevision(value => value + 1); refresh();
    } catch (error) {
      if (!live()) return;
      const uncertain = !(error instanceof ApiError && error.status >= 400 && error.status < 500 && !/unknown/i.test(error.code));
      if (!uncertain) {
        const next = new Map(uncertainControls.get(api)); next.delete(key);
        uncertainControls.set(api, next); setUnknownView({ api, items: next });
      }
      setWriteState(uncertain ? 'unknown' : error instanceof ApiError && /conflict|revision|stale/i.test(error.code) ? 'conflict' : 'error');
      const message = uncertain ? '本日程的操作结果尚未确认，请刷新核对；暂不重复提交。' : scheduleManagementError(error);
      setRowErrors(previous => remember(new Map(previous), key, message));
      if (!direct) setWriteError(message);
    } finally {
      if (live()) { controller.current = null; setActiveKey(null); }
    }
  }
  function showRule(item: PluginScheduleItem) { setDetails({ owner: item.owner, id: item.id, title: scheduleTitle(item) }); }
  function showOccurrence(item: PluginScheduleHistoryItem) {
    const rule = knownRules.get(scheduleKey({ owner: item.owner, id: item.ruleId }));
    setDetails({ owner: item.owner, id: item.ruleId, occurrenceId: item.id, title: item.presentation?.title ?? (rule ? scheduleTitle(rule) : '插件任务') });
  }
  const selectedFilter = tab === 'history' ? historyState : ruleState;
  const setSelectedFilter = tab === 'history' ? setHistoryState : setRuleState;
  const writeBusy = controller.current !== null || writeState === 'saving';

  return <div className="page-stack" data-page="schedules">
    <PageHeading title="任务与日程" description="查看会话任务与插件日程的执行进展和实际结果" actions={tab !== 'tasks' && <Button size="sm" variant="ghost" disabled={!connected || rules.loading || tab === 'history' && history.loading} onClick={refresh}><RefreshCw className={rules.loading || tab === 'history' && history.loading ? 'size-3 animate-spin' : 'size-3'} />刷新</Button>} />
    {!connected ? <ConnectPrompt connect={connect} /> : <>
      <Tabs value={tab} onValueChange={value => setTab(String(value))} className="gap-2"><div className="row between"><TabsList aria-label="任务与日程视图"><TabsTrigger value="tasks">会话任务</TabsTrigger><TabsTrigger value="upcoming">插件日程</TabsTrigger><TabsTrigger value="history">插件执行记录</TabsTrigger></TabsList>{tab !== 'tasks' && <div className="row"><div className="row small"><span id="schedule-owner-label" className="muted">插件</span><Select value={owner} onValueChange={value => changeOwner(typeof value === 'string' ? value : '')}><SelectTrigger aria-labelledby="schedule-owner-label" className="max-w-48"><SelectValue>{knownOwners.get(owner) ?? (owner ? '已登记插件' : '全部插件')}</SelectValue></SelectTrigger><SelectContent><SelectItem value="">全部插件</SelectItem>{pluginOptions.map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent></Select></div><div className="row small"><span id="schedule-state-label" className="muted">状态</span><Select value={selectedFilter} onValueChange={value => setSelectedFilter(typeof value === 'string' ? value : '')}><SelectTrigger aria-labelledby="schedule-state-label"><SelectValue>{(tab === 'history' ? historyStates : ruleStates).find(option => option.value === selectedFilter)?.label ?? '全部调度状态'}</SelectValue></SelectTrigger><SelectContent>{(tab === 'history' ? historyStates : ruleStates).map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div></div>}</div>
        {tab !== 'tasks' && <>
      <div id="schedule-summary" className="summaryline small" aria-label="日程概览"><span className="row"><CalendarClock className="size-3.5 text-muted-foreground" /><strong>运行</strong><StatusPill tone={snapshot?.running ? 'success' : 'neutral'}>{snapshot ? !snapshot.available ? '尚未接入' : snapshot.running ? '调度运行中' : '调度已停止' : '待确认'}</StatusPill></span><span>待执行 <strong>{snapshot?.summary.pending ?? '—'}</strong></span><span>执行中 <strong>{snapshot?.summary.running ?? '—'}</strong></span><span className={snapshot && snapshot.summary.failed + snapshot.summary.unknown > 0 ? 'text-[var(--warning)]' : undefined}>异常 <strong>{snapshot ? snapshot.summary.failed + snapshot.summary.unknown : '—'}</strong></span><HelpTip label="日程统计">数字来自当前插件范围的调度汇总。回调结束不代表发送或发布成功；插件进展与实际结果在详情中分别展示。立即执行在后台运行，保留原失败记录；单次日程执行后不再到点重复触发，周期日程保留后续安排。只有插件核验可安全执行时才显示按钮。</HelpTip><span className="push muted">{rules.updatedAt ? `${rules.error ? '上次读取' : '读取于'} ${scheduleTime(rules.updatedAt)}` : '尚未读取'}</span></div>
      {rules.error && <p className="strip warn" role="alert">日程读取失败，{snapshot ? '保留上次快照；当前状态需要重新核对。' : '当前计划与运行状态尚未确认。'}</p>}
      {notice && <p className="strip" role="status">{notice}</p>}
        </>}
        <TabsContent value="tasks" keepMounted className="[&[hidden]]:hidden"><ConversationTasks api={api} connected={connected} active={tab === 'tasks'} /></TabsContent>
        <TabsContent value="upcoming" keepMounted className="[&[hidden]]:hidden"><Section id="schedule-upcoming" title="插件日程" className="flush" actions={<span className="small muted">{rows.length} / {snapshot?.items.length ?? 0} 项</span>}>
          {!snapshot && rules.loading ? <p className="row small muted p-3" role="status"><LoaderCircle className="size-3 animate-spin" />正在读取日程…</p> : rows.length === 0 ? <EmptyState title={rules.error ? '日程暂不可用' : owner || ruleState ? '没有匹配的日程' : '暂无插件日程'} description={rules.error ? '请刷新核对，读取失败不表示没有任务。' : '插件登记的计划会显示在这里；此页用于查看和管理现有日程。'} /> : <div className="tablewrap"><table><thead><tr><th>名称</th><th>插件</th><th>下次时间</th><th>实际进展</th><th>调度状态</th><th className="text-right">操作</th></tr></thead><tbody>{rows.map(item => {
            const uncertain = pending.has(scheduleKey(item));
            const disabled = writeBusy || rules.loading || rules.error !== null || uncertain || item.managementState !== 'ready';
            return <tr key={scheduleKey(item)}><td className="max-w-64"><strong className="block truncate" title={scheduleTitle(item)}>{scheduleTitle(item)}</strong>{rowErrors.get(scheduleKey(item)) && <span className="block truncate small text-[var(--warning)]" title={rowErrors.get(scheduleKey(item))} role="status">{rowErrors.get(scheduleKey(item))}</span>}</td><td>{scheduleOwner(item)}</td><td className="tabular-nums" title={item.timeZone}>{scheduleTime(item.nextAt)}</td><td className="max-w-72"><span className="block truncate" title={item.business?.summary}>{item.business?.stage || '尚无业务进展'}</span>{item.business?.summary && <span className="block truncate small muted" title={item.business.summary}>{item.business.summary}</span>}</td><td><StatusPill tone={uncertain || item.managementState === 'unknown' ? 'warning' : scheduleTone(item.state)}>{activeKey === scheduleKey(item) ? '正在保存' : uncertain ? '操作待核对' : scheduleStateLabel(item)}</StatusPill>{uncertain && activeKey !== scheduleKey(item) && <HelpTip label="此日程操作待核对">操作结果尚未确认。请刷新并查看此日程详情，其他日程仍可操作。</HelpTip>}</td><td><div className="row justify-end">{item.actions.canPause && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => openControl(item, item.paused ? 'resume' : 'pause')}>{item.paused ? <Play className="size-3" /> : <Pause className="size-3" />}{item.paused ? '恢复' : '暂停'}</Button>}{item.state === 'running' && item.actions.canPause && <HelpTip label="执行中暂停说明">暂停后续触发，当前执行继续。</HelpTip>}{item.actions.canRunNow && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => openControl(item, 'run-now')}><Play className="size-3" />立即执行</Button>}{item.actions.canSkip && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => openControl(item, 'skip')}><SkipForward className="size-3" />跳过本次</Button>}<Button size="sm" variant="link" onClick={() => showRule(item)}>详情</Button></div></td></tr>;
          })}</tbody></table></div>}
          <div className="row small muted px-2.5 py-1.5"><span>状态筛选作用于本页；插件筛选按完整目录查询。</span><span className="push">{ruleAfter && <Button size="sm" variant="ghost" disabled={rules.loading} onClick={() => setRuleAfter(null)}>返回首批</Button>}{snapshot?.next && <Button size="sm" variant="outline" disabled={rules.loading} onClick={() => setRuleAfter(snapshot?.next ?? null)}>下一批</Button>}</span></div>
        </Section></TabsContent>
        <TabsContent value="history" keepMounted className="[&[hidden]]:hidden"><Section id="schedule-history" title="插件执行记录" className="flush" actions={<span className="small muted">{historyRows.length} / {history.snapshot?.items.length ?? 0} 条</span>}>
          {history.error && <p className="strip warn m-2" role="alert">执行记录读取失败；保留已读取内容，不能据此确认没有执行。</p>}
          {!history.snapshot && history.loading ? <p className="row small muted p-3" role="status"><LoaderCircle className="size-3 animate-spin" />正在读取执行记录…</p> : historyRows.length === 0 ? <EmptyState title={history.error ? '执行记录暂不可用' : '暂无匹配的执行记录'} description="执行阶段与插件业务结果在每条记录的详情中查看。" /> : <div className="tablewrap"><table><thead><tr><th>名称</th><th>插件</th><th>计划时间</th><th>实际进展</th><th>耗时</th><th>调度状态</th><th className="text-right">操作</th></tr></thead><tbody>{historyRows.map(item => {
            const rule = knownRules.get(scheduleKey({ owner: item.owner, id: item.ruleId }));
            return <tr key={JSON.stringify([item.owner, item.id])}><td className="max-w-64"><strong className="block truncate" title={item.presentation?.title ?? (rule ? scheduleTitle(rule) : '插件任务')}>{item.presentation?.title ?? (rule ? scheduleTitle(rule) : '插件任务')}</strong>{item.trigger === 'manual' && <span className="small muted">手动执行</span>}</td><td>{item.presentation?.ownerLabel ?? knownOwners.get(item.owner) ?? '已登记插件'}</td><td className="tabular-nums">{scheduleTime(item.scheduledAt)}</td><td className="max-w-72"><span className="block truncate" title={item.business?.summary}>{item.business?.stage || '尚无业务进展'}</span>{item.business?.summary && <span className="block truncate small muted" title={item.business.summary}>{item.business.summary}</span>}</td><td className="tabular-nums">{scheduleDuration(item)}</td><td><StatusPill tone={scheduleTone(item.status)}>{scheduleHistoryStateLabel(item.status)}</StatusPill></td><td className="text-right"><Button size="sm" variant="link" onClick={() => showOccurrence(item)}>详情</Button></td></tr>;
          })}</tbody></table></div>}
          <div className="row small muted px-2.5 py-1.5"><span>按计划时间倒序；状态筛选仅作用已读取记录。</span><span className="push">{historyAfter && <Button size="sm" variant="ghost" disabled={history.loading} onClick={() => setHistoryAfter(null)}>返回首批</Button>}{history.snapshot?.next && <Button size="sm" variant="outline" disabled={history.loading} onClick={() => setHistoryAfter(history.snapshot?.next ?? null)}>下一批</Button>}</span></div>
        </Section></TabsContent>
      </Tabs>
      <DetailsWindow open={details !== null} onOpenChange={open => { if (!open) setDetails(null); }} title={details?.title ?? '日程详情'} description="时间规则、关联会话、实际阶段与结果分别展示。">{details && <ScheduleDetails key={JSON.stringify([details.owner, details.id, details.occurrenceId ?? null, detailRevision])} api={api} connected={connected} target={details} controls={{ busy: writeBusy, errors: rowErrors, pendingIds: new Set(pending.keys()), onOpen: showRule, onRunNow: item => openControl(item, 'run-now', true) }} />}</DetailsWindow>
      <Dialog open={target !== null} onOpenChange={open => { if (!open) closeControl(); }}><DialogContent showCloseButton={!writeBusy}><DialogHeader><DialogTitle>{target ? actionLabels[target.action] : '管理日程'}</DialogTitle><DialogDescription>{target ? scheduleTitle(target.item) : '请核对所选日程'}</DialogDescription></DialogHeader>{target && <div className="stack"><dl className="info"><dt>插件</dt><dd>{scheduleOwner(target.item)}</dd><dt>下次时间</dt><dd>{scheduleTime(target.item.nextAt, true)}</dd></dl><p className="strip">确认后跳过本次任务，不会执行本次生成或发布。</p>{writeError && <p className="strip warn" role="alert">{writeError}</p>}</div>}<DialogFooter><Button variant="ghost" disabled={writeBusy} onClick={closeControl}>{writeState === 'unknown' || writeState === 'conflict' ? '关闭并刷新核对' : '取消'}</Button><Button disabled={!target || writeBusy || writeState === 'unknown' || writeState === 'conflict' || rules.error !== null || rules.loading} onClick={() => void submitControl()}>{writeBusy && <LoaderCircle className="size-3 animate-spin" />}{writeBusy ? '正在处理' : target ? `确认${actionLabels[target.action]}` : '确认'}</Button></DialogFooter></DialogContent></Dialog>
    </>}
  </div>;
}
