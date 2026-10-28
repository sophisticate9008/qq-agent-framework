import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAdminServer } from '../src/admin/server.ts'
import { createNativeRuntimeRoutes } from '../src/admin/runtime.ts'
import { createNativeChatRuntime } from '../src/host/native-chat-runtime.ts'
import { capabilityObject as object, capabilityUntil as until, createNativeCapabilityRuntimeFixture } from './fixtures/native-capability-runtime.ts'

type Fixture = Awaited<ReturnType<typeof createNativeCapabilityRuntimeFixture>>
const prompts = (fixture: Fixture) => fixture.calls.filter(call => call.method === 'session/prompt')
const entries = async (fixture: Fixture) => {
  const value = await fixture.api('/api/chat/activity')
  assert(Array.isArray(value.items))
  return value.items.map(object)
}
async function disk(directory: string) {
  const result: Record<string, string> = {}
  for (const name of await readdir(directory)) {
    const filename = join(directory, name)
    if ((await stat(filename)).isFile()) result[name] = createHash('sha256').update(await readFile(filename)).digest('hex')
  }
  return result
}
async function complete(fixture: Fixture, messageId: number) {
  const count = prompts(fixture).length
  fixture.inbound(messageId)
  await until(() => prompts(fixture).length === count + 1, 'Expected actual native prompt')
  const sessionId = String(prompts(fixture).at(-1)!.input.sessionId)
  const turn = prompts(fixture).filter(call => call.input.sessionId === sessionId).length
  const stream = fixture.streams.findLast(stream => stream.sessionId === sessionId && stream.socket.readyState === 1)!
  fixture.event('turn/start', { turn }, stream)
  await fixture.reply('Synthetic visible reply.', stream)
  fixture.event('turn/end', { turn, reason: { kind: 'completed' } }, stream)
}

test('activity HTTP GET is authenticated, strict, unavailable without runtime and never loads configuration or creates files', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-activity-read-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const missing = join(directory, 'not-created')
  let loads = 0
  const runtime = createNativeChatRuntime({ directory: missing,
    async loadConfiguration() { loads++; throw new Error('DO-NOT-EXPOSE-CREDENTIAL') },
    async resolveDeployment() { assert.fail('Activity must not resolve a deployment') } })
  context.after(() => runtime.close())
  const routes = createNativeRuntimeRoutes({ directory: missing, chatRuntime: runtime })
  const admin = createAdminServer({ token: 'synthetic-activity-admin-token-0123456789', snapshot: () => ({}), routes })
  await new Promise<void>(resolve => admin.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve, reject) => admin.close(error => error ? reject(error) : resolve())))
  const address = admin.address()
  assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  assert.equal((await fetch(`${origin}/api/chat/activity`)).status, 401)
  const headers = { authorization: 'Bearer synthetic-activity-admin-token-0123456789' }
  assert.equal((await fetch(`${origin}/api/chat/activity?limit=100`, { headers })).status, 400)
  assert.equal((await fetch(`${origin}/api/chat/activity?source=other`, { headers })).status, 400)
  assert.equal((await fetch(`${origin}/api/chat/activity?source=qq&source=simulation`, { headers })).status, 400)
  const response = await fetch(`${origin}/api/chat/activity`, { headers })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { source: 'native-chat', retention: 'process', capacity: 100, state: 'stopped', items: [],
    simulation: { state: 'none', runId: null, updatedAt: null } })
  const absent = createNativeRuntimeRoutes({ directory: missing }).find(route => route.pathname === '/api/chat/activity')!
  await assert.rejects(async () => absent.handle({ body: null, query: new URLSearchParams(), signal: new AbortController().signal }),
    { statusCode: 503, code: 'runtime_not_connected' })
  assert.equal(loads, 0)
  assert.deepEqual(await readdir(directory), [])
  await assert.rejects(runtime.start({}, new AbortController().signal))
  assert.equal(loads, 1)
  assert.equal(runtime.activity().state, 'error')
  assert(runtime.activity().items.some(entry => entry.summary.includes('启动失败')))
  assert(!JSON.stringify(runtime.activity()).includes('DO-NOT-EXPOSE'))
  assert.deepEqual(await readdir(directory), [])
})

test('default gateway records real native receive and confirmed send, rejects outsiders, retains stop/start activity and resets only with a new process instance',
  { timeout: 60_000 }, async context => {
    const fixture = await createNativeCapabilityRuntimeFixture(context, { evidenceRoot: process.env.NATIVE_ACTIVITY_EVIDENCE })
    await fixture.api('/api/chat/activity', undefined, 401, false)
    await fixture.login()
    const initial = await fixture.api('/api/chat/activity')
    assert.equal(initial.state, 'stopped')
    assert.deepEqual(initial.items, [])
    await assert.rejects(readFile(join(fixture.directory, 'runtime/native-chat.sqlite')), { code: 'ENOENT' })
    assert.equal(fixture.calls.length, 0)
    await fixture.configure(false)
    await fixture.save('access', { allow: ['private:123'], deny: [], owner: null })
    assert.equal((await fixture.apply()).state, 'verified')
    await fixture.start()
    await complete(fixture, 1)
    await until(async () => (await entries(fixture)).some(entry => entry.type === 'sent'), 'Expected confirmed native send activity')
    const activity = await entries(fixture)
    assert(activity.some(entry => entry.type === 'received' && entry.conversationId === 'private:123'))
    assert(activity.some(entry => entry.type === 'processed' && entry.level === 'info'))
    assert(activity.some(entry => entry.type === 'sent' && entry.summary === '协议已确认发送回复。'))
    fixture.inbound(2, 'group')
    await until(async () => object((await fixture.status()).ingress).rejected === 1, 'Expected denied conversation admission')
    assert.equal(object(object((await fixture.status()).ingress).lastReceipt).errorCode, 'NATIVE_CHAT_ACCESS_DENIED')
    assert(!(await entries(fixture)).some(entry => entry.conversationId === 'group:456'))
    assert.equal(prompts(fixture).length, 1)
    await fixture.api('/api/chat/runtime/stop', {})
    const before = await disk(join(fixture.directory, 'runtime'))
    const stopped = await fixture.api('/api/chat/activity')
    assert.equal(stopped.state, 'stopped')
    assert(Array.isArray(stopped.items))
    assert(stopped.items.map(object).some(entry => entry.id === activity[0]!.id))
    assert.deepEqual(await fixture.api('/api/chat/activity'), stopped)
    assert.deepEqual(await disk(join(fixture.directory, 'runtime')), before)
    const callCount = fixture.calls.length
    assert(stopped.items.map(object).some(entry => entry.type === 'sent' && entry.content === 'Synthetic visible reply.'))
    for (const secret of ['fixture-dsh-owner', 'fixture-onebot-http', 'synthetic-model-key']) assert(!JSON.stringify(stopped).includes(secret))
    await fixture.start()
    assert((await entries(fixture)).some(entry => entry.id === activity[0]!.id))
    assert.equal(prompts(fixture).length, 1)
    await fixture.api('/api/chat/runtime/stop', {})
    await fixture.reopen()
    const reopened = await fixture.api('/api/chat/activity')
    assert.equal(reopened.state, 'stopped')
    assert.deepEqual(reopened.items, [])
    assert.equal(prompts(fixture).length, 1)
    assert(fixture.calls.length >= callCount)
    assert.deepEqual(fixture.errors, [])
    console.log(JSON.stringify({ kind: 'native-activity-stop-get', stopped, stopGetWrites: false, replayedPrompts: 0,
      newInstanceActivity: reopened, onlyCurrentNativeHost: true }))
  })

test('actual timeout observation keeps unknown execution isolated and never replays or exposes model data', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context, { evidenceRoot: process.env.NATIVE_ACTIVITY_EVIDENCE })
  await fixture.login()
  await fixture.configure(false)
  const policy = object((await fixture.api('/api/chat/execution')).policy)
  await fixture.save('execution', { policy: { ...policy, turnTimeoutMs: 1200, cancelOnTimeout: false, noticeEnabled: false } })
  await fixture.apply()
  await fixture.start()
  fixture.inbound(1)
  await until(() => prompts(fixture).length === 1, 'Expected accepted unanswered execution')
  await until(async () => (await entries(fixture)).some(entry => entry.type === 'timeout' && entry.conversationId === 'private:123'),
    'Expected actual controller deadline observation')
  const journal = await fixture.api('/api/chat/executions')
  assert(Array.isArray(journal.items) && journal.items.map(object).some(entry => entry.deadlineReached === true && entry.isolated === true))
  fixture.inbound(2)
  await until(async () => object(object((await fixture.status()).ingress).lastReceipt).status === 'queued',
    'New input waits behind the unresolved execution without replay')
  assert.equal(prompts(fixture).length, 1)
  assert.equal(fixture.sends.length, 0)
  assert.equal(fixture.calls.filter(call => call.method === 'session/cancel').length, 0)
  assert.deepEqual(fixture.errors, [])
})

test('default native transport records actual unconfirmed delivery as warning, never as a confirmed send', { timeout: 60_000 }, async context => {
  const fixture = await createNativeCapabilityRuntimeFixture(context)
  const onebot = createServer((request, response) => {
    if (request.url === '/get_login_info') {
      response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 999 } }))
    } else response.destroy()
  })
  await new Promise<void>(resolve => onebot.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve, reject) => onebot.close(error => error ? reject(error) : resolve())))
  const address = onebot.address()
  assert(address && typeof address !== 'string')
  await fixture.login()
  await fixture.configure(false)
  await fixture.save('adapters', { adapters: {
    onebotHttp: { enabled: true, endpoint: `http://127.0.0.1:${address.port}`, secret: 'synthetic-unknown-send' } } })
  await fixture.apply()
  await fixture.start()
  await complete(fixture, 1)
  await until(async () => (await entries(fixture)).some(entry => entry.type === 'sent' && entry.level === 'warning'),
    'Expected actual unconfirmed transport receipt')
  const activity = await entries(fixture)
  assert(!activity.some(entry => entry.summary === '协议已确认发送回复。'))
  assert(activity.some(entry => entry.summary === '回复发送结果未确认，未自动重复发送。'))
  assert(activity.filter(entry => entry.type === 'sent').every(entry => entry.content === null))
  assert.equal(prompts(fixture).length, 1)
})
