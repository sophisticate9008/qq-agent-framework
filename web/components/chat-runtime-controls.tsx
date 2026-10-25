import { useChatApplication } from '../lib/use-chat-application.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { chatRuntimeBadge, chatRuntimeCanApplyAndStart, chatRuntimeLastError, chatRuntimeNeedsSessionMigration, chatRuntimeReason, chatRuntimeVisibleReasons, parseChatRuntimeStatus, type ChatRuntimeStatus } from '../lib/chat-runtime.ts';
import { applyAndStartChat, chatApplicationPhaseLabels } from '../lib/chat-application.ts';
import type { PageProps } from '../lib/types.ts';
import { Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';
import { SessionMigrationControl } from './session-migration-control.tsx';

export function ChatRuntimeControls({ api, connected, dirty, navigate, onRunningChange, connectionPanel }: {
  readonly api: ApiClient; readonly connected: boolean; readonly dirty: boolean; readonly navigate: PageProps['navigate'];
  onRunningChange?(running: boolean): void; readonly connectionPanel?: ReactNode;
}) {
  const { application, state: applicationState, observationError, refresh: refreshApplication } = useChatApplication(api, connected);
  const [status, setStatus] = useState<ChatRuntimeStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<'start' | 'stop' | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const request = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const connection = useRef({ api, connected, dirty });
  connection.current = { api, connected, dirty };
  const resource = useReadResource(api, '/api/chat/runtime', connected, parseChatRuntimeStatus, { intervalMs: 5_000,
    pollWhen: () => request.current === null && !application.getSnapshot().busy });
  const active = action !== null || status?.state === 'starting' || status?.state === 'stopping';
  const running = status?.state === 'running';
  const visibleReasons = status ? chatRuntimeVisibleReasons(status) : [];
  const applyBeforeStart = status ? chatRuntimeCanApplyAndStart(status) : false;
  useEffect(() => { onRunningChange?.(running || active); }, [running, active, onRunningChange]);

  useEffect(() => {
    epoch.current++;
    setAction(null); setStatus(null); setError(''); setUncertain(false);
    return () => { epoch.current++; request.current?.abort(); request.current = null; };
  }, [api, connected]);
  useEffect(() => {
    setLoading(resource.loading);
    if (request.current === null) {
      if (resource.snapshot) { setStatus(resource.snapshot); if (!resource.error) setUncertain(false); }
      setError(resource.error ? errorMessage(resource.error) : '');
    }
  }, [resource.snapshot, resource.loading, resource.error]);

  async function control(operation: 'start' | 'stop'): Promise<void> {
    if (!status || active || uncertain || operation === 'start' && dirty || loading || request.current
      || application.getSnapshot().busy || application.getSnapshot().blocked || connection.current.api !== api || !connection.current.connected) return;
    epoch.current++;
    const controller = new AbortController();
    request.current = controller;
    const generation = epoch.current;
    const current = () => !controller.signal.aborted && request.current === controller && generation === epoch.current
      && connection.current.api === api && connection.current.connected;
    const sharedOwner = operation === 'stop' ? application.claim() : null;
    const abort = () => { if (sharedOwner && application.owns(sharedOwner)) application.freeze(); };
    controller.signal.addEventListener('abort', abort, { once: true });
    setAction(operation);
    setError(''); setNotice('');
    try {
      if (operation === 'start') {
        const result = await applyAndStartChat({ api, signal: controller.signal, deploy: applyBeforeStart, expectedRevisions: status.revisions,
          isCurrent: () => current() && !connection.current.dirty,
          onPhase: phase => { if (current()) setNotice(chatApplicationPhaseLabels[phase]); } });
        if (!current()) return;
        setStatus(result.runtime);
        setNotice(result.state === 'running' ? '聊天已启动，原有上下文保留。' : '检查未通过，已停止后续操作。');
        setError(result.state === 'running' ? '' : result.reasons.map(reason => chatRuntimeReason(reason).text).join(' '));
        return;
      }
      await writeResource(api, '/api/chat/runtime/stop', {}, controller.signal);
      if (!current()) return;
      const next = parseChatRuntimeStatus(await readResource(api, '/api/chat/runtime', controller.signal));
      if (!current()) return;
      if (!next) throw new Error('invalid_chat_runtime');
      setStatus(next);
    } catch (failure) {
      if (current()) {
        if (sharedOwner) application.freeze();
        setError(`${errorMessage(failure)} 请重新检查状态，不会自动重复操作。`);
        setUncertain(true);
      }
    } finally {
      if (current()) setAction(null);
      if (request.current === controller) request.current = null;
      if (sharedOwner) application.release(sharedOwner);
      controller.signal.removeEventListener('abort', abort);
    }
  }

  if (!connected) return null;
  return <Section id="chat-runtime" scrollable height={connectionPanel ? "lg" : "sm"} title="聊天运行" description="确认设置已应用后再启动聊天。WebSocket 可自动连接；聊天模型仍需单独启停。"
    actions={<StatusPill tone={status?.chatReady && !resource.error ? 'success' : 'warning'}>{active ? '正在处理' : resource.error ? '运行状态待确认' : chatRuntimeBadge(status)}</StatusPill>}
    footer={<><span className="mr-auto text-xs text-muted-foreground">{dirty ? '请先保存连接设置。' : uncertain ? '操作结果待确认，请先重新检查。' : status?.configurationChanged ? '有新的已保存设置；停止后重新启动才会生效。' : '不会自动启动，也不会清空会话。'}</span>
      <Button variant="outline" disabled={active || loading} onClick={() => { resource.refresh(); refreshApplication(); }}><RefreshCw className="size-3.5" />重新检查</Button>
      {running || status?.state === 'error' ? <Button variant="outline" disabled={active || uncertain || loading || applicationState.busy || applicationState.blocked} onClick={() => void control('stop')}><Square className="size-3.5" />停止聊天</Button>
        : <span role="group" aria-label="启动聊天" data-page-field><Button id="chat-runtime-start" disabled={!status?.canStart && !applyBeforeStart || active || uncertain || dirty || loading || applicationState.busy || applicationState.blocked} onClick={() => void control('start')}><Play className="size-3.5" />{applyBeforeStart ? '应用并启动' : '启动聊天'}</Button></span>}</>}>
    {observationError && <p role="status" className="mb-3 text-xs text-muted-foreground">暂时无法读取应用操作；后台阶段不会因此重复执行，请重新检查。</p>}
    {notice && <p role="status" className="mb-3 text-xs leading-6 text-muted-foreground">{notice}</p>}
    {loading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在检查聊天条件</p>}
    {error && <p role="alert" className="mb-3 flex items-start gap-2 text-xs leading-6 text-destructive"><CircleAlert className="mt-1 size-4 shrink-0" />{error}</p>}
    {status && <>
      <dl className="grid grid-cols-3 gap-4 text-xs"><div><dt className="text-muted-foreground">QQ 消息连接</dt><dd className="mt-2 font-medium">{status.protocolConnected ? '已连接' : '未连接'}</dd></div><div><dt className="text-muted-foreground">DSH 模型执行</dt><dd className="mt-2 font-medium">{status.modelExecutionVerified === true ? '已核验' : '待实际调用核验'}</dd></div><div><dt className="text-muted-foreground">聊天处理</dt><dd className="mt-2 font-medium">{status.chatReady ? '已启用' : running ? '暂不可用' : '未启动'}</dd></div></dl>
      {visibleReasons.length > 0 ? <ul className="mt-4 grid gap-2 border-t pt-3">{visibleReasons.map(reason => {
        const item = chatRuntimeReason(reason);
        return <li key={reason} className="flex items-start justify-between gap-3 text-xs leading-5"><span>{item.text}</span><Button variant="ghost" size="sm" onClick={() => navigate(item.page, item.target)}>去设置</Button></li>;
      })}</ul> : <p className="mt-4 border-t pt-3 text-xs leading-6 text-muted-foreground">{status.chatReady ? '正在处理已授权的会话；停止聊天会保留历史与发送记录。' : running ? '聊天处理暂不可用，请重新检查当前状态。' : '本地配置检查通过。点击启动后还会验证协议账号与 DSH 连接，验证通过才接收消息。'}</p>}
      {status.state === 'stopped' && chatRuntimeNeedsSessionMigration(status)
        && <SessionMigrationControl api={api} connected={connected} disabled={dirty || active || uncertain || loading} onComplete={() => resource.refresh()} />}
      {applicationState.blocked && <p role="status" className="mt-3 text-xs text-muted-foreground">先前应用或启动结果尚未确认，已停止后续操作；重新检查只读取状态，不会重试。</p>}
      {status.modelExecutionVerified === false && <p className="mt-3 text-xs leading-5 text-muted-foreground">当前就绪检查不验证真实模型调用，模型服务与凭据是否可用仍以实际消息结果为准。</p>}
      {status.lastError && <p role="alert" className="mt-3 text-xs leading-5 text-destructive">{chatRuntimeLastError(status.lastError)}</p>}
    </>}
    {connectionPanel}
  </Section>;
}
