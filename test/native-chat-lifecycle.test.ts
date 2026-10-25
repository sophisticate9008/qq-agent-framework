import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FrameworkError } from '../src/core/values.ts'
import { createNativeChatLifecycle, DEFAULT_NATIVE_CHAT_RUNNING_INTENT, NATIVE_CHAT_LIFECYCLE_FILE,
  validateNativeChatRunningIntent, type NativeChatLifecycleDocument, type NativeChatRunningIntent } from '../src/admin/native-chat-lifecycle.ts'
import { createNativeRuntimeRoutes, readNativeChatConfiguration } from '../src/admin/runtime.ts'
import { createNativeChatRuntime } from '../src/host/native-chat-runtime.ts'

const revisionNames = ['plans', 'personas', 'access', 'adapters', 'providers', 'authorization', 'deployment', 'execution']
const revisions = Object.freeze(Object.fromEntries(revisionNames.map(key => [key, 'a'.repeat(64)])))
const signal = () => new AbortController().signal

function fixture(intent?: NativeChatRunningIntent) {
  let document: NativeChatLifecycleDocument = { revision: 'initial', exists: intent !== undefined,
    value: intent ?? DEFAULT_NATIVE_CHAT_RUNNING_INTENT }
  let currentState = 'stopped'
  let freshRevisions = revisions
  let activeRevisions: Readonly<Record<string, string>> | null = null
  let canStart = true
  let starts = 0
  let stops = 0
  let writes = 0
  let failStart = false
  let failStop = false
  let failWrite = false
  let wrongActive = false
  let startBarrier: Promise<void> | undefined
  let exclusive = false
  const lifecycle = createNativeChatLifecycle({
    runtime: {
      async status() { return { state: currentState, canStart, revisions: freshRevisions, activeRevisions } },
      async start(expected, controlSignal) {
        controlSignal.throwIfAborted()
        starts++
        if (failStart) throw new FrameworkError('START_UNKNOWN', 'test-only')
        await startBarrier
        currentState = 'running'
        activeRevisions = wrongActive ? { ...expected, plans: 'b'.repeat(64) } : expected
      },
      async stop() {
        stops++
        if (failStop) throw new FrameworkError('STOP_UNKNOWN', 'test-only')
        currentState = 'stopped'
        activeRevisions = null
      }
    },
    async read() { return document },
    async write(previous, value) {
      if (failWrite) throw new Error('test-only write failure')
      assert.equal(previous.revision, document.revision)
      writes++
      document = { revision: `revision-${writes}`, exists: true, value: validateNativeChatRunningIntent(value) }
      return document
    },
    async runExclusive(operation) {
      if (exclusive) throw new Error('test-only busy')
      exclusive = true
      try { return await operation() } finally { exclusive = false }
    }
  })
  return { lifecycle, document: () => document, counts: () => ({ starts, stops, writes }),
    setCanStart: (value: boolean) => { canStart = value },
    setState: (value: string) => { currentState = value },
    setRevisions: (value: Readonly<Record<string, string>>) => { freshRevisions = value },
    setFailStart: () => { failStart = true }, setFailStop: () => { failStop = true },
    setFailWrite: () => { failWrite = true }, setWrongActive: () => { wrongActive = true },
    setStartBarrier: (value: Promise<void>) => { startBarrier = value } }
}

const runningIntent: NativeChatRunningIntent = { schema: 1, desiredRunning: true, revisions, updatedAt: 123 }

test('successful explicit start records actual eight revisions; maintenance preserves and stop clears intent', async () => {
  const state = fixture()
  await state.lifecycle.start(revisions, signal())
  assert.equal(state.document().value.desiredRunning, true)
  assert.deepEqual(state.document().value.revisions, revisions)
  const saved = state.document()
  await state.lifecycle.stop(true)
  assert.deepEqual(state.document(), saved)
  await state.lifecycle.stop(false)
  assert.equal(state.document().value.desiredRunning, false)
  assert.deepEqual(state.document().value.revisions, revisions)
  assert.deepEqual(state.counts(), { starts: 1, stops: 2, writes: 2 })
})

test('missing intent and explicitly stopped intent never auto-start', async () => {
  for (const state of [fixture(), fixture({ ...runningIntent, desiredRunning: false })]) {
    assert.equal((await state.lifecycle.restore(signal())).state, 'skipped')
    assert.deepEqual(state.counts(), { starts: 0, stops: 0, writes: 0 })
  }
})

test('restore requires every persisted revision and fresh stopped canStart, without applying or migrating', async () => {
  for (const key of revisionNames) {
    const state = fixture(runningIntent)
    state.setRevisions({ ...revisions, [key]: 'b'.repeat(64) })
    assert.deepEqual(await state.lifecycle.restore(signal()), { state: 'skipped', reason: 'configuration_changed' })
    assert.equal(state.counts().starts, 0)
  }
  const unavailable = fixture(runningIntent)
  unavailable.setCanStart(false)
  assert.deepEqual(await unavailable.lifecycle.restore(signal()), { state: 'skipped', reason: 'runtime_not_ready' })
  const unknown = fixture(runningIntent)
  unknown.setState('error')
  assert.deepEqual(await unknown.lifecycle.restore(signal()), { state: 'skipped', reason: 'runtime_not_stopped' })
})

test('startup restores once and preserves the already authorized persisted intent', async () => {
  const state = fixture(runningIntent)
  assert.deepEqual(await state.lifecycle.restore(signal()), { state: 'restored', reason: null })
  assert.deepEqual(await state.lifecycle.restore(signal()), { state: 'restored', reason: null })
  assert.deepEqual(state.counts(), { starts: 1, stops: 0, writes: 0 })
  assert.deepEqual(state.document().value, runningIntent)
})

test('startup failure is reported once and never retried', async () => {
  const state = fixture(runningIntent)
  state.setFailStart()
  assert.deepEqual(await state.lifecycle.restore(signal()), { state: 'failed', reason: 'startup_restore_failed' })
  await state.lifecycle.restore(signal())
  assert.equal(state.counts().starts, 1)
  assert.equal((await state.lifecycle.describe()).restoration.state, 'failed')
})

test('an aborted restore returns unknown and a late start cannot rewrite the result or retry', async () => {
  const state = fixture(runningIntent)
  let release: (() => void) | undefined
  state.setStartBarrier(new Promise<void>(resolve => { release = resolve }))
  const controller = new AbortController()
  const pending = state.lifecycle.restore(controller.signal)
  for (let turn = 0; turn < 12 && state.counts().starts === 0; turn++) await Promise.resolve()
  assert.equal(state.counts().starts, 1)
  controller.abort()
  assert.deepEqual(await pending, { state: 'failed', reason: 'startup_restore_aborted_or_unknown' })
  release?.()
  await Promise.resolve()
  await state.lifecycle.restore(signal())
  assert.equal((await state.lifecycle.describe()).restoration.state, 'failed')
  assert.equal(state.counts().starts, 1)
  assert.equal(state.counts().writes, 0)
})

test('write failure or unverified active revisions never claim persisted start success', async () => {
  const failed = fixture()
  failed.setFailWrite()
  await assert.rejects(failed.lifecycle.start(revisions, signal()), { code: 'NATIVE_CHAT_LIFECYCLE_WRITE_FAILED' })
  assert.equal(failed.document().exists, false)
  const changed = fixture()
  changed.setWrongActive()
  await assert.rejects(changed.lifecycle.start(revisions, signal()), { code: 'NATIVE_CHAT_LIFECYCLE_START_UNVERIFIED' })
  assert.equal(changed.document().exists, false)
})

test('explicit stop clears intent even if stopping becomes unknown', async () => {
  const state = fixture(runningIntent)
  state.setFailStop()
  await assert.rejects(state.lifecycle.stop(false), { code: 'STOP_UNKNOWN' })
  assert.equal(state.document().value.desiredRunning, false)
  assert.equal((await state.lifecycle.restore(signal())).reason, 'explicitly_stopped')
})

test('lifecycle document rejects missing revisions and extra credential fields', () => {
  const { execution: omitted, ...incomplete } = revisions
  assert.equal(typeof omitted, 'string')
  assert.throws(() => validateNativeChatRunningIntent({ ...runningIntent, revisions: incomplete }))
  assert.throws(() => validateNativeChatRunningIntent({ ...runningIntent, revisions: null }))
  assert.throws(() => validateNativeChatRunningIntent({ ...runningIntent, secret: 'not-saved' }))
})

test('real stop route persists private intent, accepts only explicit maintenance, and internal close preserves it', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-lifecycle-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const runtime = createNativeChatRuntime({ directory, loadConfiguration: () => readNativeChatConfiguration(directory),
    resolveDeployment: async () => ({ missingReasons: [], presetBindings: [] }) })
  context.after(() => runtime.close())
  const routes = createNativeRuntimeRoutes({ directory, chatRuntime: runtime })
  const stop = routes.find(route => route.method === 'POST' && route.pathname === '/api/chat/runtime/stop')
  assert.ok(stop)
  const request = (body: Record<string, unknown>) => stop.handle({ query: new URLSearchParams(), body, signal: signal() })
  const filename = join(directory, NATIVE_CHAT_LIFECYCLE_FILE)
  await request({ maintenance: true })
  await assert.rejects(readFile(filename), { code: 'ENOENT' })
  await assert.rejects(Promise.resolve().then(() => request({ maintenance: false })), { statusCode: 400 })
  await request({})
  const content = await readFile(filename, 'utf8')
  assert.equal(JSON.parse(content).desiredRunning, false)
  assert.equal((await stat(filename)).mode & 0o777, 0o600)
  await runtime.close()
  assert.equal(await readFile(filename, 'utf8'), content)
})
