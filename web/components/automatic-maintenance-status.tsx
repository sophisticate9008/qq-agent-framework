import { useReadResource } from '../lib/use-read-resource.ts';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
interface Maintenance { state: string; lastRunAt: number | null; removed: number; totalRecords: number | null; maxRecords: number | null; reason: string | null }
function parse(value: unknown): Maintenance | null {
  if (!value || typeof value !== 'object' || !('enabled' in value) || value.enabled !== true) return null;
  const v = value as Record<string, unknown>;
  if (!['pending', 'healthy', 'attention'].includes(String(v.state)) || typeof v.removed !== 'number'
    || v.lastRunAt !== null && typeof v.lastRunAt !== 'number' || v.totalRecords !== null && typeof v.totalRecords !== 'number'
    || v.maxRecords !== null && typeof v.maxRecords !== 'number' || v.reason !== null && typeof v.reason !== 'string') return null;
  return { state: String(v.state), lastRunAt: v.lastRunAt as number | null, removed: v.removed, totalRecords: v.totalRecords as number | null, maxRecords: v.maxRecords as number | null, reason: v.reason as string | null };
}
export function AutomaticMaintenanceStatus({ api, connected }: { readonly api: ApiClient; readonly connected: boolean }) {
  const resource = useReadResource(api, '/api/chat/maintenance', connected, parse, { intervalMs: 30_000 });
  const value = resource.snapshot;
  return <div className={`inline-flex items-center gap-1 text-xs ${resource.error || value?.state === 'attention' ? 'text-status-warning' : 'text-muted-foreground'}`}>
    <span role={resource.error || value?.state === 'attention' ? 'status' : undefined}>{resource.error ? '自动维护状态未更新' : !value ? '正在读取维护状态' : value.state === 'healthy' ? '自动维护正常' : value?.state === 'attention' ? '自动维护需要处理' : '自动维护等待运行'}</span>
    <ReadOnlyDetails title="自动维护" description="后台分批回收过期记录，无需手动清理。">
      <p className="mb-4">运行记录保留 7 天。单类记录超过一万条或数据库达到七成容量时，会提前回收一小时前已结束的记录；正在处理和结果未知的记录保留，用量账本与聊天历史独立保存。</p>
      {value?.reason === 'protected_or_ledger_capacity' && <p className="mb-3">数据库空间接近上限，剩余记录中可能包含用量账本或未完成任务，请核对这两部分。</p>}
      <TechnicalDetails fields={[{ label: '最近维护', value: value?.lastRunAt ? new Date(value.lastRunAt).toLocaleString() : '尚未运行' }, { label: '本次进程已回收', value: value?.removed ?? '尚未读取' }, { label: '数据库记录', value: value?.totalRecords == null ? '尚未读取' : `${value.totalRecords} / ${value.maxRecords}` }, { label: '技术原因', value: value?.reason ?? '无' }, { label: '读取错误', value: resource.error ? errorMessage(resource.error) : null }]} />
    </ReadOnlyDetails>
  </div>;
}
