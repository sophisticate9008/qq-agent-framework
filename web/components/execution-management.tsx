import { useEffect, useState, useSyncExternalStore } from 'react';
import { parseNativeExecutionRecoveryView, type NativeExecutionRecoveryView } from '../../src/contracts/native-execution-recovery.ts';
import { ApiError, errorMessage, isRecord, type ApiClient } from '../lib/api.ts';
import { createDraftKey, retainedDraft, retainDraft, subscribeRetainedDrafts, type DraftKey } from '../lib/retained-drafts.ts';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { parseExecutionDetail, parseExecutionReconciliation, type ExecutionReconciliationView } from '../lib/execution-management.ts';
import type { ExecutionJournalEntry } from '../lib/execution-journal.ts';
import { Button } from './ui/button.tsx';
interface State { readonly phase: 'idle' | 'writing' | 'unknown'; readonly action: 'reconcile' | 'preview' | 'commit' | null; readonly recovery: NativeExecutionRecoveryView | null; readonly originalRevision: string | null; readonly result: ExecutionReconciliationView | null; readonly message: string }
const empty: State = { phase: 'idle', action: null, recovery: null, originalRevision: null, result: null, message: '' };
const keys = new Map<string, DraftKey<State>>();
function key(id: string): DraftKey<State> { let value = keys.get(id); if (!value) { value = createDraftKey<State>(`execution-management:${id}`, { kind: 'state' }); keys.set(id, value); } return value; }
export function ExecutionManagement({ api, connected, entry, onRead }: { readonly api: ApiClient; readonly connected: boolean; readonly entry: ExecutionJournalEntry; readonly onRead: () => void }) {
  const id = entry.id; const draftKey = key(id);
  const state = useSyncExternalStore(listener => subscribeRetainedDrafts(api, listener), () => retainedDraft(api, draftKey) ?? empty);
  const [reading, setReading] = useState(false); const [error, setError] = useState(''); const [confirm, setConfirm] = useState(false);
  const [readView, setReadView] = useState<NativeExecutionRecoveryView | null>(null);
  const [observed, setObserved] = useState<ExecutionJournalEntry | null>(null);
  const [readVersion, setReadVersion] = useState(0);
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController(); setReading(true); setError(''); setConfirm(false);
    void Promise.allSettled([
      readResource(api, `/api/chat/executions?id=${id}`, controller.signal).then(input => { const parsed = parseExecutionDetail(input, id); if (!parsed) throw new Error('invalid_execution_detail'); if (!controller.signal.aborted) { setObserved(parsed.item); const current = retainedDraft(api, draftKey); if (current?.phase === 'unknown' && current.action === 'reconcile' && parsed.item && !parsed.item.isolated) retainDraft(api, draftKey, { ...current, phase: 'idle', result: null, message: '已按原执行标识核对，当前记录不再隔离；未重发任何请求。' }); } }),
      readResource(api, `/api/chat/executions/recovery?id=${id}`, controller.signal).then(input => {
        if (!isRecord(input) || input.native !== true || input.automaticReplayAvailable !== false) throw new Error('invalid_execution_recovery');
        const view = input.item === null ? null : parseNativeExecutionRecoveryView(input.item); if (input.item !== null && (!view || view.executionId !== id)) throw new Error('invalid_execution_recovery');
        if (controller.signal.aborted) return;
        setReadView(view);
        const current = retainedDraft(api, draftKey) ?? empty;
        if (current === empty) return;
        const resolved = current.phase === 'unknown' && (current.action === 'preview' && view !== null || current.action === 'commit' && (view?.state === 'confirmed' || view?.state === 'completed'));
        retainDraft(api, draftKey, { ...current, recovery: view, phase: resolved ? 'idle' : current.phase, message: resolved ? '已读取原恢复计划的持久状态。' : current.message });
      })
    ]).then(results => { if (!controller.signal.aborted) { if (results.some(result => result.status === 'rejected')) setError('部分管理证据无法读取，保留原状态；不会按空记录或成功处理。'); setReading(false); } });
    return () => controller.abort();
  }, [api, connected, id, draftKey, readVersion]);
  async function run(action: 'reconcile' | 'preview' | 'commit'): Promise<void> {
    if (!connected || reading || !confirm || state.phase === 'writing' || state.phase === 'unknown' && !(action === 'commit' && (state.originalRevision || (state.recovery ?? readView)?.state === 'unknown' || (state.recovery ?? readView)?.state === 'requested'))) return;
    const revision = action === 'commit' ? state.originalRevision ?? (state.recovery ?? readView)?.revision : undefined;
    if (action === 'commit' && !revision) return;
    setConfirm(false); setError('');
    const pending: State = { ...state, phase: 'writing', action, originalRevision: action === 'commit' ? revision ?? null : state.originalRevision, message: '' };
    retainDraft(api, draftKey, pending);
    try {
      const result = await writeResource(api, action === 'reconcile' ? '/api/chat/executions/reconcile' : `/api/chat/executions/recovery/${action}`, action === 'reconcile' ? { executionId: id, confirm: true } : action === 'preview' ? { executionId: id } : { executionId: id, revision, confirm: true });
      if (retainedDraft(api, draftKey) !== pending) return;
      if (action === 'reconcile') {
        const parsed = parseExecutionReconciliation(result, id); if (!parsed) throw new Error('invalid_execution_reconciliation');
        retainDraft(api, draftKey, { ...state, phase: 'idle', action, result: parsed, message: parsed.state === 'released' ? 'SDK 持久证据已核验，本次隔离已解除。' : '证据不足，保持隔离。' });
      } else {
        const parsed = parseNativeExecutionRecoveryView(result); if (!parsed || parsed.executionId !== id) throw new Error('invalid_execution_recovery');
        retainDraft(api, draftKey, { ...state, phase: parsed.state === 'unknown' ? 'unknown' : 'idle', action, recovery: parsed, originalRevision: action === 'commit' ? revision ?? null : state.originalRevision, message: parsed.state === 'unknown' ? '新会话创建结果未知。只读取或明确核对原 revision，不创建另一份。' : '恢复计划已保存；原请求与迟到结果均不会重发。' });
      }
      setReadVersion(value => value + 1); onRead();
    } catch (error) {
      if (retainedDraft(api, draftKey) !== pending) return;
      const unknown = !(error instanceof ApiError) || error.status >= 500 || /unknown/.test(error.code);
      retainDraft(api, draftKey, { ...state, phase: unknown ? 'unknown' : 'idle', action, originalRevision: action === 'commit' ? revision ?? null : state.originalRevision, message: unknown ? '管理操作结果未知，请按原执行标识读取；不会自动重试。' : `${errorMessage(error)}${error instanceof ApiError && /^execution_[a-z_]+$/.test(error.code) ? `（${error.code}）` : ''}` });
    }
  }
  const recovery = state.recovery ?? readView; const actual = observed ?? entry; const locked = !connected || reading || state.phase === 'writing';
  const persistedRecoveryPending = recovery !== null && ['requested', 'unknown', 'confirmed'].includes(recovery.state);
  const canManage = actual.isolated || actual.status === 'unknown' || actual.cancelStatus === 'unknown' || recovery !== null || state.phase !== 'idle';
  if (!canManage) return null;
  return <div className="grid gap-3 rounded-lg border border-amber-500/30 p-4 text-xs" data-execution-management>
    <strong>执行结果与上下文恢复</strong><p className="text-muted-foreground">核对只观察 SDK 持久证据；新会话恢复保留原上下文记录，旧请求和迟到输出不会重放。这里不答复模型提问或批准工具。</p>
    <Button size="sm" variant="outline" disabled={locked} onClick={() => setReadVersion(value => value + 1)}>读取原执行与恢复结果</Button>
    {state.phase !== 'unknown' && !persistedRecoveryPending && <><label className="flex gap-2"><input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} disabled={locked} />我已核对所选执行，明确进行以下管理操作</label><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={locked || !confirm} onClick={() => void run('reconcile')}>核对执行结果</Button><Button size="sm" variant="outline" disabled={locked || !confirm || recovery !== null} onClick={() => void run('preview')}>预览保留上下文恢复</Button>{recovery?.state === 'available' && <Button size="sm" disabled={locked || !confirm} onClick={() => void run('commit')}>确认创建新的会话地址</Button>}</div></>}
    {(state.phase === 'unknown' && state.action === 'commit' && state.originalRevision || recovery && ['requested', 'unknown', 'confirmed'].includes(recovery.state)) && <><label className="flex gap-2"><input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} disabled={locked} />核对原恢复请求；服务仅观察原 revision，禁止再次创建会话</label><Button size="sm" variant="outline" disabled={locked || !confirm} onClick={() => void run('commit')}>核对原恢复请求</Button></>}
    {recovery && <div className="grid gap-2"><p>恢复状态：{recovery.state} · 第 {recovery.sourceGeneration} 代</p><p className="break-all">原会话：{recovery.sourceSessionId}；新会话：{recovery.childSessionId ?? '尚未核验'}</p><p>恢复计划要求重启聊天，重新建立 QQ 会话与新地址的关联；确认前不会切换当前绑定。</p>{recovery.missingReasons.length > 0 && <p role="status">原因：{recovery.missingReasons.join('、')}</p>}</div>}
    {state.result?.restartRequired && <p>请在连接页明确重启聊天，以建立核验后的会话关联。</p>}
    {state.result && state.result.missingReasons.length > 0 && <p>核对未释放原因：{state.result.missingReasons.join('、')}</p>}
    {(state.message || error) && <p role="status">{state.message} {error}</p>}
  </div>;
}
