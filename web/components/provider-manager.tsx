import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { catalogFailureState } from '../lib/native-catalog-operation.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { validModelProviderApi, type ModelProviderApi } from '../../src/host/model-provider-protocols.ts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import { ConnectPrompt, Field, SaveBar, Section, StatusPill, ToggleField } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog.tsx';
import { HelpTip } from './help-tip.tsx';
import { SettingsWindow } from './settings-window.tsx';
import { Input } from './ui/input.tsx';
import { ProviderApiInput } from './provider-api-input.tsx';
import { newCatalogIdentifier } from '../lib/catalog-identifier.ts';
import { ProviderReferenceManager, retainedProviderReferenceId } from './provider-reference-manager.tsx';
import { useReadResource } from '../lib/use-read-resource.ts';
import { parsePlanCatalog } from '../lib/chat-plans.ts';
import { parseChatAssistant } from '../lib/chat-assistant.ts';
import { providerReferences } from '../lib/provider-references.ts';
import { modelReasoningEffortLabel, parseProviderModelCapabilities, providerModelCapabilitiesPath, type ModelCapabilities } from '../lib/model-capabilities.ts';
import { ProviderModelCapabilityDialog } from './provider-model-capabilities.tsx';

export interface ProviderModel {
  readonly id: string;
  readonly name: string;
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

function ProviderField({ id, label, tip, children }: { readonly id: string; readonly label: string; readonly tip?: string; readonly children: ReactNode }) {
  return <Field className="provider-field" id={id} label={label} tip={tip}>{children}</Field>;
}

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
  if (state === 'saved') return '提供方已保存。';
  if (state === 'busy') return '另一项写入正在进行。请重新载入后再编辑，不会自动重试。';
  if (state === 'conflict') return '目录已被其他窗口修改。请重新载入后再编辑。';
  if (state === 'unknown') return '无法确认保存结果。请重新载入核对，不会自动重试。';
  return dirty ? '未保存' : '未修改';
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
  const [creationDialogOpen, setCreationDialogOpen] = useState(false);
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
  const [modelFilter, setModelFilter] = useState('');
  const [modelEditor, setModelEditor] = useState<{ readonly ownerId: string; readonly index: number | null; readonly value: ProviderModel } | null>(null);
  const [modelEditorOpen, setModelEditorOpen] = useState(false);
  const [modelDelete, setModelDelete] = useState<{ readonly ownerId: string; readonly index: number; readonly value: ProviderModel } | null>(null);
  const [modelError, setModelError] = useState('');
  const [capabilityTarget, setCapabilityTarget] = useState<{ readonly provider: string; readonly model: string; readonly onUpdated?: (capabilities: ModelCapabilities) => void } | null>(null);
  const plans = useReadResource(api, '/api/chat/plans', connected, parsePlanCatalog);
  const assistant = useReadResource(api, '/api/chat/assistant', connected, parseChatAssistant);
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
  const capabilityCache = useReadResource(api, providerModelCapabilitiesPath(selected?.id ?? ''), connected && selected !== null && !creating, parseProviderModelCapabilities);
  useEffect(() => { setCapabilityTarget(null); }, [api, connected, selectedId]);
  useEffect(() => { if (selected && connected && !creating) capabilityCache.refresh(); }, [catalog?.revision, selected?.id, connected, creating]);

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
    setModelEditor(null); setModelEditorOpen(false); setModelDelete(null); setModelFilter(''); setCreationDialogOpen(false);
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
    setCreationDialogOpen(true);
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
      setCreationDialogOpen(false);
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

  function editModel(index: number | null): void {
    if (!draft || locked || index === null && draft.models.length >= 128) return;
    const value = index === null ? { id: '', name: '' } : draft.models[index];
    if (!value) return;
    if (modelEditor?.ownerId !== draft.id || modelEditor.index !== index) setModelEditor({ ownerId: draft.id, index, value });
    setModelError(''); setModelEditorOpen(true);
  }

  function commitModel(): void {
    if (!draft || !modelEditor || modelEditor.ownerId !== draft.id || locked) return;
    const next = { id: modelEditor.value.id.trim(), name: modelEditor.value.name.trim() };
    if (!/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(next.id) || next.id.includes('..') || next.id.includes('//') || next.id.endsWith('/')) { setModelError('请填写有效的 API 模型 ID，最多 128 个字符。'); return; }
    if (draft.models.some((model, index) => index !== modelEditor.index && model.id === next.id)) { setModelError('此 API 模型 ID 已在当前服务中登记。'); return; }
    if (next.name.length > 128 || /[\u0000-\u001f\u007f]/.test(next.name)) { setModelError('显示名称最多 128 个字符，不能包含控制字符。'); return; }
    update('models', modelEditor.index === null ? [...draft.models, next] : draft.models.map((model, index) => index === modelEditor.index ? next : model));
    setModelEditorOpen(false); setModelEditor(null);
  }

  const connectionFields = !draft ? <p className="small muted">从左侧选择模型服务，或新建服务开始配置。</p> : <div className="stack provider-editor">
          <div className="formgrid">
            <ProviderField id="provider-name" label="服务名称" tip="用于目录和聊天方案展示。"><Input id="provider-name" value={draft.name} disabled={locked} maxLength={128} placeholder="例如：我的模型服务" onChange={event => update('name', event.target.value)} /></ProviderField>
            <ProviderField id="provider-api" label="接口协议" tip="选择常用协议，或输入自定义 DSH api 标识。"><ProviderApiInput key={selectedId ?? 'new-provider'} value={draft.api} disabled={locked} onChange={value => update('api', value)} /></ProviderField>
            <div className="spanall"><ProviderField id="provider-base-url" label="基础地址" tip="填写完整接口基础地址，地址中不含查询参数或密钥。"><Input id="provider-base-url" type="url" value={draft.baseUrl} maxLength={2048} disabled={locked} placeholder="https://api.example.com/v1" onChange={event => update('baseUrl', event.target.value)} /></ProviderField></div>
            <div className="spanall"><ProviderField id="provider-api-key" label={selected?.apiKeyConfigured ? '替换密钥' : 'API 密钥'} tip="密钥只写入；留空保留原值。提交或离开编辑后清空尚未提交的密钥。"><Input id="provider-api-key" ref={keyInput} type="password" autoComplete="new-password" spellCheck={false} maxLength={4096} disabled={locked || clearApiKey} placeholder={selected?.apiKeyConfigured ? '已保存 · 留空保留原密钥' : '仅在服务需要认证时填写'} onChange={event => { setKeyEntered(event.target.value.length > 0); clearFeedback(); }} /></ProviderField></div>
          </div>
          <div className="row between"><div className="row"><label className="row small"><input type="checkbox" checked={draft.enabled} disabled={locked} onChange={event => update('enabled', event.target.checked)} />在模型目录中启用</label>{!creating && selected?.apiKeyConfigured && <label className="row small"><input type="checkbox" checked={clearApiKey} disabled={locked} onChange={event => { if (locked) return; clearKeyInput(); setClearApiKey(event.target.checked); clearFeedback(); }} />保存时清除已保存密钥</label>}</div><SettingsWindow title="连接高级设置" description="维护内部标识与 HTTP 兼容选项，与当前服务一起保存。"><div className="stack"><ProviderField id="provider-id" label={nativeFormMetadata.provider.fields.id} tip="新建时自动生成，创建后固定。"><Input id="provider-id" value={draft.id} disabled={locked || !creating} maxLength={128} className="font-mono" onChange={event => update('id', event.target.value)} /></ProviderField><ToggleField label={nativeFormMetadata.provider.fields.allowInsecureHttp} description="允许需要明文 HTTP 的远程接口。" checked={draft.allowInsecureHttp === true} disabled={locked} onChange={value => update('allowInsecureHttp', value)} /></div></SettingsWindow></div>
          <div className="strip">密钥只写入；留空保留原值。保存服务后，模型目录才会供方案和助手选择。</div>
        </div>;

  if (!connected) return <ConnectPrompt connect={connect} />;

  return <div className="grid min-w-0 gap-2">
    <NativeCatalogRecovery recovery={recovery} reading={loading || saving} onRead={() => setReloadVersion(value => value + 1)} onReleased={() => { setSaveState('idle'); setWriteError(''); }} />
    {confirmReload && <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5" role="alert" aria-label="确认重新载入提供方目录"><span className="mr-auto min-w-0 flex-1 basis-56">重新载入将丢弃本页未保存的更改和未提交的密钥。保留当前内容不会重新提交，也不会解除保存限制。</span><Button variant="ghost" size="sm" disabled={loading || saving} onClick={() => setConfirmReload(false)}>保留当前内容</Button><Button variant="destructive" size="sm" disabled={loading || saving} onClick={discardAndReload}>放弃更改并重新载入</Button></div>}
    {(fieldError || writeError || blocked) && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive" role="alert"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span>{writeError || fieldError || stateMessage(saveState, dirty)}</span></div>}
    <div className="masterdetail editor-workspace">
      <Section className="editor-directory" title="模型服务目录" actions={<Button size="sm" variant="ghost" disabled={dirty || locked || !catalog || catalog.providers.length >= 128} onClick={create}><Plus className="size-3.5" />新建</Button>} footer={<div className="row"><span className="small muted">{catalog?.providers.length ?? 0} 项服务</span><Button variant="ghost" size="sm" disabled={loading || saving} onClick={reload}><RefreshCw className={loading ? 'size-3 animate-spin' : 'size-3'} />重读</Button></div>}>
        {loading ? <p className="row small muted" role="status"><LoaderCircle className="size-3.5 animate-spin" />正在读取目录</p> : !catalog ? <p className="text-xs text-destructive" role="alert">{loadError || '暂时无法读取提供方，请重新载入。'}</p> : catalog.providers.length === 0 ? <p className="small muted">新建模型服务，登记连接与模型。</p> : <div className="masterlist" role="group" aria-label="选择模型提供方">{catalog.providers.map((provider, index) => <button key={provider.id} type="button" className={!creating && selectedId === provider.id ? 'active' : ''} disabled={dirty || locked} onClick={() => choose(provider)} aria-pressed={!creating && selectedId === provider.id}><span className="letter">{String(index + 1).padStart(2, '0')}</span><span className="copy"><strong>{provider.name}</strong><span className="muted">{provider.enabled ? '已启用' : '未启用'} · {provider.models.length} 个模型</span></span></button>)}</div>}
      </Section>
      <div className="stack editor-detail">
      {!loading && catalog && <>
      <Section id={nativeFormMetadata.provider.id} title={creating ? '新建模型服务' : selected?.name || '模型服务'} actions={draft && <StatusPill tone={draft.enabled ? 'success' : 'neutral'}>{draft.enabled ? '已启用' : '未启用'}</StatusPill>} footer={draft && <div className="row">
        <SaveBar compact dirty={dirty} saving={saving} disabled={blocked || loading || referenceEditing} message={stateMessage(saveState, dirty)} onSave={save} onReset={blocked ? undefined : reset} label={creating ? '创建提供方' : '保存提供方'} />
        {selected && !onUseModel && <SettingsWindow title="模型使用者" label="使用者与引用" description="方案与助手保留的模型选择；引用更改单独保存。"><ProviderReferenceManager key={selected.id} api={api} connected={connected} providerId={selected.id} revision={catalog.revision} providers={catalog.providers} disabled={loading || saving || blocked || dirty} setDirty={setDirty} onEditingChange={setReferenceEditing} onManageCapabilities={(provider, model, onUpdated) => setCapabilityTarget({ provider, model, onUpdated })} /></SettingsWindow>}
        <span className="push small muted">{dirty ? '未保存草稿' : '已载入'}</span>
        {!creating && selected && <Button variant="destructive" size="sm" disabled={dirty || locked || confirmDelete} onClick={() => setConfirmDelete(true)}>删除服务</Button>}
      </div>}>
        {creating && creationDialogOpen ? <p className="small muted">在新建窗口中编辑服务草稿。</p> : connectionFields}
      </Section>
      {draft && <Section title="模型目录" actions={<Button size="sm" variant="outline" disabled={locked || draft.models.length >= 128} onClick={() => editModel(null)}><Plus className="size-3.5" />添加模型</Button>}>
        <div className="row mb-2"><Input aria-label="搜索模型目录" className="max-w-[270px]" value={modelFilter} onChange={event => setModelFilter(event.target.value)} placeholder="搜索模型显示名称或 API 标识" /><span className="push small muted">显示名称用于选择，API 标识用于实际请求</span></div>
        {dirty && <p className="mb-2 text-xs text-amber-700 dark:text-amber-300" role="status">有未保存的供应商草稿，请先保存后刷新能力或清除缓存。</p>}<div className="tablewrap" role="group" aria-label="可用模型列表"><table><thead><tr><th>模型显示名称</th><th>API 模型 ID</th><th>能力缓存</th><th>使用者</th><th>操作</th></tr></thead><tbody>{draft.models.map((model, index) => ({ model, index })).filter(({ model }) => `${model.name} ${model.id}`.toLowerCase().includes(modelFilter.trim().toLowerCase())).map(({ model, index }) => <tr key={index}><td>{model.name || model.id}</td><td className="font-mono">{model.id}</td><td className="small muted">{capabilityCache.loading ? '读取中' : capabilityCache.error ? '读取失败' : capabilityCache.snapshot?.provider === selected?.id && capabilityCache.snapshot?.models.find(item => item.model === model.id)?.cache ? capabilityCache.snapshot?.models.find(item => item.model === model.id)?.reasoningEfforts.map(modelReasoningEffortLabel).join('、') : '未缓存'}</td><td className="muted">{!plans.snapshot || !assistant.snapshot || plans.error || assistant.error ? '待核对' : providerReferences(draft.id, plans.snapshot, assistant.snapshot).filter(reference => reference.model === model.id).map(reference => reference.name).join('、') || '无引用'}</td><td><div className="row"><Button size="sm" variant="link" disabled={creating || !selected?.models.some(saved => saved.id === model.id)} onClick={() => { if (selected) setCapabilityTarget({ provider: selected.id, model: model.id }); }}>能力</Button><Button size="sm" variant="link" disabled={locked} onClick={() => editModel(index)}>编辑</Button><Button size="sm" variant="link" disabled={locked} onClick={() => setModelDelete({ ownerId: draft.id, index, value: model })}>删除</Button>{onUseModel && <Button size="sm" variant="link" disabled={dirty || locked || !selected?.enabled || !selected.models.some(saved => saved.id === model.id)} onClick={() => { const saved = selected?.models.find(saved => saved.id === model.id); if (selected?.enabled && saved && !dirty && !locked) onUseModel(selected, saved); }}>用于当前方案</Button>}</div></td></tr>)}</tbody></table>{draft.models.length === 0 && <p className="small muted p-3">还没有模型，添加后保存服务即可选择。</p>}</div>
      </Section>}
      </>}
      </div>
    </div>
    {capabilityTarget && catalog && <ProviderModelCapabilityDialog key={JSON.stringify([capabilityTarget.provider, capabilityTarget.model])} api={api} connected={connected} provider={capabilityTarget.provider} model={capabilityTarget.model} providersRevision={catalog.revision} disabledReason={dirty || creating ? '请先保存供应商草稿，再刷新能力或清除缓存。' : loading || saving || blocked ? '供应商设置正在处理或等待核对，请先完成当前操作。' : undefined} onUpdated={capabilityTarget.onUpdated} onClose={() => setCapabilityTarget(null)} />}
    <Dialog open={creating && creationDialogOpen} onOpenChange={open => { if (!saving) { if (!open) clearKeyInput(); setCreationDialogOpen(open); } }}><DialogContent className="sm:max-w-3xl" showCloseButton={!saving}><DialogHeader><DialogTitle>新建模型服务</DialogTitle><DialogDescription>登记连接参数，保存后添加服务支持的模型。</DialogDescription></DialogHeader>{creating && creationDialogOpen && connectionFields}{(fieldError || writeError) && <p role="alert" className="text-xs text-destructive">{fieldError || writeError}</p>}<DialogFooter><Button disabled={!dirty || locked} onClick={save}>{saving ? '正在创建' : '创建模型服务'}</Button><Button variant="ghost" disabled={saving} onClick={() => { clearKeyInput(); setCreationDialogOpen(false); }}>返回编辑</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={modelEditorOpen} onOpenChange={setModelEditorOpen}><DialogContent><DialogHeader><DialogTitle>{modelEditor?.index === null ? '添加模型' : '编辑模型'}</DialogTitle><DialogDescription>修改进入当前服务草稿，保存提供方后才写入模型目录。</DialogDescription></DialogHeader>{modelEditor && <div className="stack"><div className="formgrid"><Field id="provider-model-name" label="显示名称" tip="可选，留空时使用 API 模型 ID。"><Input id="provider-model-name" maxLength={128} disabled={locked} value={modelEditor.value.name} onChange={event => { setModelEditor({ ...modelEditor, value: { ...modelEditor.value, name: event.target.value } }); setModelError(''); }} /></Field><Field id="provider-model-id" label="API 模型 ID"><Input id="provider-model-id" maxLength={128} disabled={locked} value={modelEditor.value.id} onChange={event => { setModelEditor({ ...modelEditor, value: { ...modelEditor.value, id: event.target.value } }); setModelError(''); }} /></Field></div><div className="strip">模型能力以实际元数据为准，登记目录不会调用模型。</div>{modelError && <p role="alert" className="text-xs text-destructive">{modelError}</p>}</div>}<DialogFooter><Button disabled={locked || !modelEditor || modelEditor.ownerId !== draft?.id} onClick={commitModel}>{modelEditor?.index === null ? '添加到服务草稿' : '更新服务草稿'}</Button><Button variant="ghost" onClick={() => setModelEditorOpen(false)}>返回编辑</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={modelDelete !== null} onOpenChange={open => { if (!open) setModelDelete(null); }}><DialogContent><DialogHeader><DialogTitle>移除模型</DialogTitle><DialogDescription>从当前服务草稿移除；保存提供方时核验实际引用。</DialogDescription></DialogHeader><p>{modelDelete?.value.name || modelDelete?.value.id}</p><p className="text-xs text-muted-foreground">被方案或助手使用的模型会在保存时拒绝删除。请先更换对应引用。</p><DialogFooter><Button variant="destructive" disabled={locked || !draft || modelDelete?.ownerId !== draft.id || draft.models[modelDelete?.index ?? -1] !== modelDelete?.value} onClick={() => { if (!draft || !modelDelete || locked || modelDelete.ownerId !== draft.id || draft.models[modelDelete.index] !== modelDelete.value) return; update('models', draft.models.filter((_, index) => index !== modelDelete.index)); setModelDelete(null); }}>从服务草稿移除</Button><Button variant="ghost" onClick={() => setModelDelete(null)}>取消</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={confirmDelete} onOpenChange={value => { if (!saving) setConfirmDelete(value); }}><DialogContent showCloseButton={!saving}><DialogHeader><DialogTitle>删除提供方“{selected?.name}”？</DialogTitle><DialogDescription>同时删除其模型和已保存密钥，无法撤销。被方案或助手引用的服务不能删除。</DialogDescription></DialogHeader>{writeError && <p role="alert" className="text-destructive">{writeError}</p>}<DialogFooter><Button variant="outline" disabled={saving} onClick={() => setConfirmDelete(false)}>取消</Button><Button variant="destructive" disabled={dirty || locked} onClick={remove}>确认删除服务</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
