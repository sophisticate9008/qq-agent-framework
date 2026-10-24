import { useCallback, useEffect, useState } from 'react';
import { Banknote, Coins, Database, LoaderCircle, RefreshCw, Sigma, Waypoints } from 'lucide-react';
import { ConnectPrompt, EmptyState, PageHeading, Section, StatusPill } from '../components/management.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { asRecord, errorMessage } from '../lib/api.ts';
import { describeConversationKey, formatActivityCost, formatActivityCount, parseUsageSnapshot, type UsageSnapshot } from '../lib/activity.ts';
import type { PageProps } from '../lib/types.ts';

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
}

export function UsagePage(props: PageProps) {
  const { api, connected, connect } = props;
  const chatManagement = asRecord(props.snapshot.integrations).chatManagement !== false;
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reloadVersion, setReloadVersion] = useState(0);

  const loadUsage = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const next = parseUsageSnapshot(await api.get('/api/legacy/usage?limit=100', signal));
    if (!next) throw new Error('invalid_usage_response');
    setUsage(next);
    setLoadError('');
  }, [api]);

  useEffect(() => {
    if (!connected || !chatManagement) {
      setUsage(null);
      setLoadError('');
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void loadUsage(controller.signal).catch(error => {
      if (!controller.signal.aborted) {
        setUsage(null);
        setLoadError(errorMessage(error));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [chatManagement, connected, loadUsage, reloadVersion]);

  const reload = (): void => setReloadVersion(version => version + 1);

  if (!connected) return <div className="page-stack" data-page="usage"><PageHeading title="用量与费用" description="查看聊天账本记录的真实 token 用量与费用估算。" /><ConnectPrompt connect={connect} /></div>;
  if (!chatManagement) return <div className="page-stack" data-page="usage"><PageHeading title="用量与费用" description="查看聊天宿主提供的用量账本。" /><Section id="usage-unavailable" title="尚未接入聊天宿主" description="独立消息网关没有聊天账本，当前无法提供用量统计。接入对应宿主后再查看。" /></div>;

  return <div className="page-stack" data-page="usage">
    <PageHeading title="用量与费用" description="数据来自聊天账本；费用按配置价目表估算，不是模型平台实际账单。" actions={<Button variant="outline" onClick={reload} disabled={loading}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新</Button>} />
    {loading && !usage ? <Section id="usage-summary" title="用量汇总"><div className="flex min-h-52 items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取聊天账本</div></Section>
      : loadError && !usage ? <Section id="usage-summary" title="用量不可用" description={loadError} actions={<Button variant="outline" onClick={reload}>重试</Button>}><EmptyState title="暂时无法读取用量" description="统计失败时不会显示为零。请检查聊天宿主和账本服务后重试。" /></Section>
      : usage && <>
        <Section id="usage-summary" title="账本汇总" description={`统计生成于 ${formatTimestamp(usage.generatedAt)}`} actions={<StatusPill tone={usage.totals.estimated ? 'warning' : 'neutral'}>{usage.totals.estimated ? '含估算费用' : '账本统计'}</StatusPill>}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[
            { id: 'total-tokens', label: '总 Token', value: formatActivityCount(usage.totals.totalTokens), caption: '账本记录的累计 token', icon: Sigma },
            { id: 'estimated-cost', label: '费用估算', value: formatActivityCost(usage.totals.cost, usage.currency, usage.symbol), caption: `按价目表估算 · ${usage.currency}`, icon: Banknote },
            { id: 'conversations', label: '会话数', value: formatActivityCount(usage.totals.conversations), caption: '账本中的会话范围', icon: Waypoints },
            { id: 'turns', label: '对话轮次', value: formatActivityCount(usage.totals.turns), caption: `${formatActivityCount(usage.totals.steps)} 个处理步骤`, icon: Database },
          ].map(item => <div key={item.label} data-usage-metric={item.id} className="rounded-lg border p-4"><div className="flex items-center justify-between text-xs text-muted-foreground"><span>{item.label}</span><item.icon className="size-4" /></div><strong className="mt-3 block break-words text-xl font-semibold tabular-nums">{item.value}</strong><p className="mt-2 text-[11px] leading-5 text-muted-foreground">{item.caption}</p></div>)}</div>
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 text-xs leading-5 text-muted-foreground"><Coins className="mt-0.5 size-3.5 shrink-0" />所有费用均依据本地价目表与账本 token 计算，不能替代模型平台账单。无法拆到具体轮次的历史估算费用为 {formatActivityCost(usage.totals.unattributedCost, usage.currency, usage.symbol)}。</p>
        </Section>
        <Section id="token-breakdown" title="Token 构成" description="按账本计数口径展示累计分类，不额外加总推理 token，也不推导日、周或其他时间窗口。">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 xl:grid-cols-6">{[
            ['输入', usage.totals.inputTokens], ['输出', usage.totals.outputTokens], ['缓存命中', usage.totals.cacheHitTokens],
            ['缓存未命中', usage.totals.cacheMissTokens], ['缓存写入', usage.totals.cacheWriteTokens], ['推理', usage.totals.reasoningTokens],
          ].map(([label, value]) => <div key={String(label)}><span className="text-[11px] text-muted-foreground">{label}</span><strong className="mt-1 block text-sm font-medium tabular-nums">{formatActivityCount(Number(value))}</strong></div>)}</div>
        </Section>
        <Section id="conversation-usage" title="按会话汇总" description={`最多显示 ${usage.limit} 条聊天账本汇总。`} actions={usage.limited ? <StatusPill tone="warning">结果已截断</StatusPill> : <StatusPill tone="success">完整结果</StatusPill>}>
          {usage.conversations.length === 0 ? <EmptyState title="暂无用量记录" description="聊天账本已成功读取，但当前没有会话用量。" /> : <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-[58rem] text-left text-xs"><thead className="border-b bg-muted/40 text-muted-foreground"><tr><th className="px-3 py-2.5 font-medium">会话</th><th className="px-3 py-2.5 text-right font-medium">Token</th><th className="px-3 py-2.5 text-right font-medium">费用估算</th><th className="px-3 py-2.5 text-right font-medium">轮次 / 步骤</th><th className="px-3 py-2.5 font-medium">模型</th><th className="px-3 py-2.5 font-medium">最近记录</th></tr></thead><tbody className="divide-y">{usage.conversations.map(conversation => {
            const identity = describeConversationKey(conversation.key);
            return <tr key={conversation.key} data-usage-key={conversation.key} className="align-top hover:bg-muted/30"><td className="px-3 py-3"><div className="flex items-center gap-2"><Badge variant="outline">{identity.label}</Badge><strong className="font-medium tabular-nums">{identity.identifier}</strong></div><p className="mt-1 text-[11px] text-muted-foreground">{formatActivityCount(conversation.sessionCount)} 个技术会话</p></td><td className="px-3 py-3 text-right tabular-nums"><strong className="font-medium">{formatActivityCount(conversation.totalTokens)}</strong><p className="mt-1 text-[11px] text-muted-foreground">入 {formatActivityCount(conversation.inputTokens)} · 出 {formatActivityCount(conversation.outputTokens)} · 命中 {formatActivityCount(conversation.cacheHitTokens)}</p></td><td className="px-3 py-3 text-right tabular-nums"><strong className="font-medium">{formatActivityCost(conversation.cost, usage.currency, usage.symbol)}</strong>{conversation.estimated && <p className="mt-1 text-[11px] text-muted-foreground">按价目表估算</p>}</td><td className="px-3 py-3 text-right tabular-nums">{formatActivityCount(conversation.turns)} / {formatActivityCount(conversation.steps)}</td><td className="max-w-52 px-3 py-3"><div className="flex flex-wrap gap-1">{conversation.models.length === 0 ? <span className="text-muted-foreground">未记录</span> : conversation.models.map(model => <Badge key={model} variant="secondary" className="max-w-full"><span className="truncate">{model}</span></Badge>)}</div></td><td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{conversation.lastAt ? formatTimestamp(conversation.lastAt) : '未记录'}</td></tr>;
          })}</tbody></table></div>}
          {usage.limited && <p className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-400" role="status">结果达到接口上限；总计来自完整账本汇总，会话表仅显示本次返回的部分记录。</p>}
        </Section>
      </>}
  </div>;
}
