import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { JsonObject } from '../src/core/types.ts'
import { createLifecycleHooks, type LifecycleCheckpoint, type LifecycleHookDefinition,
  type LifecycleHookFault } from '../src/host/lifecycle-hooks.ts'

const signal = () => new AbortController().signal
const definition = (extra: Partial<LifecycleHookDefinition> = {}): LifecycleHookDefinition => ({
  id: 'test-hook', checkpoint: 'runtime.starting', kind: 'observe', run() {}, ...extra })

test('lifecycle declarations are inert, copied, immutable and ordered by order then exact id', async () => {
  const seen: string[] = []
  const input = [definition({ id: 'zeta', run() { seen.push('zeta') } }),
    definition({ id: 'alpha', run() { seen.push('alpha') } }),
    definition({ id: 'first', order: -10, run() { seen.push('first') } })]
  const runner = createLifecycleHooks(input)
  input.reverse()
  input[0] = definition({ run() { assert.fail('Mutated input must not run') } })
  assert.deepEqual(seen, [])
  assert(Object.isFrozen(runner))
  const before = runner.describe()
  assert(Object.isFrozen(before.definitions[0]))
  assert.equal('run' in before.definitions[0], false)
  await runner.run('runtime.starting', {}, signal())
  assert.deepEqual(seen, ['first', 'alpha', 'zeta'])
  assert.equal(before.pendingRaw, 0)
  assert.equal(runner.describe().faults, 0)
})

test('lifecycle run deep-snapshots input before asynchronous hooks without exposing mutable caller data', async () => {
  let finish: (() => void) | undefined
  const paused = new Promise<void>(resolve => { finish = resolve })
  const runner = createLifecycleHooks([definition({ id: 'first', async run() { await paused } }),
    definition({ id: 'second', run(request) {
      assert(Object.isFrozen(request))
      assert(Object.isFrozen(request.data))
      assert(Object.isFrozen(request.data.nested))
      assert.deepEqual(request.data, { nested: { value: 'original' } })
      assert.throws(() => { (request.data.nested as JsonObject).value = 'changed' }, TypeError)
    } })])
  const data = { nested: { value: 'original' } }
  const pending = runner.run('runtime.starting', data, signal())
  data.nested.value = 'mutated'
  finish!()
  await pending
})

test('guards fail closed and sanitize errors; observers isolate failures and fault callback errors', async () => {
  const faults: Readonly<LifecycleHookFault>[] = []
  let after = 0
  const runner = createLifecycleHooks([
    definition({ id: 'a-observer', run() { throw new Error('secret-bearing hook failure') } }),
    definition({ id: 'b-guard', kind: 'guard', run() { throw new Error('private body') } }),
    definition({ id: 'c-after', run() { after++ } })], { onFault(fault) { faults.push(fault); throw new Error('private logger') } })
  await assert.rejects(runner.run('runtime.starting', {}, signal()), { code: 'LIFECYCLE_HOOK_GUARD_FAILED' })
  assert.equal(after, 0)
  assert.deepEqual(faults.map(fault => fault.code), ['LIFECYCLE_HOOK_OBSERVE_FAILED', 'LIFECYCLE_HOOK_GUARD_FAILED'])
  assert(Object.isFrozen(faults[0]))
  assert.equal(JSON.stringify(runner.describe()).includes('secret'), false)
  assert.equal(JSON.stringify(runner.describe()).includes('private'), false)
})

test('only four pre-mutation checkpoints accept guards while every declared checkpoint accepts observers', async () => {
  const checkpoints: LifecycleCheckpoint[] = ['runtime.starting', 'runtime.ready', 'runtime.stopping', 'runtime.stopped',
    'message.normalized', 'message.admitted', 'message.rejected', 'agent.submitting', 'agent.submitted',
    'send.before', 'send.after', 'access.changed']
  const guarded: LifecycleCheckpoint[] = ['runtime.starting', 'message.admitted', 'agent.submitting', 'send.before']
  for (const checkpoint of checkpoints) {
    let calls = 0
    await createLifecycleHooks([definition({ checkpoint, run() { calls++ } })]).run(checkpoint, {}, signal())
    assert.equal(calls, 1)
    if (guarded.includes(checkpoint)) {
      await createLifecycleHooks([definition({ checkpoint, kind: 'guard' })]).run(checkpoint, {}, signal())
    } else assert.throws(() => createLifecycleHooks([definition({ checkpoint, kind: 'guard' })]), { code: 'INVALID_LIFECYCLE_HOOKS' })
  }
})

test('invalid fields, unknown checkpoints, duplicate identities, sparse arrays and accessors are rejected without execution', async () => {
  for (const extra of [{ id: '' }, { checkpoint: 'invented' }, { kind: 'execute' }, { order: NaN }, { order: 0.5 },
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 30_001 }, { unexpected: true }, { run: null }]) {
    assert.throws(() => createLifecycleHooks([{ ...definition(), ...extra } as LifecycleHookDefinition]), { code: 'INVALID_LIFECYCLE_HOOKS' })
  }
  assert.throws(() => createLifecycleHooks([definition(), definition()]), { code: 'INVALID_LIFECYCLE_HOOKS' })
  assert.throws(() => createLifecycleHooks(Array.from({ length: 65 }, (_entry, index) => definition({ id: `hook-${index}` }))),
    { code: 'INVALID_LIFECYCLE_HOOKS' })
  assert.throws(() => createLifecycleHooks(new Array<LifecycleHookDefinition>(1)), { code: 'INVALID_LIFECYCLE_HOOKS' })
  let read = false
  const accessor = Object.defineProperty({ ...definition() }, 'run', { enumerable: true, get() { read = true; return () => {} } })
  assert.throws(() => createLifecycleHooks([accessor]), { code: 'INVALID_LIFECYCLE_HOOKS' })
  assert.equal(read, false)
  const inherited = Object.create(definition()) as LifecycleHookDefinition
  assert.throws(() => createLifecycleHooks([inherited]), { code: 'INVALID_LIFECYCLE_HOOKS' })
  const runner = createLifecycleHooks([])
  await assert.rejects(runner.run('invented' as LifecycleCheckpoint, {}, signal()), { code: 'INVALID_LIFECYCLE_HOOKS' })
  const cyclic: JsonObject = {}
  cyclic.self = cyclic
  await assert.rejects(runner.run('runtime.ready', cyclic, signal()), { code: 'INVALID_DATA' })
})

test('guard timeout blocks later hooks, aborts its signal, and raw work keeps capacity until it really settles', async () => {
  let finish: (() => void) | undefined
  let receivedSignal: AbortSignal | undefined
  let later = false
  const runner = createLifecycleHooks([definition({ id: 'guard', kind: 'guard', timeoutMs: 15, run(request) {
    receivedSignal = request.signal
    return new Promise<void>(resolve => { finish = resolve })
  } }), definition({ id: 'later', run() { later = true } })])
  await assert.rejects(runner.run('runtime.starting', {}, signal()), { code: 'LIFECYCLE_HOOK_TIMEOUT' })
  assert.equal(receivedSignal?.aborted, true)
  assert.equal(later, false)
  assert.equal(runner.describe().pendingRaw, 1)
  finish!()
  await delay(0)
  assert.equal(runner.describe().pendingRaw, 0)
})

test('observer timeout is isolated and late rejection never becomes an unhandled rejection', async () => {
  let rejectRaw: ((error: Error) => void) | undefined
  let later = false
  const runner = createLifecycleHooks([definition({ id: 'a-observe', timeoutMs: 15,
    run: () => new Promise<void>((_resolve, reject) => { rejectRaw = reject }) }),
  definition({ id: 'b-after', run() { later = true } })])
  await runner.run('runtime.starting', {}, signal())
  assert.equal(later, true)
  assert.equal(runner.describe().lastFault?.code, 'LIFECYCLE_HOOK_TIMEOUT')
  assert.equal(runner.describe().pendingRaw, 1)
  rejectRaw!(new Error('late private exception'))
  await delay(0)
  assert.equal(runner.describe().pendingRaw, 0)
})

test('pending raw work is capped at sixteen without queuing and capacity returns only on actual settlement', async () => {
  const finishes: Array<() => void> = []
  let calls = 0
  const runner = createLifecycleHooks([definition({ kind: 'guard', timeoutMs: 15, run() {
    calls++
    return new Promise<void>(resolve => finishes.push(resolve))
  } })])
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => runner.run('runtime.starting', {}, signal())))
  assert.equal(calls, 16)
  assert.equal(runner.describe().pendingRaw, 16)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'LIFECYCLE_HOOK_TIMEOUT').length, 16)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'LIFECYCLE_HOOK_BACKPRESSURE').length, 4)
  await assert.rejects(runner.run('runtime.starting', {}, signal()), { code: 'LIFECYCLE_HOOK_BACKPRESSURE' })
  finishes.shift()!()
  await delay(0)
  const next = runner.run('runtime.starting', {}, signal())
  await assert.rejects(next, { code: 'LIFECYCLE_HOOK_TIMEOUT' })
  assert.equal(calls, 17)
  runner.close()
  for (const finish of finishes) finish()
  await delay(0)
  assert.equal(runner.describe().pendingRaw, 0)
})

test('parent cancellation interrupts either kind immediately, does not run later hooks and is never observer success', async () => {
  for (const kind of ['guard', 'observe'] as const) {
    const parent = new AbortController()
    let finish: (() => void) | undefined
    let entered: (() => void) | undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    let later = false
    const runner = createLifecycleHooks([definition({ id: 'first', kind, run() {
      entered!()
      return new Promise<void>(resolve => { finish = resolve })
    } }), definition({ id: 'second', run() { later = true } })])
    const pending = runner.run('runtime.starting', {}, parent.signal)
    await started
    parent.abort()
    await assert.rejects(pending, { code: 'LIFECYCLE_HOOK_ABORTED' })
    assert.equal(later, false)
    assert.equal(runner.describe().pendingRaw, 1)
    finish!()
    await delay(0)
    assert.equal(runner.describe().pendingRaw, 0)
  }
})

test('close interrupts outstanding work, rejects future calls and preserves true raw pending counts', async () => {
  let finish: (() => void) | undefined
  let entered: (() => void) | undefined
  const started = new Promise<void>(resolve => { entered = resolve })
  const runner = createLifecycleHooks([definition({ run() {
    entered!()
    return new Promise<void>(resolve => { finish = resolve })
  } })])
  const pending = runner.run('runtime.starting', {}, signal())
  await started
  runner.close()
  runner.close()
  await assert.rejects(pending, { code: 'LIFECYCLE_HOOK_CLOSED' })
  assert.equal(runner.describe().closed, true)
  assert.equal(runner.describe().pendingRaw, 1)
  await assert.rejects(runner.run('runtime.ready', {}, signal()), { code: 'LIFECYCLE_HOOK_CLOSED' })
  finish!()
  await delay(0)
  assert.equal(runner.describe().pendingRaw, 0)
})

test('already aborted parents and cancellation inside a successful hook prevent subsequent work', async () => {
  const parent = new AbortController()
  let calls = 0
  const runner = createLifecycleHooks([definition({ id: 'first', run() { calls++; parent.abort() } }),
    definition({ id: 'second', run() { calls++ } })])
  await assert.rejects(runner.run('runtime.starting', {}, parent.signal), { code: 'LIFECYCLE_HOOK_ABORTED' })
  assert.equal(calls, 1)
  await assert.rejects(runner.run('runtime.starting', {}, parent.signal), { code: 'LIFECYCLE_HOOK_ABORTED' })
  assert.equal(calls, 1)
})
