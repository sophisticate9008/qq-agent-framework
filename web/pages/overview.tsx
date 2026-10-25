import { useAccountWorkspace } from '../lib/account-workspace.tsx';
import { RefreshCw } from 'lucide-react';
import { SetupProgress } from '../components/setup-progress.tsx';
import { RecentActivity } from '../components/recent-activity.tsx';
import { Button } from '../components/ui/button.tsx';
import { ConnectPrompt, PageHeading, Section, StatusPill } from '../components/management.tsx';
import { asRecord } from '../lib/api.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { parseChatRuntimeStatus } from '../lib/chat-runtime.ts';
import { overviewPageShortcuts } from '../lib/page-registry.ts';
import { parseNativeRuntimeProjection } from '../../src/contracts/native-runtime-projection.ts';
import type { PageProps } from '../lib/types.ts';

function parseFeaturesProjection(input: unknown) { return parseNativeRuntimeProjection(asRecord(input).projection); }

export function OverviewPage({ connected, snapshot, refresh, navigate, connect, api }: PageProps) {
  const runtime = useReadResource(api, '/api/chat/runtime', connected, parseChatRuntimeStatus, { intervalMs: 5_000 });
  const status = runtime.error ? null : runtime.snapshot;
  const account = useAccountWorkspace();
  const accountProjection = useReadResource(api, '/api/chat/features', connected && account?.selected !== null && account?.selected !== undefined, parseFeaturesProjection, { intervalMs: 5_000 });
  const projection = account?.selected ? accountProjection.error ? null : accountProjection.snapshot : connected ? parseNativeRuntimeProjection(snapshot.runtimeProjection) : null;
  const metrics = asRecord(asRecord(snapshot.overview).metrics);
  const connection = overviewPageShortcuts.find(item => item.id === 'adapters');
  return <div className="page-stack" data-page="overview">
    <PageHeading title="工作台概览" description="查看当前运行摘要、配置下一步和最近活动。" actions={<Button variant="outline" disabled={!connected || runtime.loading} onClick={() => { runtime.refresh(); void refresh(); }}><RefreshCw className="size-3.5" />刷新状态</Button>} />
    {!connected ? <ConnectPrompt connect={connect} /> : <>
      <Section id="native-runtime" title="运行摘要" description="管理连接、QQ 接入、聊天处理和实际模型执行分别核对。" actions={<Button size="sm" variant="outline" onClick={() => navigate('adapters')}>查看{connection?.label ?? '连接'}</Button>}>
        <div className="grid gap-3 text-xs leading-6 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2 rounded-lg border p-3"><strong>管理连接</strong><StatusPill tone="success">已连接</StatusPill></div>
          <div className="flex items-center justify-between gap-2 rounded-lg border p-3"><strong>QQ 接入</strong><StatusPill tone={status?.protocolConnected ? 'success' : 'neutral'}>{status ? status.protocolConnected ? '已连接' : '未连接' : '待确认'}</StatusPill></div>
          <div className="flex items-center justify-between gap-2 rounded-lg border p-3"><strong>聊天处理</strong><StatusPill tone={status?.chatReady ? 'success' : 'neutral'}>{status ? status.chatReady ? '已就绪' : { stopped: '已停止', starting: '正在启动', running: '等待条件就绪', stopping: '正在停止', error: '需要处理' }[status.state] : '待确认'}</StatusPill></div>
          <div className="flex items-center justify-between gap-2 rounded-lg border p-3"><strong>实际模型执行</strong><StatusPill tone={status?.modelExecutionVerified ? 'success' : 'neutral'}>{status?.modelExecutionVerified === true ? '已核验' : status?.modelExecutionVerified === false ? '尚未核验' : '待确认'}</StatusPill></div>
        </div>
        {runtime.error && <p role="status" className="mt-3 text-xs leading-6 text-muted-foreground">当前运行状态暂未读到；已保存配置不受影响，请在连接页核对。</p>}
        {projection && <p className="mt-3 text-xs leading-6 text-muted-foreground">当前聊天宿主：声明 {projection.features.length} 项功能，安装 {projection.features.filter(feature => feature.installed).length} 项，运行就绪 {projection.features.filter(feature => feature.ready).length} 项。授权按实际会话独立核验。{(projection.featuresLimited || projection.capabilitiesLimited) && ' 当前快照只覆盖部分声明。'}</p>}
        {typeof metrics.pending === 'number' && typeof metrics.unknown === 'number' && (metrics.pending > 0 || metrics.unknown > 0) && <p className="mt-3 text-xs leading-6">独立出站网关：待处理 {metrics.pending} 项，发送结果待核对 {metrics.unknown} 项。该计数只覆盖独立网关。</p>}
      </Section>
      <SetupProgress api={api} connected={connected} navigate={navigate} />
      <RecentActivity api={api} connected={connected} />
    </>}
  </div>;
}
