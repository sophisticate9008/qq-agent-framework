import { ReadOnlyDetails, TechnicalDetails } from '../components/read-only-details.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.tsx';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Banknote, BrainCircuit, Coins, Database, LoaderCircle, RefreshCw, Sigma, Trash2, Waypoints } from 'lucide-react';

import { ConnectPrompt, EmptyState, PageHeading, Section, StatusPill } from '../components/management.tsx';
import { VirtualTableBody } from '../components/virtual-list.tsx';
import { UsageModelCosts } from '../components/usage-model-costs.tsx';
import { UsageChart } from '../components/usage-chart.tsx';
import { UsageConversation, usageSessionSuffix } from '../components/usage-conversation.ts';
import { UsageTokenBreakdown } from '../components/usage-token-breakdown.tsx';
import { UsagePricingManager } from '../components/usage-pricing-manager.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx';
import { Input } from '../components/ui/input.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { ApiError, errorMessage, isRecord } from '../lib/api.ts';
import {
  describeConversationKey,
  formatActivityCost,
  formatUsageCount,
  parseUsageSnapshot,
  sumUsageCounts,
  type UsageBuckets,
  type UsageNowTier,
  type UsagePriceTable,
  type UsageSnapshot,
  type ConversationUsage,
} from '../lib/activity.ts';
import {
  parseUsageConversation,
  formatUsageWindowEndpoint,
  parseUsageRecent,
  parseUsageResetAccepted,
  parseUsageSeries,
  usageSectionLabels,
  type AggregateUsageTier,
  type UsageChartMetric,
  type UsageConversationDetails,
  type UsageRecent,
  type UsageSeries,
} from '../lib/usage-details.ts';
import type { PageProps } from '../lib/types.ts';

const resetConfirmation = '清空用量账本';
const rangeOptions = [
  { hours: 24, label: '24 小时' },
  { hours: 72, label: '3 天' },
  { hours: 168, label: '7 天' },
  { hours: 720, label: '30 天' },
] as const;
const compactSectionClass = '[&>.panel-body]:p-2.5';
const ledgerSectionClass = 'rounded-none border-0 shadow-none [&>.panel-header]:border-0 [&>.panel-header]:bg-transparent [&>.panel-body]:pt-0';

type ResetState = 'idle' | 'saving' | 'conflict' | 'unknown' | 'error';
type RefreshReason = 'initial' | 'manual' | 'automatic';

function ledgerIdentity(conversation: ConversationUsage): string {
  return conversation.ledgerKey ?? conversation.key;
}

function formatTimestamp(value: string | number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(new Date(value));
}

function formatPercentage(value: number | null): string {
  if (value === null) return '未知';
  return new Intl.NumberFormat('zh-CN', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

function usageError(error: unknown, invalidCode: string, invalidMessage: string): string {
  if (error instanceof ApiError && error.code === 'runtime_not_connected') {
    return '聊天宿主与账本数据源尚未接入，用量当前不可用。';
  }
  return error instanceof Error && error.message === invalidCode ? invalidMessage : errorMessage(error);
}

function tierLabel(tier: AggregateUsageTier): string {
  if (tier === 'flat') return '固定单价';
  if (tier === 'peak') return '高峰';
  if (tier === 'mixed') return '混合';
  return '低谷';
}

function TierBadge({ tier }: { readonly tier: AggregateUsageTier }) {
  const className = tier === 'peak'
    ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    : tier === 'mixed'
      ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
      : tier === 'off' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-border bg-muted text-muted-foreground';
  return <Badge variant="outline" className={className}>{tierLabel(tier)}</Badge>;
}

function MetricCard({ id, label, value, caption, icon }: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly caption: ReactNode;
  readonly icon: typeof Sigma;
}) {
  const Icon = icon;
  return <div data-usage-metric={id} className="metric min-w-0"><div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{label}</span><Icon className="size-3.5 shrink-0" /></div><strong className="mt-1 block break-words text-xl font-semibold tabular-nums">{value}</strong><p className="mt-1 text-xs leading-4 text-muted-foreground">{caption}</p></div>;
}

function BlockUnavailable({ title, description }: { readonly title: string; readonly description: string }) {
  return <div className="rounded-lg border border-dashed px-4 py-4"><strong className="text-sm font-medium">{title}</strong><p className="mt-1.5 text-xs leading-5 text-muted-foreground">{description}</p></div>;
}

function LoadingBlock({ children }: { readonly children: ReactNode }) {
  return <div className="flex min-h-32 items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />{children}</div>;
}

function cacheHitRate(buckets: UsageBuckets): number | null {
  const input = sumUsageCounts(buckets.cacheMiss, buckets.cacheHit, buckets.cacheWrite);
  if (input === null || buckets.cacheHit === null) return null;
  return input > 0 ? buckets.cacheHit / input : 0;
}

function resetErrorState(error: unknown): ResetState {
  if (error instanceof ApiError && (error.status === 409 || /conflict|stale|revision/.test(error.code))) return 'conflict';
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && !/unknown/.test(error.code)) return 'error';
  return 'unknown';
}

function resetStateMessage(state: ResetState, fallback: string): string {
  if (state === 'conflict') return '账本已在其他位置变化。请关闭并刷新统计，核对新的 revision 后重新输入确认文字。';
  if (state === 'unknown') return '服务无法确认清空请求是否已受理。请勿再次提交；先关闭并刷新统计，核对账本当前状态。';
  return fallback;
}

function hasAvailablePricing(value: UsageSnapshot): value is UsageSnapshot & {
  readonly priceTable: UsagePriceTable;
  readonly nowTier: UsageNowTier;
} {
  return value.priceTable !== null && value.nowTier !== null;
}

function KnownCosts({ costs }: { readonly costs: Readonly<Record<string, number>> | undefined }) {
  const entries = Object.entries(costs ?? {});
  return entries.length === 0 ? null : <span className="block text-xs text-muted-foreground" data-usage-known-costs>已记录：{entries.map(([currency, amount]) => formatActivityCost(amount, currency, `${currency} `)).join(' · ')}（分币种，不合并）</span>;
}

function NativeCoverageSummary({ usage, detailedCounts }: { readonly usage: UsageSnapshot; readonly detailedCounts: boolean }) {
  const coverage = usage.coverage;
  if (!coverage) return null;
  const labels: Readonly<Record<string, string>> = { input: '未命中输入', output: '输出', cacheRead: '缓存读取', cacheWrite: '缓存写入', total: '总量', reasoning: '推理' };
  return <div className="mb-3 grid gap-2 rounded-lg border p-3 text-xs leading-5" data-native-usage-coverage>
    <p>{coverage.records === 0 ? '尚无用量记录。' : `${coverage.records} 条用量记录，${coverage.incompleteTurns} 轮计数不完整，${coverage.missingCostTurns} 条费用未知。`}</p>
    <KnownCosts costs={coverage.knownCosts} />
    {coverage.records > 0 && <div><p className="font-medium">已知 Token 小计与缺失情况</p><div className="mt-2">{Object.entries(labels).map(([key, label]) => <p key={key}>{label}：{coverage.knownTokens[key] === undefined || coverage.knownTokens[key] === 0 && (coverage.missingTokens[key] ?? 0) > 0 ? '未知' : formatUsageCount(coverage.knownTokens[key], detailedCounts)}；缺失 {coverage.missingTokens[key] ?? '未知'} 条</p>)}</div></div>}
    <p className="text-muted-foreground">累计显示已记录小计，未报告字段保持未知，不按零补齐；不同币种不合并。缺失费用可按原价格快照或记录时段的内置参考价补充估算，已有金额保持原值。</p>
    {(coverage.missingTokens.cacheRead ?? 0) > 0 && <p className="text-muted-foreground">部分调用未报告缓存读取，命中率与未命中分项保持未知；可确认的总输入仍计入累计输入。</p>}
    <p className="text-muted-foreground">累计输入是各次模型请求的输入之和，同一上下文可能多次计入；它不是当前上下文大小。</p>
  </div>;
}

export function UsagePage(props: PageProps) {
  const { api, connected, connect } = props;
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [series, setSeries] = useState<UsageSeries | null>(null);
  const [turns, setTurns] = useState<UsageConversationDetails | null>(null);
  const [recent, setRecent] = useState<UsageRecent | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [recentLoading, setRecentLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [seriesError, setSeriesError] = useState('');
  const [turnsError, setTurnsError] = useState('');
  const [recentError, setRecentError] = useState('');
  const [refreshMessage, setRefreshMessage] = useState('');
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const [rangeHours, setRangeHours] = useState(24);
  const [chartMetric, setChartMetric] = useState<UsageChartMetric>('cost');
  const [detailedCounts, setDetailedCounts] = useState(false);
  const [selectedBucket, setSelectedBucket] = useState<number | null>(null);
  const [selectedKey, setSelectedKey] = useState('');
  const [usageView, setUsageView] = useState('conversations');
  const [autoRefreshMs, setAutoRefreshMs] = useState<number | null>(10_000);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');
  const [resetState, setResetState] = useState<ResetState>('idle');
  const [resetError, setResetError] = useState('');
  const [resetRevision, setResetRevision] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConversationUsage | null>(null);
  const [deleteState, setDeleteState] = useState<ResetState>('idle');
  const [deleteError, setDeleteError] = useState('');
  const [ledgerWriting, setLedgerWriting] = useState(false);
  const summaryController = useRef<AbortController | null>(null);
  const seriesController = useRef<AbortController | null>(null);
  const turnsController = useRef<AbortController | null>(null);
  const recentController = useRef<AbortController | null>(null);
  const resetController = useRef<AbortController | null>(null);
  const deleteController = useRef<AbortController | null>(null);
  const conversationsRef = useRef<readonly ConversationUsage[]>([]);
  const ledgerWriteBusy = useRef(false);
  const summaryRequest = useRef(0);
  const seriesRequest = useRef(0);
  const turnsRequest = useRef(0);
  const recentRequest = useRef(0);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const lifecycleEpoch = useRef(0);
  const selectedKeyRef = useRef('');
  const rangeHoursRef = useRef(24);
  const formatCount = (value: number | null): string => formatUsageCount(value, detailedCounts);

  const loadSummary = useCallback(async (): Promise<void> => {
    summaryController.current?.abort();
    const controller = new AbortController();
    const request = summaryRequest.current + 1;
    summaryController.current = controller;
    summaryRequest.current = request;
    setSummaryLoading(true);
    try {
      const parsed = parseUsageSnapshot(await api.get('/api/chat/usage?limit=200', controller.signal));
      if (!parsed) throw new Error('invalid_usage_response');
      if (controller.signal.aborted || summaryRequest.current !== request) return;
      setUsage(parsed);
      conversationsRef.current = parsed.conversations;
      setRuntimeUnavailable(false);
      setSummaryError('');
      if (!parsed.conversations.some(conversation => ledgerIdentity(conversation) === selectedKeyRef.current)) {
        const next = parsed.conversations[0] ? ledgerIdentity(parsed.conversations[0]) : '';
        selectedKeyRef.current = next;
        setSelectedKey(next);
        turnsController.current?.abort();
        setTurns(null);
        setTurnsError('');
        setTurnsLoading(false);
      }
    } catch (error) {
      if (!controller.signal.aborted && summaryRequest.current === request) {
        if (error instanceof ApiError && error.code === 'runtime_not_connected') setRuntimeUnavailable(true);
        setSummaryError(usageError(error, 'invalid_usage_response', '用量汇总返回了无法识别的内容。'));
      }
    } finally {
      if (!controller.signal.aborted && summaryRequest.current === request) setSummaryLoading(false);
    }
  }, [api]);

  const loadSeries = useCallback(async (hours: number): Promise<void> => {
    seriesController.current?.abort();
    const controller = new AbortController();
    const request = seriesRequest.current + 1;
    seriesController.current = controller;
    seriesRequest.current = request;
    setSeriesLoading(true);
    try {
      const parsed = parseUsageSeries(await api.get(`/api/chat/usage/series?hours=${hours}&buckets=48`, controller.signal));
      if (!parsed || parsed.hours !== hours) throw new Error('invalid_usage_series_response');
      if (controller.signal.aborted || seriesRequest.current !== request || rangeHoursRef.current !== hours) return;
      setSeries(parsed);
      setSeriesError('');
      setSelectedBucket(current => current !== null && current < parsed.buckets.length ? current : null);
    } catch (error) {
      if (!controller.signal.aborted && seriesRequest.current === request && rangeHoursRef.current === hours) {
        setSeriesError(usageError(error, 'invalid_usage_series_response', '走势数据返回了无法识别的内容。'));
      }
    } finally {
      if (!controller.signal.aborted && seriesRequest.current === request) setSeriesLoading(false);
    }
  }, [api]);

  const loadRecent = useCallback(async (): Promise<void> => {
    recentController.current?.abort();
    const controller = new AbortController();
    const request = recentRequest.current + 1;
    recentController.current = controller;
    recentRequest.current = request;
    setRecentLoading(true);
    try {
      const parsed = parseUsageRecent(await api.get('/api/chat/usage/recent?limit=40', controller.signal));
      if (!parsed) throw new Error('invalid_usage_recent_response');
      if (controller.signal.aborted || recentRequest.current !== request) return;
      setRecent(parsed);
      setRecentError('');
    } catch (error) {
      if (!controller.signal.aborted && recentRequest.current === request) {
        setRecentError(usageError(error, 'invalid_usage_recent_response', '最近调用流水返回了无法识别的内容。'));
      }
    } finally {
      if (!controller.signal.aborted && recentRequest.current === request) setRecentLoading(false);
    }
  }, [api]);

  const loadTurns = useCallback(async (key: string): Promise<void> => {
    if (!key) return;
    const conversation = conversationsRef.current.find(item => ledgerIdentity(item) === key);
    if (!conversation) return;
    turnsController.current?.abort();
    const controller = new AbortController();
    const request = turnsRequest.current + 1;
    turnsController.current = controller;
    turnsRequest.current = request;
    setTurnsLoading(true);
    setTurnsError('');
    try {
      const sessionId = conversation.sessionId ?? undefined;
      const query = new URLSearchParams({ key: conversation.key, limit: '200', ...(sessionId ? { sessionId } : {}) });
      const parsed = parseUsageConversation(await api.get(`/api/chat/usage/turns?${query}`, controller.signal), conversation.key, sessionId);
      if (!parsed) throw new Error('invalid_usage_turns_response');
      if (controller.signal.aborted || turnsRequest.current !== request || selectedKeyRef.current !== key) return;
      setTurns(parsed);
    } catch (error) {
      if (!controller.signal.aborted && turnsRequest.current === request && selectedKeyRef.current === key) {
        setTurns(null);
        setTurnsError(usageError(error, 'invalid_usage_turns_response', '逐轮明细返回了无法识别的内容。'));
      }
    } finally {
      if (!controller.signal.aborted && turnsRequest.current === request) setTurnsLoading(false);
    }
  }, [api]);

  const runRefresh = useCallback((reason: RefreshReason): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    if (reason === 'automatic' && document.visibilityState !== 'visible') return Promise.resolve();
    const epoch = lifecycleEpoch.current;
    const promise = Promise.all([loadSummary(), loadSeries(rangeHoursRef.current), loadRecent()]).then(async () => {
      if (lifecycleEpoch.current !== epoch) return;
      if (selectedKeyRef.current) await loadTurns(selectedKeyRef.current);
      if (lifecycleEpoch.current !== epoch) return;
      if (reason === 'manual') setRefreshMessage(`统计已刷新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
    }).finally(() => {
      if (refreshInFlight.current === promise) refreshInFlight.current = null;
    });
    refreshInFlight.current = promise;
    return promise;
  }, [loadRecent, loadSeries, loadSummary, loadTurns]);

  useEffect(() => {
    lifecycleEpoch.current += 1;
    if (!connected) {
      summaryController.current?.abort();
      seriesController.current?.abort();
      turnsController.current?.abort();
      recentController.current?.abort();
      setUsage(null);
      setSeries(null);
      setTurns(null);
      setRecent(null);
      conversationsRef.current = [];
      selectedKeyRef.current = '';
      setSelectedKey('');
      setDeleteTarget(null);
      setDeleteState('idle');
      setDeleteError('');
      setLedgerWriting(false);
    } else {
      void runRefresh('initial');
    }
    return () => {
      lifecycleEpoch.current += 1;
      refreshInFlight.current = null;
      summaryController.current?.abort();
      seriesController.current?.abort();
      turnsController.current?.abort();
      recentController.current?.abort();
      resetController.current?.abort();
      deleteController.current?.abort();
    };
  }, [connected, runRefresh]);

  useEffect(() => {
    if (!connected || runtimeUnavailable || autoRefreshMs === null || ledgerWriting) return;
    const refreshVisiblePage = (): void => {
      if (document.visibilityState === 'visible') void runRefresh('automatic');
    };
    const timer = window.setInterval(refreshVisiblePage, autoRefreshMs);
    document.addEventListener('visibilitychange', refreshVisiblePage);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisiblePage);
    };
  }, [autoRefreshMs, connected, ledgerWriting, runRefresh, runtimeUnavailable]);

  const selectedConversation = useMemo(
    () => usage?.conversations.find(conversation => ledgerIdentity(conversation) === selectedKey) ?? null,
    [selectedKey, usage]
  );
  const selectableConversations = usage?.conversations ?? [];

  function selectRange(hours: number): void {
    rangeHoursRef.current = hours;
    setRangeHours(hours);
    setSelectedBucket(null);
    void loadSeries(hours);
  }

  function selectConversation(key: string, expandTurns = false): void {
    if (expandTurns) setUsageView('turns');
    selectedKeyRef.current = key;
    setSelectedKey(key);
    setTurns(null);
    void loadTurns(key);
  }

  function openReset(): void {
    if (usage?.resetAvailable === false || ledgerWriteBusy.current || deleteState === 'saving' || deleteTarget) return;
    setResetText('');
    setResetState('idle');
    setResetError('');
    setResetRevision(usage?.revision ?? null);
    setResetOpen(true);
  }

  function closeReset(): void {
    if (resetState === 'saving') return;
    const verify = resetState === 'conflict' || resetState === 'unknown';
    setResetOpen(false);
    setResetText('');
    setResetState('idle');
    setResetError('');
    setResetRevision(null);
    if (verify) void runRefresh('manual');
  }

  async function resetLedger(): Promise<void> {
    if (ledgerWriteBusy.current || !resetRevision || resetText !== resetConfirmation || resetState !== 'idle' && resetState !== 'error') return;
    ledgerWriteBusy.current = true;
    setLedgerWriting(true);
    resetController.current?.abort();
    const controller = new AbortController();
    resetController.current = controller;
    setResetState('saving');
    setResetError('');
    try {
      const accepted = parseUsageResetAccepted(await api.post('/api/chat/usage/reset', {
        revision: resetRevision,
        confirm: resetConfirmation,
      }, controller.signal));
      if (!accepted) throw new ApiError('usage_reset_unknown', 504);
      if (controller.signal.aborted) return;
      setResetOpen(false);
      setResetText('');
      setResetState('idle');
      setResetRevision(null);
      setTurns(null);
      lifecycleEpoch.current += 1;
      refreshInFlight.current = null;
      summaryController.current?.abort();
      seriesController.current?.abort();
      turnsController.current?.abort();
      recentController.current?.abort();
      await runRefresh('manual');
      if (controller.signal.aborted) return;
      setRefreshMessage('已清空全部账本记录，统计已刷新。');
    } catch (error) {
      if (controller.signal.aborted) return;
      setResetState(resetErrorState(error));
      setResetError(errorMessage(error));
    } finally {
      ledgerWriteBusy.current = false;
      if (!controller.signal.aborted) setLedgerWriting(false);
    }
  }

  function openDelete(conversation: ConversationUsage): void {
    if (!usage?.native || !conversation.ledgerKey || !conversation.sessionId || !conversation.revision
      || resetOpen || ledgerWriteBusy.current) return;
    setDeleteTarget(conversation);
    setDeleteState('idle');
    setDeleteError('');
  }

  function closeDelete(): void {
    if (deleteState === 'saving') return;
    const verify = deleteState === 'conflict' || deleteState === 'unknown';
    setDeleteTarget(null);
    setDeleteState('idle');
    setDeleteError('');
    if (verify) void runRefresh('manual');
  }

  async function deleteSessionLedger(): Promise<void> {
    const target = deleteTarget;
    if (ledgerWriteBusy.current || !target?.sessionId || !target.revision
      || deleteState !== 'idle' && deleteState !== 'error') return;
    ledgerWriteBusy.current = true;
    setLedgerWriting(true);
    const controller = new AbortController();
    deleteController.current = controller;
    setDeleteState('saving');
    setDeleteError('');
    try {
      const result = await api.post('/api/chat/usage/session/delete', {
        conversationId: target.key, sessionId: target.sessionId, revision: target.revision,
      }, controller.signal);
      if (!isRecord(result) || result.ok !== true || !Number.isSafeInteger(result.affected)
        || typeof result.affected !== 'number' || result.affected < 0
        || typeof result.operationId !== 'string' || result.operationId.length === 0
        || result.conversationId !== undefined && result.conversationId !== target.key
        || result.sessionId !== undefined && result.sessionId !== target.sessionId) {
        throw new ApiError('usage_session_delete_unknown', 504);
      }
      if (controller.signal.aborted) return;
      setDeleteTarget(null);
      setDeleteState('idle');
      if (selectedKeyRef.current === ledgerIdentity(target)) {
        selectedKeyRef.current = '';
        setSelectedKey('');
      }
      setTurns(null);
      setTurnsError('');
      setTurnsLoading(false);
      lifecycleEpoch.current += 1;
      refreshInFlight.current = null;
      summaryController.current?.abort();
      seriesController.current?.abort();
      turnsController.current?.abort();
      recentController.current?.abort();
      await runRefresh('manual');
      if (controller.signal.aborted) return;
      setRefreshMessage(`已删除该模型会话的 ${formatCount(result.affected)} 条账本记录。`);
    } catch (error) {
      if (controller.signal.aborted) return;
      setDeleteState(resetErrorState(error));
      setDeleteError(errorMessage(error));
    } finally {
      ledgerWriteBusy.current = false;
      if (!controller.signal.aborted) setLedgerWriting(false);
    }
  }

  if (!connected) return <div className="page-stack gap-2" data-page="usage"><PageHeading title="用量与费用" description="查看聊天账本记录的 token 用量与费用估算。" /><ConnectPrompt connect={connect} /></div>;

  const automaticValue = autoRefreshMs === null ? 'off' : String(autoRefreshMs);
  const pricingUnavailable = usage?.unavailable.includes('pricing') ?? true;
  const ledgerUnavailable = usage?.unavailable.includes('ledger') ?? true;
  const registeredReferenceModel = usage?.nowTier && usage.priceTable
    ? Object.hasOwn(usage.priceTable.models, usage.nowTier.model)
    : false;
  const knownCosts = Object.entries(usage?.coverage?.knownCosts ?? {});
  const showKnownCosts = usage?.native === true && knownCosts.length > 0;
  const incompleteNativeTotals = usage?.native === true && usage.coverage !== undefined
    && (usage.coverage.partial || usage.coverage.incompleteTurns > 0 || usage.coverage.missingCostTurns > 0
      || Object.entries(usage.coverage.missingTokens).some(([key, count]) => key !== 'reasoning' && count > 0));
  const summaryCost = showKnownCosts
    ? knownCosts.map(([currency, amount]) => formatActivityCost(amount, currency, `${currency} `)).join(' · ')
    : usage ? formatActivityCost(usage.totals.cost, usage.currency, usage.symbol) : '未知';

  const summaryDetails = usage && <ReadOnlyDetails title="统计详情" label="统计说明">
            
            <div className="grid gap-3">
          <div id="token-breakdown" className="mt-2 border-t pt-2">
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 md:grid-cols-3 xl:grid-cols-6">{[
            { label: '输入', value: usage.totals.inputTokens, icon: ArrowUp }, { label: '输出', value: usage.totals.outputTokens, icon: ArrowDown },
            { label: '缓存命中', value: usage.totals.cacheHitTokens, icon: Database }, { label: '缓存未命中', value: usage.totals.cacheMissTokens, icon: Database },
            { label: '缓存写入', value: usage.totals.cacheWriteTokens, icon: Database }, { label: '推理', value: usage.totals.reasoningTokens, icon: BrainCircuit },
          ].map(item => <div key={item.label} className="flex items-center gap-2"><span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><item.icon className="size-3" aria-hidden="true" />{item.label}</span><strong className="text-sm font-medium tabular-nums">{formatCount(item.value)}</strong></div>)}</div>
          </div>

              <NativeCoverageSummary usage={usage} detailedCounts={detailedCounts} />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs md:grid-cols-4">
            <div><dt className="text-muted-foreground">平均每轮</dt><dd className="mt-1 font-medium tabular-nums">{usage.totals.avgCostPerTurn === null ? '不可用' : usage.totals.turns === 0 ? '暂无轮次' : formatActivityCost(usage.totals.avgCostPerTurn, usage.currency, usage.symbol)}</dd></div>
            <div><dt className="text-muted-foreground">平均每步</dt><dd className="mt-1 font-medium tabular-nums">{usage.totals.avgCostPerStep === null ? '不可用' : usage.totals.steps === 0 ? '暂无步骤' : formatActivityCost(usage.totals.avgCostPerStep, usage.currency, usage.symbol)}</dd></div>
            <div><dt className="text-muted-foreground">高峰 / 低谷</dt><dd className="mt-1 font-medium tabular-nums">{usage.totals.byTier === null ? '不可用' : `${formatActivityCost(usage.totals.byTier.peak, usage.currency, usage.symbol)} / ${formatActivityCost(usage.totals.byTier.off, usage.currency, usage.symbol)}`}</dd></div>
            <div><dt className="text-muted-foreground">未逐轮归属</dt><dd className="mt-1 font-medium tabular-nums">{formatActivityCost(usage.totals.unattributedCost, usage.currency, usage.symbol)}</dd></div>
          </dl>
            <div className="mt-3 border-t pt-3"><p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><Coins className="mt-0.5 size-3.5 shrink-0" />{usage.native ? "费用为提供方上报值或入账时单价的估算；币种分开记录，旧轮次不随当前价格变化。" : "累计费用依据当前账本价目表与 token 记录估算，不能替代模型平台账单。"}</p>{usage.ledger ? <dl className="mt-3 grid grid-cols-2 gap-3 text-xs md:grid-cols-4"><div><dt className="text-muted-foreground">账本行数</dt><dd className="mt-1 font-medium tabular-nums">{formatCount(usage.ledger.journalLines)} / {formatCount(usage.ledger.maxLines)}</dd></div><div><dt className="text-muted-foreground">会话 / 基线 / 采样</dt><dd className="mt-1 font-medium tabular-nums">{formatCount(usage.ledger.sessions)} / {formatCount(usage.ledger.baselines)} / {formatCount(usage.ledger.samples)}</dd></div><div><dt className="text-muted-foreground">已淘汰行</dt><dd className="mt-1 font-medium tabular-nums">{formatCount(usage.ledger.droppedLines)}</dd></div><div><dt className="text-muted-foreground">最近写入 / 压缩</dt><dd className="mt-1 font-medium">{usage.ledger.lastIngestAt === 0 ? '未记录' : formatTimestamp(usage.ledger.lastIngestAt)} / {usage.ledger.lastCompactedAt === 0 ? '未记录' : formatTimestamp(usage.ledger.lastCompactedAt)}</dd></div></dl> : ledgerUnavailable && <div className="mt-3"><BlockUnavailable title="账本运行统计不可用" description={usage.native ? "原生账本只提供实际响应记录；未知的容量、压缩与淘汰指标不推测填充。已知记录数见汇总。" : "聊天宿主未提供账本运行统计；已有累计用量仍可查看。"} /></div>}</div>
            </div>
          </ReadOnlyDetails>;

  return <div className="page-stack gap-2" data-page="usage">
    <PageHeading title="用量与费用" description="查看当前账本、用量走势和入账费用。" />
    <div className="flex flex-wrap items-center gap-2"><span className="mr-1 text-xs text-muted-foreground">{usage ? `生成于 ${formatTimestamp(usage.generatedAt)}` : '正在读取账本'}</span><label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor="usage-detailed-counts"><Switch id="usage-detailed-counts" size="sm" checked={detailedCounts} onCheckedChange={setDetailedCounts} /><span>详细数值</span></label><label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground" htmlFor="usage-auto-refresh"><span>自动刷新</span><select id="usage-auto-refresh" className="h-[27px] rounded border bg-background px-2 text-xs text-foreground" value={automaticValue} onChange={event => setAutoRefreshMs(event.target.value === 'off' ? null : Number(event.target.value))} disabled={runtimeUnavailable}><option value="off">关闭</option><option value="3000">3 秒</option><option value="10000">10 秒</option><option value="30000">30 秒</option></select></label><Button id="usage-refresh" variant="outline" onClick={() => void runRefresh('manual')} disabled={summaryLoading || seriesLoading || recentLoading || ledgerWriting}><RefreshCw className={summaryLoading || seriesLoading || recentLoading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新</Button><UsagePricingManager {...props} onSaved={() => { void runRefresh("manual"); }} /><Button id="usage-reset-open" variant="outline" onClick={openReset} disabled={!usage?.revision || usage.resetAvailable === false || summaryLoading || deleteTarget !== null || ledgerWriting}><Trash2 className="size-3.5" />清空账本</Button></div>
    {refreshMessage && <p className="text-xs text-muted-foreground" role="status">{refreshMessage}</p>}

    {summaryLoading && !usage ? <Section id="usage-summary" title={usageSectionLabels.summary} className={compactSectionClass}><LoadingBlock>正在读取用量账本</LoadingBlock></Section>
      : summaryError && !usage ? <Section id="usage-unavailable" title="用量暂不可用" actions={<Button variant="outline" onClick={() => void runRefresh('manual')}>重试</Button>} className={compactSectionClass}><EmptyState locked title={runtimeUnavailable ? '尚未连接聊天服务' : '暂时无法显示账本'} description={summaryError} /></Section>
      : usage && <>
        <div id="usage-summary" className="grid gap-2">
          {summaryError && <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5" role="alert">刷新失败，继续显示上次数据：{summaryError}</p>}
          {(usage.coverage?.partial || usage.limited) && <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5" role="alert">{usage.coverage?.partial ? '扫描达到上限，当前统计仅为部分结果。' : '会话列表已截断，未显示全部会话。'}</p>}
          {incompleteNativeTotals && <p className="text-xs text-muted-foreground" role="status">显示已记录小计；缺失用量或费用未计入，详情中可查看缺失项。</p>}
          <div className="metrics">
            <MetricCard id="total-tokens" label={incompleteNativeTotals ? '已记录 Token' : '总 Token'} value={formatCount(usage.totals.totalTokens)} caption={<span className="flex flex-wrap gap-x-3 gap-y-1"><span className="inline-flex items-center gap-1"><ArrowUp className="size-3" aria-hidden="true" /><span title="各次模型请求的输入之和，不是当前上下文大小">累计输入 {formatCount(usage.totals.inputTokens)}</span></span><span className="inline-flex items-center gap-1"><ArrowDown className="size-3" aria-hidden="true" />{formatCount(usage.totals.outputTokens)}</span></span>} icon={Sigma} />
            <MetricCard id="estimated-cost" label={showKnownCosts ? '已记录费用' : '费用估算'} value={summaryCost} caption={showKnownCosts ? incompleteNativeTotals || usage.totals.cost === null ? '已知金额小计 · 非实际账单' : '含估算 · 非实际账单' : usage.native ? '非实际账单' : `按价目表估算 · ${usage.currency} · 非实际账单`} icon={Banknote} />
            <MetricCard id="conversations" label="会话 / 轮次" value={`${formatCount(usage.totals.conversations)} / ${formatCount(usage.totals.turns)}`} caption={`${formatCount(usage.totals.steps)} 个处理步骤`} icon={Waypoints} />
            <MetricCard id="cache-hit-rate" label="缓存命中率" value={usage.totals.cacheHitRate === null ? '不可用' : formatPercentage(usage.totals.cacheHitRate)} caption={`命中 ${formatCount(usage.totals.cacheHitTokens)} · 未命中 ${formatCount(usage.totals.cacheMissTokens)}`} icon={Database} />
          </div>

        </div>

        <div className="split">
        <Section id="usage-series" title={usageSectionLabels.chart} actions={<div className="flex flex-wrap justify-end gap-1.5"><select aria-label="走势时间范围" className="h-[27px] rounded border bg-background px-2 text-xs" value={rangeHours} onChange={event => selectRange(Number(event.target.value))}>{rangeOptions.map(option => <option key={option.hours} value={option.hours}>{option.label}</option>)}</select><select aria-label="走势纵轴" className="h-[27px] rounded border bg-background px-2 text-xs" value={chartMetric} onChange={event => setChartMetric(event.target.value === 'tokens' ? 'tokens' : 'cost')}><option value="cost">费用</option><option value="tokens">Token</option></select></div>} className={compactSectionClass}>
          {seriesLoading && !series ? <LoadingBlock>正在读取走势</LoadingBlock>
            : seriesError && !series ? <BlockUnavailable title="走势暂时不可用" description={seriesError} />
              : series && <div className="grid gap-3">{seriesError && <p className="text-xs text-amber-700 dark:text-amber-300" role="alert">走势刷新失败，继续显示上次数据：{seriesError}</p>}<div className="flex flex-wrap items-end justify-between gap-2"><div><span className="text-xs text-muted-foreground">窗口内合计</span><strong className="mt-0.5 block text-lg font-semibold tabular-nums">{chartMetric === 'cost' ? formatActivityCost(series.totals.cost, series.currency, series.symbol) : `${formatCount(series.totals.tokens)} token`}</strong>{series.native && <KnownCosts costs={series.knownCosts} />}</div><p className="text-xs text-muted-foreground">每桶 {formatCount(series.bucketMs / 60_000)} 分钟 · {formatCount(series.totals.turns)} 轮 · {formatCount(series.totals.steps)} 步</p></div><UsageChart series={series} metric={chartMetric} selectedIndex={selectedBucket} onSelect={setSelectedBucket} detailedCounts={detailedCounts} /><ReadOnlyDetails title="走势统计口径" label="统计口径"><div className="grid gap-2 border-t px-3 py-3 text-xs leading-5 text-muted-foreground"><p>{series.busiest ? `估算费用 ${formatActivityCost(series.busiest.cost, series.currency, series.symbol)}，${formatCount(series.busiest.tokens)} token。` : series.native ? '所选窗口没有可确认的最忙桶；未知数据未绘制为零。' : '所选窗口内没有产生正用量，纵轴保持真实 0 刻度。'}</p>{series.offChartCost !== null && series.offChartCost > 0 || series.offChartTokens !== null && series.offChartTokens > 0 ? <p>另有 {formatActivityCost(series.offChartCost, series.currency, series.symbol)}、约 {formatCount(series.offChartTokens)} token 属于图外累计历史；它们只有累计值，没有可画入时间桶的逐时明细。</p> : <p>{series.native && (series.offChartCost === null || series.offChartTokens === null) ? '图外累计历史包含未知用量或费用，不能确认其为零。' : '当前累计账本没有需要单列说明的图外历史。'}</p>}{series.countedSamples === 0 && <p>窗口内没有可追溯采样；这可能表示没有调用，也可能表示逐轮采样已被容量上限淘汰，不能据此推断累计总量为零。</p>}</div></ReadOnlyDetails></div>}
        </Section>
        <UsageModelCosts recent={recent} currency={usage.currency} loading={recentLoading} error={recentError} />
        </div>

        <Section title="账本明细" actions={summaryDetails} className="[&>.panel-body]:p-0">
        <Tabs value={usageView} onValueChange={value => setUsageView(String(value))} className="gap-2">
          <TabsList aria-label="用量记录视图" className="h-[34px] w-full justify-start bg-muted/30 px-2"><TabsTrigger value="conversations">按会话</TabsTrigger><TabsTrigger value="turns">逐轮明细</TabsTrigger><TabsTrigger value="recent">调用记录</TabsTrigger></TabsList>
          <TabsContent value="conversations" keepMounted className="[&[hidden]]:hidden">
        <Section id="conversation-usage" title={usageSectionLabels.conversations} description={`最多 ${formatCount(usage.limit)} 条；选择会话后加载逐轮明细。`} actions={usage.limited ? <StatusPill tone="warning">结果已截断</StatusPill> : <StatusPill tone="success">完整结果</StatusPill>} className={ledgerSectionClass}>
          {usage.conversations.length === 0 ? <EmptyState title="暂无用量记录" description="聊天账本已成功读取，但当前没有会话用量。" /> : <div data-usage-conversations-panel><div className="tablewrap min-h-0 overscroll-contain border-t" data-usage-conversations-scroll tabIndex={0} role="region" aria-label="会话用量列表"><table aria-rowcount={usage.conversations.length + 1} className="w-full min-w-[76rem] text-left text-[11px]"><thead className="sticky top-0 z-10 border-b bg-muted text-xs text-muted-foreground"><tr><th className="px-2 py-1 font-medium">会话</th><th className="px-2 py-1 text-right font-medium">轮 / 步</th><th className="px-2 py-1 text-right font-medium">未命中输入</th><th className="px-2 py-1 text-right font-medium">缓存命中</th><th className="px-2 py-1 text-right font-medium">缓存写入</th><th className="px-2 py-1 text-right font-medium">输出</th><th className="px-2 py-1 text-right font-medium">命中率</th><th className="px-2 py-1 text-right font-medium">费用估算</th><th className="min-w-36 px-2 py-1 text-right font-medium">成本占比</th><th className="px-2 py-1 font-medium">模型</th><th className="px-2 py-1 font-medium">最近记录</th><th className="px-2 py-1 font-medium">操作</th></tr></thead><VirtualTableBody items={usage.conversations} getItemKey={conversation => ledgerIdentity(conversation)} columns={12} estimateSize={30}>{conversation => {
            const identity = describeConversationKey(conversation.key);
            const buckets = conversation.buckets;
            const share = usage.totals.cost === null || conversation.cost === null ? null : usage.totals.cost > 0 ? conversation.cost / usage.totals.cost : 0;
            const shareLabel = formatPercentage(share);
            return <tr key={ledgerIdentity(conversation)} data-usage-key={conversation.key} data-usage-ledger-key={ledgerIdentity(conversation)} className={selectedKey === ledgerIdentity(conversation) ? 'bg-accent/45 align-top' : 'align-top hover:bg-muted/30'}><td className="px-2 py-1"><button type="button" className="text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-pressed={selectedKey === ledgerIdentity(conversation)} onClick={() => selectConversation(ledgerIdentity(conversation), true)}><UsageConversation conversationKey={conversation.key} sessionId={conversation.sessionId} /></button></td><td className="px-2 py-1 text-right tabular-nums">{formatCount(conversation.turns)} / {formatCount(conversation.steps)}</td><td className="px-2 py-1 text-right tabular-nums">{buckets ? formatCount(buckets.cacheMiss) : "不可用"}</td><td className="px-2 py-1 text-right tabular-nums">{buckets ? formatCount(buckets.cacheHit) : "不可用"}</td><td className="px-2 py-1 text-right tabular-nums">{buckets ? formatCount(buckets.cacheWrite) : "不可用"}</td><td className="px-2 py-1">{buckets ? <span className="block text-right tabular-nums">{formatCount(buckets.output)}</span> : <span className="block text-right text-muted-foreground">不可用</span>}</td><td className="px-2 py-1 text-right tabular-nums">{conversation.cacheHitRate === null ? '不可用' : formatPercentage(conversation.cacheHitRate)}</td><td className="px-2 py-1 text-right tabular-nums"><strong className="font-medium">{formatActivityCost(conversation.cost, usage.currency, usage.symbol)}</strong></td><td className="min-w-36 px-2 py-1"><span className="block text-right tabular-nums">{shareLabel}</span></td><td className="max-w-52 px-2 py-1"><span className="block max-w-40 truncate" title={conversation.models.join("、")}>{conversation.models.join("、") || "未记录"}</span></td><td className="whitespace-nowrap px-2 py-1 text-muted-foreground">{conversation.lastAt ? formatTimestamp(conversation.lastAt) : '未记录'}</td><td className="px-2 py-1"><div className="flex items-center gap-1"><ReadOnlyDetails title="会话用量详情" description={`${identity.label} ${identity.identifier}`}><UsageConversation conversationKey={conversation.key} sessionId={conversation.sessionId} showRun /><KnownCosts costs={conversation.knownCosts} />{buckets && <><UsageTokenBreakdown values={buckets} side="input" formatCount={formatCount} /><UsageTokenBreakdown values={buckets} side="output" formatCount={formatCount} /></>}<TechnicalDetails fields={[{ label: '完整汇总', value: conversation }]} /></ReadOnlyDetails>{usage.native && conversation.ledgerKey && conversation.sessionId && <span title={!conversation.revision ? '暂时无法核对该会话账本，请刷新后重试' : undefined}><Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" aria-label={`删除${identity.label} ${identity.identifier}${usageSessionSuffix(conversation.sessionId)}的账本`} title={!conversation.revision ? '暂时无法核对该会话账本，请刷新后重试' : undefined} disabled={!conversation.revision || ledgerWriting || resetOpen || deleteTarget !== null} onClick={() => openDelete(conversation)}><Trash2 className="size-3.5" />删除</Button></span>}</div></td></tr>;
          }}</VirtualTableBody></table></div></div>}
          {usage.limited && <p className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-400" role="status">结果达到接口上限；总计来自完整账本汇总，会话表仅显示本次返回的部分记录。</p>}
        </Section>

          </TabsContent>
          <TabsContent value="turns" keepMounted className="[&[hidden]]:hidden">
        <Section id="usage-turns" title={usageSectionLabels.turns} description="最多 200 轮；累计历史可能早于逐轮保留窗口。" actions={<div className="flex flex-wrap items-center justify-end gap-2"><select id="usage-key-select" className="h-8 max-w-64 rounded-lg border bg-background px-2 text-xs" value={selectedKey} onChange={event => selectConversation(event.target.value)} aria-label="选择逐轮明细会话">{selectableConversations.map(conversation => <option key={ledgerIdentity(conversation)} value={ledgerIdentity(conversation)} title={describeConversationKey(conversation.key).simulationRunId ? `模拟运行：${describeConversationKey(conversation.key).simulationRunId}` : undefined}>{describeConversationKey(conversation.key).label} · {describeConversationKey(conversation.key).identifier}{usageSessionSuffix(conversation.sessionId)}</option>)}</select><Button id="usage-turns-load" size="sm" variant="outline" disabled={!selectedKey || turnsLoading} onClick={() => void loadTurns(selectedKey)}>{turnsLoading && <LoaderCircle className="size-3.5 animate-spin" />}加载明细</Button></div>} className={ledgerSectionClass}>
          <div data-usage-turns-panel>
            
            <div className="pt-3" data-usage-turns-body>
          {!selectedKey ? <EmptyState title="选择一条会话" description="从会话汇总或下拉列表选择要查看的会话。" />
            : turnsLoading && !turns ? <LoadingBlock>正在读取逐轮明细</LoadingBlock>
              : turnsError ? <BlockUnavailable title="逐轮明细暂时不可用" description={turnsError} />
                : turns ? <div className="grid min-w-0 gap-3"><div className="flex max-h-24 shrink-0 flex-wrap gap-x-4 gap-y-1.5 overflow-auto text-xs text-muted-foreground"><span>会话：<strong className="text-foreground"><UsageConversation conversationKey={turns.key} sessionId={selectedConversation?.sessionId ?? (turns.sessionIds.length === 1 ? turns.sessionIds[0] : undefined)} showRun /></strong></span><span>{formatCount(turns.sessionCount)} 个技术会话</span><span>可追溯 {formatCount(turns.turns.length)} 轮</span><span>已归属 {formatActivityCost(turns.attributedCost, turns.currency, turns.symbol)}</span><span>未逐轮归属 {formatActivityCost(turns.unattributedCost, turns.currency, turns.symbol)}</span>{turns.byTier ? <span>峰 {formatActivityCost(turns.byTier.peak, turns.currency, turns.symbol)} · 闲 {formatActivityCost(turns.byTier.off, turns.currency, turns.symbol)}</span> : <span>固定单价 · 无峰谷价档</span>}<span>{turns.firstAt === 0 ? '起始未记录' : `始于 ${formatTimestamp(turns.firstAt)}`} · {turns.lastAt === 0 ? '末次未记录' : `末于 ${formatTimestamp(turns.lastAt)}`}</span>{turns.native && <span>时间为框架观察时刻；响应事件数不是重试次数。{turns.partial && "扫描结果不完整。"}</span>}<span>模型：{turns.models.length > 0 ? turns.models.join('、') : '未记录'}</span>{turns.limited && <StatusPill tone="warning">结果已截断</StatusPill>}</div>{turns.turns.length === 0 ? <EmptyState title="没有可追溯轮次" description="该会话只有累计值，逐轮采样可能已被容量上限淘汰。" /> : <div data-usage-turns-scroll tabIndex={0} role="region" aria-label="逐轮用量列表" className="tablewrap min-h-0 overscroll-contain rounded-lg border"><table aria-rowcount={turns.turns.length + 1} className="w-full min-w-[86rem] text-left text-[11px]"><thead className="sticky top-0 z-10 border-b bg-muted text-xs text-muted-foreground"><tr><th className="px-2 py-1 font-medium">起止时间</th><th className="px-2 py-1 text-right font-medium">轮</th><th className="px-2 py-1 text-right font-medium">{turns.native ? "步骤 / 响应事件" : "步骤 / 重试"}</th><th className="px-2 py-1 text-right font-medium">未命中输入</th><th className="px-2 py-1 text-right font-medium">缓存命中</th><th className="px-2 py-1 text-right font-medium">缓存写入</th><th className="px-2 py-1 text-right font-medium">输出</th><th className="px-2 py-1 text-right font-medium">命中率</th><th className="px-2 py-1 text-right font-medium">费用估算</th><th className="px-2 py-1 font-medium">时段</th><th className="px-2 py-1 font-medium">模型 / Provider</th><th className="px-2 py-1 font-medium">详情</th></tr></thead><VirtualTableBody items={turns.turns} getItemKey={turn => `${turn.sessionId}-${turn.generation ?? ""}-${turn.turnId ?? turn.turn}-${turn.endedAt}`} columns={12} estimateSize={30}>{(turn, index) => <tr key={`${turn.sessionId}-${turn.generation ?? ""}-${turn.turnId ?? turn.turn}-${turn.endedAt}`} data-usage-turn={index}><td className="whitespace-nowrap px-2 py-1"><span title={`${formatTimestamp(turn.startedAt)} — ${formatTimestamp(turn.endedAt)}`}>{new Date(turn.startedAt).toLocaleTimeString('zh-CN', { hour12: false })} — {new Date(turn.endedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span></td><td className="px-2 py-1 text-right tabular-nums">{turn.turnId ?? `#${formatCount(turn.turn)}`}</td><td className="px-2 py-1 text-right tabular-nums">{formatCount(turn.steps)} / {formatCount(turn.attempts)}</td><td className="px-2 py-1 text-right tabular-nums">{formatCount(turn.buckets.cacheMiss)}</td><td className="px-2 py-1 text-right tabular-nums">{formatCount(turn.buckets.cacheHit)}</td><td className="px-2 py-1 text-right tabular-nums">{formatCount(turn.buckets.cacheWrite)}</td><td className="px-2 py-1"><span className="block text-right tabular-nums">{formatCount(turn.buckets.output)}</span></td><td className="px-2 py-1 text-right tabular-nums">{formatPercentage(cacheHitRate(turn.buckets))}</td><td className="px-2 py-1 text-right tabular-nums">{formatActivityCost(turn.cost, turns.currency, turns.symbol)}{turn.cost === null && <KnownCosts costs={turn.knownCosts} />}{turn.costRecovery && <span className="block text-xs text-muted-foreground">{turn.costRecovery === "historical-reference" ? "含历史参考估价" : "含原快照补估"}</span>}{turn.coverage && turn.coverage !== "complete" && <span className="block text-xs text-muted-foreground">覆盖不完整</span>}</td><td className="px-2 py-1"><TierBadge tier={turn.tier} /></td><td className="px-2 py-1"><span className="block max-w-52 truncate" title={`${turn.model ?? '未记录'} / ${turn.provider ?? 'Provider 未记录'}`}>{turn.model ?? '未记录'}</span></td><td className="px-2 py-1"><ReadOnlyDetails title="逐轮用量详情"><UsageConversation conversationKey={turns.key} sessionId={turn.sessionId} showRun /><UsageTokenBreakdown values={turn.buckets} side="input" formatCount={formatCount} /><UsageTokenBreakdown values={turn.buckets} side="output" formatCount={formatCount} /><TechnicalDetails fields={[{ label: "完整记录", value: turn }]} /></ReadOnlyDetails></td></tr>}</VirtualTableBody></table></div>}</div>
                  : <EmptyState title="尚未加载逐轮明细" description={selectedConversation ? `已选择${describeConversationKey(selectedConversation.key).label} ${describeConversationKey(selectedConversation.key).identifier}${usageSessionSuffix(selectedConversation.sessionId)}，点击“加载明细”读取。` : '点击会话汇总中的一行，或使用上方下拉列表选择会话。'} />}
            </div>
          </div>
        </Section>

          </TabsContent>
          <TabsContent value="recent" keepMounted className="[&[hidden]]:hidden">
        <Section id="usage-recent" title={usageSectionLabels.recent} description="最近 40 条计费采样，包含步骤和重试轴。" className={ledgerSectionClass}>
          <div data-usage-recent-panel>
            
            <div className="pt-3" data-usage-recent-body>
          {recentLoading && !recent ? <LoadingBlock>正在读取最近调用</LoadingBlock>
            : recentError && !recent ? <BlockUnavailable title="最近调用暂时不可用" description={recentError} />
              : recent && <div className="grid min-w-0 gap-3">{recentError && <p className="text-xs text-amber-700 dark:text-amber-300" role="alert">最近调用刷新失败，继续显示上次数据：{recentError}</p>}{recent.entries.length === 0 ? <EmptyState title="暂无最近调用" description="账本返回空流水；这不代表累计用量为零。" /> : <div data-usage-recent-scroll className="tablewrap min-h-0 overscroll-contain rounded-lg border"><table className="w-full min-w-[82rem] text-left text-[11px]"><thead className="sticky top-0 z-10 border-b bg-muted text-xs text-muted-foreground"><tr><th className="px-2 py-1 font-medium">时间</th><th className="px-2 py-1 font-medium">会话</th><th className="px-2 py-1 text-right font-medium">{recent.native ? "轮标识 / 步 / 重试（未知）" : "轮 / 步 / 重试"}</th><th className="px-2 py-1 text-right font-medium">未命中输入</th><th className="px-2 py-1 text-right font-medium">缓存命中</th><th className="px-2 py-1 text-right font-medium">缓存写入</th><th className="px-2 py-1 text-right font-medium">输出</th><th className="px-2 py-1 text-right font-medium">Token</th><th className="px-2 py-1 text-right font-medium">费用估算</th><th className="px-2 py-1 font-medium">时段</th><th className="px-2 py-1 font-medium">模型</th><th className="px-2 py-1 font-medium">详情</th></tr></thead><tbody className="divide-y">{recent.entries.map((entry, index) => <tr key={entry.id ?? `${entry.sid}-${entry.turn}-${entry.step}-${entry.retry}-${entry.time}`} data-usage-recent={index}><td className="whitespace-nowrap px-2 py-1">{formatTimestamp(entry.time)}</td><td className="px-2 py-1"><UsageConversation conversationKey={entry.key} sessionId={entry.sid} /></td><td className="px-2 py-1 text-right tabular-nums">{entry.turnId ?? formatCount(entry.turn)} / {formatCount(entry.step)} / {formatCount(entry.retry)}</td><td className="px-2 py-1 text-right tabular-nums">{formatCount(entry.cacheMiss)}</td><td className="px-2 py-1 text-right tabular-nums">{formatCount(entry.cacheHit)}</td><td className="px-2 py-1 text-right tabular-nums">{formatCount(entry.cacheWrite)}</td><td className="px-2 py-1"><span className="block text-right tabular-nums">{formatCount(entry.output)}</span></td><td className="px-2 py-1 text-right tabular-nums">{formatCount(entry.tokens)}</td><td className="px-2 py-1 text-right tabular-nums" title={entry.costRecovery === "historical-reference" ? "按记录时段的内置参考价补估，非实际账单" : entry.costRecovery === "price-snapshot" ? "按原入账价格快照补估缺失费用" : entry.knownCost?.source === "reported" ? "提供方上报费用" : entry.knownCost?.source === "operator-price-estimate" ? "按入账时保存的单价计算，旧记录不回算" : undefined}>{entry.knownCost ? formatActivityCost(entry.knownCost.amount, entry.knownCost.currency, `${entry.knownCost.currency} `) : formatActivityCost(entry.cost, usage.currency, recent.symbol)}{entry.costRecovery && <span className="block text-xs text-muted-foreground">{entry.costRecovery === "historical-reference" ? "历史参考估价" : "原快照补估"}</span>}</td><td className="px-2 py-1"><TierBadge tier={entry.tier} /></td><td className="px-2 py-1">{entry.model ?? '未记录'}</td><td className="px-2 py-1"><ReadOnlyDetails title="调用用量详情"><UsageConversation conversationKey={entry.key} sessionId={entry.sid} showRun /><UsageTokenBreakdown values={entry} side="input" formatCount={formatCount} /><UsageTokenBreakdown values={entry} side="output" formatCount={formatCount} /><TechnicalDetails fields={[{ label: "完整记录", value: entry }]} /></ReadOnlyDetails></td></tr>)}</tbody></table></div>}</div>}
            </div>
          </div>
        </Section>

          </TabsContent>
        </Tabs>
        </Section>

        {!usage.native && <div id="usage-prices" className="flex flex-wrap items-center gap-2">
          {pricingUnavailable || !hasAvailablePricing(usage) ? <BlockUnavailable title="价目表信息不可用" description={usage.native ? "规则为空或包含多个币种，不能合成单一币种价目摘要；下方原生单价编辑器完整列出所有规则，历史金额仍按币种记录。" : "聊天宿主未提供完整价目表；已有 token 与费用汇总仍可查看。"} /> : <ReadOnlyDetails title="模型价目明细" label="查看价目表"><div className="max-h-96 min-h-0 overflow-auto overscroll-contain border-t" data-usage-prices-scroll tabIndex={0} role="region" aria-label="模型价目列表"><div className="grid gap-3 p-3"><dl className="grid grid-cols-2 gap-3 text-xs lg:grid-cols-4"><div><dt className="text-muted-foreground">版本</dt><dd className="mt-1 break-all font-medium">{usage.priceTable.version}</dd></div><div><dt className="text-muted-foreground">计价单位</dt><dd className="mt-1 font-medium">每 {formatCount(usage.priceTable.unit)} token · {usage.priceTable.currency}</dd></div><div><dt className="text-muted-foreground">{usage.native ? "计价方式" : "高峰倍率"}</dt><dd className="mt-1 font-medium tabular-nums">{usage.native ? "固定单价" : `× ${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(usage.priceTable.peakMultiplier)}`}</dd></div><div><dt className="text-muted-foreground">{usage.native ? "目录示例规则" : "当前参考价档"}</dt><dd className="mt-1 font-medium">{usage.nowTier.tierLabel}</dd><span className="mt-1 block text-xs text-muted-foreground">{usage.nowTier.label} ({usage.nowTier.model})</span></div></dl>{usage.native ? <p className="text-xs leading-5 text-muted-foreground">原生账本使用固定单价，不适用峰谷时段。这里只展示当前目录；历史费用保留各轮入账时的价格快照。</p> : <p className="text-xs leading-5 text-muted-foreground">北京时间高峰窗口：{usage.priceTable.peakWindows.length === 0 ? '未配置' : usage.priceTable.peakWindows.map(window => `${formatUsageWindowEndpoint(window[0])}–${formatUsageWindowEndpoint(window[1])}`).join('、')}；生效星期：{usage.priceTable.peakWeekdays.length === 0 ? '未配置' : usage.priceTable.peakWeekdays.map(day => `周${'一二三四五六日'[day - 1]}`).join('、')}；账本内置节假日 {formatCount(usage.priceTable.holidayCount)} 天。高峰单价按空闲单价乘以配置倍率。</p>}{!usage.native && usage.nowTier.estimated && <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5">当前参考价档被账本标记为估算。{registeredReferenceModel ? '默认参考模型已登记在下表；该标记不代表模型缺失。' : '默认参考模型未登记在当前价目表中，账本使用了配置的兜底价。'}</p>}<div className="rounded-lg border"><table aria-rowcount={Object.keys(usage.priceTable.models).length + 1} className="w-full min-w-[44rem] text-left text-[11px]"><thead className="sticky top-0 z-10 border-b bg-muted text-xs text-muted-foreground"><tr><th className="px-2 py-1 font-medium">模型</th><th className="px-2 py-1 text-right font-medium">缓存命中</th><th className="px-2 py-1 text-right font-medium">缓存未命中</th><th className="px-2 py-1 text-right font-medium">缓存写入</th><th className="px-2 py-1 text-right font-medium">输出</th></tr></thead><VirtualTableBody items={Object.entries(usage.priceTable.models)} getItemKey={([name]) => name} columns={5} estimateSize={64}>{([name, model]) => <tr key={name}><td className="px-2 py-1"><code className="break-all">{name}</code><span className="mt-1 block text-xs text-muted-foreground">{model.label}</span></td><td className="px-2 py-1 text-right tabular-nums">{formatActivityCost(model.off.cacheHit, usage.priceTable.currency, usage.priceTable.symbol)}</td><td className="px-2 py-1 text-right tabular-nums">{formatActivityCost(model.off.cacheMiss, usage.priceTable.currency, usage.priceTable.symbol)}</td><td className="px-2 py-1 text-right tabular-nums">{formatActivityCost(model.off.cacheWrite, usage.priceTable.currency, usage.priceTable.symbol)}</td><td className="px-2 py-1 text-right tabular-nums">{formatActivityCost(model.off.output, usage.priceTable.currency, usage.priceTable.symbol)}</td></tr>}</VirtualTableBody></table></div><p className="text-xs leading-5 text-muted-foreground">{usage.native ? "表中为固定单价，仅影响新入账记录；不同币种的规则可在下方单价编辑器分别配置。" : "表中为空闲时段单价；高峰按配置倍率计算。所有金额均为估算。"}</p></div></div></ReadOnlyDetails>}
        </div>

        }

      </>}

    <Dialog open={deleteTarget !== null} onOpenChange={open => { if (!open) closeDelete(); }}>
      <DialogContent showCloseButton={deleteState !== 'saving'}>
        <DialogHeader><DialogTitle>删除该模型会话的账本？</DialogTitle><DialogDescription>删除下列模型会话已记录的用量与费用，无法撤销。会话历史、当前绑定与其他模型会话的账本保留；之后新产生的用量继续记录。</DialogDescription></DialogHeader>
        {deleteTarget && <dl className="grid gap-3 text-sm"><div><dt className="text-xs text-muted-foreground">QQ 会话</dt><dd className="mt-1"><UsageConversation conversationKey={deleteTarget.key} sessionId={deleteTarget.sessionId} showRun /></dd></div><div><dt className="text-xs text-muted-foreground">完整模型会话 ID</dt><dd className="mt-1 break-all font-mono text-xs">{deleteTarget.sessionId}</dd></div><div><dt className="text-xs text-muted-foreground">已记录用量</dt><dd className="mt-1">{formatCount(deleteTarget.turns)} 轮 · {formatCount(deleteTarget.steps)} 个处理步骤</dd></div></dl>}
        {deleteState !== 'idle' && deleteState !== 'saving' && <p className="text-xs leading-5 text-destructive" role="alert">{deleteState === 'conflict' ? '该模型会话的账本已变化。请关闭并刷新，核对最新记录后重新选择。' : deleteState === 'unknown' ? '删除结果暂时无法确认，可能已删除部分记录。请勿重复提交；关闭弹窗并刷新，核对实际剩余账本。' : deleteError}</p>}
        <DialogFooter><Button variant="outline" disabled={deleteState === 'saving'} onClick={closeDelete}>{deleteState === 'conflict' || deleteState === 'unknown' ? '关闭并刷新核对' : '取消'}</Button><Button id="usage-session-delete-submit" variant="destructive" disabled={!deleteTarget?.revision || deleteState === 'saving' || deleteState === 'conflict' || deleteState === 'unknown' || resetState === 'saving'} onClick={() => void deleteSessionLedger()}>{deleteState === 'saving' && <LoaderCircle className="size-3.5 animate-spin" />}{deleteState === 'saving' ? '正在删除' : '确认删除账本'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={resetOpen} onOpenChange={open => { if (!open) closeReset(); }}>
      <DialogContent showCloseButton={resetState !== 'saving' && resetState !== 'conflict' && resetState !== 'unknown'}>
        <DialogHeader><DialogTitle>确认清空用量账本？</DialogTitle><DialogDescription>将清空全部用量与费用记录，包括结果未知的统计记录，此操作无法撤销。</DialogDescription></DialogHeader>
        <div className="grid gap-4"><div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs leading-5"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" /><span>清空全部用量与费用统计。会话历史、独立执行证据、单价设置和防重放记录保留。清空后新产生的用量会继续入账。</span></div><label className="grid gap-2"><span className="field-label">输入“{resetConfirmation}”以确认</span><Input id="usage-reset-confirm" autoFocus autoComplete="off" value={resetText} onChange={event => { setResetText(event.target.value); if (resetState === 'error') setResetState('idle'); }} disabled={resetState === 'saving' || resetState === 'conflict' || resetState === 'unknown'} /></label>{resetState !== 'idle' && resetState !== 'saving' && <p className="text-xs leading-5 text-destructive" role="alert">{resetStateMessage(resetState, resetError)}</p>}</div>
        <DialogFooter>{resetState !== 'conflict' && resetState !== 'unknown' && <Button variant="outline" onClick={closeReset} disabled={resetState === 'saving'}>取消</Button>}{(resetState === 'conflict' || resetState === 'unknown') && <Button variant="outline" onClick={closeReset}>关闭并刷新核对</Button>}<Button id="usage-reset-submit" variant="destructive" disabled={!resetRevision || resetText !== resetConfirmation || resetState === 'saving' || resetState === 'conflict' || resetState === 'unknown'} onClick={() => void resetLedger()}>{resetState === 'saving' && <LoaderCircle className="size-3.5 animate-spin" />}{resetState === 'saving' ? '正在提交' : '确认清空'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
