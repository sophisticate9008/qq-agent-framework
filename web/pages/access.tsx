import { SettingsWindow } from '../components/settings-window.tsx';
import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { catalogFailureState } from '../lib/native-catalog-operation.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { NativeCatalogRecovery } from '../components/native-catalog-recovery.tsx';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { asRecord, errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import { ConnectPrompt, Field, PageHeading, SaveBar, Section, StatusPill } from '../components/management.tsx';
import { ReadOnlyDetails } from '../components/read-only-details.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { formatAccessLists, parseAccessLists, type AccessListFields } from '../lib/access-lists.ts';

interface AccessState {
  readonly revision: string;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly owner: string | null;
  readonly application: 'live' | 'saved' | 'reload-required' | 'sync-failed' | null;
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
    || record.application !== undefined && (typeof record.application !== 'string' || !['live', 'saved', 'reload-required', 'sync-failed'].includes(record.application))
    || allow.some(entry => deny.includes(entry))) return null;
  return { revision: record.revision, allow, deny, owner: record.owner as string | null,
    application: record.application === undefined ? null : record.application as AccessState['application'] };
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

function saveMessage(state: SaveState, dirty: boolean, application: AccessState['application']): string {
  if (state === 'saved' || state === 'idle' && !dirty && application !== null) {
    if (application === 'live') return '聊天名单已保存并立即生效。';
    if (application === 'saved') return '聊天名单已保存；聊天启动时将使用这份名单。';
    if (application === 'reload-required') return '聊天名单已保存，仍有设置等待应用；请核对聊天运行状态。';
    if (application === 'sync-failed') return '名单已保存，但运行同步失败，请重新保存同步。';
    return '聊天名单已保存；运行中的生效状态尚未确认。';
  }
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
  const canResynchronize = access?.application === 'sync-failed' && !dirty;
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
    if (!access || !form || !dirty && !canResynchronize || saving || blocked || writeController.current) return;
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

  const reloadButton = <Button variant="ghost" size="sm" onClick={() => setReloadVersion(version => version + 1)} disabled={loading || saving || dirty && !blocked}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新读取</Button>;
  const recoveryPanel = <NativeCatalogRecovery recovery={recovery} reading={loading || saving} onRead={() => setReloadVersion(value => value + 1)} onReleased={() => { setResult('idle'); setWriteError(''); }} />;
  const saveFeedback = saveMessage(result, dirty, access?.application ?? null);
  const applicationWarning = !dirty && (result === 'saved' || result === 'idle')
    && (access?.application === 'reload-required' || access?.application === 'sync-failed')
    ? <p className="strip warn" role="status">{saveFeedback}</p> : null;
  const saveControls = <div className="actions border-t pt-2"><SaveBar dirty={dirty || canResynchronize} saving={saving} disabled={blocked || loading} message={saveFeedback} onSave={() => void save()} onReset={blocked || !dirty ? undefined : reset} label={canResynchronize ? '重新保存同步' : '保存名单'} /></div>;
  const feedback = <>{recoveryPanel}{applicationWarning}{validationError && <p className="text-xs text-destructive" role="alert">{validationError}</p>}{writeError && <p className="text-xs text-destructive" role="alert">{writeError}</p>}{saveControls}</>;
  const disabled = saving || blocked || loading;
  const groups = access?.allow.filter(value => value.startsWith('group:')).map(value => value.slice(6)) ?? [];
  const privateChats = access?.allow.filter(value => value.startsWith('private:')).map(value => value.slice(8)) ?? [];
  const ownerField = form && <Field id="access-owner" label={nativeFormMetadata.access.fields.owner} tip="真实 QQ 用户号；留空表示没有主人。昵称、群身份和网页登录身份均不会授予主人权限。"><Input id="access-owner" value={form.owner} onChange={event => update('owner', event.target.value)} disabled={disabled} inputMode="numeric" maxLength={20} placeholder="填写主人 QQ 号" /></Field>;
  return <div className="page-stack" data-page="access">
    {!props.embedded && <PageHeading title="访问范围" description="主人与会话白名单；群聊与私聊分开维护。" actions={reloadButton} />}
    <Section id={nativeFormMetadata.access.id} title="主人与白名单" actions={access ? <StatusPill tone={access.allow.length ? 'success' : 'warning'}>{access.allow.length} 项会话</StatusPill> : reloadButton}
      footer={form && access && <>
        <SettingsWindow title="主人与白名单" triggerVariant="default" label={dirty ? '继续编辑名单 · 未保存' : '编辑名单'} description="群聊与私聊分开填写，多个号码用逗号隔开。关闭窗口保留未保存草稿。"><div className="stack">{ownerField}<div className="formgrid">
          <Field layout="stacked" label={nativeFormMetadata.access.fields.allowGroups} tip="群白名单允许该群会话接收与回复，不额外过滤群成员。"><Textarea value={form.allow.groups} onChange={event => updateList('allow', 'groups', event.target.value)} disabled={disabled} maxLength={32_768} rows={5} className="resize-y text-xs" placeholder="填写群号，多个号码用逗号隔开" /></Field>
          <Field layout="stacked" label={nativeFormMetadata.access.fields.allowPrivate} tip="私聊白名单只控制对应用户的私聊。"><Textarea value={form.allow.privateChats} onChange={event => updateList('allow', 'privateChats', event.target.value)} disabled={disabled} maxLength={32_768} rows={5} className="resize-y text-xs" placeholder="填写私聊账号，多个号码用逗号隔开" /></Field>
        </div><div className="strip">同一份白名单允许接收和回复；敏感操作核验实际主人。</div>{feedback}</div></SettingsWindow>
        <SettingsWindow title="拒绝名单" description="拒绝项与白名单不能重叠；保存名单会同时保存当前主人与访问草稿。关闭窗口保留草稿。"><div className="stack"><div className="formgrid">
          <Field layout="stacked" label={nativeFormMetadata.access.fields.denyGroups}><Textarea value={form.deny.groups} onChange={event => updateList('deny', 'groups', event.target.value)} disabled={disabled} maxLength={32_768} rows={5} className="resize-y text-xs" placeholder="填写拒绝的群号" /></Field>
          <Field layout="stacked" label={nativeFormMetadata.access.fields.denyPrivate}><Textarea value={form.deny.privateChats} onChange={event => updateList('deny', 'privateChats', event.target.value)} disabled={disabled} maxLength={32_768} rows={5} className="resize-y text-xs" placeholder="填写拒绝的私聊账号" /></Field>
        </div>{feedback}</div></SettingsWindow>
        <ReadOnlyDetails title="访问规则说明" label="规则说明"><div className="stack"><p>主人由真实 QQ 用户号确定，管理页面登录身份不会授予 QQ 主人权限。</p><p>同一份白名单允许接收与回复；群会话与私聊分别授权，白名单内工具直接开放，敏感操作核验实际主人。</p><p>群聊 @ 与白名单内私聊固定唤醒，额外昵称和引用唤醒在人设中配置。</p><p>拒绝项与白名单不能重叠；主人账号本身不会隐式扩大会话准入范围。</p></div></ReadOnlyDetails>
      </>}>
      {loading && !access ? <div className="empty" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取访问名单</div> : !access || !form ? <div className="stack"><p className="small text-destructive" role="alert">{loadError || '暂时无法读取访问授权。'}</p>{reloadButton}</div> : <div className="stack">
        <div className="row"><span className="muted">已保存主人账号</span><strong>{access.owner ?? '尚未指定'}</strong>{dirty && <StatusPill tone="warning">草稿未保存</StatusPill>}</div>
        <div className="row"><strong>群聊</strong><span className="muted small">{groups.length} 项</span>{groups.slice(0, 5).map(value => <span className="chip" key={value}>群号 {value}</span>)}{groups.length > 5 && <span className="muted small">另 {groups.length - 5} 项</span>}</div>
        <div className="row"><strong>私聊</strong><span className="muted small">{privateChats.length} 项</span>{privateChats.slice(0, 5).map(value => <span className="chip" key={value}>用户号 {value}</span>)}{privateChats.length > 5 && <span className="muted small">另 {privateChats.length - 5} 项</span>}</div>
        <div className={`strip ${access.allow.length ? '' : 'warn'}`}>{access.allow.length ? '同一份白名单允许接收和回复；敏感操作核验实际主人。' : '已保存的白名单为空。'}</div>
        {recoveryPanel}{applicationWarning}{loadError && <p role="alert" className="text-xs text-destructive">读取失败，保留当前快照与草稿：{loadError}</p>}{writeError && <p role="alert" className="text-xs text-destructive">{writeError}</p>}
        <div className="row small muted"><span className="grow" role="status">{saveFeedback}</span>{reloadButton}</div>
      </div>}
    </Section>
  </div>;
}
