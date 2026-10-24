import { useEffect, useState } from 'react';
import { Activity, ArrowUpRight, ChevronRight, Clock3, MessagesSquare, RefreshCw, ShieldCheck, SlidersHorizontal, Sparkles, UserRound } from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { EmptyState, PageHeading, Section, StatusPill } from '../components/management.tsx';
import { asRecord } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';

export function OverviewPage({ connected, snapshot, refresh, navigate, connect, api }: PageProps) {
  const [legacyStatus, setLegacyStatus] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    setLegacyStatus(null);
    if (!connected || snapshot.mode !== 'gateway-live') return;
    const controller = new AbortController();
    void api.get('/api/legacy/status', controller.signal).then(value => {
      if (!controller.signal.aborted) setLegacyStatus(asRecord(value));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [api, connected, snapshot]);
  const overview = asRecord(snapshot.overview);
  const metrics = asRecord(overview.metrics);
  const policy = asRecord(asRecord(snapshot.policy).configuration);
  const online = connected && overview.online === true;
  const healthy = connected && (overview.gatewayHealthy === true || overview.mode === 'demo');
  const budget = policy.budgetEnabled === false ? '已关闭' : policy.budgetEnabled === true ? '已开启' : '未设置';
  const hasMetrics = connected && typeof metrics.writes === 'number';
  const activity = [
    { label: '发送请求', value: metrics.writes, warning: false },
    { label: '正在处理', value: metrics.pending, warning: false },
    { label: '被拒绝的请求', value: metrics.rejected, warning: true },
    { label: '发送结果未确认', value: metrics.unknown, warning: true },
    { label: '恢复时待核对的记录', value: metrics.recoveredUnknown, warning: true },
  ].filter(item => typeof item.value === 'number' && item.value > 0);
  const services = [
    { name: 'QQ 消息连接', hint: '当前账号在线状态', ready: connected && typeof overview.online === 'boolean' ? online : null, icon: MessagesSquare },
    { name: '消息发送服务', hint: '负责文字、图片和转发', ready: connected ? healthy : null, icon: Activity },
    ...(connected && snapshot.mode === 'gateway-live' ? [
      { name: '聊天引擎', hint: 'DSH 的当前就绪状态', ready: typeof legacyStatus?.dshReady === 'boolean' ? legacyStatus.dshReady : null, icon: Sparkles },
      { name: '聊天接收服务', hint: 'QQ 协议连接的当前状态', ready: typeof asRecord(legacyStatus?.snowluma).connected === 'boolean' ? asRecord(legacyStatus?.snowluma).connected === true : null, icon: MessagesSquare },
    ] : []),
    { name: '访问保护', hint: '使用本机令牌管理工作台', ready: connected ? true : null, icon: ShieldCheck },
  ];
  const statistics = [
    { label: 'QQ 连接', value: connected ? online ? '在线' : overview.mode === 'demo' ? '演示中' : '待检查' : '待连接', caption: connected ? '当前账号连接状态' : '登录后自动获取状态', icon: MessagesSquare },
    { label: '发送请求', value: hasMetrics ? String(metrics.writes) : '—', caption: '本次网关运行收到的发送请求', icon: ArrowUpRight },
    { label: '等待处理', value: connected && typeof metrics.pending === 'number' ? String(metrics.pending) : '—', caption: '正在排队或执行的请求', icon: Clock3 },
    { label: '用量限制', value: connected ? budget : '—', caption: '随时调整预算开关与额度', icon: ShieldCheck },
  ];
  const shortcuts = [
    { id: 'persona' as const, label: '人设与形象', description: '管理性格、表达与身份', icon: UserRound },
    { id: 'features' as const, label: '功能与触发', description: '按需开启伙伴的能力', icon: Sparkles },
    { id: 'access' as const, label: '访问范围', description: '管理群聊、好友与权限', icon: ShieldCheck },
    { id: 'settings' as const, label: '运行设置', description: '预算、连接和显示偏好', icon: SlidersHorizontal },
  ];
  return <div className="page-stack" data-page="overview">
    <PageHeading title="工作台概览" description="看看伙伴的近况，也让每一项设置触手可及。" actions={<Button variant="outline" onClick={() => void refresh()} disabled={!connected}><RefreshCw className="size-3.5" />刷新状态</Button>} />
    <div className="grid gap-5 xl:grid-cols-[1.25fr_1fr]">
      <section className="welcome-panel relative overflow-hidden rounded-2xl border p-7 sm:p-8"><span className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-card/75 px-3 py-1 text-[11px] font-medium text-primary"><Sparkles className="size-3" />你的智能伙伴工作空间</span><h2 className="text-[24px] leading-snug font-semibold tracking-tight">让陪伴，更合心意。</h2><p className="mt-3 max-w-sm text-[13px] leading-7 text-muted-foreground">从人设到日常能力，都可以在这里慢慢调整。<br className="hidden sm:block" />把复杂的连接，变成简单的日常。</p><div className="mt-6 flex gap-2.5"><Button onClick={() => connected ? navigate('persona') : connect()}>{connected ? '管理人设' : '连接工作台'}<ChevronRight className="size-3.5" /></Button><Button variant="outline" onClick={() => navigate('features')}>浏览功能</Button></div><div className="pointer-events-none absolute -top-9 -right-10 size-48 rounded-full border-[30px] border-primary/4" /></section>
      <div className="grid grid-cols-2 gap-3">{shortcuts.map(item => <button key={item.id} className="group flex min-w-0 items-center gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-colors hover:border-primary/40 hover:bg-accent/20" onClick={() => navigate(item.id)}><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground"><item.icon className="size-[18px]" /></span><span className="min-w-0"><strong className="block text-xs font-medium sm:text-[13px]">{item.label}</strong><span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground sm:text-xs">{item.description}</span></span></button>)}</div>
    </div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-5">{statistics.map(item => <section key={item.label} className="panel p-5"><div className="flex items-center justify-between text-xs text-muted-foreground"><span>{item.label}</span><item.icon className="size-4 opacity-65" /></div><strong className="mt-4 block text-[25px] leading-tight font-semibold tracking-tight">{item.value}</strong><p className="mt-2.5 text-[10px] leading-relaxed text-muted-foreground">{item.caption}</p></section>)}</div>
    <div className="grid gap-5 lg:grid-cols-2"><Section title="连接与服务" description="确认聊天与消息发送是否顺畅。"><div className="grid gap-4">{services.map(item => <div key={item.name} className="flex items-center justify-between border-b pb-4 last:border-0 last:pb-0"><div className="flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"><item.icon className="size-4" /></span><div><strong className="block text-xs font-medium">{item.name}</strong><p className="mt-1 text-[10px] text-muted-foreground">{item.hint}</p></div></div><StatusPill tone={item.ready === true ? 'success' : item.ready === false ? 'warning' : 'neutral'}>{item.ready === true ? '已就绪' : item.ready === false ? '未就绪' : connected ? '待检查' : '未连接'}</StatusPill></div>)}</div></Section><Section title="最近动态" description="本次网关的累计计数，不包含旧连接直接发送的消息。">{activity.length > 0 ? <div className="grid gap-3">{activity.map(item => <div key={item.label} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3"><span className="text-xs text-muted-foreground">{item.label}</span><StatusPill tone={item.warning ? 'warning' : 'neutral'}>{String(item.value)}</StatusPill></div>)}{activity.some(item => item.warning) && <p className="field-hint">未确认的发送不会自动重试，请先核对实际消息，避免重复发送。</p>}</div> : <EmptyState title={!connected ? '还没有运行记录' : hasMetrics ? '暂时没有新的消息处理' : '运行记录暂时不可用'} description={!connected ? '连接工作台后，可以查看消息处理情况。' : hasMetrics ? '收到消息后，这里会显示实际处理计数。' : '当前无法读取网关状态，请检查连接后刷新。请勿将此状态视为没有消息。'} />}</Section></div>
  </div>;
}
