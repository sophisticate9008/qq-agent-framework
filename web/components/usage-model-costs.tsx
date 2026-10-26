import type { UsageRecent } from '../lib/usage-details.ts';
import { formatActivityCost } from '../lib/activity.ts';
import { EmptyState, Section } from './management.tsx';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { Badge } from './ui/badge.tsx';

interface ModelCostSample {
  readonly model: string;
  readonly currency: string | null;
  amount: number | null;
  records: number;
  readonly sources: Set<string>;
}

export function UsageModelCosts({ recent, currency, loading, error }: {
  readonly recent: UsageRecent | null;
  readonly currency: string;
  readonly loading: boolean;
  readonly error: string;
}) {
  const samples = new Map<string, ModelCostSample>();
  for (const entry of recent?.entries ?? []) {
    const model = entry.model ?? '模型未记录';
    const amount = entry.knownCost?.amount ?? entry.cost;
    const recordedCurrency = entry.knownCost?.currency ?? (amount === null ? null : currency);
    const source = entry.knownCost?.source === 'reported' ? '提供方上报'
      : entry.knownCost?.source === 'operator-price-estimate' ? '单价估算'
        : amount === null ? '费用未知' : '账本估算';
    const key = JSON.stringify([entry.model, recordedCurrency, amount === null]);
    const sample = samples.get(key);
    if (sample) {
      sample.records += 1;
      if (sample.amount !== null && amount !== null) sample.amount += amount;
      sample.sources.add(source);
    } else samples.set(key, { model, currency: recordedCurrency, amount, records: 1, sources: new Set([source]) });
  }

  return <Section id="usage-model-costs" title="模型费用 · 当前调用采样" className="[&>.panel-body]:p-0"
    actions={<ReadOnlyDetails title="模型费用采样口径" label="费用记录详情"><p className="mb-3 text-xs leading-5 text-muted-foreground">按本次返回的调用记录采样汇总，币种分别记录。费用未知的调用单独列出，已有记录保留入账时的计价依据。</p><TechnicalDetails fields={[{ label: '采样记录数', value: recent?.entries.length ?? '尚未取得' }, { label: '完整性', value: recent?.partial ? '扫描结果不完整' : recent ? '当前返回采样' : '尚未取得' }, { label: '调用记录', value: recent?.entries ?? null }]} /></ReadOnlyDetails>}>
    {error && <p role="alert" className="px-2.5 py-2 text-xs text-destructive">采样读取失败。{recent ? '暂列上次结果，尚未重新确认。' : '当前费用待核对。'}</p>}
    {!recent && loading && <p role="status" className="px-2.5 py-4 text-xs text-muted-foreground">正在读取模型费用采样…</p>}
    {recent && samples.size === 0 && <EmptyState title="暂无调用采样" description="当前返回的调用列表为空，累计费用请查看账本汇总。" />}
    {samples.size > 0 && <div className="tablewrap max-h-72"><table className="w-full text-left text-[11px]"><thead className="sticky top-0 bg-muted text-muted-foreground"><tr><th className="px-2.5 py-1.5 font-medium">模型</th><th className="px-2.5 py-1.5 font-medium">已知费用</th><th className="px-2.5 py-1.5 font-medium">覆盖</th></tr></thead><tbody className="divide-y">{Array.from(samples, ([key, sample]) => <tr key={key} className="odd:bg-muted/10 even:bg-muted/30"><td className="max-w-36 px-2.5 py-1.5"><span className="block truncate" title={sample.model}>{sample.model}</span></td><td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums">{sample.amount === null || sample.currency === null ? '未知' : formatActivityCost(sample.amount, sample.currency, `${sample.currency} `)}</td><td className="px-2.5 py-1.5"><Badge variant="outline" className={sample.amount === null ? 'text-status-warning' : 'text-muted-foreground'}>{Array.from(sample.sources).join('、')}</Badge><span className="ml-1 text-muted-foreground">{sample.records} 条</span></td></tr>)}</tbody></table></div>}
    <p className="m-2.5 rounded bg-muted/50 px-2 py-1.5 text-[11px] leading-5 text-muted-foreground">仅汇总本次返回的调用采样，不能作为全账本模型费用；币种不合并。{recent?.partial && '扫描结果不完整。'}</p>
  </Section>;
}
