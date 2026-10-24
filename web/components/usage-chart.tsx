import { useMemo } from 'react';
import { ArrowDown, ArrowUp, Database } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Tooltip, XAxis, YAxis } from 'recharts';

import { formatActivityCost, formatUsageCount } from '../lib/activity.ts';
import { usageBucketValue, type AggregateUsageTier, type UsageChartMetric, type UsageSeries, type UsageSeriesBucket } from '../lib/usage-details.ts';
import { ChartContainer, ChartTooltipContent } from './ui/chart.tsx';

const tierLabels: Readonly<Record<AggregateUsageTier, string>> = {
  peak: '高峰', off: '空闲', mixed: '混合',
};

const tierColors: Readonly<Record<AggregateUsageTier, string>> = {
  peak: 'var(--color-amber-500)', off: 'var(--color-emerald-500)', mixed: 'var(--color-sky-500)',
};

function formatBucketTime(time: number, bucketMs: number): string {
  return new Intl.DateTimeFormat('zh-CN', bucketMs >= 86_400_000
    ? { month: 'numeric', day: 'numeric' }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time));
}

function bucketIndex(value: unknown, length: number): number | null {
  const index = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(index) && index >= 0 && index < length ? index : null;
}

function BucketCounts({ bucket, detailedCounts }: { readonly bucket: UsageSeriesBucket; readonly detailedCounts: boolean }) {
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] sm:grid-cols-3">
    <div><dt className="text-muted-foreground">Token</dt><dd className="mt-0.5 font-medium tabular-nums">{formatUsageCount(bucket.tokens, detailedCounts)}</dd></div>
    <div><dt className="text-muted-foreground">轮次 / 步骤</dt><dd className="mt-0.5 font-medium tabular-nums">{formatUsageCount(bucket.turns, detailedCounts)} / {formatUsageCount(bucket.steps, detailedCounts)}</dd></div>
    <div><dt className="flex items-center gap-1 text-muted-foreground"><ArrowUp className="size-3" aria-hidden="true" />输入</dt><dd className="mt-0.5 font-medium tabular-nums">{formatUsageCount(bucket.cacheMiss + bucket.cacheHit + bucket.cacheWrite, detailedCounts)}</dd></div>
    <div><dt className="flex items-center gap-1 text-muted-foreground"><ArrowDown className="size-3" aria-hidden="true" />输出</dt><dd className="mt-0.5 font-medium tabular-nums">{formatUsageCount(bucket.output, detailedCounts)}</dd></div>
    <div title={`缓存写入 ${formatUsageCount(bucket.cacheWrite, detailedCounts)}；未命中 ${formatUsageCount(bucket.cacheMiss, detailedCounts)}。未命中 = 输入 − 缓存命中 − 缓存写入。`}><dt className="flex items-center gap-1 text-muted-foreground"><Database className="size-3" aria-hidden="true" />缓存</dt><dd className="mt-0.5 font-medium tabular-nums">{formatUsageCount(bucket.cacheHit, detailedCounts)}</dd></div>
  </dl>;
}

export interface UsageChartProps {
  readonly series: UsageSeries;
  readonly metric: UsageChartMetric;
  readonly selectedIndex: number | null;
  readonly detailedCounts?: boolean;
  onSelect(index: number): void;
}

export function UsageChart({ series, metric, selectedIndex, detailedCounts = false, onSelect }: UsageChartProps) {
  const chartData = useMemo(() => series.buckets.map(bucket => ({ ...bucket, value: usageBucketValue(bucket, metric) })), [metric, series]);
  const allZero = chartData.every(bucket => bucket.value === 0);
  const selectedBucket = selectedIndex === null ? null : series.buckets[selectedIndex] ?? null;

  return <div id="usage-chart" className="grid min-w-0 gap-3" data-chart-engine="recharts">
    <ChartContainer className="h-60 rounded-lg border bg-muted/10 px-1 py-2 sm:h-64 sm:px-3">
      <BarChart data={chartData} accessibilityLayer aria-label={`${metric === 'cost' ? '估算费用' : 'Token'}随时间的用量图`} margin={{ top: 10, right: 10, bottom: 0, left: 0 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="t" axisLine={false} tickLine={false} tickMargin={10} minTickGap={32} interval="preserveStartEnd" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} tickFormatter={(value: number) => formatBucketTime(value, series.bucketMs)} />
        <YAxis width={76} axisLine={false} tickLine={false} tickMargin={8} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} domain={allZero ? [0, 1] : [0, 'auto']} ticks={allZero ? [0] : undefined} allowDecimals={metric === 'cost'} tickFormatter={(value: number) => metric === 'cost' ? formatActivityCost(value, series.currency, series.symbol) : formatUsageCount(value, detailedCounts)} />
        <Tooltip cursor={false} isAnimationActive={false} allowEscapeViewBox={{ x: false, y: false }} offset={12} content={({ active, activeIndex }) => {
          const index = bucketIndex(activeIndex, series.buckets.length);
          const bucket = index === null ? undefined : series.buckets[index];
          return active && bucket ? <ChartTooltipContent data-usage-tooltip-index={index}>
            <div className="mb-2 flex items-center justify-between gap-2"><strong>{formatBucketTime(bucket.t, series.bucketMs)}</strong><span className="text-muted-foreground">{tierLabels[bucket.tier]}</span></div>
            <div className="mb-2 text-sm font-semibold tabular-nums">{formatActivityCost(bucket.cost, series.currency, series.symbol)}<span className="ml-1 text-[10px] font-normal text-muted-foreground">估算费用</span></div>
            <BucketCounts bucket={bucket} detailedCounts={detailedCounts} />
          </ChartTooltipContent> : null;
        }} />
        <Bar dataKey="value" name={metric === 'cost' ? '估算费用' : 'Token'} isAnimationActive={false} radius={[3, 3, 0, 0]} maxBarSize={44} activeBar={{ fillOpacity: 1, stroke: 'var(--primary)', strokeWidth: 1, strokeLinejoin: 'round', strokeMiterlimit: 1 }} onClick={(_entry, index) => onSelect(index)}>
          {chartData.map((bucket, index) => <Cell key={bucket.t} data-usage-bucket-index={index} fill={tierColors[bucket.tier]} fillOpacity={selectedIndex === index ? 1 : 0.8} />)}
        </Bar>
      </BarChart>
    </ChartContainer>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-[11px] text-muted-foreground" aria-label="价格时段图例">
        {(['off', 'peak', 'mixed'] as const).map(tier => <span key={tier} className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm" style={{ backgroundColor: tierColors[tier] }} />{tierLabels[tier]}</span>)}
      </div>
      <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" htmlFor="usage-bucket-select"><span className="shrink-0">时间桶明细</span><select id="usage-bucket-select" aria-label="查看时间桶" className="h-8 min-w-0 rounded-lg border bg-background px-2 text-xs text-foreground" value={selectedBucket ? String(selectedIndex) : ''} onChange={event => {
        const index = bucketIndex(event.target.value, series.buckets.length);
        if (index !== null) onSelect(index);
      }}><option value="" disabled>选择时间</option>{series.buckets.map((bucket, index) => <option key={bucket.t} value={index}>{formatBucketTime(bucket.t, series.bucketMs)} · {tierLabels[bucket.tier]}</option>)}</select></label>
    </div>
    {selectedBucket ? <div className="h-36 overflow-auto overscroll-contain rounded-lg border bg-muted/20 p-3" aria-live="polite" data-usage-bucket-details={selectedIndex ?? ''}><div className="grid gap-2"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{formatBucketTime(selectedBucket.t, series.bucketMs)}</strong><span className="text-xs text-muted-foreground">{tierLabels[selectedBucket.tier]} · {formatActivityCost(selectedBucket.cost, series.currency, series.symbol)}</span></div><BucketCounts bucket={selectedBucket} detailedCounts={detailedCounts} />{selectedBucket.keys.length > 0 && <p className="break-words text-[11px] text-muted-foreground">涉及会话：{selectedBucket.keys.join('、')}</p>}</div></div>
      : <p className="text-[11px] leading-5 text-muted-foreground" aria-live="polite" data-usage-bucket-details="">悬浮查看，点击柱形可保留桶明细；零用量桶可从时间选择器查看。</p>}
  </div>;
}
