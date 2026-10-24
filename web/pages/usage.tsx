import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Banknote, BrainCircuit, ChevronDown, Coins, Database, LoaderCircle, RefreshCw, Sigma, Trash2, Waypoints } from 'lucide-react';

import { ConnectPrompt, EmptyState, PageHeading, Section, StatusPill } from '../components/management.tsx';
import { VirtualTableBody } from '../components/virtual-list.tsx';
import { UsageChart } from '../components/usage-chart.tsx';
import { UsageTokenBreakdown } from '../components/usage-token-breakdown.tsx';
import { UsagePricingManager } from '../components/usage-pricing-manager.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx';
import { Input } from '../components/ui/input.tsx';
import { Progress } from '../components/ui/progress.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { ApiError, errorMessage } from '../lib/api.ts';
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
const compactSectionClass = 'rounded-xl [&>.panel-header]:gap-3 [&>.panel-header]:px-4 [&>.panel-header]:pt-4 [&>.panel-body]:p-4';

type ResetState = 'idle' | 'saving' | 'conflict' | 'unknown' | 'error';
type RefreshReason = 'initial' | 'manual' | 'automatic';

function formatTimestamp(value: string | number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(new Date(value));
}

function formatPercentage(value: number | null): string {
  if (value === null) return '未知';
  return new Intl.NumberFormat('zh-CN', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

function clampPercentage(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
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
  return '空闲';
}

function TierBadge({ tier }: { readonly tier: AggregateUsageTier }) {
  const className = tier === 'peak'
    ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    : tier === 'mixed'
      ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
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
  return <div data-usage-metric={id} className="min-w-0 rounded-lg border p-3"><div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground"><span>{label}</span><Icon className="size-3.5 shrink-0" /></div><strong className="mt-2 block break-words text-lg font-semibold tabular-nums">{value}</strong><p className="mt-1 text-[11px] leading-4 text-muted-foreground">{caption}</p></div>;
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
  return entries.length === 0 ? null : <span className="block text-[11px] text-muted-foreground" data-usage-known-costs>已记录：{entries.map(([currency, amount]) => formatActivityCost(amount, currency, `${currency} `)).join(' · ')}（分币种，不合并）</span>;
}

function NativeCoverageSummary({ usage, detailedCounts }: { readonly usage: UsageSnapshot; readonly detailedCounts: boolean }) {
  const coverage = usage.coverage;
  if (!coverage) return null;
  const labels: Readonly<Record<string, string>> = { input: '未命中输入', output: '输出', cacheRead: '缓存读取', cacheWrite: '缓存写入', total: '总量', reasoning: '推理' };
  return <div className="mb-3 grid gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-5" data-native-usage-coverage>
    <p>{coverage.records === 0 ? '尚无原生用量记录；没有上报不等于零 Token 或零费用。' : `${coverage.records} 条响应记录，${coverage.incompleteTurns} 轮覆盖不完整，${coverage.missingCostTurns} 条费用未知。`}{coverage.partial && '扫描达到边界，当前汇总仅为部分结果。'}未知计数和金额保持“未知”，不以零填充。</p>
    <KnownCosts costs={coverage.knownCosts} />
    {coverage.records > 0 && <details><summary className="cursor-pointer font-medium">已知 Token 小计与缺失情况</summary><div className="mt-2 max-h-32 overflow-auto overscroll-contain">{Object.entries(labels).map(([key, label]) => <p key={key}>{label}：{coverage.knownTokens[key] === undefined || coverage.knownTokens[key] === 0 && (coverage.missingTokens[key] ?? 0) > 0 ? '未知' : formatUsageCount(coverage.knownTokens[key], detailedCounts)}；缺失 {coverage.missingTokens[key] ?? '未知'} 条</p>)}</div></details>}
    <p className="text-muted-foreground">仅统计框架已观察到的终态响应；中断前未收到的用量不会推测补齐。历史费用保留入账快照，修改单价不回算旧轮次。</p>
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
  const [turnsOpen, setTurnsOpen] = useState(false);
  const [autoRefreshMs, setAutoRefreshMs] = useState<number | null>(10_000);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');
  const [resetState, setResetState] = useState<ResetState>('idle');
  const [resetError, setResetError] = useState('');
  const [resetRevision, setResetRevision] = useState<string | null>(null);
  const summaryController = useRef<AbortController | null>(null);
  const seriesController = useRef<AbortController | null>(null);
  const turnsController = useRef<AbortController | null>(null);
  const recentController = useRef<AbortController | null>(null);
  const resetController = useRef<AbortController | null>(null);
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
      setRuntimeUnavailable(false);
      setSummaryError('');
      if (!selectedKeyRef.current && parsed.conversations[0]) {
        selectedKeyRef.current = parsed.conversations[0].key;
        setSelectedKey(parsed.conversations[0].key);
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
    turnsController.current?.abort();
    const controller = new AbortController();
    const request = turnsRequest.current + 1;
    turnsController.current = controller;
    turnsRequest.current = request;
    setTurnsLoading(true);
    setTurnsError('');
    try {
      const parsed = parseUsageConversation(await api.get(`/api/chat/usage/turns?key=${encodeURIComponent(key)}&limit=200`, controller.signal), key);
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
    };
  }, [connected, runRefresh]);

  useEffect(() => {
    if (!connected || runtimeUnavailable || autoRefreshMs === null) return;
    const refreshVisiblePage = (): void => {
      if (document.visibilityState === 'visible') void runRefresh('automatic');
    };
    const timer = window.setInterval(refreshVisiblePage, autoRefreshMs);
    document.addEventListener('visibilitychange', refreshVisiblePage);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisiblePage);
    };
  }, [autoRefreshMs, connected, runRefresh, runtimeUnavailable]);

  const selectedConversation = useMemo(
    () => usage?.conversations.find(conversation => conversation.key === selectedKey) ?? null,
    [selectedKey, usage]
  );
  const selectableConversations = useMemo(() => {
    if (!usage || !selectedKey || usage.conversations.some(conversation => conversation.key === selectedKey)) return usage?.conversations ?? [];
    return [{ key: selectedKey, sessionCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0,
      cacheHitTokens: 0, cost: 0, estimated: false, turns: 0, steps: 0, lastAt: null, models: [],
      buckets: null, attributedCost: null, unattributedCost: null, byTier: null, cacheHitRate: null, firstAt: null },
    ...usage.conversations];
  }, [selectedKey, usage]);

  function selectRange(hours: number): void {
    rangeHoursRef.current = hours;
    setRangeHours(hours);
    setSelectedBucket(null);
    void loadSeries(hours);
  }

  function selectConversation(key: string, expandTurns = false): void {
    if (expandTurns) setTurnsOpen(true);
    selectedKeyRef.current = key;
    setSelectedKey(key);
    setTurns(null);
    void loadTurns(key);
  }

  function openReset(): void {
    if (usage?.resetAvailable === false) return;
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
    if (!resetRevision || resetText !== resetConfirmation || resetState !== 'idle' && resetState !== 'error') return;
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
      setRefreshMessage('账本清空请求已受理并刷新，请核对当前统计。');
    } catch (error) {
      if (controller.signal.aborted) return;
      setResetState(resetErrorState(error));
      setResetError(errorMessage(error));
    }
  }

  if (!connected) return <div className="page-stack gap-4" data-page="usage"><PageHeading title="用量与费用" description="查看聊天账本记录的 token 用量与费用估算。" /><ConnectPrompt connect={connect} /></div>;

  const automaticValue = autoRefreshMs === null ? 'off' : String(autoRefreshMs);
  const pricingUnavailable = usage?.unavailable.includes('pricing') ?? true;
  const ledgerUnavailable = usage?.unavailable.includes('ledger') ?? true;
  const registeredReferenceModel = usage?.nowTier && usage.priceTable
    ? Object.hasOwn(usage.priceTable.models, usage.nowTier.model)
    : false;

  return <div className="page-stack gap-4" data-page="usage">
    <PageHeading title="用量与费用" description="展示当前聊天账本；费用按有效价目表估算，不是模型平台实际账单。" actions={<div className="flex flex-wrap items-center justify-end gap-2"><label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor="usage-detailed-counts"><Switch id="usage-detailed-counts" size="sm" checked={detailedCounts} onCheckedChange={setDetailedCounts} /><span>详细数值</span></label><label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor="usage-auto-refresh"><span>自动刷新</span><select id="usage-auto-refresh" className="h-8 rounded-lg border bg-background px-2 text-xs text-foreground" value={automaticValue} onChange={event => setAutoRefreshMs(event.target.value === 'off' ? null : Number(event.target.value))} disabled={runtimeUnavailable}><option value="off">关闭</option><option value="3000">3 秒</option><option value="10000">10 秒</option><option value="30000">30 秒</option></select></label><Button id="usage-refresh" variant="outline" onClick={() => void runRefresh('manual')} disabled={summaryLoading || seriesLoading || recentLoading}><RefreshCw className={summaryLoading || seriesLoading || recentLoading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新</Button></div>} />
    {refreshMessage && <p className="text-xs text-muted-foreground" role="status">{refreshMessage}</p>}

    {summaryLoading && !usage ? <Section id="usage-summary" title={usageSectionLabels.summary} className={compactSectionClass}><LoadingBlock>正在读取用量账本</LoadingBlock></Section>
      : summaryError && !usage ? <Section id="usage-unavailable" title="用量暂不可用" description={summaryError} actions={<Button variant="outline" onClick={() => void runRefresh('manual')}>重试</Button>} className={compactSectionClass}><EmptyState locked title="账本数据源尚不可用" description="请先接入聊天宿主与账本数据源；不可用不代表用量为零。" /></Section>
      : usage && <>
        <Section id="usage-summary" title={usageSectionLabels.summary} description={`生成于 ${formatTimestamp(usage.generatedAt)}`} actions={<StatusPill tone={usage.totals.estimated ? 'warning' : 'neutral'}>{usage.native ? '原生响应记录' : usage.totals.estimated ? '含估算价档' : '价目表估算'}</StatusPill>} className={compactSectionClass}>
          {summaryError && <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5" role="alert">刷新失败，继续显示上次数据：{summaryError}</p>}
          <NativeCoverageSummary usage={usage} detailedCounts={detailedCounts} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard id="total-tokens" label="总 Token" value={formatCount(usage.totals.totalTokens)} caption={<span className="flex flex-wrap gap-x-3 gap-y-1"><span className="inline-flex items-center gap-1"><ArrowUp className="size-3" aria-hidden="true" />{formatCount(usage.totals.inputTokens)}</span><span className="inline-flex items-center gap-1"><ArrowDown className="size-3" aria-hidden="true" />{formatCount(usage.totals.outputTokens)}</span></span>} icon={Sigma} />
            <MetricCard id="estimated-cost" label="费用估算" value={formatActivityCost(usage.totals.cost, usage.currency, usage.symbol)} caption={usage.native ? "提供方上报或入账单价快照估算；未知与多币种不合并" : `按价目表估算 · ${usage.currency} · 非实际账单`} icon={Banknote} />
            <MetricCard id="conversations" label="会话 / 轮次" value={`${formatCount(usage.totals.conversations)} / ${formatCount(usage.totals.turns)}`} caption={`${formatCount(usage.totals.steps)} 个处理步骤`} icon={Waypoints} />
            <MetricCard id="cache-hit-rate" label="缓存命中率" value={usage.totals.cacheHitRate === null ? '不可用' : formatPercentage(usage.totals.cacheHitRate)} caption={`命中 ${formatCount(usage.totals.cacheHitTokens)} · 未命中 ${formatCount(usage.totals.cacheMissTokens)}`} icon={Database} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 text-xs md:grid-cols-4">
            <div><dt className="text-muted-foreground">平均每轮</dt><dd className="mt-1 font-medium tabular-nums">{usage.totals.avgCostPerTurn === null ? '不可用' : usage.totals.turns === 0 ? '暂无轮次' : formatActivityCost(usage.totals.avgCostPerTurn, usage.currency, usage.symbol)}</dd></div>
            <div><dt className="text-muted-foreground">平均每步</dt><dd className="mt-1 font-medium tabular-nums">{usage.totals.avgCostPerStep === null ? '不可用' : usage.totals.steps === 0 ? '暂无步骤' : formatActivityCost(usage.totals.avgCostPerStep, usage.currency, usage.symbol)}</dd></div>
            <div><dt className="text-muted-foreground">高峰 / 空闲</dt><dd className="mt-1 font-medium tabular-nums">{usage.totals.byTier === null ? '不可用' : `${formatActivityCost(usage.totals.byTier.peak, usage.currency, usage.symbol)} / ${formatActivityCost(usage.totals.byTier.off, usage.currency, usage.symbol)}`}</dd></div>
            <div><dt className="text-muted-foreground">未逐轮归属</dt><dd className="mt-1 font-medium tabular-nums">{formatActivityCost(usage.totals.unattributedCost, usage.currency, usage.symbol)}</dd></div>
          </dl>
          <details className="group/summary mt-3 rounded-lg border bg-muted/15">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"><span>计费口径与账本状态</span><ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open/summary:rotate-180" aria-hidden="true" /></summary>
            <div className="border-t px-3 py-3"><p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><Coins className="mt-0.5 size-3.5 shrink-0" />{usage.native ? "费用为提供方上报值或入账时固定单价的估算；币种分开记录，旧轮次不随当前价格变化。" : "累计费用依据当前账本价目表与 token 记录估算，不能替代模型平台账单。"}</p>{usage.ledger ? <dl className="mt-3 grid grid-cols-2 gap-3 text-xs md:grid-cols-4"><div><dt className="text-muted-foreground">账本行数</dt><dd className="mt-1 font-medium tabular-nums">{formatCount(usage.ledger.journalLines)} / {formatCount(usage.ledger.maxLines)}</dd></div><div><dt className="text-muted-foreground">会话 / 基线 / 采样</dt><dd className="mt-1 font-medium tabular-nums">{formatCount(usage.ledger.sessions)} / {formatCount(usage.ledger.baselines)} / {formatCount(usage.ledger.samples)}</dd></div><div><dt className="text-muted-foreground">已淘汰行</dt><dd className="mt-1 font-medium tabular-nums">{formatCount(usage.ledger.droppedLines)}</dd></div><div><dt className="text-muted-foreground">最近写入 / 压缩</dt><dd className="mt-1 font-medium">{usage.ledger.lastIngestAt === 0 ? '未记录' : formatTimestamp(usage.ledger.lastIngestAt)} / {usage.ledger.lastCompactedAt === 0 ? '未记录' : formatTimestamp(usage.ledger.lastCompactedAt)}</dd></div></dl> : ledgerUnavailable && <div className="mt-3"><BlockUnavailable title="账本运行统计不可用" description={usage.native ? "原生账本只提供实际响应记录；未知的容量、压缩与淘汰指标不推测填充。已知记录数见汇总。" : "聊天宿主未提供账本运行统计；已有累计用量仍可查看。"} /></div>}</div>
          </details>
        </Section>

        <Section id="token-breakdown" title={usageSectionLabels.breakdown} description="累计分类；推理 token 单列，不额外计入总量。" className={compactSectionClass}>
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 md:grid-cols-3 xl:grid-cols-6">{[
            { label: '输入', value: usage.totals.inputTokens, icon: ArrowUp }, { label: '输出', value: usage.totals.outputTokens, icon: ArrowDown },
            { label: '缓存命中', value: usage.totals.cacheHitTokens, icon: Database }, { label: '缓存未命中', value: usage.totals.cacheMissTokens, icon: Database },
            { label: '缓存写入', value: usage.totals.cacheWriteTokens, icon: Database }, { label: '推理', value: usage.totals.reasoningTokens, icon: BrainCircuit },
          ].map(item => <div key={item.label}><span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><item.icon className="size-3" aria-hidden="true" />{item.label}</span><strong className="mt-1 block text-sm font-medium tabular-nums">{formatCount(item.value)}</strong></div>)}</div>
        </Section>

        <Section id="usage-series" title={usageSectionLabels.chart} description="真实时间桶；指标切换不重新取数。" actions={<div className="flex flex-wrap justify-end gap-2"><div className="inline-flex rounded-lg border p-0.5" aria-label="走势时间范围">{rangeOptions.map(option => <Button key={option.hours} size="sm" variant={rangeHours === option.hours ? 'secondary' : 'ghost'} data-usage-hours={option.hours} aria-pressed={rangeHours === option.hours} onClick={() => selectRange(option.hours)}>{option.label}</Button>)}</div><div className="inline-flex rounded-lg border p-0.5" aria-label="走势纵轴"><Button size="sm" variant={chartMetric === 'cost' ? 'secondary' : 'ghost'} data-usage-chart-metric="cost" aria-pressed={chartMetric === 'cost'} onClick={() => setChartMetric('cost')}>花费</Button><Button size="sm" variant={chartMetric === 'tokens' ? 'secondary' : 'ghost'} data-usage-chart-metric="tokens" aria-pressed={chartMetric === 'tokens'} onClick={() => setChartMetric('tokens')}>Token</Button></div></div>} className={compactSectionClass}>
          {seriesLoading && !series ? <LoadingBlock>正在读取走势</LoadingBlock>
            : seriesError && !series ? <BlockUnavailable title="走势暂时不可用" description={seriesError} />
              : series && <div className="grid gap-3">{seriesError && <p className="text-xs text-amber-700 dark:text-amber-300" role="alert">走势刷新失败，继续显示上次数据：{seriesError}</p>}<div className="flex flex-wrap items-end justify-between gap-2"><div><span className="text-[11px] text-muted-foreground">窗口内合计</span><strong className="mt-0.5 block text-lg font-semibold tabular-nums">{chartMetric === 'cost' ? formatActivityCost(series.totals.cost, series.currency, series.symbol) : `${formatCount(series.totals.tokens)} token`}</strong>{series.native && <KnownCosts costs={series.knownCosts} />}</div><p className="text-xs text-muted-foreground">每桶 {formatCount(series.bucketMs / 60_000)} 分钟 · {formatCount(series.totals.turns)} 轮 · {formatCount(series.totals.steps)} 步</p></div><UsageChart series={series} metric={chartMetric} selectedIndex={selectedBucket} onSelect={setSelectedBucket} detailedCounts={detailedCounts} /><details className="group/series rounded-lg border bg-muted/15"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"><span>{series.busiest ? `最忙桶 ${formatTimestamp(series.busiest.t)}` : '统计口径'}</span><ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open/series:rotate-180" aria-hidden="true" /></summary><div className="grid gap-2 border-t px-3 py-3 text-xs leading-5 text-muted-foreground"><p>{series.busiest ? `估算费用 ${formatActivityCost(series.busiest.cost, series.currency, series.symbol)}，${formatCount(series.busiest.tokens)} token。` : series.native ? '所选窗口没有可确认的最忙桶；未知数据未绘制为零。' : '所选窗口内没有产生正用量，纵轴保持真实 0 刻度。'}</p>{series.offChartCost !== null && series.offChartCost > 0 || series.offChartTokens !== null && series.offChartTokens > 0 ? <p>另有 {formatActivityCost(series.offChartCost, series.currency, series.symbol)}、约 {formatCount(series.offChartTokens)} token 属于图外累计历史；它们只有累计值，没有可画入时间桶的逐时明细。</p> : <p>{series.native && (series.offChartCost === null || series.offChartTokens === null) ? '图外累计历史包含未知用量或费用，不能确认其为零。' : '当前累计账本没有需要单列说明的图外历史。'}</p>}{series.countedSamples === 0 && <p>窗口内没有可追溯采样；这可能表示没有调用，也可能表示逐轮采样已被容量上限淘汰，不能据此推断累计总量为零。</p>}</div></details></div>}
        </Section>

        <Section id="conversation-usage" title={usageSectionLabels.conversations} description={`最多 ${formatCount(usage.limit)} 条；选择会话后加载逐轮明细。`} actions={usage.limited ? <StatusPill tone="warning">结果已截断</StatusPill> : <StatusPill tone="success">完整结果</StatusPill>} className={compactSectionClass}>
          {usage.conversations.length === 0 ? <EmptyState title="暂无用量记录" description="聊天账本已成功读取，但当前没有会话用量。" /> : <details className="group/conversations rounded-lg border" data-usage-conversations-panel><summary className="flex cursor-pointer list-none items-center justify-between gap-3 bg-muted/20 px-3 py-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"><span>会话记录</span><span className="ml-auto text-muted-foreground">{formatCount(usage.conversations.length)} 条</span><ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open/conversations:rotate-180" aria-hidden="true" /></summary><div className="h-96 min-h-0 overflow-auto overscroll-contain border-t" data-usage-conversations-scroll tabIndex={0} role="region" aria-label="会话用量列表"><table aria-rowcount={usage.conversations.length + 1} className="w-full min-w-[82rem] text-left text-xs"><thead className="sticky top-0 z-10 border-b bg-muted text-muted-foreground"><tr><th className="px-3 py-2.5 font-medium">会话</th><th className="px-3 py-2.5 text-right font-medium">轮 / 步</th><th className="px-3 py-2.5 text-right font-medium">输入与缓存</th><th className="px-3 py-2.5 text-right font-medium">输出</th><th className="px-3 py-2.5 text-right font-medium">命中率</th><th className="px-3 py-2.5 text-right font-medium">费用估算</th><th className="min-w-36 px-3 py-2.5 text-right font-medium">成本占比</th><th className="px-3 py-2.5 font-medium">模型</th><th className="px-3 py-2.5 font-medium">最近记录</th></tr></thead><VirtualTableBody items={usage.conversations} getItemKey={conversation => conversation.key} columns={9} estimateSize={100}>{conversation => {
            const identity = describeConversationKey(conversation.key);
            const buckets = conversation.buckets;
            const share = usage.totals.cost === null || conversation.cost === null ? null : usage.totals.cost > 0 ? conversation.cost / usage.totals.cost : 0;
            const sharePercent = share === null ? null : clampPercentage(share * 100);
            const shareLabel = formatPercentage(sharePercent === null ? null : sharePercent / 100);
            return <tr key={conversation.key} data-usage-key={conversation.key} className={selectedKey === conversation.key ? 'bg-accent/45 align-top' : 'align-top hover:bg-muted/30'}><td className="px-3 py-2.5"><button type="button" className="text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-pressed={selectedKey === conversation.key} onClick={() => selectConversation(conversation.key, true)}><span className="flex items-center gap-2"><Badge variant="outline">{identity.label}</Badge><strong className="font-medium tabular-nums">{identity.identifier}</strong></span><span className="mt-1 block text-[11px] text-muted-foreground">{formatCount(conversation.sessionCount)} 个技术会话</span>{conversation.firstAt && <span className="mt-1 block whitespace-nowrap text-[11px] text-muted-foreground">始于 {formatTimestamp(conversation.firstAt)}</span>}</button></td><td className="px-3 py-2.5 text-right tabular-nums">{formatCount(conversation.turns)} / {formatCount(conversation.steps)}</td><td className="px-3 py-2.5">{buckets ? <UsageTokenBreakdown values={buckets} side="input" formatCount={formatCount} /> : <span className="block text-right text-muted-foreground">不可用</span>}</td><td className="px-3 py-2.5">{buckets ? <UsageTokenBreakdown values={buckets} side="output" formatCount={formatCount} /> : <span className="block text-right text-muted-foreground">不可用</span>}</td><td className="px-3 py-2.5 text-right tabular-nums">{conversation.cacheHitRate === null ? '不可用' : formatPercentage(conversation.cacheHitRate)}</td><td className="px-3 py-2.5 text-right tabular-nums"><strong className="font-medium">{formatActivityCost(conversation.cost, usage.currency, usage.symbol)}</strong>{conversation.cost === null && <KnownCosts costs={conversation.knownCosts} />}{conversation.byTier && <p className="mt-1 text-[11px] text-muted-foreground">峰 {formatActivityCost(conversation.byTier.peak, usage.currency, usage.symbol)} · 闲 {formatActivityCost(conversation.byTier.off, usage.currency, usage.symbol)}</p>}{conversation.unattributedCost !== null && conversation.unattributedCost > 0 && <p className="mt-1 text-[11px] text-muted-foreground">未逐轮归属 {formatActivityCost(conversation.unattributedCost, usage.currency, usage.symbol)}</p>}</td><td className="min-w-36 px-3 py-2.5"><span className="block text-right tabular-nums">{shareLabel}</span>{sharePercent !== null && <Progress className="mt-1.5" value={sharePercent} aria-label={`${identity.label} ${identity.identifier} 成本占比`} aria-valuetext={shareLabel} />}</td><td className="max-w-52 px-3 py-2.5"><div className="flex flex-wrap gap-1">{conversation.models.length === 0 ? <span className="text-muted-foreground">未记录</span> : conversation.models.map(model => <Badge key={model} variant="secondary" className="max-w-full"><span className="truncate">{model}</span></Badge>)}</div></td><td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">{conversation.lastAt ? formatTimestamp(conversation.lastAt) : '未记录'}</td></tr>;
          }}</VirtualTableBody></table></div></details>}
          {usage.limited && <p className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-400" role="status">结果达到接口上限；总计来自完整账本汇总，会话表仅显示本次返回的部分记录。</p>}
        </Section>

        <Section id="usage-turns" title={usageSectionLabels.turns} description="最多 200 轮；累计历史可能早于逐轮保留窗口。" actions={<div className="flex flex-wrap items-center justify-end gap-2"><select id="usage-key-select" className="h-8 max-w-64 rounded-lg border bg-background px-2 text-xs" value={selectedKey} onChange={event => selectConversation(event.target.value)} aria-label="选择逐轮明细会话">{selectableConversations.map(conversation => <option key={conversation.key} value={conversation.key}>{describeConversationKey(conversation.key).label} · {describeConversationKey(conversation.key).identifier}</option>)}</select><Button id="usage-turns-load" size="sm" variant="outline" disabled={!selectedKey || turnsLoading} onClick={() => void loadTurns(selectedKey)}>{turnsLoading && <LoaderCircle className="size-3.5 animate-spin" />}加载明细</Button></div>} className={compactSectionClass}>
          <details open={turnsOpen} onToggle={event => setTurnsOpen(event.currentTarget.open)} className="group/turns" data-usage-turns-panel>
            <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg border bg-muted/20 px-3 py-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"><span>轮次记录</span><ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open/turns:rotate-180" aria-hidden="true" /></summary>
            <div className="h-96 min-h-0 pt-3" data-usage-turns-body>
          {!selectedKey ? <EmptyState title="选择一条会话" description="从会话汇总或下拉列表选择要查看的会话。" />
            : turnsLoading && !turns ? <LoadingBlock>正在读取逐轮明细</LoadingBlock>
              : turnsError ? <BlockUnavailable title="逐轮明细暂时不可用" description={turnsError} />
                : turns ? <div className="flex h-full min-h-0 flex-col gap-3"><div className="flex max-h-24 shrink-0 flex-wrap gap-x-4 gap-y-1.5 overflow-auto text-[11px] text-muted-foreground"><span>会话：<strong className="text-foreground">{turns.key}</strong></span><span>{formatCount(turns.sessionCount)} 个技术会话</span><span>可追溯 {formatCount(turns.turns.length)} 轮</span><span>已归属 {formatActivityCost(turns.attributedCost, turns.currency, turns.symbol)}</span><span>未逐轮归属 {formatActivityCost(turns.unattributedCost, turns.currency, turns.symbol)}</span>{turns.byTier ? <span>峰 {formatActivityCost(turns.byTier.peak, turns.currency, turns.symbol)} · 闲 {formatActivityCost(turns.byTier.off, turns.currency, turns.symbol)}</span> : <span>固定单价 · 无峰谷价档</span>}<span>{turns.firstAt === 0 ? '起始未记录' : `始于 ${formatTimestamp(turns.firstAt)}`} · {turns.lastAt === 0 ? '末次未记录' : `末于 ${formatTimestamp(turns.lastAt)}`}</span>{turns.native && <span>时间为框架观察时刻；响应事件数不是重试次数。{turns.partial && "扫描结果不完整。"}</span>}<span>模型：{turns.models.length > 0 ? turns.models.join('、') : '未记录'}</span>{turns.limited && <StatusPill tone="warning">结果已截断</StatusPill>}</div>{turns.turns.length === 0 ? <EmptyState title="没有可追溯轮次" description="该会话只有累计值，逐轮采样可能已被容量上限淘汰。" /> : <div data-usage-turns-scroll tabIndex={0} role="region" aria-label="逐轮用量列表" className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg border"><table aria-rowcount={turns.turns.length + 1} className="w-full min-w-[100rem] text-left text-xs"><thead className="sticky top-0 z-10 border-b bg-muted text-muted-foreground"><tr><th className="px-3 py-2.5 font-medium">起止时间</th><th className="px-3 py-2.5 text-right font-medium">轮</th><th className="px-3 py-2.5 text-right font-medium">{turns.native ? "步骤 / 响应事件" : "步骤 / 重试"}</th><th className="px-3 py-2.5 text-right font-medium">输入与缓存</th><th className="px-3 py-2.5 text-right font-medium">输出</th><th className="px-3 py-2.5 text-right font-medium">命中率</th><th className="px-3 py-2.5 text-right font-medium">费用估算</th><th className="px-3 py-2.5 font-medium">时段</th><th className="px-3 py-2.5 font-medium">模型 / Provider</th><th className="px-3 py-2.5 font-medium">技术会话</th></tr></thead><VirtualTableBody items={turns.turns} getItemKey={turn => `${turn.sessionId}-${turn.generation ?? ""}-${turn.turnId ?? turn.turn}-${turn.endedAt}`} columns={10} estimateSize={72}>{(turn, index) => <tr key={`${turn.sessionId}-${turn.generation ?? ""}-${turn.turnId ?? turn.turn}-${turn.endedAt}`} data-usage-turn={index}><td className="whitespace-nowrap px-3 py-2.5"><span className="block">始 {formatTimestamp(turn.startedAt)}</span><span className="mt-1 block text-[11px] text-muted-foreground">末 {formatTimestamp(turn.endedAt)}</span></td><td className="px-3 py-2.5 text-right tabular-nums">{turn.turnId ?? `#${formatCount(turn.turn)}`}</td><td className="px-3 py-2.5 text-right tabular-nums">{formatCount(turn.steps)} / {formatCount(turn.attempts)}</td><td className="px-3 py-2.5"><UsageTokenBreakdown values={turn.buckets} side="input" formatCount={formatCount} /></td><td className="px-3 py-2.5"><UsageTokenBreakdown values={turn.buckets} side="output" formatCount={formatCount} /></td><td className="px-3 py-2.5 text-right tabular-nums">{formatPercentage(cacheHitRate(turn.buckets))}</td><td className="px-3 py-2.5 text-right tabular-nums">{formatActivityCost(turn.cost, turns.currency, turns.symbol)}{turn.cost === null && <KnownCosts costs={turn.knownCosts} />}{turn.coverage && turn.coverage !== "complete" && <span className="block text-[11px] text-muted-foreground">覆盖不完整</span>}</td><td className="px-3 py-2.5"><TierBadge tier={turn.tier} /></td><td className="px-3 py-2.5"><span className="block">{turn.model ?? '未记录'}</span><span className="mt-1 block text-[11px] text-muted-foreground">{turn.provider ?? 'Provider 未记录'}</span></td><td className="max-w-48 break-all px-3 py-2.5 text-[11px] text-muted-foreground">{turn.sessionId}</td></tr>}</VirtualTableBody></table></div>}</div>
                  : <EmptyState title="尚未加载逐轮明细" description={selectedConversation ? `已选择${describeConversationKey(selectedConversation.key).label} ${describeConversationKey(selectedConversation.key).identifier}，点击“加载明细”读取。` : '点击会话汇总中的一行，或使用上方下拉列表选择会话。'} />}
            </div>
          </details>
        </Section>

        <Section id="usage-recent" title={usageSectionLabels.recent} description="最近 40 条计费采样，包含步骤和重试轴。" className={compactSectionClass}>
          <details className="group/recent" data-usage-recent-panel>
            <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg border bg-muted/20 px-3 py-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"><span>调用记录</span><ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open/recent:rotate-180" aria-hidden="true" /></summary>
            <div className="h-96 min-h-0 pt-3" data-usage-recent-body>
          {recentLoading && !recent ? <LoadingBlock>正在读取最近调用</LoadingBlock>
            : recentError && !recent ? <BlockUnavailable title="最近调用暂时不可用" description={recentError} />
              : recent && <div className="flex h-full min-h-0 flex-col gap-3">{recentError && <p className="text-xs text-amber-700 dark:text-amber-300" role="alert">最近调用刷新失败，继续显示上次数据：{recentError}</p>}{recent.entries.length === 0 ? <EmptyState title="暂无最近调用" description="账本返回空流水；这不代表累计用量为零。" /> : <div data-usage-recent-scroll className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg border"><table className="w-full min-w-[96rem] text-left text-xs"><thead className="sticky top-0 z-10 border-b bg-muted text-muted-foreground"><tr><th className="px-3 py-2.5 font-medium">时间</th><th className="px-3 py-2.5 font-medium">会话</th><th className="px-3 py-2.5 text-right font-medium">{recent.native ? "轮标识 / 步 / 重试（未知）" : "轮 / 步 / 重试"}</th><th className="px-3 py-2.5 text-right font-medium">输入与缓存</th><th className="px-3 py-2.5 text-right font-medium">输出</th><th className="px-3 py-2.5 text-right font-medium">Token</th><th className="px-3 py-2.5 text-right font-medium">费用估算</th><th className="px-3 py-2.5 font-medium">时段</th><th className="px-3 py-2.5 font-medium">模型</th><th className="px-3 py-2.5 font-medium">技术会话</th></tr></thead><tbody className="divide-y">{recent.entries.map((entry, index) => <tr key={entry.id ?? `${entry.sid}-${entry.turn}-${entry.step}-${entry.retry}-${entry.time}`} data-usage-recent={index}><td className="whitespace-nowrap px-3 py-2.5">{formatTimestamp(entry.time)}</td><td className="px-3 py-2.5">{entry.key ?? '未归属'}</td><td className="px-3 py-2.5 text-right tabular-nums">{entry.turnId ?? formatCount(entry.turn)} / {formatCount(entry.step)} / {formatCount(entry.retry)}</td><td className="px-3 py-2.5"><UsageTokenBreakdown values={entry} side="input" formatCount={formatCount} /></td><td className="px-3 py-2.5"><UsageTokenBreakdown values={entry} side="output" formatCount={formatCount} /></td><td className="px-3 py-2.5 text-right tabular-nums">{formatCount(entry.tokens)}</td><td className="px-3 py-2.5 text-right tabular-nums" title={entry.knownCost?.source === "reported" ? "提供方上报费用" : entry.knownCost?.source === "operator-price-estimate" ? "按入账时保存的单价计算，旧记录不回算" : undefined}>{entry.knownCost ? formatActivityCost(entry.knownCost.amount, entry.knownCost.currency, `${entry.knownCost.currency} `) : formatActivityCost(entry.cost, usage.currency, recent.symbol)}</td><td className="px-3 py-2.5"><TierBadge tier={entry.tier} /></td><td className="px-3 py-2.5">{entry.model ?? '未记录'}</td><td className="max-w-48 break-all px-3 py-2.5 text-[11px] text-muted-foreground">{entry.sid}</td></tr>)}</tbody></table></div>}</div>}
            </div>
          </details>
        </Section>

        <Section id="usage-prices" title={usageSectionLabels.prices} description="当前账本配置的单价与价格时段。" className={compactSectionClass}>
          {pricingUnavailable || !hasAvailablePricing(usage) ? <BlockUnavailable title="价目表信息不可用" description={usage.native ? "规则为空或包含多个币种，不能合成单一币种价目摘要；下方原生单价编辑器完整列出所有规则，历史金额仍按币种记录。" : "聊天宿主未提供完整价目表；已有 token 与费用汇总仍可查看。"} /> : <details className="group/prices rounded-lg border" data-usage-prices-panel><summary className="flex cursor-pointer list-none items-center justify-between gap-3 bg-muted/20 px-3 py-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"><span>价目明细</span><span className="ml-auto text-muted-foreground">{formatCount(Object.keys(usage.priceTable.models).length)} 个模型 · {usage.priceTable.version}</span><ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open/prices:rotate-180" aria-hidden="true" /></summary><div className="h-96 min-h-0 overflow-auto overscroll-contain border-t" data-usage-prices-scroll tabIndex={0} role="region" aria-label="模型价目列表"><div className="grid gap-3 p-3"><dl className="grid grid-cols-2 gap-3 text-xs lg:grid-cols-4"><div><dt className="text-muted-foreground">版本</dt><dd className="mt-1 break-all font-medium">{usage.priceTable.version}</dd></div><div><dt className="text-muted-foreground">计价单位</dt><dd className="mt-1 font-medium">每 {formatCount(usage.priceTable.unit)} token · {usage.priceTable.currency}</dd></div><div><dt className="text-muted-foreground">{usage.native ? "计价方式" : "高峰倍率"}</dt><dd className="mt-1 font-medium tabular-nums">{usage.native ? "固定单价" : `× ${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(usage.priceTable.peakMultiplier)}`}</dd></div><div><dt className="text-muted-foreground">{usage.native ? "目录示例规则" : "当前参考价档"}</dt><dd className="mt-1 font-medium">{usage.nowTier.tierLabel}</dd><span className="mt-1 block text-[11px] text-muted-foreground">{usage.nowTier.label} ({usage.nowTier.model})</span></div></dl>{usage.native ? <p className="text-xs leading-5 text-muted-foreground">原生账本使用固定单价，不适用峰谷时段。这里只展示当前目录；历史费用保留各轮入账时的价格快照。</p> : <p className="text-xs leading-5 text-muted-foreground">北京时间高峰窗口：{usage.priceTable.peakWindows.length === 0 ? '未配置' : usage.priceTable.peakWindows.map(window => `${formatUsageWindowEndpoint(window[0])}–${formatUsageWindowEndpoint(window[1])}`).join('、')}；生效星期：{usage.priceTable.peakWeekdays.length === 0 ? '未配置' : usage.priceTable.peakWeekdays.map(day => `周${'一二三四五六日'[day - 1]}`).join('、')}；账本内置节假日 {formatCount(usage.priceTable.holidayCount)} 天。高峰单价按空闲单价乘以配置倍率。</p>}{!usage.native && usage.nowTier.estimated && <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5">当前参考价档被账本标记为估算。{registeredReferenceModel ? '默认参考模型已登记在下表；该标记不代表模型缺失。' : '默认参考模型未登记在当前价目表中，账本使用了配置的兜底价。'}</p>}<div className="rounded-lg border"><table aria-rowcount={Object.keys(usage.priceTable.models).length + 1} className="w-full min-w-[44rem] text-left text-xs"><thead className="sticky top-0 z-10 border-b bg-muted text-muted-foreground"><tr><th className="px-3 py-2.5 font-medium">模型</th><th className="px-3 py-2.5 text-right font-medium">缓存命中</th><th className="px-3 py-2.5 text-right font-medium">缓存未命中</th><th className="px-3 py-2.5 text-right font-medium">缓存写入</th><th className="px-3 py-2.5 text-right font-medium">输出</th></tr></thead><VirtualTableBody items={Object.entries(usage.priceTable.models)} getItemKey={([name]) => name} columns={5} estimateSize={64}>{([name, model]) => <tr key={name}><td className="px-3 py-2.5"><code className="break-all">{name}</code><span className="mt-1 block text-[11px] text-muted-foreground">{model.label}</span></td><td className="px-3 py-2.5 text-right tabular-nums">{formatActivityCost(model.off.cacheHit, usage.priceTable.currency, usage.priceTable.symbol)}</td><td className="px-3 py-2.5 text-right tabular-nums">{formatActivityCost(model.off.cacheMiss, usage.priceTable.currency, usage.priceTable.symbol)}</td><td className="px-3 py-2.5 text-right tabular-nums">{formatActivityCost(model.off.cacheWrite, usage.priceTable.currency, usage.priceTable.symbol)}</td><td className="px-3 py-2.5 text-right tabular-nums">{formatActivityCost(model.off.output, usage.priceTable.currency, usage.priceTable.symbol)}</td></tr>}</VirtualTableBody></table></div><p className="text-[11px] leading-5 text-muted-foreground">{usage.native ? "表中为固定单价，仅影响新入账记录；不同币种的规则可在下方单价编辑器分别配置。" : "表中为空闲时段单价；高峰按配置倍率计算。所有金额均为估算。"}</p></div></div></details>}
        </Section>

        <Section id="usage-management" title={usageSectionLabels.management} description="revision 仅用于清空前预检；冲突或未知结果不会自动重试。" actions={<Button id="usage-reset-open" variant="destructive" onClick={openReset} disabled={!usage.revision || usage.resetAvailable === false}><Trash2 className="size-3.5" />清空账本</Button>} className={compactSectionClass}>
          <div className="flex items-start gap-3 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-xs leading-5"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" /><p><strong className="text-destructive">{usage.resetAvailable === false ? "原生账本不支持从此页面清空，保留历史入账记录。" : "清空会删除当前账本累计和逐轮记录，且不可恢复。"}</strong><span className="mt-1 block text-muted-foreground">{usage.resetAvailable === false ? "单价编辑不删除历史，也不重算旧轮次；读取与导览仍可正常使用。" : "预检通过后的并发写入也可能被删除。成功响应只表示账本接受请求，不保证持久化结果。"}{usage.revision ? '' : ' 当前快照没有 revision，因此清空入口不可用。'}</span></p></div>
        </Section>
      </>}

    <UsagePricingManager {...props} onSaved={() => { void runRefresh("manual"); }} />

    <Dialog open={resetOpen} onOpenChange={open => { if (!open) closeReset(); }}>
      <DialogContent showCloseButton={resetState !== 'saving' && resetState !== 'conflict' && resetState !== 'unknown'}>
        <DialogHeader><DialogTitle>确认清空用量账本？</DialogTitle><DialogDescription>此操作会删除累计用量与逐轮记录，无法撤销。当前 revision 只在清空前预检，并非原子删除；预检后并发写入的新记录可能被一并丢弃。仅在可以接受该风险时执行。冲突或结果未知时必须先刷新核对，不会自动重试。</DialogDescription></DialogHeader>
        <div className="grid gap-4"><div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs leading-5"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" /><span>成功只代表账本清空请求已受理，不保证并发写入后的账本仍为空。</span></div><label className="grid gap-2"><span className="field-label">输入“{resetConfirmation}”以确认</span><Input id="usage-reset-confirm" autoFocus autoComplete="off" value={resetText} onChange={event => { setResetText(event.target.value); if (resetState === 'error') setResetState('idle'); }} disabled={resetState === 'saving' || resetState === 'conflict' || resetState === 'unknown'} /></label>{resetState !== 'idle' && resetState !== 'saving' && <p className="text-xs leading-5 text-destructive" role="alert">{resetStateMessage(resetState, resetError)}</p>}</div>
        <DialogFooter>{resetState !== 'conflict' && resetState !== 'unknown' && <Button variant="outline" onClick={closeReset} disabled={resetState === 'saving'}>取消</Button>}{(resetState === 'conflict' || resetState === 'unknown') && <Button variant="outline" onClick={closeReset}>关闭并刷新核对</Button>}<Button id="usage-reset-submit" variant="destructive" disabled={!resetRevision || resetText !== resetConfirmation || resetState === 'saving' || resetState === 'conflict' || resetState === 'unknown'} onClick={() => void resetLedger()}>{resetState === 'saving' && <LoaderCircle className="size-3.5 animate-spin" />}{resetState === 'saving' ? '正在提交' : '确认清空'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
