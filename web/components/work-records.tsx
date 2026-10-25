import { useState } from 'react';
import { NATIVE_WORK_PATH, parseNativeWorkListSnapshot, parseNativeWorkDetailSnapshot } from '../../src/contracts/native-work.ts';
import { isNativeAccessScope } from '../../src/contracts/native-access.ts';
import type { ApiClient } from '../lib/api.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { workContentSummary, workDeliveryLabels, workStateLabels, workTime } from '../lib/work-ui.ts';
import { Field, Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';

function WorkDetail({ api, connected, id }: { readonly api: ApiClient; readonly connected: boolean; readonly id: string }) {
  const detail = useReadResource(api, `${NATIVE_WORK_PATH}?id=${encodeURIComponent(id)}`, connected, parseNativeWorkDetailSnapshot, { intervalMs: 5_000 });
  const record = detail.snapshot?.record;
  return <div className="grid min-w-0 gap-3 rounded-lg border p-3 text-xs leading-6" data-work-detail={id}>
    <div className="flex flex-wrap items-center justify-between gap-2"><strong>工作记录详情</strong><Button size="sm" variant="outline" disabled={detail.loading} onClick={detail.refresh}>刷新工作详情</Button></div>
    {detail.error && <p role="status">工作详情暂未读到；保留上次状态，不推断执行或回传成功。</p>}
    {record ? <><div className="flex flex-wrap gap-2"><StatusPill>{workStateLabels[record.status]}</StatusPill><StatusPill tone={record.delivery === 'confirmed' ? 'success' : 'neutral'}>{workDeliveryLabels[record.delivery]}</StatusPill></div>
      <dl className="grid gap-1 break-all"><div>工作：{record.id}</div><div>所属会话：{record.conversationId}</div><div>父会话：{record.parentSessionId}</div><div>子任务：{record.childId}</div><div>创建：{workTime(record.createdAt)}</div><div>处理期限：{workTime(record.deadlineAt)}</div></dl>
      {record.status === 'unknown' && <p>结果尚未核实，不会从网页重新执行或恢复。请在所属 QQ 会话查看并处理。</p>}
      {record.result ? <div><strong>已记录执行结果</strong><p>结束原因：{record.result.stopReason}</p><div className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border p-2">{record.result.output.map(workContentSummary).join('\n\n') || '没有可展示的结果内容。'}</div></div> : <p>尚无已确认的执行结果。</p>}
      {record.lateResult && <details><summary className="cursor-pointer">迟到结果（未自动替代当前结果）</summary><div className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{record.lateResult.output.map(workContentSummary).join('\n\n')}</div></details>}
      <details><summary className="cursor-pointer">回传与技术记录</summary><div className="grid gap-1 break-all"><p>结果标识：{record.resultId ?? '无'}</p><p>回传标识：{record.deliveryId ?? '无'}</p><p>QQ 消息回执：{record.deliveryMessageId ?? '未取得'}</p><p>文件上传回执：{record.deliveryFileId ?? '未取得'}</p><p>执行错误：{record.lastError ?? '无'}</p><p>回传错误：{record.deliveryError ?? '无'}</p></div></details>
    </> : <p>{detail.loading ? '正在读取工作详情…' : '尚未取得工作详情。'}</p>}
  </div>;
}

export function WorkRecords({ api, connected }: { readonly api: ApiClient; readonly connected: boolean }) {
  const [draftFilter, setDraftFilter] = useState('');
  const [filter, setFilter] = useState('');
  const [after, setAfter] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const query = new URLSearchParams({ limit: '50' });
  if (filter) query.set('conversationId', filter);
  if (after) query.set('after', after);
  const resource = useReadResource(api, `${NATIVE_WORK_PATH}?${query}`, connected, parseNativeWorkListSnapshot, { intervalMs: 5_000 });
  const validFilter = draftFilter === '' || isNativeAccessScope(draftFilter);
  if (!connected) return null;
  return <Section id="native-work-records" title="独立工作记录" description="查看执行结果与回父会话的回执。发起、追加、停止和恢复工作请在所属 QQ 会话进行。" scrollable height="lg">
    <div className="grid gap-3 text-xs leading-6"><div className="flex flex-wrap items-end gap-2"><Field label="工作所属会话筛选"><input aria-label="工作所属会话筛选" className="h-9 w-full rounded border bg-background px-3" placeholder="全部会话，或 group:123 / private:456" value={draftFilter} onChange={event => setDraftFilter(event.target.value)} /></Field><Button size="sm" variant="outline" disabled={!validFilter || resource.loading} onClick={() => { setFilter(draftFilter); setAfter(null); setSelected(null); resource.refresh(); }}>筛选工作记录</Button><Button size="sm" variant="outline" disabled={resource.loading} onClick={resource.refresh}>刷新工作记录</Button></div>
      {!validFilter && <p role="status">请输入完整的 group:群号 或 private:账号。</p>}
      {resource.error && <p role="status">工作记录暂未读到；不会据此认为没有任务或任务成功。</p>}
      {resource.snapshot?.records.map(record => <button type="button" key={record.id} className="grid gap-1 rounded-lg border p-3 text-left hover:bg-muted/40" aria-pressed={selected === record.id} onClick={() => setSelected(record.id)}><strong className="break-all">{record.id}</strong><span>{record.conversationId} · {workStateLabels[record.status]} · {workDeliveryLabels[record.delivery]}</span><span>{workTime(record.createdAt)}</span></button>)}
      {resource.snapshot?.records.length === 0 && <p>当前筛选下没有工作记录。</p>}
      {!resource.snapshot && resource.loading && <p>正在读取工作记录…</p>}
      <div className="flex gap-2">{after && <Button size="sm" variant="outline" disabled={resource.loading} onClick={() => { setAfter(null); setSelected(null); }}>返回首批工作</Button>}{resource.snapshot?.next && <Button size="sm" variant="outline" disabled={resource.loading} onClick={() => { setAfter(resource.snapshot?.next ?? null); setSelected(null); }}>下一批工作</Button>}</div>
      {selected && <WorkDetail key={selected} api={api} connected={connected} id={selected} />}
    </div>
  </Section>;
}
