import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRecord } from '../src/core/values.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { openReadonlySqliteStore } from '../src/storage/sqlite-readonly.ts'
import { createNativeWorkHistoryReader } from '../src/host/native-work-history.ts'
import { createNativeWorkRoutes } from '../src/admin/native-work.ts'
import { createAdminServer } from '../src/admin/server.ts'
import { parseNativeWorkDetailSnapshot, parseNativeWorkListSnapshot, parseNativeWorkView } from '../src/contracts/native-work.ts'

function record(id: string, conversationId = 'group:123') {
  return { schema: 1, id, childId: `child-${id}`, parentSessionId: 'parent', conversationId, generation: 2,
    createdAt: 100, deadlineAt: 200, status: 'starting', result: null, lateResult: null,
    task: 'private task must never reach management output', configuration: { secret: 'private-secret' } }
}

test('stopped work history reads preserved evidence without executor recovery or business writes', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-work-history-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'native-chat.sqlite')
  const store = createSqliteStore({ filename })
  store.write('native-work.executions', 'a', record('a'))
  store.write('native-work.executions', 'b', record('b', 'private:456'))
  store.write('native-work.executions', 'c', { ...record('c'), status: 'completed', result: { stopReason: 'end', output: [{ type: 'text', text: 'done' }] },
    delivery: 'confirmed', deliveryFileId: 'uploaded-file', deliveryMessageId: null })
  store.close()
  const bytes = await readFile(filename)
  const readonly = openReadonlySqliteStore(filename)
  context.after(() => readonly.close())
  const reader = createNativeWorkHistoryReader(readonly)
  assert.equal(reader.read('a')?.status, 'starting')
  assert.equal(reader.read('c')?.deliveryFileId, 'uploaded-file')
  assert.equal(reader.read('missing'), null)
  const first = reader.list({ limit: 1, conversationId: 'private:456' })
  assert.deepEqual(first, { records: [], next: 'a' })
  const second = reader.list({ limit: 1, after: first.next!, conversationId: 'private:456' })
  assert.deepEqual(second.records.map(item => item.id), ['b'])
  const output = JSON.stringify(reader.list())
  assert.equal(output.includes('private-secret'), false)
  assert.equal(output.includes('private task'), false)
  assert.deepEqual(await readFile(filename), bytes)
  const stored = readonly.read('native-work.executions', 'a')?.value
  assert(isRecord(stored)); assert.equal(stored.status, 'starting')
})

test('work DTO rejects authority fields and invalid content, media URLs, cursors and timestamps', () => {
  const store = createSqliteStore({ filename: ':memory:' })
  try {
    store.write('native-work.executions', 'a', record('a'))
    const view = createNativeWorkHistoryReader(store).read('a')!
    assert(parseNativeWorkView(view))
    assert.equal(parseNativeWorkView({ ...view, task: 'hidden' }), null)
    assert.equal(parseNativeWorkView({ ...view, deadlineAt: 99 }), null)
    assert.equal(parseNativeWorkView({ ...view, generation: 0 }), null)
    assert.equal(parseNativeWorkView({ ...view, result: { stopReason: 'end', output: [{ type: 'image', url: 'https://example.invalid' }] } }), null)
    assert.equal(parseNativeWorkListSnapshot({ schema: 1, records: [view, view], next: null }), null)
    assert.equal(parseNativeWorkListSnapshot({ schema: 1, records: [], next: '' }), null)
    assert(parseNativeWorkDetailSnapshot({ schema: 1, record: view }))
    store.write('native-work.executions', 'bad', { ...record('bad'), generation: 0 })
    assert.throws(() => createNativeWorkHistoryReader(store).read('bad'), { code: 'INVALID_NATIVE_WORK_RECORD' })
  } finally { store.close() }
})

test('work HTTP is strictly read-only, bounded and reports corrupt evidence as unavailable', async context => {
  const store = createSqliteStore({ filename: ':memory:' })
  context.after(() => store.close())
  store.write('native-work.executions', 'a', record('a'))
  const reader = createNativeWorkHistoryReader(store)
  const token = 'readonly-work-admin-token-12345678'
  const server = createAdminServer({ token, snapshot: () => ({}), routes: createNativeWorkRoutes(reader) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const get = (query = '') => fetch(`${origin}/api/chat/work${query}`, { headers: { authorization: `Bearer ${token}` } })
  assert.deepEqual(parseNativeWorkListSnapshot(await (await get('?limit=1')).json())?.records.map(item => item.id), ['a'])
  assert.equal(parseNativeWorkDetailSnapshot(await (await get('?id=a')).json())?.record.status, 'starting')
  assert.equal((await get('?id=missing')).status, 404)
  for (const query of ['?limit=1001', '?limit=0', '?id=a&after=b', '?after=', '?limit=1&limit=2', '?action=start'])
    assert.equal((await get(query)).status, 400)
  const write = await fetch(`${origin}/api/chat/work`, { method: 'POST', headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start' }) })
  assert.equal(write.status, 405)
  store.write('native-work.executions', 'bad', { ...record('bad'), childId: '' })
  const bad = await get('?id=bad')
  assert.equal(bad.status, 503)
  assert.deepEqual(await bad.json(), { error: 'native_work_history_unavailable' })
  const stored = store.read('native-work.executions', 'a')?.value
  assert(isRecord(stored)); assert.equal(stored.status, 'starting')
})
