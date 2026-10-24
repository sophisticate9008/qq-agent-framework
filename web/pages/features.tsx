import { useEffect, useState } from 'react';
import { Boxes, Check, LoaderCircle, RefreshCw, ServerOff, Wrench } from 'lucide-react';
import { ConfigurationEditor } from '../components/configuration-editor.tsx';
import { ConnectPrompt, EmptyState, PageHeading, Section, StatusPill } from '../components/management.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { asRecord, errorMessage } from '../lib/api.ts';
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
}

interface NativeFeatures {
  readonly runtimeConnected: boolean;
  readonly editableResources: boolean;
  readonly capabilities: readonly CapabilityState[];
  readonly features: readonly FeatureState[];
}

function parseFeature(value: unknown): FeatureState | null {
  const record = asRecord(value);
  if (typeof record.id !== 'string') return null;
  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name : record.id,
    description: typeof record.description === 'string' ? record.description : '本地装配功能',
    status: typeof record.status === 'string' ? record.status : 'installed',
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
  const features = record.features.map(parseFeature);
  if (capabilities.some(capability => capability === null) || features.some(feature => feature === null)) return null;
  return {
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

  useEffect(() => {
    if (!connected) {
      setFeatures(null);
      setLoadError('');
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void api.get('/api/chat/features', controller.signal).then(value => {
      const next = parseFeatures(value);
      if (!next) throw new Error('invalid_features_response');
      setFeatures(next);
    }).catch(error => {
      if (!controller.signal.aborted) {
        setFeatures(null);
        setLoadError(errorMessage(error));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [api, connected, reloadVersion]);

  if (!connected) return <div className="page-stack" data-page="features"><PageHeading title="功能与触发" description="查看本机装配的能力与功能。" /><ConnectPrompt connect={connect} /></div>;

  const installedCapabilities = features?.capabilities.filter(capability => capability.installed) ?? [];
  return <div className="page-stack" data-page="features">
    <PageHeading title="功能与触发" description="查看本机实际装配的能力与功能。聊天方案、人设、访问授权和用户偏好仍分别管理。" actions={<Button variant="outline" onClick={() => setReloadVersion(version => version + 1)} disabled={loading}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新读取</Button>} />
    {loading && !features ? <Section title="本地装配"><div className="flex min-h-44 items-center justify-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取本地能力</div></Section>
      : !features ? <Section title="本地装配不可用" description={loadError || '服务没有返回可识别的功能数据。'}><EmptyState locked title="无法读取本机能力" description="暂时无法读取能力与功能清单，请稍后重试。" /></Section>
        : <>
          {!features.runtimeConnected && <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-5"><ServerOff className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" /><p><strong>原生聊天宿主未接入。</strong><span className="mt-1 block text-muted-foreground">可以查看和配置本地资源，但这些能力当前不会参与真实聊天。</span></p></div>}
          <div className="grid gap-5 lg:grid-cols-2">
            <Section title="能力装配" description="显示本机当前可提供的受控动作。" actions={<StatusPill tone={installedCapabilities.length > 0 ? 'success' : 'neutral'}>{installedCapabilities.length} 项已安装</StatusPill>}>
              <div className="h-96 min-h-0 overflow-auto overscroll-contain pr-1">{features.capabilities.length === 0 ? <EmptyState title="没有已声明能力" description="当前版本没有报告任何本机能力。" /> : <div className="grid gap-2">{features.capabilities.map(capability => <div key={capability.id} className="flex min-h-12 items-center justify-between gap-3 rounded-lg border px-3 py-2.5"><span className="flex min-w-0 items-center gap-2"><Wrench className="size-4 shrink-0 text-muted-foreground" /><code className="truncate text-xs">{capability.id}</code></span><Badge variant={capability.installed ? 'secondary' : 'outline'}>{capability.installed ? <><Check className="size-3" />已安装</> : '未安装'}</Badge></div>)}</div>}</div>
            </Section>
            <Section title="已装配功能" description="显示使用上述能力的本机功能；空列表表示尚未装配。" actions={<StatusPill>{features.features.length} 项</StatusPill>}>
              <div className="h-96 min-h-0 overflow-auto overscroll-contain pr-1">{features.features.length === 0 ? <EmptyState title="尚未装配功能" description="当前没有报告可运行功能。" /> : <div className="grid gap-2">{features.features.map(feature => <div key={feature.id} className="flex items-start gap-3 rounded-lg border p-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Boxes className="size-4" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-xs font-medium">{feature.name}</strong><Badge variant="outline">{feature.status}</Badge></div><p className="mt-1 text-[11px] leading-5 text-muted-foreground">{feature.description}</p><code className="mt-1 block truncate text-[10px] text-muted-foreground">{feature.id}</code></div></div>)}</div>}</div>
            </Section>
          </div>
          {features.editableResources && <ConfigurationEditor {...props} category="features" />}
        </>}
  </div>;
}
