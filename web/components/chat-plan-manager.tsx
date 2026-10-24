import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, LoaderCircle, Plus, RefreshCw, Save, Server, ServerOff } from 'lucide-react';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import { catalogIdentifierDescription, isCatalogIdentifier } from '../lib/catalog-identifier.ts';
import type { PageProps } from '../lib/types.ts';
import { ConnectPrompt, EmptyState, Field, SaveBar, Section, StatusPill } from './management.tsx';
import { Badge } from './ui/badge.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Textarea } from './ui/textarea.tsx';
import { createBuiltinDailyChatPlanDraft } from '../../src/host/chat-templates.ts';

export interface ChatPlan {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly personaId: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly contextLimits: { readonly group: number; readonly private: number };
}

interface ChatPlanCatalog {
  readonly revision: string;
  readonly activePlanId: string | null;
  readonly plans: readonly ChatPlan[];
}

interface PersonaOption {
  readonly id: string;
  readonly name: string;
}

interface ProviderOption {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly models: readonly { readonly id: string; readonly name: string }[];
}

type SaveState = 'idle' | 'saved' | 'busy' | 'conflict' | 'unknown';

const emptyPlan: ChatPlan = {
  id: '', name: '', description: '', instructions: '', personaId: '', provider: '', model: '', reasoningEffort: '',
  contextLimits: { group: 128_000, private: 128_000 },
};

const textKeys = ['id', 'name', 'description', 'instructions', 'personaId', 'provider', 'model', 'reasoningEffort'] as const;

function validContextLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 16_777_216;
}

function readText(record: Record<string, unknown>, key: typeof textKeys[number]): string | null {
  return typeof record[key] === 'string' ? record[key] : null;
}

function parsePlan(value: unknown): ChatPlan | null {
  const record = asRecord(value);
  const id = readText(record, 'id');
  const name = readText(record, 'name');
  const description = readText(record, 'description');
  const instructions = readText(record, 'instructions');
  const personaId = readText(record, 'personaId');
  const provider = readText(record, 'provider');
  const model = readText(record, 'model');
  const reasoningEffort = readText(record, 'reasoningEffort');
  const context = record.contextLimits === undefined ? emptyPlan.contextLimits : asRecord(record.contextLimits);
  if (id === null || name === null || description === null || instructions === null || personaId === null
    || provider === null || model === null || reasoningEffort === null
    || !validContextLimit(context.group) || !validContextLimit(context.private)) return null;
  return { id, name, description, instructions, personaId, provider, model, reasoningEffort,
    contextLimits: { group: context.group, private: context.private } };
}

function parseCatalog(value: unknown): ChatPlanCatalog | null {
  const record = asRecord(value);
  if (typeof record.revision !== 'string' || !Array.isArray(record.plans)
    || record.activePlanId !== null && typeof record.activePlanId !== 'string') return null;
  const plans = record.plans.map(parsePlan);
  if (plans.some(plan => plan === null)) return null;
  const completePlans = plans as ChatPlan[];
  if (new Set(completePlans.map(plan => plan.id)).size !== completePlans.length) return null;
  if (record.activePlanId !== null && !completePlans.some(plan => plan.id === record.activePlanId)) return null;
  return { revision: record.revision, activePlanId: record.activePlanId as string | null, plans: completePlans };
}

function parsePersonaOptions(value: unknown): readonly PersonaOption[] | null {
  const record = asRecord(value);
  if (!Array.isArray(record.personas)) return null;
  const personas = record.personas.map(item => {
    const persona = asRecord(item);
    return typeof persona.id === 'string' && typeof persona.name === 'string'
      ? { id: persona.id, name: persona.name }
      : null;
  });
  return personas.some(persona => persona === null) ? null : personas as PersonaOption[];
}

function samePlan(left: ChatPlan, right: ChatPlan): boolean {
  return textKeys.every(key => left[key] === right[key])
    && left.contextLimits.group === right.contextLimits.group && left.contextLimits.private === right.contextLimits.private;
}

function parseProviderOptions(value: unknown): readonly ProviderOption[] | null {
  const record = asRecord(value);
  if (!Array.isArray(record.providers) || record.providers.length > 128) return null;
  const providers: ProviderOption[] = [];
  for (const value of record.providers) {
    const provider = asRecord(value);
    if (typeof provider.id !== 'string' || typeof provider.name !== 'string' || typeof provider.enabled !== 'boolean'
      || !Array.isArray(provider.models) || provider.models.length > 128) return null;
    const models: { id: string; name: string }[] = [];
    for (const value of provider.models) {
      const model = asRecord(value);
      if (typeof model.id !== 'string' || typeof model.name !== 'string') return null;
      models.push({ id: model.id, name: model.name });
    }
    if (new Set(models.map(model => model.id)).size !== models.length) return null;
    providers.push({ id: provider.id, name: provider.name, enabled: provider.enabled, models });
  }
  return new Set(providers.map(provider => provider.id)).size === providers.length ? providers : null;
}

function planError(error: unknown): SaveState {
  if (error instanceof ApiError && error.code === 'chat_storage_busy') return 'busy';
  if (error instanceof ApiError && (error.status === 409 || /conflict|stale|revision/.test(error.code))) return 'conflict';
  if (error instanceof ApiError && (error.status >= 500 || /unknown/.test(error.code))) return 'unknown';
  return 'idle';
}

function saveMessage(state: SaveState, dirty: boolean): string {
  if (state === 'saved') return '聊天方案目录已保存。';
  if (state === 'busy') return '另一项保存正在进行，请稍后重新载入后再提交；不会自动重试。';
  if (state === 'conflict') return '目录已在其他窗口更新，请重新载入后再编辑。';
  if (state === 'unknown') return '无法确认保存结果，请重新载入核对，不会自动重试。';
  return dirty ? '聊天方案有尚未保存的更改。' : '当前内容与已保存方案一致。';
}

export function ChatPlanManager({ api, connected, connect, setDirty, navigate }: PageProps) {
  const [catalog, setCatalog] = useState<ChatPlanCatalog | null>(null);
  const [personas, setPersonas] = useState<readonly PersonaOption[]>([]);
  const [providers, setProviders] = useState<readonly ProviderOption[]>([]);
  const [runtimeConnected, setRuntimeConnected] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ChatPlan>(emptyPlan);
  const [groupContext, setGroupContext] = useState(String(emptyPlan.contextLimits.group));
  const [privateContext, setPrivateContext] = useState(String(emptyPlan.contextLimits.private));
  const [creating, setCreating] = useState(false);
  const [pendingActivePlanId, setPendingActivePlanId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [reloadVersion, setReloadVersion] = useState(0);
  const reportedDirty = useRef(false);
  const saveController = useRef<AbortController | null>(null);
  const setDirtyRef = useRef(setDirty);
  const selectedPlan = catalog?.plans.find(plan => plan.id === selectedId) ?? null;
  const contextBaseline = creating ? emptyPlan.contextLimits : selectedPlan?.contextLimits ?? emptyPlan.contextLimits;
  const contextDirty = groupContext !== String(contextBaseline.group) || privateContext !== String(contextBaseline.private);
  const draftDirty = creating
    ? textKeys.some(key => draft[key].trim() !== '')
    : selectedPlan !== null && !samePlan(draft, selectedPlan);
  const activeDirty = catalog !== null && pendingActivePlanId !== catalog.activePlanId;
  const dirty = draftDirty || activeDirty || contextDirty;
  const blocked = saveState === 'busy' || saveState === 'conflict' || saveState === 'unknown';
  const editingDisabled = saving || blocked;
  const selectedProvider = providers.find(provider => provider.id === draft.provider);
  const selectedModel = selectedProvider?.models.find(model => model.id === draft.model);
  const registeredSelection = selectedProvider?.enabled === true && selectedModel !== undefined;

  function selectContext(plan: ChatPlan): void {
    setGroupContext(String(plan.contextLimits.group));
    setPrivateContext(String(plan.contextLimits.private));
  }

  useEffect(() => { setDirtyRef.current = setDirty; }, [setDirty]);
  useEffect(() => {
    if (reportedDirty.current === dirty) return;
    reportedDirty.current = dirty;
    setDirty(dirty, 'chat-plans');
  }, [dirty, setDirty]);
  useEffect(() => () => {
    saveController.current?.abort();
    reportedDirty.current = false;
    setDirtyRef.current(false, 'chat-plans');
  }, []);

  useEffect(() => {
    setSaving(false);
    if (!connected) {
      setCatalog(null);
      setRuntimeConnected(null);
      setSelectedId(null);
      setDraft(emptyPlan);
      selectContext(emptyPlan);
      setProviders([]);
      setCreating(false);
      setLoadError('');
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    setWriteError('');
    setSaveState('idle');
    void Promise.all([
      api.get('/api/chat/plans', controller.signal),
      api.get('/api/chat/personas', controller.signal),
      api.get('/api/chat/status', controller.signal),
      api.get('/api/chat/providers', controller.signal),
    ]).then(([plansValue, personasValue, statusValue, providersValue]) => {
      if (controller.signal.aborted) return;
      const next = parseCatalog(plansValue);
      const nextPersonas = parsePersonaOptions(personasValue);
      const nextProviders = parseProviderOptions(providersValue);
      const runtimeStatus = asRecord(statusValue);
      if (!next || !nextPersonas || !nextProviders || typeof runtimeStatus.runtimeConnected !== 'boolean') throw new Error('invalid_chat_plans_response');
      const preferred = next.plans.find(plan => plan.id === next.activePlanId) ?? next.plans[0] ?? null;
      setCatalog(next);
      setPersonas(nextPersonas);
      setProviders(nextProviders);
      setRuntimeConnected(runtimeStatus.runtimeConnected);
      setPendingActivePlanId(next.activePlanId);
      setSelectedId(preferred?.id ?? null);
      setDraft(preferred ?? emptyPlan);
      selectContext(preferred ?? emptyPlan);
      setCreating(preferred === null);
    }).catch(error => {
      if (!controller.signal.aborted) {
        setCatalog(null);
        setRuntimeConnected(null);
        setLoadError(errorMessage(error));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => { controller.abort(); saveController.current?.abort(); };
  }, [api, connected, reloadVersion]);

  const planIdConflict = useMemo(() => creating && catalog?.plans.some(plan => plan.id === draft.id.trim()) === true, [catalog, creating, draft.id]);

  function update<Key extends keyof ChatPlan>(key: Key, value: ChatPlan[Key]): void {
    if (editingDisabled) return;
    setDraft(current => ({ ...current, [key]: value }));
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function chooseProvider(providerId: string): void {
    if (editingDisabled || !providers.some(provider => provider.enabled && provider.id === providerId)) return;
    setDraft(current => ({ ...current, provider: providerId, model: '' }));
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function updateContext(kind: 'group' | 'private', value: string): void {
    if (editingDisabled) return;
    if (kind === 'group') setGroupContext(value);
    else setPrivateContext(value);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function modelLabel(plan: ChatPlan): string {
    const provider = providers.find(provider => provider.id === plan.provider);
    const model = provider?.models.find(model => model.id === plan.model);
    return `${provider?.name ?? '未登记提供方'} · ${model?.name ?? '未登记模型'}`;
  }

  function selectPlan(plan: ChatPlan): void {
    if (dirty || editingDisabled) return;
    setSelectedId(plan.id);
    setDraft(plan);
    selectContext(plan);
    setCreating(false);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function createPlan(): void {
    if (dirty || editingDisabled) return;
    setSelectedId(null);
    setDraft(emptyPlan);
    selectContext(emptyPlan);
    setCreating(true);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function useBuiltinPlan(): void {
    if (!catalog || dirty || loading || editingDisabled) return;
    const next = createBuiltinDailyChatPlanDraft(catalog.plans, personas);
    setSelectedId(null);
    setDraft(next);
    selectContext(next);
    setCreating(true);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function reset(): void {
    setPendingActivePlanId(catalog?.activePlanId ?? null);
    if (editingDisabled) return;
    if (creating) { setDraft(emptyPlan); selectContext(emptyPlan); }
    else if (selectedPlan) { setDraft(selectedPlan); selectContext(selectedPlan); }
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  async function save(): Promise<void> {
    if (!catalog || !dirty || editingDisabled) return;
    const normalized = { ...draft, id: draft.id.trim(), name: draft.name.trim(), personaId: draft.personaId.trim(), provider: draft.provider.trim(), model: draft.model.trim(), reasoningEffort: draft.reasoningEffort.trim(), contextLimits: { group: Number(groupContext), private: Number(privateContext) } };
    if (!normalized.id || !normalized.name || !normalized.personaId || !normalized.provider || !normalized.model || !normalized.reasoningEffort) {
      setFieldError('内部标识、名称、关联人设、模型提供方、模型和思考强度必须填写。');
      return;
    }
    if (!isCatalogIdentifier(normalized.id)) {
      setFieldError(catalogIdentifierDescription);
      return;
    }
    if (planIdConflict) {
      setFieldError('内部标识已存在。');
      return;
    }
    if (!personas.some(persona => persona.id === normalized.personaId)) {
      setFieldError('请选择人设库中存在的人设。');
      return;
    }
    if (!['off', 'low', 'medium', 'high', 'max'].includes(normalized.reasoningEffort)) {
      setFieldError('请选择受支持的思考强度。');
      return;
    }
    if (!/^\d+$/.test(groupContext) || !/^\d+$/.test(privateContext)
      || !validContextLimit(normalized.contextLimits.group) || !validContextLimit(normalized.contextLimits.private)) {
      setFieldError('群聊和私聊上下文分别填写 1–16,777,216 之间的整数，单位为 token。');
      return;
    }
    if (!registeredSelection && (creating || selectedPlan === null || selectedPlan.provider !== normalized.provider || selectedPlan.model !== normalized.model)) {
      setFieldError('请先在“模型提供方”登记并启用服务与模型，再从列表选择。');
      return;
    }
    const plans = creating ? [...catalog.plans, normalized] : catalog.plans.map(plan => plan.id === selectedId ? normalized : plan);
    const activePlanId = selectedId !== null && pendingActivePlanId === selectedId && selectedId !== normalized.id ? normalized.id : pendingActivePlanId;
    const activePlan = plans.find(plan => plan.id === activePlanId);
    if (activePlanId !== catalog.activePlanId && activePlan
      && !providers.some(provider => provider.enabled && provider.id === activePlan.provider && provider.models.some(model => model.id === activePlan.model))) {
      setFieldError('启用前请先登记并启用该方案使用的提供方与模型。');
      return;
    }
    const controller = new AbortController();
    saveController.current = controller;
    setSaving(true);
    setWriteError('');
    setSaveState('idle');
    try {
      const response = await api.post('/api/chat/plans', { revision: catalog.revision, activePlanId, plans }, controller.signal);
      if (controller.signal.aborted) return;
      const next = parseCatalog(response);
      if (!next) throw new Error('invalid_chat_plans_response');
      const saved = next.plans.find(plan => plan.id === normalized.id);
      if (!saved) throw new Error('invalid_chat_plans_response');
      setCatalog(next);
      setPendingActivePlanId(next.activePlanId);
      setSelectedId(saved.id);
      setDraft(saved);
      selectContext(saved);
      setCreating(false);
      setSaveState('saved');
    } catch (error) {
      if (!controller.signal.aborted) {
        setSaveState(planError(error));
        setWriteError(errorMessage(error));
      }
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  if (!connected) return <ConnectPrompt connect={connect} />;
  if (loading && !catalog) return <Section title="聊天方案目录"><div className="flex min-h-52 items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取聊天方案</div></Section>;
  if (!catalog) return <Section title="聊天方案目录不可用" description={loadError || '服务没有返回可识别的方案目录。'} actions={<Button variant="outline" onClick={() => setReloadVersion(version => version + 1)} disabled={loading}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重试</Button>}><EmptyState locked title="原生聊天管理尚不可用" description="暂时无法读取聊天方案，请稍后重试。" /></Section>;
  const RuntimeIcon = runtimeConnected ? Server : ServerOff;

  return <div className="grid gap-5">
    <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-xs leading-5 ${runtimeConnected ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}><RuntimeIcon className={`mt-0.5 size-4 shrink-0 ${runtimeConnected ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`} /><p><strong>{runtimeConnected ? '原生聊天宿主已接入；保存仍不等于当前会话已经切换。' : '原生聊天宿主未接入，已保存方案当前不可用于真实聊天。'}</strong><span className="mt-1 block text-muted-foreground">本页维护聊天方案目录与启用指针；实际运行状态以原生宿主为准。</span></p></div>
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(14rem,0.32fr)_minmax(0,1fr)]">
      <Section scrollable title="聊天方案" description="方案把模型选择、回复指令和人设引用组装为一个可启用单元。" actions={<Button size="sm" onClick={createPlan} disabled={dirty || editingDisabled}><Plus className="size-3.5" />新建方案</Button>}>
        <div className="mb-4 grid gap-2 rounded-lg border border-dashed p-3">
          <Button size="sm" variant="outline" onClick={useBuiltinPlan} disabled={dirty || loading || editingDisabled}>使用内置日常方案</Button>
          <p className="text-xs leading-5 text-muted-foreground">通用可编辑模板，并非核心策略。只填入新的未保存草稿，不覆盖已有方案；提供方和模型需从集中目录选择，保存不会自动启用。</p>
        </div>
        <div className="min-w-0">{catalog.plans.length === 0 ? <EmptyState title="还没有聊天方案" description="创建第一份方案后，可将它选择为启用方案。" action={<Button size="sm" onClick={createPlan}><Plus className="size-3.5" />新建方案</Button>} /> : <div className="grid gap-1.5">{catalog.plans.map(plan => <Button key={plan.id} variant={!creating && selectedId === plan.id ? 'secondary' : 'ghost'} className="h-auto w-full justify-start px-3 py-2.5 text-left whitespace-normal" disabled={dirty || editingDisabled} onClick={() => selectPlan(plan)}><span className="min-w-0 flex-1"><strong className="block truncate text-xs font-medium">{plan.name}</strong><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{modelLabel(plan)}</span></span>{pendingActivePlanId === plan.id && <Badge variant="outline"><Check className="size-3" />启用</Badge>}</Button>)}</div>}</div>
      </Section>
      <Section scrollable title={creating ? '新建聊天方案' : draft.name || '聊天方案'} description="选择关联人设后，再设置模型与方案指令；能力、访问授权和用户偏好仍分别管理。" actions={<StatusPill tone={pendingActivePlanId === draft.id && draft.id !== '' ? 'success' : 'neutral'}>{pendingActivePlanId === draft.id && draft.id !== '' ? '已选择启用' : '未选择启用'}</StatusPill>} footer={<SaveBar dirty={dirty} saving={saving} disabled={blocked} message={saveMessage(saveState, dirty)} onSave={() => void save()} onReset={reset} label="保存聊天方案"><Button type="button" variant="outline" disabled={creating || !draft.id || pendingActivePlanId === draft.id || editingDisabled || !registeredSelection} onClick={() => { setPendingActivePlanId(draft.id); setSaveState('idle'); }}><Check className="size-3.5" />选择为启用方案</Button></SaveBar>}>
        <div className="grid gap-5">
          <div className="grid gap-5 sm:grid-cols-2"><Field label="内部标识" description={creating ? '用于稳定关联，创建后不可修改。' : '现有内部标识不可修改。'}><Input value={draft.id} disabled={!creating || editingDisabled} maxLength={128} placeholder="daily-chat" onChange={event => update('id', event.target.value)} /></Field><Field label="方案名称"><Input value={draft.name} disabled={editingDisabled} maxLength={128} placeholder="日常聊天" onChange={event => update('name', event.target.value)} /></Field></div>
          <Field label="方案说明" description="只说明用途，不作为模型指令。"><Input value={draft.description} disabled={editingDisabled} maxLength={500} placeholder="用于日常群聊与私聊" onChange={event => update('description', event.target.value)} /></Field>
          <Field label="方案指令" description="只放本方案的回复约束；人设正文、能力权限和用户偏好在各自页面管理。"><Textarea value={draft.instructions} disabled={editingDisabled} className="h-44 resize-none leading-6" placeholder="描述这份聊天方案如何组织回复" onChange={event => update('instructions', event.target.value)} /></Field>
          {creating && !draft.personaId && <p className="text-xs leading-5 text-muted-foreground" role="status">尚未关联人设：可先在人设库使用内置小鲸鱼并保存，或选择其他已登记人设。模板不会自动创建人设。</p>}
          <div className="grid gap-5 sm:grid-cols-2"><Field label="关联人设" description="身份与表达风格在人设库中独立维护。"><div className="flex gap-2"><select className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm" value={draft.personaId} disabled={editingDisabled || personas.length === 0} onChange={event => update('personaId', event.target.value)}><option value="" disabled>{personas.length === 0 ? '请先创建人设' : '选择人设'}</option>{personas.map(persona => <option key={persona.id} value={persona.id}>{persona.name}</option>)}</select><Button type="button" variant="outline" onClick={() => navigate('persona')}>管理人设</Button></div></Field><Field label="思考强度"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={draft.reasoningEffort} disabled={editingDisabled} onChange={event => update('reasoningEffort', event.target.value)}><option value="" disabled>选择思考强度</option><option value="off">关闭额外推理</option><option value="low">较低</option><option value="medium">均衡</option><option value="high">深入</option><option value="max">最高</option></select></Field></div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="模型提供方" description="连接类型、服务地址、密钥与模型只需集中配置一次。"><div className="flex gap-2"><select className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm" value={draft.provider} disabled={editingDisabled} onChange={event => chooseProvider(event.target.value)}><option value="" disabled>选择模型提供方</option>{draft.provider && !selectedProvider && <option value={draft.provider} disabled>未登记的提供方</option>}{providers.filter(provider => provider.enabled || provider.id === draft.provider).map(provider => <option key={provider.id} value={provider.id} disabled={!provider.enabled}>{provider.name}{provider.enabled ? '' : '（已停用）'}</option>)}</select><Button type="button" variant="outline" onClick={() => navigate('providers')}>管理提供方</Button></div></Field>
            <Field label="模型" description="显示在提供方页面设置的模型名称，不用重复填写 API 标识。"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={draft.model} disabled={editingDisabled || !selectedProvider?.enabled} onChange={event => update('model', event.target.value)}><option value="" disabled>{selectedProvider ? '选择模型' : '先选择提供方'}</option>{draft.model && !selectedModel && <option value={draft.model} disabled>未登记的模型</option>}{selectedProvider?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></Field>
          </div>
          {!registeredSelection && <div className="rounded-lg border border-dashed px-3 py-2.5 text-xs leading-5 text-muted-foreground">{draft.provider ? '这份方案的提供方或模型尚未登记、已停用。原有内容会保留，请在“模型提供方”补齐后再启用。' : '先在“模型提供方”添加连接和模型，再回来选择。'}</div>}
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="群聊上下文" description="每个群聊会话的上下文上限，单位 token。"><Input type="number" min={1} max={16_777_216} step={1} inputMode="numeric" value={groupContext} disabled={editingDisabled} onChange={event => updateContext('group', event.target.value)} /></Field>
            <Field label="私聊上下文" description="每个私聊会话的上下文上限，独立于群聊设置。"><Input type="number" min={1} max={16_777_216} step={1} inputMode="numeric" value={privateContext} disabled={editingDisabled} onChange={event => updateContext('private', event.target.value)} /></Field>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">上下文数值保存在本方案中；聊天引擎接入后仍需支持并应用这些限制，不能超过实际模型的可用窗口。</p>
          {fieldError && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />{fieldError}</div>}
          {writeError && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><span>{writeError}</span>{(saveState === 'busy' || saveState === 'conflict' || saveState === 'unknown') && <Button size="sm" variant="outline" onClick={() => setReloadVersion(version => version + 1)}>重新载入</Button>}</div>}
        </div>
      </Section>
    </div>
    <Section title="应用边界" description="目录保存与聊天宿主应用是两个独立状态。" actions={<div className="flex items-center gap-2"><StatusPill tone={runtimeConnected ? 'success' : 'warning'}>{runtimeConnected ? '原生宿主已接入' : '原生宿主未接入'}</StatusPill><Button variant="outline" onClick={() => setReloadVersion(version => version + 1)} disabled={loading || saving || dirty}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新载入目录</Button></div>}>
      <div className="grid gap-3 text-xs leading-6 text-muted-foreground sm:grid-cols-2"><p><Save className="mr-2 inline size-3.5" /><strong className="text-foreground">已保存：</strong>方案已保存到本机，其他窗口的更改不会被静默覆盖。</p><p><ServerOff className="mr-2 inline size-3.5" /><strong className="text-foreground">是否运行：</strong>原生聊天宿主接入后，才会使用选中的启用方案。</p></div>
    </Section>
  </div>;
}
