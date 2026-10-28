import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { parsePluginSessionSnapshot } from '../../src/contracts/plugin-sessions.ts';
import { pluginModelIdentifier } from '../../src/contracts/plugin-model.ts';
import { ApiError, errorMessage, isRecord, type ApiClient } from '../lib/api.ts';
import { describeConversationKey } from '../lib/activity.ts';
import { hasSessionResetTarget, type ManagedSession } from '../lib/session-management.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx';

type WriteState = 'idle' | 'saving' | 'error' | 'conflict' | 'unknown';
function bindError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'session_bind_conflict') return 'QQ 会话绑定已变化，请刷新后重新选择。';
    if (error.code === 'session_bind_busy') return '当前会话或目标会话正在处理消息，请结束后再操作。';
    if (error.code === 'session_bind_execution_unsettled') return '会话仍有未确认的执行，请先核对状态。';
    if (/target_occupied/.test(error.code)) return '目标会话已有其他 QQ 会话使用，请选择其他模型会话。';
    if (/target_owned/.test(error.code)) return '目标会话的历史属于其他 QQ 会话，请选择独立会话或插件会话。';
    if (/not_found/.test(error.code)) return '目标模型会话不存在，请核对完整会话 ID。';
  }
  return errorMessage(error);
}
export function SessionBindDialog({ api, connected, target, onClose, onBound }: {
  readonly api: ApiClient;
  readonly connected: boolean;
  readonly target: ManagedSession | null;
  readonly onClose: () => void;
  readonly onBound: () => void;
}) {
  const controller = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const [state, setState] = useState<WriteState>('idle');
  const [error, setError] = useState('');
  const [source, setSource] = useState<'id' | 'plugin'>('id');
  const [sessionId, setSessionId] = useState('');
  const plugins = useReadResource(api, '/api/chat/plugin-sessions', connected && target !== null, parsePluginSessionSnapshot);
  const choices = new Map<string, string>();
  for (const row of plugins.snapshot?.bindings ?? []) {
    if (row.state === 'ready' && !row.busy && row.sessionId !== target?.sessionId) {
      const label = `${row.owner} / ${row.name}`;
      choices.set(row.sessionId, choices.has(row.sessionId) ? `${choices.get(row.sessionId)}、${label}` : label);
    }
  }
  useEffect(() => {
    epoch.current++;
    controller.current?.abort(); controller.current = null;
    setState('idle'); setError(''); setSource('id'); setSessionId('');
    return () => { epoch.current++; controller.current?.abort(); };
  }, [api, connected, target]);
  const locked = state === 'saving' || state === 'conflict' || state === 'unknown';
  function close() {
    if (state === 'saving') return;
    if (state === 'conflict' || state === 'unknown') onBound();
    onClose();
  }
  async function bind() {
    if (!target || !hasSessionResetTarget(target) || !pluginModelIdentifier(sessionId) || !connected || locked || controller.current) return;
    if (source === 'plugin' && (plugins.error || !choices.has(sessionId))) { setState('error'); setError('插件会话列表已变化，请重新选择。'); return; }
    const currentController = new AbortController();
    const generation = epoch.current;
    controller.current = currentController;
    const live = () => !currentController.signal.aborted && generation === epoch.current && controller.current === currentController
      && connection.current.api === api && connection.current.connected;
    setState('saving'); setError('');
    try {
      const result = await writeResource(api, '/api/chat/sessions/bind', {
        key: target.key, sessionId: target.sessionId, generation: target.generation,
        bindingRevision: target.bindingRevision, targetSessionId: sessionId, confirm: true,
      }, currentController.signal);
      if (!live()) return;
      if (!isRecord(result) || result.ok !== true || result.key !== target.key || result.previousSessionId !== target.sessionId
        || result.previousGeneration !== target.generation || result.sessionId !== sessionId || result.historyPreserved !== true
        || result.contextReset !== false || typeof result.generation !== 'number' || !Number.isSafeInteger(result.generation)
        || result.bindingChanged !== (sessionId !== target.sessionId)
        || result.generation !== target.generation + (result.bindingChanged ? 1 : 0) || result.nextGeneration !== result.generation
        || typeof result.bindingRevision !== 'string' || !/^[a-f0-9]{64}$/.test(result.bindingRevision)
        || typeof result.bindingChanged !== 'boolean') throw new ApiError('session_bind_unknown', 504);
      setState('idle'); onBound(); onClose(); toast.success('已更换 QQ 会话绑定，原有历史保留。');
    } catch (failure) {
      if (!live()) return;
      if (failure instanceof ApiError && failure.status === 409) { setState('conflict'); setError(bindError(failure)); }
      else if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) { setState('error'); setError(bindError(failure)); }
      else { setState('unknown'); setError(`尚未确认绑定是否更换，请关闭弹窗并刷新核对。${bindError(failure)}`); }
    } finally { if (controller.current === currentController) controller.current = null; }
  }
  return <Dialog open={target !== null} onOpenChange={open => { if (!open) close(); }}><DialogContent showCloseButton={state !== 'saving'}><DialogHeader><DialogTitle>更换 QQ 会话绑定</DialogTitle><DialogDescription>将当前 QQ 会话连接到一个已有模型会话，后续聊天使用目标会话的上下文。原模型历史保留。</DialogDescription></DialogHeader>
    {target && <div className="grid gap-3 text-xs"><div className="rounded border bg-muted/20 p-2 leading-6"><strong>{describeConversationKey(target.key).label} {describeConversationKey(target.key).identifier}</strong><p className="break-all text-muted-foreground">当前会话：{target.sessionId}</p></div><div className="flex gap-2"><Button size="sm" variant={source === 'id' ? 'secondary' : 'outline'} disabled={locked} onClick={() => { setSource('id'); setSessionId(''); }}>输入会话 ID</Button><Button size="sm" variant={source === 'plugin' ? 'secondary' : 'outline'} disabled={locked} onClick={() => { setSource('plugin'); setSessionId(''); }}>选择插件会话</Button></div>
      {source === 'id' ? <label className="grid gap-1">目标 DSH 会话 ID<Input value={sessionId} maxLength={256} disabled={locked} onChange={event => setSessionId(event.target.value)} placeholder="输入完整模型会话 ID" /></label> : <label className="grid gap-1">插件现有会话<select className="h-[27px] min-w-0 rounded border border-input bg-background px-2 text-xs" value={sessionId} disabled={locked || plugins.loading || Boolean(plugins.error)} onChange={event => setSessionId(event.target.value)}><option value="">选择一个已就绪的插件会话</option>{[...choices].map(([id, label]) => <option key={id} value={id}>{label} · {id.slice(-10)}</option>)}</select>{plugins.loading && <span className="text-muted-foreground">正在读取插件会话…</span>}{plugins.error && <span role="alert" className="text-destructive">插件会话读取失败，可重试或直接输入会话 ID。<Button size="sm" variant="ghost" onClick={plugins.refresh}>重试读取</Button></span>}</label>}
      <p className="text-muted-foreground">插件可与当前 QQ 共享此模型会话；绑定范围由宿主核对，其他 QQ 会话的历史保持独立。</p></div>}
    {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={state === 'saving'} onClick={close}>{state === 'conflict' || state === 'unknown' ? '关闭并刷新' : '取消'}</Button><Button disabled={locked || !target || !hasSessionResetTarget(target) || !pluginModelIdentifier(sessionId) || !connected || source === 'plugin' && Boolean(plugins.error)} onClick={() => void bind()}>{state === 'saving' && <LoaderCircle className="size-3.5 animate-spin" />}{state === 'saving' ? '正在更换' : '确认更换绑定'}</Button></DialogFooter></DialogContent></Dialog>;
}
