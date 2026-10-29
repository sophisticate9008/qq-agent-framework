import type { EffectAdapter, JsonObject, JsonValue } from '../core/types.ts'
import { assert, isRecord } from '../core/values.ts'
import type { ConversationTaskRuntime } from './conversation-tasks.ts'
import { parseConversationTaskInput, parseTaskCondition } from '../contracts/conversation-tasks.ts'
import type { NativeMessageSourceReader } from './native-message-sources.ts'
import type { NativeToolContribution } from './native-framework-tools.ts'
import type { createBridgeHost } from './bridge.ts'
import { json } from './data.ts'

const object = (properties: JsonObject, required = Object.keys(properties)): JsonObject => ({ type: 'object', additionalProperties: false, properties, required })
const text: JsonObject = { type: 'string', minLength: 1, maxLength: 160 }
const condition: JsonObject = { type: 'object', description: '等待条件：{kind:delay,delayMs:毫秒}；{kind:daily,hour,minute,timeZone}每日循环；{kind:at,at:Unix毫秒}；{kind:event,topic,key}；{kind:task,taskId}；{kind:any或all,conditions:[条件]}。事件的topic和key使用宿主提供的已知来源，例如work.completed配合后台workId。' }
const fields: JsonObject = { title: text, instruction: { type: 'string', minLength: 1, maxLength: 16000 }, condition,
  deadlineAt: { type: 'integer', minimum: 1, description: '任务失效的Unix毫秒时间，必须在未来。' },
  executor: { type: 'string', enum: ['conversation'], description: '在所属会话接续执行。' }, context: { type: 'object' }, maxSteps: { type: 'integer', minimum: 1, maximum: 1000 } }
const specs = [
  ['qbf_task_create', 'native.tasks.create', '创建属于当前会话的持久任务。时间到、事件发生或依赖任务结束后，AI会在原会话继续执行。创建成功才确认已安排。delay从任务保存时开始，确认回复请使用返回的timing.dueAt具体时刻（换算会话时区），不要把原延迟当成回复后的剩余时间。子任务共享原任务预算。', object(fields)],
  ['qbf_task_update', 'native.tasks.update', '修改尚未执行的任务，或显式把已结清任务绑定到当前会话上下文。必须先读取最新revision，保留原预算和截止期限。', object({ id: text, revision: { type: 'integer', minimum: 1 }, configuration: object(fields) })],
  ['qbf_task_list', 'native.tasks.list', '分页查看当前会话的任务、状态、任务编号和revision。', object({ after: { type: 'string' } }, [])],
  ['qbf_task_control', 'native.tasks.control', '按最新revision暂停、恢复、取消或核对任务。delete只删除已结束且执行已核清、没有未结依赖的记录；活跃任务先cancel。reconcile只检查原执行，不重复提交。', object({ id: text, revision: { type: 'integer', minimum: 1 }, action: { enum: ['pause', 'resume', 'cancel', 'reconcile', 'delete'] } })],
  ['qbf_task_continue', 'native.tasks.continue', '仅在任务触发的执行内使用：保存本轮结果和进度，并安排下一次等待。省略wait表示完成；本轮确认完成后原子应用。', object({ result: {}, checkpoint: { type: 'object' }, wait: condition }, ['result', 'checkpoint'])]
] as const
export const CONVERSATION_TASK_TOOLS: readonly NativeToolContribution[] = specs.map(([name, capability, description, parameters]) => ({
  definition: { name, capability, description, parameters, featureId: 'framework-tools', timeoutMs: 15000,
    registrationSource: { origin: 'framework-builtin', ownerId: 'qq-bridge-framework', ownerName: '框架任务运行时', transport: 'native' } },
  validate(value: JsonValue) { assert(isRecord(value), 'TASK_INVALID_INPUT', 'Task tools accept an object.'); return value }
}))
export function createConversationTaskEffects(options: { runtime: () => ConversationTaskRuntime | undefined;
  sources: () => NativeMessageSourceReader | undefined; host: () => ReturnType<typeof createBridgeHost> | undefined }): Readonly<Record<string, EffectAdapter>> {
  const effects: Record<string, EffectAdapter> = {}
  for (const [, capability] of specs) effects[capability] = { async execute(request) {
    const runtime = options.runtime(), reader = options.sources(), binding = options.host()?.sessions.get(request.scope.conversationId)
    assert(runtime && reader && binding, 'TASK_RUNTIME_UNAVAILABLE', 'The task runtime is not available.')
    const source = await reader.lookup(request.scope, request.signal)
    assert(isRecord(request.input), 'TASK_INVALID_INPUT', 'Task input must be an object.')
    const input = request.input
    const allowed = capability === 'native.tasks.create' ? Object.keys(fields) : capability === 'native.tasks.update' ? ['id', 'revision', 'configuration']
      : capability === 'native.tasks.list' ? ['after'] : capability === 'native.tasks.continue' ? ['result', 'checkpoint', 'wait'] : ['id', 'revision', 'action']
    assert(Object.keys(input).every(key => allowed.includes(key)), 'TASK_INVALID_INPUT', 'Unexpected task tool fields.')
    if (capability === 'native.tasks.create') {
      const task = await runtime.create(parseConversationTaskInput(input), { binding, actorId: source.userId,
        sourceMessageId: source.task?.originalMessageId ?? source.sourceMessageId }, request.scope.eventId, source.task?.id, request.signal)
      const dueAt = task.condition.kind === 'delay' ? (task.waitAt ?? task.createdAt) + task.condition.delayMs
        : task.condition.kind === 'at' ? task.condition.at : null
      return json({ ...task, timing: { savedAt: task.createdAt, dueAt, dueAtISO: dueAt === null ? null : new Date(dueAt).toISOString(),
        note: '延迟从保存时开始；确认时说明具体触发时刻。到点后等待会话空闲和模型处理，实际提醒可能稍晚。' } })
    }
    if (capability === 'native.tasks.update') {
      assert(typeof input.id === 'string' && Number.isSafeInteger(input.revision), 'TASK_INVALID_CONTROL', 'A current task version is required.')
      const task = runtime.get(input.id)
      assert(task && task.origin.binding.conversationId === binding.conversationId && (source.userId === task.origin.actorId || source.isOwner),
        'TASK_NOT_FOUND', 'Task management is limited to the current conversation and creator.')
      return json(await runtime.replace(task.id, Number(input.revision), input.configuration,
        { ...task.origin, binding }, request.signal))
    }
    if (capability === 'native.tasks.list') {
      assert(input.after === undefined || typeof input.after === 'string', 'TASK_INVALID_PAGE', 'Invalid cursor.')
      return json(runtime.list(binding.conversationId, input.after as string | undefined))
    }
    if (capability === 'native.tasks.continue') {
      assert(source.task && isRecord(input.checkpoint) && Object.hasOwn(input, 'result'), 'TASK_NOT_ACTIVATED', 'Only an active task can save its continuation.')
      runtime.propose(source.task.id, source.task.runId, { status: 'completed', result: input.result as JsonValue,
        checkpoint: input.checkpoint as JsonObject, ...(input.wait === undefined ? {} : { wait: parseTaskCondition(input.wait) }) })
      return { saved: true, appliesAfterExecution: true }
    }
    assert(typeof input.id === 'string' && Number.isSafeInteger(input.revision)
      && ['pause', 'resume', 'cancel', 'reconcile', 'delete'].includes(String(input.action)), 'TASK_INVALID_CONTROL', 'A current task identity, revision and action are required.')
    const task = runtime.get(input.id)
    assert(task && task.origin.binding.conversationId === binding.conversationId && (task.origin.actorId === source.userId || source.isOwner),
      'TASK_NOT_FOUND', 'Task management is limited to its creator or the configured owner in this conversation.')
    if (input.action === 'delete') return json(await runtime.remove(task.id, Number(input.revision), request.signal))
    return json(await runtime.control(task.id, Number(input.revision), input.action as 'pause' | 'resume' | 'cancel' | 'reconcile', request.signal))
  } }
  return effects
}
