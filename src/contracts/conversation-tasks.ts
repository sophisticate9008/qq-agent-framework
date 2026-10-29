import type { JsonObject, JsonValue } from './data.ts'
import type { SessionBinding } from './ports.ts'
import { isRecord, reference } from './values.ts'
function assert(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new TypeError(`${code}: ${message}`)
}

export type TaskCondition = { readonly kind: 'at'; readonly at: number }
  | { readonly kind: 'delay'; readonly delayMs: number }
  | { readonly kind: 'daily'; readonly hour: number; readonly minute: number; readonly timeZone: string }
  | { readonly kind: 'event'; readonly topic: string; readonly key: string }
  | { readonly kind: 'task'; readonly taskId: string }
  | { readonly kind: 'any' | 'all'; readonly conditions: readonly TaskCondition[] }
export interface ConversationTaskInput {
  readonly title: string
  readonly instruction: string
  readonly condition: TaskCondition
  readonly deadlineAt: number
  readonly executor: string
  readonly context: JsonObject
  readonly maxSteps: number
}
export interface TaskOrigin {
  readonly binding: SessionBinding
  readonly actorId: string
  readonly sourceMessageId: string
}
export type ConversationTaskState = 'waiting' | 'running' | 'paused' | 'completed' | 'failed' | 'unknown' | 'cancelled' | 'expired' | 'blocked'
export interface ConversationTask extends ConversationTaskInput {
  readonly schema: 1
  readonly id: string
  readonly rootId: string
  readonly parentId: string | null
  readonly origin: TaskOrigin
  readonly state: ConversationTaskState
  readonly generation: number
  readonly revision: number
  readonly createdAt: number
  readonly waitAt?: number
  readonly updatedAt: number
  readonly steps: number
  readonly checkpoint: JsonObject
  readonly result: JsonValue
  readonly lastError: string | null
  readonly runId: string | null
}
export interface TaskEvent {
  readonly id: string
  readonly conversationId: string
  readonly topic: string
  readonly key: string
  readonly at: number
  readonly payload: JsonValue
  readonly sequence?: number
}
export interface TaskRun {
  readonly title?: string
  readonly conversationId?: string
  readonly schema: 1
  readonly id: string
  readonly taskId: string
  readonly generation: number
  readonly state: 'running' | 'completed' | 'rejected' | 'unknown' | 'cancelled'
  readonly owner: string
  readonly leaseUntil: number
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly evidence: readonly TaskEvent[]
  readonly outcome: TaskOutcome | null
}
export type TaskOutcome = { readonly status: 'completed'; readonly result: JsonValue; readonly checkpoint?: JsonObject;
  readonly wait?: TaskCondition; readonly children?: readonly ConversationTaskInput[] }
  | { readonly status: 'rejected' | 'unknown'; readonly code: string; readonly retryAt?: number }

const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  assert(Object.keys(value).every(key => keys.includes(key)), 'TASK_INVALID_INPUT', 'Unexpected task fields.')
}
function parseCondition(value: unknown, depth = 0): TaskCondition {
  if (depth === 0) assert(JSON.stringify(value)?.length <= 8000, 'TASK_INVALID_CONDITION', 'Condition size exceeds the limit.')
  assert(isRecord(value) && depth <= 4, 'TASK_INVALID_CONDITION', 'A bounded structured condition is required.')
  if (value.kind === 'at') {
    exact(value, ['kind', 'at']); assert(integer(value.at, 0, 8_639_999_000_000_000), 'TASK_INVALID_CONDITION', 'Invalid due time.')
    return { kind: 'at', at: value.at }
  }
  if (value.kind === 'delay') {
    exact(value, ['kind', 'delayMs']); assert(integer(value.delayMs, 1000, 366 * 86400000), 'TASK_INVALID_CONDITION', 'Invalid delay.')
    return { kind: 'delay', delayMs: value.delayMs }
  }
  if (value.kind === 'daily') {
    exact(value, ['kind', 'hour', 'minute', 'timeZone'])
    assert(integer(value.hour, 0, 23) && integer(value.minute, 0, 59) && typeof value.timeZone === 'string' && value.timeZone.length <= 100,
      'TASK_INVALID_CONDITION', 'A calendar time and timezone are required.')
    const timeZone = new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).resolvedOptions().timeZone
    return { kind: 'daily', hour: value.hour, minute: value.minute, timeZone }
  }
  if (value.kind === 'event') {
    exact(value, ['kind', 'topic', 'key'])
    assert(reference(value.topic) && reference(value.key), 'TASK_INVALID_CONDITION', 'An event topic and correlation key are required.')
    return { kind: 'event', topic: value.topic, key: value.key }
  }
  if (value.kind === 'task') {
    exact(value, ['kind', 'taskId']); assert(reference(value.taskId), 'TASK_INVALID_CONDITION', 'A dependency identity is required.')
    return { kind: 'task', taskId: value.taskId }
  }
  exact(value, ['kind', 'conditions'])
  assert((value.kind === 'any' || value.kind === 'all') && Array.isArray(value.conditions)
    && value.conditions.length > 0 && value.conditions.length <= 8, 'TASK_INVALID_CONDITION', 'Conditions must be bounded.')
  return { kind: value.kind, conditions: value.conditions.map(item => parseCondition(item, depth + 1)) }
}
export function parseTaskCondition(value: unknown): TaskCondition {
  const parsed = parseCondition(value)
  function count(condition: TaskCondition): number { return condition.kind === 'all' || condition.kind === 'any'
    ? condition.conditions.reduce((sum, child) => sum + count(child), 0) : 1 }
  assert(count(parsed) <= 32, 'TASK_INVALID_CONDITION', 'At most 32 leaf conditions can be joined.')
  return parsed
}
export function parseConversationTaskInput(value: unknown): ConversationTaskInput {
  assert(isRecord(value), 'TASK_INVALID_INPUT', 'A task object is required.')
  exact(value, ['title', 'instruction', 'condition', 'deadlineAt', 'executor', 'context', 'maxSteps'])
  assert(typeof value.title === 'string' && value.title.trim().length > 0 && value.title.length <= 160
    && typeof value.instruction === 'string' && value.instruction.trim().length > 0 && value.instruction.length <= 16000
    && integer(value.deadlineAt, 1, 8_639_999_000_000_000) && reference(value.executor)
    && isRecord(value.context) && JSON.stringify(value.context).length <= 16000
    && integer(value.maxSteps, 1, 1000), 'TASK_INVALID_INPUT', 'Task purpose, deadline, executor and budget are required.')
  return { title: value.title, instruction: value.instruction, condition: parseTaskCondition(value.condition), deadlineAt: value.deadlineAt,
    executor: value.executor, context: value.context as JsonObject, maxSteps: value.maxSteps }
}

export function parseConversationTask(value: unknown): ConversationTask | null {
  try {
    if (!isRecord(value) || value.schema !== 1 || !reference(value.id) || !reference(value.rootId)
      || value.parentId !== null && !reference(value.parentId) || !isRecord(value.origin) || !isRecord(value.origin.binding)
      || !reference(value.origin.actorId) || !reference(value.origin.sourceMessageId) || !reference(value.origin.binding.conversationId)
      || !reference(value.origin.binding.sessionId) || !integer(value.origin.binding.generation, 1)
      || !['waiting', 'running', 'paused', 'completed', 'failed', 'unknown', 'cancelled', 'expired', 'blocked'].includes(String(value.state))
      || !integer(value.generation, 1) || !integer(value.revision, 0) || !integer(value.steps, 0)
      || !integer(value.createdAt, 0) || !integer(value.updatedAt, 0) || !isRecord(value.checkpoint)
      || value.waitAt !== undefined && !integer(value.waitAt, 0)
      || !Object.hasOwn(value, 'result') || value.lastError !== null && typeof value.lastError !== 'string'
      || value.runId !== null && !reference(value.runId)) return null
    const input = parseConversationTaskInput(Object.fromEntries(['title', 'instruction', 'condition', 'deadlineAt', 'executor', 'context', 'maxSteps'].map(key => [key, value[key]])))
    return { ...value, ...input } as unknown as ConversationTask
  } catch { return null }
}
export function parseConversationTaskPage(value: unknown): { items: readonly ConversationTask[]; next: string | null } | null {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 200 || value.next !== null && !reference(value.next)) return null
  const items = value.items.map(parseConversationTask)
  return items.some(item => item === null) ? null : { items: items as ConversationTask[], next: value.next as string | null }
}
