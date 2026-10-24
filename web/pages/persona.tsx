import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, Plus, RefreshCw, UserRound } from 'lucide-react';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import { catalogIdentifierDescription, isCatalogIdentifier } from '../lib/catalog-identifier.ts';
import type { PageProps } from '../lib/types.ts';
import { ConnectPrompt, EmptyState, Field, PageHeading, SaveBar, Section } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { ConfigurationEditor } from '../components/configuration-editor.tsx';
import { createBuiltinWhalePersonaDraft } from '../../src/host/chat-templates.ts';

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

type SaveState = 'idle' | 'saved' | 'busy' | 'conflict' | 'unknown';

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
  if (error instanceof ApiError && error.code === 'chat_storage_busy') return 'busy';
  if (error instanceof ApiError && (error.status === 409 || /conflict|revision/.test(error.code))) return 'conflict';
  if (error instanceof ApiError && (error.status >= 500 || /unknown/.test(error.code))) return 'unknown';
  return error instanceof ApiError && error.status >= 400 && error.status < 500 ? 'idle' : 'unknown';
}

function stateMessage(state: SaveState, dirty: boolean): string {
  if (state === 'saved') return '人设库已保存。';
  if (state === 'busy') return '另一项保存正在进行，请稍后重新载入后再提交；不会自动重试。';
  if (state === 'conflict') return '人设库已在其他窗口更新，请重新载入。';
  if (state === 'unknown') return '无法确认保存结果，请重新载入核对；不会自动重试。';
  return dirty ? '人设更改尚未保存。' : '当前内容与已保存人设库一致。';
}

export function PersonaPage(props: PageProps) {
  const { api, connected, connect, setDirty, navigate } = props;
  const [catalog, setCatalog] = useState<PersonaCatalog | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Persona>(emptyPersona);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [reloadVersion, setReloadVersion] = useState(0);
  const reportedDirty = useRef(false);
  const setDirtyRef = useRef(setDirty);
  const lifecycleEpoch = useRef(0);
  const saveController = useRef<AbortController | null>(null);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const selected = catalog?.personas.find(persona => persona.id === selectedId) ?? null;
  const dirty = creating
    ? Object.values(draft).some(value => value.trim() !== '')
    : selected !== null && !samePersona(draft, selected);
  const idConflict = useMemo(() => creating && catalog?.personas.some(persona => persona.id === draft.id.trim()) === true, [catalog, creating, draft.id]);
  const blocked = saveState === 'busy' || saveState === 'conflict' || saveState === 'unknown';
  const editingDisabled = loading || saving || blocked;
  const templateDisabled = dirty || editingDisabled;

  useEffect(() => { setDirtyRef.current = setDirty; }, [setDirty]);
  useEffect(() => {
    if (reportedDirty.current === dirty) return;
    reportedDirty.current = dirty;
    setDirty(dirty, 'personas');
  }, [dirty, setDirty]);
  useEffect(() => () => {
    lifecycleEpoch.current += 1;
    saveController.current?.abort();
    reportedDirty.current = false;
    setDirtyRef.current(false, 'personas');
  }, []);

  useEffect(() => {
    const epoch = ++lifecycleEpoch.current;
    const controller = new AbortController();
    saveController.current?.abort();
    saveController.current = null;
    const isCurrent = () => !controller.signal.aborted && lifecycleEpoch.current === epoch
      && connection.current.api === api && connection.current.connected;
    setSaving(false);
    setLoading(connected);
    setCatalog(null);
    setSelectedId(null);
    setDraft(emptyPersona);
    setCreating(false);
    setLoadError('');
    setWriteError('');
    setFieldError('');
    setSaveState('idle');
    if (!connected) {
      return () => { controller.abort(); lifecycleEpoch.current += 1; };
    }
    void api.get('/api/chat/personas', controller.signal).then(value => {
      if (!isCurrent()) return;
      const next = parseCatalog(value);
      if (!next) throw new Error('invalid_personas_response');
      const preferred = next.personas[0] ?? null;
      setCatalog(next);
      setSelectedId(preferred?.id ?? null);
      setDraft(preferred ?? emptyPersona);
      setCreating(preferred === null);
    }).catch(error => {
      if (isCurrent()) {
        setCatalog(null);
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
    if (editingDisabled || key === 'id' && !creating) return;
    setDraft(current => ({ ...current, [key]: value }));
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function choose(persona: Persona): void {
    if (dirty || editingDisabled) return;
    setSelectedId(persona.id);
    setDraft(persona);
    setCreating(false);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function createPersona(): void {
    if (dirty || editingDisabled) return;
    setSelectedId(null);
    setDraft(emptyPersona);
    setCreating(true);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function useBuiltinPersona(): void {
    if (!catalog || templateDisabled) return;
    setSelectedId(null);
    setDraft(createBuiltinWhalePersonaDraft(catalog.personas));
    setCreating(true);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  async function save(): Promise<void> {
    if (!connected || !catalog || !dirty || editingDisabled || saveController.current) return;
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
    const isCurrent = () => !controller.signal.aborted && lifecycleEpoch.current === epoch
      && saveController.current === controller && connection.current.api === api && connection.current.connected;
    setSaving(true);
    setWriteError('');
    setSaveState('idle');
    try {
      const response = await api.post('/api/chat/personas', { revision: catalog.revision, personas }, controller.signal);
      if (!isCurrent()) return;
      const next = parseCatalog(response);
      if (!next) throw new ApiError('personas_save_unknown', 504);
      const saved = next.personas.find(persona => persona.id === normalized.id);
      if (!saved) throw new ApiError('personas_save_unknown', 504);
      setCatalog(next);
      setSelectedId(saved.id);
      setDraft(saved);
      setCreating(false);
      setSaveState('saved');
    } catch (error) {
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
    if (editingDisabled) return;
    setDraft(creating ? emptyPersona : selected ?? emptyPersona);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  if (!connected) return <div className="page-stack" data-page="persona"><PageHeading title="人设与形象" description="独立管理身份定义与表达风格。" /><ConnectPrompt connect={connect} /></div>;

  return <div className="page-stack" data-page="persona">
    <PageHeading title="人设与形象" description="人设库只定义身份和表达风格。聊天方案可以选择关联人设，能力、访问授权和用户偏好仍分别管理。" actions={<Button variant="outline" onClick={() => setReloadVersion(version => version + 1)} disabled={loading || saving || dirty}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新载入</Button>} />
    {loading && !catalog ? <Section scrollable title="人设库"><div className="flex min-h-52 items-center justify-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取人设库</div></Section>
      : !catalog ? <Section title="人设库不可用" description={loadError || '服务没有返回可识别的人设库。'}><EmptyState locked title="无法读取原生人设库" description="暂时无法读取人设内容，请稍后重试。" /></Section>
        : <div className="grid items-start gap-5 lg:grid-cols-[minmax(14rem,0.32fr)_minmax(0,1fr)]">
          <Section scrollable title="人设库" description="这里保存可被聊天方案引用的人设。" actions={<Button size="sm" onClick={createPersona} disabled={dirty || editingDisabled}><Plus className="size-3.5" />新建人设</Button>}>
            <div className="mb-4 grid gap-2 rounded-lg border border-dashed p-3">
              <Button size="sm" variant="outline" onClick={useBuiltinPersona} disabled={templateDisabled}>使用内置小鲸鱼</Button>
              <p className="text-xs leading-5 text-muted-foreground">通用可编辑模板，并非核心策略。只填入新的未保存草稿，不覆盖现有人设；保存后仍需在聊天方案中选择关联。</p>
            </div>
            <div className="min-w-0">{catalog.personas.length === 0 ? <EmptyState title="还没有人设" description="创建第一份独立人设，之后可在聊天方案中选择关联。" action={<Button size="sm" onClick={createPersona}><Plus className="size-3.5" />新建人设</Button>} /> : <div className="grid gap-1.5">{catalog.personas.map(persona => <Button key={persona.id} variant={!creating && selectedId === persona.id ? 'secondary' : 'ghost'} className="h-auto w-full justify-start px-3 py-2.5 text-left whitespace-normal" disabled={dirty || editingDisabled} onClick={() => choose(persona)}><UserRound className="size-4 shrink-0" /><span className="min-w-0 flex-1"><strong className="block truncate text-xs font-medium">{persona.name}</strong><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{persona.id}</span></span></Button>)}</div>}</div>
          </Section>
          <Section scrollable title={creating ? '新建人设' : draft.name || '人设内容'} description="只描述这个角色是谁、如何表达；不要在这里写工具权限、触发条件或用户偏好。" footer={<SaveBar dirty={dirty} saving={saving} disabled={blocked || loading} message={stateMessage(saveState, dirty)} onSave={() => void save()} onReset={blocked ? undefined : reset} label={creating ? '创建人设' : '保存人设'}><Button variant="outline" onClick={() => navigate('model')}>查看聊天方案</Button></SaveBar>}>
            <div className="grid gap-5">
              <div className="grid gap-5 sm:grid-cols-2"><Field label="内部标识" description={creating ? '用于稳定关联，创建后不可修改。' : '现有内部标识不可修改。'}><Input value={draft.id} disabled={!creating || editingDisabled} maxLength={128} placeholder="persona-default" onChange={event => update('id', event.target.value)} /></Field><Field label="显示名称"><Input value={draft.name} disabled={editingDisabled} maxLength={128} placeholder="日常伙伴" onChange={event => update('name', event.target.value)} /></Field></div>
              <Field label="身份定义" description="说明角色身份、关系边界和稳定事实。"><Textarea value={draft.identity} disabled={editingDisabled} className="h-44 resize-none leading-6" placeholder="描述这个角色是谁" onChange={event => update('identity', event.target.value)} /></Field>
              <Field label="表达风格" description="说明语气、措辞和表达边界，不包含能力授权。"><Textarea value={draft.style} disabled={editingDisabled} className="h-36 resize-none leading-6" placeholder="描述这个角色如何表达" onChange={event => update('style', event.target.value)} /></Field>
              {fieldError && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />{fieldError}</div>}
              {writeError && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><span>{writeError}</span>{(saveState === 'busy' || saveState === 'conflict' || saveState === 'unknown') && <Button size="sm" variant="outline" onClick={() => setReloadVersion(version => version + 1)}>重新载入</Button>}</div>}
            </div>
          </Section>
        </div>}
    <Section id="persona-gateway-identity" title="出站网关身份标识" description="这里配置出站网关使用的身份标识，不是聊天人设正文。"><p className="text-xs leading-5 text-muted-foreground">网关身份配置与人设库独立保存；修改这些字段不会创建、关联或覆盖聊天角色的身份定义与表达风格。</p></Section>
    <ConfigurationEditor category="persona" {...props} />
  </div>;
}
