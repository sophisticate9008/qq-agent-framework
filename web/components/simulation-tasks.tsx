import { useState } from 'react'
import { parseSimulationSessionSnapshot } from '../../src/contracts/simulation-sessions.ts'
import { parseSimulationTasks } from '../../src/contracts/simulation-tasks.ts'
import type { ApiClient } from '../lib/api.ts'
import { useReadResource } from '../lib/use-read-resource.ts'
import { Section, StatusPill } from './management.tsx'
import { ReadOnlyDetails } from './read-only-details.tsx'
import { Button } from './ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx'

const states: Record<string, string> = { waiting: '等待触发', running: '正在执行', paused: '已暂停', completed: '已完成',
  failed: '执行失败', rejected: '未接纳', unknown: '结果待核对', cancelled: '已取消', expired: '已过期', blocked: '等待处理' }
const time = (at: number) => new Date(at).toLocaleString('zh-CN')

export function SimulationTasks({ api, connected }: { api: ApiClient; connected: boolean }) {
  const sessions = useReadResource(api, '/api/chat/simulations/sessions', connected, parseSimulationSessionSnapshot, { intervalMs: 10000 })
  const [selected, setSelected] = useState('')
  const runIds = [...new Set(sessions.snapshot?.sessions.map(session => session.runId) ?? [])]
  const runId = selected || runIds[0]
  return <Section title="模拟任务与执行记录" description="查看本地模拟会话中实际保存的任务和触发结果。模拟回复由本地捕获，未向真实 QQ 发送。"
    actions={<Button size="sm" variant="ghost" onClick={sessions.refresh}>刷新轮次</Button>}>
    {sessions.error && <p role="alert">模拟轮次读取失败，请刷新重试。</p>}
    {sessions.snapshot?.limited && <p className="small muted">模拟轮次目录较大，本次显示已读取的部分轮次。</p>}
    {!!sessions.snapshot?.unavailableRuns && <p className="small muted">部分模拟轮次暂不可读。</p>}
    {runIds.length > 0 ? <div className="stack">
      <Select value={runId} onValueChange={value => { if (value) setSelected(value) }}>
        <SelectTrigger aria-label="模拟任务轮次"><SelectValue /></SelectTrigger>
        <SelectContent>{runIds.map(id => <SelectItem key={id} value={id}>模拟 · {id}</SelectItem>)}</SelectContent>
      </Select>
      {runId && <SimulationTaskRecords key={runId} api={api} connected={connected} runId={runId} />}
    </div> : <p className="small muted">{sessions.loading ? '正在读取模拟轮次…' : '暂无可读取的模拟会话。'}</p>}
  </Section>
}

function SimulationTaskRecords({ api, connected, runId }: { api: ApiClient; connected: boolean; runId: string }) {
  const [after, setAfter] = useState<string | null>(null)
  const [before, setBefore] = useState<string | null>(null)
  const query = new URLSearchParams({ runId, ...(after ? { after } : {}), ...(before ? { before } : {}) })
  const data = useReadResource(api, '/api/chat/simulations/tasks?' + query, connected, parseSimulationTasks, { intervalMs: 5000 })
  return <div className="stack" data-simulation-task-records>
    <div className="row flex-wrap"><StatusPill tone="neutral">模拟 · {data.snapshot?.runtimeState === 'busy' ? '运行中或占用待核对' : '已停止'}</StatusPill>
      <Button size="sm" variant="ghost" onClick={data.refresh}>刷新记录</Button></div>
    {data.error && <p role="alert">模拟任务读取失败；不能据此确认没有任务。</p>}
    {!data.snapshot ? <p>正在读取任务…</p> : <>
      <strong>任务（每批最多 20 条）</strong>
      {data.snapshot.tasks.items.length === 0 && <p className="small muted">当前无任务；已删除任务的执行记录仍在下方保留至清理期限。</p>}
      {data.snapshot.tasks.items.map(task => <div className="row flex-wrap" key={task.id}>
        <strong className="grow">{task.title}</strong><StatusPill tone="neutral">{states[task.state]}</StatusPill>
        <ReadOnlyDetails title={task.title} label="详情"><div className="stack">
          <p>{task.instruction}</p><p>所属会话：{task.origin.binding.conversationId}</p>
          <p>保存于 {time(task.createdAt)} · 截止 {time(task.deadlineAt)}</p>
          <p>执行 {task.steps} 次 · {task.lastError ?? '无错误记录'}</p>
          <pre className="whitespace-pre-wrap break-all">{JSON.stringify({ condition: task.condition, progress: task.checkpoint, result: task.result }, null, 2)}</pre>
          <p className="break-all">任务编号：{task.id}</p>
        </div></ReadOnlyDetails>
      </div>)}
      <div className="row"><Button size="sm" variant="ghost" disabled={!after} onClick={() => setAfter(null)}>任务首批</Button>
        <Button size="sm" variant="ghost" disabled={!data.snapshot.tasks.next} onClick={() => setAfter(data.snapshot?.tasks.next ?? null)}>下一批任务</Button></div>
      <strong>执行记录（按触发时间倒序，每批最多 20 条）</strong>
      {!data.snapshot.runs.length && <p className="small muted">尚无保留期内的执行记录。</p>}
      {data.snapshot.runs.map(run => <div className="row flex-wrap" key={run.id} data-simulation-task-run>
        <strong className="grow">{run.title ?? '任务 ' + run.taskId.slice(0, 8)}{run.taskDeleted ? '（任务已删除）' : ''}</strong>
        <span className="small muted">{time(run.startedAt)}</span><StatusPill tone={run.state === 'completed' ? 'success' : 'neutral'}>{states[run.state]}</StatusPill>
        <ReadOnlyDetails title="模拟任务执行记录" label="详情"><div className="stack">
          <p>模拟轮次：{runId}</p><p>触发于 {time(run.startedAt)}</p><p>结束于 {run.finishedAt === null ? '尚未结束' : time(run.finishedAt)}</p>
          {run.conversationId && <p>所属会话：{run.conversationId}</p>}
          <p className="break-all">任务编号：{run.taskId}</p><p className="break-all">执行编号：{run.id}</p>
          <p>回复内容可在“最近活动”的模拟来源中查看。</p>
        </div></ReadOnlyDetails>
      </div>)}
      <div className="row"><Button size="sm" variant="ghost" disabled={!before} onClick={() => setBefore(null)}>最新执行</Button>
        <Button size="sm" variant="ghost" disabled={!data.snapshot.nextRun} onClick={() => setBefore(data.snapshot?.nextRun ?? null)}>更早执行</Button></div>
    </>}
  </div>
}
