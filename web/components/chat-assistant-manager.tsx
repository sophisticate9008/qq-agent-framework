import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ApiError, errorMessage, type ApiClient } from '../lib/api.ts';
import { assistantAvailabilityMessage, parseAssistantConfiguration, parseAssistantProviders, parseChatAssistant, sameAssistantConfiguration,
  type AssistantProvider, type ChatAssistantConfiguration, type ChatAssistantSnapshot } from '../lib/chat-assistant.ts';
import { Field, SaveBar, Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';
import { AssistantDeploymentManager } from './assistant-deployment-manager.tsx';
import { modelReasoningEffortLabel, parseModelCapabilities, type ModelCapabilities } from '../lib/model-capabilities.ts';

interface AssistantCapabilities {
  readonly api: ApiClient;
  readonly generation: number;
  readonly provider: string;
  readonly model: string;
  readonly value: ModelCapabilities | null;
  readonly loading: boolean;
}

interface AssistantView {
  readonly api: ApiClient;
  readonly generation: number;
  readonly snapshot: ChatAssistantSnapshot | null;
  readonly draft: ChatAssistantConfiguration | null;
  readonly providers: readonly AssistantProvider[];
  readonly providerError: string;
  readonly error: string;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly blocked: boolean;
  readonly reviewed: boolean;
  readonly message: string;
}

const assistantDraftKey = createDraftKey<{ readonly snapshot: ChatAssistantSnapshot; readonly draft: ChatAssistantConfiguration }>('chat-assistant');

export function ChatAssistantManager({ api, connected, setDirty }: {
  readonly api: ApiClient;
  readonly connected: boolean;
  readonly setDirty?: (value: boolean, scope?: string) => void;
}) {
  const recovery = useNativeCatalogOperation(api, 'assistant');
  const [view, setView] = useState<AssistantView | null>(null);
  const live = useRef(view);
  live.current = view;
  const epoch = useRef(0);
  const request = useRef<AbortController | null>(null);
  const uncertain = useRef(new WeakSet<ApiClient>());
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const dirtyCallback = useRef(setDirty);
  dirtyCallback.current = setDirty;
  const refresh = useRef<() => void>(() => undefined);
  const [capabilities, setCapabilities] = useState<AssistantCapabilities | null>(null);
  const [capabilitiesReload, setCapabilitiesReload] = useState(0);
  const capabilitiesEpoch = useRef(0);

  useEffect(() => {
    const generation = ++epoch.current;
    let active = true;
    const owns = () => active && epoch.current === generation && connection.current.api === api && connection.current.connected;
    const retained = retainedDraft(api, assistantDraftKey);
    const initial: AssistantView = { api, generation, snapshot: retained?.snapshot ?? null, draft: retained?.draft ?? null, providers: [], providerError: '', error: '',
      loading: connected, saving: false, blocked: uncertain.current.has(api) || recovery.store.getSnapshot().assistant !== undefined, reviewed: false, message: '' };
    live.current = initial; setView(initial);
    async function load(): Promise<void> {
      if (!owns() || request.current) return;
      const controller = new AbortController();
      request.current = controller;
      const current = () => owns() && request.current === controller && !controller.signal.aborted;
      const prior = live.current;
      if (!prior || prior.api !== api || prior.generation !== generation) return;
      const pending = { ...prior, loading: true, error: '', reviewed: false };
      live.current = pending; setView(pending);
      try {
        const [settings, catalog] = await Promise.allSettled([
          readResource(api, '/api/chat/assistant', controller.signal), readResource(api, '/api/chat/providers', controller.signal, 1_000),
        ]);
        if (!current()) return;
        const providers = catalog.status === 'fulfilled' ? parseAssistantProviders(catalog.value) : null;
        if (settings.status === 'rejected') throw settings.reason;
        const snapshot = parseChatAssistant(settings.value);
        if (!snapshot) throw new Error('invalid_chat_assistant');
        recovery.review();
        const preserveDraft = prior.blocked || prior.snapshot !== null && prior.draft !== null
          && !sameAssistantConfiguration(prior.snapshot.configuration, prior.draft);
        const next = { ...pending, snapshot, draft: preserveDraft ? prior.draft ?? snapshot.configuration : snapshot.configuration, providers: providers ?? [],
          providerError: providers ? '' : '暂时无法读取模型目录；已保存的目标会保留。', reviewed: prior.blocked, loading: false };
        live.current = next; setView(next);
      } catch (failure) {
        if (!current()) return;
        const next = { ...pending, loading: false, error: errorMessage(failure) };
        live.current = next; setView(next);
      } finally {
        if (current()) request.current = null;
      }
    }
    const read = () => { void load(); };
    refresh.current = read;
    if (connected) read();
    return () => {
      active = false; epoch.current++;
      request.current?.abort(); request.current = null;
      if (refresh.current === read) refresh.current = () => undefined;
    };
  }, [api, connected]);

  const current = connected && view?.api === api && view.generation === epoch.current ? view : null;
  const targetProvider = current?.draft?.provider;
  const targetModel = current?.draft?.model;
  const settingsGeneration = current?.generation;
  const settingsLoading = current?.loading;
  useEffect(() => {
    const generation = ++capabilitiesEpoch.current;
    setCapabilities(null);
    if (!connected || settingsLoading || settingsGeneration === undefined || !targetProvider || !targetModel) return;
    const controller = new AbortController();
    const owns = () => !controller.signal.aborted && capabilitiesEpoch.current === generation
      && epoch.current === settingsGeneration && connection.current.api === api && connection.current.connected;
    setCapabilities({ api, generation, provider: targetProvider, model: targetModel, value: null, loading: true });
    void readResource(api, `/api/chat/model-capabilities?${new URLSearchParams({ provider: targetProvider, model: targetModel })}`, controller.signal)
      .then(value => {
        if (!owns()) return;
        const parsed = parseModelCapabilities(value);
        if (!parsed || parsed.provider !== targetProvider || parsed.model !== targetModel) throw new Error('invalid_model_capabilities');
        setCapabilities({ api, generation, provider: targetProvider, model: targetModel, value: parsed, loading: false });
      }).catch(() => {
        if (owns()) setCapabilities({ api, generation, provider: targetProvider, model: targetModel, value: null, loading: false });
      });
    return () => { controller.abort(); capabilitiesEpoch.current++; };
  }, [api, connected, targetProvider, targetModel, settingsGeneration, settingsLoading, capabilitiesReload]);
  const currentCapabilities = capabilities?.api === api && capabilities.generation === capabilitiesEpoch.current
    && capabilities.provider === targetProvider && capabilities.model === targetModel ? capabilities : null;
  const dirty = current?.snapshot != null && current.draft != null && !sameAssistantConfiguration(current.snapshot.configuration, current.draft);
  useEffect(() => {
    if (!current) return;
    retainDraft(api, assistantDraftKey, connected && dirty && current.snapshot && current.draft ? { snapshot: current.snapshot, draft: current.draft } : null);
  }, [api, connected, current?.snapshot, current?.draft, dirty]);
  useEffect(() => { setDirty?.(dirty, 'chat-assistant'); }, [dirty, setDirty]);
  useEffect(() => () => { dirtyCallback.current?.(false, 'chat-assistant'); }, []);

  function owned(): AssistantView | null {
    const latest = live.current;
    return latest && latest === view && latest.api === api && latest.generation === epoch.current
      && connection.current.api === api && connection.current.connected ? latest : null;
  }
  function update(changes: Partial<ChatAssistantConfiguration>): void {
    const owner = owned();
    if (!owner?.draft || request.current || owner.loading || owner.saving || owner.blocked || recovery.blocked) return;
    const next = { ...owner, draft: { ...owner.draft, ...changes }, error: '', message: '' };
    live.current = next; setView(next);
  }
  async function save(): Promise<void> {
    const owner = owned();
    if (!owner?.snapshot || !owner.draft || request.current || owner.loading || owner.saving || owner.blocked || recovery.blocked
      || sameAssistantConfiguration(owner.snapshot.configuration, owner.draft)) return;
    const configuration = parseAssistantConfiguration(owner.draft);
    if (!configuration || configuration.mode === 'chat-assistant' && !owner.providers.some(provider => provider.enabled
      && provider.id === configuration.provider && provider.models.some(model => model.id === configuration.model))) {
      const next = { ...owner, error: '请选择已启用的执行提供方及其模型；无法读取目录时请先刷新。' };
      live.current = next; setView(next); return;
    }
    if (configuration.mode === 'chat-assistant' && configuration.reasoningEffort !== null) {
      const saved = owner.snapshot.configuration;
      const preserving = saved.mode === configuration.mode && saved.provider === configuration.provider
        && saved.model === configuration.model && saved.reasoningEffort === configuration.reasoningEffort;
      const known = currentCapabilities?.value?.state === 'available';
      if (known ? !currentCapabilities?.value?.reasoningEfforts.includes(configuration.reasoningEffort) : !preserving) {
        const next = { ...owner, error: '请为助手选择当前模型支持的思考等级，或使用模型默认。' };
        live.current = next; setView(next); return;
      }
    }
    const controller = new AbortController();
    const operationToken = recovery.begin(owner.snapshot.revision, controller.signal);
    if (!operationToken) return;
    uncertain.current.add(api);
    request.current = controller;
    const owns = () => !controller.signal.aborted && request.current === controller && owner.generation === epoch.current
      && connection.current.api === api && connection.current.connected;
    const pending = { ...owner, saving: true, error: '', message: '' };
    live.current = pending; setView(pending);
    try {
      const response = await writeResource(api, '/api/chat/assistant', { revision: owner.snapshot.revision, configuration }, controller.signal);
      if (!owns()) return;
      const snapshot = parseChatAssistant(response);
      if (!snapshot || !sameAssistantConfiguration(snapshot.configuration, configuration)) throw new ApiError('assistant_save_unknown', 504);
      recovery.complete(operationToken);
      uncertain.current.delete(api);
      const next = { ...pending, snapshot, draft: snapshot.configuration, saving: false, message: `助手设置已保存；${assistantAvailabilityMessage(snapshot)}。` };
      live.current = next; setView(next);
    } catch (failure) {
      const failureState = recovery.fail(operationToken, failure);
      if (!owns()) return;
      const reasoningError = failure instanceof ApiError && /^assistant_reasoning_(unsupported|unavailable)$/.test(failure.code);
      const conflict = failure instanceof ApiError && failure.status === 409 && !reasoningError;
      const unknown = !(failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && !/unknown/.test(failure.code));
      if (conflict || unknown) uncertain.current.add(api);
      else uncertain.current.delete(api);
      const next = { ...pending, saving: false, blocked: failureState !== 'idle', reviewed: false,
        error: reasoningError ? '当前模型的思考等级未确认支持，请刷新等级后重选，或使用模型默认。'
          : unknown ? '保存结果未知，不会自动重试。请重新读取并核对，再明确允许新的保存。'
          : conflict ? '设置已变化，草稿已保留。请重新读取并核对，再进行新的保存。' : errorMessage(failure) };
      live.current = next; setView(next);
    } finally {
      if (owns()) request.current = null;
    }
  }

  if (!connected) return null;
  const draft = current?.draft;
  const providers = current?.providers ?? [];
  const provider = providers.find(item => item.id === draft?.provider);
  const locked = !current?.snapshot || current.loading || current.saving || current.blocked || recovery.blocked;
  const selectClass = 'h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm';
  const supportedEfforts = currentCapabilities?.value?.state === 'available' ? currentCapabilities.value.reasoningEfforts : [];
  const effortSupported = draft?.reasoningEffort != null && supportedEfforts.includes(draft.reasoningEffort);
  return <><Section id="chat-assistant" title="聊天模式" scrollable description="普通聊天与独立助手分开配置。"
    actions={<Button size="sm" variant="outline" disabled={!current || current.loading || current.saving} onClick={() => refresh.current()}><RefreshCw className="size-3.5" />重新读取助手设置</Button>}
    footer={<SaveBar dirty={dirty} saving={current?.saving ?? false} disabled={locked} label="保存助手设置" onSave={() => void save()} message={current?.message || undefined} />}>
    <div className="grid gap-4 text-xs leading-6">
      <div><StatusPill tone={current?.snapshot?.state === 'available' ? 'success' : 'neutral'}>{current?.snapshot ? assistantAvailabilityMessage(current.snapshot) : '助手执行状态待确认'}</StatusPill></div>
      {current?.error && <p role="alert" className="text-destructive">{current.error}</p>}
      {current?.providerError && <p role="status" className="text-muted-foreground">{current.providerError}</p>}
      {!draft ? <p role="status">{current?.loading ? '正在读取助手设置…' : '暂时无法读取助手设置，请重新读取。'}</p> : <>
        <Field label="聊天模式"><select aria-label="聊天模式" className={selectClass} value={draft.mode} disabled={locked} onChange={event => {
          if (event.target.value === 'chat-only' || event.target.value === 'chat-assistant') update({ mode: event.target.value });
        }}><option value="chat-only">仅聊天</option><option value="chat-assistant">聊天＋助手</option></select></Field>
        <p className="text-muted-foreground">{draft.mode === 'chat-only' ? '普通聊天中的已接入 MCP 与技能仍可使用；助手目标会保留。' : current?.snapshot?.state === 'available' ? '执行目标单独保存；请在所属 QQ 会话发起实际工作。' : '保存执行目标；助手执行的缺失条件以当前状态为准。'}</p>
        {draft.mode === 'chat-assistant' && <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label="助手昵称" description="可选，例如 gpt姐姐。昵称与执行模型分开保存。"><input aria-label="助手昵称" className={selectClass} value={draft.nickname} maxLength={48} placeholder="例如：gpt姐姐" disabled={locked} onChange={event => update({ nickname: event.target.value })} /></Field></div>
          <Field label="执行提供方"><select aria-label="执行提供方" className={selectClass} value={draft.provider ?? ''} disabled={locked || providers.length === 0} onChange={event => {
            const selected = providers.find(item => item.enabled && item.id === event.target.value);
            if (selected) update({ provider: selected.id, model: null });
          }}><option value="" disabled>选择模型提供方</option>{draft.provider && !provider && <option value={draft.provider} disabled>已保存的提供方（暂不可用）</option>}{providers.map(item => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.name}{!item.enabled ? '（未启用）' : ''}</option>)}</select></Field>
          <Field label="执行模型"><select aria-label="执行模型" className={selectClass} value={draft.model ?? ''} disabled={locked || !provider?.enabled} onChange={event => {
            if (provider?.enabled && provider.models.some(model => model.id === event.target.value)) update({ model: event.target.value });
          }}><option value="" disabled>选择执行模型</option>{draft.model && !provider?.models.some(model => model.id === draft.model) && <option value={draft.model} disabled>已保存的模型（暂不可用）</option>}{provider?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></Field>
          <div className="sm:col-span-2"><Field label="助手思考等级" description="只列出执行模型支持的等级，与聊天模型分开保存。">
            <div className="flex gap-2"><select aria-label="助手思考等级" className={selectClass}
              value={draft.reasoningEffort === null ? '' : effortSupported ? draft.reasoningEffort : 'unconfirmed'}
              disabled={locked || !provider?.enabled || !draft.model || currentCapabilities?.loading === true}
              onChange={event => {
                const effort = supportedEfforts.find(item => item === event.target.value);
                if (event.target.value === '') update({ reasoningEffort: null });
                else if (effort) update({ reasoningEffort: effort });
              }}>
              <option value="">使用模型默认</option>
              {draft.reasoningEffort !== null && !effortSupported && <option value="unconfirmed" disabled>原有等级待核对</option>}
              {supportedEfforts.map(effort => <option key={effort} value={effort}>{modelReasoningEffortLabel(effort)}</option>)}
            </select><Button size="sm" variant="outline" disabled={locked || !draft.model || !provider?.enabled || currentCapabilities?.loading === true} onClick={() => setCapabilitiesReload(value => value + 1)}>刷新等级</Button></div>
            <p className="text-muted-foreground" role="status">{!draft.provider || !draft.model ? '先选择执行提供方和模型。'
              : currentCapabilities?.loading ? '正在读取模型支持的等级…'
              : currentCapabilities?.value?.state === 'available' ? `支持：${supportedEfforts.map(modelReasoningEffortLabel).join('、')}。`
              : '暂未确认支持的等级，可使用模型默认或刷新重试。'}</p>
            {draft.reasoningEffort !== null && !effortSupported && <p className="text-muted-foreground">原值“{modelReasoningEffortLabel(draft.reasoningEffort)}”已保留，不会自动改档。</p>}
          </Field></div>
        </div>}
      </>}
      {current?.blocked && <div className="grid gap-2 rounded-lg border p-3"><p>重新读取只核对状态，不会再次保存，草稿仍保留。</p><Button size="sm" variant="outline" disabled={!current.reviewed || current.loading || current.saving} onClick={() => {
        const owner = owned();
        if (!owner?.blocked || !owner.reviewed || request.current || owner.loading || owner.saving) return;
        if (recovery.block && !recovery.release()) return;
        uncertain.current.delete(api);
        const next = { ...owner, blocked: false, reviewed: false, error: '', message: '已核对，可以进行新的保存；不会重试原请求。' };
        live.current = next; setView(next);
      }}>我已核对，允许新的保存</Button></div>}
    </div>
  </Section><AssistantDeploymentManager api={api} connected={connected} assistantRevision={current?.snapshot?.revision ?? null}
    dirty={dirty || current?.saving === true || current?.blocked === true} enabled={current?.snapshot?.configuration.mode === 'chat-assistant'} onChanged={() => refresh.current()} /></>;
}
