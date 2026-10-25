import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NATIVE_USAGE_MAINTENANCE_PATH, parseNativeUsageMaintenanceEnvelope, parseNativeUsageMaintenanceList, type NativeUsageMaintenanceListSnapshot, parseNativeUsageExport, parseNativeUsageMaintenanceScope, type NativeUsageMaintenanceOperation } from '../../src/contracts/native-usage-maintenance.ts';
import { ApiError, errorMessage } from '../lib/api.ts';
import { createDraftKey, retainedDraft, retainDraft, subscribeRetainedDrafts } from '../lib/retained-drafts.ts';
import { writeResource, readResource } from '../lib/resource-reader.ts';
import type { PageProps } from '../lib/types.ts';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Field, Section } from './management.tsx';

interface State { readonly id: string | null; readonly operation: NativeUsageMaintenanceOperation | null; readonly phase: 'idle' | 'writing' | 'unknown'; readonly message: string }
const initial: State = { id: null, operation: null, phase: 'idle', message: '' };
const stateKey = createDraftKey<State>('usage-maintenance-operation', { kind: 'state' });
const scopeKey = createDraftKey<{ readonly since: string; readonly until: string; readonly conversation: string; readonly provider: string; readonly model: string; readonly after: string }>('usage-maintenance-filter', { kind: 'state' });
function dateInput(time: number): string { const value = new Date(time); return new Date(time - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
export function UsageMaintenanceManager({ api, connected, onSaved }: PageProps & { readonly onSaved: () => void }) {
  const state = useSyncExternalStore(listener => subscribeRetainedDrafts(api, listener), () => retainedDraft(api, stateKey) ?? initial);
  const [filter, setFilter] = useState(() => retainedDraft(api, scopeKey) ?? { since: dateInput(Date.now() - 30 * 86400_000), until: dateInput(Date.now()), conversation: '', provider: '', model: '', after: '' });
  const [confirmed, setConfirmed] = useState(false);
  const [reading, setReading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const lifecycle = useRef(0);
  useEffect(() => { lifecycle.current++; return () => { lifecycle.current++; }; }, [api, connected]);
  const [history, setHistory] = useState<NativeUsageMaintenanceListSnapshot | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false); const [historyError, setHistoryError] = useState('');
  useEffect(() => { if (connected) void loadHistory(); }, [api, connected]);
  const [notice, setNotice] = useState('');
  function edit(key: keyof typeof filter, value: string): void { const next = { ...filter, [key]: value }; setFilter(next); retainDraft(api, scopeKey, next); setConfirmed(false); }
  function scope() { return parseNativeUsageMaintenanceScope({ since: new Date(filter.since).getTime(), until: new Date(filter.until).getTime(), ...(filter.after.trim() ? { after: filter.after.trim() } : {}), ...(filter.conversation.trim() ? { conversationId: filter.conversation.trim() } : {}), ...(filter.provider.trim() ? { provider: filter.provider.trim() } : {}), ...(filter.model.trim() ? { model: filter.model.trim() } : {}) }); }
  async function write(kind?: 'archive' | 'clear'): Promise<void> {
    if (!connected || state.phase !== 'idle' || reading || exporting) return;
    const selected = scope(); if (!selected) { setNotice('请检查起止时间与会话标识。'); return; }
    const id = kind ? crypto.randomUUID() : state.id; if (!id || !kind && (!confirmed || state.operation?.state !== 'prepared')) return;
    const request = kind ? { action: 'preview', operationId: id, kind, scope: selected } : { action: 'confirm', operationId: id, revision: state.operation?.revision, confirm: true };
    setNotice(''); const previous = state; const pending: State = { ...previous, id, phase: 'writing', message: '' }; retainDraft(api, stateKey, pending); setConfirmed(false);
    try {
      const parsed = parseNativeUsageMaintenanceEnvelope(await writeResource(api, NATIVE_USAGE_MAINTENANCE_PATH, request));
      if (retainedDraft(api, stateKey) !== pending) return;
      if (!parsed?.operation || parsed.operation.id !== id || kind && (parsed.operation.kind !== kind || Object.entries(selected).some(([key, value]) => parsed.operation?.scope[key as keyof typeof selected] !== value))) throw new Error('invalid_usage_maintenance');
      retainDraft(api, stateKey, { id, operation: parsed.operation, phase: 'idle', message: parsed.operation.state === 'completed' ? '本批操作已持久完成。' : '' });
      if (parsed.operation.state === 'completed') onSaved();
    } catch (error) {
      if (retainedDraft(api, stateKey) !== pending) return;
      const unknown = !(error instanceof ApiError) || error.status >= 500 || /unknown/.test(error.code);
      retainDraft(api, stateKey, { ...previous, id, phase: unknown ? 'unknown' : 'idle', message: unknown ? '结果未知。仅按原操作标识读取结果，不会重新提交。' : error instanceof ApiError && error.code === 'usage_ledger_not_created' ? '尚无用量账本，暂无可归档或清理记录。' : errorMessage(error) });
    }
  }
  async function review(selectedId?: string): Promise<void> {
    const operationId = selectedId ?? state.id;
    if (state.phase === 'unknown' && selectedId && selectedId !== state.id) { setNotice('请先核对当前未知操作的原结果，再选择其他记录。'); return; }
    if (!operationId || reading || state.phase === 'writing' || !connected) return;
    const generation = lifecycle.current; setReading(true); setNotice(''); setConfirmed(false);
    try {
      const parsed = parseNativeUsageMaintenanceEnvelope(await readResource(api, `${NATIVE_USAGE_MAINTENANCE_PATH}?id=${operationId}`)); if (generation !== lifecycle.current || (retainedDraft(api, stateKey) ?? initial) !== state) return; if (!parsed || parsed.operation && parsed.operation.id !== operationId) throw new Error('invalid_usage_maintenance');
      const unresolved = state.phase === 'unknown' && parsed.operation?.state === 'prepared';
      retainDraft(api, stateKey, { id: operationId, operation: parsed.operation, phase: unresolved ? 'unknown' : 'idle', message: unresolved ? '原预览仍未结算；等待其失效或核对持久完成结果，不重新提交。' : parsed.operation ? '已读取原操作的持久状态。' : '原操作未记录或预览已失效，可明确创建新的预览。' });
      if (parsed.operation?.state === 'completed') onSaved();
    } catch (error) { setNotice(errorMessage(error)); } finally { setReading(false); }
  }
  async function loadHistory(after?: string): Promise<void> {
    if (!connected) return;
    const generation = lifecycle.current; setHistoryLoading(true); setHistoryError('');
    try {
      const query = new URLSearchParams({ action: 'list', limit: '20', ...(after ? { after } : {}) });
      const parsed = parseNativeUsageMaintenanceList(await readResource(api, `${NATIVE_USAGE_MAINTENANCE_PATH}?${query}`));
      if (!parsed) throw new Error('invalid_usage_maintenance_history');
      if (generation === lifecycle.current) setHistory(parsed);
    } catch { if (generation === lifecycle.current) setHistoryError('操作记录暂时无法读取；可能尚未创建账本，也可能存储不可用。不以空记录代替未知。'); }
    finally { if (generation === lifecycle.current) setHistoryLoading(false); }
  }
  async function download(source: 'active' | 'archive'): Promise<void> {
    const selected = scope(); if (!selected || exporting || !connected) { setNotice('请检查导出范围。'); return; }
    const generation = lifecycle.current; setExporting(true); setNotice('');
    try {
      const query = new URLSearchParams({ action: 'export', source }); for (const [key, value] of Object.entries(selected)) query.set(key, String(value));
      const exported = parseNativeUsageExport(await readResource(api, `${NATIVE_USAGE_MAINTENANCE_PATH}?${query}`)); if (!exported || exported.source !== source || Object.entries(selected).some(([key, value]) => exported.scope[key as keyof typeof selected] !== value)) throw new Error('invalid_usage_export');
      const bytes = new TextEncoder().encode(exported.data); const digest = await crypto.subtle.digest('SHA-256', bytes); const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      if (generation !== lifecycle.current) return;
      if (sha256 !== exported.sha256) throw new Error('invalid_usage_export_hash');
      const url = URL.createObjectURL(new Blob([bytes], { type: exported.mediaType })); const link = document.createElement('a'); link.href = url; link.download = exported.fileName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`已导出 ${exported.records} 条记录，SHA-256 ${sha256}。${exported.partial ? '本批不完整；可按返回游标继续导出。' : ''}`);
    } catch (error) { setNotice(errorMessage(error)); } finally { setExporting(false); }
  }
  const operation = state.operation; const locked = !connected || state.phase !== 'idle' || reading || exporting;
  return <Section id="native-usage-maintenance" title="归档与清理用量记录" description="先预览精确范围，再确认本批记录。未知轮次与执行证据保留，历史费用不重算。">
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2"><Field label="范围开始"><Input type="datetime-local" value={filter.since} onChange={event => edit('since', event.target.value)} disabled={locked} /></Field><Field label="范围结束（不含）"><Input type="datetime-local" value={filter.until} onChange={event => edit('until', event.target.value)} disabled={locked} /></Field><Field label="会话筛选"><Input placeholder="group:123 / private:123；留空为全部" value={filter.conversation} onChange={event => edit('conversation', event.target.value)} disabled={locked} /></Field><Field label="提供方筛选"><Input value={filter.provider} onChange={event => edit('provider', event.target.value)} disabled={locked} /></Field><Field label="批次游标（首批留空）"><Input value={filter.after} onChange={event => edit('after', event.target.value)} disabled={locked} /></Field><Field label="模型筛选"><Input value={filter.model} onChange={event => edit('model', event.target.value)} disabled={locked} /></Field></div>
      <p className="text-xs text-muted-foreground">归档保全已结算明细；清理删除所选用量明细，保留最小去重凭据，避免迟到响应恢复旧统计。每批最多 60 条；不会删除会话、执行、工作或发送回执。</p>
      <div className="flex flex-wrap gap-2"><Button disabled={locked} onClick={() => void write('archive')}>预览归档</Button><Button variant="outline" disabled={locked} onClick={() => void write('clear')}>预览清理</Button><Button variant="outline" disabled={locked} onClick={() => void download('active')}>导出当前记录 JSON</Button><Button variant="outline" disabled={locked} onClick={() => void download('archive')}>导出归档 JSON</Button><Button variant="outline" disabled={!connected || !state.id || reading || state.phase === 'writing'} onClick={() => void review()}>读取原操作结果</Button></div>
      <details className="rounded-lg border p-3 text-xs" data-usage-operation-history><summary className="cursor-pointer font-medium">查找已记录的账本操作</summary><div className="mt-3 grid gap-3"><p className="text-muted-foreground">关闭页面后可在这里发现原操作标识。列表仅含范围与状态，按存储位置分页，每批最多 20 项；不会自动确认或继续写入。</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!connected || historyLoading} onClick={() => void loadHistory()}>读取首批操作记录</Button>{history?.next && <Button size="sm" variant="outline" disabled={historyLoading} onClick={() => void loadHistory(history.next ?? undefined)}>下一批操作记录</Button>}</div>{historyError && <p role="status">{historyError}</p>}{history && <><p>{history.operations.length} 项已读取{history.partial ? '；仍有未加载记录。' : '；本批读取结束，不代表其他过期预览仍存在。'}</p>{history.operations.map(item => <div key={item.id} className="grid gap-1 rounded border p-2"><p>{item.kind === 'archive' ? '归档' : '清理'} · {item.state} · {new Date(item.createdAt).toLocaleString()}；范围 {new Date(item.scope.since).toLocaleString()} 至 {new Date(item.scope.until).toLocaleString()}，{item.scope.conversationId ?? '全部会话'}。</p><code className="break-all">{item.id}</code>{item.state === 'prepared' && <p>预览失效时间：{new Date(item.expiresAt).toLocaleString()}</p>}<Button size="sm" variant="outline" disabled={reading || state.phase === 'writing' || state.phase === 'unknown' && item.id !== state.id} onClick={() => void review(item.id)}>读取此操作详情</Button></div>)}</>}</div></details>
      {state.id && <p className="break-all text-xs text-muted-foreground">操作标识：{state.id} · {state.phase === 'writing' ? '提交中' : state.phase === 'unknown' ? '结果未知' : operation?.state ?? '无持久预览'}</p>}
      {operation && <div className="grid gap-3 rounded-lg border p-3 text-xs"><p>{operation.kind === 'archive' ? '归档' : '清理'}预览：{operation.rows.length} 条；保护未知记录 {operation.protectedUnknown} 条；已完成 {operation.affected} 条。{operation.partial && '仅为本批，仍有未扫描记录。'}</p><p className="text-muted-foreground">预览时间范围：{new Date(operation.scope.since).toLocaleString()} 至 {new Date(operation.scope.until).toLocaleString()}；会话 {operation.scope.conversationId ?? '全部'}；提供方 {operation.scope.provider ?? '全部'}；模型 {operation.scope.model ?? '全部'}。</p><ul className="max-h-48 overflow-auto">{operation.rows.map(row => <li key={row.cursor}>{row.conversationId} · {row.provider}/{row.model} · {row.status} · {new Date(row.recordedAt).toLocaleString()}</li>)}</ul>{operation.missingReasons.length > 0 && <p role="alert">阻断原因：{operation.missingReasons.join('、')}</p>}{operation.state === 'prepared' && <><label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={locked} />我已核对本次预览，确认{operation.kind === 'archive' ? '归档' : '永久清理'}以上精确记录</label><Button variant={operation.kind === 'clear' ? 'destructive' : 'default'} disabled={locked || !confirmed || operation.rows.length === 0} onClick={() => void write()}>确认本批{operation.kind === 'archive' ? '归档' : '清理'}</Button></>}{operation.next && operation.state === 'completed' && <p className="break-all text-muted-foreground">下一批游标：{operation.next}；下一批需重新预览并确认。<Button size="sm" variant="outline" disabled={locked} onClick={() => edit('after', operation.next ?? '')}>填入下一批游标</Button></p>}</div>}
      {(state.message || notice) && <p role="status" className="break-all text-xs">{state.message} {notice}</p>}
    </div>
  </Section>;
}
