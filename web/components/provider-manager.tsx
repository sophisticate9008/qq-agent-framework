import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { catalogFailureState } from '../lib/native-catalog-operation.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { validModelProviderApi, type ModelProviderApi } from '../../src/host/model-provider-protocols.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, KeyRound, LoaderCircle, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import { ConnectPrompt, EmptyState, Field, SaveBar, Section, StatusPill, ToggleField } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { VirtualList, type VirtualListHandle } from './virtual-list.tsx';
import { ProviderApiInput } from './provider-api-input.tsx';
import { newCatalogIdentifier } from '../lib/catalog-identifier.ts';
import { ProviderReferenceManager, retainedProviderReferenceId } from './provider-reference-manager.tsx';

export interface ProviderModel {
  readonly id: string;
  readonly name: string;
}

const modelRowKeys = new WeakMap<ProviderModel, number>();
let nextModelRowKey = 0;

function modelRowKey(model: ProviderModel): number {
  const existing = modelRowKeys.get(model);
  if (existing !== undefined) return existing;
  const key = nextModelRowKey++;
  modelRowKeys.set(model, key);
  return key;
}

interface ProviderDraft {
  readonly id: string;
  readonly name: string;
  readonly api: ModelProviderApi;
  readonly allowInsecureHttp?: boolean;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly models: readonly ProviderModel[];
}

export interface Provider extends ProviderDraft {
  readonly apiKeyConfigured: boolean;
}

interface ProviderCatalog {
  readonly revision: string;
  readonly providers: readonly Provider[];
}

interface ProviderWrite extends ProviderDraft {
  readonly apiKey?: string;
  readonly clearApiKey?: boolean;
}

type SaveState = 'idle' | 'saved' | 'busy' | 'conflict' | 'unknown';

function parseCatalog(value: unknown): ProviderCatalog | null {
  const record = asRecord(value);
  if (typeof record.revision !== 'string' || !Array.isArray(record.providers)) return null;
  const providers: Provider[] = [];
  for (const item of record.providers) {
    const provider = asRecord(item);
    if (typeof provider.id !== 'string' || !provider.id.trim() || typeof provider.name !== 'string'
      || typeof provider.baseUrl !== 'string'
      || typeof provider.enabled !== 'boolean' || typeof provider.apiKeyConfigured !== 'boolean'
      || !Array.isArray(provider.models)) return null;
    const api = provider.api ?? (provider.type === 'openai' ? 'openai-completions' : provider.type === 'anthropic' ? 'anthropic-messages' : undefined);
    if (!validModelProviderApi(api)
      || provider.allowInsecureHttp !== undefined && typeof provider.allowInsecureHttp !== 'boolean') return null;
    const models: ProviderModel[] = [];
    for (const item of provider.models) {
      const model = asRecord(item);
      if (typeof model.id !== 'string' || !model.id.trim() || typeof model.name !== 'string') return null;
      models.push({ id: model.id, name: model.name });
    }
    if (new Set(models.map(model => model.id)).size !== models.length) return null;
    providers.push({ id: provider.id, name: provider.name, api, baseUrl: provider.baseUrl,
      ...(provider.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: provider.allowInsecureHttp as boolean }),
      enabled: provider.enabled, apiKeyConfigured: provider.apiKeyConfigured, models });
  }
  if (new Set(providers.map(provider => provider.id)).size !== providers.length) return null;
  return { revision: record.revision, providers };
}

function editable(provider: ProviderDraft): ProviderDraft {
  return { id: provider.id, name: provider.name, api: provider.api, baseUrl: provider.baseUrl,
    ...(provider.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: provider.allowInsecureHttp }),
    enabled: provider.enabled, models: provider.models.map(model => ({ id: model.id, name: model.name })) };
}

function stateForError(error: unknown): SaveState {
  return catalogFailureState(error);
}

function stateMessage(state: SaveState, dirty: boolean): string {
  if (state === 'saved') return '提供方目录已保存；未测试连通性，也未同步外部运行环境。';
  if (state === 'busy') return '另一项写入正在进行。请重新载入后再编辑，不会自动重试。';
  if (state === 'conflict') return '目录已被其他窗口修改。请重新载入后再编辑。';
  if (state === 'unknown') return '无法确认保存结果。请重新载入核对，不会自动重试。';
  return dirty ? '有未保存的更改，请保存或撤销后再切换、新建或删除。' : '目录与已保存内容一致。';
}

function validationError(provider: ProviderDraft, catalog: ProviderCatalog, creating: boolean): string {
  if (!validModelProviderApi(provider.api)) return '请填写有效的 DSH api 标识（最多 128 个字母、数字、点、下划线或短横线）。';
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(provider.id) || provider.id.includes('..')) return '请在高级设置中检查内部标识：需为 1–128 个字母、数字、点、冒号、下划线或短横线，以字母或数字开头，且不能包含连续的点。';
  if (creating && catalog.providers.some(item => item.id === provider.id)) return '高级设置中的内部标识已存在，请换一个标识。';
  if (!provider.name || provider.name.length > 128 || /[\u0000-\u001f\u007f]/.test(provider.name)) return '提供方显示名称需为 1–128 个字符，不能包含控制字符。';
  if (catalog.providers.some(item => item.id !== provider.id && item.name === provider.name)) return '提供方显示名称已存在，请换一个便于区分的名称。';
  try {
    const url = new URL(provider.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || /[\u0000-\u0020\u007f\\?#]/.test(provider.baseUrl)) return '请使用完整接口地址，不要包含凭据、查询参数、片段或空格。';
    if (url.protocol === 'http:' && !provider.allowInsecureHttp && url.hostname !== 'localhost' && url.hostname !== '[::1]'
      && !/^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname)) return '远程 HTTP 会明文传输密钥，请改用 HTTPS，或明确打开允许 HTTP 开关。';
  } catch {
    return '请填写完整的接口基础地址，例如 https://api.example.com/v1。';
  }
  if (provider.models.some(model => !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(model.id)
    || model.id.includes('..') || model.id.includes('//') || model.id.endsWith('/'))) return '请填写有效的 API 模型 ID（最多 128 个字符）；不需要的空行可以删除。';
  if (provider.models.some(model => !model.name || model.name.length > 128 || /[\u0000-\u001f\u007f]/.test(model.name))) return '模型显示名称最多 128 个字符，不能包含控制字符。';
  if (new Set(provider.models.map(model => model.id)).size !== provider.models.length) return '同一提供方下的 API 模型 ID 不能重复。';
  if (new Set(provider.models.map(model => model.name)).size !== provider.models.length) return '同一提供方下的模型显示名称不能重复，请填写不同的别名。';
  return '';
}

const providerDraftKey = createDraftKey<{ readonly catalog: ProviderCatalog; readonly draft: ProviderDraft; readonly selectedId: string | null; readonly creating: boolean; readonly clearApiKey: boolean }>('providers');

export function ProviderManager({ api, connected, connect, setDirty, preferredProviderId, onUseModel }: PageProps & {
  readonly preferredProviderId?: string;
  readonly onUseModel?: (provider: Provider, model: ProviderModel) => void;
}) {
  const recovery = useNativeCatalogOperation(api, 'providers');
  const retained = useMemo(() => retainedDraft(api, providerDraftKey), [api]);
  const draftApi = useRef(api);
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(retained?.catalog ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(retained?.selectedId ?? null);
  const [draft, setDraft] = useState<ProviderDraft | null>(retained?.draft ?? null);
  const [creating, setCreating] = useState(retained?.creating ?? false);
  const [keyEntered, setKeyEntered] = useState(false);
  const [clearApiKey, setClearApiKey] = useState(retained?.clearApiKey ?? false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [reloadVersion, setReloadVersion] = useState(0);
  const [referenceEditing, setReferenceEditing] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const modelList = useRef<VirtualListHandle>(null);
  const revealNewModel = useRef(false);
  const lifecycle = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const connection = useRef({ connected, api });
  connection.current = { connected, api };
  const setDirtyRef = useRef(setDirty);
  const reportedDirty = useRef(false);
  const selected = catalog?.providers.find(provider => provider.id === selectedId) ?? null;
  const publicDirty = creating || clearApiKey
    || (draft !== null && selected !== null && JSON.stringify(draft) !== JSON.stringify(editable(selected)));
  const dirty = publicDirty || keyEntered;
  const draftOwner = useRef({ api, catalog, draft, selectedId, creating, clearApiKey, dirty });
  draftOwner.current = { api: draftApi.current, catalog, draft, selectedId, creating, clearApiKey, dirty };
  const blocked = recovery.blocked || saveState === 'busy' || saveState === 'conflict' || saveState === 'unknown';
  const locked = loading || saving || blocked || referenceEditing;

  useEffect(() => {
    if (!revealNewModel.current || !draft) return;
    revealNewModel.current = false;
    modelList.current?.scrollToIndex(draft.models.length - 1);
  }, [draft]);

  useEffect(() => {
    if (draftApi.current !== api) return;
    retainDraft(api, providerDraftKey, connected && publicDirty && catalog && draft ? { catalog, draft, selectedId, creating, clearApiKey } : null);
  }, [api, connected, publicDirty, catalog, draft, selectedId, creating, clearApiKey]);
  useEffect(() => { setDirtyRef.current = setDirty; }, [setDirty]);
  useEffect(() => {
    if (reportedDirty.current === dirty) return;
    reportedDirty.current = dirty;
    setDirty(dirty, 'providers');
  }, [dirty, setDirty]);
  useEffect(() => () => {
    if (keyInput.current) keyInput.current.value = '';
    setDirtyRef.current(false, 'providers');
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    if (keyInput.current) keyInput.current.value = '';
    setKeyEntered(false);
    setClearApiKey(false);
    setConfirmDelete(false);
    setConfirmReload(false);
    const prior = draftOwner.current.api === api ? draftOwner.current : null;
    draftApi.current = api;
    const preserveDraft = connected && prior?.dirty === true && prior.catalog !== null && prior.draft !== null;
    setSaving(false);
    setCatalog(connected ? prior?.catalog ?? null : null);
    if (!preserveDraft) { setDraft(null); setSelectedId(null); setCreating(false); }
    setFieldError('');
    setWriteError('');
    setLoadError('');
    setLoading(connected);
    if (connected) {
      void readResource(api, '/api/chat/providers', controller.signal, reloadVersion === 0 ? 1_000 : 0).then(value => {
        if (controller.signal.aborted || !connection.current.connected || connection.current.api !== api) return;
        const next = parseCatalog(value);
        if (!next) throw new Error('invalid_providers_response');
        const first = next.providers.find(provider => provider.id === (preferredProviderId ?? retainedProviderReferenceId(api))) ?? next.providers[0] ?? null;
        setCatalog(next);
        recovery.review();
        if (preserveDraft && prior) {
          setClearApiKey(prior.clearApiKey);
          setCreating(prior.creating || !next.providers.some(provider => provider.id === prior.draft?.id));
        } else { setSelectedId(first?.id ?? null); setDraft(first ? editable(first) : null); }
        setSaveState('idle');
      }).catch(error => {
        if (!controller.signal.aborted) setLoadError(errorMessage(error));
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }
    return () => {
      controller.abort();
      writeController.current?.abort();
      writeController.current = null;
    };
  }, [api, connected, reloadVersion]);

  function clearKeyInput(): void {
    if (keyInput.current) keyInput.current.value = '';
    setKeyEntered(false);
  }

  function clearFeedback(): void {
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
    setConfirmDelete(false);
    setConfirmReload(false);
  }

  function update<Key extends keyof ProviderDraft>(key: Key, value: ProviderDraft[Key]): void {
    if (locked || (key === 'id' && !creating)) return;
    setDraft(current => current ? { ...current, [key]: value } : null);
    clearFeedback();
  }

  function choose(provider: Provider): void {
    if (dirty || locked) return;
    clearKeyInput();
    setClearApiKey(false);
    setSelectedId(provider.id);
    setDraft(editable(provider));
    setCreating(false);
    clearFeedback();
  }

  function create(): void {
    if (!catalog || catalog.providers.length >= 128 || dirty || locked) return;
    clearKeyInput();
    setClearApiKey(false);
    setSelectedId(null);
    setDraft({ id: newCatalogIdentifier('provider'), name: '', api: 'openai-responses', baseUrl: '', enabled: true, models: [] });
    setCreating(true);
    clearFeedback();
  }

  function reset(): void {
    if (locked) return;
    const restored = selected ?? catalog?.providers[0] ?? null;
    clearKeyInput();
    setClearApiKey(false);
    setSelectedId(restored?.id ?? null);
    setDraft(restored ? editable(restored) : null);
    setCreating(false);
    clearFeedback();
  }

  function reload(): void {
    if (saving || loading || writeController.current) return;
    if (dirty) {
      setConfirmDelete(false);
      setConfirmReload(true);
      return;
    }
    discardAndReload();
  }

  function discardAndReload(): void {
    if (saving || loading || writeController.current) return;
    setConfirmReload(false);
    clearKeyInput();
    setLoading(true);
    setReloadVersion(version => version + 1);
  }

  async function commit(providers: readonly ProviderWrite[], preferredId: string | null): Promise<void> {
    const session = lifecycle.current;
    if (!catalog || locked || writeController.current || !connected || !session || session.signal.aborted) return;
    const controller = new AbortController();
    writeController.current = controller;
    const operationToken = recovery.begin(catalog.revision, controller.signal);
    if (!operationToken) { writeController.current = null; return; }
    const current = () => !controller.signal.aborted && !session.signal.aborted
      && lifecycle.current === session && connection.current.connected && connection.current.api === api;
    setSaving(true);
    setWriteError('');
    setFieldError('');
    setSaveState('idle');
    setConfirmDelete(false);
    setConfirmReload(false);
    try {
      const value = await writeResource(api, '/api/chat/providers', { revision: catalog.revision, providers }, controller.signal);
      if (!current()) return;
      const next = parseCatalog(value);
      if (!next || (preferredId !== null && !next.providers.some(provider => provider.id === preferredId))) throw new Error('invalid_providers_response');
      const preferred = next.providers.find(provider => provider.id === preferredId) ?? next.providers[0] ?? null;
      setCatalog(next);
      setSelectedId(preferred?.id ?? null);
      setDraft(preferred ? editable(preferred) : null);
      setCreating(false);
      recovery.complete(operationToken);
      setSaveState('saved');
    } catch (error) {
      recovery.fail(operationToken, error);
      if (!current()) return;
      const state = stateForError(error);
      setSaveState(state);
      setWriteError(error instanceof ApiError && (error.code === 'provider_model_in_use' || error.code === 'assistant_target_in_use')
        ? '方案或助手仍引用此提供方或模型。请在下方“模型使用者”中更换目标或解除助手引用，再明确保存提供方更改。本次输入的密钥已清空。'
        : state === 'idle' ? `${errorMessage(error)} 本次输入的密钥已清空，如需更换请重新填写。`
          : stateMessage(state, true));
    } finally {
      if (current()) {
        clearKeyInput();
        setClearApiKey(false);
        setSaving(false);
      }
      if (writeController.current === controller) writeController.current = null;
    }
  }

  function save(): void {
    if (!catalog || !draft || !dirty || locked || writeController.current) return;
    const apiKey = keyInput.current?.value.trim() ?? '';
    clearKeyInput();
    const normalized: ProviderDraft = { ...editable(draft), id: creating ? draft.id.trim() : draft.id,
      name: draft.name.trim(), baseUrl: draft.baseUrl.trim(),
      models: draft.models.map(model => ({ id: model.id.trim(), name: model.name.trim() || model.id.trim() })) };
    const error = validationError(normalized, catalog, creating)
      || (apiKey.length > 4096 || !/^[\x20-\x7e]*$/.test(apiKey) ? 'API 密钥最多 4096 个字符，只能包含可打印的 ASCII 字符。' : '');
    if (error) {
      setFieldError(`${error}${apiKey ? ' 本次输入的密钥已清空，请在修正后重新填写。' : ''}`);
      return;
    }
    const changed: ProviderWrite = { ...normalized,
      ...(clearApiKey ? { clearApiKey: true } : apiKey ? { apiKey } : {}) };
    const providers = creating ? [...catalog.providers.map(editable), changed]
      : catalog.providers.map(provider => provider.id === selectedId ? changed : editable(provider));
    void commit(providers, normalized.id);
  }

  function remove(): void {
    if (!catalog || !selected || dirty || locked || !confirmDelete) return;
    clearKeyInput();
    void commit(catalog.providers.filter(provider => provider.id !== selected.id).map(editable), null);
  }

  function updateModel(index: number, key: keyof ProviderModel, value: string): void {
    if (!draft) return;
    update('models', draft.models.map((model, modelIndex) => {
      if (modelIndex !== index) return model;
      const changed = { ...model, [key]: value };
      modelRowKeys.set(changed, modelRowKey(model));
      return changed;
    }));
  }

  if (!connected) return <ConnectPrompt connect={connect} />;

  return <div className="grid min-w-0 gap-5">
    <NativeCatalogRecovery recovery={recovery} reading={loading || saving} onRead={() => setReloadVersion(value => value + 1)} onReleased={() => { setSaveState('idle'); setWriteError(''); }} />
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-5">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
      <p><strong>这里仅保存框架自己的提供方目录。</strong><span className="mt-1 block text-muted-foreground">保存不代表接口可用；不会发起模型测试，也不会自动同步外部 DSH 运行环境或切换已有会话。</span></p>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{catalog ? `${catalog.providers.length} 个提供方 · ${catalog.providers.reduce((total, provider) => total + provider.models.length, 0)} 个模型` : '提供方与模型集中维护，聊天方案按目录选择。'}</span>
      <Button variant="outline" disabled={loading || saving} onClick={reload}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新载入目录</Button>
    </div>
    {confirmReload && <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-5" role="alert" aria-label="确认重新载入提供方目录"><span className="mr-auto min-w-0 flex-1 basis-56">重新载入将丢弃本页未保存的更改和未提交的密钥。保留当前内容不会重新提交，也不会解除保存限制。</span><Button variant="ghost" disabled={loading || saving} onClick={() => setConfirmReload(false)}>保留当前内容</Button><Button variant="destructive" disabled={loading || saving} onClick={discardAndReload}>放弃更改并重新载入</Button></div>}
    {(fieldError || writeError || blocked) && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs leading-5 text-destructive" role="alert"><CircleAlert className="mt-0.5 size-3.5 shrink-0" /><span>{writeError || fieldError || stateMessage(saveState, dirty)}</span></div>}
    {loading ? <Section scrollable title="提供方目录"><div className="flex min-h-52 items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取提供方目录</div></Section>
      : !catalog ? <Section scrollable title="提供方目录不可用"><EmptyState locked title="暂时无法读取提供方" description={loadError || '服务没有返回可识别的目录，请重新载入后再编辑。'} /></Section>
        : <div className="grid items-start gap-5 lg:grid-cols-[minmax(14rem,0.32fr)_minmax(0,1fr)]">
          <Section scrollable title="提供方目录" description="按显示名称选择接口并维护其模型。最多 128 个提供方。" actions={<Button size="sm" disabled={dirty || locked || catalog.providers.length >= 128} onClick={create}><Plus className="size-3.5" />新建提供方</Button>}>
            {catalog.providers.length === 0 ? <EmptyState title="还没有模型提供方" description="添加提供方，填写名称、接口类型和基础地址；需要认证时填写密钥。录入服务商的 API 模型 ID 并保存后，即可在聊天方案中选择。" action={<Button size="sm" disabled={dirty || locked} onClick={create}><Plus className="size-3.5" />添加提供方</Button>} />
              : <VirtualList items={catalog.providers} getItemKey={provider => provider.id} estimateSize={74} itemClassName="pb-1.5">{provider => <Button key={provider.id} variant={!creating && selectedId === provider.id ? 'secondary' : 'ghost'} className="h-auto w-full justify-start px-3 py-3 text-left whitespace-normal" disabled={dirty || locked} onClick={() => choose(provider)} aria-pressed={!creating && selectedId === provider.id}>
                <Server className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><strong className="block truncate text-xs font-medium">{provider.name}</strong><span className="mt-1 block truncate text-[10px] text-muted-foreground">{provider.api} · {provider.models.length} 个模型</span></span><StatusPill tone={provider.enabled ? 'success' : 'neutral'}>{provider.enabled ? '启用' : '停用'}</StatusPill>
              </Button>}</VirtualList>}
          </Section>
          <Section scrollable id={nativeFormMetadata.provider.id} title={creating ? '新建提供方' : selected?.name || nativeFormMetadata.provider.title} description="接口配置与模型名称分别维护；密钥仅写入，不会回显。" actions={draft ? <StatusPill tone={dirty ? 'warning' : 'neutral'}>{dirty ? '尚未保存' : '已载入'}</StatusPill> : undefined} footer={draft ? <>
            {confirmDelete && <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs" role="alert"><span className="mr-auto min-w-0 flex-1 basis-48 break-words">确认从目录删除「{selected?.name}」？此操作会同时移除其模型和已保存密钥；若被聊天方案引用，服务可能拒绝删除。</span><Button variant="ghost" disabled={locked} onClick={() => setConfirmDelete(false)}>取消</Button><Button variant="destructive" disabled={dirty || locked} onClick={remove}>确认删除</Button></div>}
            <SaveBar dirty={dirty} saving={saving} disabled={blocked || loading} message={stateMessage(saveState, dirty)} onSave={save} onReset={blocked ? undefined : reset} label={creating ? '创建提供方' : '保存提供方'}>
              {!creating && <Button variant="destructive" disabled={dirty || locked || confirmDelete} onClick={() => setConfirmDelete(true)}><Trash2 className="size-3.5" />删除提供方</Button>}
            </SaveBar>
          </> : undefined}>
            {!draft ? <EmptyState title="集中管理接口与模型" description="从左侧选择提供方，或新建一个提供方开始配置。" /> : <div className="grid gap-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label={nativeFormMetadata.provider.fields.name} description="用于列表和聊天方案展示，不是接口参数。"><Input id="provider-name" value={draft.name} disabled={locked} maxLength={128} placeholder="例如：我的模型服务" onChange={event => update('name', event.target.value)} /></Field>
                <Field label={nativeFormMetadata.provider.fields.type} description="下拉快速选择，输入名称搜索，也可填写自定义 DSH api 标识。实际支持情况以服务渠道和 DSH 为准，不会自动切换协议。"><ProviderApiInput key={selectedId ?? 'new-provider'} value={draft.api} disabled={locked} onChange={value => update('api', value)} /></Field>
              </div>
              <Field label={nativeFormMetadata.provider.fields.baseUrl} description="填写 DSH 要使用的基础地址，不含查询参数或密钥；建议使用 HTTPS。"><Input id="provider-base-url" type="url" value={draft.baseUrl} maxLength={2048} disabled={locked} placeholder="https://api.example.com/v1" onChange={event => update('baseUrl', event.target.value)} /></Field>
              {(draft.baseUrl.startsWith('http://') || draft.allowInsecureHttp) && <ToggleField label={nativeFormMetadata.provider.fields.allowInsecureHttp} description="远程 HTTP 会明文传输 API 密钥和消息。仅在了解风险且确需使用此地址时允许；不影响协议端连接设置。" checked={draft.allowInsecureHttp === true} disabled={locked} onChange={value => update('allowInsecureHttp', value)} />}
              <ToggleField label={nativeFormMetadata.provider.fields.enabled} description="控制目录中的可选状态，不代表已经连接或切换运行中的模型。" checked={draft.enabled} disabled={locked} onChange={value => update('enabled', value)} />
              <div className="grid gap-3 rounded-lg border bg-muted/20 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="flex items-center gap-2 text-xs font-medium"><KeyRound className="size-3.5" />API 密钥</span><StatusPill tone="neutral">{selected?.apiKeyConfigured ? '已保存密钥 · 不回显' : '未保存密钥'}</StatusPill></div>
                <Field label={selected?.apiKeyConfigured ? nativeFormMetadata.provider.fields.replaceKey : nativeFormMetadata.provider.fields.fillKey} description="留空保留已保存的密钥；提交后无论成功或失败，输入都会清空。切页或关闭编辑时未提交的密钥也会清空。">
                  <Input id="provider-api-key" ref={keyInput} type="password" autoComplete="new-password" spellCheck={false} maxLength={4096} disabled={locked || clearApiKey} placeholder={selected?.apiKeyConfigured ? '留空不更换' : '仅在需要认证时填写'} onChange={event => { setKeyEntered(event.target.value.length > 0); clearFeedback(); }} />
                </Field>
                {!creating && selected?.apiKeyConfigured && <ToggleField label={nativeFormMetadata.provider.fields.clearKey} description="仅在明确打开此选项并保存时清除；留空不会清除。" checked={clearApiKey} disabled={locked} onChange={value => { if (locked) return; clearKeyInput(); setClearApiKey(value); clearFeedback(); }} />}
              </div>
              <div className="grid min-w-0 gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-xs font-medium">模型列表 <span className="text-muted-foreground">({draft.models.length}/128)</span></h3><p className="mt-1 text-[11px] leading-5 text-muted-foreground">API 模型 ID 按服务商填写一次；显示名称可选，留空时使用 API ID。</p></div><Button size="sm" variant="outline" disabled={locked || draft.models.length >= 128} onClick={() => { revealNewModel.current = true; update('models', [...draft.models, { id: '', name: '' }]); }}><Plus className="size-3.5" />添加模型</Button></div>
                <div className="h-60 min-h-0 overflow-auto overscroll-contain rounded-lg border p-3" role="group" aria-label="可用模型列表">
                  {draft.models.length === 0 ? <div className="flex h-full items-center justify-center px-4 text-center text-xs leading-6 text-muted-foreground">还没有模型。添加后，聊天方案才能从此提供方选择模型。</div>
                    : <VirtualList items={draft.models} getItemKey={modelRowKey} estimateSize={142} listRef={modelList} itemClassName="pb-3">{(model, index) => <div className="grid gap-3 rounded-lg border bg-background p-3">
                      <div className="flex items-center justify-between gap-2"><span className="text-[11px] font-medium text-muted-foreground">模型 {index + 1}</span><Button size="icon-xs" variant="ghost" disabled={locked} aria-label={`删除模型 ${index + 1}`} onClick={() => update('models', draft.models.filter((_, modelIndex) => modelIndex !== index))}><Trash2 className="size-3.5" /></Button></div>
                      <div className="grid gap-3 sm:grid-cols-2"><Field label={nativeFormMetadata.provider.fields.modelId}><Input id={`provider-model-id-${index}`} value={model.id} maxLength={128} disabled={locked} placeholder="服务商要求的模型标识" onChange={event => updateModel(index, 'id', event.target.value)} /></Field><Field label={nativeFormMetadata.provider.fields.modelName}><Input id={`provider-model-name-${index}`} value={model.name} maxLength={128} disabled={locked} placeholder="留空使用 API 模型 ID" onChange={event => updateModel(index, 'name', event.target.value)} /></Field></div>
                      {onUseModel && <Button size="sm" variant="outline" disabled={dirty || locked || !selected?.enabled || !selected.models.some(saved => saved.id === model.id)} onClick={() => { const saved = selected?.models.find(saved => saved.id === model.id); if (selected?.enabled && saved && !dirty && !locked) onUseModel(selected, saved); }}>在聊天方案中使用此模型</Button>}
                    </div>}</VirtualList>}
                </div>
              </div>
              <details key={selectedId ?? 'new-provider'} className="rounded-lg border bg-muted/20 p-4">
                <summary className="cursor-pointer text-xs font-medium">高级设置</summary>
                <div className="mt-4"><Field label={nativeFormMetadata.provider.fields.id} description={creating ? '已自动生成，通常无需修改。仅需兼容已有聊天方案引用时，按原标识登记；保存后固定。' : '用于关联聊天方案和密钥，创建后不可修改；显示名称可以随时修改。'}><Input id="provider-id" value={draft.id} disabled={locked || !creating} maxLength={128} className="font-mono text-xs" onChange={event => update('id', event.target.value)} /></Field></div>
              </details>
            </div>}
          </Section>
        </div>}
    {catalog && selected && !onUseModel && <ProviderReferenceManager key={selected.id} api={api} connected={connected} providerId={selected.id}
      revision={catalog.revision} providers={catalog.providers} disabled={loading || saving || blocked || dirty} setDirty={setDirty}
      onEditingChange={setReferenceEditing} />}
  </div>;
}
