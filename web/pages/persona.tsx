import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, LoaderCircle, Plus, RefreshCw, UserRound } from 'lucide-react';
import { ConfigurationEditor } from '../components/configuration-editor.tsx';
import { ConnectPrompt, EmptyState, Field, PageHeading, SaveBar, Section } from '../components/management.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx';
import { Input } from '../components/ui/input.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';

interface RoleDetail {
  readonly name: string;
  readonly content: string;
  readonly revision: string;
}

type EditorTarget = { readonly kind: 'role'; readonly name: string } | { readonly kind: 'new' };
type ResultState = 'idle' | 'saved' | 'activated' | 'conflict' | 'unknown';

function readRoles(value: unknown): { roles: string[]; current: string | null } | null {
  const record = asRecord(value);
  if (!Array.isArray(record.roles) || !record.roles.every(role => typeof role === 'string')) return null;
  if (record.current !== null && typeof record.current !== 'string') return null;
  return { roles: [...record.roles], current: record.current as string | null };
}

function readRole(value: unknown): RoleDetail | null {
  const record = asRecord(value);
  if (typeof record.name !== 'string' || typeof record.content !== 'string' || typeof record.revision !== 'string') return null;
  return { name: record.name, content: record.content, revision: record.revision };
}

function resultMessage(result: ResultState, dirty: boolean): string | undefined {
  if (result === 'saved') return '人设已保存';
  if (result === 'activated') return '当前人设状态已更新';
  if (result === 'conflict') return '人设已在其他窗口更新，请重新载入后再编辑。';
  if (result === 'unknown') return '暂时无法确认操作结果，请重新载入后查看。';
  return dirty ? undefined : '内容与已保存版本一致';
}

export function PersonaPage(props: PageProps) {
  const { api, connected, connect, setDirty } = props;
  const [roles, setRoles] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<RoleDetail | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [listLoading, setListLoading] = useState(false);
  const [roleLoading, setRoleLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [result, setResult] = useState<ResultState>('idle');
  const [pendingTarget, setPendingTarget] = useState<EditorTarget | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [configurationDirty, setConfigurationDirty] = useState(false);
  const reportedDirty = useRef(false);
  const setDirtyRef = useRef(setDirty);
  const skipRoleLoad = useRef<string | null>(null);

  const dirty = useMemo(() => creating
    ? draftName.trim().length > 0 || draftContent.length > 0
    : detail !== null && draftContent !== detail.content,
  [creating, detail, draftContent, draftName]);
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
    if (!connected) {
      setRoles([]);
      setCurrent(null);
      setSelectedName(null);
      setCreating(false);
      setDetail(null);
      setDraftName('');
      setDraftContent('');
      setLoadError('');
      setWriteError('');
      setResult('idle');
      return;
    }
    const controller = new AbortController();
    setListLoading(true);
    setLoadError('');
    void api.get('/api/legacy/roles', controller.signal).then(value => {
      const next = readRoles(value);
      if (!next) throw new Error('invalid_roles_response');
      setRoles(next.roles);
      setCurrent(next.current);
      const preferred = next.current && next.roles.includes(next.current) ? next.current : next.roles[0] ?? null;
      setSelectedName(preferred);
      setCreating(preferred === null);
      if (preferred === null) {
        setDetail(null);
        setDraftName('');
        setDraftContent('');
      }
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setListLoading(false);
    });
    return () => controller.abort();
  }, [api, connected, reloadKey]);

  useEffect(() => {
    if (!connected || creating || selectedName === null) return;
    if (skipRoleLoad.current === selectedName) {
      skipRoleLoad.current = null;
      return;
    }
    const controller = new AbortController();
    setRoleLoading(true);
    setDetail(null);
    setDraftName(selectedName);
    setDraftContent('');
    setLoadError('');
    setWriteError('');
    setResult('idle');
    void api.get(`/api/legacy/role?name=${encodeURIComponent(selectedName)}`, controller.signal).then(value => {
      const next = readRole(value);
      if (!next || next.name !== selectedName) throw new Error('invalid_role_response');
      setDetail(next);
      setDraftName(next.name);
      setDraftContent(next.content);
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setRoleLoading(false);
    });
    return () => controller.abort();
  }, [api, connected, creating, reloadKey, selectedName]);

  function applyTarget(target: EditorTarget): void {
    setPendingTarget(null);
    setFieldError('');
    setWriteError('');
    setResult('idle');
    if (target.kind === 'new') {
      setCreating(true);
      setSelectedName(null);
      setDetail(null);
      setDraftName('');
      setDraftContent('');
      return;
    }
    setCreating(false);
    setSelectedName(target.name);
    setDetail(null);
    setDraftName(target.name);
    setDraftContent('');
  }

  function requestTarget(target: EditorTarget): void {
    if (target.kind === 'role' && !creating && target.name === selectedName) return;
    if (target.kind === 'new' && creating) return;
    if (dirty) setPendingTarget(target);
    else applyTarget(target);
  }

  function reload(): void {
    setWriteError('');
    setResult('idle');
    setReloadKey(key => key + 1);
  }

  async function save(): Promise<void> {
    const name = creating ? draftName.trim() : detail?.name ?? '';
    if (!name) {
      setFieldError('请填写人设名称。');
      return;
    }
    if (!draftContent.trim()) {
      setFieldError('请填写人设正文。');
      return;
    }
    if (!creating && detail === null) return;
    setSaving(true);
    setFieldError('');
    setWriteError('');
    setResult('idle');
    try {
      const body = creating
        ? { name, content: draftContent, create: true }
        : { name, content: draftContent, revision: detail!.revision };
      const response = readRole(await api.post('/api/legacy/role', body));
      if (!response || response.name !== name || response.content !== draftContent) throw new Error('invalid_role_response');
      if (creating) skipRoleLoad.current = response.name;
      setDetail(response);
      setDraftName(response.name);
      setDraftContent(response.content);
      setSelectedName(response.name);
      setCreating(false);
      setRoles(existing => existing.includes(response.name) ? existing : [...existing, response.name]);
      setResult('saved');
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      setResult(/conflict|stale|revision/.test(code) ? 'conflict' : /unknown/.test(code) ? 'unknown' : 'idle');
      setWriteError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function activate(): Promise<void> {
    if (selectedName === null || creating || dirty) return;
    setActivating(true);
    setWriteError('');
    setResult('idle');
    const nextName = current === selectedName ? null : selectedName;
    try {
      const response = asRecord(await api.post('/api/legacy/role/activate', { name: nextName }));
      if (response.current !== null && typeof response.current !== 'string') throw new Error('invalid_activate_response');
      if (response.current !== nextName) throw new Error('invalid_activate_response');
      setCurrent(nextName);
      setResult('activated');
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      setResult(/unknown/.test(code) ? 'unknown' : 'idle');
      setWriteError(errorMessage(error));
    } finally {
      setActivating(false);
    }
  }

  if (!connected) return <div className="page-stack" data-page="persona"><PageHeading title="人设与形象" description="管理伙伴的身份、表达方式和当前启用的人设。" /><ConnectPrompt connect={connect} /></div>;

  const busy = listLoading || roleLoading || saving || activating;
  const activationLabel = current === selectedName ? '停用当前人设' : '启用这个人设';

  return <div className="page-stack" data-page="persona">
    <PageHeading title="人设与形象" description="选择现有人设继续调整，或创建一个新的身份与表达方式。" actions={<Button variant="outline" onClick={reload} disabled={busy || dirty}><RefreshCw className={listLoading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新载入</Button>} />
    {loadError && !roles.length ? <Section title="无法读取人设" description={loadError} actions={<Button variant="outline" onClick={reload}>重试</Button>}><EmptyState title="人设列表暂时不可用" description="请检查连接后重试，现有配置不会受到影响。" /></Section> : <div className="grid items-start gap-5 lg:grid-cols-[minmax(13rem,0.36fr)_minmax(0,1fr)]">
      <Section title="人设列表" description="当前可用的全部人设。" actions={<Button size="sm" onClick={() => requestTarget({ kind: 'new' })} disabled={busy}><Plus className="size-3.5" />新建</Button>}>
        {listLoading ? <div className="flex min-h-44 items-center justify-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取人设</div> : roles.length === 0 ? <EmptyState title="还没有人设" description="新建第一份人设，为伙伴设定身份和表达方式。" action={<Button size="sm" onClick={() => requestTarget({ kind: 'new' })}><Plus className="size-3.5" />新建人设</Button>} /> : <div className="grid gap-1.5">{roles.map(role => <Button key={role} variant={!creating && selectedName === role ? 'secondary' : 'ghost'} className="h-auto w-full justify-start px-3 py-2.5 text-left whitespace-normal" onClick={() => requestTarget({ kind: 'role', name: role })} disabled={busy}><UserRound className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{role}</span>{current === role && <Badge variant="outline"><Check className="size-3" />当前</Badge>}</Button>)}</div>}
      </Section>
      <div className="grid min-w-0 gap-5">
        <Section title={creating ? '新建人设' : selectedName ?? '人设内容'} description={creating ? '名称用于在人设列表中辨认，正文决定身份和表达方式。' : current === selectedName ? '这是当前启用的人设，保存后不会重置已有会话。' : '保存内容后，可将它设为当前人设。'} footer={<SaveBar dirty={dirty} saving={saving} message={resultMessage(result, dirty)} onSave={() => void save()} onReset={() => detail ? setDraftContent(detail.content) : (setDraftName(''), setDraftContent(''))} label={creating ? '创建人设' : '保存人设'}><Button variant="outline" disabled={creating || selectedName === null || dirty || busy} onClick={() => void activate()}>{activating && <LoaderCircle className="size-4 animate-spin" />}{activating ? '正在更新' : activationLabel}</Button></SaveBar>}>
          {roleLoading ? <div className="flex min-h-72 items-center justify-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取人设内容</div> : loadError && !detail && !creating ? <EmptyState title="无法读取人设内容" description={loadError} action={<Button variant="outline" onClick={reload}>重试</Button>} /> : <div className="grid gap-5">
            <Field label="人设名称" description={creating ? '使用容易辨认的名称，创建后不可在此页面改名。' : '现有人设名称不可修改。'} error={fieldError && !draftName.trim() ? fieldError : undefined}><Input value={draftName} onChange={event => { setDraftName(event.target.value); setFieldError(''); setResult('idle'); }} disabled={!creating || saving} placeholder="例如：日常伙伴" maxLength={128} /></Field>
            <Field label="人设正文" description="写下身份、性格、语气和需要遵守的表达边界。" error={fieldError && draftName.trim() && !draftContent.trim() ? fieldError : undefined}><Textarea value={draftContent} onChange={event => { setDraftContent(event.target.value); setFieldError(''); setResult('idle'); }} disabled={roleLoading || saving} placeholder="描述伙伴的身份、性格和表达方式" className="min-h-80 resize-y leading-6" /></Field>
            {writeError && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><span>{writeError}</span>{(result === 'conflict' || result === 'unknown') && <Button size="sm" variant="outline" onClick={reload}>重新载入</Button>}</div>}
          </div>}
        </Section>
        <ConfigurationEditor category="persona" {...props} setDirty={setConfigurationDirty} />
      </div>
    </div>}
    <Dialog open={pendingTarget !== null} onOpenChange={open => { if (!open) setPendingTarget(null); }}><DialogContent><DialogHeader><DialogTitle>切换前还有未保存内容</DialogTitle><DialogDescription>切换后，本次编辑会被舍弃。你也可以留在这里先保存。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setPendingTarget(null)}>继续编辑</Button><Button variant="destructive" onClick={() => { if (pendingTarget) applyTarget(pendingTarget); }}>舍弃并切换</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
