import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { chatApplicationStore } from '../lib/chat-application.ts';
import { parseChatRuntimeStatus } from '../lib/chat-runtime.ts';
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

  async function observe(): Promise<void> {
    if (request.current || busy || application.getSnapshot().busy || owner.current.api !== api || !owner.current.connected
      || !application.getSnapshot().blocked) return;
    const controller = new AbortController();
    const generation = epoch.current;
    request.current = controller;
    const current = () => !controller.signal.aborted && owner.current.api === api && owner.current.connected
      && generation === epoch.current && request.current === controller;
    setBusy(true); setMessage('正在核对当前状态…');
    try {
      const status = parseChatRuntimeStatus(await api.get('/api/chat/runtime', controller.signal));
      if (!current()) return;
      setMessage(status ? `当前聊天${status.chatReady ? '已就绪' : '尚未就绪'}；先前操作结果仍需核对，不会重新提交。` : '状态无法确认，不会重新提交。');
      complete.current();
    } catch (failure) {
      if (current()) setMessage(`${errorMessage(failure)} 请重新核对状态。`);
    } finally {
      if (current()) { request.current = null; setBusy(false); }
    }
  }

  if (!state.blocked) return null;
  return <div className="mt-2 flex flex-wrap items-center gap-2 rounded bg-amber-500/10 px-2 py-1.5 text-xs">
    <span>先前启动结果待核对。</span>
    <Button variant="outline" size="sm" disabled={!connected || busy || state.busy} onClick={() => void observe()}>
      <RefreshCw className={busy ? 'size-3 animate-spin' : 'size-3'} />{busy ? '正在读取' : '查看当前状态'}
    </Button>
    {message && <span role="status" className="text-muted-foreground">{message}</span>}
  </div>;
}
