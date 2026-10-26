import { useState } from 'react';
import { NATIVE_WORK_PATH, parseNativeWorkListSnapshot, parseNativeWorkDetailSnapshot } from '../../src/contracts/native-work.ts';
import { isNativeAccessScope } from '../../src/contracts/native-access.ts';
import type { ApiClient } from '../lib/api.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { workContentSummary, workDeliveryLabels, workStateLabels, workTime } from '../lib/work-ui.ts';
import { Field, Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { DetailsWindow, ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { describeConversationKey } from '../lib/activity.ts';

function WorkDetail({ api, connected, id }: { readonly api: ApiClient; readonly connected: boolean; readonly id: string }) {
  const detail = useReadResource(api, `${NATIVE_WORK_PATH}?id=${encodeURIComponent(id)}`, connected, parseNativeWorkDetailSnapshot, { intervalMs: 5_000 });
  const record = detail.snapshot?.record;
  return <div className="grid min-w-0 gap-2 text-sm leading-6" data-work-detail={id}>
    <div className="flex flex-wrap items-center justify-between gap-2"><strong>工作记录详情</strong><Button size="sm" variant="outline" disabled={detail.loading} onClick={detail.refresh}>刷新工作详情</Button></div>
    {detail.error && <p role="status">工作详情暂未读到；保留上次状态，不推断执行或回传成功。</p>}
    {record ? <><div className="flex flex-wrap gap-2"><StatusPill>{workStateLabels[record.status]}</StatusPill><StatusPill tone={record.delivery === 'confirmed' ? 'success' : 'neutral'}>{workDeliveryLabels[record.delivery]}</StatusPill></div>
      <dl className="grid gap-1 break-all"><div>工作：{record.id}</div><div>所属会话：{record.conversationId}</div><div>父会话：{record.parentSessionId}</div><div>子任务：{record.childId}</div><div>创建：{workTime(record.createdAt)}</div><div>处理期限：{workTime(record.deadlineAt)}</div></dl>
      {record.status === 'unknown' && <p>结果尚未核实，不会从网页重新执行或恢复。请在所属 QQ 会话查看并处理。</p>}
      {record.result ? <div><strong>已记录执行结果</strong><p>结束原因：{record.result.stopReason}</p><div className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border p-2">{record.result.output.map(workContentSummary).join('\n\n') || '没有可展示的结果内容。'}</div></div> : <p>尚无已确认的执行结果。</p>}
      {record.lateResult && <section><h3 className="font-medium">迟到结果（未自动替代当前结果）</h3><div className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{record.lateResult.output.map(workContentSummary).join('\n\n')}</div></section>}
      <section><h3 className="font-medium">回传与技术记录</h3><div className="grid gap-1 break-all"><p>结果标识：{record.resultId ?? '无'}</p><p>回传标识：{record.deliveryId ?? '无'}</p><p>QQ 消息回执：{record.deliveryMessageId ?? '未取得'}</p><p>文件上传回执：{record.deliveryFileId ?? '未取得'}</p><p>执行错误：{record.lastError ?? '无'}</p><p>回传错误：{record.deliveryError ?? '无'}</p></div></section>
    </> : <p>{detail.loading ? '正在读取工作详情…' : '尚未取得工作详情。'}</p>}
  </div>;
}

export function WorkRecords({ api, connected, embedded = false }: { readonly api: ApiClient; readonly connected: boolean; readonly embedded?: boolean }) {
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
  return <Section id="native-work-records" title="独立工作记录" className={embedded ? 'rounded-none border-0 shadow-none [&>.panel-header]:hidden' : undefined} actions={<Button size="sm" variant="outline" disabled={resource.loading} onClick={resource.refresh}>刷新</Button>}>
    <div className="grid gap-2 text-xs"><div className="flex flex-wrap items-center gap-2"><Field label="所属会话"><Input aria-label="工作所属会话筛选" className="w-56 max-w-full" placeholder="全部，或 group:123 / private:456" value={draftFilter} onChange={event => setDraftFilter(event.target.value)} /></Field><Button size="sm" variant="outline" disabled={!validFilter || resource.loading} onClick={() => { setFilter(draftFilter); setAfter(null); setSelected(null); resource.refresh(); }}>筛选</Button>{embedded && <Button size="sm" variant="outline" disabled={resource.loading} onClick={resource.refresh}>刷新</Button>}<span className="ml-auto text-xs text-muted-foreground">工作操作在所属 QQ 会话进行</span></div>
      {!validFilter && <p role="status" className="text-xs text-destructive">请输入完整的 group:群号 或 private:账号。</p>}
      {resource.error && <p role="alert" className="text-xs text-destructive">工作记录读取失败，结果仍待核对。</p>}
      {resource.snapshot && resource.snapshot.records.length > 0 && <div className="tablewrap rounded-md border"><table className="w-full min-w-[44rem] text-left text-[11px]"><thead className="bg-muted text-xs text-muted-foreground"><tr><th className="px-2 py-1 font-medium">所属会话</th><th className="px-2 py-1 font-medium">状态</th><th className="px-2 py-1 font-medium">结果摘要</th><th className="px-2 py-1 font-medium">回传</th><th className="px-2 py-1 font-medium">创建时间</th><th className="px-2 py-1 font-medium">操作</th></tr></thead><tbody className="divide-y">{resource.snapshot.records.map(record => { const identity = describeConversationKey(record.conversationId); return <tr key={record.id} className="hover:bg-muted/30"><td className="whitespace-nowrap px-2 py-1">{identity.label} {identity.identifier}</td><td className={`whitespace-nowrap px-2 py-1 ${record.status === 'unknown' || record.status === 'failed' ? 'text-destructive' : ''}`}>{workStateLabels[record.status]}</td><td className="max-w-72 px-2 py-1"><span className="block truncate">{record.result?.output.map(workContentSummary).join(' ') || (record.status === 'unknown' ? '结果未确认' : '尚无已确认结果')}</span></td><td className="whitespace-nowrap px-2 py-1 text-xs text-muted-foreground">{workDeliveryLabels[record.delivery]}</td><td className="whitespace-nowrap px-2 py-1 text-xs text-muted-foreground">{workTime(record.createdAt)}</td><td className="px-2 py-1"><Button size="sm" variant="ghost" aria-label={`查看${identity.label} ${identity.identifier}工作详情`} onClick={() => setSelected(record.id)}>详情</Button></td></tr>; })}</tbody></table></div>}
      {resource.snapshot?.records.length === 0 && <p className="text-xs text-muted-foreground">当前筛选下没有工作记录。</p>}
      {!resource.snapshot && resource.loading && <p className="text-xs text-muted-foreground">正在读取工作记录…</p>}
      <div className="flex flex-wrap items-center gap-2">{after && <Button size="sm" variant="outline" disabled={resource.loading} onClick={() => { setAfter(null); setSelected(null); }}>返回首批</Button>}{resource.snapshot?.next && <Button size="sm" variant="outline" disabled={resource.loading} onClick={() => { setAfter(resource.snapshot?.next ?? null); setSelected(null); }}>下一批</Button>}{resource.error && <ReadOnlyDetails title="工作列表读取详情"><TechnicalDetails fields={[{ label: '读取错误', value: resource.error instanceof Error ? resource.error.message : String(resource.error) }]} /></ReadOnlyDetails>}</div>
      <DetailsWindow open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }} title="工作记录详情" description="查看已确认结果、迟到结果和回传回执。">{selected && <WorkDetail key={selected} api={api} connected={connected} id={selected} />}</DetailsWindow>
    </div>
  </Section>;
}
