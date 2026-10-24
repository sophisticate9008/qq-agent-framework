import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, Plus, RefreshCw, UserRound } from 'lucide-react';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import { ConnectPrompt, EmptyState, Field, PageHeading, SaveBar, Section } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
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
  return 'idle';
}

function stateMessage(state: SaveState, dirty: boolean): string {
  if (state === 'saved') return '人设库已保存。';
  if (state === 'busy') return '另一项保存正在进行，请稍后重新载入后再提交；不会自动重试。';
  if (state === 'conflict') return '人设库已在其他窗口更新，请重新载入。';
  if (state === 'unknown') return '无法确认保存结果，请重新载入核对；不会自动重试。';
  return dirty ? '人设更改尚未保存。' : '当前内容与已保存人设库一致。';
}

export function PersonaPage({ api, connected, connect, setDirty, navigate }: PageProps) {
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
  const selected = catalog?.personas.find(persona => persona.id === selectedId) ?? null;
  const dirty = creating
    ? Object.values(draft).some(value => value.trim() !== '')
    : selected !== null && !samePersona(draft, selected);
  const idConflict = useMemo(() => creating && catalog?.personas.some(persona => persona.id === draft.id.trim()) === true, [catalog, creating, draft.id]);
  const templateDisabled = dirty || loading || saving || saveState === 'busy' || saveState === 'conflict' || saveState === 'unknown';

  useEffect(() => { setDirtyRef.current = setDirty; }, [setDirty]);
  useEffect(() => {
    if (reportedDirty.current === dirty) return;
    reportedDirty.current = dirty;
    setDirty(dirty, 'personas');
  }, [dirty, setDirty]);
  useEffect(() => () => {
    reportedDirty.current = false;
    setDirtyRef.current(false, 'personas');
  }, []);

  useEffect(() => {
    if (!connected) {
      setCatalog(null);
      setSelectedId(null);
      setDraft(emptyPersona);
      setCreating(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    setWriteError('');
    setSaveState('idle');
    void api.get('/api/chat/personas', controller.signal).then(value => {
      const next = parseCatalog(value);
      if (!next) throw new Error('invalid_personas_response');
      const preferred = next.personas[0] ?? null;
      setCatalog(next);
      setSelectedId(preferred?.id ?? null);
      setDraft(preferred ?? emptyPersona);
      setCreating(preferred === null);
    }).catch(error => {
      if (!controller.signal.aborted) {
        setCatalog(null);
        setLoadError(errorMessage(error));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [api, connected, reloadVersion]);

  function update<Key extends keyof Persona>(key: Key, value: Persona[Key]): void {
    setDraft(current => ({ ...current, [key]: value }));
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function choose(persona: Persona): void {
    if (dirty || saving) return;
    setSelectedId(persona.id);
    setDraft(persona);
    setCreating(false);
    setFieldError('');
    setWriteError('');
    setSaveState('idle');
  }

  function createPersona(): void {
    if (dirty || saving) return;
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
    if (!catalog || !dirty || saving) return;
    const normalized = { ...draft, id: draft.id.trim(), name: draft.name.trim() };
    if (!normalized.id || !normalized.name || !normalized.identity.trim() || !normalized.style.trim()) {
      setFieldError('内部标识、名称、身份和表达风格必须填写。');
      return;
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(normalized.id)) {
      setFieldError('内部标识只能使用字母、数字、点、下划线和短横线，且不能超过 128 个字符。');
      return;
    }
    if (idConflict) {
      setFieldError('内部标识已存在。');
      return;
    }
    const personas = creating ? [...catalog.personas, normalized] : catalog.personas.map(persona => persona.id === selectedId ? normalized : persona);
    setSaving(true);
    setWriteError('');
    setSaveState('idle');
    try {
      const next = parseCatalog(await api.post('/api/chat/personas', { revision: catalog.revision, personas }));
      if (!next) throw new Error('invalid_personas_response');
      const saved = next.personas.find(persona => persona.id === normalized.id);
      if (!saved) throw new Error('invalid_personas_response');
      setCatalog(next);
      setSelectedId(saved.id);
      setDraft(saved);
      setCreating(false);
      setSaveState('saved');
    } catch (error) {
      setSaveState(stateForError(error));
      setWriteError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  function reset(): void {
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
          <Section scrollable title="人设库" description="这里保存可被聊天方案引用的人设。" actions={<Button size="sm" onClick={createPersona} disabled={dirty || saving}><Plus className="size-3.5" />新建人设</Button>}>
            <div className="mb-4 grid gap-2 rounded-lg border border-dashed p-3">
              <Button size="sm" variant="outline" onClick={useBuiltinPersona} disabled={templateDisabled}>使用内置小鲸鱼</Button>
              <p className="text-xs leading-5 text-muted-foreground">通用可编辑模板，并非核心策略。只填入新的未保存草稿，不覆盖现有人设；保存后仍需在聊天方案中选择关联。</p>
            </div>
            <div className="min-w-0">{catalog.personas.length === 0 ? <EmptyState title="还没有人设" description="创建第一份独立人设，之后可在聊天方案中选择关联。" action={<Button size="sm" onClick={createPersona}><Plus className="size-3.5" />新建人设</Button>} /> : <div className="grid gap-1.5">{catalog.personas.map(persona => <Button key={persona.id} variant={!creating && selectedId === persona.id ? 'secondary' : 'ghost'} className="h-auto w-full justify-start px-3 py-2.5 text-left whitespace-normal" disabled={dirty || saving} onClick={() => choose(persona)}><UserRound className="size-4 shrink-0" /><span className="min-w-0 flex-1"><strong className="block truncate text-xs font-medium">{persona.name}</strong><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{persona.id}</span></span></Button>)}</div>}</div>
          </Section>
          <Section scrollable title={creating ? '新建人设' : draft.name || '人设内容'} description="只描述这个角色是谁、如何表达；不要在这里写工具权限、触发条件或用户偏好。" footer={<SaveBar dirty={dirty} saving={saving} message={stateMessage(saveState, dirty)} onSave={() => void save()} onReset={reset} label={creating ? '创建人设' : '保存人设'}><Button variant="outline" onClick={() => navigate('model')}>查看聊天方案</Button></SaveBar>}>
            <div className="grid gap-5">
              <div className="grid gap-5 sm:grid-cols-2"><Field label="内部标识" description={creating ? '用于稳定关联，创建后不可修改。' : '现有内部标识不可修改。'}><Input value={draft.id} disabled={!creating || saving} maxLength={128} placeholder="persona-default" onChange={event => update('id', event.target.value)} /></Field><Field label="显示名称"><Input value={draft.name} disabled={saving} maxLength={128} placeholder="日常伙伴" onChange={event => update('name', event.target.value)} /></Field></div>
              <Field label="身份定义" description="说明角色身份、关系边界和稳定事实。"><Textarea value={draft.identity} disabled={saving} className="h-44 resize-none leading-6" placeholder="描述这个角色是谁" onChange={event => update('identity', event.target.value)} /></Field>
              <Field label="表达风格" description="说明语气、措辞和表达边界，不包含能力授权。"><Textarea value={draft.style} disabled={saving} className="h-36 resize-none leading-6" placeholder="描述这个角色如何表达" onChange={event => update('style', event.target.value)} /></Field>
              {fieldError && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />{fieldError}</div>}
              {writeError && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><span>{writeError}</span>{(saveState === 'busy' || saveState === 'conflict' || saveState === 'unknown') && <Button size="sm" variant="outline" onClick={() => setReloadVersion(version => version + 1)}>重新载入</Button>}</div>}
            </div>
          </Section>
        </div>}
  </div>;
}
