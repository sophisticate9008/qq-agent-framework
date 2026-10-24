import { ArrowDown, ArrowUp, Database } from 'lucide-react';

export interface UsageTokenBreakdownValues {
  readonly cacheMiss: number;
  readonly cacheHit: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number;
}

interface UsageTokenBreakdownProps {
  readonly values: UsageTokenBreakdownValues;
  readonly side: 'input' | 'output';
  readonly formatCount: (value: number) => string;
}

export function UsageTokenBreakdown({ values, side, formatCount }: UsageTokenBreakdownProps) {
  if (side === 'output') {
    return <div className="grid justify-items-end text-right text-[11px] tabular-nums" role="group" aria-label="输出 Token" data-token-direction="output" title={`推理 ${formatCount(values.reasoning)}；推理不额外计入总量。`}>
      <span className="inline-flex items-center gap-1 whitespace-nowrap"><ArrowDown className="size-3 text-sky-600 dark:text-sky-400" aria-hidden="true" /><span className="text-muted-foreground">输出</span><strong className="font-medium text-foreground">{formatCount(values.output)}</strong></span>
    </div>;
  }

  const input = values.cacheMiss + values.cacheHit + values.cacheWrite;
  return <div className="grid justify-items-end gap-0.5 text-right text-[11px] tabular-nums" role="group" aria-label="输入与缓存 Token 分项" data-token-direction="input">
    <span className="inline-flex items-center gap-1 whitespace-nowrap"><ArrowUp className="size-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" /><span className="text-muted-foreground">输入</span><strong className="font-medium text-foreground">{formatCount(input)}</strong></span>
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground" data-token-cache title={`缓存命中 ${formatCount(values.cacheHit)}；缓存写入 ${formatCount(values.cacheWrite)}；未命中 ${formatCount(values.cacheMiss)}。未命中 = 输入 − 缓存命中 − 缓存写入。`}><Database className="size-3" aria-hidden="true" /><span>缓存</span><strong className="font-medium">{formatCount(values.cacheHit)}</strong></span>
  </div>;
}
