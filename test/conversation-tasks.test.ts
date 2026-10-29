import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createConversationTaskRuntime, type ConversationTaskExecutor } from '../src/host/conversation-tasks.ts'
import type { ConversationTaskInput, TaskOrigin, TaskOutcome } from '../src/contracts/conversation-tasks.ts'
const initial = Date.parse('2026-01-01T00:00:00Z')
const origin: TaskOrigin = { binding: { conversationId: 'group:123', sessionId: 'session-test', generation: 1 }, actorId: '456', sourceMessageId: 'message-test' }
const input = (changes: Partial<ConversationTaskInput> = {}): ConversationTaskInput => ({ title: '任务', instruction: '按委托执行', executor: 'test',
  context: {}, maxSteps: 10, deadlineAt: initial + 86400000, condition: { kind: 'delay', delayMs: 1000 }, ...changes })
function fixture(t: TestContext, executor: ConversationTaskExecutor) {
  let at = initial
  const store = createSqliteStore({ filename: ':memory:', clock: () => at })
  const runtime = createConversationTaskRuntime({ store, clock: () => at, authorize: async () => {}, ready: () => true })
  runtime.register('test', executor); runtime.start()
  t.after(async () => { await runtime.stop(); store.close() })
  return { store, runtime, advance(ms: number) { at += ms } }
}
async function settle() { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)) }

test('time tasks are durable, idempotent and bounded by deadlines; stale updates cannot overwrite newer state', async t => {
  let calls = 0
  const f = fixture(t, { version: 1, async execute() { calls++; return { status: 'completed', result: 'done' } }, async inspect() { return null } })
  const task = await f.runtime.create(input(), origin, 'op-one')
  assert.equal((await f.runtime.create(input(), origin, 'op-one')).id, task.id)
  await assert.rejects(f.runtime.create(input({ title: 'changed' }), origin, 'op-one'), { code: 'TASK_IDEMPOTENCY_CONFLICT' })
  await f.runtime.tick(); await settle(); assert.equal(calls, 0)
  f.advance(1000); await f.runtime.tick(); await settle()
  assert.equal(calls, 1); assert.equal(f.runtime.get(task.id)?.state, 'completed')
  await f.runtime.tick(); assert.equal(calls, 1)
  await assert.rejects(f.runtime.control(task.id, task.revision, 'cancel'), { code: 'TASK_CONFLICT' })
})

test('events arriving before wait registration are consumed once, with scope isolation and all-condition joins', async t => {
  let calls = 0
  const f = fixture(t, { version: 1, async execute(task) { calls++; return { status: 'completed', result: calls, wait: task.condition } }, async inspect() { return null } })
  const task = await f.runtime.create(input({ condition: { kind: 'all', conditions: [{ kind: 'event', topic: 'ready', key: 'job' }, { kind: 'delay', delayMs: 1000 }] } }), origin, 'events')
  f.runtime.emit({ ...origin, binding: { ...origin.binding, conversationId: 'group:789' } }, 'ready', 'job', {}, 'foreign')
  f.advance(1000); await f.runtime.tick(); await settle(); assert.equal(calls, 0)
  f.runtime.emit(origin, 'ready', 'job', { ok: true }, 'first')
  await f.runtime.tick(); await settle(); assert.equal(calls, 1)
  f.advance(1000); await f.runtime.tick(); await settle(); assert.equal(calls, 1)
  f.runtime.emit(origin, 'ready', 'job', {}, 'first'); await f.runtime.tick(); await settle(); assert.equal(calls, 1)
  f.runtime.emit(origin, 'ready', 'job', {}, 'second'); await f.runtime.tick(); await settle(); assert.equal(calls, 2)
  assert.equal(f.runtime.get(task.id)?.state, 'waiting')
})

test('unknown execution is inspected without resubmission and checkpoints apply only after confirmation', async t => {
  let calls = 0, confirmed = false
  const f = fixture(t, { version: 1, async execute(task, run) {
    calls++; f.runtime.propose(task.id, run.id, { status: 'completed', result: 'saved', checkpoint: { stage: 2 }, wait: { kind: 'event', topic: 'answer', key: 'question' } })
    return { status: 'unknown', code: 'RESULT_UNKNOWN' }
  }, async inspect() { return confirmed ? { status: 'completed', result: 'observed' } : null } })
  const task = await f.runtime.create(input(), origin, 'unknown')
  f.advance(1000); await f.runtime.tick(); await settle()
  assert.equal(f.runtime.get(task.id)?.state, 'unknown'); assert.deepEqual(f.runtime.get(task.id)?.checkpoint, {})
  await f.runtime.tick(); await settle(); assert.equal(calls, 1)
  confirmed = true
  await f.runtime.control(task.id, f.runtime.get(task.id)!.revision, 'reconcile')
  assert.equal(f.runtime.get(task.id)?.state, 'waiting'); assert.deepEqual(f.runtime.get(task.id)?.checkpoint, { stage: 2 })
  assert.equal(calls, 1)
})

test('cancelling a running parent fences late results and cancels its children', async t => {
  let resolve!: (value: TaskOutcome) => void
  const f = fixture(t, { version: 1, execute: async () => new Promise<TaskOutcome>(done => { resolve = done }), async inspect() { return null } })
  const task = await f.runtime.create(input(), origin, 'parent')
  f.advance(1000); await f.runtime.tick(); await settle()
  const child = await f.runtime.create(input(), origin, 'child', task.id)
  await f.runtime.control(task.id, f.runtime.get(task.id)!.revision, 'cancel')
  resolve({ status: 'completed', result: 'late', wait: { kind: 'delay', delayMs: 1000 } }); await settle()
  assert.equal(f.runtime.get(task.id)?.state, 'cancelled'); assert.equal(f.runtime.get(child.id)?.state, 'cancelled')
  await assert.rejects(f.runtime.control(task.id, f.runtime.get(task.id)!.revision, 'reconcile'), { code: 'TASK_RECONCILE_UNAVAILABLE' })
})

test('terminal history expires while a durable creation receipt prevents replay', async t => {
  const f = fixture(t, { version: 1, async execute() { return { status: 'completed', result: null } }, async inspect() { return null } })
  const configuration = input({ deadlineAt: initial + 30 * 86400000 })
  const task = await f.runtime.create(configuration, origin, 'retained')
  f.advance(1000); await f.runtime.tick(); await settle()
  f.advance(8 * 86400000); f.runtime.maintain()
  assert.equal(f.runtime.get(task.id), null)
  await assert.rejects(f.runtime.create(configuration, origin, 'retained'), { code: 'TASK_OPERATION_RETIRED' })
})

test('one model session is serialized while an unrelated session proceeds, and shared budgets stop repetition', async t => {
  let release!: (value: TaskOutcome) => void
  const calls: string[] = []
  const f = fixture(t, { version: 1, async execute(task) {
    calls.push(task.title)
    if (task.title === 'slow') return new Promise<TaskOutcome>(resolve => { release = resolve })
    return { status: 'completed', result: null, wait: { kind: 'delay', delayMs: 1000 } }
  }, async inspect() { return null } })
  await f.runtime.create(input({ title: 'slow' }), origin, 'slow')
  f.advance(1000); await f.runtime.tick(); await settle()
  const other = { ...origin, binding: { ...origin.binding, conversationId: 'group:888', sessionId: 'other-session' } }
  await f.runtime.create(input({ title: 'queued' }), origin, 'same-session')
  const repeated = await f.runtime.create(input({ title: 'independent', maxSteps: 1 }), other, 'independent')
  f.advance(1000); await f.runtime.tick(); await settle()
  assert.deepEqual(calls, ['slow', 'independent'])
  f.advance(1000); await f.runtime.tick(); await settle()
  assert.equal(f.runtime.get(repeated.id)?.lastError, 'TASK_BUDGET_EXHAUSTED')
  release({ status: 'completed', result: null }); await settle()
  await f.runtime.tick(); await settle(); assert(calls.includes('queued'))
})

test('deletion rejects active or unknown tasks and retains a tombstone after settled removal', async t => {
  const f = fixture(t, { version: 1, async execute() { return { status: 'completed', result: null } }, async inspect() { return null } })
  const task = await f.runtime.create(input(), origin, 'delete-one')
  await assert.rejects(f.runtime.remove(task.id, task.revision), { code: 'TASK_DELETE_UNSETTLED' })
  f.advance(1000); await f.runtime.tick(); await settle()
  assert.deepEqual(await f.runtime.remove(task.id, f.runtime.get(task.id)!.revision), { id: task.id, deleted: true })
  assert.equal(f.runtime.list().items.length, 0)
  await assert.rejects(f.runtime.create(input(), origin, 'delete-one'), { code: 'TASK_OPERATION_RETIRED' })
})
