import { useEffect, useMemo, useRef, useState } from 'react';

import { formatActivityCost, formatActivityCount } from '../lib/activity.ts';
import {
  buildUsageChartGeometry,
  usageBucketValue,
  type AggregateUsageTier,
  type UsageChartMetric,
  type UsageSeries,
  type UsageSeriesBucket,
} from '../lib/usage-details.ts';

const tierLabels: Readonly<Record<AggregateUsageTier, string>> = {
  peak: '高峰',
  off: '空闲',
  mixed: '混合',
};

const tierClasses: Readonly<Record<AggregateUsageTier, string>> = {
  peak: 'fill-amber-500/85 dark:fill-amber-400/80',
  off: 'fill-emerald-600/80 dark:fill-emerald-400/75',
  mixed: 'fill-sky-600/80 dark:fill-sky-400/75',
};

const tierLegendClasses: Readonly<Record<AggregateUsageTier, string>> = {
  peak: 'bg-amber-500/85 dark:bg-amber-400/80',
  off: 'bg-emerald-600/80 dark:bg-emerald-400/75',
  mixed: 'bg-sky-600/80 dark:bg-sky-400/75',
};

function formatBucketTime(time: number, bucketMs: number): string {
  const options: Intl.DateTimeFormatOptions = bucketMs >= 86_400_000
    ? { month: 'numeric', day: 'numeric' }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  return new Intl.DateTimeFormat('zh-CN', options).format(new Date(time));
}

function formatMetric(value: number, metric: UsageChartMetric, series: UsageSeries): string {
  return metric === 'tokens'
    ? `${formatActivityCount(value)} token`
    : formatActivityCost(value, series.currency, series.symbol);
}

function bucketLabel(bucket: UsageSeriesBucket, series: UsageSeries, metric: UsageChartMetric): string {
  return `${formatBucketTime(bucket.t, series.bucketMs)}，${tierLabels[bucket.tier]}，${formatMetric(usageBucketValue(bucket, metric), metric, series)}，${formatActivityCount(bucket.turns)} 轮，${formatActivityCount(bucket.steps)} 步`;
}

export interface UsageChartProps {
  readonly series: UsageSeries;
  readonly metric: UsageChartMetric;
  readonly selectedIndex: number | null;
  onSelect(index: number): void;
}

export function UsageChart({ series, metric, selectedIndex, onSelect }: UsageChartProps) {
  const chartContainer = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(960);
  useEffect(() => {
    const container = chartContainer.current;
    if (!container) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined && width > 0) setChartWidth(Math.max(240, Math.round(width)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const geometry = useMemo(() => buildUsageChartGeometry(series, metric, chartWidth), [chartWidth, metric, series]);
  const selectedBucket = selectedIndex === null ? null : series.buckets[selectedIndex] ?? null;

  function moveSelection(index: number, direction: -1 | 1): void {
    onSelect(Math.max(0, Math.min(series.buckets.length - 1, index + direction)));
  }

  return <div id="usage-chart" className="grid min-w-0 gap-4">
    <div ref={chartContainer} className="overflow-hidden rounded-lg border bg-muted/15 px-2 py-3 sm:px-4">
      <svg viewBox={`0 0 ${geometry.width} ${geometry.height}`} className="block h-auto w-full" role="img" aria-label={`${metric === 'cost' ? '估算费用' : 'Token'}随时间的用量图`}>
        {geometry.axisValues.map((axisValue, index) => {
          const y = geometry.plotTop + geometry.plotHeight - geometry.plotHeight * index / 2;
          return <g key={`${index}-${axisValue}`}>
            <line x1={geometry.plotLeft} y1={y} x2={geometry.plotLeft + geometry.plotWidth} y2={y} className="stroke-border" strokeWidth="1" />
            <text x={geometry.plotLeft - 9} y={y + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
              {formatMetric(axisValue, metric, series)}
            </text>
          </g>;
        })}
        {geometry.bars.map(bar => {
          const bucket = series.buckets[bar.index]!;
          const selected = selectedIndex === bar.index;
          const hitWidth = geometry.plotWidth / series.buckets.length;
          return <g
            key={bucket.t}
            role="button"
            tabIndex={0}
            data-usage-bucket-index={bar.index}
            aria-label={bucketLabel(bucket, series, metric)}
            aria-pressed={selected}
            onClick={() => onSelect(bar.index)}
            onPointerDown={() => onSelect(bar.index)}
            onPointerEnter={() => onSelect(bar.index)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(bar.index);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                moveSelection(bar.index, -1);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                moveSelection(bar.index, 1);
              }
            }}
            className="outline-none"
          >
            <title>{bucketLabel(bucket, series, metric)}</title>
            {bar.height > 0 && <rect x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx="2" className={tierClasses[bar.tier]} />}
            <rect
              x={geometry.plotLeft + bar.index * hitWidth}
              y={geometry.plotTop}
              width={hitWidth}
              height={geometry.plotHeight}
              fill="transparent"
              className={selected ? 'stroke-primary' : 'stroke-transparent focus:stroke-ring'}
              strokeWidth={selected ? 2 : 1}
            />
          </g>;
        })}
        {geometry.ticks.map(tick => <text key={tick.index} x={tick.x} y={geometry.height - 12} textAnchor={tick.index === 0 ? 'start' : tick.index === series.buckets.length - 1 ? 'end' : 'middle'} className="fill-muted-foreground text-[10px]">
          {formatBucketTime(series.buckets[tick.index]!.t, series.bucketMs)}
        </text>)}
      </svg>
    </div>
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-[11px] text-muted-foreground" aria-label="价格时段图例">
      {(['off', 'peak', 'mixed'] as const).map(tier => <span key={tier} className="inline-flex items-center gap-2"><span className={`size-2.5 rounded-sm ${tierLegendClasses[tier]}`} />{tierLabels[tier]}</span>)}
    </div>
    <div className="min-h-24 rounded-lg border bg-muted/20 p-4" aria-live="polite">
      {selectedBucket ? <div className="grid gap-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{formatBucketTime(selectedBucket.t, series.bucketMs)}</strong><span className="text-xs text-muted-foreground">{tierLabels[selectedBucket.tier]}时段</span></div><dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-xs sm:grid-cols-4"><div><dt className="text-muted-foreground">估算费用</dt><dd className="mt-1 font-medium tabular-nums">{formatActivityCost(selectedBucket.cost, series.currency, series.symbol)}</dd></div><div><dt className="text-muted-foreground">Token</dt><dd className="mt-1 font-medium tabular-nums">{formatActivityCount(selectedBucket.tokens)}</dd></div><div><dt className="text-muted-foreground">轮次 / 步骤</dt><dd className="mt-1 font-medium tabular-nums">{formatActivityCount(selectedBucket.turns)} / {formatActivityCount(selectedBucket.steps)}</dd></div><div><dt className="text-muted-foreground">缓存未命中 / 命中</dt><dd className="mt-1 font-medium tabular-nums">{formatActivityCount(selectedBucket.cacheMiss)} / {formatActivityCount(selectedBucket.cacheHit)}</dd></div><div><dt className="text-muted-foreground">缓存写入</dt><dd className="mt-1 font-medium tabular-nums">{formatActivityCount(selectedBucket.cacheWrite)}</dd></div><div><dt className="text-muted-foreground">输出</dt><dd className="mt-1 font-medium tabular-nums">{formatActivityCount(selectedBucket.output)}</dd></div></dl>{selectedBucket.keys.length > 0 && <p className="break-words text-[11px] text-muted-foreground">涉及会话：{selectedBucket.keys.join('、')}</p>}</div>
        : <p className="text-xs leading-5 text-muted-foreground">选择图中任意时间桶查看费用、Token、缓存和轮次明细；零用量桶也可以选择。</p>}
    </div>
  </div>;
}
