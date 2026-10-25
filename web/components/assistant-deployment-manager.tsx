import { useEffect, useRef, useState } from 'react';
import { NATIVE_ASSISTANT_DEPLOYMENT_PATH, parseNativeAssistantDeploymentSnapshot, type NativeAssistantDeploymentSnapshot } from '../../src/contracts/native-assistant-target.ts';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';

const labels: Readonly<Record<NativeAssistantDeploymentSnapshot['state'], string>> = {
  prepared: '已检查，等待明确应用', blocked: '助手目标检查未通过', applying: '助手目标应用中', verified: '助手目标已核验',
  pending_reload: '已写入，等待加载核验', unknown: '助手应用结果待核对', conflict: '配置已变化，需要重新检查',
};
const reasons: Readonly<Record<string, string>> = {
  assistant_disabled: '先保存“聊天＋助手”模式及独立执行模型。', assistant_target_disabled: '先保存“聊天＋助手”模式及独立执行模型。',
  assistant_target_unavailable: '独立助手目标尚未通过运行核对。', assistant_runtime_not_connected: '聊天宿主尚未接入独立工作执行。',
  assistant_deployment_reconciliation_required: '上次助手应用尚待核对，先核对实际结果，不会重放应用。',
  assistant_deployment_result_unknown: '尚未确认上次应用结果，请核对实际目标；不会自动重试。',
  assistant_deployment_configuration_changed: '核对期间设置发生变化，请读取原操作与当前目标，不会重复应用。',
  assistant_deployment_requires_stopped: '先在连接页明确停止聊天，再应用助手目标。',
  pending_reload: 'DSH 尚未确认加载目标；这里不会自动重启 DSH。',
};

export function AssistantDeploymentManager({ api, connected, assistantRevision, dirty, enabled, onChanged }: {
  readonly api: ApiClient; readonly connected: boolean; readonly assistantRevision: string | null;
  readonly dirty: boolean; readonly enabled: boolean; readonly onChanged: () => void;
}) {
  const request = useRef<AbortController | null>(null);
  const resource = useReadResource(api, NATIVE_ASSISTANT_DEPLOYMENT_PATH, connected, parseNativeAssistantDeploymentSnapshot,
    { intervalMs: 5_000, pollWhen: () => !request.current });
  const [view, setView] = useState<NativeAssistantDeploymentSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++; setView(null); setBusy(false); setUnknown(false); setConfirmed(false); setError(''); setNotice('');
    return () => { epoch.current++; request.current?.abort(); request.current = null; };
  }, [api, connected]);
  useEffect(() => {
    if (resource.updatedAt > 0 && !resource.loading && !resource.error && resource.snapshot && !request.current) {
      setView(resource.snapshot); setUnknown(false);
    }
  }, [resource.updatedAt, resource.loading, resource.error, resource.snapshot]);
  useEffect(() => { setConfirmed(false); }, [view?.assistantRevision, view?.operationRevision, view?.state]);
  useEffect(() => { setConfirmed(false); }, [assistantRevision, dirty]);
  const unresolved = unknown || view?.state === 'unknown' || view?.state === 'applying' || view?.state === 'pending_reload';
  const matchesSaved = view?.assistantRevision === assistantRevision;
  const canApply = !busy && !dirty && enabled && !unresolved && matchesSaved && view?.state === 'prepared'
    && view.configurationRevision !== null && view.targetRevision !== null && confirmed;

  async function perform(action: 'prepare' | 'apply' | 'reconcile'): Promise<void> {
    if (!connected || busy || request.current || !assistantRevision || action !== 'reconcile' && (dirty || !enabled || unresolved)
      || action === 'apply' && !canApply || action === 'reconcile' && (!view?.configurationRevision || view.state === 'applying')) return;
    const controller = new AbortController(); const generation = epoch.current;
    request.current = controller;
    const current = () => !controller.signal.aborted && request.current === controller && epoch.current === generation;
    const body = action === 'prepare' ? { assistantRevision } : view ? {
      assistantRevision: view.assistantRevision, configurationRevision: view.configurationRevision, operationRevision: view.operationRevision,
      ...(action === 'apply' ? { targetRevision: view.targetRevision } : {}),
    } : null;
    if (!body) { request.current = null; return; }
    setBusy(true); setError(''); setNotice(''); setConfirmed(false);
    try {
      const next = parseNativeAssistantDeploymentSnapshot(await writeResource(api, `${NATIVE_ASSISTANT_DEPLOYMENT_PATH}/${action}`, body, controller.signal));
      if (!next) throw new Error('invalid_assistant_deployment_response');
      if (!current()) return;
      setView(next); setUnknown(false);
      setNotice(next.state === 'verified' ? '独立助手目标已核验。实际工作请在所属 QQ 会话发起；这里不会启动任务。'
        : next.state === 'prepared' ? '已检查已保存的助手设置，尚未修改 DSH；核对后可以明确应用。'
          : '本次管理操作已返回当前状态；缺失或未知条件未消除前不会继续应用。');
      onChanged();
    } catch (failure) { if (current()) { setUnknown(true); setError(`${errorMessage(failure)} 先读取持久状态并核对实际结果，不会自动重发应用。`); } }
    finally { if (current()) { request.current = null; setBusy(false); resource.refresh(); } }
  }

  if (!connected) return null;
  return <Section id="assistant-deployment" title="独立助手目标应用" scrollable description="将已保存的助手模型映射到明确的 DSH 执行目标；应用配置与在 QQ 发起工作分别进行。">
    <div className="grid gap-3 text-xs leading-6">
      <div className="flex flex-wrap items-center gap-2"><StatusPill tone={view?.state === 'verified' ? 'success' : 'warning'}>{unknown ? '管理请求结果待核对' : view ? labels[view.state] : '助手目标尚待核对'}</StatusPill><Button size="sm" variant="outline" disabled={busy || resource.loading} onClick={resource.refresh}>读取助手部署状态</Button></div>
      {resource.error && <p role="status">助手部署状态暂未读到；不会据此认为已经可执行。</p>}
      {dirty && <p>助手设置仍有草稿，请先明确保存；应用只消费已保存内容。</p>}
      {!enabled && <p>请先保存“聊天＋助手”模式、独立提供方和执行模型。</p>}
      {view && <><p>模型目标：{view.provider ?? '尚未核对提供方'} / {view.model ?? '尚未核对模型'}</p>{view.missingReasons.map(reason => <p key={reason}>{Object.hasOwn(reasons, reason) ? reasons[reason] : '当前助手目标还有待核对的条件，请查看技术状态并检查连接。'}</p>)}<details><summary className="cursor-pointer">目标与技术状态</summary><div className="mt-2 grid gap-1 break-all"><p>DSH 预设：{view.agentPreset ?? '尚未核验'}</p><p>外部提供方：{view.externalProvider ?? '尚未核验'}</p><p>管理版本：{view.operationRevision}</p><p>缺失条件：{view.missingReasons.join('、') || '无'}</p><p>完整访问：未授予；工具能力仍按独立授权和 QQ 来源检查。</p></div></details></>}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || dirty || !enabled || unresolved || !assistantRevision} onClick={() => void perform('prepare')}>检查助手部署</Button><Button size="sm" variant="outline" disabled={busy || !view?.configurationRevision || view.state === 'applying'} onClick={() => void perform('reconcile')}>核对助手目标实际结果</Button></div>
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={busy || dirty || !enabled || unresolved || !matchesSaved || view?.state !== 'prepared'} onChange={event => setConfirmed(event.target.checked)} />确认应用已保存的独立助手模型配置</label>
      <Button className="justify-self-start" disabled={!canApply} onClick={() => void perform('apply')}>{busy ? '正在处理助手部署…' : '应用助手目标'}</Button>
      {(error || notice) && <p role="status" className={error ? 'text-destructive' : ''}>{error || notice}</p>}
    </div>
  </Section>;
}
