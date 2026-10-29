import { randomUUID } from 'node:crypto'
import type { DurableCasMutation, DurableStore, StoredRecord } from '../contracts/ports.ts'
import type { JsonObject, JsonValue } from '../contracts/data.ts'
import { parseConversationTaskInput, parseTaskCondition, parseConversationTask, type ConversationTask, type ConversationTaskInput,
  type TaskCondition, type TaskEvent, type TaskOrigin, type TaskOutcome, type TaskRun } from '../contracts/conversation-tasks.ts'
import { assert, errorCode, isRecord, reference, snapshot } from '../core/values.ts'
import { digest, json } from './data.ts'
import { nextCalendarTriggerAt } from './triggers.ts'
import { withDeadline } from './deadlines.ts'

const tasks = 'conversation-tasks.tasks', runs = 'conversation-tasks.runs', events = 'conversation-tasks.events'
const roots = 'conversation-tasks.budgets', proposals = 'conversation-tasks.proposals', receipts = 'conversation-tasks.receipts'
const terminal = new Set(['completed', 'failed', 'cancelled', 'expired'])
const retention = 7 * 86400000
export interface ConversationTaskExecutor {
  readonly version: 1
  execute(task: ConversationTask, run: TaskRun, signal: AbortSignal): Promise<TaskOutcome>
  inspect(task: ConversationTask, run: TaskRun, signal: AbortSignal): Promise<TaskOutcome | null>
  cancel?(task: ConversationTask, run: TaskRun, signal: AbortSignal): Promise<void>
}
function taskOf(row: StoredRecord): ConversationTask {
  const parsed = parseConversationTask({ ...row.value as JsonObject, revision: row.revision })
  assert(parsed, 'TASK_STORED_INVALID', 'Task state is invalid.')
  return snapshot(parsed)
}
export function readConversationTasks(store: Pick<DurableStore, 'read' | 'list'>, conversationId?: string, after?: string, limit = 20) {
  assert(Number.isSafeInteger(limit) && limit > 0 && limit <= 200, 'TASK_INVALID_PAGE', 'Invalid task page.')
  const selected = store.list(tasks, { limit: 1000 }).map(taskOf).filter(task => (!conversationId || task.origin.binding.conversationId === conversationId) && (!after || task.id > after))
  return { items: selected.slice(0, limit), next: selected.length > limit ? selected[limit - 1]!.id : null }
}
export function readConversationTaskHistory(store: Pick<DurableStore, 'list' | 'lookup'>, taskId: string) {
  const rows: StoredRecord[] = [...(store.lookup?.({ namespace: runs, field: 'taskId', equals: taskId, limit: 1000 }) ?? [])]
  if (!store.lookup) {
    let after: string | undefined
    for (let page = 0; page < 100; page++) {
      const batch = store.list(runs, { limit: 1000, ...(after ? { after } : {}) })
      rows.push(...batch.filter(row => isRecord(row.value) && row.value.taskId === taskId))
      if (batch.length < 1000 || rows.length >= 1000) break
      after = batch.at(-1)!.key
    }
  }
  return rows.map(row => row.value as unknown as TaskRun).sort((a, b) => b.startedAt - a.startedAt).slice(0, 100)
}
/** Durable state machine. Executors own external effects; a lease alone never proves they did not run. */
export function createConversationTaskRuntime(options: {
  readonly store: DurableStore
  readonly clock?: () => number
  readonly concurrency?: number
  readonly leaseMs?: number
  readonly authorize: (origin: TaskOrigin, signal: AbortSignal) => Promise<void>
  readonly ready: (task: ConversationTask) => boolean
  readonly onFault?: (code: string) => void
}) {
  const { store } = options, now = options.clock ?? Date.now, owner = randomUUID()
  const concurrency = options.concurrency ?? 4, leaseMs = options.leaseMs ?? 30000
  assert(Number.isSafeInteger(concurrency) && concurrency > 0 && concurrency <= 32 && leaseMs >= 1000,
    'TASK_INVALID_OPTIONS', 'Bounded task execution is required.')
  assert(store.compareAndSetBatch, 'TASK_ATOMIC_STORAGE_REQUIRED', 'Task transitions require atomic CAS storage.')
  store.createIndex?.({ namespace: runs, field: 'taskId' })
  const executors = new Map<string, ConversationTaskExecutor>()
  const rawPending = new Set<Promise<TaskOutcome>>()
  const active = new Map<string, { controller: AbortController; work: Promise<void> }>()
  let timer: ReturnType<typeof setInterval> | undefined, stopped = true, sweeping = false
  const lifetime = new AbortController()
  function batch(mutations: readonly DurableCasMutation[]) { return store.compareAndSetBatch!(mutations) }
  function get(id: string) { const row = store.read(tasks, id); return row ? taskOf(row) : null }
  function exact(id: string, revision: number) {
    const row = store.read(tasks, id)
    assert(row && row.revision === revision, 'TASK_CONFLICT', 'Read the current task revision before changing it.')
    return { row, task: taskOf(row) }
  }
  function update(row: StoredRecord, changes: JsonObject) {
    return store.write(tasks, row.key, { ...row.value as JsonObject, ...changes, updatedAt: now() }, { expectedRevision: row.revision })
  }
  function scope(origin: TaskOrigin) { return digest([origin.binding.accountScope ?? null, origin.binding.conversationId]) }
  function records(namespace: string) { return store.list(namespace, { limit: 1000 }) }
  function cancelledAncestor(task: ConversationTask) {
    let parent = task.parentId
    for (let count = 0; parent && count < 512; count++) {
      const ancestor = get(parent)
      if (!ancestor || ancestor.state === 'cancelled') return true
      parent = ancestor.parentId
    }
    return parent !== null
  }
  function dependencies(condition: TaskCondition): string[] {
    return condition.kind === 'task' ? [condition.taskId] : condition.kind === 'all' || condition.kind === 'any'
      ? condition.conditions.flatMap(dependencies) : []
  }
  function validateDependencies(condition: TaskCondition, origin: TaskOrigin, self?: string) {
    const visit = (id: string, seen: Set<string>) => {
      assert(id !== self && !seen.has(id) && seen.size < 64, 'TASK_DEPENDENCY_CYCLE', 'Task dependencies must be acyclic and bounded.')
      const dependency = get(id)
      assert(dependency && scope(dependency.origin) === scope(origin), 'TASK_DEPENDENCY_UNAVAILABLE', 'Dependencies belong to this conversation.')
      const next = new Set(seen).add(id)
      for (const child of dependencies(dependency.condition)) visit(child, next)
    }
    for (const id of dependencies(condition)) visit(id, new Set())
  }
  function newTask(input: ConversationTaskInput, origin: TaskOrigin, id: string, rootId = id, parentId: string | null = null): ConversationTask {
    return { ...input, schema: 1, id, rootId, parentId, origin: snapshot(origin), state: 'waiting', generation: 1, revision: 0,
      createdAt: now(), updatedAt: now(), steps: 0, checkpoint: {}, result: null, lastError: null, runId: null }
  }
  async function create(value: unknown, origin: TaskOrigin, operationId: string, parentId?: string, signal = lifetime.signal) {
    signal.throwIfAborted(); const input = parseConversationTaskInput(value)
    assert(reference(operationId) && reference(origin.actorId) && reference(origin.sourceMessageId), 'TASK_INVALID_ORIGIN', 'A trusted creation source is required.')
    const id = digest([scope(origin), operationId]), previous = get(id)
    if (previous) {
      const original = store.read(tasks, id)!.value as JsonObject
      assert(original.inputHash === digest(input),
        'TASK_IDEMPOTENCY_CONFLICT', 'The operation identity already names different task input.')
      return previous
    }
    assert(!store.read(receipts, id), 'TASK_OPERATION_RETIRED', 'This creation operation has already ended.')
    await options.authorize(origin, signal); signal.throwIfAborted()
    assert(input.deadlineAt > now() && input.deadlineAt <= now() + 366 * 86400000, 'TASK_INVALID_DEADLINE', 'A task needs a future deadline within one year.')
    assert(executors.has(input.executor), 'TASK_EXECUTOR_UNAVAILABLE', 'The selected executor is not registered.')
    const all = records(tasks).map(taskOf)
    assert(all.length < 512 && all.filter(task => scope(task.origin) === scope(origin) && !terminal.has(task.state)).length < 64,
      'TASK_CAPACITY', 'The task capacity has been reached.')
    validateDependencies(input.condition, origin)
    const parent = parentId ? get(parentId) : null
    assert(!parentId || parent && scope(parent.origin) === scope(origin) && parent.origin.actorId === origin.actorId && parent.state === 'running' && !cancelledAncestor(parent),
      'TASK_PARENT_UNAVAILABLE', 'A child must belong to the active parent task.')
    const task = newTask(input, origin, id, parent?.rootId ?? id, parent?.id ?? null)
    const root = parent ? store.read(roots, parent.rootId) : null
    assert(!parent || root && isRecord(root.value) && Number(root.value.created) < Number(root.value.limit)
      && input.deadlineAt <= parent.deadlineAt, 'TASK_BUDGET_EXHAUSTED', 'Child tasks share their root budget and deadline.')
    batch([{ kind: 'write', namespace: tasks, key: id, expectedRevision: null, value: json({ ...task, inputHash: digest(input), waitAt: now() }) },
      { kind: 'write', namespace: receipts, key: id, expectedRevision: null, value: { inputHash: digest(input) }, expiresAt: input.deadlineAt + retention },
      { kind: 'write', namespace: roots, key: task.rootId, expectedRevision: root?.revision ?? null,
        value: root ? { ...root.value as JsonObject, created: Number((root.value as JsonObject).created) + 1 }
          : { limit: input.maxSteps, steps: 0, created: 1 } }])
    return get(id)!
  }
  function emit(origin: TaskOrigin, topic: string, key: string, payload: JsonValue, operationId: string) {
    assert(reference(topic) && reference(key) && reference(operationId) && JSON.stringify(payload).length <= 32000,
      'TASK_INVALID_EVENT', 'A bounded correlated event is required.')
    const id = digest([scope(origin), topic, key, operationId]), existing = store.read(events, id)
    if (existing) return
    assert(records(events).length < 1000, 'TASK_EVENT_CAPACITY', 'Event history requires maintenance before accepting more events.')
    const event: TaskEvent = { id, conversationId: origin.binding.conversationId, topic, key, at: now(), payload }
    const expiresAt = records(tasks).map(taskOf).filter(task => scope(task.origin) === scope(origin) && !terminal.has(task.state))
      .reduce((until, task) => Math.max(until, task.deadlineAt + retention), now() + retention)
    store.write(events, id, json({ ...event, scope: scope(origin) }), { expectedRevision: null, expiresAt })
  }
  function matches(task: ConversationTask, condition: TaskCondition, evidence: TaskEvent[], cursors: JsonObject, waitAt: number): boolean {
    if (condition.kind === 'at') return condition.at <= now()
    if (condition.kind === 'delay') return waitAt + condition.delayMs <= now()
    if (condition.kind === 'daily') {
      const at = nextCalendarTriggerAt({ schedule: { kind: 'daily', hour: condition.hour, minute: condition.minute }, timeZone: condition.timeZone,
        dst: { overlap: 'earlier', nonexistent: 'skip' } }, waitAt)
      return at !== null && at <= now()
    }
    if (condition.kind === 'task') {
      const dependency = get(condition.taskId)
      if (!dependency || scope(dependency.origin) !== scope(task.origin) || !terminal.has(dependency.state)) return false
      if (Number(cursors[digest(['task.completed', dependency.id])] ?? 0) >= dependency.generation) return false
      evidence.push({ sequence: dependency.generation, id: `task:${dependency.id}:${dependency.generation}`, conversationId: task.origin.binding.conversationId,
        topic: 'task.completed', key: dependency.id, at: dependency.updatedAt, payload: json({ state: dependency.state, result: dependency.result }) })
      return true
    }
    if (condition.kind === 'event') {
      const matching = records(events).filter(row => isRecord(row.value) && row.value.scope === scope(task.origin)
        && row.value.topic === condition.topic && row.value.key === condition.key && Number(row.value.at) >= task.createdAt
        && row.revision > Number(cursors[digest([condition.topic, condition.key])] ?? 0)).sort((a, b) => a.revision - b.revision)[0]
      if (!matching) return false
      evidence.push({ ...matching.value as unknown as TaskEvent, sequence: matching.revision }); return true
    }
    const collected: TaskEvent[] = []
    for (const child of condition.conditions) {
      const part: TaskEvent[] = [], matched = matches(task, child, part, cursors, waitAt)
      if (condition.kind === 'any' && matched) { evidence.push(...part); return true }
      if (condition.kind === 'all' && !matched) return false
      collected.push(...part)
    }
    if (condition.kind === 'all') { evidence.push(...collected); return true }
    return false
  }
  function assertCurrent(task: ConversationTask, run: TaskRun) {
    const current = get(task.id), record = store.read(runs, run.id)
    assert(current?.state === 'running' && !cancelledAncestor(current) && current.generation === run.generation && current.runId === run.id
      && record && isRecord(record.value) && record.value.owner === owner && record.value.state === 'running'
      && Number(record.value.leaseUntil) > now(), 'TASK_STALE_EXECUTION', 'The execution lease is no longer current.')
    return { task: current, runRow: record }
  }
  function finish(task: ConversationTask, run: TaskRun, outcome: TaskOutcome) {
    const current = assertCurrent(task, run), row = store.read(tasks, task.id)!
    assert(JSON.stringify(outcome).length <= 64000, 'TASK_RESULT_CAPACITY', 'Task results must be bounded.')
    const next: JsonObject = { ...row.value as JsonObject, updatedAt: now(), lastError: null }
    const mutations: DurableCasMutation[] = []
    if (outcome.status === 'completed') {
      if (outcome.wait) { parseTaskCondition(outcome.wait); validateDependencies(outcome.wait, task.origin, task.id) }
      const wait = outcome.wait ?? (task.condition.kind === 'daily' ? task.condition : undefined)
      next.state = wait ? 'waiting' : 'completed'; next.result = outcome.result
      next.checkpoint = outcome.checkpoint ?? current.task.checkpoint
      if (wait) { next.condition = json(wait); next.generation = task.generation + 1; next.waitAt = now() }
      const cursors: JsonObject = isRecord(row.value) && isRecord(row.value.eventCursors) ? { ...row.value.eventCursors } as JsonObject : {}
      for (const event of run.evidence) if (event.sequence !== undefined) cursors[digest([event.topic, event.key])] = event.sequence
      assert(Object.keys(cursors).length <= 128, 'TASK_CONDITION_CAPACITY', 'A task can observe at most 128 distinct event correlations.')
      next.eventCursors = cursors
      const children = outcome.children ?? []
      assert(children.length <= 8 && records(tasks).length + children.length <= 512
        && records(tasks).map(taskOf).filter(candidate => scope(candidate.origin) === scope(task.origin) && !terminal.has(candidate.state)).length + children.length <= 64, 'TASK_CAPACITY', 'Too many child tasks.')
      const budget = store.read(roots, task.rootId)!
      assert(isRecord(budget.value) && Number(budget.value.created) + children.length <= Number(budget.value.limit), 'TASK_BUDGET_EXHAUSTED', 'The shared task budget is exhausted.')
      children.forEach((input, index) => {
        const parsed = parseConversationTaskInput(input), id = digest([run.id, 'child', index])
        assert(parsed.deadlineAt <= task.deadlineAt && parsed.deadlineAt > now() && executors.has(parsed.executor), 'TASK_INVALID_CHILD', 'Child limits must fit the parent.')
        validateDependencies(parsed.condition, task.origin)
        mutations.push({ kind: 'write', namespace: tasks, key: id, expectedRevision: null,
          value: json({ ...newTask(parsed, task.origin, id, task.rootId, task.id), waitAt: now(), inputHash: digest(parsed) }) })
      })
      if (children.length) mutations.push({ kind: 'write', namespace: roots, key: task.rootId, expectedRevision: budget.revision,
        value: { ...budget.value, created: Number(budget.value.created) + children.length } })
    } else {
      const retry = outcome.status === 'rejected' && outcome.retryAt !== undefined && outcome.retryAt >= now() + 1000 && outcome.retryAt < task.deadlineAt
      next.state = outcome.status === 'unknown' ? 'unknown' : retry ? 'waiting' : 'failed'
      next.lastError = /^[A-Z][A-Z_]{1,95}$/.test(outcome.code) ? outcome.code : 'TASK_EXECUTOR_FAILED'
      if (retry) {
        next.condition = json({ kind: 'at', at: outcome.retryAt }); next.generation = task.generation + 1
      }
    }
    mutations.push({ kind: 'write', namespace: tasks, key: task.id, expectedRevision: row.revision, value: next },
      { kind: 'write', namespace: runs, key: run.id, expectedRevision: current.runRow.revision,
        value: json({ ...current.runRow.value as JsonObject, state: outcome.status, outcome, finishedAt: now() }),
        expiresAt: outcome.status === 'unknown' ? null : now() + retention })
    batch(mutations)
    const activation = store.read('conversation-tasks.activations', run.id)
    if (activation && outcome.status !== 'unknown') store.write(activation.namespace, activation.key, activation.value, { expectedRevision: activation.revision, expiresAt: now() + retention })
    if (outcome.status !== 'unknown') {
      const proposal = store.read(proposals, run.id)
      if (proposal) store.delete(proposals, run.id, proposal.revision)
    }
  }
  async function execute(task: ConversationTask, run: TaskRun, controller: AbortController) {
    let submitted = false
    const heartbeat = setInterval(() => {
      try { const current = assertCurrent(task, run); store.write(runs, run.id,
        { ...current.runRow.value as JsonObject, leaseUntil: now() + leaseMs }, { expectedRevision: current.runRow.revision }) }
      catch { controller.abort() }
    }, Math.max(250, Math.floor(leaseMs / 3)))
    heartbeat.unref()
    try {
      await options.authorize(task.origin, controller.signal); assertCurrent(task, run); controller.signal.throwIfAborted()
      const executor = executors.get(task.executor)!
      submitted = true
      const outcome = await withDeadline({ signal: controller.signal, timeoutMs: Math.max(1, Math.min(task.deadlineAt - now(), 300000)),
        code: 'TASK_EXECUTION_TIMEOUT_UNKNOWN', run: signal => {
          const pending = Promise.resolve().then(() => executor.execute(task, run, signal))
          rawPending.add(pending)
          const release = () => { rawPending.delete(pending) }
          pending.then(release, release)
          return pending
        } })
      const proposed = store.read(proposals, run.id)
      finish(task, run, outcome.status === 'completed' && proposed ? proposed.value as unknown as TaskOutcome : outcome)
    } catch (error) {
      try { finish(task, run, { status: submitted ? 'unknown' : 'rejected', code: errorCode(error, submitted ? 'TASK_EXECUTION_UNKNOWN' : 'TASK_ADMISSION_REJECTED') }) }
      catch { /* A newer task generation owns the state; the old run remains queryable. */ }
    } finally { clearInterval(heartbeat); active.delete(task.id) }
  }
  async function recover(task: ConversationTask, signal: AbortSignal) {
    assert(!cancelledAncestor(task), 'TASK_PARENT_CANCELLED', 'The parent task was cancelled.')
    assert(task.runId, 'TASK_NO_EXECUTION', 'There is no execution to reconcile.')
    const row = store.read(runs, task.runId)
    assert(row && isRecord(row.value), 'TASK_RUN_MISSING', 'The original execution record is required.')
    const run = row.value as unknown as TaskRun
    if (run.state === 'running' && run.leaseUntil > now() && run.owner !== owner || active.has(task.id)) return false
    const executor = executors.get(task.executor)
    assert(executor, 'TASK_EXECUTOR_UNAVAILABLE', 'Restore the original execution backend before reconciliation.')
    await options.authorize(task.origin, signal)
    const outcome = await withDeadline({ signal, timeoutMs: 5000, code: 'TASK_INSPECTION_TIMEOUT', run: signal => executor.inspect(task, run, signal) })
    if (!outcome || outcome.status === 'unknown') {
      const current = store.read(tasks, task.id)
      if (current?.revision === task.revision && task.state === 'running') update(current, { state: 'unknown', lastError: 'TASK_EXECUTION_UNKNOWN' })
      return false
    }
    const current = exact(task.id, task.revision), nextRun = { ...run, owner, state: 'running' as const, leaseUntil: now() + leaseMs }
    batch([{ kind: 'write', namespace: tasks, key: task.id, expectedRevision: current.row.revision,
      value: { ...current.row.value as JsonObject, state: 'running' } },
    { kind: 'write', namespace: runs, key: run.id, expectedRevision: row.revision, value: json(nextRun) }])
    const proposed = store.read(proposals, run.id)
    finish(get(task.id)!, nextRun, outcome.status === 'completed' && proposed ? proposed.value as unknown as TaskOutcome : outcome)
    return true
  }
  async function tick() {
    if (stopped || sweeping) return
    sweeping = true
    try {
      let inspectedCancellation = false
      const heldSessions = new Set(records(tasks).map(taskOf).filter(task => ['running', 'unknown'].includes(task.state)).map(task => task.origin.binding.sessionId))
      for (const row of records(tasks)) {
        if (stopped) break
        const task = taskOf(row)
        if (task.state === 'cancelled' && task.runId && !active.has(task.id) && !inspectedCancellation) {
          const record = store.read(runs, task.runId), executor = executors.get(task.executor)
          if (record && isRecord(record.value) && ['running', 'unknown'].includes(String(record.value.state)) && executor) {
            inspectedCancellation = true
            try {
              const outcome = await withDeadline({ signal: lifetime.signal, timeoutMs: 5000, code: 'TASK_INSPECTION_TIMEOUT',
                run: signal => executor.inspect(task, record.value as unknown as TaskRun, signal) })
              if (outcome && outcome.status !== 'unknown') {
                store.write(runs, record.key, json({ ...record.value, state: 'cancelled', outcome, finishedAt: now() }),
                  { expectedRevision: record.revision, expiresAt: now() + retention })
                const proposal = store.read(proposals, record.key); if (proposal) store.delete(proposals, record.key, proposal.revision)
                const activation = store.read('conversation-tasks.activations', record.key)
                if (activation) store.write(activation.namespace, activation.key, activation.value, { expectedRevision: activation.revision, expiresAt: now() + retention })
              }
            } catch (error) { options.onFault?.(errorCode(error)) }
          }
          continue
        }
        if (task.state === 'running' && !active.has(task.id)) {
          try { await recover(task, AbortSignal.timeout(5000)) } catch (error) { options.onFault?.(errorCode(error)) }
          continue
        }
        if (!terminal.has(task.state) && cancelledAncestor(task)) {
          update(row, { state: 'cancelled', generation: task.generation + 1 }); active.get(task.id)?.controller.abort(); continue
        }
        if (task.state !== 'waiting') continue
        if (task.deadlineAt <= now()) { update(row, { state: 'expired' }); continue }
        if (active.size >= concurrency || rawPending.size >= concurrency || heldSessions.has(task.origin.binding.sessionId) || !options.ready(task)) continue
        if (!executors.has(task.executor)) { update(row, { state: 'blocked', lastError: 'TASK_EXECUTOR_UNAVAILABLE' }); continue }
        const evidence: TaskEvent[] = [], value = row.value as JsonObject
        const cursors = isRecord(value.eventCursors) ? value.eventCursors as JsonObject : {}
        if (!matches(task, task.condition, evidence, cursors, Number(value.waitAt ?? task.createdAt))) continue
        const budget = store.read(roots, task.rootId)
        if (!budget || !isRecord(budget.value) || Number(budget.value.steps) >= Number(budget.value.limit) || task.steps >= task.maxSteps) {
          update(row, { state: 'blocked', lastError: 'TASK_BUDGET_EXHAUSTED' }); continue
        }
        const id = digest([task.id, task.generation, task.steps + 1]), run: TaskRun = { schema: 1, id, taskId: task.id,
          generation: task.generation, owner, state: 'running', leaseUntil: now() + leaseMs, startedAt: now(), finishedAt: null,
          evidence: evidence.slice(0, 32), outcome: null }
        try {
          batch([{ kind: 'write', namespace: tasks, key: task.id, expectedRevision: row.revision,
            value: { ...row.value as JsonObject, state: 'running', runId: id, steps: task.steps + 1, updatedAt: now() } },
          { kind: 'write', namespace: runs, key: id, expectedRevision: null, value: json(run) },
          { kind: 'write', namespace: roots, key: task.rootId, expectedRevision: budget.revision,
            value: { ...budget.value, steps: Number(budget.value.steps) + 1 } }])
        } catch (error) { if (errorCode(error) === 'STORE_CONFLICT') continue; throw error }
        const controller = new AbortController()
        const work = Promise.resolve().then(() => execute(get(task.id)!, run, controller))
        active.set(task.id, { controller, work }); heldSessions.add(task.origin.binding.sessionId)
      }
    } finally { sweeping = false }
  }
  async function control(id: string, revision: number, action: 'pause' | 'resume' | 'cancel' | 'reconcile', signal = lifetime.signal) {
    const { row, task } = exact(id, revision)
    await options.authorize(task.origin, signal); exact(id, revision)
    if (action === 'reconcile') {
      assert(['running', 'unknown'].includes(task.state), 'TASK_RECONCILE_UNAVAILABLE', 'Only unresolved executions can be reconciled.')
      await recover(task, signal); return get(id)!
    }
    if (action === 'resume') {
      assert(['paused', 'blocked'].includes(task.state) && task.deadlineAt > now(), 'TASK_RESUME_UNAVAILABLE', 'Only paused or blocked tasks can resume.')
      update(row, { state: 'waiting', lastError: null })
    } else {
      assert(!terminal.has(task.state), 'TASK_CONTROL_UNAVAILABLE', 'The task has ended.')
      assert(action !== 'pause' || task.state === 'waiting' || task.state === 'blocked', 'TASK_PAUSE_BUSY', 'Cancel an active task or wait for its execution.')
      if (action === 'pause') update(row, { state: 'paused', generation: task.generation + 1 })
      else {
        const all = records(tasks).map(taskOf), affected = new Set([id])
        for (let changed = true; changed;) {
          changed = false
          for (const candidate of all) if (candidate.parentId && affected.has(candidate.parentId) && !affected.has(candidate.id)) {
            affected.add(candidate.id); changed = true
          }
        }
        const targets = all.filter(candidate => affected.has(candidate.id) && !terminal.has(candidate.state))
        // Persist the parent fence first; recovery also cancels descendants after interruption.
        update(row, { state: 'cancelled', generation: task.generation + 1 })
        for (const candidate of targets.filter(candidate => candidate.id !== id)) update(store.read(tasks, candidate.id)!, { state: 'cancelled', generation: candidate.generation + 1 })

        for (const candidate of targets) {
          active.get(candidate.id)?.controller.abort()
          const run = candidate.runId ? store.read(runs, candidate.runId)?.value as unknown as TaskRun | undefined : undefined
          if (run && ['running', 'unknown'].includes(run.state)) {
            try { await withDeadline({ signal, timeoutMs: 5000, code: 'TASK_CANCEL_UNKNOWN',
              run: async signal => { await executors.get(candidate.executor)?.cancel?.(candidate, run, signal) } }) }
            catch (error) { options.onFault?.(errorCode(error)) }
          }
        }
      }
    }
    return get(id)!
  }
  async function remove(id: string, revision: number, signal = lifetime.signal) {
    const { row, task } = exact(id, revision)
    await options.authorize(task.origin, signal); exact(id, revision)
    const run = task.runId ? store.read(runs, task.runId) : null
    assert(terminal.has(task.state) && !active.has(id) && (!run || isRecord(run.value) && !['running', 'unknown'].includes(String(run.value.state))),
      'TASK_DELETE_UNSETTLED', 'End the task and reconcile its execution before deleting it.')
    assert(!records(tasks).map(taskOf).some(other => other.id !== id && !terminal.has(other.state)
      && (other.parentId === id || other.rootId === id || dependencies(other.condition).includes(id))),
      'TASK_DELETE_REFERENCED', 'An unfinished task still depends on this record.')
    const receipt = store.read(receipts, id)
    batch([{ kind: 'delete', namespace: tasks, key: id, expectedRevision: row.revision },
      { kind: 'write', namespace: receipts, key: id, expectedRevision: receipt?.revision ?? null,
        value: { deletedAt: now(), inputHash: (row.value as JsonObject).inputHash ?? null }, expiresAt: Math.max(now(), task.deadlineAt) + retention }])
    return { id, deleted: true as const }
  }
  async function replace(id: string, revision: number, input: unknown, origin: TaskOrigin, signal = lifetime.signal) {
    const { row, task } = exact(id, revision), next = parseConversationTaskInput(input)
    assert(['waiting', 'paused', 'blocked', 'failed', 'expired'].includes(task.state), 'TASK_UPDATE_BUSY', 'Settle active or unknown executions before replacing a task.')
    assert(scope(task.origin) === scope(origin) && origin.actorId === task.origin.actorId, 'TASK_ORIGIN_CHANGED', 'Task ownership cannot change.')
    await options.authorize(origin, signal); exact(id, revision)
    assert(next.deadlineAt > now() && next.deadlineAt <= task.deadlineAt && next.maxSteps <= task.maxSteps
      && executors.has(next.executor), 'TASK_UPDATE_LIMITS', 'An update must fit the original budget and deadline.')
    validateDependencies(next.condition, origin, id)
    update(row, { ...json(next) as JsonObject, origin: json(origin), state: task.state === 'paused' ? 'paused' : 'waiting',
      generation: task.generation + 1, waitAt: now(), lastError: null })
    return get(id)!
  }
  function propose(id: string, runId: string, outcome: Extract<TaskOutcome, { status: 'completed' }>) {
    const task = get(id), run = store.read(runs, runId)?.value as unknown as TaskRun | undefined
    assert(task && run, 'TASK_NOT_FOUND', 'A current execution is required.'); assertCurrent(task, run)
    if (outcome.wait) { parseTaskCondition(outcome.wait); validateDependencies(outcome.wait, task.origin, id) }
    assert(JSON.stringify(outcome).length <= 64000, 'TASK_RESULT_CAPACITY', 'Task continuation is too large.')
    const previous = store.read(proposals, runId)
    store.write(proposals, runId, json(outcome), { expectedRevision: previous?.revision ?? null, expiresAt: null })
  }
  function maintain() {
    const all = records(tasks).map(taskOf)
    for (const task of all) {
      if (!terminal.has(task.state) || task.updatedAt >= now() - retention
        || all.some(other => !terminal.has(other.state) && (other.parentId === task.id || other.rootId === task.id || dependencies(other.condition).includes(task.id)))) continue
      const run = task.runId ? store.read(runs, task.runId) : null
      if (run && isRecord(run.value) && ['unknown', 'running'].includes(String(run.value.state))) continue
      for (const namespace of [proposals, 'conversation-tasks.activations']) if (task.runId) {
        const record = store.read(namespace, task.runId); if (record) store.delete(namespace, task.runId, record.revision)
      }
      store.delete(tasks, task.id, task.revision)
    }
    const remaining = records(tasks).map(taskOf)
    for (const row of records(roots)) if (!remaining.some(task => task.rootId === row.key)) store.delete(roots, row.key, row.revision)
  }
  return Object.freeze({ create, get, emit, tick, control, remove, replace, propose, maintain,
    register(name: string, executor: ConversationTaskExecutor) {
      assert(reference(name) && executor.version === 1 && !executors.has(name), 'TASK_EXECUTOR_CONFLICT', 'Executor registration is versioned and unique.')
      executors.set(name, executor); return () => { executors.delete(name) }
    },
    list(conversationId?: string, after?: string, limit = 20) { return readConversationTasks(store, conversationId, after, limit) },
    history(taskId: string) { return readConversationTaskHistory(store, taskId) },
    start() { if (!stopped) return; stopped = false; timer = setInterval(() => { void tick().catch(error => options.onFault?.(errorCode(error))) }, 1000); timer.unref() },
    async stop() { stopped = true; clearInterval(timer); lifetime.abort(); for (const entry of active.values()) entry.controller.abort(); await Promise.allSettled([...active.values()].map(entry => entry.work)) },
    status() { return { running: !stopped, active: active.size, rawPending: rawPending.size, concurrency, executors: [...executors.keys()] } }
  })
}
export type ConversationTaskRuntime = ReturnType<typeof createConversationTaskRuntime>
