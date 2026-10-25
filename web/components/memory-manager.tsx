import { useEffect, useMemo, useRef, useState } from 'react';
import { NATIVE_MEMORY_PATH, parseNativeMemoryEntry, parseNativeMemorySnapshot, validateNativeMemoryScope, type NativeMemoryEntry } from '../../src/contracts/native-memory.ts';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { createDraftKey, retainedDraft, retainDraft } from '../lib/retained-drafts.ts';
import { memoryDraft, memoryManagementRequest, memoryScopeLabel, memorySourceLabels, memoryStateLabels, memoryChangeLabels, type MemoryDraft } from '../lib/memory-ui.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { Section, Field, ToggleField } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Textarea } from './ui/textarea.tsx';

const key = createDraftKey<{ readonly selected: NativeMemoryEntry | null; readonly draft: MemoryDraft; readonly baseline: MemoryDraft }>('memory');
type FilterKind = 'all' | 'global' | 'group' | 'user';
export function MemoryManager({ api, connected, setDirty }: { readonly api: ApiClient; readonly connected: boolean; readonly setDirty: (value: boolean, scope?: string) => void }) {
  const initial = useMemo(() => retainedDraft(api, key), [api]);
  const empty = useMemo(() => memoryDraft(), [api]);
  const [selected, setSelected] = useState<NativeMemoryEntry | null>(initial?.selected ?? null);
  const [draft, setDraft] = useState(initial?.draft ?? empty);
  const [baseline, setBaseline] = useState(initial?.baseline ?? empty);
  const [filterKind, setFilterKind] = useState<FilterKind>('all');
  const [filterConversation, setFilterConversation] = useState('');
  const [filterUser, setFilterUser] = useState('');
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [revokeConfirmed, setRevokeConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const draftApi = useRef(api);
  const recovery = useNativeCatalogOperation(api, 'memory');
  const resource = useReadResource(api, `${NATIVE_MEMORY_PATH}?limit=50${filter}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, connected, parseNativeMemorySnapshot,
    { intervalMs: 5_000, pollWhen: () => !request.current });
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const locked = saving || recovery.blocked;
  const terminal = selected !== null && (selected.status === 'revoked' || selected.status === 'expired');
  useEffect(() => { setDirty(dirty, 'memory'); }, [dirty, setDirty]);
  useEffect(() => { if (draftApi.current === api) retainDraft(api, key, connected && dirty ? { selected, draft, baseline } : null); }, [api, connected, dirty, selected, draft, baseline]);
  useEffect(() => {
    if (draftApi.current !== api) { draftApi.current = api; const form = memoryDraft(); setSelected(null); setDraft(form); setBaseline(form); }
    setSaving(false); setRevokeConfirmed(false);
    return () => request.current?.abort();
  }, [api, connected]);
  useEffect(() => () => setDirty(false, 'memory'), [setDirty]);
  useEffect(() => {
    if (resource.updatedAt > 0 && !resource.loading && !resource.error) recovery.review();
    if (dirty || saving || recovery.blocked || !selected || resource.loading || resource.error || resource.updatedAt === 0) return;
    const next = resource.snapshot?.entries.find(entry => entry.id === selected.id);
    if (next && next.revision !== selected.revision) { const form = memoryDraft(next); setSelected(next); setDraft(form); setBaseline(form); setRevokeConfirmed(false); }
  }, [resource.updatedAt, resource.loading, resource.error, dirty, saving, recovery.blocked, selected]);

  function edit(entry: NativeMemoryEntry | null): void {
    if (dirty || locked) return;
    const form = memoryDraft(entry ?? undefined); setSelected(entry); setDraft(form); setBaseline(form); setRevokeConfirmed(false); setError(''); setNotice('');
  }
  function update(patch: Partial<MemoryDraft>): void { if (!locked && !terminal) { setDraft(current => ({ ...current, ...patch })); setError(''); setNotice(''); setRevokeConfirmed(false); } }
  function applyFilter(): void {
    try {
      const scope = filterKind === 'all' ? null : validateNativeMemoryScope(filterKind === 'global' ? { kind: 'global' }
        : filterKind === 'group' ? { kind: 'group', conversationId: filterConversation.trim() }
          : { kind: 'user', conversationId: filterConversation.trim(), userId: filterUser.trim() });
      const query = new URLSearchParams(scope === null ? {} : { scope: scope.kind,
        ...(scope.kind === 'global' ? {} : { conversationId: scope.conversationId }), ...(scope.kind === 'user' ? { userId: scope.userId } : {}) });
      setFilter(query.size ? `&${query}` : ''); setCursor(null); setError('');
    } catch { setError('请填写有效的筛选会话与用户账号；群范围使用group:群号。'); }
  }
  async function commit(revoke = false): Promise<void> {
    if (locked || request.current || !resource.snapshot || resource.error || !connected || revoke && (!selected || !revokeConfirmed || dirty) || !revoke && (!dirty || terminal)) return;
    let body: unknown;
    try { body = revoke && selected ? { action: 'revoke', id: selected.id, revision: selected.revision } : memoryManagementRequest(draft, selected); }
    catch (failure) { setError(failure instanceof Error && failure.message !== 'INVALID_NATIVE_MEMORY' ? failure.message : '请检查范围、正文、标签与有效期。'); return; }
    const controller = new AbortController(); request.current = controller;
    const token = recovery.begin(selected ? String(selected.revision) : 'new', controller.signal);
    if (!token) { request.current = null; return; }
    setSaving(true); setError(''); setNotice('');
    try {
      const result = parseNativeMemoryEntry(await writeResource(api, NATIVE_MEMORY_PATH, body, controller.signal));
      if (!result || selected && result.id !== selected.id) throw new Error('invalid_memory_response');
      if (controller.signal.aborted) return;
      recovery.complete(token);
      const form = memoryDraft(result); setSelected(result); setDraft(form); setBaseline(form); setRevokeConfirmed(false);
      setNotice(result.status === 'proposed' ? '更正已保存；这条提议仍需主人在所属 QQ 会话确认。' : result.status === 'revoked' ? '记忆已撤销，后续上下文不再采用。' : '手工记忆更改已保存，按范围与有效期用于后续上下文，不扩大权限。');
      resource.refresh();
    } catch (failure) { recovery.fail(token, failure); if (!controller.signal.aborted) setError(`${errorMessage(failure)} 不会自动重试管理写入。`); }
    finally { if (!controller.signal.aborted) setSaving(false); if (request.current === controller) request.current = null; }
  }

  if (!connected) return null;
  return <Section id="native-memory" title="记忆与偏好" scrollable height="lg" description="查看来源、范围与有效期，手工记录、纠正或撤销内容。模型提议只能由主人在所属 QQ 会话明确确认。">
    <div className="grid gap-4 text-xs leading-6">
      <NativeCatalogRecovery recovery={recovery} reading={resource.loading || saving} onRead={resource.refresh} onReleased={() => setError('')} />
      <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"><Field label="记忆筛选范围"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={filterKind} onChange={event => { if (['all', 'global', 'group', 'user'].includes(event.target.value)) setFilterKind(event.target.value as FilterKind); }}><option value="all">全部范围</option><option value="global">全局共享</option><option value="group">指定群</option><option value="user">指定用户与来源会话</option></select></Field>{(filterKind === 'group' || filterKind === 'user') && <Field label="筛选来源会话"><Input value={filterConversation} placeholder="group:群号或private:用户号" onChange={event => setFilterConversation(event.target.value)} /></Field>}{filterKind === 'user' && <Field label="筛选用户账号"><Input value={filterUser} onChange={event => setFilterUser(event.target.value)} /></Field>}<Button size="sm" variant="outline" disabled={saving} onClick={applyFilter}>筛选记忆</Button></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={locked || dirty} onClick={() => edit(null)}>新增手工记忆</Button><Button size="sm" variant="outline" disabled={saving} onClick={resource.refresh}>读取记忆列表</Button></div>
      {resource.error && <p role="status">记忆服务暂时不可读；草稿保留，不能据此认为没有记忆。</p>}
      {resource.snapshot?.entries.length === 0 && <p>当前筛选范围没有记忆。</p>}
      {resource.snapshot && <div className="grid max-h-80 gap-2 overflow-auto" aria-label="记忆列表">{resource.snapshot.entries.map(entry => <div key={entry.id} className="grid gap-2 rounded-lg border p-3"><strong>{memoryScopeLabel(entry.scope)} · {memoryStateLabels[entry.status]}</strong><p className="whitespace-pre-wrap break-words">{entry.content}</p><p>来源：{memorySourceLabels[entry.source.kind]} · {entry.expiresAt === null ? '长期保存' : `有效至${new Date(entry.expiresAt).toLocaleString()}`}</p><Button size="sm" variant="outline" disabled={locked || dirty} onClick={() => edit(entry)}>查看来源或纠正</Button></div>)}</div>}
      {resource.snapshot?.nextCursor && <Button size="sm" variant="outline" disabled={saving} onClick={() => setCursor(resource.snapshot?.nextCursor ?? null)}>下一页记忆</Button>}{cursor && <Button size="sm" variant="ghost" onClick={() => setCursor(null)}>返回首批记忆</Button>}
      <div className="grid gap-4 rounded-lg border p-4" aria-label="记忆管理编辑">
        <strong>{selected ? `${memoryStateLabels[selected.status]} · 版本${selected.revision}` : '新手工记忆'}</strong>
        {selected?.status === 'proposed' && <p>这条内容尚未采用。管理页的纠正会保留待确认状态；请由主人在所属 QQ 会话处理。</p>}
        <Field label="记忆作用范围" description="已有条目的范围固定；跨范围共享需明确新建。全局共享由主人手工登记。"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={draft.scope} disabled={locked || terminal || selected !== null} onChange={event => { if (['global', 'group', 'user'].includes(event.target.value)) update({ scope: event.target.value as MemoryDraft['scope'] }); }}><option value="group">指定群</option><option value="user">指定用户与来源会话</option><option value="global">全局共享</option></select></Field>
        {draft.scope !== 'global' && <Field label="记忆来源会话"><Input value={draft.conversationId} disabled={locked || terminal || selected !== null} maxLength={40} placeholder="group:群号或private:用户号" onChange={event => update({ conversationId: event.target.value })} /></Field>}
        {draft.scope === 'user' && <Field label="记忆用户账号"><Input value={draft.userId} disabled={locked || terminal || selected !== null} maxLength={32} onChange={event => update({ userId: event.target.value })} /></Field>}
        <Field label="记忆类型"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={draft.kind} disabled={locked || terminal} onChange={event => { if (event.target.value === 'memory' || event.target.value === 'preference') update({ kind: event.target.value }); }}><option value="memory">事实记忆</option><option value="preference">偏好</option></select></Field>
        <Field label="记忆正文"><Textarea value={draft.content} maxLength={4_000} disabled={locked || terminal} className="h-28" onChange={event => update({ content: event.target.value })} /></Field>
        <Field label="记忆标签" description="可选，每行或逗号分隔，最多16个且不能重复。"><Textarea value={draft.tags} maxLength={1_040} disabled={locked || terminal} className="h-20" onChange={event => update({ tags: event.target.value })} /></Field>
        {selected && <><p>当前期限：{selected.expiresAt === null ? '长期保存' : new Date(selected.expiresAt).toLocaleString()}</p><ToggleField label="更改记忆有效期" checked={draft.changeExpiry} disabled={locked || terminal} onChange={changeExpiry => update({ changeExpiry })} /></>}
        {draft.changeExpiry && <><ToggleField label="记忆长期保存" checked={draft.permanent} disabled={locked || terminal} onChange={permanent => update({ permanent })} />{!draft.permanent && <Field label="记忆有效小时数" description="从这次明确保存起计时。"><Input type="number" min={0.001} step="any" value={draft.hours} disabled={locked || terminal} onChange={event => update({ hours: event.target.value })} /></Field>}</>}
        <div className="flex flex-wrap gap-2"><Button disabled={locked || terminal || !dirty || !resource.snapshot || !!resource.error} onClick={() => void commit()}>{saving ? '正在保存…' : selected?.status === 'proposed' ? '保存更正（仍待QQ确认）' : selected ? '保存记忆纠正' : '保存手工记忆'}</Button><Button variant="ghost" disabled={locked || !dirty} onClick={() => { setDraft(baseline); setError(''); }}>撤销记忆草稿</Button></div>
        {selected && <details className="rounded-lg border p-3"><summary className="cursor-pointer">来源与修改记录</summary><div className="mt-3 grid gap-2"><p>范围：{memoryScopeLabel(selected.scope)}</p><p>来源：{memorySourceLabels[selected.source.kind]}</p>{selected.source.kind !== 'operator' && <p>来源会话：{selected.source.conversationId} · 用户{selected.source.userId} · 消息{selected.source.messageId}</p>}<p>采用依据：{selected.confirmedBy ? memorySourceLabels[selected.confirmedBy.kind] : '尚未确认'}</p>{selected.history.map((change, index) => <p key={index}>{new Date(change.at).toLocaleString()} · {memoryChangeLabels[change.action]} · {memorySourceLabels[change.source.kind]}</p>)}{selected.historyTruncated && <p>较早记录未包含在本次返回的历史中。</p>}</div></details>}
        {selected && !terminal && <details className="rounded-lg border p-3"><summary className="cursor-pointer">撤销此条记忆</summary><div className="mt-3 grid gap-2"><label className="flex gap-2"><input type="checkbox" checked={revokeConfirmed} disabled={locked || dirty} onChange={event => setRevokeConfirmed(event.target.checked)} />确认撤销此条内容，不再用于后续上下文</label><Button size="sm" variant="destructive" disabled={locked || dirty || !revokeConfirmed} onClick={() => void commit(true)}>撤销记忆</Button></div></details>}
      </div>
      {(error || notice) && <p role="status" className={error ? 'text-destructive' : ''}>{error || notice}</p>}
    </div>
  </Section>;
}
