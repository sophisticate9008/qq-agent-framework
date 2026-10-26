import { useEffect, useRef, useState } from 'react';
import { parseNativeDshRestartSnapshot, type NativeDshRestartSnapshot } from '../../src/contracts/native-dsh-restart.ts';
import { Button } from './ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx';
import { Input } from './ui/input.tsx';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { ApiError, type ApiClient } from '../lib/api.ts';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { describeConversationKey } from '../lib/activity.ts';
import { hasSessionResetTarget, type ManagedSession } from '../lib/session-management.ts';

export function SessionDeleteDialog({ api, target, onClose, onDeleted }: {
  readonly api: ApiClient; readonly target: ManagedSession | null; readonly onClose: () => void; readonly onDeleted: () => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [operationId, setOperationId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<NativeDshRestartSnapshot | null>(null);
  const [error, setError] = useState(''); const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const owner = useRef({ api, target }); owner.current = { api, target };
  const write = useRef<AbortController | null>(null);
  useEffect(() => {
    setConfirmation(''); setOperationId(null); setSnapshot(null); setError(''); setCode(''); setSending(false);
    return () => { write.current?.abort(); write.current = null; };
  }, [api, target]);
  useEffect(() => {
    if (!operationId || !target) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = parseNativeDshRestartSnapshot(await readResource(api, `/api/chat/dsh/restart?id=${encodeURIComponent(operationId)}`, controller.signal));
        if (controller.signal.aborted) return;
        if (!result || result.operation?.id !== operationId) { setError('还没有查到这次操作的结果，请保留操作编号。'); }
        else {
          setSnapshot(result); setError('');
          if (result.operation.state === 'completed') return;
          if (result.operation.state !== 'running') return;
        }
      } catch { if (!controller.signal.aborted) setError('暂时无法更新删除进度，未重复提交。'); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [api, operationId, target, pollVersion]);
  async function submit() {
    if (!target || !hasSessionResetTarget(target) || confirmation !== '删除会话' || sending || operationId) return;
    const id = crypto.randomUUID(); const controller = new AbortController(); write.current = controller;
    setSending(true); setError('');
    try {
      const result = parseNativeDshRestartSnapshot(await writeResource(api, '/api/chat/sessions/delete', {
        operationId: id, confirm: '删除会话', target: { key: target.key, sessionId: target.sessionId, generation: target.generation, bindingRevision: target.bindingRevision },
      }, controller.signal));
      if (owner.current.api !== api || owner.current.target !== target || controller.signal.aborted) return;
      if (!result || result.operation?.id !== id) throw new Error('unknown_result');
      setSnapshot(result); setOperationId(id);
    } catch (error) {
      if (owner.current.api !== api || owner.current.target !== target || controller.signal.aborted) return;
      const reason = error instanceof ApiError ? error.code : 'session_delete_unknown'; setCode(reason);
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        setError(/BUSY|UNSETTLED|busy|unsettled/.test(reason) ? '还有任务未结束，请等处理完成后再删除。' : /NOT_FOUND|not_found/.test(reason) ? '模型会话已不存在，请刷新后核对绑定。' : '会话状态已变化或维护尚未结束，请刷新后核对。');
      } else { setOperationId(id); setError('删除结果暂未确认，正在查询这次操作；不会重复删除。'); }
    } finally { if (owner.current.api === api && owner.current.target === target) setSending(false); }
  }
  async function reconcile() {
    if (!operationId || checking) return;
    setChecking(true);
    try {
      const result = parseNativeDshRestartSnapshot(await writeResource(api, '/api/chat/dsh/restart/reconcile', { operationId }));
      if (owner.current.api !== api || owner.current.target !== target) return;
      if (result) { setSnapshot(result); setPollVersion(value => value + 1); }
    } catch { if (owner.current.api === api && owner.current.target === target) setError('尚未确认完成，请查看维护详情。'); }
    finally { if (owner.current.api === api && owner.current.target === target) setChecking(false); }
  }
  const operation = snapshot?.operation;
  const phase = operation?.phase ? { stop: '正在暂停聊天', restart: '正在删除模型会话并重启服务', verify: '正在确认删除结果', restore: '正在恢复聊天' }[operation.phase] : '准备删除';
  return <Dialog open={target !== null} onOpenChange={open => { if (!open && !sending && !operationId) onClose(); }}>
    <DialogContent showCloseButton={!sending && !operationId} className="sm:max-w-lg">
      <DialogHeader><DialogTitle>{operation?.state === 'completed' ? '会话已删除' : '删除这段聊天历史？'}</DialogTitle>
        <DialogDescription>删除所选模型会话的历史、框架短期上下文和当前绑定。QQ 消息、用量账本和操作记录保留。删除期间模型服务会短暂停止，随后恢复；其他会话的历史与绑定保留。</DialogDescription></DialogHeader>
      {target && <p className="font-medium">{describeConversationKey(target.key).label} {describeConversationKey(target.key).identifier}</p>}
      {!operationId && <Input aria-label="输入删除会话确认" placeholder="输入“删除会话”确认" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={sending} />}
      {operation && <p role="status">{operation.state === 'completed' ? '删除完成。下次聊天将建立新对话。' : operation.state === 'running' ? phase : '操作尚未完成，需要核对维护结果。'}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {(operationId || code) && <ReadOnlyDetails title="删除操作详情" description="保留此编号可查询同一次操作。"><TechnicalDetails fields={[{ label: '操作编号', value: operationId }, { label: '技术原因', value: operation?.reasons ?? code }, { label: '处理阶段', value: operation?.phase }]} /></ReadOnlyDetails>}
      <DialogFooter>{operationId ? <>
        {operation?.state === 'unknown' && <Button variant="outline" disabled={checking} onClick={() => void reconcile()}>{checking ? '正在核对' : '核对并恢复'}</Button>}
        <Button onClick={() => { onClose(); onDeleted(); }}>{operation?.state === 'completed' ? '完成' : '关闭并刷新'}</Button>
      </> : <><Button variant="outline" disabled={sending} onClick={onClose}>取消</Button><Button variant="destructive" disabled={sending || confirmation !== '删除会话'} onClick={() => void submit()}>{sending ? '正在提交' : '确认删除'}</Button></>}</DialogFooter>
    </DialogContent>
  </Dialog>;
}
