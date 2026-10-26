import { SettingsWindow } from './settings-window.tsx';
import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { catalogFailureState } from '../lib/native-catalog-operation.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import { catalogIdentifierDescription, isCatalogIdentifier, newCatalogIdentifier } from '../lib/catalog-identifier.ts';
import { sameCapabilitySelection } from '../lib/chat-capability-ui.ts';
import type { PageProps } from '../lib/types.ts';
import { ConnectPrompt, EmptyState, Field, PageHeading, SaveBar, Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Textarea } from './ui/textarea.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.tsx';
import { ProviderManager } from './provider-manager.tsx';
import { createBuiltinDailyChatPlanDraft } from '../../src/host/chat-templates.ts';
import { HelpTip } from './help-tip.tsx';
import { DshDeploymentManager, type PreparedChatConfiguration } from './dsh-deployment-manager.tsx';
import { modelCapabilitiesUnavailableMessage, modelReasoningEffortLabel, modelReasoningEffortOptions, parseModelCapabilities, type ModelCapabilities } from '../lib/model-capabilities.ts';

import { CHAT_PLAN_LIMITS, DEFAULT_CHAT_CONTEXT_LIMITS, isChatContextLimit, isChatPlanReasoningEffort } from '../../src/contracts/chat-plans.ts';
import { parsePlan, parsePlanCatalog, type ChatPlanCatalogSnapshot, type ChatPlanDraft } from '../lib/chat-plans.ts';
export { parsePlan } from '../lib/chat-plans.ts';
export type { NormalizedChatPlan as ChatPlan } from '../../src/contracts/chat-plans.ts';

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

function PlanField({ id, label, tip, stacked = false, children }: { readonly id: string; readonly label: string; readonly tip?: string; readonly stacked?: boolean; readonly children: ReactNode }) {
  return <Field id={id} label={label} tip={tip} layout={stacked ? 'stacked' : 'inline'}>{children}</Field>;
}

const emptyPlan: ChatPlanDraft = {
  id: '', name: '', description: '', instructions: '', personaId: '', provider: '', model: '', reasoningEffort: '',
  contextLimits: DEFAULT_CHAT_CONTEXT_LIMITS,
};

const textKeys = ['id', 'name', 'description', 'instructions', 'personaId', 'provider', 'model', 'reasoningEffort'] as const;

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

function samePlan(left: ChatPlanDraft, right: ChatPlanDraft): boolean {
  return textKeys.every(key => left[key] === right[key])
    && Object.hasOwn(left, 'capabilitySelection') === Object.hasOwn(right, 'capabilitySelection')
    && sameCapabilitySelection(left.capabilitySelection, right.capabilitySelection)
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
  return catalogFailureState(error);
}

function saveMessage(state: SaveState, dirty: boolean): string {
  if (state === 'saved') return '已保存。';
  if (state === 'busy') return '另一项保存正在进行，请稍后重新载入后再提交；不会自动重试。';
  if (state === 'conflict') return '方案已在其他窗口更新，请重新载入后再编辑。';
  if (state === 'unknown') return '无法确认保存结果，请重新载入核对，不会自动重试。';
  return dirty ? '未保存。' : '与已保存的方案一致。';
}

const planDraftKey = createDraftKey<{
  readonly catalog: ChatPlanCatalogSnapshot; readonly draft: ChatPlanDraft; readonly selectedId: string | null;
  readonly creating: boolean; readonly groupContext: string; readonly privateContext: string; readonly pendingActivePlanId: string | null;
  readonly creationId: string; readonly contextTouched: { readonly group: boolean; readonly private: boolean };
}>('chat-plans');

export function ChatPlanManager(props: PageProps & { readonly children?: ReactNode; readonly compact?: boolean }) {
  const { api, connected, connect, setDirty, navigate } = props;
  const recovery = useNativeCatalogOperation(api, 'plans');
  const retained = useMemo(() => retainedDraft(api, planDraftKey), [api]);
  const draftApi = useRef(api);
  const [catalog, setCatalog] = useState<ChatPlanCatalogSnapshot | null>(retained?.catalog ?? null);
  const [personas, setPersonas] = useState<readonly PersonaOption[]>([]);
  const [providers, setProviders] = useState<readonly ProviderOption[]>([]);
  const [runtimeConnected, setRuntimeConnected] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(retained?.selectedId ?? null);
  const [draft, setDraft] = useState<ChatPlanDraft>(retained?.draft ?? emptyPlan);
  const [groupContext, setGroupContext] = useState(retained?.groupContext ?? String(emptyPlan.contextLimits.group));
  const [privateContext, setPrivateContext] = useState(retained?.privateContext ?? String(emptyPlan.contextLimits.private));
  const [contextTouched, setContextTouched] = useState(retained?.contextTouched ?? { group: false, private: false });
  const [creating, setCreating] = useState(retained?.creating ?? false);
  const [creationDialogOpen, setCreationDialogOpen] = useState(false);
  const [creationId, setCreationId] = useState(retained?.creationId ?? '');
  const [pendingActivePlanId, setPendingActivePlanId] = useState<string | null>(retained?.pendingActivePlanId ?? null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updatingChat, setUpdatingChat] = useState(false);
  const updateOwner = useRef<symbol | null>(null);
  const [loadError, setLoadError] = useState('');
  const [auxiliaryWarnings, setAuxiliaryWarnings] = useState<readonly string[]>([]);
  const [writeError, setWriteError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [reloadVersion, setReloadVersion] = useState(0);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [modelEditorOpen, setModelEditorOpen] = useState(false);
  const [capabilitiesReload, setCapabilitiesReload] = useState(0);
  const [capabilitiesView, setCapabilitiesView] = useState<{
    readonly api: PageProps['api']; readonly generation: number; readonly provider: string; readonly model: string;
    readonly value: ModelCapabilities | null; readonly loading: boolean; readonly error: string;
  } | null>(null);
  const capabilitiesEpoch = useRef(0);
  const capabilitiesController = useRef<AbortController | null>(null);
  const deletionTarget = useRef<string | null>(null);
  const selectedOwner = useRef<string | null>(null);
  const reportedDirty = useRef(false);
  const saveController = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const operationBlocked = useRef(false);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const setDirtyRef = useRef(setDirty);
  const selectedPlan = catalog?.plans.find(plan => plan.id === selectedId) ?? null;
  const contextBaseline = creating ? emptyPlan.contextLimits : selectedPlan?.contextLimits ?? emptyPlan.contextLimits;
  const contextDirty = groupContext !== String(contextBaseline.group) || privateContext !== String(contextBaseline.private);
  const draftDirty = creating
    ? textKeys.some(key => key === 'id' ? draft.id !== creationId : draft[key].trim() !== '') || Object.hasOwn(draft, 'capabilitySelection')
    : selectedPlan !== null && !samePlan(draft, selectedPlan);
  const activeDirty = catalog !== null && pendingActivePlanId !== catalog.activePlanId;
  const dirty = draftDirty || activeDirty || contextDirty;
  const draftOwner = useRef({ api, catalog, draft, creating, selectedId, groupContext, privateContext, pendingActivePlanId, dirty });
  draftOwner.current = { api: draftApi.current, catalog, draft, creating, selectedId, groupContext, privateContext, pendingActivePlanId, dirty };
  const blocked = recovery.blocked || saveState === 'busy' || saveState === 'conflict' || saveState === 'unknown';
  const editingDisabled = saving || blocked || loading || updatingChat;
  const selectedProvider = providers.find(provider => provider.id === draft.provider);
  const selectedModel = selectedProvider?.models.find(model => model.id === draft.model);
  const registeredSelection = selectedProvider?.enabled === true && selectedModel !== undefined;
  const hasCatalog = catalog !== null;
  const currentCapabilities = connected && capabilitiesView?.api === api && capabilitiesView.generation === capabilitiesEpoch.current
    && capabilitiesView.provider === draft.provider && capabilitiesView.model === draft.model ? capabilitiesView : null;
  const supportedEfforts = currentCapabilities?.value?.state === 'available' ? currentCapabilities.value.reasoningEfforts : [];
  const reasoningOptions = modelReasoningEffortOptions(currentCapabilities?.value ?? null, draft.reasoningEffort);
  const effortSupported = supportedEfforts.some(effort => effort === draft.reasoningEffort);
  const reasoningSupport = !draft.provider || !draft.model ? '先选择提供方和模型，再读取实际支持档位。'
    : currentCapabilities?.value?.state === 'available' ? `当前模型支持：${supportedEfforts.map(modelReasoningEffortLabel).join('、')}。`
      : currentCapabilities?.loading || !currentCapabilities ? '正在读取当前模型支持的档位…'
        : currentCapabilities.error || modelCapabilitiesUnavailableMessage(currentCapabilities.value?.missingReasons ?? []);
  const deletionBlockedReason = editingDisabled ? '正在读取、保存或等待结果核对，暂不能删除。'
    : selectedPlan?.id === catalog?.activePlanId ? catalog?.plans.length === 1 ? '当前只有这一份启用方案，请先新建方案并切换启用，再删除。' : '当前方案正在启用，请先选择其他方案启用并保存。'
      : dirty ? '请先保存或撤销当前更改，再删除。'
        : '删除这个未启用方案，当前聊天继续运行。';

  function invalidateCapabilities(): void {
    capabilitiesEpoch.current++;
    capabilitiesController.current?.abort();
    capabilitiesController.current = null;
    setCapabilitiesView(null);
    setCapabilitiesReload(current => current + 1);
  }

  function selectContext(plan: ChatPlanDraft): void {
    setContextTouched({ group: plan.contextLimits.group !== emptyPlan.contextLimits.group, private: plan.contextLimits.private !== emptyPlan.contextLimits.private });
    setGroupContext(String(plan.contextLimits.group));
    setPrivateContext(String(plan.contextLimits.private));
  }

  useEffect(() => {
    if (draftApi.current !== api) return;
    retainDraft(api, planDraftKey, connected && dirty && catalog ? { catalog, draft, selectedId, creating, creationId, groupContext, privateContext, pendingActivePlanId, contextTouched } : null);
  }, [api, connected, dirty, catalog, draft, selectedId, creating, creationId, groupContext, privateContext, pendingActivePlanId, contextTouched]);
  useEffect(() => { setDirtyRef.current = setDirty; }, [setDirty]);
  useEffect(() => {
    if (reportedDirty.current === dirty) return;
    reportedDirty.current = dirty;
    setDirty(dirty, 'chat-plans');
  }, [dirty, setDirty]);
  useEffect(() => () => {
    epoch.current++;
    saveController.current?.abort();
    reportedDirty.current = false;
    setDirtyRef.current(false, 'chat-plans');
  }, []);

  useEffect(() => {
    const generation = ++epoch.current;
    setSaving(false);
    if (!connected) {
      setCatalog(null);
      setRuntimeConnected(null);
      setSelectedId(null);
      setDraft(emptyPlan);
      selectContext(emptyPlan);
      setProviders([]);
      setCreating(false); setCreationDialogOpen(false);
      setLoadError('');
      return;
    }
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && generation === epoch.current
      && connection.current.api === api && connection.current.connected;
    setLoading(true);
    setLoadError('');
    setWriteError('');
    setSaveState('idle');
    const prior = draftOwner.current.api === api ? draftOwner.current : null;
    draftApi.current = api;
    if (!prior) { setCatalog(null); setDraft(emptyPlan); setSelectedId(null); setPersonas([]); setProviders([]); }
    const preserveDraft = prior?.catalog !== null && prior?.dirty === true;
    setAuxiliaryWarnings([]);
    const warn = (message: string) => { if (current()) setAuxiliaryWarnings(previous => [...new Set([...previous, message])]); };
    void readResource(api, '/api/chat/personas', controller.signal).then(value => {
      if (!current()) return;
      const next = parsePersonaOptions(value);
      if (!next) throw new Error('invalid_plan_personas');
      setPersonas(next);
    }).catch(() => warn('人设目录暂未读到，方案草稿保留；读取成功后可更换人设。'));
    void readResource(api, '/api/chat/providers', controller.signal, reloadVersion === 0 ? 1_000 : 0).then(value => {
      if (!current()) return;
      const next = parseProviderOptions(value);
      if (!next) throw new Error('invalid_plan_providers');
      setProviders(next);
    }).catch(() => warn('模型目录暂未读到，方案草稿保留；读取成功后可更换模型。'));
    void readResource(api, '/api/chat/status', controller.signal).then(value => {
      if (!current()) return;
      const status = asRecord(value);
      if (typeof status.runtimeConnected !== 'boolean') throw new Error('invalid_plan_runtime_status');
      setRuntimeConnected(status.runtimeConnected);
    }).catch(() => { if (current()) setRuntimeConnected(null); warn('聊天运行状态暂未确认，方案编辑仍可继续。'); });
    void readResource(api, '/api/chat/plans', controller.signal).then(value => {
      if (!current()) return;
      const next = parsePlanCatalog(value);
      if (!next) throw new Error('invalid_chat_plans_response');
      setCatalog(next);
      recovery.review();
      operationBlocked.current = false;
      if (preserveDraft && prior) {
        setCreating(prior.creating || !next.plans.some(plan => plan.id === prior.draft.id));
        selectedOwner.current = prior.selectedId;
      } else {
        const preferred = next.plans.find(plan => plan.id === next.activePlanId) ?? next.plans[0] ?? null;
        setPendingActivePlanId(next.activePlanId); setSelectedId(preferred?.id ?? null);
        selectedOwner.current = preferred?.id ?? null;
        const initial = preferred ?? { ...emptyPlan, id: newCatalogIdentifier('plan') };
        setCreationId(preferred ? '' : initial.id);
        setDraft(initial); selectContext(initial); setCreating(preferred === null);
      }
      deletionTarget.current = null; setDeleteConfirmed(false);
    }).catch(error => {
      if (current()) {
        if (!prior?.catalog) setCatalog(null);
        setLoadError(errorMessage(error));
      }
    }).finally(() => { if (current()) setLoading(false); });
    return () => { controller.abort(); epoch.current++; saveController.current?.abort(); saveController.current = null; };
  }, [api, connected, reloadVersion]);

  useEffect(() => {
    const generation = ++capabilitiesEpoch.current;
    const editorEpoch = epoch.current;
    capabilitiesController.current?.abort();
    capabilitiesController.current = null;
    setCapabilitiesView(null);
    if (!connected || loading || !hasCatalog || !draft.provider || !draft.model) return;
    const controller = new AbortController();
    capabilitiesController.current = controller;
    const provider = draft.provider;
    const model = draft.model;
    const current = () => !controller.signal.aborted && capabilitiesEpoch.current === generation && epoch.current === editorEpoch
      && capabilitiesController.current === controller && connection.current.api === api && connection.current.connected;
    setCapabilitiesView({ api, generation, provider, model, value: null, loading: true, error: '' });
    void readResource(api, `/api/chat/model-capabilities?${new URLSearchParams({ provider, model })}`, controller.signal).then(value => {
      if (!current()) return;
      const parsed = parseModelCapabilities(value);
      if (!parsed || parsed.provider !== provider || parsed.model !== model) throw new Error('invalid_model_capabilities');
      setCapabilitiesView({ api, generation, provider, model, value: parsed, loading: false, error: '' });
    }).catch(() => {
      if (current()) setCapabilitiesView({ api, generation, provider, model, value: null, loading: false, error: '暂时无法读取当前模型支持的档位，请重新读取。' });
    }).finally(() => {
      if (capabilitiesController.current === controller) capabilitiesController.current = null;
    });
    return () => { controller.abort(); capabilitiesEpoch.current++; if (capabilitiesController.current === controller) capabilitiesController.current = null; };
  }, [api, connected, loading, hasCatalog, draft.provider, draft.model, capabilitiesReload, reloadVersion]);

  const capacity = currentCapabilities?.value?.capacity;
  useEffect(() => {
    if (!creating || editingDisabled || !capacity) return;
    if (!contextTouched.group) setGroupContext(String(capacity.recommended.group));
    if (!contextTouched.private) setPrivateContext(String(capacity.recommended.private));
  }, [creating, editingDisabled, capacity, contextTouched.group, contextTouched.private]);

  const planIdConflict = useMemo(() => creating && catalog?.plans.some(plan => plan.id === draft.id.trim()) === true, [catalog, creating, draft.id]);

  function update<Key extends keyof ChatPlanDraft>(key: Key, value: ChatPlanDraft[Key]): void {
    if (editingDisabled) return;
    if (key === 'model' || key === 'provider') invalidateCapabilities();
    setDraft(current => ({ ...current, [key]: value }));
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function chooseProvider(providerId: string): void {
    if (editingDisabled || !providers.some(provider => provider.enabled && provider.id === providerId)) return;
    invalidateCapabilities();
    setDraft(current => ({ ...current, provider: providerId, model: '' }));
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function chooseReasoningEffort(value: string): void {
    if (!currentCapabilities || currentCapabilities.generation !== capabilitiesEpoch.current
      || !registeredSelection || !supportedEfforts.some(effort => effort === value)) return;
    const effort = supportedEfforts.find(effort => effort === value);
    if (effort) update('reasoningEffort', effort);
  }

  function updateContext(kind: 'group' | 'private', value: string): void {
    if (editingDisabled) return;
    setContextTouched(current => ({ ...current, [kind]: true }));
    if (kind === 'group') setGroupContext(value);
    else setPrivateContext(value);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function modelLabel(plan: ChatPlanDraft): string {
    const provider = providers.find(provider => provider.id === plan.provider);
    const model = provider?.models.find(model => model.id === plan.model);
    return `${provider?.name ?? '未登记提供方'} · ${model?.name ?? '未登记模型'}`;
  }

  function selectPlan(plan: ChatPlanDraft): void {
    if (dirty || editingDisabled) return;
    invalidateCapabilities();
    selectedOwner.current = plan.id;
    deletionTarget.current = null;
    setSelectedId(plan.id);
    setDraft(plan);
    selectContext(plan);
    setCreating(false);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
    setDeleteConfirmed(false);
  }

  function createPlan(): void {
    if (dirty || editingDisabled) return;
    invalidateCapabilities();
    selectedOwner.current = null;
    deletionTarget.current = null;
    setSelectedId(null);
    const id = newCatalogIdentifier('plan');
    setCreationId(id);
    setCreationDialogOpen(true);
    setDraft({ ...emptyPlan, id });
    selectContext(emptyPlan);
    setCreating(true);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function useBuiltinPlan(): void {
    if (!catalog || dirty || loading || editingDisabled) return;
    invalidateCapabilities();
    const next = createBuiltinDailyChatPlanDraft(catalog.plans, personas);
    setCreationId('');
    selectedOwner.current = null;
    deletionTarget.current = null;
    setSelectedId(null);
    setCreationDialogOpen(true);
    setDraft(next);
    selectContext(next);
    setCreating(true);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function reset(): void {
    deletionTarget.current = null;
    setDeleteConfirmed(false);
    setPendingActivePlanId(catalog?.activePlanId ?? null);
    if (editingDisabled) return;
    invalidateCapabilities();
    if (creating) { setDraft({ ...emptyPlan, id: creationId || draft.id }); setCreationId(creationId || draft.id); selectContext(emptyPlan); }
    else if (selectedPlan) { setDraft(selectedPlan); selectContext(selectedPlan); }
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  async function save(options: { readonly activate?: boolean; readonly signal?: AbortSignal } = {}): Promise<ChatPlanCatalogSnapshot | null> {
    if (!catalog || catalogRef.current !== catalog || saving || blocked || loading || updatingChat && !options.activate || operationBlocked.current || saveController.current || connection.current.api !== api || !connection.current.connected) return null;
    if (!dirty && (!options.activate || catalog.activePlanId === draft.id)) return catalog;
    const normalized = { ...draft, id: draft.id.trim(), name: draft.name.trim(), personaId: draft.personaId.trim(), provider: draft.provider.trim(), model: draft.model.trim(), reasoningEffort: draft.reasoningEffort, contextLimits: { group: Number(groupContext), private: Number(privateContext) } };
    if (!normalized.id || !normalized.name || !normalized.personaId || !normalized.provider || !normalized.model || !normalized.reasoningEffort) {
      setFieldError('内部标识、名称、关联人设、模型提供方、模型和思考强度必须填写。');
      return null;
    }
    if (!isCatalogIdentifier(normalized.id)) {
      setFieldError(catalogIdentifierDescription);
      return null;
    }
    if (planIdConflict) {
      setFieldError('内部标识已存在。');
      return null;
    }
    if (!personas.some(persona => persona.id === normalized.personaId)) {
      setFieldError('请选择人设库中存在的人设。');
      return null;
    }
    if (!isChatPlanReasoningEffort(normalized.reasoningEffort)) {
      setFieldError('请选择受支持的思考强度。');
      return null;
    }
    if (!/^\d+$/.test(groupContext) || !/^\d+$/.test(privateContext)
      || !isChatContextLimit(normalized.contextLimits.group) || !isChatContextLimit(normalized.contextLimits.private)) {
      setFieldError('群聊和私聊上下文分别填写 1–16,777,216 之间的整数，单位为 token。');
      return null;
    }
    if (!registeredSelection && (creating || selectedPlan === null || selectedPlan.provider !== normalized.provider || selectedPlan.model !== normalized.model)) {
      setFieldError('请先在“模型提供方”登记并启用服务与模型，再从列表选择。');
      return null;
    }
    if (!parsePlan(normalized)) {
      setFieldError('方案字段超出长度限制或格式无效，请检查后再保存。');
      return null;
    }
    const capabilitiesConfirmed = currentCapabilities !== null && currentCapabilities.generation === capabilitiesEpoch.current
      && currentCapabilities.value?.state === 'available' && currentCapabilities.provider === normalized.provider
      && currentCapabilities.model === normalized.model && currentCapabilities.value.reasoningEfforts.some(effort => effort === normalized.reasoningEffort);
    const capabilitiesUnknown = currentCapabilities === null || currentCapabilities.generation !== capabilitiesEpoch.current
      || currentCapabilities.value?.state !== 'available';
    const preservingUnknownModel = capabilitiesUnknown && !creating && selectedPlan !== null
      && selectedPlan.provider === normalized.provider && selectedPlan.model === normalized.model
      && selectedPlan.reasoningEffort === normalized.reasoningEffort && (options.activate ? normalized.id : pendingActivePlanId) === catalog.activePlanId;
    if (!capabilitiesConfirmed && !preservingUnknownModel) {
      setFieldError('请先确认当前模型的支持情况，并明确选择该模型支持的思考强度；原草稿值会保留。');
      return null;
    }
    const plans = creating ? [...catalog.plans, normalized] : catalog.plans.map(plan => plan.id === selectedId ? normalized : plan);
    const activePlanId = options.activate ? normalized.id : selectedId !== null && pendingActivePlanId === selectedId && selectedId !== normalized.id ? normalized.id : pendingActivePlanId;
    const activePlan = plans.find(plan => plan.id === activePlanId);
    if (activePlanId !== catalog.activePlanId && activePlan
      && !providers.some(provider => provider.enabled && provider.id === activePlan.provider && provider.models.some(model => model.id === activePlan.model))) {
      setFieldError('启用前请先登记并启用该方案使用的提供方与模型。');
      return null;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) return null;
    options.signal?.addEventListener('abort', abort, { once: true });
    const generation = epoch.current;
    saveController.current = controller;
    const operationToken = recovery.begin(catalog.revision, controller.signal);
    if (!operationToken) { saveController.current = null; options.signal?.removeEventListener('abort', abort); return null; }
    const current = () => !controller.signal.aborted && epoch.current === generation && saveController.current === controller
      && connection.current.api === api && connection.current.connected;
    setSaving(true);
    setWriteError('');
    setSaveState('idle');
    try {
      const response = await writeResource(api, '/api/chat/plans', { revision: catalog.revision, activePlanId, plans }, controller.signal);
      if (!current()) return null;
      const next = parsePlanCatalog(response);
      if (!next || next.activePlanId !== activePlanId) throw new Error('invalid_chat_plans_response');
      const saved = next.plans.find(plan => plan.id === normalized.id);
      if (!saved) throw new Error('invalid_chat_plans_response');
      catalogRef.current = next;
      setCatalog(next);
      setPendingActivePlanId(next.activePlanId);
      setSelectedId(saved.id);
      selectedOwner.current = saved.id;
      deletionTarget.current = null;
      setDraft(saved);
      selectContext(saved);
      setCreating(false); setCreationDialogOpen(false);
      setDeleteConfirmed(false);
      recovery.complete(operationToken);
      setSaveState('saved');
      return next;
    } catch (error) {
      recovery.fail(operationToken, error);
      if (current()) {
        const failureState = planError(error);
        operationBlocked.current = failureState !== 'idle';
        setSaveState(failureState);
        setWriteError(errorMessage(error));
      }
      return null;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (current()) { setSaving(false); saveController.current = null; }
    }
  }

  async function prepareChatUpdate(signal: AbortSignal): Promise<PreparedChatConfiguration | null> {
    if (updateOwner.current || editingDisabled || !catalog || !draft.id) return null;
    const token = Symbol('plan-update');
    const generation = epoch.current;
    const submitted = draftOwner.current;
    updateOwner.current = token;
    setUpdatingChat(true);
    const complete = () => {
      if (updateOwner.current !== token) return;
      updateOwner.current = null;
      setUpdatingChat(false);
    };
    try {
      const next = await save({ activate: true, signal });
      const savedPlan = next?.plans.find(plan => plan.id === next.activePlanId);
      if (!next || !savedPlan || savedPlan.id !== submitted.draft.id.trim() || signal.aborted) { complete(); return null; }
      const isCurrent = () => {
        const owner = draftOwner.current;
        const unchangedSubmission = owner.draft === submitted.draft && owner.groupContext === submitted.groupContext
          && owner.privateContext === submitted.privateContext && owner.selectedId === submitted.selectedId;
        const committedSubmission = samePlan(owner.draft, savedPlan) && owner.groupContext === String(savedPlan.contextLimits.group)
          && owner.privateContext === String(savedPlan.contextLimits.private) && owner.selectedId === savedPlan.id;
        return !signal.aborted && updateOwner.current === token && epoch.current === generation && catalogRef.current === next
          && connection.current.api === api && connection.current.connected && (unchangedSubmission || committedSubmission);
      };
      return { revision: next.revision, isCurrent, complete };
    } catch (failure) { complete(); throw failure; }
  }

  async function deletePlan(): Promise<void> {
    if (!catalog || catalogRef.current !== catalog || !selectedPlan || selectedOwner.current !== selectedPlan.id
      || deletionTarget.current !== selectedPlan.id || creating || dirty || editingDisabled || operationBlocked.current || saveController.current || !deleteConfirmed
      || selectedPlan.id === catalog.activePlanId || connection.current.api !== api || !connection.current.connected) return;
    const controller = new AbortController();
    const generation = epoch.current;
    saveController.current = controller;
    const operationToken = recovery.begin(catalog.revision, controller.signal);
    if (!operationToken) { saveController.current = null; return; }
    const current = () => !controller.signal.aborted && epoch.current === generation && saveController.current === controller
      && connection.current.api === api && connection.current.connected;
    setSaving(true); setWriteError('');
    try {
      const value = await writeResource(api, '/api/chat/plans', { revision: catalog.revision, activePlanId: catalog.activePlanId,
        plans: catalog.plans.filter(plan => plan.id !== selectedPlan.id) }, controller.signal);
      if (!current()) return;
      const next = parsePlanCatalog(value);
      if (!next || next.activePlanId !== catalog.activePlanId || next.plans.some(plan => plan.id === selectedPlan.id)) throw new Error('invalid_chat_plan_deletion');
      const preferred = next.plans.find(plan => plan.id === next.activePlanId) ?? next.plans[0] ?? null;
      recovery.complete(operationToken);
      setCatalog(next); setPendingActivePlanId(next.activePlanId); setSelectedId(preferred?.id ?? null);
      selectedOwner.current = preferred?.id ?? null; deletionTarget.current = null;
      setDraft(preferred ?? emptyPlan); selectContext(preferred ?? emptyPlan); setCreating(preferred === null);
      setDeleteConfirmed(false); setSaveState('saved');
    } catch (failure) {
      recovery.fail(operationToken, failure);
      if (current()) {
        const failureState = planError(failure);
        operationBlocked.current = failureState !== 'idle';
        setSaveState(failureState);
        setWriteError(failure instanceof ApiError && /in_use|active|busy/.test(failure.code)
          ? '方案仍在使用、处于启用状态或聊天操作尚未结束。请先处理引用并重新核对；不会自动切换方案或清空会话。' : errorMessage(failure));
      }
    } finally {
      if (current()) { setSaving(false); saveController.current = null; }
    }
  }

  const editorFields = <div className="grid gap-2">
        <div className="formgrid three">
          <PlanField id="chat-plan-name" label={nativeFormMetadata.plan.fields.name}><Input id="chat-plan-name" value={draft.name} disabled={editingDisabled} maxLength={CHAT_PLAN_LIMITS.name} placeholder="日常聊天" onChange={event => update('name', event.target.value)} /></PlanField>
          <PlanField id="chat-plan-description" label={nativeFormMetadata.plan.fields.description} tip="可选，只说明用途，不作为模型指令。"><Input id="chat-plan-description" value={draft.description} disabled={editingDisabled} maxLength={CHAT_PLAN_LIMITS.description} placeholder="用于日常群聊与私聊（可选）" onChange={event => update('description', event.target.value)} /></PlanField>
          <PlanField id="chat-plan-persona" label={nativeFormMetadata.plan.fields.persona} tip="身份与表达风格在人设库中独立维护。"><div className="flex items-center gap-2"><select id="chat-plan-persona" className="h-[27px] min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" value={draft.personaId} disabled={editingDisabled || personas.length === 0} onChange={event => update('personaId', event.target.value)}><option value="" disabled>{personas.length === 0 ? '请先创建人设' : '选择人设'}</option>{personas.map(persona => <option key={persona.id} value={persona.id}>{persona.name}</option>)}</select><Button type="button" size="sm" variant="outline" aria-label="管理人设" onClick={() => navigate('persona')}>管理</Button></div></PlanField>
        </div>
        {creating && <SettingsWindow title="内部标识" description="已自动生成；只在关联现有配置时需要修改。"><div className="mt-3 max-w-sm"><PlanField id="chat-plan-id" label={nativeFormMetadata.plan.fields.id} tip="已自动生成，通常无需修改。需要兼容既有引用时可调整；创建后固定。"><Input id="chat-plan-id" value={draft.id} disabled={!creating || editingDisabled} maxLength={CHAT_PLAN_LIMITS.identifier} onChange={event => update('id', event.target.value)} /></PlanField></div></SettingsWindow>}
        {creating && !draft.personaId && <p className="text-xs leading-5 text-muted-foreground" role="status">尚未关联人设：可先在人设库使用内置小鲸鱼并保存，或选择其他已登记人设。模板不会自动创建人设。</p>}
        <div className="border-y -mx-2.5 px-2.5 py-2"><div className="row between mb-1.5"><h3 className="text-xs font-semibold">模型与回复</h3><div className="row"><Button size="sm" variant="outline" disabled={editingDisabled} onClick={() => setModelEditorOpen(true)}>就地选择或添加模型</Button><Button size="sm" variant="ghost" onClick={() => navigate('persona')}>管理人设</Button></div></div>
        <div className="formgrid three">
          <PlanField id="chat-plan-provider" label={nativeFormMetadata.plan.fields.provider} tip="连接类型、服务地址、密钥与模型只需集中配置一次。"><div className="flex items-center gap-2"><select id="chat-plan-provider" className="h-[27px] min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" value={draft.provider} disabled={editingDisabled} onChange={event => chooseProvider(event.target.value)}><option value="" disabled>选择模型提供方</option>{draft.provider && !selectedProvider && <option value={draft.provider} disabled>未登记的提供方</option>}{providers.filter(provider => provider.enabled || provider.id === draft.provider).map(provider => <option key={provider.id} value={provider.id} disabled={!provider.enabled}>{provider.name}{provider.enabled ? '' : '（已停用）'}</option>)}</select><Button type="button" size="sm" variant="outline" aria-label="管理提供方" onClick={() => navigate('providers')}>管理</Button></div></PlanField>
          <PlanField id="chat-plan-model" label={nativeFormMetadata.plan.fields.model} tip="显示在提供方页面设置的模型名称，不用重复填写 API 标识。可以就地添加或选择模型，原方案草稿会保留。"><div className="flex items-center gap-2"><select id="chat-plan-model" className="h-[27px] min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" value={draft.model} disabled={editingDisabled || !selectedProvider?.enabled} onChange={event => update('model', event.target.value)}><option value="" disabled>{selectedProvider ? '选择模型' : '先选择提供方'}</option>{draft.model && !selectedModel && <option value={draft.model} disabled>未登记的模型</option>}{selectedProvider?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></div></PlanField>
          <PlanField id="chat-plan-reasoning" label={nativeFormMetadata.plan.fields.reasoning} tip={reasoningSupport}><div className="flex items-center gap-2"><select id="chat-plan-reasoning" className="h-[27px] min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" value={draft.reasoningEffort} disabled={editingDisabled || !registeredSelection || supportedEfforts.length === 0} onChange={event => chooseReasoningEffort(event.target.value)}>
            <option value="" disabled>{supportedEfforts.length === 0 ? '尚无已确认档位' : '选择当前模型支持的档位'}</option>
            {reasoningOptions.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
          </select><Button type="button" size="sm" variant="ghost" aria-label="重新读取支持情况" disabled={editingDisabled || !draft.provider || !draft.model || currentCapabilities?.loading === true} onClick={invalidateCapabilities}><RefreshCw className={currentCapabilities?.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重读</Button></div></PlanField>
        </div>
        <div className="row small muted mt-1.5"><span>{currentCapabilities?.loading ? '正在读取模型支持情况' : capacity ? `模型窗口 ${capacity.contextWindow.toLocaleString()} token · 最大输出 ${capacity.maxTokens.toLocaleString()} token` : '尚无实际模型容量元数据'}</span><SettingsWindow title="上下文容量" description="按群聊和私聊分别设置，保存方案后应用。">        <div className="flex flex-wrap items-center gap-2">
          <div className="w-64 max-w-full"><PlanField id="chat-plan-group-context" label={nativeFormMetadata.plan.fields.groupContext} tip="每个群聊会话的上下文上限，单位 token。容量修改先保存，再明确应用到 DSH；需要迁移时沿用配置应用流程。"><Input id="chat-plan-group-context" type="number" min={CHAT_PLAN_LIMITS.contextMinimum} max={CHAT_PLAN_LIMITS.contextMaximum} step={1} inputMode="numeric" value={groupContext} disabled={editingDisabled} onChange={event => updateContext('group', event.target.value)} /></PlanField></div>
          <div className="w-64 max-w-full"><PlanField id="chat-plan-private-context" label={nativeFormMetadata.plan.fields.privateContext} tip="每个私聊会话的上下文上限，单位 token，独立于群聊设置。容量修改保存并应用后生效，不自动切换已有会话。"><Input id="chat-plan-private-context" type="number" min={CHAT_PLAN_LIMITS.contextMinimum} max={CHAT_PLAN_LIMITS.contextMaximum} step={1} inputMode="numeric" value={privateContext} disabled={editingDisabled} onChange={event => updateContext('private', event.target.value)} /></PlanField></div>
          {capacity ? <div className="flex flex-wrap items-center gap-2 pb-1"><span className="text-xs text-muted-foreground">建议群聊 {capacity.recommended.group.toLocaleString()} · 私聊 {capacity.recommended.private.toLocaleString()}</span><HelpTip label="模型容量">{`模型实际窗口 ${capacity.contextWindow.toLocaleString()} token，最大输出 ${capacity.maxTokens.toLocaleString()} token。压缩额外预留群聊 ${capacity.compaction.groupHeadroomTokens.toLocaleString()}、私聊 ${capacity.compaction.privateHeadroomTokens.toLocaleString()} token。采用建议只修改当前草稿，保存并应用后生效。`}</HelpTip><Button size="sm" variant="outline" disabled={editingDisabled} onClick={() => { setGroupContext(String(capacity.recommended.group)); setPrivateContext(String(capacity.recommended.private)); setContextTouched({ group: true, private: true }); setSaveState('idle'); }}>使用模型建议容量</Button></div> : <p className="pb-2 text-xs text-muted-foreground">尚无实际模型容量元数据；保留当前数值。</p>}
        </div>
</SettingsWindow></div></div>
        {currentCapabilities?.error && <p role="alert" className="text-xs leading-5 text-destructive">{currentCapabilities.error}</p>}
        {draft.reasoningEffort && !effortSupported && <p className="text-xs leading-5 text-muted-foreground">草稿原值“{modelReasoningEffortLabel(draft.reasoningEffort)}”仍保留，当前未确认支持；不会自动降档。支持情况未知时，已有方案可原样保留模型和档位，仅保存其他字段。</p>}
        {!registeredSelection && <div className="rounded-lg border border-dashed px-3 py-2.5 text-xs leading-5 text-muted-foreground">{draft.provider ? '这份方案的提供方或模型尚未登记、已停用。原有内容会保留，请在“模型提供方”补齐后再启用。' : '先在“模型提供方”添加连接和模型，再回来选择。'}</div>}
        <PlanField stacked id="chat-plan-instructions" label={nativeFormMetadata.plan.fields.instructions} tip="只放本方案的回复约束；人设正文、能力权限和用户偏好在各自页面管理。"><Textarea id="chat-plan-instructions" value={draft.instructions} maxLength={CHAT_PLAN_LIMITS.instructions} disabled={editingDisabled} rows={9} className="min-h-48 resize-y leading-5" placeholder="描述这份聊天方案如何组织回复" onChange={event => update('instructions', event.target.value)} /></PlanField>

          {fieldError && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />{fieldError}</div>}
          {writeError && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><span>{writeError}</span>{(saveState === 'busy' || saveState === 'conflict' || saveState === 'unknown') && <Button size="sm" variant="outline" onClick={() => setReloadVersion(version => version + 1)}>重新载入</Button>}</div>}
        </div>;

  const heading = props.compact ? null : <PageHeading title="聊天方案与助手" description="配置聊天模型与回复方式，管理独立工作的后台助手。" actions={connected && catalog ? <div className="flex flex-wrap items-center gap-3 text-xs">
      <StatusPill tone={dirty || creating ? 'warning' : 'neutral'}>{dirty || creating ? '未保存' : '已保存'}</StatusPill>
      <StatusPill tone={runtimeConnected ? 'success' : 'warning'}>{runtimeConnected === null ? '聊天状态待确认' : runtimeConnected ? '聊天可用' : '聊天暂不可用'}</StatusPill>
      <Button variant="outline" onClick={useBuiltinPlan} disabled={dirty || editingDisabled} title="将内置日常方案填入新的草稿">使用内置方案</Button>
      <Button variant="ghost" onClick={() => setReloadVersion(version => version + 1)} disabled={loading || saving || dirty}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新状态</Button>
    </div> : undefined} />;

  if (!connected) return <div className="grid gap-2">{heading}<ConnectPrompt connect={connect} />{props.children}</div>;
  if (loading && !catalog) return <div className="grid gap-2">{heading}<Section title="聊天方案"><div className="flex min-h-32 items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取聊天方案</div></Section>{props.children}</div>;
  if (!catalog) return <div className="grid gap-2">{heading}<Section title="聊天方案暂不可用" description={loadError || '暂时无法读取聊天方案。'} actions={<Button variant="outline" onClick={() => setReloadVersion(version => version + 1)} disabled={loading}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重试</Button>}><EmptyState locked title="暂时无法读取" description="已保存的方案不会改变，请稍后重试。" /></Section>{props.children}</div>;

  if (props.compact) return <div className="stack compact-chat-editor">
    <NativeCatalogRecovery recovery={recovery} reading={loading || saving} onRead={() => setReloadVersion(value => value + 1)} onReleased={() => { operationBlocked.current = false; setSaveState('idle'); setWriteError(''); }} />
    <div className="formgrid">
      <PlanField id="overview-chat-plan" label="聊天方案"><select id="overview-chat-plan" className="h-[27px] w-full min-w-0 rounded border bg-background px-2" value={creating ? '' : selectedId ?? ''} disabled={dirty || editingDisabled} onChange={event => { const plan = catalog.plans.find(item => item.id === event.target.value); if (plan) selectPlan(plan); }}><option value="" disabled>选择聊天方案</option>{catalog.plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></PlanField>
      <PlanField id="overview-chat-persona" label="关联人设"><select id="overview-chat-persona" className="h-[27px] w-full min-w-0 rounded border bg-background px-2" value={draft.personaId} disabled={editingDisabled || personas.length === 0} onChange={event => update('personaId', event.target.value)}><option value="" disabled>选择人设</option>{personas.map(persona => <option key={persona.id} value={persona.id}>{persona.name}</option>)}</select></PlanField>
      <PlanField id="overview-chat-model" label="聊天模型"><select id="overview-chat-model" className="h-[27px] w-full min-w-0 rounded border bg-background px-2" value={JSON.stringify([draft.provider, draft.model])} disabled={editingDisabled} onChange={event => { const selected = providers.flatMap(provider => provider.enabled ? provider.models.map(model => ({ provider: provider.id, model: model.id })) : []).find(item => JSON.stringify([item.provider, item.model]) === event.target.value); if (!selected) return; invalidateCapabilities(); setDraft(current => ({ ...current, provider: selected.provider, model: selected.model })); setFieldError(''); setWriteError(''); setSaveState('idle'); }}><option value={JSON.stringify([draft.provider, draft.model])} disabled>{selectedModel ? selectedModel.name : '选择聊天模型'}</option>{providers.filter(provider => provider.enabled).flatMap(provider => provider.models.filter(model => provider.id !== draft.provider || model.id !== draft.model).map(model => <option key={JSON.stringify([provider.id, model.id])} value={JSON.stringify([provider.id, model.id])}>{model.name}</option>))}</select></PlanField>
      <PlanField id="overview-chat-reasoning" label="思考强度" tip={reasoningSupport}><select id="overview-chat-reasoning" className="h-[27px] w-full min-w-0 rounded border bg-background px-2" value={draft.reasoningEffort} disabled={editingDisabled || !registeredSelection || supportedEfforts.length === 0} onChange={event => chooseReasoningEffort(event.target.value)}><option value="" disabled>{supportedEfforts.length === 0 ? '尚无已确认档位' : '选择支持的档位'}</option>{reasoningOptions.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{modelReasoningEffortLabel(option.value)}{option.disabled ? '（未确认）' : ''}</option>)}</select></PlanField>
    </div>
    {(fieldError || writeError || loadError) && <p className="text-xs text-destructive" role="alert">{fieldError || writeError || loadError}</p>}
    {props.children}
    <div className="row border-t pt-2"><Button size="sm" variant="ghost" disabled={!dirty || editingDisabled} onClick={reset}>撤销</Button><DshDeploymentManager compact minimal api={api} connected={connected} setDirty={setDirty} configurationDirty={dirty || editingDisabled || creating} configurationRevision={catalog.revision} configurationDocument="plans" configurationActive={catalog.activePlanId === draft.id} prepareConfiguration={prepareChatUpdate} configurationUpdateBlocked={blocked || loading || saving || updatingChat || !draft.id} /></div>
  </div>;

  return <div className="grid gap-2">
    {heading}
    <NativeCatalogRecovery recovery={recovery} reading={loading || saving} onRead={() => setReloadVersion(value => value + 1)} onReleased={() => { operationBlocked.current = false; setSaveState('idle'); setWriteError(''); }} />

    {(loadError || auxiliaryWarnings.length > 0) && <div role="status" className="rounded-lg border p-3 text-xs leading-6 text-muted-foreground">{loadError && <p>{loadError} 暂保留上次方案与草稿。</p>}{auxiliaryWarnings.map(warning => <p key={warning}>{warning}</p>)}</div>}
    <div className="masterdetail editor-workspace">
    <Section className="editor-directory" title="方案目录" actions={<Button size="sm" variant="ghost" onClick={createPlan} disabled={dirty || editingDisabled}><Plus className="size-3.5" />新建</Button>} footer={<span className="small muted">{catalog.plans.length} 项方案</span>}>
      {catalog.plans.length === 0 ? <p className="text-xs text-muted-foreground">还没有聊天方案，创建第一份方案开始配置。</p> : <div className="masterlist" role="group" aria-label="选择聊天方案">{catalog.plans.map((plan, index) => <button key={plan.id} type="button" className={!creating && selectedId === plan.id ? 'active' : ''} title={modelLabel(plan)} aria-pressed={!creating && selectedId === plan.id} disabled={dirty || editingDisabled} onClick={() => selectPlan(plan)}><span className="letter">{String(index + 1).padStart(2, '0')}</span><span className="copy"><strong>{plan.name}</strong><span className="muted">{modelLabel(plan)}{catalog.activePlanId === plan.id ? ' · 当前启用' : ''}</span></span></button>)}</div>}
    </Section>
    <div className="stack editor-detail">
    <Section id={nativeFormMetadata.plan.id} title={creating ? '新建聊天方案' : draft.name || '聊天方案'} actions={<StatusPill tone={catalog.activePlanId === draft.id && draft.id !== '' ? 'success' : 'neutral'}>{catalog.activePlanId === draft.id && draft.id !== '' ? '当前启用方案' : '尚未启用'}</StatusPill>} footer={<div className="flex flex-wrap items-center gap-2"><SaveBar compact dirty={dirty} saving={saving} disabled={blocked} message={saveMessage(saveState, dirty)} onSave={() => void save()} onReset={reset} label="保存聊天方案" /><DshDeploymentManager compact api={api} connected={connected} setDirty={setDirty} configurationDirty={dirty || editingDisabled || creating} configurationRevision={catalog.revision} configurationDocument="plans" configurationActive={catalog.activePlanId === draft.id}
      prepareConfiguration={prepareChatUpdate} configurationUpdateBlocked={blocked || loading || saving || updatingChat || !draft.id} /><span className="ml-auto">{!creating && <SettingsWindow title="删除聊天方案" label="删除" triggerVariant="destructive" description="删除后无法撤销；当前启用的方案不能删除。"><div className="mt-3 grid gap-2">
            
            <p role="status">{deletionBlockedReason}</p>
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1.5" checked={deleteConfirmed} disabled={editingDisabled || !selectedPlan || selectedOwner.current !== selectedPlan.id} onChange={event => {
              if (editingDisabled || !selectedPlan || saveController.current || operationBlocked.current || selectedOwner.current !== selectedPlan.id || connection.current.api !== api || !connection.current.connected) return;
              deletionTarget.current = event.target.checked ? selectedPlan.id : null;
              setDeleteConfirmed(event.target.checked);
            }} /><span>确认删除“{selectedPlan?.name}”。</span></label>
            <Button variant="destructive" disabled={!deleteConfirmed || dirty || editingDisabled || catalog.activePlanId === selectedId} onClick={() => void deletePlan()}><Trash2 className="size-3.5" />确认删除此方案</Button>
          </div></SettingsWindow>}</span></div>}>
      {creating && creationDialogOpen ? <p className="small muted">在新建窗口中编辑方案草稿。</p> : editorFields}
    </Section>
    {props.children}
    </div></div>

    <Dialog open={creating && creationDialogOpen} onOpenChange={open => { if (!saving && !updatingChat) setCreationDialogOpen(open); }}><DialogContent className="sm:max-w-5xl" showCloseButton={!saving && !updatingChat}><DialogHeader><DialogTitle>新建聊天方案</DialogTitle><DialogDescription>选择已登记的模型与人设，创建新的方案草稿。</DialogDescription></DialogHeader>{creating && creationDialogOpen && editorFields}<div className="row border-t pt-2"><Button variant="outline" className="mr-auto" onClick={useBuiltinPlan} disabled={dirty || editingDisabled} title={dirty ? '请先保存或撤销当前草稿' : '填入内置日常方案'}>填入内置方案</Button><Button disabled={!dirty || editingDisabled || blocked} onClick={() => void save()}>{saving ? '正在创建' : '创建方案'}</Button><Button variant="ghost" disabled={saving || updatingChat} onClick={() => setCreationDialogOpen(false)}>返回编辑</Button></div></DialogContent></Dialog>
    <Dialog open={modelEditorOpen} onOpenChange={setModelEditorOpen}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl" finalFocus={() => document.getElementById('chat-plan-model')}>
        <DialogHeader><DialogTitle>就地选择或添加模型</DialogTitle><DialogDescription>方案草稿保留在原处。先单独保存提供方或模型，再选择“在聊天方案中使用此模型”返回；方案仍需明确保存。</DialogDescription></DialogHeader>
        {modelEditorOpen && <ProviderManager {...props} preferredProviderId={draft.provider} onUseModel={(provider, model) => {
          if (editingDisabled || !provider.enabled) return;
          invalidateCapabilities();
          setProviders(current => [...current.filter(value => value.id !== provider.id), provider]);
          setDraft(current => ({ ...current, provider: provider.id, model: model.id }));
          setFieldError(''); setWriteError(''); setSaveState('idle'); setModelEditorOpen(false);
        }} />}
      </DialogContent>
    </Dialog>
  </div>;
}
