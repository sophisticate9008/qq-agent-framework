import type { ConversationTask } from './conversation-tasks.ts'
import type { SimulationTaskRun } from './simulation-tasks.ts'
import { isRecord, reference } from './values.ts'
import { validSimulationRunId } from './admin-activity.ts'

export interface ConversationTaskListItem {
  readonly id: string
  readonly title: string
  readonly origin: 'qq' | 'simulation'
  readonly simulationRunId: string | null
  readonly conversationId: string | null
  readonly state: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly dueAt: number | null
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly instruction: string | null
  readonly taskDeleted: boolean
  readonly runId: string | null
  readonly lastError: string | null
}
export function conversationTaskListItem(task: ConversationTask, simulationRunId: string | null = null): ConversationTaskListItem {
  return { id: task.id, title: task.title, origin: simulationRunId ? 'simulation' : 'qq', simulationRunId,
    conversationId: task.origin.binding.conversationId, state: task.state, createdAt: task.createdAt, updatedAt: task.updatedAt,
    dueAt: task.condition.kind === 'at' ? task.condition.at : task.condition.kind === 'delay' ? (task.waitAt ?? task.createdAt) + task.condition.delayMs : null,
    startedAt: null, finishedAt: null, instruction: task.instruction.length > 2000 ? task.instruction.slice(0, 2000) + '…（长指令仅显示摘要）' : task.instruction, taskDeleted: false, runId: task.runId, lastError: task.lastError }
}
export function deletedTaskListItem(run: SimulationTaskRun, simulationRunId: string): ConversationTaskListItem {
  return { id: run.taskId, title: run.title ?? '已删除的临时任务', origin: 'simulation', simulationRunId, conversationId: run.conversationId,
    state: run.state, createdAt: run.startedAt, updatedAt: run.finishedAt ?? run.startedAt, dueAt: null,
    startedAt: run.startedAt, finishedAt: run.finishedAt, instruction: null, taskDeleted: true, runId: run.id, lastError: null }
}
export function parseSimulationTaskList(value: unknown): { items: readonly ConversationTaskListItem[]; limited: boolean; unavailableRuns: number } | null {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 160 || typeof value.limited !== 'boolean'
    || !Number.isInteger(value.unavailableRuns) || Number(value.unavailableRuns) < 0 || Number(value.unavailableRuns) > 4) return null
  const items: ConversationTaskListItem[] = []
  for (const row of value.items) {
    if (!isRecord(row) || !reference(row.id) || typeof row.title !== 'string' || row.title.length > 160
      || row.origin !== 'simulation' || !validSimulationRunId(row.simulationRunId)
      || row.conversationId !== null && !reference(row.conversationId)
      || !['waiting', 'running', 'paused', 'completed', 'failed', 'rejected', 'unknown', 'cancelled', 'expired', 'blocked'].includes(String(row.state))
      || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.updatedAt)
      || [row.dueAt, row.startedAt, row.finishedAt].some(at => at !== null && (!Number.isSafeInteger(at) || Number(at) < 0))
      || row.instruction !== null && (typeof row.instruction !== 'string' || row.instruction.length > 16000)
      || typeof row.taskDeleted !== 'boolean' || row.runId !== null && !reference(row.runId)
      || row.lastError !== null && !reference(row.lastError)) return null
    items.push(row as unknown as ConversationTaskListItem)
  }
  return { items, limited: value.limited, unavailableRuns: Number(value.unavailableRuns) }
}
