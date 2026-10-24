import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, LoaderCircle, RefreshCw, ServerCog } from 'lucide-react';
import { ConfigurationEditor } from '../components/configuration-editor.tsx';
import { ConnectPrompt, EmptyState, Field, PageHeading, SaveBar, Section, StatusPill } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select.tsx';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';

interface ModelOptionLabel {
  readonly name: string;
  readonly description: string;
}

interface ModelState {
  readonly revision: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly options: string[];
  readonly labels: Readonly<Record<string, ModelOptionLabel>>;
}

type SaveResult = 'idle' | 'saved' | 'conflict' | 'unknown';

const effortFallbacks: Readonly<Record<string, ModelOptionLabel>> = {
  none: { name: '不额外思考', description: '优先快速回复，适合简单对话。' },
  minimal: { name: '极简', description: '只进行必要的推理，回复更快。' },
  low: { name: '较低', description: '使用较少推理，兼顾速度与质量。' },
  medium: { name: '均衡', description: '在回复速度和思考深度之间保持平衡。' },
  high: { name: '深入', description: '投入更多推理，适合复杂问题。' },
  xhigh: { name: '最深入', description: '使用最高可用强度处理复杂任务。' },
};

function readModel(value: unknown): ModelState | null {
  const record = asRecord(value);
  if (typeof record.revision !== 'string' || typeof record.provider !== 'string' || typeof record.model !== 'string'
    || typeof record.reasoningEffort !== 'string' || !Array.isArray(record.options)
    || !record.options.every(option => typeof option === 'string')) return null;
  const rawLabels = asRecord(record.labels);
  const labels: Record<string, ModelOptionLabel> = {};
  for (const option of record.options) {
    const label = asRecord(rawLabels[option]);
    if (typeof label.name === 'string' && typeof label.description === 'string') {
      labels[option] = { name: label.name, description: label.description };
    }
  }
  if (!record.options.includes(record.reasoningEffort)) return null;
  return {
    revision: record.revision,
    provider: record.provider,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    options: [...record.options],
    labels,
  };
}

function providerName(provider: string): string {
  if (provider === 'deepseek-official') return 'DeepSeek 官方服务';
  return provider;
}

function optionLabel(state: ModelState, option: string, index: number): ModelOptionLabel {
  return state.labels[option] ?? effortFallbacks[option.toLowerCase()] ?? {
    name: `思考强度 ${index + 1}`,
    description: '由当前模型服务提供的思考强度。',
  };
}

function saveMessage(result: SaveResult, dirty: boolean): string | undefined {
  if (result === 'saved') return '已保存，将从下一条消息开始生效';
  if (result === 'conflict') return '设置已在其他窗口更新，请重新载入后再保存。';
  if (result === 'unknown') return '暂时无法确认保存结果，请重新载入后查看。';
  return dirty ? '更改会从下一条消息开始生效' : '当前设置已同步';
}

export function ModelPage(props: PageProps) {
  const { api, connected, connect, setDirty } = props;
  const chatManagement = asRecord(props.snapshot.integrations).chatManagement !== false;
  const [model, setModel] = useState<ModelState | null>(null);
  const [selectedEffort, setSelectedEffort] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [result, setResult] = useState<SaveResult>('idle');
  const [reloadKey, setReloadKey] = useState(0);
  const [configurationDirty, setConfigurationDirty] = useState(false);
  const reportedDirty = useRef(false);
  const setDirtyRef = useRef(setDirty);
  const dirty = model !== null && selectedEffort !== model.reasoningEffort;
  const pageDirty = dirty || configurationDirty;

  useEffect(() => { setDirtyRef.current = setDirty; }, [setDirty]);
  useEffect(() => {
    if (reportedDirty.current === pageDirty) return;
    reportedDirty.current = pageDirty;
    setDirty(pageDirty);
  }, [pageDirty, setDirty]);
  useEffect(() => () => {
    reportedDirty.current = false;
    setDirtyRef.current(false);
  }, []);

  useEffect(() => {
    if (!connected || !chatManagement) {
      setModel(null);
      setSelectedEffort('');
      setLoadError('');
      setSaveError('');
      setResult('idle');
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    setSaveError('');
    setResult('idle');
    void api.get('/api/legacy/model', controller.signal).then(value => {
      const next = readModel(value);
      if (!next) throw new Error('invalid_model_response');
      setModel(next);
      setSelectedEffort(next.reasoningEffort);
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [api, chatManagement, connected, reloadKey]);

  const selectedLabel = useMemo(() => {
    if (!model) return null;
    const index = model.options.indexOf(selectedEffort);
    return optionLabel(model, selectedEffort, Math.max(index, 0));
  }, [model, selectedEffort]);

  function reload(): void {
    setReloadKey(key => key + 1);
  }

  async function save(): Promise<void> {
    if (!model || !dirty) return;
    setSaving(true);
    setSaveError('');
    setResult('idle');
    try {
      const response = readModel(await api.post('/api/legacy/model', {
        revision: model.revision,
        reasoningEffort: selectedEffort,
      }));
      if (!response || response.reasoningEffort !== selectedEffort) throw new Error('invalid_model_response');
      setModel(response);
      setSelectedEffort(response.reasoningEffort);
      setResult('saved');
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      setResult(/conflict|stale|revision/.test(code) ? 'conflict' : /unknown/.test(code) ? 'unknown' : 'idle');
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  if (!connected) return <div className="page-stack" data-page="model"><PageHeading title="模型与回复" description="查看当前模型服务，并调整回复时的思考强度。" /><ConnectPrompt connect={connect} /></div>;
  if (!chatManagement) return <div className="page-stack" data-page="model"><PageHeading title="模型与回复" description="管理聊天宿主提供的模型配置。" /><Section title="尚未接入聊天宿主" description="消息网关不直接调用模型。接入 agent 与模型适配器后，再由宿主提供对应配置。" /><ConfigurationEditor category="model" {...props} setDirty={setConfigurationDirty} /></div>;

  return <div className="page-stack" data-page="model">
    <PageHeading title="模型与回复" description="模型由当前服务提供，这里可以调整每条新消息使用的思考强度。" actions={<Button variant="outline" onClick={reload} disabled={loading || saving || dirty}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新载入</Button>} />
    {loadError && !model ? <Section title="无法读取模型设置" description={loadError} actions={<Button variant="outline" onClick={reload}>重试</Button>}><EmptyState title="模型设置暂时不可用" description="请检查连接后重试，当前聊天服务不会受到影响。" /></Section> : <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.72fr)_minmax(18rem,0.28fr)]">
      <Section title="回复设置" description="调整后不会影响正在处理的消息。" footer={<SaveBar dirty={dirty} saving={saving} message={saveMessage(result, dirty)} onSave={() => void save()} onReset={() => { if (model) setSelectedEffort(model.reasoningEffort); setSaveError(''); setResult('idle'); }} label="保存强度" />}>
        {loading || !model ? <div className="flex min-h-52 items-center justify-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取模型设置</div> : <div className="grid gap-6">
          <Field label="思考强度" description="保存后从下一条消息开始使用，不会中断或重置现有会话。"><Select value={selectedEffort} onValueChange={value => { if (value) { setSelectedEffort(value); setSaveError(''); setResult('idle'); } }} disabled={saving}><SelectTrigger className="w-full"><SelectValue>{selectedLabel?.name ?? '选择思考强度'}</SelectValue></SelectTrigger><SelectContent>{model.options.map((option, index) => <SelectItem key={option} value={option}>{optionLabel(model, option, index).name}</SelectItem>)}</SelectContent></Select>{selectedLabel && <p className="rounded-lg bg-muted px-3 py-2.5 text-xs leading-5 text-muted-foreground">{selectedLabel.description}</p>}</Field>
          {loadError && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><span>{loadError}</span><Button size="sm" variant="outline" onClick={reload}>重新载入</Button></div>}
          {saveError && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><span>{saveError}</span>{(result === 'conflict' || result === 'unknown') && <Button size="sm" variant="outline" onClick={reload}>重新载入</Button>}</div>}
        </div>}
      </Section>
      <Section title="当前模型" description="由已连接的模型服务决定。" actions={<StatusPill tone={loadError ? 'warning' : 'success'}>{loadError ? '读取异常' : '服务可用'}</StatusPill>}>
        {model ? <div className="grid gap-5"><div className="flex items-start gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"><ServerCog className="size-5" /></span><div className="min-w-0"><span className="text-[11px] text-muted-foreground">模型服务</span><strong className="mt-1 block break-all text-sm font-medium">{providerName(model.provider)}</strong></div></div><div className="flex items-start gap-3 border-t pt-5"><span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Bot className="size-5" /></span><div className="min-w-0"><span className="text-[11px] text-muted-foreground">模型标识</span><strong className="mt-1 block break-all text-sm font-medium">{model.model}</strong></div></div></div> : <div className="flex min-h-32 items-center justify-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在确认模型</div>}
      </Section>
    </div>}
    <ConfigurationEditor category="model" {...props} setDirty={setConfigurationDirty} />
  </div>;
}
