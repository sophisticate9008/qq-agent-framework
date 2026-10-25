import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { createContextStore } from '../src/core/context.ts'
import { createBridgeHost } from '../src/host/bridge.ts'
import type { AgentAdapter } from '../src/host/types.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(accept => { resolve = accept })
  return { promise, resolve }
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return
    await nextTurn()
  }
  assert.fail('Follow admission did not settle')
}

function fixture(context: TestContext, options: {
  maxSessions?: number
  isIdle?: (conversationId: string) => boolean
  submit?: AgentAdapter['submit']
  createSession?: AgentAdapter['createSession']
} = {}) {
  const store = createSqliteStore({ filename: ':memory:' })
  const contexts = createContextStore()
  const persona = contexts.registerPersona({ id: 'pool', version: '1', name: 'Pool',
    identity: { purpose: 'test' }, style: {} })
  const created: string[] = []
  const followed: Array<Parameters<AgentAdapter['follow']>[0]> = []
  const disposed: string[] = []
  const host = createBridgeHost({ store, context: contexts, persona,
    authorizeIncoming: () => true, replyTimeoutNotice: null,
    followPool: { maxSessions: options.maxSessions ?? 2, isIdle: binding => options.isIdle?.(binding.conversationId) ?? false },
    agent: {
      async createSession(request) {
        created.push(request.conversationId)
        return options.createSession?.(request) ?? { sessionId: `session-${request.conversationId}` }
      },
      async follow(request) {
        followed.push(request)
        return () => { disposed.push(request.sessionId) }
      },
      submit: options.submit ?? (async () => ({ status: 'accepted' }))
    },
    transport: { async send() { return { status: 'confirmed', messageId: 'sent' } } }
  })
  for (const conversationId of ['one', 'two', 'three', 'four', 'five']) {
    host.policy.grant({ id: conversationId, featureId: 'agent-relay', conversationId,
      capabilities: ['agent.submit', 'messaging.send'], maxUses: { 'agent.submit': 10, 'messaging.send': 10 } })
  }
  context.after(async () => { await host.stop(); store.close() })
  return { host, created, followed, disposed, receive(conversationId: string, id = 'input', signal?: AbortSignal) {
    return host.receive({ id, conversationId, userId: 'user', receivedAt: Date.now(),
      content: [{ type: 'text', text: 'input' }], directed: true, isSelf: false }, { signal })
  } }
}

test('follow pool serializes concurrent capacity admission before persistent creation and reclaims least-recently-used idle follow', async context => {
  const idle = new Set<string>()
  const fake = fixture(context, { isIdle: conversationId => idle.has(conversationId) })
  await fake.host.start()
  const results = await Promise.all(['one', 'two', 'three', 'four', 'five'].map(conversationId => fake.receive(conversationId)))
  assert.deepEqual(results.map(result => result.status), ['accepted', 'accepted', 'rejected', 'rejected', 'rejected'])
  assert.deepEqual(results.slice(2).map(result => result.errorCode), Array(3).fill('AGENT_FOLLOW_BACKPRESSURE'))
  assert.deepEqual(fake.created, ['one', 'two'])
  assert.equal(fake.host.sessions.list().length, 2)
  idle.add('one')
  idle.add('two')
  assert.equal((await fake.receive('one', 'touch')).status, 'accepted')
  const oldBinding = fake.host.sessions.get('two')
  assert.equal((await fake.receive('three', 'retry-explicit-new-input')).status, 'accepted')
  assert.deepEqual(fake.disposed, ['session-two'])
  assert.deepEqual(fake.host.sessions.get('two'), oldBinding)
  assert.equal(fake.host.metrics().followedSessions, 2)
  const old = fake.followed.find(request => request.sessionId === 'session-two')!
  await old.onEvent({ id: 'late-old-stream', sessionId: 'session-two', type: 'message', content: [{ type: 'text', text: 'late' }] })
  await fake.host.tasks.runDue()
  assert.equal(fake.host.outbox.list().length, 0)
})

test('follow pool pins a pending submit even when the idle predicate says true', async context => {
  const pending = deferred<{ status: 'accepted' }>()
  let submits = 0
  const fake = fixture(context, { maxSessions: 1, isIdle: () => true,
    async submit() { submits++; return submits === 1 ? pending.promise : { status: 'accepted' } } })
  const first = fake.receive('one')
  await until(() => submits === 1)
  assert.equal((await fake.receive('two')).errorCode, 'AGENT_FOLLOW_BACKPRESSURE')
  assert.deepEqual(fake.created, ['one'])
  pending.resolve({ status: 'accepted' })
  assert.equal((await first).status, 'accepted')
  assert.equal((await fake.receive('two', 'new-input')).status, 'accepted')
  assert.deepEqual(fake.disposed, ['session-one'])
})

test('aborted FIFO admission never creates after the earlier creation releases the admission lock', async context => {
  const pending = deferred<{ sessionId: string }>()
  const fake = fixture(context, { createSession: async () => pending.promise })
  const first = fake.receive('one')
  await until(() => fake.created.length === 1)
  const controller = new AbortController()
  const second = fake.receive('two', 'input', controller.signal)
  await nextTurn()
  controller.abort()
  pending.resolve({ sessionId: 'session-one' })
  assert.equal((await first).status, 'accepted')
  assert.notEqual((await second).status, 'accepted')
  await nextTurn()
  assert.deepEqual(fake.created, ['one'])
  assert.equal(fake.host.sessions.get('two'), null)
})
