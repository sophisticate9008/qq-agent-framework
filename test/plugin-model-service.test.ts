import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import type { AgentEvent } from '../src/contracts/ports.ts'
import type { PluginModelBackend } from '../src/contracts/plugin-model.ts'
import { createPluginModelService } from '../src/host/plugin-model-service.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

function fixture(t: TestContext) {
  const store = createSqliteStore({ filename: ':memory:' })
  t.after(() => store.close())
  const host = new AbortController(), plugin = new AbortController(), caller = new AbortController()
  const sessions = new Set<string>()
  let created = 0, starts = 0, stops = 0
  let follower: Parameters<PluginModelBackend['follow']>[0] | undefined
  let started!: () => void
  const admitted = new Promise<void>(resolve => { started = resolve })
  const backend: PluginModelBackend = {
    async models() { return [{ provider: 'fixture', model: 'fixture', providerName: 'Fixture', modelName: 'Fixture' }] },
    async inspect(sessionId) { return { exists: sessions.has(sessionId) } },
    async create({ sessionId, signal }) { signal.throwIfAborted(); sessions.add(sessionId); created++ },
    async start({ signal }) { signal.throwIfAborted(); starts++; started(); return { status: 'accepted' } },
    async follow(request) { follower = request; return () => { stops++ } },
    async waitForIdle(_session, _request, signal) { signal.throwIfAborted() },
    async inspectRun() { return { state: 'running', idle: false, usage: {} } },
  }
  const service = createPluginModelService({ store, backend, signal: host.signal,
    withSessionLease: async (_session, signal, operation) => { signal.throwIfAborted(); return operation() } })
  const client = service.forPlugin('fixture-plugin', plugin.signal)
  return { store, host, plugin, caller, client, admitted, counts: () => ({ created, starts, stops }),
    signal: () => follower?.signal,
    async complete(text: string) {
      assert(follower)
      const base = { sessionId: follower.sessionId }
      const message: AgentEvent = { ...base, id: 'message', type: 'message', content: [{ type: 'text', text }] }
      await follower.onEvent(message)
      await follower.onEvent({ ...base, id: 'completed', type: 'completed' })
    } }
}

test('explicit null plugin generation timeout creates no timer and can finish beyond the normal deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const timers = t.mock.method(globalThis, 'setTimeout')
  const f = fixture(t)
  let settled = false
  const pending = f.client.run({ prompt: 'Background indexing', timeoutMs: null }).finally(() => { settled = true })
  await f.admitted; await nextTurn()
  assert.equal(timers.mock.callCount(), 0)
  t.mock.timers.tick(7_200_000); await nextTurn()
  assert.equal(settled, false)
  assert.equal(f.signal()?.aborted, false)
  await f.complete('indexed')
  assert.equal((await pending).text, 'indexed')
  assert.deepEqual(f.counts(), { created: 1, starts: 1, stops: 1 })
})

test('unlimited plugin generation still stops on caller, plugin or host cancellation without replaying unknown work', async t => {
  for (const lifecycle of ['caller', 'plugin', 'host'] as const) await t.test(lifecycle, async t => {
    const f = fixture(t), reason = new Error(`${lifecycle} stopped`)
    const pending = f.client.run({ prompt: 'Background indexing', timeoutMs: null, signal: f.caller.signal })
    await f.admitted; await nextTurn()
    const rejected = assert.rejects(pending, error => error === reason)
    f[lifecycle].abort(reason)
    await rejected
    assert.equal(f.signal()?.aborted, true)
    assert.equal(f.counts().stops, 1)
    const execution = f.store.list('plugin-model.executions', { limit: 1 })[0]
    assert(execution && typeof execution.value === 'object' && execution.value !== null && !Array.isArray(execution.value))
    assert.equal(execution.value.state, 'unknown')
    await assert.rejects(f.client.run({ prompt: 'Do not replay', timeoutMs: null }))
    assert.equal(f.counts().starts, 1)
    assert.equal(f.counts().created, 1)
  })
})

test('plugin numeric and omitted generation deadlines retain their original limits', async t => {
  for (const timeout of [1000, undefined]) await t.test(timeout === undefined ? 'default 300000ms' : 'explicit 1000ms', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fixture(t), deadline = timeout ?? 300_000
    let settled = false
    const pending = f.client.run({ prompt: 'Bounded work', ...(timeout === undefined ? {} : { timeoutMs: timeout }) })
      .finally(() => { settled = true })
    const rejected = assert.rejects(pending, { code: 'PLUGIN_MODEL_TIMEOUT' })
    await f.admitted; await nextTurn()
    t.mock.timers.tick(deadline - 1); await nextTurn()
    assert.equal(settled, false)
    t.mock.timers.tick(1)
    await rejected
    assert.equal(f.signal()?.aborted, true)
  })
})

test('invalid plugin timeouts fail before session creation and null retains the output budget', async t => {
  const f = fixture(t)
  for (const timeout of [0, 999, 3_600_001, 1000.5, NaN, Infinity, '1000', false]) {
    for (const mode of ['persistent', 'stateless'] as const) await assert.rejects(f.client.run({ prompt: 'Invalid limits', mode,
      timeoutMs: timeout as unknown as number }), { code: 'PLUGIN_MODEL_INVALID_LIMIT' })
  }
  assert.deepEqual(f.counts(), { created: 0, starts: 0, stops: 0 })
  assert.equal(f.client.list().length, 0)
  const pending = f.client.run({ prompt: 'Bounded output', timeoutMs: null, maxOutputChars: 4 })
  const rejected = assert.rejects(pending, { code: 'PLUGIN_MODEL_OUTPUT_LIMIT' })
  await f.admitted; await nextTurn(); await f.complete('longer than four')
  await rejected
})

test('null plugin generation deadlines retain bounded per-session queue capacity', async t => {
  const f = fixture(t), stopped = new Error('Host stopped')
  const first = f.client.run({ prompt: 'Keep the session occupied', timeoutMs: null }).catch(error => error as unknown)
  await f.admitted; await nextTurn()
  let rejectedByCapacity = 0
  const queued = Array.from({ length: 16 }, () => f.client.run({ prompt: 'Queued background work', timeoutMs: null })
    .catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'PLUGIN_MODEL_QUEUE_FULL') rejectedByCapacity++
      return error
    }))
  await nextTurn()
  assert.equal(rejectedByCapacity, 1)
  assert.equal(f.counts().starts, 1)
  f.host.abort(stopped)
  assert.equal(await first, stopped)
  await Promise.all(queued)
  assert.equal(f.counts().starts, 1)
})
