import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, RefreshCw } from 'lucide-react';
import { errorMessage } from '../lib/api.ts';
import { defaultTimeoutNotice, executionForm, executionPolicy, parseExecutionConfiguration, type ExecutionConfiguration, type ExecutionForm } from '../lib/execution-policy.ts';
import type { PageProps } from '../lib/types.ts';
import { Field, SaveBar, Section } from './management.tsx';
import { SettingsWindow } from './settings-window.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Textarea } from './ui/textarea.tsx';

const executionDraftKey = createDraftKey<{ readonly saved: ExecutionConfiguration; readonly form: ExecutionForm }>('chat-execution');

export function ChatExecutionSettings({ api, connected, setDirty }: PageProps) {
  const recovery = useNativeCatalogOperation(api, 'execution');
  const retained = useMemo(() => retainedDraft(api, executionDraftKey), [api]);
  const draftApi = useRef(api);
  const [saved, setSaved] = useState<ExecutionConfiguration | null>(retained?.saved ?? null);
  const [form, setForm] = useState<ExecutionForm | null>(retained?.form ?? null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localBlocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const writeController = useRef<AbortController | null>(null);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const dirtyCallback = useRef(setDirty);
  dirtyCallback.current = setDirty;
  const dirty = saved !== null && form !== null && JSON.stringify(executionForm(saved.policy)) !== JSON.stringify(form);
  const blocked = localBlocked || recovery.blocked;
  const disabled = saving || loading || blocked;
  const view = useRef({ api, saved, form, dirty });
  view.current = { api: draftApi.current, saved, form, dirty };
  useEffect(() => {
    if (draftApi.current !== api) return;
    retainDraft(api, executionDraftKey, connected && dirty && saved && form ? { saved, form } : null);
  }, [api, connected, dirty, saved, form]);

  useEffect(() => { setDirty(dirty, 'chat-execution'); }, [dirty, setDirty]);
  useEffect(() => () => { epoch.current++; writeController.current?.abort(); dirtyCallback.current(false, 'chat-execution'); }, []);
  useEffect(() => {
    const generation = ++epoch.current;
    const controller = new AbortController();
    writeController.current?.abort(); writeController.current = null;
    const current = () => !controller.signal.aborted && generation === epoch.current
      && connection.current.api === api && connection.current.connected;
    const prior = view.current.api === api ? view.current : null;
    draftApi.current = api;
    const preserveDraft = prior?.dirty === true && prior.form !== null;
    if (!prior || !connected) { setSaved(null); setForm(null); }
    setLoading(connected); setSaving(false); setBlocked(false);
    setError(''); setNotice('');
    if (connected) void readResource(api, '/api/chat/execution', controller.signal).then(value => {
      if (!current()) return;
      const parsed = parseExecutionConfiguration(value);
      if (!parsed) throw new Error('invalid_execution_configuration');
      recovery.review();
      setSaved(parsed); if (!preserveDraft) setForm(executionForm(parsed.policy));
    }).catch(failure => { if (current()) setError(errorMessage(failure)); })
      .finally(() => { if (current()) setLoading(false); });
    return () => { controller.abort(); epoch.current++; writeController.current?.abort(); };
  }, [api, connected, reload]);

  function update(patch: Partial<ExecutionForm>): void {
    if (disabled) return;
    setForm(current => current ? { ...current, ...patch } : current);
    setError(''); setNotice('');
  }

  function readAgain(): void {
    if (saving || loading) return;
    setReload(value => value + 1);
  }

  async function save(): Promise<void> {
    if (!saved || !form || !dirty || disabled || writeController.current) return;
    const policy = executionPolicy(form);
    if (!policy) { setError('请检查总期限（0.01–300 秒）、停止与提醒期限（0.01–30 秒）、并行数（1–256）和提醒正文（最多 8000 字符）。'); return; }
    const controller = new AbortController();
    const generation = epoch.current;
    writeController.current = controller;
    const operationToken = recovery.begin(saved.revision, controller.signal);
    if (!operationToken) { writeController.current = null; return; }
    const current = () => !controller.signal.aborted && generation === epoch.current
      && writeController.current === controller && connection.current.api === api && connection.current.connected;
    setSaving(true); setError(''); setNotice('');
    try {
      const parsed = parseExecutionConfiguration(await writeResource(api, '/api/chat/execution', { revision: saved.revision, policy }, controller.signal));
      if (!current()) return;
      if (!parsed) throw new Error('invalid_execution_configuration');
      setSaved(parsed); setForm(executionForm(parsed.policy));
      recovery.complete(operationToken);
      setNotice('处理策略已保存，重启聊天后生效。');
    } catch (failure) {
      const failureState = recovery.fail(operationToken, failure);
      if (current()) { setError(`${errorMessage(failure)} 请重新读取核对，不会自动重复提交。`); setBlocked(failureState !== 'idle'); }
    } finally {
      if (current()) setSaving(false);
      if (writeController.current === controller) writeController.current = null;
    }
  }

  if (!connected) return null;
  const saveControls = <SaveBar dirty={dirty} saving={saving} disabled={loading || blocked} onSave={() => void save()} onReset={saved && !blocked ? () => { setForm(executionForm(saved.policy)); setError(''); } : undefined} label="保存处理策略" message={notice || (blocked ? '保存结果需核对，不能重复提交。' : dirty ? '尚未保存，保存后重启聊天生效。' : '保存后重启聊天生效。')} />;
  const advanced = <SettingsWindow title="高级处理设置" label="高级处理设置" description="设置停止与提醒的等待时间。关闭窗口保留草稿。"><div className="stack">
    <div className="strip">旧请求结果不明时自动核对，不重复提交；新消息按原期限排队，过期后结束，不永久锁住会话。</div>
    {form && <div className="formgrid">
      <Field id="execution-cancel-seconds" label={nativeFormMetadata.execution.fields.cancelSeconds} tip="范围 0.01–30 秒；等待结束后仍未确认停止的任务，继续按结果未知处理。"><Input id="execution-cancel-seconds" type="number" min={0.01} max={30} step={0.01} value={form.cancelSeconds} disabled={disabled || !form.cancelOnTimeout} onChange={event => update({ cancelSeconds: event.target.value })} /></Field>
      <Field id="execution-notice-seconds" label={nativeFormMetadata.execution.fields.noticeSeconds} tip="范围 0.01–30 秒；无法确认提醒是否发送时，不会自动重发。"><Input id="execution-notice-seconds" type="number" min={0.01} max={30} step={0.01} value={form.noticeSeconds} disabled={disabled || !form.noticeEnabled} onChange={event => update({ noticeSeconds: event.target.value })} /></Field>
    </div>}
    <NativeCatalogRecovery recovery={recovery} reading={loading || saving} onRead={readAgain} onReleased={() => { setBlocked(false); setError(''); }} />
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}<div className="actions border-t pt-2">{saveControls}</div>
  </div></SettingsWindow>;
  return <Section id={nativeFormMetadata.execution.id} title="回复与超时"
    actions={<Button variant="ghost" size="sm" disabled={saving || loading} onClick={readAgain}><RefreshCw className="size-3.5" />重新读取</Button>}
    footer={<>{advanced}{saveControls}</>}>
    <NativeCatalogRecovery recovery={recovery} reading={loading || saving} onRead={readAgain} onReleased={() => { setBlocked(false); setError(''); }} />
    {error && <p role="alert" className="mb-2 text-xs leading-5 text-destructive">{error}</p>}
    {!form ? <p role="status" className="row small muted"><Clock3 className="size-3.5" />{loading ? '正在读取回复处理策略' : '当前服务尚未提供回复处理策略，请检查管理服务版本。'}</p> : <div className="stack">
      <div className="formgrid">
        <Field id="execution-turn-seconds" label="总期限（秒）" tip="范围 0.01–300 秒；从收到任务起计时，进度输出不延长期限。"><Input id="execution-turn-seconds" type="number" min={0.01} max={300} step={0.01} value={form.turnSeconds} disabled={disabled} onChange={event => update({ turnSeconds: event.target.value })} /></Field>
        <Field id="execution-max-active" label="并行会话" tip="范围 1–256 个活动执行。"><Input id="execution-max-active" type="number" min={1} max={256} value={form.maxActive} disabled={disabled} onChange={event => update({ maxActive: event.target.value })} /></Field>
      </div>
      <div className="checks">
        <label className="check"><input id="execution-cancel-on-timeout" type="checkbox" checked={form.cancelOnTimeout} disabled={disabled} onChange={event => update({ cancelOnTimeout: event.target.checked })} />请求停止超时任务</label>
        <label className="check"><input id="execution-notice-enabled" type="checkbox" checked={form.noticeEnabled} disabled={disabled} onChange={event => { const noticeEnabled = event.target.checked; update({ noticeEnabled, ...(noticeEnabled && !form.noticeText.trim() ? { noticeText: defaultTimeoutNotice } : {}) }); }} />超时后发送提醒</label>
      </div>
      {form.noticeEnabled && <Field layout="stacked" label={nativeFormMetadata.execution.fields.noticeText}><Textarea id="execution-notice-text" rows={3} className="resize-y text-xs" maxLength={8000} value={form.noticeText} disabled={disabled} onChange={event => update({ noticeText: event.target.value })} /></Field>}
      <div className="strip">新消息有界排队，过期后结束；旧请求自动核对，迟到结果仅留档。</div>
    </div>}
  </Section>;
}
