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
import { Field, SaveBar, Section, ToggleField } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Textarea } from './ui/textarea.tsx';

const executionDraftKey = createDraftKey<{ readonly saved: ExecutionConfiguration; readonly form: ExecutionForm }>('chat-execution');

export function ChatExecutionSettings({ api, connected, navigate, setDirty }: PageProps) {
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
  const [confirmReload, setConfirmReload] = useState(false);
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
    setError(''); setNotice(''); setConfirmReload(false);
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
      setNotice('处理策略已保存；停止并重新启动聊天后生效，不会重置既有会话或补充授权。');
    } catch (failure) {
      const failureState = recovery.fail(operationToken, failure);
      if (current()) { setError(`${errorMessage(failure)} 请重新读取核对，不会自动重复提交。`); setBlocked(failureState !== 'idle'); }
    } finally {
      if (current()) setSaving(false);
      if (writeController.current === controller) writeController.current = null;
    }
  }

  if (!connected) return null;
  return <Section id={nativeFormMetadata.execution.id} title={nativeFormMetadata.execution.title} description="默认每次处理最多 120 秒，持续输出进度不会延长期限。其他会话不必等待超时任务。" scrollable
    actions={<Button variant="outline" size="sm" disabled={saving || loading} onClick={readAgain}><RefreshCw className="size-3.5" />重新读取策略</Button>}
    footer={<SaveBar dirty={dirty} saving={saving} disabled={loading || blocked} onSave={() => void save()} onReset={saved && !blocked ? () => { setForm(executionForm(saved.policy)); setError(''); } : undefined} label="保存处理策略" message={notice || (blocked ? '保存结果需核对，不能重复提交。' : dirty ? '策略更改尚未保存。' : '保存不等于已应用，不会自动重启聊天。')} />}>
    <NativeCatalogRecovery recovery={recovery} reading={loading || saving} onRead={readAgain} onReleased={() => { setBlocked(false); setError(''); }} />
    {error && <p role="alert" className="mb-4 text-xs leading-6 text-destructive">{error}</p>}
    {!form ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="size-4" />{loading ? '正在读取回复处理策略' : '当前服务尚未提供回复处理策略，请检查管理服务版本。'}</p> : <div className="grid gap-4">
      <Field label={nativeFormMetadata.execution.fields.turnSeconds} description="单位为秒，包含提交和等待完整回复；从框架接收任务开始计时。"><Input id="execution-turn-seconds" type="number" min={0.01} max={300} step={0.01} value={form.turnSeconds} disabled={disabled} onChange={event => update({ turnSeconds: event.target.value })} /></Field>
      <ToggleField label={nativeFormMetadata.execution.fields.noticeEnabled} description="默认关闭；开启后超时会向对应 QQ 会话发送一条提醒，失败详情只留控制台。" checked={form.noticeEnabled} disabled={disabled} onChange={noticeEnabled => update({ noticeEnabled, ...(noticeEnabled && !form.noticeText.trim() ? { noticeText: defaultTimeoutNotice } : {}) })} />
      {form.noticeEnabled && <Field label={nativeFormMetadata.execution.fields.noticeText}><Textarea id="execution-notice-text" className="h-24 resize-none text-xs" maxLength={8000} value={form.noticeText} disabled={disabled} onChange={event => update({ noticeText: event.target.value })} /></Field>}
      <ToggleField label={nativeFormMetadata.execution.fields.cancelOnTimeout} description="超时后只向当前执行发起一次协作停止；请求受理不代表模型已经停止。" checked={form.cancelOnTimeout} disabled={disabled} onChange={cancelOnTimeout => update({ cancelOnTimeout })} />
      {form.cancelOnTimeout && <details><summary className="cursor-pointer text-xs text-muted-foreground">旧限制模式的停止设置</summary><p className="mt-2 text-xs text-muted-foreground">旧限制模式仍保留原有次数上限，可在高级访问设置中查看。</p><Button variant="outline" size="sm" className="mt-2" onClick={() => navigate('access')}>高级访问设置</Button></details>}
      <details><summary className="cursor-pointer text-xs text-muted-foreground">高级：并行数与确认期限</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><Field label={nativeFormMetadata.execution.fields.maxActive}><Input id="execution-max-active" type="number" min={1} max={256} value={form.maxActive} disabled={disabled} onChange={event => update({ maxActive: event.target.value })} /></Field>{form.cancelOnTimeout && <Field label={nativeFormMetadata.execution.fields.cancelSeconds} description="秒；超时后仍按结果未确认处理。"><Input id="execution-cancel-seconds" type="number" min={0.01} max={30} step={0.01} value={form.cancelSeconds} disabled={disabled} onChange={event => update({ cancelSeconds: event.target.value })} /></Field>}{form.noticeEnabled && <Field label={nativeFormMetadata.execution.fields.noticeSeconds} description="秒；无法确认发送时不会自动重发。"><Input id="execution-notice-seconds" type="number" min={0.01} max={30} step={0.01} value={form.noticeSeconds} disabled={disabled} onChange={event => update({ noticeSeconds: event.target.value })} /></Field>}</div></details>
      <p className="border-t pt-3 text-xs leading-6 text-muted-foreground">结果未确认时暂停该会话的后续任务，不自动重发、换会话或清空上下文。迟到结果只留档，不冒充下一条请求的回复；其他会话继续处理。</p>
    </div>}
    {confirmReload && <div role="alert" className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border p-3 text-xs"><span className="mr-auto">重新读取会丢弃当前未保存的策略草稿。</span><Button size="sm" variant="outline" onClick={() => setConfirmReload(false)}>保留草稿</Button><Button size="sm" variant="destructive" onClick={() => setReload(value => value + 1)}>放弃草稿并重新读取</Button></div>}
  </Section>;
}
