import { SettingsWindow } from '../components/settings-window.tsx';
import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { catalogFailureState } from '../lib/native-catalog-operation.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { NativeCatalogRecovery } from '../components/native-catalog-recovery.tsx';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import { catalogIdentifierDescription, isCatalogIdentifier, newCatalogIdentifier } from '../lib/catalog-identifier.ts';
import type { PageProps } from '../lib/types.ts';
import { ConnectPrompt, EmptyState, Field, PageHeading, SaveBar, Section } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx';
import { createBuiltinWhalePersonaDraft } from '../../src/host/chat-templates.ts';
import { HelpTip } from '../components/help-tip.tsx';
import { useReadResource } from '../lib/use-read-resource.ts';
import { parsePlanCatalog } from '../lib/chat-plans.ts';
import { DshDeploymentManager } from '../components/dsh-deployment-manager.tsx';

import { validateChatPersona, type ChatPersona as Persona } from '../../src/contracts/chat-plans.ts';
import { DEFAULT_PERSONA_WAKE, validatePersonaWake } from '../../src/contracts/persona-wake.ts';

interface PersonaCatalog {
  readonly revision: string;
  readonly personas: readonly Persona[];
}

interface DeleteTarget {
  readonly persona: Persona;
  readonly revision: string;
  readonly epoch: number;
}

type SaveState = 'idle' | 'saved' | 'deleted' | 'busy' | 'conflict' | 'unknown';

const emptyPersona: Persona = { id: '', name: '', identity: '', style: '' };

function parsePersona(value: unknown): Persona | null {
  try { return validateChatPersona(value); } catch { return null; }
}

function parseCatalog(value: unknown): PersonaCatalog | null {
  const record = asRecord(value);
  if (typeof record.revision !== 'string' || !Array.isArray(record.personas)) return null;
  const personas = record.personas.map(parsePersona);
  if (personas.some(persona => persona === null)) return null;
  const complete = personas as Persona[];
  if (new Set(complete.map(persona => persona.id)).size !== complete.length) return null;
  return { revision: record.revision, personas: complete };
}

function samePersona(left: Persona, right: Persona): boolean {
  return left.id === right.id && left.name === right.name && left.identity === right.identity && left.style === right.style
    && JSON.stringify(left.wake ?? DEFAULT_PERSONA_WAKE) === JSON.stringify(right.wake ?? DEFAULT_PERSONA_WAKE);
}

function stateForError(error: unknown): SaveState {
  return catalogFailureState(error);
}

function stateMessage(state: SaveState, dirty: boolean): string {
  if (state === 'deleted') return '人设已删除；未删除会话、历史、上下文、资源、方案或授权。';
  if (state === 'saved') return '人设库已保存。';
  if (state === 'busy') return '另一项保存正在进行，请稍后重新载入后再提交；不会自动重试。';
  if (state === 'conflict') return '人设库已在其他窗口更新，请重新载入。';
  if (state === 'unknown') return '无法确认保存结果，请重新载入核对；不会自动重试。';
  return dirty ? '人设更改尚未保存。' : '当前内容与已保存人设库一致。';
}

const personaDraftKey = createDraftKey<{ readonly catalog: PersonaCatalog; readonly draft: Persona; readonly selectedId: string | null; readonly creating: boolean; readonly creationId: string }>('personas');

export function PersonaPage(props: PageProps) {
  const { api, connected, connect, setDirty, navigate } = props;
  const recovery = useNativeCatalogOperation(api, 'personas');
  const plans = useReadResource(api, '/api/chat/plans', connected, parsePlanCatalog);
  const activePlan = plans.snapshot?.plans.find(plan => plan.id === plans.snapshot?.activePlanId);
  const retained = useMemo(() => retainedDraft(api, personaDraftKey), [api]);
  const draftApi = useRef(api);
  const [catalog, setCatalog] = useState<PersonaCatalog | null>(retained?.catalog ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(retained?.selectedId ?? null);
  const [draft, setDraft] = useState<Persona>(retained?.draft ?? emptyPersona);
  const [creating, setCreating] = useState(retained?.creating ?? false);
  const [creationDialogOpen, setCreationDialogOpen] = useState(false);
  const [creationId, setCreationId] = useState(retained?.creationId ?? '');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [reloadVersion, setReloadVersion] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const pendingDelete = useRef<DeleteTarget | null>(null);
  const confirmationValue = useRef('');
  const deleteButton = useRef<HTMLButtonElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const reportedDirty = useRef(false);
  const setDirtyRef = useRef(setDirty);
  const lifecycleEpoch = useRef(0);
  const saveController = useRef<AbortController | null>(null);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const selected = catalog?.personas.find(persona => persona.id === selectedId) ?? null;
  const dirty = creating
    ? draft.id !== creationId || [draft.name, draft.identity, draft.style].some(value => value.trim() !== '') || JSON.stringify(draft.wake ?? DEFAULT_PERSONA_WAKE) !== JSON.stringify(DEFAULT_PERSONA_WAKE)
    : selected !== null && !samePersona(draft, selected);
  const idConflict = useMemo(() => creating && catalog?.personas.some(persona => persona.id === draft.id.trim()) === true, [catalog, creating, draft.id]);
  const blocked = recovery.blocked || saveState === 'busy' || saveState === 'conflict' || saveState === 'unknown';
  const editingDisabled = loading || saving || blocked || deleteTarget !== null;
  const templateDisabled = dirty || editingDisabled;
  const currentView = useRef({ api, catalog, draft, selectedId, dirty, creating, blocked, loading });
  currentView.current = { api: draftApi.current, catalog, draft, selectedId, dirty, creating, blocked, loading };

  useEffect(() => {
    if (draftApi.current !== api) return;
    retainDraft(api, personaDraftKey, connected && dirty && catalog ? { catalog, draft, selectedId, creating, creationId } : null);
  }, [api, connected, dirty, catalog, draft, selectedId, creating, creationId]);
  useEffect(() => { setDirtyRef.current = setDirty; }, [setDirty]);
  useEffect(() => {
    if (reportedDirty.current === dirty) return;
    reportedDirty.current = dirty;
    setDirty(dirty, 'personas');
  }, [dirty, setDirty]);
  useEffect(() => () => {
    lifecycleEpoch.current += 1;
    saveController.current?.abort();
    pendingDelete.current = null;
    confirmationValue.current = '';
    reportedDirty.current = false;
    setDirtyRef.current(false, 'personas');
  }, []);

  useEffect(() => {
    const epoch = ++lifecycleEpoch.current;
    const controller = new AbortController();
    saveController.current?.abort();
    saveController.current = null;
    clearDelete();
    setCreationDialogOpen(false);
    const isCurrent = () => !controller.signal.aborted && lifecycleEpoch.current === epoch
      && connection.current.api === api && connection.current.connected;
    const prior = currentView.current.api === api ? currentView.current : null;
    draftApi.current = api;
    const preserveDraft = prior?.dirty === true && prior.catalog !== null;
    setSaving(false);
    setLoading(connected);
    setCatalog(connected ? prior?.catalog ?? null : null);
    if (!preserveDraft || !connected) { setSelectedId(null); setDraft(emptyPersona); setCreating(false); }
    setLoadError('');
    setWriteError('');
    setFieldError('');
    setSaveState('idle');
    if (!connected) {
      return () => { controller.abort(); lifecycleEpoch.current += 1; };
    }
    void readResource(api, '/api/chat/personas', controller.signal).then(value => {
      if (!isCurrent()) return;
      const next = parseCatalog(value);
      if (!next) throw new Error('invalid_personas_response');
      const preferred = next.personas[0] ?? null;
      setCatalog(next);
      recovery.review();
      if (preserveDraft) {
        setCreating(prior.creating || !next.personas.some(persona => persona.id === prior.draft.id));
      } else {
        const initial = preferred ?? { ...emptyPersona, id: newCatalogIdentifier('persona') };
        setCreationId(preferred ? '' : initial.id);
        setSelectedId(preferred?.id ?? null); setDraft(initial); setCreating(preferred === null);
      }
    }).catch(error => {
      if (isCurrent()) {
        if (!prior?.catalog) setCatalog(null);
        setLoadError(errorMessage(error));
      }
    }).finally(() => {
      if (isCurrent()) setLoading(false);
    });
    return () => {
      controller.abort();
      saveController.current?.abort();
      lifecycleEpoch.current += 1;
    };
  }, [api, connected, reloadVersion]);

  function update<Key extends keyof Persona>(key: Key, value: Persona[Key]): void {
    if (editingDisabled || currentView.current.blocked || currentView.current.loading || pendingDelete.current || saveController.current || key === 'id' && !creating) return;
    currentView.current.dirty = true;
    setDraft(current => ({ ...current, [key]: value }));
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function choose(persona: Persona): void {
    if (dirty || currentView.current.dirty || editingDisabled || currentView.current.blocked || pendingDelete.current || saveController.current) return;
    currentView.current.selectedId = persona.id;
    setSelectedId(persona.id);
    setDraft(persona);
    setCreating(false);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function createPersona(): void {
    if (dirty || currentView.current.dirty || editingDisabled || currentView.current.blocked || pendingDelete.current || saveController.current) return;
    currentView.current.creating = true;
    setCreationDialogOpen(true);
    setSelectedId(null);
    const id = newCatalogIdentifier('persona');
    setCreationId(id);
    setDraft({ ...emptyPersona, id });
    setCreating(true);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function useBuiltinPersona(): void {
    if (!catalog || templateDisabled || currentView.current.dirty || currentView.current.blocked || pendingDelete.current || saveController.current) return;
    currentView.current.creating = true;
    setCreationDialogOpen(true);
    setCreationId('');
    setSelectedId(null);
    setDraft(createBuiltinWhalePersonaDraft(catalog.personas));
    setCreating(true);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  async function save(): Promise<void> {
    if (!connected || connection.current.api !== api || !connection.current.connected || !catalog || !dirty || editingDisabled || currentView.current.blocked || pendingDelete.current || saveController.current) return;
    const normalized = { ...draft, id: draft.id.trim(), name: draft.name.trim() };
    try { if (normalized.wake) normalized.wake = validatePersonaWake({ ...normalized.wake, nicknames: normalized.wake.nicknames.filter(name => name.length > 0) }); }
    catch { setFieldError('昵称最多 16 个，每个不超过 128 字且不能重复；续聊时长为 0–300 秒。'); return; }
    if (!normalized.id || !normalized.name || !normalized.identity.trim() || !normalized.style.trim()) {
      setFieldError('内部标识、名称、身份和表达风格必须填写。');
      return;
    }
    if (!isCatalogIdentifier(normalized.id)) {
      setFieldError(catalogIdentifierDescription);
      return;
    }
    if (idConflict) {
      setFieldError('内部标识已存在。');
      return;
    }
    const personas = creating ? [...catalog.personas, normalized] : catalog.personas.map(persona => persona.id === selectedId ? normalized : persona);
    const controller = new AbortController();
    const epoch = lifecycleEpoch.current;
    saveController.current = controller;
    const operationToken = recovery.begin(catalog.revision, controller.signal);
    if (!operationToken) { saveController.current = null; return; }
    const isCurrent = () => !controller.signal.aborted && lifecycleEpoch.current === epoch
      && saveController.current === controller && connection.current.api === api && connection.current.connected;
    setSaving(true);
    setWriteError('');
    setSaveState('idle');
    try {
      const response = await writeResource(api, '/api/chat/personas', { revision: catalog.revision, personas }, controller.signal);
      if (!isCurrent()) return;
      const next = parseCatalog(response);
      if (!next) throw new ApiError('personas_save_unknown', 504);
      const saved = next.personas.find(persona => persona.id === normalized.id);
      if (!saved) throw new ApiError('personas_save_unknown', 504);
      setCatalog(next);
      setSelectedId(saved.id);
      setDraft(saved);
      setCreating(false);
      setCreationDialogOpen(false);
      recovery.complete(operationToken);
      setSaveState('saved');
    } catch (error) {
      recovery.fail(operationToken, error);
      if (!isCurrent()) return;
      setSaveState(stateForError(error));
      setWriteError(errorMessage(error));
    } finally {
      if (isCurrent()) {
        saveController.current = null;
        setSaving(false);
      }
    }
  }

  function reset(): void {
    if (editingDisabled || currentView.current.blocked || pendingDelete.current || saveController.current) return;
    if (creating) { setDraft({ ...emptyPersona, id: creationId || draft.id }); setCreationId(creationId || draft.id); }
    else setDraft(selected ?? emptyPersona);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function clearDelete(): void {
    pendingDelete.current = null;
    confirmationValue.current = '';
    setDeleteTarget(null);
    setDeleteConfirmation('');
  }

  function openDelete(): void {
    const view = currentView.current;
    if (!connected || !connection.current.connected || connection.current.api !== api || !catalog || !selected
      || view.catalog !== catalog || view.selectedId !== selected.id || view.creating || view.dirty || view.loading || view.blocked
      || saveController.current || pendingDelete.current) return;
    const target = { persona: selected, revision: catalog.revision, epoch: lifecycleEpoch.current };
    pendingDelete.current = target;
    confirmationValue.current = '';
    setDeleteTarget(target);
    setDeleteConfirmation('');
    setWriteError('');
    setFieldError('');
    setSaveState('idle');
  }

  function closeDelete(): void {
    if (saveController.current) return;
    clearDelete();
  }

  function deleteFinalFocus(): HTMLElement | false {
    const opener = deleteButton.current;
    if (opener?.isConnected && !opener.disabled) return opener;
    const create = createButton.current;
    return create?.isConnected && !create.disabled ? create : false;
  }

  function reload(): void {
    if (currentView.current.dirty && !currentView.current.blocked || pendingDelete.current || saveController.current || currentView.current.loading) return;
    setReloadVersion(version => version + 1);
  }

  async function removePersona(): Promise<void> {
    const target = deleteTarget;
    const view = currentView.current;
    if (!target || pendingDelete.current !== target || confirmationValue.current !== target.persona.name
      || !connected || !connection.current.connected || connection.current.api !== api || lifecycleEpoch.current !== target.epoch
      || !catalog || view.catalog !== catalog || catalog.revision !== target.revision || view.selectedId !== target.persona.id
      || view.dirty || view.creating || view.loading || view.blocked || saveController.current) return;
    const personas = catalog.personas.filter(persona => persona.id !== target.persona.id);
    const controller = new AbortController();
    saveController.current = controller;
    const operationToken = recovery.begin(catalog.revision, controller.signal);
    if (!operationToken) { saveController.current = null; return; }
    const isCurrent = () => !controller.signal.aborted && lifecycleEpoch.current === target.epoch
      && saveController.current === controller && connection.current.api === api && connection.current.connected;
    setSaving(true);
    setWriteError('');
    try {
      const response = await writeResource(api, '/api/chat/personas', { revision: target.revision, personas }, controller.signal);
      if (!isCurrent()) return;
      const next = parseCatalog(response);
      if (!next || !/^[a-f0-9]{64}$/.test(next.revision) || next.revision === target.revision || next.personas.length !== personas.length
        || personas.some(persona => !next.personas.some(saved => samePersona(saved, persona)))) {
        throw new ApiError('personas_delete_unknown', 504);
      }
      const preferred = next.personas[0] ?? null;
      setCatalog(next);
      setSelectedId(preferred?.id ?? null);
      setDraft(preferred ?? emptyPersona);
      setCreating(preferred === null);
      clearDelete();
      recovery.complete(operationToken);
      setSaveState('deleted');
    } catch (error) {
      recovery.fail(operationToken, error);
      if (!isCurrent()) return;
      setSaveState(stateForError(error));
      setWriteError(error instanceof ApiError && error.code === 'persona_in_use_or_missing'
        ? '该人设仍被聊天方案引用，或目录已变化。请先调整关联，再重新载入核对；不会自动删除其他配置。'
        : errorMessage(error));
    } finally {
      if (isCurrent()) {
        saveController.current = null;
        setSaving(false);
      }
    }
  }

  const editorFields = <div className="grid min-w-0 gap-2">
              <div className="formgrid">
                <Field id="chat-persona-name" label={nativeFormMetadata.persona.fields.name}><Input id="chat-persona-name" value={draft.name} disabled={editingDisabled} maxLength={128} placeholder="日常伙伴" onChange={event => update('name', event.target.value)} /></Field>
                <Field id="chat-persona-nicknames" label="呼叫昵称" tip="用逗号分隔，最多 16 个。人设名称也可用于呼叫。"><Input id="chat-persona-nicknames" disabled={editingDisabled} value={(draft.wake ?? DEFAULT_PERSONA_WAKE).nicknames.join('，')} onChange={event => update('wake', { ...(draft.wake ?? DEFAULT_PERSONA_WAKE), nicknames: event.target.value.split(/[,，]/).map(value => value.trim()) })} /></Field></div><div className="row small muted"><span className={activePlan?.personaId === draft.id && !creating ? 'badge good' : 'badge'}>{activePlan?.personaId === draft.id && !creating ? '当前方案正在使用' : '可供方案选择'}</span><span>唤醒设置保存后即时生效</span><span className="push"><SettingsWindow title="唤醒与续聊" description="白名单内私聊和群聊 @ 必定唤醒，其他方式随人设保存。">              <div id="persona-wake" className="grid gap-2"><Field id="persona-wake-nicknames" label="额外昵称" tip="最多 16 个，逗号分隔；人设名称本身可用于呼叫。"><Input id="persona-wake-nicknames" disabled={editingDisabled} value={(draft.wake ?? DEFAULT_PERSONA_WAKE).nicknames.join('，')} onChange={event => update('wake', { ...(draft.wake ?? DEFAULT_PERSONA_WAKE), nicknames: event.target.value.split(/[,，]/).map(value => value.trim()) })} /></Field>
                <div className="flex items-center gap-0.5"><h3 className="text-xs font-medium">唤醒与续聊</h3><HelpTip label="唤醒与续聊">保存后即时生效。白名单内的私聊和群聊 @ 必定唤醒。</HelpTip></div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={editingDisabled} checked={(draft.wake ?? DEFAULT_PERSONA_WAKE).wakeOnReply} onChange={event => update('wake', { ...(draft.wake ?? DEFAULT_PERSONA_WAKE), wakeOnReply: event.target.checked })} />引用机器人时唤醒</label>
                  <div className="flex flex-wrap items-center gap-2"><div className="flex items-center gap-0.5"><label className="field-label" htmlFor="chat-persona-continuation">会话续聊时长</label><HelpTip label="会话续聊时长">从最近一次呼叫起，本会话所有发言者的消息都可进入参与判断，包括引用或 @ 他人的消息；不相关时保持安静。普通消息和机器人回复不续长时长，0 表示关闭，最长 300 秒。</HelpTip></div><Input id="chat-persona-continuation" className="w-24" type="number" min={0} max={300} step={1} disabled={editingDisabled} value={(draft.wake ?? DEFAULT_PERSONA_WAKE).continuationMs / 1000} onChange={event => update('wake', { ...(draft.wake ?? DEFAULT_PERSONA_WAKE), continuationMs: Number(event.target.value) * 1000 })} /><span className="text-xs text-muted-foreground">秒</span></div>
                </div>
                <div className="row border-t pt-2"><Button disabled={!dirty || editingDisabled} onClick={() => void save()}>{saving ? '正在保存' : '保存人设设置'}</Button></div>
              </div>
</SettingsWindow></span>
              </div>
              {creating && <SettingsWindow title="内部标识" label="内部标识" description="已自动生成；只在关联现有配置时需要修改。"><div className="mt-3"><Field className="max-w-sm" label={nativeFormMetadata.persona.fields.id} description="已自动生成，通常无需修改。需要兼容既有引用时可调整；创建后固定。"><Input id="chat-persona-id" value={draft.id} disabled={!creating || editingDisabled} maxLength={128} onChange={event => update('id', event.target.value)} /></Field></div></SettingsWindow>}
              <div className="editorgrid">
              <div className="grid gap-2"><div className="flex items-center gap-0.5"><label className="field-label" htmlFor="chat-persona-identity">{nativeFormMetadata.persona.fields.identity}</label><HelpTip label={nativeFormMetadata.persona.fields.identity}>说明角色身份、关系边界和稳定事实。</HelpTip></div><Textarea id="chat-persona-identity" value={draft.identity} disabled={editingDisabled} rows={13} className="min-h-64 resize-y leading-5" placeholder="描述这个角色是谁" onChange={event => update('identity', event.target.value)} /></div>
              <div className="grid gap-2"><div className="flex items-center gap-0.5"><label className="field-label" htmlFor="chat-persona-style">{nativeFormMetadata.persona.fields.style}</label><HelpTip label={nativeFormMetadata.persona.fields.style}>说明语气、措辞和表达边界。能力与权限由框架配置。</HelpTip></div><Textarea id="chat-persona-style" value={draft.style} disabled={editingDisabled} rows={13} className="min-h-64 resize-y leading-5" placeholder="描述这个角色如何表达" onChange={event => update('style', event.target.value)} /></div>
              </div>

              <div className="strip">身份与表达分开编辑；模型、能力与权限在各自设置中维护。</div>
              {fieldError && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />{fieldError}</div>}
              {writeError && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><span>{writeError}</span>{(saveState === 'busy' || saveState === 'conflict' || saveState === 'unknown') && <Button size="sm" variant="outline" disabled={deleteTarget !== null || saving || loading} onClick={reload}>重新载入</Button>}</div>}
            </div>;

  if (!connected) return <div className="page-stack" data-page="persona"><PageHeading title="人设与唤醒" description="管理身份、表达风格和唤醒方式。" /><ConnectPrompt connect={connect} /></div>;

  return <div className="page-stack" data-page="persona">
    <PageHeading title="人设与唤醒" description="每个人设保存身份、表达风格和唤醒方式，随聊天方案选用。" actions={<><Button variant="outline" onClick={useBuiltinPersona} disabled={!catalog || templateDisabled} title="将内置小鲸鱼填入新的草稿">使用内置人设</Button><Button variant="outline" onClick={reload} disabled={loading || saving || dirty && !blocked || deleteTarget !== null}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新载入</Button></>} />
    <NativeCatalogRecovery recovery={recovery} reading={loading || saving || deleteTarget !== null} onRead={reload} onReleased={() => { setSaveState('idle'); setWriteError(''); }} />
    {loading && !catalog ? <Section title="人设库"><div className="flex min-h-32 items-center justify-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取人设库</div></Section>
      : !catalog ? <Section title="人设库不可用" description={loadError || '服务没有返回可识别的人设库。'}><EmptyState locked title="无法读取原生人设库" description="暂时无法读取人设内容，请稍后重试。" /></Section>
        : <div className="masterdetail editor-workspace">
          <Section className="editor-directory" title="人设目录" actions={<Button id="persona-create-open" ref={createButton} size="sm" variant="ghost" onClick={createPersona} disabled={dirty || editingDisabled}><Plus className="size-3.5" />新建</Button>} footer={<span className="text-xs text-muted-foreground">{catalog.personas.length} 项人设</span>}>
            {catalog.personas.length === 0 ? <p className="text-xs text-muted-foreground">还没有人设，可新建或使用内置小鲸鱼。</p> : <div className="masterlist" aria-label="人设目录">{catalog.personas.map((persona, index) => <button key={persona.id} type="button" className={!creating && selectedId === persona.id ? 'active' : ''} aria-pressed={!creating && selectedId === persona.id} disabled={dirty || editingDisabled} onClick={() => choose(persona)}><span className="letter">{String(index + 1).padStart(2, '0')}</span><span className="copy"><strong>{persona.name}</strong><span className="muted">{plans.snapshot?.plans.filter(plan => plan.personaId === persona.id).map(plan => plan.name).join('、') || (plans.snapshot ? '尚未关联方案' : '身份与表达风格')}</span></span></button>)}</div>}
          </Section>
          <div className="stack editor-detail"><Section id={nativeFormMetadata.persona.id} actions={<span className="badge">人设草稿</span>} title={creating ? '新建人设' : draft.name || '人设内容'} footer={<div className="flex flex-wrap items-center gap-2"><SaveBar compact dirty={dirty} saving={saving} disabled={blocked || loading || deleteTarget !== null} message={stateMessage(saveState, dirty)} onSave={() => void save()} onReset={blocked ? undefined : reset} label={creating ? '创建人设' : '保存人设'} /><DshDeploymentManager compact api={api} connected={connected} setDirty={setDirty} configurationDirty={dirty || editingDisabled || creating} configurationRevision={catalog.revision} configurationDocument="personas" selectedPersonaId={selectedId ?? ''} />{!creating && selected && <Button id="persona-delete-open" ref={deleteButton} size="sm" variant="destructive" className="ml-auto" disabled={dirty || editingDisabled} onClick={openDelete}><Trash2 className="size-3.5" />删除</Button>}</div>}>
            {creating && creationDialogOpen ? <p className="small muted">在新建窗口中编辑人设草稿。</p> : editorFields}
          </Section></div>
        </div>}
    <Dialog open={creating && creationDialogOpen} onOpenChange={open => { if (!saving) setCreationDialogOpen(open); }}><DialogContent className="sm:max-w-5xl" showCloseButton={!saving}><DialogHeader><DialogTitle>新建人设</DialogTitle><DialogDescription>编辑新的草稿，保存后可在聊天方案中选择。</DialogDescription></DialogHeader>{creating && creationDialogOpen && editorFields}<DialogFooter><Button variant="outline" className="mr-auto" onClick={useBuiltinPersona} disabled={templateDisabled} title={dirty ? '请先保存或撤销当前草稿' : '填入内置小鲸鱼'}>填入内置人设</Button><Button disabled={!dirty || editingDisabled} onClick={() => void save()}>{saving ? '正在创建' : '创建人设'}</Button><Button variant="ghost" disabled={saving} onClick={() => setCreationDialogOpen(false)}>返回编辑</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={deleteTarget !== null} onOpenChange={open => { if (!open) closeDelete(); }}>
      <DialogContent className="sm:max-w-[480px]" showCloseButton={!saving} finalFocus={deleteFinalFocus}>
        <DialogHeader><DialogTitle>删除选中的人设？</DialogTitle><DialogDescription>删除后无法撤销。仍被聊天方案使用的人设不能删除。</DialogDescription></DialogHeader>
        {deleteTarget && <div className="grid min-w-0 gap-2">
          <p className="break-words rounded-lg border border-destructive/30 p-3 text-xs leading-6"><strong className="block">{deleteTarget.persona.name}</strong></p>
          <Field label="输入人设名称确认" className="[&>.management-field-label]:grid-cols-[max-content_minmax(0,1fr)] [&_.field-label]:whitespace-nowrap"><Input id="persona-delete-confirm-id" value={deleteConfirmation} autoComplete="off" spellCheck={false} disabled={saving || blocked} placeholder={deleteTarget.persona.name} onChange={event => { if (saveController.current || blocked || pendingDelete.current !== deleteTarget) return; confirmationValue.current = event.target.value; setDeleteConfirmation(event.target.value); }} /></Field>
          {writeError && <p role="alert" className="text-xs leading-6 text-destructive">{writeError}{blocked && ' 请关闭确认并重新载入核对，不会自动重试。'}</p>}
        </div>}
        <DialogFooter><Button id="persona-delete-cancel" variant="outline" disabled={saving} onClick={closeDelete}>{blocked ? '关闭确认' : '取消'}</Button><Button id="persona-delete-submit" variant="destructive" disabled={!deleteTarget || deleteConfirmation !== deleteTarget.persona.name || saving || blocked || loading} onClick={() => void removePersona()}>{saving && <LoaderCircle className="size-3.5 animate-spin" />}{saving ? '正在删除' : '确认删除人设'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
