import type { ApiClient } from '../lib/api.ts';
import { requestDshRestart } from '../lib/dsh-restart.ts';
import { useDshRestart } from '../lib/use-dsh-restart.ts';
import { Button } from './ui/button.tsx';

const phases = { stop: '正在停止聊天', restart: '正在重启 DSH', verify: '正在等待 DSH 就绪', restore: '正在恢复聊天' } as const;
const availability: Readonly<Record<string, string>> = {
  LOCAL_DSH_RESTART_NOT_CONFIGURED: '当前管理服务尚未接入本机 DSH 重启。',
  LOCAL_DSH_MANAGER_UNSUPPORTED: '当前本机服务管理器不支持重启 DSH。',
  LOCAL_DSH_MANAGER_TARGET_MISMATCH: '当前服务管理器未对应这台 DSH。',
  LOCAL_DSH_RESTART_UNAVAILABLE: '本机 DSH 重启暂不可用。',
  DSH_RESTART_SHARED_RUNTIME_ACTIVE: '其他账号仍在使用 DSH，当前不能重启。',
  DSH_RESTART_APPLICATION_BUSY: '聊天设置仍在更新，请等待当前阶段结束。',
  LOCAL_DSH_RESTART_ACCOUNT_UNAVAILABLE: '当前账号工作空间暂不提供本机 DSH 重启。',
  LOCAL_DSH_DEPLOYMENT_PROCESS_MISSING: '尚未识别到本机 DSH 进程，请先恢复服务，再刷新状态。',
};

export function DshRestartControl({ api, connected, compact = false }: { readonly api: ApiClient; readonly connected: boolean; readonly compact?: boolean }) {
  const { state, pending, resource } = useDshRestart(api, connected);
  const operation = state.snapshot?.operation;
  const unknown = state.uncertain || operation?.state === 'unknown';
  const running = operation?.state === 'running';
  const reason = state.snapshot?.available === false
    ? availability[state.snapshot.missingReasons.find(code => Object.hasOwn(availability, code)) ?? ''] ?? '暂时无法确认本机 DSH 重启条件，请刷新状态后重试。'
    : undefined;
  const label = running ? operation.phase ? phases[operation.phase] : '正在重启 DSH' : unknown ? '恢复原重启' : '重启 DSH';
  return <div className={compact ? 'inline-grid gap-1' : 'grid gap-2 rounded-lg border p-3 text-xs'} data-dsh-restart>
    <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline"
      disabled={!connected || state.requestActive || running || !unknown && !state.snapshot?.available}
      onClick={() => void requestDshRestart(api, unknown)}>{label}</Button>
      {(pending || resource.error || state.snapshot?.available === false) && <Button size="sm" variant="ghost" onClick={resource.refresh}>读取重启状态</Button>}
    </div>
    {!compact && <p>自动暂停聊天、重启本机 DSH，并恢复此前的运行状态；当前草稿与会话记录保留。</p>}
    {(!compact || state.error || unknown || resource.error || reason) && <>
      {state.error && <p role="status">{state.error} {unknown ? '可读取原重启状态，不会重新提交。' : '可刷新状态后再操作。'}</p>}
      {resource.error && <p role="status">暂时未读到重启状态，原操作保留；可重新读取。</p>}
      {unknown && <p role="status">原重启结果待确认。恢复只核对同一操作，不重复执行重启命令。</p>}
      {!pending && reason && <p>{reason}</p>}
      {operation?.state === 'completed' && <p>{operation.restartExecutionVerified ? 'DSH 已重启，维护已完成。' : 'DSH 可用，维护已完成；原重启回执未确认。'}</p>}
      {operation?.state === 'blocked' && <p>本次重启未继续，请刷新状态后处理条件。</p>}
    </>}
  </div>;
}
