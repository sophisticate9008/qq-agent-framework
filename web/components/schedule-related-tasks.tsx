import { Play, RefreshCw } from 'lucide-react';
import { parsePluginScheduleSnapshot, type PluginScheduleItem } from '../../src/contracts/plugin-schedules.ts';
import type { ApiClient } from '../lib/api.ts';
import { pluginSchedulesPath, scheduleKey, scheduleStateLabel, scheduleTone } from '../lib/plugin-schedules.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';

export interface ScheduleControls {
  readonly busy?: boolean;
  readonly errors?: ReadonlyMap<string, string>;
  readonly pendingIds?: ReadonlySet<string>;
  readonly onOpen?: (item: PluginScheduleItem) => void;
  readonly onRunNow?: (item: PluginScheduleItem) => void;
}

/** Resolve references as normal, bounded same-plugin schedule reads; no business-specific actions. */
export function ScheduleRelatedTask({ api, connected, owner, link, controls }: {
  readonly api: ApiClient;
  readonly connected: boolean;
  readonly owner: string;
  readonly link: { readonly id: string; readonly label: string };
  readonly controls: ScheduleControls;
}) {
  const query = new URLSearchParams({ owner, id: link.id, limit: '1' });
  const resource = useReadResource(api, `${pluginSchedulesPath}?${query}`, connected, parsePluginScheduleSnapshot);
  const item = resource.snapshot?.items.find(item => item.owner === owner && item.id === link.id);
  const key = scheduleKey({ owner, id: link.id });
  const error = controls.errors?.get(key);
  const locked = controls.busy || controls.pendingIds?.has(key) || resource.loading || Boolean(resource.error) || item?.managementState !== 'ready';
  return <li className="stack gap-1 py-2 first:pt-0 last:pb-0">
    <div className="row"><strong className="min-w-0 flex-1 break-words">{link.label}</strong>{item && <StatusPill tone={scheduleTone(item.state)}>{scheduleStateLabel(item)}</StatusPill>}</div>
    <p className="small muted whitespace-pre-wrap">{resource.error ? '关联任务读取失败，请刷新核对。' : item ? [item.business?.stage, item.business?.summary].filter(Boolean).join(' · ') : resource.loading ? '正在读取关联任务…' : '此日程已回收或尚未登记，现有业务记录仍保留。'}</p>
    {error && <p className="small text-[var(--warning)]" role="status">{error}</p>}
    <div className="row justify-end"><Button size="sm" variant="ghost" disabled={resource.loading} onClick={resource.refresh}><RefreshCw className="size-3" />刷新</Button>{item && controls.onOpen && <Button size="sm" variant="link" onClick={() => controls.onOpen?.(item)}>查看详情</Button>}{item?.actions.canRunNow && controls.onRunNow && <Button size="sm" variant="outline" disabled={locked} onClick={() => controls.onRunNow?.(item)}><Play className="size-3" />立即执行</Button>}</div>
  </li>;
}
