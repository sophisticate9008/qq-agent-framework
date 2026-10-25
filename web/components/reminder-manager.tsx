import { useEffect, useMemo, useRef, useState } from 'react';
import { NATIVE_REMINDERS_PATH, NATIVE_REMINDER_HISTORY_PATH, parseNativeReminderSnapshot, parseNativeRemindersSnapshot,
  parseNativeReminderHistorySnapshot, type NativeReminderSnapshot } from '../../src/contracts/native-reminders.ts';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { createDraftKey, retainedDraft, retainDraft } from '../lib/retained-drafts.ts';
import { reminderConfiguration, reminderDraft, reminderOutcomeLabels, reminderStateLabels, reminderTime, type ReminderDraft } from '../lib/reminder-ui.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Textarea } from './ui/textarea.tsx';
import { Field, SaveBar, Section, ToggleField } from './management.tsx';

const draftKey = createDraftKey<{ readonly selected: NativeReminderSnapshot | null; readonly draft: ReminderDraft; readonly baseline: ReminderDraft }>('reminders');

export function ReminderManager({ api, connected, setDirty }: {
  readonly api: ApiClient; readonly connected: boolean; readonly setDirty: (value: boolean, scope?: string) => void;
}) {
  const retained = useMemo(() => retainedDraft(api, draftKey), [api]);
  const initial = useMemo(() => reminderDraft(), [api]);
  const [selected, setSelected] = useState<NativeReminderSnapshot | null>(retained?.selected ?? null);
  const [draft, setDraft] = useState(retained?.draft ?? initial);
  const [baseline, setBaseline] = useState(retained?.baseline ?? initial);
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [cancelConfirmed, setCancelConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const draftApi = useRef(api);
  const recovery = useNativeCatalogOperation(api, 'reminders');
  const list = useReadResource(api, `${NATIVE_REMINDERS_PATH}?${new URLSearchParams({ limit: '50', ...(cursor ? { after: cursor } : {}) })}`,
    connected, parseNativeRemindersSnapshot, { intervalMs: 5_000, pollWhen: () => !request.current });
  const history = useReadResource(api, `${NATIVE_REMINDER_HISTORY_PATH}?${new URLSearchParams({ limit: '25', ...(selected ? { ruleId: selected.id } : {}), ...(historyCursor ? { after: historyCursor } : {}) })}`,
    connected && selected !== null, parseNativeReminderHistorySnapshot, { intervalMs: 5_000, pollWhen: () => !request.current });
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const locked = saving || recovery.blocked;
  const terminal = selected !== null && ['cancelled', 'completed', 'expired', 'unknown'].includes(selected.state);

  useEffect(() => { setDirty(dirty, 'reminders'); }, [dirty, setDirty]);
  useEffect(() => {
    if (draftApi.current === api) retainDraft(api, draftKey, connected && dirty ? { selected, draft, baseline } : null);
  }, [api, connected, dirty, selected, draft, baseline]);
  useEffect(() => {
    if (draftApi.current !== api) { draftApi.current = api; const empty = reminderDraft(); setSelected(null); setDraft(empty); setBaseline(empty); }
    setConfirmed(false); setCancelConfirmed(false); setSaving(false); setError('');
    return () => request.current?.abort();
  }, [api, connected]);
  useEffect(() => () => setDirty(false, 'reminders'), [setDirty]);
  useEffect(() => {
    if (!list.loading && !list.error && list.updatedAt > 0) recovery.review();
    if (dirty || saving || recovery.blocked || !selected || list.updatedAt === 0 || list.loading || list.error) return;
    const next = list.snapshot?.rules.find(rule => rule.id === selected.id);
    if (next && next.revision !== selected.revision) { const form = reminderDraft(next.configuration); setSelected(next); setDraft(form); setBaseline(form); setConfirmed(false); }
  }, [list.updatedAt, list.loading, list.error, dirty, saving, recovery.blocked, selected]);

  function edit(rule: NativeReminderSnapshot | null): void {
    if (dirty || locked) return;
    const form = reminderDraft(rule?.configuration);
    setSelected(rule); setDraft(form); setBaseline(form); setConfirmed(false); setCancelConfirmed(false); setHistoryCursor(null); setError(''); setNotice('');
  }

  function update(patch: Partial<ReminderDraft>): void {
    if (locked || terminal) return;
    setDraft(current => ({ ...current, ...patch })); setConfirmed(false); setCancelConfirmed(false); setError(''); setNotice('');
  }

  async function commit(body: Readonly<Record<string, unknown>>): Promise<void> {
    if (locked || request.current || !connected) return;
    const controller = new AbortController(); request.current = controller;
    const token = recovery.begin(selected ? String(selected.revision) : 'new', controller.signal);
    if (!token) { request.current = null; return; }
    setSaving(true); setError(''); setNotice('');
    try {
      const value = await writeResource(api, NATIVE_REMINDERS_PATH, body, controller.signal);
      if (controller.signal.aborted) return;
      const result = parseNativeReminderSnapshot(value);
      if (!result || selected !== null && result.id !== selected.id) throw new Error('invalid_reminder_response');
      recovery.complete(token);
      const form = reminderDraft(result.configuration);
      setSelected(result); setDraft(form); setBaseline(form); setConfirmed(false); setCancelConfirmed(false);
      setNotice(result.state === 'enabled' ? '提醒已保存并启用，后续按实际权限与发送状态执行。' : result.state === 'cancelled' ? '规则已取消，已有历史结果保留。' : '提醒设置已保存。');
      setCursor(null); list.refresh(); history.refresh();
    } catch (failure) {
      recovery.fail(token, failure);
      if (!controller.signal.aborted) setError(`${errorMessage(failure)} 不会自动重试；请先读取规则和历史核对结果。`);
    } finally {
      if (!controller.signal.aborted) setSaving(false);
      if (request.current === controller) request.current = null;
    }
  }

  function save(): void {
    if (locked || terminal || !dirty || !confirmed) return;
    try {
      const configuration = reminderConfiguration(draft);
      if (configuration.schedule.kind === 'once' && configuration.schedule.at <= Date.now()) throw new Error('单次执行时间需要晚于当前时间。');
      void commit(selected ? { action: 'update', id: selected.id, revision: selected.revision, configuration } : { action: 'create', configuration });
    } catch (failure) { setError(failure instanceof Error && failure.message !== 'INVALID_NATIVE_REMINDER' ? failure.message : '请检查目标会话、提醒正文、时区和时间范围。'); }
  }

  if (!connected) return null;
  return <Section id="native-reminders" title="提醒规则" scrollable height="lg" description="启用后按规则向选定会话发送提醒。新草稿默认停用；权限不足或结果未知时不会自动补发。">
    <div className="grid gap-4 text-xs leading-6">
      <NativeCatalogRecovery recovery={recovery} reading={list.loading || saving} onRead={list.refresh} onReleased={() => setError('')} />
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={dirty || locked} onClick={() => edit(null)}>新建提醒</Button><Button size="sm" variant="outline" disabled={saving} onClick={list.refresh}>重新读取规则</Button></div>
      {list.error && <p role="status">提醒服务暂时不可读；已有草稿保留，不能据此确认调度状态。</p>}
      {!list.loading && list.snapshot?.rules.length === 0 && <p className="text-muted-foreground">还没有提醒规则，填写后明确创建；新草稿默认停用。</p>}
      {list.snapshot && <div className="grid max-h-80 gap-2 overflow-auto" aria-label="提醒规则列表">{list.snapshot.rules.map(rule => <div key={rule.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3"><span className="mr-auto min-w-0 flex-1 break-words"><strong>{rule.configuration.conversationId} · {reminderStateLabels[rule.state]}</strong><span className="block line-clamp-2">{rule.configuration.text}</span><span className="block text-muted-foreground">{rule.configuration.timeZone} · {reminderTime(rule.nextAt, rule.configuration.timeZone)}</span></span><Button size="sm" variant="outline" disabled={dirty || locked} onClick={() => edit(rule)}>查看或编辑</Button></div>)}</div>}
      {list.snapshot?.nextCursor && <Button size="sm" variant="outline" disabled={saving} onClick={() => setCursor(list.snapshot?.nextCursor ?? null)}>下一页规则</Button>}
      {cursor && <Button size="sm" variant="ghost" onClick={() => setCursor(null)}>返回首批规则</Button>}
      <div className="grid gap-4 rounded-lg border p-4" aria-label="提醒规则编辑">
        <strong>{selected ? `规则 ${selected.id} · ${reminderStateLabels[selected.state]} · 版本 ${selected.revision}` : '新提醒草稿'}</strong>
        {terminal && <p role="status">此规则已结束或发送结果未知。历史可读；未知结果不重发，可明确取消规则后另建新意图。</p>}
        <div className="grid gap-4 sm:grid-cols-2"><Field label="目标 QQ 会话" description={selected ? '已创建规则的目标会话固定；更换会话请明确新建规则。' : '填写group:群号或private:用户号；提醒不扩大访问权限。'}><Input value={draft.conversationId} disabled={locked || terminal || selected !== null} maxLength={40} placeholder="group:123456" onChange={event => update({ conversationId: event.target.value })} /></Field><Field label="提醒时区" description="使用IANA时区，例如Asia/Shanghai；每日/每周按此时区执行。"><Input value={draft.timeZone} disabled={locked || terminal} maxLength={100} onChange={event => update({ timeZone: event.target.value })} /></Field></div>
        <Field label="提醒正文"><Textarea value={draft.text} maxLength={4_000} disabled={locked || terminal} className="h-28" onChange={event => update({ text: event.target.value })} /></Field>
        <Field label="执行规则"><select value={draft.kind} className="h-9 w-full rounded-md border bg-background px-3 text-sm" disabled={locked || terminal} onChange={event => { if (['once', 'delay', 'daily', 'weekly'].includes(event.target.value)) update({ kind: event.target.value as ReminderDraft['kind'] }); }}><option value="delay">延时一次</option><option value="once">指定日期一次</option><option value="daily">每天</option><option value="weekly">每周</option></select></Field>
        {draft.kind === 'once' && <Field label="执行日期与时间" description="按上方时区解释；不存在或重复的夏令时刻需要另选时间。"><Input type="datetime-local" value={draft.onceAt} disabled={locked || terminal} onChange={event => update({ onceAt: event.target.value })} /></Field>}
        {draft.kind === 'delay' && <Field label="延迟分钟数" description="从本次保存计时，至少1秒，最多366天。"><Input type="number" min={1 / 60} max={366 * 24 * 60} step="any" value={draft.delayMinutes} disabled={locked || terminal} onChange={event => update({ delayMinutes: event.target.value })} /></Field>}
        {(draft.kind === 'daily' || draft.kind === 'weekly') && <Field label="执行时刻"><Input type="time" value={draft.time} disabled={locked || terminal} onChange={event => update({ time: event.target.value })} /></Field>}
        {draft.kind === 'weekly' && <Field label="每周执行日"><select value={draft.dayOfWeek} className="h-9 w-full rounded-md border bg-background px-3 text-sm" disabled={locked || terminal} onChange={event => update({ dayOfWeek: event.target.value })}>{['一', '二', '三', '四', '五', '六', '日'].map((day, index) => <option key={day} value={String(index + 1)}>星期{day}</option>)}</select></Field>}
        <ToggleField label="保存后启用提醒" checked={draft.enabled} disabled={locked || terminal} description="启用才会安排发送；未知结果保持隔离，不自动重试。" onChange={enabled => update({ enabled })} />
        <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={locked || terminal || !dirty} onChange={event => setConfirmed(event.target.checked)} />我已核对目标会话、时间和正文，确认{draft.enabled ? '保存并启用发送' : '保存为停用规则'}</label>
        <SaveBar dirty={dirty} saving={saving} disabled={locked || terminal || !confirmed || list.snapshot === null || list.error !== null} onSave={save} onReset={() => { if (!locked) { setDraft(baseline); setConfirmed(false); setError(''); } }} label={selected ? draft.enabled ? '保存并启用提醒' : '保存提醒设置' : draft.enabled ? '创建并启用提醒' : '创建停用提醒'} />
        {selected && !dirty && !locked && (selected.state === 'enabled' || selected.state === 'disabled') && <Button size="sm" variant="outline" onClick={() => void commit({ action: 'set-enabled', id: selected.id, revision: selected.revision, enabled: selected.state !== 'enabled' })}>{selected.state === 'enabled' ? '停用此提醒' : '启用此提醒'}</Button>}
        {selected && selected.state !== 'cancelled' && <details className="rounded-lg border p-3"><summary className="cursor-pointer">取消此规则</summary><div className="mt-3 grid gap-2"><p>取消未来执行并保留历史；正在发送或结果未知的消息不会自动撤回或重发。</p><label className="flex gap-2"><input type="checkbox" checked={cancelConfirmed} disabled={locked || dirty} onChange={event => setCancelConfirmed(event.target.checked)} />确认取消规则{selected.id}</label><Button size="sm" variant="destructive" disabled={locked || dirty || !cancelConfirmed} onClick={() => void commit({ action: 'cancel', id: selected.id, revision: selected.revision })}>确认取消提醒</Button></div></details>}
      </div>
      {selected && <div className="grid gap-2 rounded-lg border p-3" aria-label="提醒执行历史"><strong>下一次执行：{reminderTime(selected.nextAt, selected.configuration.timeZone)}</strong>{selected.lastOccurrence && <p>最近结果：{reminderOutcomeLabels[selected.lastOccurrence.status]}</p>}<Button size="sm" variant="outline" onClick={history.refresh}>读取执行历史</Button>{history.error && <p role="status">执行历史暂时不可读，不能据此判断发送结果。</p>}{history.snapshot?.history.map(item => <p key={item.id}>{reminderTime(item.scheduledAt, selected.configuration.timeZone)} · {reminderOutcomeLabels[item.status]}</p>)}{history.snapshot?.nextCursor && <Button size="sm" variant="outline" onClick={() => setHistoryCursor(history.snapshot?.nextCursor ?? null)}>更早的执行历史</Button>}</div>}
      {(error || notice) && <p role="status" className={error ? 'text-destructive' : ''}>{error || notice}</p>}
    </div>
  </Section>;
}
