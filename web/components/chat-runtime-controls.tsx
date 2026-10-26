import { useChatApplication } from '../lib/use-chat-application.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { chatRuntimeBadge, chatRuntimeCanApplyAndStart, chatRuntimeCanRecoverStoppedControl, chatRuntimeEngineReadiness, chatRuntimeLastError, chatRuntimeNeedsSessionMigration, chatRuntimeReason, chatRuntimeVisibleReasons, parseChatRuntimeStatus, type ChatRuntimeStatus } from '../lib/chat-runtime.ts';
import { applyAndStartChat, chatApplicationPhaseLabels } from '../lib/chat-application.ts';
import type { PageProps } from '../lib/types.ts';
import { StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';
import { SessionMigrationControl } from './session-migration-control.tsx';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { SettingsWindow } from './settings-window.tsx';
import { useDshRestart } from '../lib/use-dsh-restart.ts';

export function ChatRuntimeControls({ api, connected, dirty, navigate, onRunningChange, connectionPanel, compact = false }: {
  readonly api: ApiClient; readonly connected: boolean; readonly dirty: boolean; readonly navigate: PageProps['navigate'];
  onRunningChange?(running: boolean): void; readonly connectionPanel?: ReactNode; readonly compact?: boolean;
}) {
  const { application, state: applicationState, observationError, refresh: refreshApplication } = useChatApplication(api, connected);
  const restart = useDshRestart(api, connected);
  const [status, setStatus] = useState<ChatRuntimeStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<'start' | 'stop' | 'restore' | null>(null);
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
    if (!status || active || uncertain || restart.pending || operation === 'start' && dirty || loading || request.current
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

  async function restoreStoppedControls(): Promise<void> {
    const state = application.getSnapshot();
    if (!connected || request.current || restart.pending || state.busy || state.reconciling || state.kind !== 'manual'
      || state.manualSource !== 'runtime' || !state.blocked) return;
    const controller = new AbortController();
    const generation = epoch.current;
    request.current = controller;
    const current = () => !controller.signal.aborted && request.current === controller && epoch.current === generation
      && connection.current.api === api && connection.current.connected;
    setAction('restore'); setError('');
    try {
      const value = await api.get('/api/chat/runtime', controller.signal);
      if (!current()) return;
      const next = parseChatRuntimeStatus(value);
      if (!next || !chatRuntimeCanRecoverStoppedControl(value)) {
        setError('尚未确认聊天已停止并排空，保护仍保留；可重新恢复操作，不会重复启停。');
        return;
      }
      const proof = application.reviewManual('runtime');
      if (!proof || !application.acknowledgeManual(proof, 'runtime')) throw new Error('runtime_recovery_changed');
      setStatus(next); setUncertain(false); setNotice('已确认聊天停止且没有待排空操作，管理操作已恢复；会话记录保留。');
    } catch (failure) { if (current()) setError(`${errorMessage(failure)} 恢复入口仍可重试。`); }
    finally {
      if (request.current === controller) { request.current = null; setAction(null); }
    }
  }

  if (!connected) return null;
  const refreshControl = <Button variant="ghost" size="sm" disabled={active} onClick={() => { resource.refresh(); refreshApplication(); }}><RefreshCw className="size-3.5" />刷新状态</Button>;
  const statusTone = status?.chatReady && !resource.error ? 'success' : uncertain || resource.error || applicationState.blocked ? 'warning' : 'neutral';
  const statusLabel = active ? '正在处理' : resource.error ? '运行状态待确认' : chatRuntimeBadge(status);
  const controlButton = running || status?.state === 'error'
    ? <Button variant="outline" disabled={active || uncertain || restart.pending || loading || applicationState.busy || applicationState.blocked} onClick={() => void control('stop')}><Square className="size-3.5" />停止聊天</Button>
    : <span role="group" aria-label="启动聊天" data-page-field><Button id="chat-runtime-start" disabled={!status?.canStart && !applyBeforeStart || active || uncertain || restart.pending || dirty || loading || applicationState.busy || applicationState.blocked} onClick={() => void control('start')}><Play className="size-3.5" />{applyBeforeStart ? '应用并启动' : '启动聊天'}</Button></span>;
  const recovery = <>
    {applicationState.kind === 'manual' && applicationState.manualSource === 'runtime' && applicationState.blocked && <div className="strip warn stack" data-runtime-control-recovery><p>先前启停请求没有确认结果。恢复只读取实际停止与排空状态，不重复启停。</p><Button size="sm" variant="outline" className="justify-self-start" disabled={request.current !== null || restart.pending || applicationState.busy || applicationState.reconciling} onClick={() => void restoreStoppedControls()}>恢复操作</Button></div>}
    {applicationState.blocked && <p role="status" className="small muted">先前应用或启动结果尚未确认，后续操作暂时锁定；刷新只读取状态。</p>}
  </>;
  const checks = <>
    {status && <dl className="info"><dt>QQ 消息</dt><dd>{status.protocolConnected ? '已连接' : '未连接'}</dd><dt>DSH</dt><dd>{chatRuntimeEngineReadiness(status)}</dd><dt>聊天处理</dt><dd>{status.chatReady ? '已启用' : running ? '暂不可用' : '未启动'}</dd></dl>}
    {visibleReasons.length > 0 && <ul className="stack">{visibleReasons.map(reason => {
      const item = chatRuntimeReason(reason);
      return <li key={reason} className="row"><span className="grow text-xs">{item.text}</span><Button variant="ghost" size="sm" onClick={() => navigate(item.page, item.target)}>去设置</Button></li>;
    })}</ul>}
  </>;
  const controlBody = <div className="stack">
        <div className="row"><StatusPill tone={statusTone}>{statusLabel}</StatusPill>{refreshControl}</div>
        {loading && <p role="status" className="row muted small"><LoaderCircle className="size-3.5 animate-spin" />正在检查聊天条件</p>}
        {checks}
        {status?.state === 'stopped' && chatRuntimeNeedsSessionMigration(status) && <SessionMigrationControl api={api} connected={connected} disabled={dirty || active || uncertain || loading} onComplete={() => resource.refresh()} />}
        <div className="strip">{running ? '停止接收新的聊天消息，保留已有聊天记录与发送证据。' : applyBeforeStart ? '将应用已保存的聊天设置并启动，原有上下文保留。' : '启动前核对连接与配置；实际模型请求通过 QQ 消息验证。'}</div>
        {dirty && <p className="small muted">请先保存连接设置。</p>}
        {notice && <p role="status" className="small muted">{notice}</p>}
        {error && <p role="alert" className="row text-xs text-destructive"><CircleAlert className="size-3.5 shrink-0" />{error}</p>}
        {recovery}<div className="actions border-t pt-2">{controlButton}{refreshControl}</div>
      </div>;
  if (compact) return controlBody;
  return <section id="chat-runtime" className="panel entity">
    <div className="row"><span className="avatar" aria-hidden="true">▷</span><div className="grow"><h2 className="panel-title">聊天运行</h2><p className="muted small">已授权的 QQ 会话</p></div><StatusPill tone={statusTone}>{statusLabel}</StatusPill></div>
    <div className="meta"><span>QQ 消息：{status ? status.protocolConnected ? '已连接' : '未连接' : '待确认'}</span><span>DSH：{status ? chatRuntimeEngineReadiness(status) : '待确认'}</span></div>
    <div className={`strip ${uncertain || applicationState.blocked || resource.error ? 'warn' : ''}`} role="status">{!status ? loading ? '正在读取聊天运行状态。' : '暂时无法确认聊天运行状态，请刷新读取。' : active ? '正在更新聊天运行状态，请等待原操作。' : dirty ? '连接草稿尚未保存；请保存后再启动聊天。' : uncertain || applicationState.blocked ? '启停结果未确认，先核对停止与排空状态。' : status?.configurationChanged ? '设置已更新，重启聊天后生效。' : running ? status.chatReady ? '正在处理白名单内消息；停止会保留聊天历史和发送记录。' : '聊天正在运行，当前接收条件需要处理。' : status.state === 'error' ? '聊天运行需要处理，请查看详情。' : '聊天已停止；可检查条件后明确启动。'}</div>
    <div className="actions">
      <SettingsWindow title={running ? '停止聊天' : '启动与检查聊天'} label={running ? '停止聊天' : '启动聊天'} description="检查真实运行状态后执行；停止保留历史，启动沿当前配置继续。">{controlBody}</SettingsWindow>
      {refreshControl}
      <ReadOnlyDetails title="聊天运行详情" description="运行条件、当前诊断与原操作证据。"><div className="stack">{checks}<TechnicalDetails fields={[{ label: '运行状态', value: statusLabel }, { label: '最近错误', value: status?.lastError ? chatRuntimeLastError(status.lastError) : '无' }, { label: '应用阶段', value: applicationState.phase ? chatApplicationPhaseLabels[applicationState.phase] : '无' }, { label: '操作编号', value: applicationState.operationId }, { label: '配置更新', value: status?.configurationChanged ?? '未知' }]} />{recovery}{connectionPanel}</div></ReadOnlyDetails>
    </div>
    {notice && <p role="status" className="small muted">{notice}</p>}
    {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
    {observationError && <p role="status" className="small muted">暂时无法读取应用操作，后台阶段不会重复执行，请刷新状态。</p>}
    {status?.lastError && <p role="alert" className="text-xs text-destructive">{chatRuntimeLastError(status.lastError)}</p>}
    {(uncertain || applicationState.blocked) && recovery}
  </section>;
}
