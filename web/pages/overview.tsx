import { useEffect, useState } from 'react';
import { Activity, ArrowUpRight, Bot, Cable, ChevronRight, Clock3, MessagesSquare, RefreshCw, ServerCog, ShieldCheck, SlidersHorizontal, Sparkles, UserRound } from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { EmptyState, PageHeading, Section, StatusPill } from '../components/management.tsx';
import { asRecord } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';

interface RuntimeStatus {
  readonly runtimeConnected: boolean;
}

function parseRuntimeStatus(value: unknown): RuntimeStatus | null {
  const record = asRecord(value);
  return typeof record.runtimeConnected === 'boolean' ? { runtimeConnected: record.runtimeConnected } : null;
}

export function OverviewPage({ connected, snapshot, refresh, navigate, connect, api }: PageProps) {
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  useEffect(() => {
    if (!connected) {
      setRuntimeStatus(null);
      return;
    }
    const controller = new AbortController();
    setRuntimeLoading(true);
    void api.get('/api/chat/status', controller.signal).then(value => {
      if (!controller.signal.aborted) setRuntimeStatus(parseRuntimeStatus(value));
    }).catch(() => {
      if (!controller.signal.aborted) setRuntimeStatus(null);
    }).finally(() => {
      if (!controller.signal.aborted) setRuntimeLoading(false);
    });
    return () => controller.abort();
  }, [api, connected, snapshot]);

  const overview = asRecord(snapshot.overview);
  const metrics = asRecord(overview.metrics);
  const policy = asRecord(asRecord(snapshot.policy).configuration);
  const gatewayHealthy = connected && (overview.gatewayHealthy === true || overview.mode === 'demo');
  const budget = policy.budgetEnabled === false ? '已关闭' : policy.budgetEnabled === true ? '已开启' : '未设置';
  const hasMetrics = connected && typeof metrics.writes === 'number';
  const activity = [
    { label: '网关发送请求', value: metrics.writes, warning: false },
    { label: '正在处理', value: metrics.pending, warning: false },
    { label: '被拒绝的请求', value: metrics.rejected, warning: true },
    { label: '发送结果未确认', value: metrics.unknown, warning: true },
    { label: '恢复时待核对记录', value: metrics.recoveredUnknown, warning: true },
  ].filter(item => typeof item.value === 'number' && item.value > 0);
  const services = [
    { name: '管理服务', hint: '保存方案、人设、授权和本地配置', ready: connected ? true : null, icon: ServerCog },
    { name: '独立消息网关', hint: '负责受控消息发送，不代表聊天宿主', ready: connected ? gatewayHealthy : null, icon: MessagesSquare },
    { name: '原生聊天宿主', hint: '负责接收聊天并运行启用方案', ready: runtimeStatus?.runtimeConnected ?? null, icon: Bot },
    { name: '管理访问保护', hint: '使用本机令牌保护管理接口', ready: connected ? true : null, icon: ShieldCheck },
  ];
  const statistics = [
    { label: '原生宿主', value: runtimeLoading ? '检查中' : runtimeStatus?.runtimeConnected === true ? '已接入' : runtimeStatus?.runtimeConnected === false ? '未接入' : '不可用', caption: '负责运行启用的聊天方案', icon: Bot },
    { label: '网关发送请求', value: hasMetrics ? String(metrics.writes) : '—', caption: '仅为独立网关本次运行计数', icon: ArrowUpRight },
    { label: '等待处理', value: connected && typeof metrics.pending === 'number' ? String(metrics.pending) : '—', caption: '网关正在排队或执行的请求', icon: Clock3 },
    { label: '发送预算', value: connected ? budget : '—', caption: '网关授权额度，不是模型 token', icon: ShieldCheck },
  ];
  const shortcuts = [
    { id: 'model' as const, label: '聊天方案', description: '创建、编辑并选择启用方案', icon: Bot },
    { id: 'adapters' as const, label: '适配器', description: '消息、聊天引擎与图片连接', icon: Cable },
    { id: 'persona' as const, label: '人设与形象', description: '独立管理身份与表达风格', icon: UserRound },
    { id: 'features' as const, label: '功能与触发', description: '查看本地装配能力', icon: Sparkles },
    { id: 'access' as const, label: '访问范围', description: '管理原生聊天授权主体', icon: ShieldCheck },
    { id: 'sessions' as const, label: '会话管理', description: '原生宿主接入后查看会话', icon: MessagesSquare },
    { id: 'usage' as const, label: '用量统计', description: '原生宿主接入后查看用量', icon: Activity },
    { id: 'settings' as const, label: '运行设置', description: '管理端、网关与显示偏好', icon: SlidersHorizontal },
  ];

  return <div className="page-stack" data-page="overview">
    <PageHeading title="工作台概览" description="分别查看管理服务、独立消息网关和原生聊天宿主；每个组件独立报告状态。" actions={<Button variant="outline" onClick={() => void refresh()} disabled={!connected}><RefreshCw className="size-3.5" />刷新状态</Button>} />
    <Section id="native-runtime" title="原生聊天接入" description="查看原生聊天宿主与独立管理组件的当前状态。" actions={<StatusPill tone={runtimeStatus?.runtimeConnected ? 'success' : 'warning'}>{runtimeLoading ? '检查中' : runtimeStatus?.runtimeConnected ? '原生宿主已接入' : '原生宿主未接入'}</StatusPill>}>
      <div className="grid gap-4 text-xs leading-6 text-muted-foreground sm:grid-cols-3">
        <div><strong className="text-foreground">管理服务</strong><p>方案、人设和授权可以独立保存，即使原生聊天宿主尚未启动。</p></div>
        <div><strong className="text-foreground">消息网关</strong><p>独立处理受控发送与回执，不负责决定聊天方案或人设。</p></div>
        <div><strong className="text-foreground">原生宿主</strong><p>{runtimeStatus?.runtimeConnected ? '新宿主已报告接入，可以继续核对会话与用量。' : '当前不可用于真实聊天；已保存设置不会因此自动应用。'}</p></div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-xs text-muted-foreground">保存管理设置不代表原生宿主已经运行；以这里的接入状态为准。</p><Button variant="outline" onClick={() => navigate('model')}>管理聊天方案<ChevronRight className="size-3.5" /></Button></div>
    </Section>
    <div className="grid gap-5 xl:grid-cols-[1.15fr_1fr]">
      <section className="welcome-panel rounded-lg border p-6 sm:p-7"><div className="flex items-center gap-3"><span className="flex size-11 items-center justify-center rounded-lg bg-accent text-accent-foreground"><Bot className="size-5" /></span><div><h2 className="text-lg font-semibold">聊天管理</h2><p className="mt-1 text-xs text-muted-foreground">从聊天方案开始，再分别配置人设、能力和授权。</p></div></div><div className="mt-6 flex flex-wrap gap-2.5"><Button onClick={() => connected ? navigate('model') : connect()}>{connected ? '打开聊天方案' : '连接工作台'}<ChevronRight className="size-3.5" /></Button><Button variant="outline" onClick={() => navigate('features')}>查看本地能力</Button></div></section>
      <div className="grid grid-cols-2 gap-3">{shortcuts.map(item => <button key={item.id} className="group flex min-w-0 items-center gap-3 rounded-lg border bg-card p-4 text-left shadow-xs transition-colors hover:border-primary/40 hover:bg-accent/20" onClick={() => navigate(item.id)}><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"><item.icon className="size-[18px]" /></span><span className="min-w-0"><strong className="block text-xs font-medium sm:text-[13px]">{item.label}</strong><span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground sm:text-xs">{item.description}</span></span></button>)}</div>
    </div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-5">{statistics.map(item => <section key={item.label} className="panel p-5"><div className="flex items-center justify-between text-xs text-muted-foreground"><span>{item.label}</span><item.icon className="size-4 opacity-65" /></div><strong className="mt-4 block text-xl leading-tight font-semibold">{item.value}</strong><p className="mt-2.5 text-[10px] leading-relaxed text-muted-foreground">{item.caption}</p></section>)}</div>
    <div className="grid gap-5 lg:grid-cols-2"><Section title="组件状态" description="管理服务、消息网关和原生宿主分别报告状态。"><div className="grid gap-4">{services.map(item => <div key={item.name} className="flex items-center justify-between border-b pb-4 last:border-0 last:pb-0"><div className="flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"><item.icon className="size-4" /></span><div><strong className="block text-xs font-medium">{item.name}</strong><p className="mt-1 text-[10px] text-muted-foreground">{item.hint}</p></div></div><StatusPill tone={item.ready === true ? 'success' : item.ready === false ? 'warning' : 'neutral'}>{item.ready === true ? '已就绪' : item.ready === false ? '未接入' : '不可用'}</StatusPill></div>)}</div></Section><Section title="最近网关动态" description="仅统计独立消息网关，不代表全部聊天流量。">{activity.length > 0 ? <div className="grid gap-3">{activity.map(item => <div key={item.label} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3"><span className="text-xs text-muted-foreground">{item.label}</span><StatusPill tone={item.warning ? 'warning' : 'neutral'}>{String(item.value)}</StatusPill></div>)}{activity.some(item => item.warning) && <p className="field-hint">未确认的发送不会自动重试，请先核对实际结果。</p>}</div> : <EmptyState title={!connected ? '还没有管理连接' : hasMetrics ? '暂无新的网关处理' : '网关记录不可用'} description={!connected ? '连接工作台后读取各组件状态。' : hasMetrics ? '收到网关请求后，这里会显示独立计数。' : '无法读取网关指标时不会按零处理。'} />}</Section></div>
  </div>;
}
