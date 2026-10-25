import { parseNativeRuntimeProjection, type NativeRuntimeProjection } from '../../src/contracts/native-runtime-projection.ts';
import { PackageConfigurationManager } from '../components/package-configuration-manager.tsx';
import { ForwardAuthorizationManager } from '../components/forward-authorization-manager.tsx';
import { readResource } from '../lib/resource-reader.ts';
import { ChatInputSettings } from '../components/chat-input-settings.tsx';
import { ReminderManager } from '../components/reminder-manager.tsx';
import { NativeToolStatus } from '../components/native-tool-status.tsx';
import { NativeBootstrapSummary } from '../components/native-bootstrap-summary.tsx';
import { MemoryManager } from '../components/memory-manager.tsx';
import { useEffect, useRef, useState } from 'react';
import { Boxes, LoaderCircle, RefreshCw, ServerOff } from 'lucide-react';
import { ConfigurationEditor } from '../components/configuration-editor.tsx';
import { ChatTools } from '../components/chat-tools.tsx';
import { ConnectPrompt, EmptyState, PageHeading, Section } from '../components/management.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.tsx';
import { VirtualList } from '../components/virtual-list.tsx';
import { asRecord, errorMessage } from '../lib/api.ts';
import { featureLabel, featureStatusLabel, readDeclaredCapabilities } from '../lib/feature-labels.ts';
import type { PageProps } from '../lib/types.ts';

interface CapabilityState {
  readonly id: string;
  readonly installed: boolean;
}

interface FeatureState {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly capabilities: readonly string[] | null;
}

interface NativeFeatures {
  readonly runtimeConnected: boolean;
  readonly editableResources: boolean;
  readonly capabilities: readonly CapabilityState[];
  readonly features: readonly FeatureState[];
  readonly projection: NativeRuntimeProjection | null;
}

function parseFeature(value: unknown): FeatureState | null {
  const record = asRecord(value);
  if (typeof record.id !== 'string') return null;
  return {
    id: record.id,
    name: featureLabel(record.id, typeof record.name === 'string' ? record.name : undefined),
    description: typeof record.description === 'string' ? record.description : '本地装配功能',
    status: typeof record.status === 'string' ? record.status : 'unknown',
    capabilities: readDeclaredCapabilities(record.capabilities),
  };
}

function parseFeatures(value: unknown): NativeFeatures | null {
  const record = asRecord(value);
  if (typeof record.runtimeConnected !== 'boolean' || typeof record.editableResources !== 'boolean'
    || !Array.isArray(record.capabilities) || !Array.isArray(record.features)) return null;
  const capabilities = record.capabilities.map(item => {
    const capability = asRecord(item);
    return typeof capability.id === 'string' && typeof capability.installed === 'boolean'
      ? { id: capability.id, installed: capability.installed }
      : null;
  });
  const projection = record.projection === undefined ? null : parseNativeRuntimeProjection(record.projection);
  if (record.projection !== undefined && !projection) return null;
  const features = record.features.map(parseFeature);
  if (capabilities.some(capability => capability === null) || features.some(feature => feature === null)) return null;
  return {
    projection,
    runtimeConnected: record.runtimeConnected,
    editableResources: record.editableResources,
    capabilities: capabilities as CapabilityState[],
    features: features as FeatureState[],
  };
}

export function FeaturesPage(props: PageProps) {
  const { api, connected, connect } = props;
  const [features, setFeatures] = useState<NativeFeatures | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reloadVersion, setReloadVersion] = useState(0);
  const epoch = useRef(0);
  const connection = useRef({ api, connected });
  const previousConnection = useRef({ api, connected: false });
  connection.current = { api, connected };

  useEffect(() => {
    const generation = ++epoch.current;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && generation === epoch.current
      && connection.current.api === api && connection.current.connected;
    if (previousConnection.current.api !== api || !previousConnection.current.connected || !connected) setFeatures(null);
    previousConnection.current = { api, connected };
    setLoading(connected);
    setLoadError('');
    if (!connected) {
      return () => { controller.abort(); epoch.current++; };
    }
    void readResource(api, '/api/chat/features', controller.signal).then(value => {
      if (!current()) return;
      const next = parseFeatures(value);
      if (!next) throw new Error('invalid_features_response');
      setFeatures(next);
    }).catch(error => {
      if (current()) {
        setLoadError(errorMessage(error));
      }
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => { controller.abort(); epoch.current++; };
  }, [api, connected, reloadVersion]);

  if (!connected) return <div className="page-stack" data-page="features"><PageHeading title="功能与触发" description="配置聊天功能和触发方式。" /><ConnectPrompt connect={connect} /></div>;

  return <div className="page-stack" data-page="features">
    <PageHeading title="功能与触发" description="配置聊天功能和触发方式。" actions={<Button variant="outline" onClick={() => setReloadVersion(version => version + 1)} disabled={loading}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新读取</Button>} />
    <ChatInputSettings api={api} connected={connected} setDirty={props.setDirty} />
    <PackageConfigurationManager api={api} connected={connected} setDirty={props.setDirty} onlyIds={['chat-output']} />
    <ForwardAuthorizationManager api={api} connected={connected} setDirty={props.setDirty} navigate={props.navigate} />
    <ReminderManager api={api} connected={connected} setDirty={props.setDirty} />
    <details className="rounded-xl border bg-card p-3"><summary className="cursor-pointer px-2 py-1 text-sm font-medium">记忆与偏好管理</summary><div className="mt-3"><MemoryManager api={api} connected={connected} setDirty={props.setDirty} /></div></details>
    <Tabs defaultValue="framework" className="gap-4">
      <TabsList aria-label="功能分类" className="h-10 w-full justify-start sm:w-fit"><TabsTrigger value="framework" className="px-5">聊天工具</TabsTrigger><TabsTrigger value="extensions" className="px-5">功能设置</TabsTrigger></TabsList>
      <TabsContent value="framework" keepMounted><ChatTools api={api} connected={connected} /><NativeToolStatus api={api} connected={connected} navigate={props.navigate} /></TabsContent>
      <TabsContent value="extensions" keepMounted className="grid gap-4 [&[hidden]]:hidden">
        <PackageConfigurationManager api={api} connected={connected} setDirty={props.setDirty} excludeIds={['chat-input', 'chat-output']} />
        <NativeBootstrapSummary api={api} connected={connected} />
    {features && loadError && <p role="alert" className="rounded-lg border border-amber-500/30 p-3 text-xs leading-5 text-muted-foreground">读取失败，暂时显示上次的结果。未保存的设置仍然保留。</p>}
    {loading && !features ? <Section title="功能设置"><div className="flex min-h-44 items-center justify-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取功能设置</div></Section>
      : !features ? <Section title="功能设置"><EmptyState locked title="暂时无法读取功能设置" description="请重新读取，或检查服务连接。" /></Section>
        : <>
          {!features.runtimeConnected && <div className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-5"><ServerOff className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" /><p className="min-w-0 flex-1"><strong>聊天暂未就绪。</strong><span className="mt-1 block text-muted-foreground">请到连接页查看连接和启动状态。</span></p><Button variant="outline" onClick={() => props.navigate('adapters')}>查看聊天连接</Button></div>}
          {features.features.length > 0 && <Section title="聊天功能">
            <div className="h-96 min-h-0 overflow-auto overscroll-contain pr-1" role="region" aria-label="功能清单"><VirtualList items={features.features} getItemKey={feature => feature.id} estimateSize={120}>{feature => <div className="flex items-start gap-3 rounded-lg border p-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Boxes className="size-4" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="break-words text-xs font-medium">{feature.name}</strong><Badge variant="outline">{featureStatusLabel(feature.status)}</Badge>{features.projection && (() => { const actual = features.projection.features.find(item => item.id === feature.id); return actual ? <><Badge variant="outline">已声明</Badge><Badge variant="outline">{actual.installed ? '已安装' : '未安装'}</Badge><Badge variant="outline">{actual.ready ? '运行就绪' : '尚未就绪'}</Badge><span className="text-[11px] text-muted-foreground">授权由会话独立核验</span></> : <span className="text-[11px] text-muted-foreground">当前宿主未报告此项安装状态</span>; })()}</div><p className="mt-1 break-words text-[11px] leading-5 text-muted-foreground">{feature.description}</p></div></div>}</VirtualList></div>
          </Section>}
          {features.runtimeConnected && features.features.length === 0 && !features.editableResources && <p className="text-xs text-muted-foreground">当前没有可调整的额外功能。</p>}
          {features.editableResources && <ConfigurationEditor {...props} category="features" />}
        </>}
      </TabsContent>
    </Tabs>
  </div>;
}
