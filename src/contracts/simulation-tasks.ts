import { isRecord, reference } from './values.ts'
import { validSimulationRunId } from './admin-activity.ts'
import { parseConversationTaskPage } from './conversation-tasks.ts'

export interface SimulationTaskRun {
  readonly id: string
  readonly taskId: string
  readonly title: string | null
  readonly conversationId: string | null
  readonly taskDeleted: boolean
  readonly state: 'running' | 'completed' | 'rejected' | 'unknown' | 'cancelled'
  readonly startedAt: number
  readonly finishedAt: number | null
}
export function parseSimulationTasks(value: unknown) {
  if (!isRecord(value) || value.schema !== 1 || !validSimulationRunId(value.runId)
    || !['busy', 'stopped'].includes(String(value.runtimeState)) || !Array.isArray(value.runs) || value.runs.length > 20
    || value.nextRun !== null && !reference(value.nextRun)) return null
  const tasks = parseConversationTaskPage(value.tasks)
  if (!tasks) return null
  const runs: SimulationTaskRun[] = []
  for (const row of value.runs) {
    if (!isRecord(row) || !reference(row.id) || !reference(row.taskId)
      || row.title !== null && (typeof row.title !== 'string' || row.title.length > 160)
      || row.conversationId !== null && !reference(row.conversationId) || typeof row.taskDeleted !== 'boolean'
      || !['running', 'completed', 'rejected', 'unknown', 'cancelled'].includes(String(row.state))
      || !Number.isSafeInteger(row.startedAt) || Number(row.startedAt) < 0
      || row.finishedAt !== null && (!Number.isSafeInteger(row.finishedAt) || Number(row.finishedAt) < Number(row.startedAt))) return null
    runs.push(row as unknown as SimulationTaskRun)
  }
  return { schema: 1 as const, runId: value.runId, runtimeState: value.runtimeState as 'busy' | 'stopped',
    tasks, runs, nextRun: value.nextRun as string | null }
}
