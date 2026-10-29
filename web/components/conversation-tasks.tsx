import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { parseConversationTaskPage } from '../../src/contracts/conversation-tasks.ts'
import { conversationTaskListItem, parseSimulationTaskList, type ConversationTaskListItem } from '../../src/contracts/conversation-task-list.ts'
import { asRecord, type ApiClient } from '../lib/api.ts'
import { useReadResource } from '../lib/use-read-resource.ts'
import { EmptyState, Section, StatusPill } from './management.tsx'
import { DetailsWindow, RawDetails } from './read-only-details.tsx'
import { VirtualTableBody } from './virtual-list.tsx'
import { Button } from './ui/button.tsx'

const states: Record<string, string> = { waiting: '等待触发', running: '正在执行', paused: '已暂停', completed: '已完成', failed: '执行失败',
  rejected: '未接纳', unknown: '结果待核对', cancelled: '已取消', expired: '已过期', blocked: '等待处理' }
const time = (at: number | null) => at === null ? '—' : new Date(at).toLocaleString('zh-CN')
const key = (task: ConversationTaskListItem) => JSON.stringify([task.origin, task.simulationRunId, task.id, task.taskDeleted ? task.runId : null])
export function ConversationTasks({ api, connected, active = true }: { api: ApiClient; connected: boolean; active?: boolean }) {
  const [after, setAfter] = useState<string | null>(null)
  const [selected, setSelected] = useState<ConversationTaskListItem | null>(null)
  const data = useReadResource(api, '/api/chat/tasks' + (after ? '?after=' + after : ''), connected && active, parseConversationTaskPage, { intervalMs: 5000 })
  const simulation = useReadResource(api, '/api/chat/simulations/tasks/recent', connected && active, parseSimulationTaskList, { intervalMs: 5000 })
  const rows = [...(data.snapshot?.items.map(task => conversationTaskListItem(task)) ?? []), ...(simulation.snapshot?.items ?? [])]
    .sort((a, b) => b.updatedAt - a.updatedAt || key(a).localeCompare(key(b)))
  const detail = selected && (rows.find(task => key(task) === key(selected)) ?? selected)
  return <Section title="会话任务" className="flush" description="在会话中安排，到点或条件满足后继续执行。模拟记录与 QQ 记录合并显示。"
    actions={<Button size="sm" variant="ghost" onClick={() => { data.refresh(); simulation.refresh() }}><RefreshCw className="size-3" />刷新</Button>}>
    {(data.error || simulation.error || !!simulation.snapshot?.unavailableRuns) && <p className="strip warn m-2" role="alert">{data.error ? 'QQ 任务暂时无法读取。' : ''}{simulation.error || simulation.snapshot?.unavailableRuns ? '部分模拟记录暂时无法读取。' : ''}保留已读取记录。</p>}
    {rows.length === 0 ? <EmptyState title={data.loading || simulation.loading ? '正在读取任务…' : '暂无会话任务'} description="可以在会话中说“十分钟后提醒我喝水”。" /> :
      <div className="tablewrap max-h-96 overflow-auto overscroll-contain" data-conversation-tasks-scroll>
        <table><thead className="sticky top-0 z-10 bg-muted"><tr><th>任务</th><th>会话</th><th>触发时间</th><th>状态</th><th className="text-right">操作</th></tr></thead>
          <VirtualTableBody items={rows} getItemKey={key} columns={5} estimateSize={42}>{task => <tr key={key(task)} data-conversation-task data-origin={task.origin}>
            <td className="max-w-72"><div className="flex items-center gap-2"><strong className="truncate" title={task.title}>{task.title}</strong>
              {task.origin === 'simulation' && <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground" title={`模拟轮次 ${task.simulationRunId}，回复仅在本地捕获`}>模拟</span>}</div>
              {task.taskDeleted && <span className="small muted">任务已删除 · 保留执行记录</span>}</td>
            <td className="small muted">{task.conversationId ?? '未记录'}</td><td className="tabular-nums small">{time(task.dueAt ?? task.startedAt)}</td>
            <td><StatusPill tone={['unknown', 'failed', 'blocked', 'rejected'].includes(task.state) ? 'warning' : task.state === 'completed' ? 'success' : 'neutral'}>{states[task.state]}</StatusPill></td>
            <td className="text-right"><Button size="sm" variant="link" onClick={() => setSelected(task)}>详情</Button></td>
          </tr>}</VirtualTableBody>
        </table>
      </div>}
    <div className="row small muted px-2.5 py-1.5 flex-wrap"><span>共 {rows.length} 条 · QQ 每批 20 条 · 合并最近 4 轮模拟{simulation.snapshot?.limited ? '（模拟记录仅显示最近一批）' : ''}</span>
      <span className="push">{after && <Button size="sm" variant="ghost" onClick={() => setAfter(null)}>返回首批</Button>}
        {data.snapshot?.next && <Button size="sm" variant="outline" onClick={() => setAfter(data.snapshot?.next ?? null)}>下一批 QQ 任务</Button>}</span></div>
    <DetailsWindow open={detail !== null} onOpenChange={open => { if (!open) setSelected(null) }} title={detail?.title ?? '任务详情'} description="任务来源、时间与实际执行状态。">
      {detail && <div className="stack">
        <dl className="info"><dt>来源</dt><dd>{detail.origin === 'simulation' ? `模拟 · ${detail.simulationRunId}` : 'QQ'}</dd>
          <dt>状态</dt><dd>{states[detail.state]}{detail.taskDeleted ? ' · 任务已删除' : ''}</dd>
          <dt>会话</dt><dd>{detail.conversationId ?? '未记录'}</dd><dt>保存时间</dt><dd>{time(detail.createdAt)}</dd>
          <dt>计划触发</dt><dd>{time(detail.dueAt)}</dd><dt>实际开始</dt><dd>{time(detail.startedAt)}</dd><dt>执行结束</dt><dd>{time(detail.finishedAt)}</dd></dl>
        {detail.instruction && <p className="whitespace-pre-wrap">{detail.instruction}</p>}
        {detail.lastError && <p className="strip warn">{detail.lastError}</p>}
        {detail.origin === 'simulation' ? <p className="small muted">模拟回复仅在本地捕获；正文可在最近活动中查看。</p> : <TaskHistory api={api} id={detail.id} />}
        <p className="small muted break-all">任务编号：{detail.id}</p>
        {detail.runId && <p className="small muted break-all">执行编号：{detail.runId}</p>}
      </div>}
    </DetailsWindow>
  </Section>
}
function TaskHistory({ api, id }: { api: ApiClient; id: string }) {
  const data = useReadResource(api, '/api/chat/tasks/history?id=' + id, true, value => {
    const row = asRecord(value)
    return Array.isArray(row.items) && row.items.length <= 100 ? row.items.map(asRecord) : null
  })
  return <div className="stack"><strong>最近执行记录（最多 100 条）</strong>
    {data.error ? <p>执行记录读取失败。</p> : data.snapshot?.map(run => <div className="row" key={String(run.id)}>
      <span>{time(Number(run.startedAt))} · {states[String(run.state)]}</span><RawDetails value={run} />
    </div>)}</div>
}
