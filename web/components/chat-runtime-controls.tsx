import { useEffect, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { chatRuntimeBadge, chatRuntimeReason, chatRuntimeVisibleReasons, parseChatRuntimeStatus, type ChatRuntimeStatus } from '../lib/chat-runtime.ts';
import type { PageId } from '../lib/types.ts';
import { Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';

export function ChatRuntimeControls({ api, connected, dirty, navigate, onRunningChange }: {
  readonly api: ApiClient; readonly connected: boolean; readonly dirty: boolean; navigate(page: PageId): void;
  onRunningChange?(running: boolean): void;
}) {
  const [status, setStatus] = useState<ChatRuntimeStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<'start' | 'stop' | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const active = action !== null || status?.state === 'starting' || status?.state === 'stopping';
  const running = status?.state === 'running';
  const visibleReasons = status ? chatRuntimeVisibleReasons(status) : [];
  useEffect(() => { onRunningChange?.(running || active); }, [running, active, onRunningChange]);

  useEffect(() => {
    const controller = new AbortController();
    epoch.current++;
    setAction(null);
    setStatus(null);
    setError('');
    setLoading(connected);
    setUncertain(false);
    if (!connected) return () => controller.abort();
    let pending = false;
    const read = async (): Promise<void> => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      const generation = epoch.current;
      try {
        const next = parseChatRuntimeStatus(await api.get('/api/chat/runtime', controller.signal));
        if (!next) throw new Error('invalid_chat_runtime');
        if (!controller.signal.aborted && generation === epoch.current) { setStatus(next); setError(''); }
      } catch (failure) {
        if (!controller.signal.aborted && generation === epoch.current) setError(errorMessage(failure));
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void read();
    const timer = setInterval(() => { if (request.current === null) void read(); }, 5000);
    return () => { clearInterval(timer); controller.abort(); request.current?.abort(); request.current = null; };
  }, [api, connected, reload]);

  async function control(operation: 'start' | 'stop'): Promise<void> {
    if (!status || active || uncertain || operation === 'start' && dirty || loading || request.current) return;
    epoch.current++;
    const controller = new AbortController();
    request.current = controller;
    setAction(operation);
    setError('');
    try {
      await api.post(`/api/chat/runtime/${operation}`, operation === 'start' ? { revisions: status.revisions } : {}, controller.signal);
      const next = parseChatRuntimeStatus(await api.get('/api/chat/runtime', controller.signal));
      if (!next) throw new Error('invalid_chat_runtime');
      if (!controller.signal.aborted) setStatus(next);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(`${errorMessage(failure)} 请重新检查状态，不会自动重复操作。`);
        setUncertain(true);
      }
    } finally {
      if (!controller.signal.aborted) setAction(null);
      if (request.current === controller) request.current = null;
    }
  }

  if (!connected) return null;
  return <Section id="chat-runtime" scrollable height="sm" title="聊天运行" description="确认设置已应用后再启动。保存配置、连接协议与启动聊天是不同操作。"
    actions={<StatusPill tone={status?.chatReady ? 'success' : 'warning'}>{active ? '正在处理' : chatRuntimeBadge(status)}</StatusPill>}
    footer={<><span className="mr-auto text-xs text-muted-foreground">{dirty ? '请先保存连接设置。' : uncertain ? '操作结果待确认，请先重新检查。' : status?.configurationChanged ? '有新的已保存设置；停止后重新启动才会生效。' : '不会自动启动，也不会清空会话。'}</span>
      <Button variant="outline" disabled={active || loading} onClick={() => setReload(value => value + 1)}><RefreshCw className="size-3.5" />重新检查</Button>
      {running ? <Button variant="outline" disabled={active || uncertain || loading} onClick={() => void control('stop')}><Square className="size-3.5" />停止聊天</Button>
        : <Button disabled={!status?.canStart || active || uncertain || dirty || loading} onClick={() => void control('start')}><Play className="size-3.5" />启动聊天</Button>}</>}>
    {loading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在检查聊天条件</p>}
    {error && <p role="alert" className="mb-3 flex items-start gap-2 text-xs leading-6 text-destructive"><CircleAlert className="mt-1 size-4 shrink-0" />{error}</p>}
    {status && <>
      <dl className="grid grid-cols-2 gap-4 text-xs"><div><dt className="text-muted-foreground">消息连接</dt><dd className="mt-2 font-medium">{status.protocolConnected ? '已连接' : '未连接'}</dd></div><div><dt className="text-muted-foreground">聊天处理</dt><dd className="mt-2 font-medium">{status.chatReady ? '已启用' : running ? '暂不可用' : '未启动'}</dd></div></dl>
      {visibleReasons.length > 0 ? <ul className="mt-4 grid gap-2 border-t pt-3">{visibleReasons.map(reason => {
        const item = chatRuntimeReason(reason);
        return <li key={reason} className="flex items-start justify-between gap-3 text-xs leading-5"><span>{item.text}</span><Button variant="ghost" size="sm" onClick={() => navigate(item.page)}>去设置</Button></li>;
      })}</ul> : <p className="mt-4 border-t pt-3 text-xs leading-6 text-muted-foreground">{status.chatReady ? '正在处理已授权的会话；停止聊天会保留历史与发送记录。' : running ? '聊天处理暂不可用，请重新检查当前状态。' : '本地配置检查通过。点击启动后还会验证协议账号与 DSH 连接，验证通过才接收消息。'}</p>}
      {status.modelExecutionVerified === false && <p className="mt-3 text-xs leading-5 text-muted-foreground">当前就绪检查不验证真实模型调用，模型服务与凭据是否可用仍以实际消息结果为准。</p>}
      {status.lastError && <p role="alert" className="mt-3 text-xs leading-5 text-destructive">上次启动或运行未完成，请核对连接与设置后重新检查。</p>}
    </>}
  </Section>;
}
