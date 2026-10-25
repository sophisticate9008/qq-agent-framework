import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../lib/api.ts';
import {
  nativeRuntimeCompatibilityDifferenceLabel, nativeRuntimeCompatibilityLabel, nativeRuntimeCompatibilityReasonLabel,
  nativeRuntimeCompatibilityRecoveryText, nativeRuntimeConfigurationBaselineLabel, nativeRuntimeBaselineUnavailableReasonLabel,
  parseNativeRuntimeCompatibility, parseNativeRuntimeConfigurationBaseline,
  type NativeRuntimeCompatibility, type NativeRuntimeConfigurationBaseline,
} from '../lib/native-runtime-compatibility.ts';
import type { PageId } from '../lib/types.ts';
import { Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';

function OriginalField({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="min-w-0"><dt className="font-medium">{label}</dt><dd className="mt-1"><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 font-mono text-xs [overflow-wrap:anywhere]">{value}</pre></dd></div>;
}

function OriginalValues({ baseline }: { readonly baseline: Extract<NativeRuntimeConfigurationBaseline, { state: 'available' }> }) {
  const { definition, persona, endpoint, bindings } = baseline.values;
  return <details className="mt-3 min-w-0 rounded-md border p-3">
    <summary className="cursor-pointer font-medium">展开原配置（可能含你保存的敏感文案）</summary>
    <p className="my-3 text-muted-foreground">仅供核对，不会应用。基线不含提供方密钥或协议凭据，也不保证能完整重建提供方与能力来源；不要公开截图或转发原文。</p>
    <dl className="grid min-w-0 gap-3">
      <OriginalField label="聊天方案标识" value={definition.planId} />
      <OriginalField label="关联人设标识" value={definition.personaId} />
      <OriginalField label="方案行为指令" value={definition.instructions} />
      <OriginalField label="模型提供方" value={definition.model.provider} />
      <OriginalField label="模型标识" value={definition.model.name} />
      <OriginalField label="推理档位" value={{ off: '关闭（off）', low: '低（low）', medium: '中（medium）', high: '高（high）', max: '最高（max）' }[definition.model.reasoningEffort]} />
      <OriginalField label="方案中的人设身份正文" value={definition.persona.identity} />
      <OriginalField label="方案中的人设表达风格" value={definition.persona.style} />
      <OriginalField label="人设标识" value={persona.id} />
      <OriginalField label="人设名称" value={persona.name} />
      <OriginalField label="人设身份正文" value={persona.identity} />
      <OriginalField label="人设表达风格" value={persona.style} />
      <OriginalField label="DSH 连接地址" value={endpoint} />
      <OriginalField label="群聊／私聊上下文上限" value={definition.contextLimits
        ? `群聊：${definition.contextLimits.group}\n私聊：${definition.contextLimits.private}` : '原记录未提供，不推断当前默认值。'} />
      <OriginalField label="能力选择" value={definition.capabilitySelection === undefined ? '原记录未提供，不推断当前默认值。'
        : definition.capabilitySelection === null ? '明确未选择工作包（null）' : `工作包：${definition.capabilitySelection.presetId}\n版本：${definition.capabilitySelection.revision}`} />
    </dl>
    <details className="mt-3"><summary className="cursor-pointer">技术字段：DSH 预设绑定（{bindings.length} 条）</summary>
      <p className="my-2 text-muted-foreground">agentPreset 为预设标识；conversationKind 为 group 群聊、private 私聊或 null 未限定；externalProvider 为外部提供方标识；definitionFingerprint 仅是定义指纹，不能反推原文或权限。</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 [overflow-wrap:anywhere]">{JSON.stringify(bindings, null, 2)}</pre>
    </details>
  </details>;
}

export function NativeRuntimeCompatibility({ api, connected, dirty, navigate }: {
  readonly api: ApiClient; readonly connected: boolean; readonly dirty: boolean; navigate(page: PageId): void;
}) {
  const [status, setStatus] = useState<NativeRuntimeCompatibility | null>(null);
  const [baseline, setBaseline] = useState<NativeRuntimeConfigurationBaseline | null>(null);
  const [loading, setLoading] = useState<'summary' | 'baseline' | null>(null);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const current = useRef({ api, connected });
  current.current = { api, connected };

  async function read(kind: 'summary' | 'baseline'): Promise<void> {
    if (!connected || current.current.api !== api || !current.current.connected || request.current
      || kind === 'baseline' && status?.baseline.state !== 'available') return;
    const controller = new AbortController();
    const generation = epoch.current;
    request.current = controller;
    setLoading(kind);
    setError('');
    setBaseline(null);
    if (kind === 'summary') setStatus(null);
    const live = () => !controller.signal.aborted && epoch.current === generation
      && current.current.api === api && current.current.connected;
    try {
      const response = await api.get(kind === 'summary' ? '/api/chat/runtime' : '/api/chat/runtime/baseline', controller.signal);
      if (!live()) return;
      if (kind === 'summary') {
        const next = parseNativeRuntimeCompatibility(response);
        if (!next) throw new Error('invalid_compatibility_summary');
        setStatus(next);
      } else {
        const next = parseNativeRuntimeConfigurationBaseline(response);
        if (!next) throw new Error('invalid_compatibility_baseline');
        if (next.state === 'available' && next.capturedAt !== status?.baseline.capturedAt) {
          setError('原配置基线已变化，请重新检查兼容性后再读取；不会混用不同检查的原值。');
        } else setBaseline(next);
      }
    } catch {
      if (live()) setError(kind === 'summary' ? '无法确认兼容性：读取失败或服务未提供有效检查结果。请确认访问会话后手动重新检查。'
        : '无法读取有效的原配置；不提供部分值，也不猜测恢复。请手动重新检查。');
    } finally {
      if (live()) setLoading(null);
      if (request.current === controller) request.current = null;
    }
  }

  useEffect(() => {
    epoch.current++;
    setStatus(null);
    setBaseline(null);
    setError('');
    setLoading(null);
    void read('summary');
    return () => { epoch.current++; request.current?.abort(); request.current = null; };
  }, [api, connected]);

  if (!connected) return null;
  return <Section id="native-runtime-compatibility" title="保留会话兼容性 / 原配置核对" scrollable height="md"
    description="只检查已保存配置与已有会话；不修改配置、会话、资源、方案或授权。"
    actions={<StatusPill tone={status?.state === 'compatible' ? 'success' : 'warning'}>{loading ? '正在读取' : status?.state === 'compatible' ? '兼容' : '需要核对'}</StatusPill>}>
    <div className="grid min-w-0 gap-3 text-xs leading-6 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={loading !== null} onClick={() => void read('summary')}>重新检查兼容性</Button>
        {status?.baseline.state === 'available' && <Button variant="outline" size="sm" disabled={loading !== null} onClick={() => void read('baseline')}>读取保留的原配置</Button>}
      </div>
      <p className="text-muted-foreground">以下是本次载入或手动检查的结果，不持续刷新；保存或切换设置后请重新检查。</p>
      {dirty && <p role="status">当前有未保存草稿；本检查不包含草稿，也不会替你保存或撤销。</p>}
      {loading && <p role="status">{loading === 'summary' ? '正在读取已保存配置的兼容性摘要。' : '正在按需读取原配置，仅供人工核对。'}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {status ? <>
        <h3 className="font-medium">{nativeRuntimeCompatibilityLabel(status)}</h3>
        <p>{status.hasPersistedSessions === null ? '是否存在持久会话尚不能确认。' : status.hasPersistedSessions ? '已有持久会话；不会自动新建或清空会话来绕过不兼容。' : '没有检测到需要比较的持久会话；这不代表聊天已经就绪或获得授权。'}</p>
        {status.reasons.length > 0 && <ul className="list-inside list-disc">{status.reasons.map(reason => <li key={reason}>{nativeRuntimeCompatibilityReasonLabel(reason)}</li>)}</ul>}
        <p>差异字段：{status.differences.length ? status.differences.map(nativeRuntimeCompatibilityDifferenceLabel).join('、') : '本次未报告差异；读取不可用时不代表相同。'}</p>
        <p>{nativeRuntimeCompatibilityRecoveryText(status)}</p>
        {status.baseline.state === 'available' ? <p>有可核对的原值基线。需要时点击“读取保留的原配置”，再展开原文；不会自动读取原文。</p>
          : <p>{status.baseline.state === 'not-required' ? '本次不需要原值基线。' : '没有可用原配置基线，不能猜测原值。'}</p>}
        {status.baseline.state !== 'available' && status.baseline.state !== 'not-required'
          && <p>{nativeRuntimeBaselineUnavailableReasonLabel(status.baseline.unavailableReason)}</p>}
        <ol className="list-inside list-decimal">
          <li>先核对差异字段与可信原值；没有原值时请操作者查证，不根据指纹反推。</li>
          <li>在对应设置页人工核对原字段，确认当前版本后条件保存。部署修改还需单独预览、确认应用和检查加载。</li>
          <li>保存后回到此处重新检查；不会自动恢复、迁移、新建会话、补授权或启动聊天。</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate('model')}>核对聊天方案</Button>
          <Button variant="ghost" size="sm" onClick={() => navigate('persona')}>核对人设</Button>
          <Button variant="ghost" size="sm" onClick={() => navigate('providers')}>核对模型提供方</Button>
          <Button variant="ghost" size="sm" onClick={() => navigate('adapters')}>核对连接与部署</Button>
        </div>
        <details><summary className="cursor-pointer">技术摘要（不含原文）</summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2">{JSON.stringify(status, null, 2)}</pre>
        </details>
      </> : !loading && <p>尚无有效的兼容性结果；不能据此认定兼容或允许启动。</p>}
      {baseline && <div><p role="status">{nativeRuntimeConfigurationBaselineLabel(baseline)}</p>
        {baseline.state !== 'available' && <p>{nativeRuntimeBaselineUnavailableReasonLabel(baseline.unavailableReason)}</p>}
        {baseline.state === 'available' && <><p>基线记录时间（毫秒时间戳）：{baseline.capturedAt}</p><OriginalValues baseline={baseline} /></>}
      </div>}
    </div>
  </Section>;
}
