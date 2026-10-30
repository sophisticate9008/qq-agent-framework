import { RefreshCw } from 'lucide-react';
import { parsePluginScheduleDetail, type PluginScheduleBusinessDetails } from '../../src/contracts/plugin-schedules.ts';
import type { ApiClient } from '../lib/api.ts';
import { describeConversationKey } from '../lib/activity.ts';
import { pluginSchedulesPath, scheduleDuration, scheduleHistoryStateLabel, scheduleOwner, schedulePlanLabel, scheduleStateLabel, scheduleTime, scheduleTitle, scheduleTone } from '../lib/plugin-schedules.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { StatusPill } from './management.tsx';
import { RawDetails, TechnicalDetails } from './read-only-details.tsx';
import { Button } from './ui/button.tsx';

export interface ScheduleDetailTarget {
  readonly owner: string;
  readonly id: string;
  readonly title: string;
  readonly occurrenceId?: string;
}
const stepLabels: Readonly<Record<NonNullable<PluginScheduleBusinessDetails['steps']>[number]['state'], string>> = {
  pending: '待开始', running: '进行中', completed: '已完成', failed: '失败', skipped: '已跳过', unknown: '待核对',
};

/** Mounted only while its drawer is open; detail payloads and images are never polled. */
export function ScheduleDetails({ api, connected, target }: { readonly api: ApiClient; readonly connected: boolean; readonly target: ScheduleDetailTarget }) {
  const query = new URLSearchParams({ owner: target.owner, id: target.id });
  if (target.occurrenceId) query.set('occurrenceId', target.occurrenceId);
  const path = `${pluginSchedulesPath}/detail?${query}`;
  const parse = (value: unknown) => {
    const detail = parsePluginScheduleDetail(value);
    return detail && detail.item.owner === target.owner && detail.item.id === target.id
      && (!detail.occurrence || detail.occurrence.owner === target.owner && detail.occurrence.ruleId === target.id)
      && (!target.occurrenceId || detail.occurrence?.id === target.occurrenceId) ? detail : null;
  };
  const resource = useReadResource(api, path, connected, parse);
  const value = resource.snapshot;
  const details = value?.details;
  const occurrence = value?.occurrence;
  const state = occurrence?.status ?? value?.item.state;
  const scope = details?.sessionId && /^(?:group|private):/.test(details.sessionId) ? describeConversationKey(details.sessionId) : null;
  return <div className="stack">
    <div className="row"><Button size="sm" variant="outline" disabled={resource.loading} onClick={resource.refresh}><RefreshCw className={resource.loading ? 'size-3 animate-spin' : 'size-3'} />刷新详情</Button><span className="push small muted">{resource.updatedAt ? `读取于 ${scheduleTime(resource.updatedAt)}` : '尚未读取'}</span></div>
    {resource.error && <p className="strip warn" role="alert">详情读取失败；{value ? '保留上次读取的内容，当前进展待核对。' : '当前执行与业务结果尚未确认。'}</p>}
    {!value ? <p className="small muted" role="status">{resource.loading ? '正在读取任务详情…' : '暂无可核对的任务详情。'}</p> : <>
      <div className="row"><strong className="min-w-0 break-words">{occurrence?.presentation?.title ?? scheduleTitle(value.item)}</strong><span className="push"><StatusPill tone={state ? scheduleTone(state) : 'neutral'}>{occurrence ? scheduleHistoryStateLabel(occurrence.status) : scheduleStateLabel(value.item)}</StatusPill></span></div>
      {value.item.presentation?.description && <p className="small muted whitespace-pre-wrap">{value.item.presentation.description}</p>}
      <dl className="info"><dt>所属插件</dt><dd>{occurrence?.presentation?.ownerLabel ?? scheduleOwner(value.item)}</dd><dt>时间规则</dt><dd>{schedulePlanLabel(value.item.schedule)}</dd><dt>规则时区</dt><dd>{value.item.timeZone}</dd><dt>{occurrence ? '本次计划时间' : '下次计划时间'}</dt><dd>{scheduleTime(occurrence?.scheduledAt ?? value.item.nextAt, true)}</dd><dt>暂停状态</dt><dd>{value.item.paused ? '已持久暂停' : '未暂停'}</dd>{occurrence && <><dt>触发方式</dt><dd>{occurrence.trigger === 'manual' ? '手动立即执行' : '定时触发'}</dd><dt>实际开始</dt><dd>{scheduleTime(occurrence.startedAt, true)}</dd><dt>执行耗时</dt><dd>{scheduleDuration(occurrence)}</dd></>}</dl>
      {occurrence?.status === 'completed' && <div className="strip">本次调度回调已结束。具体生成、发送或发布的结果以插件提供的阶段与回执为准。</div>}
      {(value.item.managementState !== 'ready' || occurrence?.status === 'unknown') && <p className="strip warn" role="status">{value.item.managementState === 'running-now' ? '本次立即执行正在后台处理，关闭页面后仍会继续。' : value.item.managementState === 'skipping' ? '跳过操作仍在处理，请核对原任务的状态。' : '原执行或管理操作的结果尚未确认，请核对证据。'}</p>}
      {value.detailsError && <p className="strip warn" role="alert">插件业务详情暂时读取失败；调度状态不能代替业务结果。</p>}
      {details ? <>
        <section className="stack border-t pt-2"><h3 className="font-semibold">实际进展</h3><div className="strip"><strong>{details.stage || '阶段尚未提供'}</strong>{details.summary && <p className="mt-1 whitespace-pre-wrap">{details.summary}</p>}</div>
          <dl className="info"><dt>关联会话</dt><dd>{scope ? `${scope.label} ${scope.identifier}` : details.sessionId ? '插件独立会话' : '未关联或尚未记录'}</dd></dl>
          {details.steps && details.steps.length > 0 && <ol className="divide-y rounded border">{details.steps.map((step, index) => <li key={`${index}:${step.label}`} className="row px-2 py-1.5 even:bg-muted/40"><span className="small muted">{index + 1}</span><span className="min-w-0 flex-1 break-words">{step.label}</span><StatusPill tone={step.state === 'failed' || step.state === 'unknown' ? 'warning' : step.state === 'completed' ? 'success' : step.state === 'running' ? 'info' : 'neutral'}>{stepLabels[step.state]}</StatusPill></li>)}</ol>}
        </section>
        <section className="stack border-t pt-2"><h3 className="font-semibold">实际结果</h3>{details.result ? <>
          {details.result.title && <strong className="break-words">{details.result.title}</strong>}
          {details.result.body && <div className="rounded border bg-card p-2 whitespace-pre-wrap break-words select-text">{details.result.body}</div>}
          {details.result.images.length > 0 && <div className="grid gap-2">{details.result.images.map((image, index) => <figure key={index} className="min-w-0 rounded border bg-muted/20 p-1"><img src={image.dataUrl} alt={image.alt || `任务结果图片 ${index + 1}`} loading="lazy" className="mx-auto max-h-96 max-w-full rounded object-contain" />{image.alt && <figcaption className="small muted px-1 py-1">{image.alt}</figcaption>}</figure>)}</div>}
          {!details.result.title && !details.result.body && details.result.images.length === 0 && <p className="small muted">插件未提供可展示的结果内容。</p>}
        </> : <p className="small muted">插件尚未提供可展示的业务结果。</p>}</section>
      </> : <p className="small muted">{value.detailsAvailable ? '插件尚未提供本次业务详情。' : '此插件未提供业务结果详情。'}调度记录仍可查看。</p>}
      <section className="border-t pt-2"><RawDetails title="日程技术记录" label="查看次要技术详情" value={{ rule: value.item, occurrence, sessionId: details?.sessionId ?? null, detailsError: value.detailsError }} /></section>
      {occurrence?.errorCode && <div className="strip warn"><p>本次执行报告异常，具体业务结果请结合上方进展核对。</p><TechnicalDetails fields={[{ label: '错误标识', value: occurrence.errorCode }]} /></div>}
    </>}
  </div>;
}
