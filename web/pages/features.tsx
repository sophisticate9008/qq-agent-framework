import { parseNativeRuntimeProjection, type NativeRuntimeProjection } from '../../src/contracts/native-runtime-projection.ts';
import { PackageConfigurationManager } from '../components/package-configuration-manager.tsx';
import { readResource } from '../lib/resource-reader.ts';
import { NativeBootstrapSummary } from '../components/native-bootstrap-summary.tsx';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { ChatTools } from '../components/chat-tools.tsx';
import { ConnectPrompt, PageHeading, Section } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.tsx';
import { ReadOnlyDetails, TechnicalDetails } from '../components/read-only-details.tsx';
import { asRecord, errorMessage } from '../lib/api.ts';
import { featureStatusLabel, readDeclaredCapabilities } from '../lib/feature-labels.ts';
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
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : record.id,
    description: typeof record.description === 'string' ? record.description : '未提供用途说明',
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

  const builtinIds = ['agent-relay', 'framework-tools', 'reminder', 'reminders', 'memory', 'media', 'native-services', 'chat-input', 'chat-output'];
  const customFeatures = features?.features.filter(feature => !builtinIds.includes(feature.id)) ?? [];
  const installedFeatures = customFeatures.filter(feature => features?.projection
    ? features.projection.features.some(actual => actual.id === feature.id && actual.installed)
    : ['installed', 'active', 'running'].includes(feature.status));
  const hasUnconfirmed = customFeatures.length > installedFeatures.length;

  if (!connected) return <div className="page-stack" data-page="features"><PageHeading title="功能与扩展" description="查看框架功能与已接入扩展的实际状态。" /><ConnectPrompt connect={connect} /></div>;

  return <div className="page-stack" data-page="features">
    <PageHeading title="功能与扩展" description="查看框架功能与已接入扩展的实际状态。" actions={<Button variant="outline" onClick={() => setReloadVersion(version => version + 1)} disabled={loading}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新读取</Button>} />
    <Section title="功能" className="[&>.panel-body]:p-0">
    <Tabs defaultValue="framework" className="gap-0">
      <TabsList aria-label="功能分类" className="h-[34px] w-full justify-start bg-muted/30 px-2"><TabsTrigger value="framework" className="px-3">框架内置</TabsTrigger><TabsTrigger value="extensions" className="px-3">Agent 扩展</TabsTrigger></TabsList>
      <TabsContent value="framework" keepMounted className="p-2.5 [&[hidden]]:hidden">
        <div className="flex flex-wrap items-center gap-2"><strong className="text-sm font-semibold">回复方式</strong><p className="min-w-0 flex-1 basis-64 text-xs text-muted-foreground">短回复分条、长文转发和媒体发送已集中到首页。</p><Button onClick={() => props.navigate('overview')}>到首页调整<ArrowRight className="size-3.5" /></Button></div>
      </TabsContent>
      <TabsContent value="extensions" keepMounted className="grid gap-2 p-2.5 [&[hidden]]:hidden">
        <div className="flex flex-wrap items-center justify-end gap-2"><NativeBootstrapSummary api={api} connected={connected} />{(loadError || hasUnconfirmed) && <ReadOnlyDetails title="扩展列表详情" description="当前读取结果与尚待核对的扩展。"><TechnicalDetails fields={[{ label: '读取错误', value: loadError || null }, { label: '扩展状态', value: customFeatures }, { label: '运行结果', value: features?.projection }]} /></ReadOnlyDetails>}</div>
        {loadError && <p role="alert" className="text-xs text-destructive">扩展列表读取失败。{features ? '暂列上次结果，' : ''}请重新读取或查看详情。</p>}
        {loading && !features && <p role="status" className="text-sm text-muted-foreground">正在读取扩展…</p>}
        {hasUnconfirmed && <p role="status" className="text-xs text-muted-foreground">有扩展状态待核对，请查看运行详情。</p>}
        {installedFeatures.length > 0 && <Section title="已安装扩展"><div className="grid divide-y">{installedFeatures.map(feature => <div key={feature.id} className="flex min-h-[30px] flex-wrap items-center gap-2 py-0.5"><div className="flex min-w-0 flex-1 basis-48 items-center gap-3"><strong className="max-w-1/2 truncate text-sm font-medium" title={feature.name}>{feature.name}</strong><p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={feature.description}>{feature.description}</p></div><span className="text-xs text-muted-foreground">{featureStatusLabel(feature.status)}</span><ReadOnlyDetails title={feature.name} description="扩展的运行状态与记录。"><TechnicalDetails fields={[{ label: '扩展记录', value: feature }, { label: '运行状态', value: features?.projection?.features.find(actual => actual.id === feature.id) }]} /></ReadOnlyDetails></div>)}</div></Section>}
        {features && !loadError && installedFeatures.length === 0 && !hasUnconfirmed && <p className="text-sm text-muted-foreground">当前没有已安装的额外扩展。</p>}
        <PackageConfigurationManager api={api} connected={connected} setDirty={props.setDirty} excludeIds={builtinIds} />
        <ChatTools api={api} connected={connected} />
      </TabsContent>
    </Tabs>
    </Section>
    <p className="text-xs text-muted-foreground">人设唤醒在“人设”中配置；模型提问在所属 QQ 会话中回复。</p>
  </div>;
}
