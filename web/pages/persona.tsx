import { AppearanceManager } from '../components/appearance-manager.tsx';
import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { catalogFailureState } from '../lib/native-catalog-operation.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { NativeCatalogRecovery } from '../components/native-catalog-recovery.tsx';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import { catalogIdentifierDescription, isCatalogIdentifier, newCatalogIdentifier } from '../lib/catalog-identifier.ts';
import type { PageProps } from '../lib/types.ts';
import { ConnectPrompt, EmptyState, Field, PageHeading, SaveBar, Section } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx';
import { createBuiltinWhalePersonaDraft } from '../../src/host/chat-templates.ts';
import { VirtualList } from '../components/virtual-list.tsx';
import { DshDeploymentManager } from '../components/dsh-deployment-manager.tsx';

interface Persona {
  readonly id: string;
  readonly name: string;
  readonly identity: string;
  readonly style: string;
}

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
  const record = asRecord(value);
  if (typeof record.id !== 'string' || typeof record.name !== 'string'
    || typeof record.identity !== 'string' || typeof record.style !== 'string') return null;
  return { id: record.id, name: record.name, identity: record.identity, style: record.style };
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
  return left.id === right.id && left.name === right.name && left.identity === right.identity && left.style === right.style;
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
  const retained = useMemo(() => retainedDraft(api, personaDraftKey), [api]);
  const draftApi = useRef(api);
  const [catalog, setCatalog] = useState<PersonaCatalog | null>(retained?.catalog ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(retained?.selectedId ?? null);
  const [draft, setDraft] = useState<Persona>(retained?.draft ?? emptyPersona);
  const [creating, setCreating] = useState(retained?.creating ?? false);
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
    ? draft.id !== creationId || [draft.name, draft.identity, draft.style].some(value => value.trim() !== '')
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
    if (!target || pendingDelete.current !== target || confirmationValue.current !== target.persona.id
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
      setWriteError(error instanceof ApiError && (error.code === 'persona_in_use_or_missing' || error.code === 'persona_in_use_by_appearance')
        ? '该人设仍被聊天方案或角色参考图绑定引用，或目录已变化。请先调整关联或解除参考图绑定，再重新载入核对；不会自动删除其他配置。'
        : errorMessage(error));
    } finally {
      if (isCurrent()) {
        saveController.current = null;
        setSaving(false);
      }
    }
  }

  if (!connected) return <div className="page-stack" data-page="persona"><PageHeading title="人设与形象" description="独立管理身份定义与表达风格。" /><ConnectPrompt connect={connect} /></div>;

  return <div className="page-stack" data-page="persona">
    <PageHeading title="人设与形象" description="人设库只定义身份和表达风格。聊天方案可以选择关联人设，能力、访问授权和用户偏好仍分别管理。" actions={<Button variant="outline" onClick={reload} disabled={loading || saving || dirty && !blocked || deleteTarget !== null}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新载入</Button>} />
    <NativeCatalogRecovery recovery={recovery} reading={loading || saving || deleteTarget !== null} onRead={reload} onReleased={() => { setSaveState('idle'); setWriteError(''); }} />
    {loading && !catalog ? <Section scrollable title="人设库"><div className="flex min-h-52 items-center justify-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取人设库</div></Section>
      : !catalog ? <Section title="人设库不可用" description={loadError || '服务没有返回可识别的人设库。'}><EmptyState locked title="无法读取原生人设库" description="暂时无法读取人设内容，请稍后重试。" /></Section>
        : <div className="grid items-start gap-5 lg:grid-cols-[minmax(14rem,0.32fr)_minmax(0,1fr)]">
          <Section scrollable title="人设库" description="这里保存可被聊天方案引用的人设。" actions={<Button id="persona-create-open" ref={createButton} size="sm" onClick={createPersona} disabled={dirty || editingDisabled}><Plus className="size-3.5" />新建人设</Button>}>
            {catalog.personas.length > 0 && <div className="mb-4 grid gap-2 rounded-lg border border-dashed p-3">
              <Button size="sm" variant="outline" onClick={useBuiltinPersona} disabled={templateDisabled}>使用内置小鲸鱼</Button>
              <p className="text-xs leading-5 text-muted-foreground">完整角色草稿，身份定义与表达风格分开填写。只填入新的未保存草稿，不覆盖现有人设；保存后仍需在聊天方案中选择关联。</p>
            </div>}
            <div className="min-w-0">{catalog.personas.length === 0 ? <EmptyState title="还没有人设" description="从内置小鲸鱼创建完整角色草稿，身份定义与表达风格分开填写；也可使用上方新建人设。不会自动保存或启用；保存后仍需在聊天方案中选择关联。" action={<Button size="sm" onClick={useBuiltinPersona} disabled={templateDisabled}>使用内置小鲸鱼</Button>} /> : <VirtualList items={catalog.personas} getItemKey={persona => persona.id} estimateSize={64} itemClassName="pb-1.5">{persona => <Button key={persona.id} variant={!creating && selectedId === persona.id ? 'secondary' : 'ghost'} className="h-auto w-full justify-start px-3 py-2.5 text-left whitespace-normal" disabled={dirty || editingDisabled} onClick={() => choose(persona)}><UserRound className="size-4 shrink-0" /><span className="min-w-0 flex-1"><strong className="block truncate text-xs font-medium">{persona.name}</strong><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{persona.id}</span></span></Button>}</VirtualList>}</div>
          </Section>
          <Section scrollable id={nativeFormMetadata.persona.id} title={creating ? '新建人设' : draft.name || '人设内容'} description="只描述这个角色是谁、如何表达；不要在这里写工具权限、触发条件或用户偏好。" footer={<SaveBar dirty={dirty} saving={saving} disabled={blocked || loading || deleteTarget !== null} message={stateMessage(saveState, dirty)} onSave={() => void save()} onReset={blocked ? undefined : reset} label={creating ? '创建人设' : '保存人设'}><Button variant="outline" onClick={() => navigate('model')}>查看聊天方案</Button></SaveBar>}>
            <div className="grid gap-5">
              <Field label={nativeFormMetadata.persona.fields.name}><Input value={draft.name} disabled={editingDisabled} maxLength={128} placeholder="日常伙伴" onChange={event => update('name', event.target.value)} /></Field>
              <details key={selectedId ?? creationId} className="rounded-lg border bg-muted/20 p-3"><summary className="cursor-pointer text-xs font-medium">高级设置</summary><div className="mt-3"><Field label={nativeFormMetadata.persona.fields.id} description={creating ? '已自动生成，通常无需修改。需要兼容既有引用时可调整；创建后固定。' : '用于稳定关联，现有内部标识不可修改。'}><Input id="chat-persona-id" value={draft.id} disabled={!creating || editingDisabled} maxLength={128} onChange={event => update('id', event.target.value)} /></Field></div></details>
              <Field label={nativeFormMetadata.persona.fields.identity} description="说明角色身份、关系边界和稳定事实。"><Textarea value={draft.identity} disabled={editingDisabled} className="h-44 resize-none leading-6" placeholder="描述这个角色是谁" onChange={event => update('identity', event.target.value)} /></Field>
              <Field label={nativeFormMetadata.persona.fields.style} description="说明语气、措辞和表达边界，不包含能力授权。"><Textarea value={draft.style} disabled={editingDisabled} className="h-36 resize-none leading-6" placeholder="描述这个角色如何表达" onChange={event => update('style', event.target.value)} /></Field>
              {!creating && selected && <details className="rounded-lg border border-destructive/30 p-3 text-xs leading-6"><summary className="cursor-pointer font-medium">删除此人设</summary><div className="mt-3 grid gap-3"><p>被方案引用时不能删除。确认后仅移除此人设，不删除会话、历史或授权。</p><Button id="persona-delete-open" ref={deleteButton} variant="destructive" disabled={dirty || editingDisabled} onClick={openDelete}><Trash2 className="size-3.5" />删除人设</Button></div></details>}
              {fieldError && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />{fieldError}</div>}
              {writeError && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><span>{writeError}</span>{(saveState === 'busy' || saveState === 'conflict' || saveState === 'unknown') && <Button size="sm" variant="outline" disabled={deleteTarget !== null || saving || loading} onClick={reload}>重新载入</Button>}</div>}
            </div>
          </Section>
        </div>}
    {catalog && <DshDeploymentManager compact navigate={navigate} api={api} connected={connected} setDirty={setDirty} configurationDirty={dirty || editingDisabled || creating} configurationRevision={catalog.revision} configurationDocument="personas" />}
    <AppearanceManager api={api} connected={connected} personaId={creating ? null : selectedId} personaDirty={dirty || editingDisabled} setDirty={setDirty} />
    <Dialog open={deleteTarget !== null} onOpenChange={open => { if (!open) closeDelete(); }}>
      <DialogContent showCloseButton={!saving} finalFocus={deleteFinalFocus}>
        <DialogHeader><DialogTitle>删除选中的人设？</DialogTitle><DialogDescription>只从人设库移除这一项，不能撤销；不会删除聊天方案、会话、历史、上下文、资源或授权。被方案引用的人设会由服务端拒绝删除。</DialogDescription></DialogHeader>
        {deleteTarget && <div className="grid min-w-0 gap-4">
          <p className="break-words rounded-lg border border-destructive/30 p-3 text-xs leading-6"><strong className="block">{deleteTarget.persona.name}</strong><span className="select-all break-all">{deleteTarget.persona.id}</span></p>
          <Field label="输入完整人设标识以确认"><Input id="persona-delete-confirm-id" value={deleteConfirmation} autoComplete="off" spellCheck={false} disabled={saving || blocked} placeholder={deleteTarget.persona.id} onChange={event => { if (saveController.current || blocked || pendingDelete.current !== deleteTarget) return; confirmationValue.current = event.target.value; setDeleteConfirmation(event.target.value); }} /></Field>
          {writeError && <p role="alert" className="text-xs leading-6 text-destructive">{writeError}{blocked && ' 请关闭确认并重新载入核对，不会自动重试。'}</p>}
        </div>}
        <DialogFooter><Button id="persona-delete-cancel" variant="outline" disabled={saving} onClick={closeDelete}>{blocked ? '关闭确认' : '取消'}</Button><Button id="persona-delete-submit" variant="destructive" disabled={!deleteTarget || deleteConfirmation !== deleteTarget.persona.id || saving || blocked || loading} onClick={() => void removePersona()}>{saving && <LoaderCircle className="size-3.5 animate-spin" />}{saving ? '正在删除' : '确认删除人设'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
