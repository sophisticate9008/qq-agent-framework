import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { applyAndStartChat, chatApplicationPhaseLabels, chatApplicationStore } from '../lib/chat-application.ts';
import { chatRuntimeReason, parseChatRuntimeStatus } from '../lib/chat-runtime.ts';
import { Button } from './ui/button.tsx';

export function SessionMigrationControl({ api, connected = true, disabled, onComplete }: {
  readonly api: ApiClient;
  readonly connected?: boolean;
  readonly disabled: boolean;
  readonly onComplete: () => void;
}) {
  const application = chatApplicationStore(api);
  const state = useSyncExternalStore(application.subscribe, application.getSnapshot, application.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const owner = useRef({ api, connected, disabled });
  owner.current = { api, connected, disabled };
  const complete = useRef(onComplete);
  complete.current = onComplete;
  useEffect(() => {
    epoch.current++; setBusy(false); setMessage('');
    return () => { epoch.current++; request.current?.abort(); request.current = null; };
  }, [api, connected]);

  async function apply(): Promise<void> {
    if (request.current || busy || application.getSnapshot().busy || owner.current.api !== api || !owner.current.connected
      || disabled && !application.getSnapshot().blocked) return;
    const controller = new AbortController();
    const generation = epoch.current;
    request.current = controller;
    const current = () => !controller.signal.aborted && owner.current.api === api && owner.current.connected
      && generation === epoch.current && request.current === controller;
    setBusy(true); setMessage('正在核对当前状态…');
    try {
      if (application.getSnapshot().blocked) {
        const status = parseChatRuntimeStatus(await api.get('/api/chat/runtime', controller.signal));
        if (!current()) return;
        setMessage(status ? `当前聊天${status.chatReady ? '已就绪' : '尚未就绪'}；先前操作结果仍需核对，不会重新提交。` : '状态无法确认，不会重新提交。');
        return;
      }
      const result = await applyAndStartChat({ api, signal: controller.signal, deploy: false,
        isCurrent: () => current() && !owner.current.disabled,
        onPhase: phase => { if (current()) setMessage(chatApplicationPhaseLabels[phase]); } });
      if (!current()) return;
      setMessage(result.state === 'running' ? '已保留上下文并启动聊天。' : result.reasons.map(reason => chatRuntimeReason(reason).text).join(' ') || '当前检查尚未通过。');
      complete.current();
    } catch (failure) {
      if (current()) setMessage(`${failure instanceof Error ? failure.message : errorMessage(failure)} 不会自动重试或清空会话。`);
    } finally {
      if (current()) { request.current = null; setBusy(false); }
    }
  }

  return <details className="mt-4 rounded-lg border bg-muted/20 p-3"><summary className="cursor-pointer text-xs text-muted-foreground">高级：会话衔接与状态核对</summary><div className="mt-3 grid max-h-48 gap-2 overflow-auto">
    <p className="text-xs leading-5 text-muted-foreground">日常修改请在伙伴页保存后点击“应用并启动／更新聊天”。这里复用相同的会话衔接与启动检查，不清除上下文。</p>
    <Button variant="outline" size="sm" className="field-label justify-self-start" disabled={!connected || busy || state.busy || disabled && !state.blocked} onClick={() => void apply()}>
      <RefreshCw className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} />{busy ? '正在处理' : state.blocked ? '查看当前状态' : '保留上下文并启动'}
    </Button>
    {message && <p role="status" className="text-xs leading-5 text-muted-foreground">{message}</p>}
  </div></details>;
}
