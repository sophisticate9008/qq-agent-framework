import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createContextStore } from '../src/core/context.ts'
import { FrameworkError } from '../src/core/values.ts'
import { createBridgeHost } from '../src/host/bridge.ts'
import { createControlCommands } from '../src/host/control-commands.ts'
import { createNativeActivity } from '../src/host/native-activity.ts'
import { createNativeInboundController } from '../src/host/native-inbound.ts'
import { createNativeMediaRegistry } from '../src/host/native-media.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

async function fixture(context: TestContext, denied: Error) {
  const store = createSqliteStore({ filename: ':memory:' })
  const personas = createContextStore()
  const persona = personas.registerPersona({ id: 'inbound', version: '1', name: 'Inbound', identity: {}, style: {} })
  const lifetime = new AbortController()
  let reads = 0
  let sends = 0
  let prompts = 0
  let commands = 0
  let registrations = 0
  const host = createBridgeHost({ store, context: personas, persona, authorizeIncoming: () => false,
    transport: { send() { sends++; return { status: 'rejected' } } },
    agent: { async createSession() { throw new Error('Unexpected session creation') },
      async submit() { prompts++; return { status: 'rejected' } }, async follow() { return () => {} } } })
  const activity = createNativeActivity()
  const media = createNativeMediaRegistry({ store, accountId: '999',
    async authorize() { registrations++; throw denied },
    contentReader: { async read() { reads++; return { status: 'rejected', code: 'UNEXPECTED_MEDIA_READ' } } } })
  const definition = { id: 'synthetic-control', matches: () => true, async handle() { commands++ } }
  const controls = createControlCommands({ store, signal: lifetime.signal, commands: [definition],
    async send() { sends++; return { status: 'rejected' } } })
  const inbound = createNativeInboundController({ activity,
    resources: { state: 'running', closed: false, host, lifetime, media, configuration: undefined,
      executions: undefined, inbox: undefined, messageSources: undefined, interactionMessages: undefined,
      quotedContext: undefined, inputPackage: undefined },
    controlDefinitions: [definition], async getControlCommands() { return controls },
    async checkpoint() {}, async guard() { throw new Error('Unexpected admission guard') },
    safeCode: error => error instanceof FrameworkError ? error.code : 'UNEXPECTED_ERROR' })
  await host.start()
  context.after(async () => {
    lifetime.abort()
    await controls.stop()
    await controls.drain()
    await host.stop()
    activity.closeEvents()
    store.close()
  })
  async function message(id: number, segments: readonly { type: string; data: Record<string, string> }[]) {
    assert(inbound.handlers.onEvent)
    await inbound.handlers.onEvent({ post_type: 'message', self_id: 999, message_type: 'group',
      group_id: 456, user_id: 123, message_id: id, time: Math.floor(Date.now() / 1000), message: [...segments] },
    { selfId: '999', receivedAt: Date.now(), signal: lifetime.signal })
  }
  return { message, inbound, store, activity, counts: () => ({ reads, sends, prompts, commands, registrations }) }
}

test('media access denial becomes a normal rejected receipt before registration or content reads, preserving control commands', async context => {
  const denied = new FrameworkError('NATIVE_CHAT_ACCESS_DENIED', 'Synthetic conversation is not allowed')
  const fake = await fixture(context, denied)
  for (const [index, type] of ['image', 'record', 'file', 'forward'].entries()) {
    await assert.doesNotReject(fake.message(index + 1, [{ type, data: { file: 'synthetic-reference', id: 'synthetic-forward' } }]))
    assert.deepEqual(fake.inbound.status().lastReceipt, { status: 'rejected', errorCode: denied.code })
  }
  assert.equal(fake.inbound.status().rejected, 4)
  assert.equal(fake.inbound.status().unknown, 0)
  assert.equal(fake.inbound.status().received, 0)
  assert.deepEqual(fake.counts(), { reads: 0, sends: 0, prompts: 0, commands: 0, registrations: 4 })
  assert.deepEqual(fake.store.list('native-chat.media'), [])
  assert(fake.activity.read('running').items.every(item => item.type === 'processed' && item.conversationId === 'group:456'))
  await fake.message(5, [{ type: 'text', data: { text: '/synthetic-control' } }])
  assert.equal(fake.counts().commands, 1)
  assert.equal(fake.counts().registrations, 4)
})

test('unexpected media authorization and storage failures retain their original errors', async context => {
  for (const error of [new FrameworkError('STORE_IO_ERROR', 'Synthetic storage failure'),
    new FrameworkError('NATIVE_CHAT_CONFIGURATION_CHANGED', 'Synthetic configuration change'),
    new Error('Synthetic unexpected registrar failure')]) {
    const fake = await fixture(context, error)
    await assert.rejects(fake.message(1, [{ type: 'image', data: { file: 'synthetic-reference' } }]), actual => actual === error)
    assert.equal(fake.inbound.status().lastReceipt, null)
    assert.equal(fake.inbound.status().rejected, 0)
    assert.deepEqual(fake.store.list('native-chat.media'), [])
    assert.deepEqual(fake.counts(), { reads: 0, sends: 0, prompts: 0, commands: 0, registrations: 1 })
  }
})
