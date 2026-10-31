import assert from 'node:assert/strict'
import test from 'node:test'
import { createStickerLibraryRoutes } from '../src/admin/sticker-library.ts'
import { AdminRequestError, createAdminServer } from '../src/admin/server.ts'
import { parseStickerLibrarySnapshot } from '../src/contracts/sticker-library.ts'
import { FrameworkError } from '../src/core/values.ts'

const id = 'a'.repeat(64)
const snapshot = { schema: 1, accountCollection: 'confirmed', capacity: { count: 0, nearFullAt: 240, capacityKnown: false },
  items: [], limited: false, pending: 0 }
function fixture() {
  const calls: unknown[] = []
  let list: unknown = snapshot, preview: unknown = { image: 'data:image/jpeg;base64,/9j/' }, result: unknown = { status: 'unknown' }
  let failure: unknown, connected = true
  const manager = {
    async snapshot(signal: AbortSignal) { signal.throwIfAborted(); if (failure) throw failure; return list },
    async thumbnail(stickerId: string, signal: AbortSignal) { calls.push(stickerId); signal.throwIfAborted(); if (failure) throw failure; return preview },
    async remove(stickerId: string, revision: number, operationId: string, signal: AbortSignal) {
      calls.push({ stickerId, revision, operationId }); signal.throwIfAborted(); if (failure) throw failure; return result
    },
  }
  const routes = createStickerLibraryRoutes({ stickerLibrary: () => connected ? manager : undefined })
  return { calls, routes, setList(value: unknown) { list = value }, setPreview(value: unknown) { preview = value },
    setResult(value: unknown) { result = value }, setFailure(value: unknown) { failure = value }, disconnect() { connected = false },
    invoke(path: 'library' | 'preview' | 'delete', body: Record<string, unknown> | null = null, query = new URLSearchParams(), signal = new AbortController().signal) {
      const route = routes.find(route => route.pathname === `/api/chat/stickers/${path}`)
      assert(route); return Promise.resolve().then(() => route.handle({ query, body, signal }))
    } }
}
function rejected(promise: Promise<unknown>, status: number, code: string) {
  return assert.rejects(promise, error => error instanceof AdminRequestError && error.statusCode === status && error.code === code)
}

test('sticker routes expose clean snapshots and thumbnails without account, path or protocol URLs', async () => {
  const f = fixture()
  f.setList({ ...snapshot, directory: '/private', accountId: 'private' })
  assert.deepEqual(await f.invoke('library'), snapshot)
  f.setPreview({ image: 'data:image/jpeg;base64,/9j/', url: 'https://private.example' })
  assert.deepEqual(await f.invoke('preview', null, new URLSearchParams({ id })), { image: 'data:image/jpeg;base64,/9j/' })
  assert.deepEqual(f.calls, [id])
  f.disconnect(); await rejected(f.invoke('library'), 503, 'runtime_not_connected')
})

test('sticker routes reject unsupported queries and invalid deletes before dispatch', async () => {
  const f = fixture(), valid = { id, revision: 1, operationId: 'operation-delete-1234' }
  await rejected(f.invoke('library', null, new URLSearchParams('account=other')), 400, 'invalid_sticker_query')
  for (const query of ['id=bad', `id=${id}&id=${id}`, `id=${id}&url=https://private.example`]) {
    await rejected(f.invoke('preview', null, new URLSearchParams(query)), 400, 'invalid_sticker_query')
  }
  for (const body of [{ ...valid, revision: 0.5 }, { ...valid, revision: NaN }, { ...valid, path: '/private' },
    { ...valid, operationId: 'short' }, { ...valid, id: '../private' }, { ...valid, id: undefined, arbitrary: id }]) {
    await rejected(f.invoke('delete', body), 400, 'invalid_sticker_delete')
  }
  assert.deepEqual(f.calls, [])
})

test('sticker delete preserves operation identity and returns unknown without retry instructions', async () => {
  const f = fixture(), body = { id, revision: 3, operationId: 'operation-delete-1234' }
  f.setResult({ status: 'unknown', error: 'private protocol response' })
  assert.deepEqual(await f.invoke('delete', body), { status: 'unknown', retry: false })
  assert.deepEqual(f.calls, [{ stickerId: id, revision: 3, operationId: body.operationId }])
  f.setResult({ status: 'unexpected' })
  await rejected(f.invoke('delete', { ...body, operationId: 'operation-delete-5678' }), 503, 'sticker_delete_result_unknown')
})

test('sticker routes sanitize malformed results and translate stable host errors', async () => {
  const f = fixture()
  f.setList({ ...snapshot, capacity: { count: 0, nearFullAt: 240, capacityKnown: true } })
  await rejected(f.invoke('library'), 503, 'sticker_library_invalid_response')
  f.setPreview({ image: 'https://private.example' })
  await rejected(f.invoke('preview', null, new URLSearchParams({ id })), 503, 'sticker_library_invalid_preview')
  f.setFailure(new FrameworkError('STICKER_DELETE_CONFLICT', 'private details'))
  await rejected(f.invoke('delete', { id, revision: 1, operationId: 'operation-delete-1234' }), 409, 'sticker_delete_conflict')
  f.setFailure(new Error('/private/credentials'))
  await rejected(f.invoke('library'), 503, 'sticker_library_unavailable')
})

test('sticker routes register with the real admin server and bound large UTF-8 snapshots visibly', async t => {
  const f = fixture()
  const server = createAdminServer({ token: 'sticker-admin-test-token', snapshot: () => ({}), routes: f.routes })
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); assert(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/api/chat/stickers/library`
  const headers = { authorization: 'Bearer sticker-admin-test-token' }
  const ordinary = await fetch(url, { headers })
  assert.equal(ordinary.status, 200)
  assert.deepEqual(await ordinary.json(), snapshot)

  const items = Array.from({ length: 6100 }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), revision: 1,
    name: '图'.repeat(255), description: '开'.repeat(240), avoid: '慎'.repeat(128),
    tags: Array.from({ length: 12 }, (_, tag) => `${tag.toString(16)}${'笑'.repeat(23)}`), storage: index < 5000 ? 'account' : 'extra',
    state: 'ready', canDelete: true, createdAt: 1 }))
  f.setList({ ...snapshot, capacity: { count: 5000, nearFullAt: 240, capacityKnown: false }, items })
  const large = await fetch(url, { headers }), text = await large.text()
  assert.equal(large.status, 200)
  assert(Buffer.byteLength(text) <= 4 * 1024 * 1024)
  const parsed = parseStickerLibrarySnapshot(JSON.parse(text) as unknown)
  assert(parsed && parsed.limited)
  assert(parsed.items.length > 0 && parsed.items.length < items.length)
  assert.deepEqual(parsed.items, items.slice(0, parsed.items.length))
  assert.deepEqual(parsed.capacity, { count: 5000, nearFullAt: 240, capacityKnown: false })
  const preview = await fetch(`http://127.0.0.1:${address.port}/api/chat/stickers/preview?id=${id}`, { headers })
  assert.equal(preview.status, 200)
  assert.deepEqual(await preview.json(), { image: 'data:image/jpeg;base64,/9j/' })
})
