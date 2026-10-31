import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContextStore } from '../src/core/context.ts'
import { readNativeChatConfiguration } from '../src/admin/runtime.ts'
import { DEFAULT_PERSONA_WAKE, type PersonaWake } from '../src/contracts/persona-wake.ts'
import { createBridgeHost } from '../src/host/bridge.ts'
import { createNativeActivity } from '../src/host/native-activity.ts'
import { createNativeInboundController } from '../src/host/native-inbound.ts'
import { createNativeInbox } from '../src/host/native-inbox.ts'
import { createNativeMessageSources } from '../src/host/native-message-sources.ts'
import { readChatInputConfiguration } from '../src/host/chat-input-configuration.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

async function fixture(context: TestContext, continuationMs = 90000) {
  const directory = await mkdtemp(join(tmpdir(), 'group-probability-'))
  const store = createSqliteStore({ filename: ':memory:' })
  const lifetime = new AbortController()
  const personas = createContextStore()
  const persona = personas.registerPersona({ id: 'probability-fixture', version: '1', name: 'Fixture', identity: {}, style: {} })
  const host = createBridgeHost({ store, context: personas, persona, authorizeIncoming: () => true,
    transport: { send() { throw new Error('No QQ sends in admission fixture') } },
    agent: { async createSession() { throw new Error('No model calls in admission fixture') },
      async submit() { throw new Error('No model calls in admission fixture') }, async follow() { return () => {} } } })
  const activity = createNativeActivity()
  const inbox = createNativeInbox({ store, readiness: () => 'busy', async deliver() { throw new Error('Queue stays pending') } })
  let wake: PersonaWake = { ...DEFAULT_PERSONA_WAKE, continuationMs }
  let sample = 0.009999, draws = 0
  let admission: Promise<void> | undefined
  let admissionEntered: (() => void) | undefined
  const initial = await readNativeChatConfiguration(directory)
  const inbound = createNativeInboundController({ activity,
    resources: { state: 'running', closed: false, host, lifetime, media: undefined, executions: undefined, inbox,
      configuration: { ...initial, access: { allow: ['group:456', 'private:123'], deny: [], owner: '123' } },
      messageSources: createNativeMessageSources({ owner: '123', signal: lifetime.signal, async validate() {} }),
      interactionMessages: undefined, quotedContext: undefined,
      inputPackage: { read: (conversationId, name) => readChatInputConfiguration(directory, conversationId, name, wake) } },
    controlDefinitions: [], async getControlCommands() { throw new Error('No control commands') },
    async checkpoint() {}, async guard(_conversationId, _signal, _recheck, phase) {
      if (phase === 'admission') { admissionEntered?.(); await admission }
    }, safeCode: () => 'SYNTHETIC_FAILURE', random() { draws++; return sample } })
  await host.start()
  context.after(async () => {
    lifetime.abort(); inbound.clear(); await inbox.stop(); await host.stop(); activity.closeEvents(); store.close()
    await rm(directory, { recursive: true, force: true })
  })
  async function message(id: number, options: { mention?: boolean; private?: boolean; denied?: boolean; self?: boolean } = {}) {
    assert(inbound.handlers.onEvent)
    await inbound.handlers.onEvent({ post_type: 'message', self_id: 999, message_type: options.private ? 'private' : 'group',
      ...(options.private ? {} : { group_id: options.denied ? 789 : 456 }), user_id: options.self ? 999 : 123,
      message_id: id, time: Math.floor(Date.now() / 1000),
      message: [...(options.mention ? [{ type: 'at', data: { qq: '999' } }] : []), { type: 'text', data: { text: '普通消息' } }] },
    { selfId: '999', receivedAt: Date.now(), signal: lifetime.signal })
  }
  return { message, inbox, inbound, host, draws: () => draws,
    sample(value: number) { sample = value }, probability(value: number) { wake = { ...wake, groupWakeProbabilityPercent: value } },
    holdAdmission() {
      let release: () => void = () => {}
      admission = new Promise<void>(resolve => { release = resolve })
      const entered = new Promise<void>(resolve => { admissionEntered = resolve })
      return { entered, release }
    } }
}

test('one percent has an exact boundary, retained duplicates never redraw, and a hit activates the ordinary continuation window', async context => {
  const f = await fixture(context)
  f.sample(0.01)
  await f.message(1)
  assert.equal(f.inbox.summary().pending, 0)
  assert.equal(f.draws(), 1)
  f.sample(0)
  await f.message(1)
  assert.equal(f.draws(), 1)
  await f.message(2)
  assert.equal(f.draws(), 2)
  assert.equal(f.inbox.list()[0]!.entries[0]!.trigger, 'probability')
  assert.equal(f.inbound.observationActive('group:456', 90000), true)
  await f.message(3)
  assert.equal(f.draws(), 2)
  assert.equal(f.inbox.list()[0]!.entries.at(-1)!.trigger, 'continuation')
})

test('a pending admission prevents a second probability wake even when continuation is disabled', async context => {
  const f = await fixture(context, 0)
  const gate = f.holdAdmission()
  const first = f.message(10)
  await gate.entered
  await f.message(11)
  assert.equal(f.draws(), 1)
  gate.release(); await first
  await f.message(10)
  await f.message(12)
  assert.equal(f.draws(), 1)
  assert.equal(f.inbox.summary().pending, 1)
})

test('disabled probability, private messages, denied groups, self echoes and real mentions never draw', async context => {
  const f = await fixture(context)
  f.probability(0)
  await f.message(20)
  assert.equal(f.draws(), 0)
  f.probability(100)
  await f.message(21, { denied: true })
  await f.message(22, { self: true })
  await f.message(23, { private: true })
  await f.message(24, { mention: true })
  assert.equal(f.draws(), 0)
  assert.equal(f.inbox.list().flatMap(queue => queue.entries).some(entry => entry.trigger === 'probability'), false)
})
