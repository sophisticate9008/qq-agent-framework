import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { catalogFailureState } from '../lib/native-catalog-operation.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { NativeCatalogRecovery } from '../components/native-catalog-recovery.tsx';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, ShieldCheck, ShieldX } from 'lucide-react';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import { ConnectPrompt, Field, PageHeading, SaveBar, Section, StatusPill } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { ChatAuthorizationManager } from '../components/chat-authorization-manager.tsx';
import { formatAccessLists, parseAccessLists, type AccessListFields } from '../lib/access-lists.ts';

interface AccessState {
  readonly revision: string;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly owner: string | null;
}

interface AccessForm {
  readonly allow: AccessListFields;
  readonly deny: AccessListFields;
  readonly owner: string;
}

type SaveState = 'idle' | 'saved' | 'busy' | 'conflict' | 'unknown';

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !/^(?:group|private):[1-9][0-9]{0,19}$/.test(item))) return null;
  const result = value as string[];
  return new Set(result).size === result.length ? result : null;
}

function parseAccess(value: unknown): AccessState | null {
  const record = asRecord(value);
  const allow = stringList(record.allow);
  const deny = stringList(record.deny);
  if (typeof record.revision !== 'string' || !allow || !deny
    || record.owner !== null && (typeof record.owner !== 'string' || !/^[1-9][0-9]{0,19}$/.test(record.owner))
    || allow.some(entry => deny.includes(entry))) return null;
  return { revision: record.revision, allow, deny, owner: record.owner as string | null };
}

function toForm(access: AccessState): AccessForm {
  return { allow: formatAccessLists(access.allow), deny: formatAccessLists(access.deny), owner: access.owner ?? '' };
}

function sameAccess(access: AccessState, form: AccessForm): boolean {
  const allow = parseAccessLists(form.allow, access.allow).values;
  const deny = parseAccessLists(form.deny, access.deny).values;
  if (!allow || !deny) return false;
  const owner = form.owner.trim() || null;
  return owner === access.owner && allow.length === access.allow.length && deny.length === access.deny.length
    && allow.every((value, index) => value === access.allow[index])
    && deny.every((value, index) => value === access.deny[index]);
}

function saveState(error: unknown): SaveState {
  return catalogFailureState(error);
}

function saveMessage(state: SaveState, dirty: boolean): string {
  if (state === 'saved') return '聊天名单已保存。';
  if (state === 'busy') return '另一项保存正在进行，请稍后重新载入后再提交；不会自动重试。';
  if (state === 'conflict') return '名单已在其他窗口更新，请重新载入。';
  if (state === 'unknown') return '无法确认保存结果，请重新载入核对；不会自动重试。';
  return dirty ? '名单更改尚未保存。' : '当前名单与已保存设置一致。';
}

const accessDraftKey = createDraftKey<{ readonly access: AccessState; readonly form: AccessForm }>('chat-access');

export function AccessPage(props: PageProps & { readonly embedded?: boolean }) {
  const { api, connected, connect, setDirty } = props;
  const recovery = useNativeCatalogOperation(api, 'access');
  const retained = useMemo(() => retainedDraft(api, accessDraftKey), [api]);
  const draftApi = useRef(api);
  const [access, setAccess] = useState<AccessState | null>(retained?.access ?? null);
  const [form, setForm] = useState<AccessForm | null>(retained?.form ?? null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [validationError, setValidationError] = useState('');
  const [result, setResult] = useState<SaveState>('idle');
  const [reloadVersion, setReloadVersion] = useState(0);
  const reportedDirty = useRef(false);
  const setDirtyRef = useRef(setDirty);
  const writeController = useRef<AbortController | null>(null);
  const lifecycle = useRef(0);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const dirty = access !== null && form !== null && !sameAccess(access, form);
  const blocked = recovery.blocked || result === 'busy' || result === 'conflict' || result === 'unknown';

  const view = useRef({ api, access, form, dirty });
  view.current = { api: draftApi.current, access, form, dirty };
  useEffect(() => {
    if (draftApi.current !== api) return;
    retainDraft(api, accessDraftKey, connected && dirty && access && form ? { access, form } : null);
  }, [api, connected, dirty, access, form]);
  useEffect(() => { setDirtyRef.current = setDirty; }, [setDirty]);
  useEffect(() => {
    if (reportedDirty.current === dirty) return;
    reportedDirty.current = dirty;
    setDirty(dirty, 'chat-access');
  }, [dirty, setDirty]);
  useEffect(() => () => {
    lifecycle.current++;
    writeController.current?.abort();
    reportedDirty.current = false;
    setDirtyRef.current(false, 'chat-access');
  }, []);

  useEffect(() => {
    const generation = ++lifecycle.current;
    writeController.current?.abort();
    writeController.current = null;
    const prior = view.current.api === api ? view.current : null;
    draftApi.current = api;
    const preserveDraft = prior?.dirty === true && prior.form !== null;
    if (!prior) { setAccess(null); setForm(null); }
    setSaving(false);
    const current = () => !controller.signal.aborted && generation === lifecycle.current
      && connection.current.api === api && connection.current.connected;
    if (!connected) {
      setAccess(null);
      setForm(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    setWriteError('');
    setResult('idle');
    void readResource(api, '/api/chat/access', controller.signal).then(value => {
      const next = parseAccess(value);
      if (!next) throw new Error('invalid_access_response');
      if (!current()) return;
      recovery.review();
      setAccess(next);
      if (!preserveDraft) setForm(toForm(next));
    }).catch(error => {
      if (current()) {
        if (!prior?.access) { setAccess(null); setForm(null); }
        setLoadError(errorMessage(error));
      }
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => { controller.abort(); lifecycle.current++; writeController.current?.abort(); };
  }, [api, connected, reloadVersion]);

  function update(key: 'owner', value: string): void {
    if (saving || blocked) return;
    setForm(current => current ? { ...current, [key]: value } : current);
    setValidationError('');
    setWriteError('');
    setResult('idle');
  }

  function updateList(list: 'allow' | 'deny', kind: keyof AccessListFields, value: string): void {
    if (saving || blocked) return;
    setForm(current => current ? { ...current, [list]: { ...current[list], [kind]: value } } : current);
    setValidationError('');
    setWriteError('');
    setResult('idle');
  }

  function reset(): void {
    if (saving || blocked) return;
    if (access) setForm(toForm(access));
    setValidationError('');
    setWriteError('');
    setResult('idle');
  }

  async function save(): Promise<void> {
    if (!access || !form || !dirty || saving || blocked || writeController.current) return;
    const allow = parseAccessLists(form.allow, access.allow);
    const deny = parseAccessLists(form.deny, access.deny);
    if (!allow.values || !deny.values) {
      setValidationError(allow.error ?? deny.error ?? '请检查授权项。');
      return;
    }
    if (allow.values.some(entry => deny.values!.includes(entry))) {
      setValidationError('同一主体不能同时出现在允许和拒绝名单中。');
      return;
    }
    const owner = form.owner.trim() || null;
    if (owner !== null && !/^[1-9][0-9]{0,19}$/.test(owner)) {
      setValidationError('所有者必须是 1–20 位十进制用户号，不包含 private: 前缀。');
      return;
    }
    setSaving(true);
    const controller = new AbortController();
    const generation = lifecycle.current;
    const current = () => !controller.signal.aborted && generation === lifecycle.current
      && connection.current.api === api && connection.current.connected;
    writeController.current = controller;
    const operationToken = recovery.begin(access.revision, controller.signal);
    if (!operationToken) { writeController.current = null; setSaving(false); return; }
    setWriteError('');
    setResult('idle');
    try {
      const next = parseAccess(await writeResource(api, '/api/chat/access', {
        revision: access.revision,
        allow: allow.values,
        deny: deny.values,
        owner,
      }, controller.signal));
      if (!next) throw new Error('invalid_access_response');
      if (!current()) return;
      setAccess(next);
      setForm(toForm(next));
      recovery.complete(operationToken);
      setResult('saved');
    } catch (error) {
      recovery.fail(operationToken, error);
      if (!current()) return;
      setResult(saveState(error));
      setWriteError(errorMessage(error));
    } finally {
      if (current()) setSaving(false);
      if (writeController.current === controller) writeController.current = null;
    }
  }

  if (!connected) return <div className="page-stack" data-page="access">{!props.embedded && <PageHeading title="访问范围" description="同一份白名单同时允许接收和回复；群聊和私聊分开填写。" />}<ConnectPrompt connect={connect} /></div>;

  return <div className="page-stack" data-page="access">
    {props.embedded ? <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">访问控制</h2><Button variant="outline" onClick={() => setReloadVersion(version => version + 1)} disabled={loading || saving || dirty && !blocked}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新载入名单</Button></div>
      : <PageHeading title="访问范围" description="同一份白名单同时允许接收和回复；群聊、私聊分开填写，主人账号单独指定。" actions={<Button variant="outline" onClick={() => setReloadVersion(version => version + 1)} disabled={loading || saving || dirty && !blocked}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新载入</Button>} />}
    <NativeCatalogRecovery recovery={recovery} reading={loading || saving} onRead={() => setReloadVersion(value => value + 1)} onReleased={() => { setResult('idle'); setWriteError(''); }} />
    {loading && !access ? <Section title="原生访问授权"><div className="flex min-h-44 items-center justify-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取授权目录</div></Section>
      : !access || !form ? <Section title="原生访问授权不可用" description={loadError || '服务没有返回可识别的授权目录。'}><div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-6">暂时无法读取访问授权，请稍后重试。</div></Section>
        : <>
          {parseAccessLists(form.allow).values?.length === 0 && <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-5"><ShieldX className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" /><p><strong>当前默认全部拒绝。</strong><span className="mt-1 block text-muted-foreground">白名单为空时，不会接收或回复任何群聊、私聊消息。</span></p></div>}
          <Section id={nativeFormMetadata.access.id} title={nativeFormMetadata.access.title} description="群号和私聊账号分开填，多个号码用逗号隔开。群名单允许该群会话接收和回复；私聊名单只控制私聊，不额外过滤群成员。" actions={<StatusPill tone={parseAccessLists(form.allow).values?.length ? 'success' : 'warning'}>{parseAccessLists(form.allow).values?.length ?? 0} 项</StatusPill>} footer={<SaveBar dirty={dirty} saving={saving} disabled={blocked} message={saveMessage(result, dirty)} onSave={() => void save()} onReset={blocked ? undefined : reset} label="保存名单" />}>
            <div className="h-96 min-h-0 overflow-auto overscroll-contain pr-1"><div className="grid gap-5 sm:grid-cols-2">
              <Field label={nativeFormMetadata.access.fields.allowGroups} description="只填群号，例如：123456, 234567"><Textarea value={form.allow.groups} onChange={event => updateList('allow', 'groups', event.target.value)} disabled={saving || blocked} maxLength={32_768} className="h-24 resize-none text-xs leading-6" placeholder="123456, 234567" /></Field>
              <Field label={nativeFormMetadata.access.fields.allowPrivate} description="只填私聊账号，例如：345678, 456789"><Textarea value={form.allow.privateChats} onChange={event => updateList('allow', 'privateChats', event.target.value)} disabled={saving || blocked} maxLength={32_768} className="h-24 resize-none text-xs leading-6" placeholder="345678, 456789" /></Field>
            </div>
            <details className="mt-5 rounded-lg border bg-muted/20 p-3"><summary className="cursor-pointer text-xs text-muted-foreground">拒绝名单（可选）{access.deny.length > 0 ? ` · 已设置 ${access.deny.length} 项` : ''}</summary><div className="mt-4 grid gap-5 sm:grid-cols-2">
              <Field label={nativeFormMetadata.access.fields.denyGroups} description="即使在白名单中，这些群也不接收或回复。"><Textarea value={form.deny.groups} onChange={event => updateList('deny', 'groups', event.target.value)} disabled={saving || blocked} maxLength={32_768} className="h-24 resize-none text-xs leading-6" placeholder="123456, 234567" /></Field>
              <Field label={nativeFormMetadata.access.fields.denyPrivate} description="即使在白名单中，这些私聊也不接收或回复。"><Textarea value={form.deny.privateChats} onChange={event => updateList('deny', 'privateChats', event.target.value)} disabled={saving || blocked} maxLength={32_768} className="h-24 resize-none text-xs leading-6" placeholder="345678, 456789" /></Field>
            </div></details>
            <div className="mt-5 grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"><Field label={nativeFormMetadata.access.fields.owner} description="只认这个账号为主人，留空表示没有主人。普通聊天和已接入工具不要求主人身份；独立工作委派的身份核验使用此账号。"><Input value={form.owner} onChange={event => update('owner', event.target.value)} disabled={saving || blocked} inputMode="numeric" maxLength={20} placeholder="654321" /></Field><div className="flex h-9 items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-4" />不按昵称或群身份认主</div></div>
            {validationError && <p className="mt-4 text-xs text-destructive" role="alert">{validationError}</p>}
            {writeError && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><span>{writeError}</span>{(result === 'busy' || result === 'conflict' || result === 'unknown') && <Button size="sm" variant="outline" onClick={() => setReloadVersion(version => version + 1)}>重新载入</Button>}</div>}
            </div>
          </Section>
        </>}
    <ChatAuthorizationManager api={api} connected={connected} setDirty={setDirty} />
  </div>;
}
