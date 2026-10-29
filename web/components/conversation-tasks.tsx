import { useState } from 'react'
import { parseConversationTaskPage, type TaskCondition } from '../../src/contracts/conversation-tasks.ts'
import { asRecord } from '../lib/api.ts'
import type { ApiClient } from '../lib/api.ts'
import { useReadResource } from '../lib/use-read-resource.ts'
import { Section, StatusPill } from './management.tsx'
import { ReadOnlyDetails, RawDetails } from './read-only-details.tsx'
import { Button } from './ui/button.tsx'
const states: Record<string, string> = { waiting: '等待触发', running: '正在执行', paused: '已暂停', completed: '已完成', failed: '执行失败',
  unknown: '结果待核对', cancelled: '已取消', expired: '已过期', blocked: '等待处理' }
function describe(condition: TaskCondition): string {
  if (condition.kind === 'at') return new Date(condition.at).toLocaleString('zh-CN')
  if (condition.kind === 'delay') return `等待 ${condition.delayMs / 1000} 秒`
  if (condition.kind === 'daily') return `每天 ${String(condition.hour).padStart(2, '0')}:${String(condition.minute).padStart(2, '0')}（${condition.timeZone}）`
  if (condition.kind === 'event') return `等待事件 ${condition.topic}`
  if (condition.kind === 'task') return '等待依赖任务结束'
  return `${condition.kind === 'all' ? '全部' : '任一'}条件满足：${condition.conditions.map(describe).join('；')}`
}
export function ConversationTasks({ api, connected }: { api: ApiClient; connected: boolean }) {
  const [after, setAfter] = useState<string | null>(null)
  const data = useReadResource(api, '/api/chat/tasks' + (after ? '?after=' + after : ''), connected, parseConversationTaskPage, { intervalMs: 10000 })
  return <Section title="会话任务" description="AI 在 QQ 会话中创建的持久任务；到点或条件满足后继续执行。管理与补充要求直接在所属 QQ 会话提出。"
    actions={<Button size="sm" variant="ghost" onClick={data.refresh}>刷新</Button>}>
    {data.error ? <p>任务暂时无法读取。</p> : !data.snapshot ? <p>正在读取任务…</p> : !data.snapshot.items.length ? <p className="small muted">暂无会话任务。可以在 QQ 说“十分钟后提醒我”或“构建结束后告诉我”。</p> :
      <div className="stack">{data.snapshot.items.map(task => <div className="row flex-wrap" key={task.id}>
        <strong className="grow">{task.title}</strong><span className="small muted">{task.origin.binding.conversationId} · {task.condition.kind === 'delay' ? new Date((task.waitAt ?? task.createdAt) + task.condition.delayMs).toLocaleString('zh-CN') : describe(task.condition)}</span>
        <StatusPill tone={['unknown', 'failed', 'blocked'].includes(task.state) ? 'warning' : task.state === 'completed' ? 'success' : 'neutral'}>{states[task.state]}</StatusPill>
        <ReadOnlyDetails title={task.title} label="详情"><div className="stack">
          <p>{task.instruction}</p><TaskHistory api={api} id={task.id} /><p>已执行 {task.steps} 次 · 截止 {new Date(task.deadlineAt).toLocaleString('zh-CN')}</p>
          {task.lastError && <p>当前原因：{task.lastError}</p>}
          <p>任务编号：{task.id}</p><p>当前版本：{task.revision}</p>
          {task.parentId && <p>上级任务：{task.parentId}</p>}
          <pre className="whitespace-pre-wrap break-all">{JSON.stringify({ progress: task.checkpoint, result: task.result }, null, 2)}</pre>
        </div></ReadOnlyDetails>
      </div>)}</div>}
    <div className="row mt-2"><Button size="sm" variant="ghost" disabled={!after} onClick={() => setAfter(null)}>返回首批</Button>
      <Button size="sm" variant="ghost" disabled={!data.snapshot?.next} onClick={() => setAfter(data.snapshot?.next ?? null)}>下一批</Button></div>
  </Section>
}

function TaskHistory({ api, id }: { api: ApiClient; id: string }) {
  const data = useReadResource(api, '/api/chat/tasks/history?id=' + id, true, value => {
    const row = asRecord(value)
    return Array.isArray(row.items) && row.items.length <= 100 ? row.items.map(asRecord) : null
  })
  return <div className="stack"><strong>最近执行记录（最多 100 条）</strong>
    {data.error ? <p>执行记录读取失败。</p> : data.snapshot?.map(run => <div className="row" key={String(run.id)}>
      <span>{new Date(Number(run.startedAt)).toLocaleString('zh-CN')} · {String(run.state)}</span><RawDetails value={run} />
    </div>)}</div>
}
