import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createSessionRegistry } from '../src/host/sessions.ts'
import { nativeSessionBindingRevision, resetNativeSessionContext } from '../src/host/native-session-management.ts'
import type { AgentAdapter } from '../src/contracts/ports.ts'

const agent: AgentAdapter = {
  async createSession() { throw new Error('Unused in ownership checks') },
  async submit() { throw new Error('Unused in ownership checks') },
  async follow() { throw new Error('Unused in ownership checks') }
}

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'native-reset-ownership-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'native-chat.sqlite')
  const store = createSqliteStore({ filename })
  store.write('native-chat.meta', 'session-definition', { identity: 'a'.repeat(64) })
  const metadata = { conversationId: 'group:123', state: 'ready', generation: 1, requestId: 'original-request',
    sessionId: 'original-session', updatedAt: 1 }
  const { conversationId: _conversationId, ...binding } = metadata
  store.write('host.sessions', metadata.conversationId, { schema: 1, ...binding })
  const target = { key: metadata.conversationId, sessionId: metadata.sessionId, generation: metadata.generation,
    bindingRevision: nativeSessionBindingRevision(metadata) }
  return { directory, filename, store, target }
}

test('offline reset of an old binding atomically preserves permanent external ID ownership', async context => {
  const { directory, filename, store, target } = await fixture(context)
  assert.equal(store.read('host.session-ids', target.sessionId), null)
  store.close()
  const reset = await resetNativeSessionContext({ directory, state: () => 'stopped', target, signal: new AbortController().signal })
  assert.equal(reset.nextGeneration, 2)
  const reopened = createSqliteStore({ filename })
  context.after(() => reopened.close())
  assert.deepEqual(reopened.read('host.session-ids', target.sessionId)?.value,
    { schema: 1, conversationId: target.key, generation: target.generation })
  assert.equal(reopened.list('host.session-archives').length, 1)
  const registry = createSessionRegistry({ store: reopened, agent })
  assert.throws(() => registry.bind('private:456', target.sessionId, 1), { code: 'SESSION_ID_REUSED' })
  assert.throws(() => registry.bind(target.key, target.sessionId, 2), { code: 'SESSION_ID_REUSED' })
  assert.equal(registry.get(target.key), null)
  assert.equal(registry.bind(target.key, 'fresh-session', 2).sessionId, 'fresh-session')
})

test('offline reset refuses conflicting permanent ownership without retiring or archiving the binding', async context => {
  const { directory, filename, store, target } = await fixture(context)
  store.write('host.session-ids', target.sessionId, { schema: 1, conversationId: 'private:456', generation: 1 })
  const before = store.read('host.sessions', target.key)
  store.close()
  await assert.rejects(resetNativeSessionContext({ directory, state: () => 'stopped', target,
    signal: new AbortController().signal }), { code: 'SESSION_MANAGEMENT_CONFLICT' })
  const reopened = createSqliteStore({ filename })
  context.after(() => reopened.close())
  assert.deepEqual(reopened.read('host.sessions', target.key), before)
  assert.deepEqual(reopened.list('host.session-archives'), [])
})
