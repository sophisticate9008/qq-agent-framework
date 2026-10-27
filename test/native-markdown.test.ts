import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createNativeMarkdownService } from '../src/host/native-markdown.ts'

const event = { id: 'markdown-event', type: 'agent.message', conversationId: 'private:123', sessionId: 'original-session', data: { generation: 1 } }
const signal = new AbortController().signal

test('real PNG pages survive service reconstruction and require exact account, conversation, session, generation and TTL', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-markdown-'))
  let now = Date.now(); let generation = 1
  const store = createSqliteStore({ filename: ':memory:', clock: () => now })
  const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#abc' } }).png().toBuffer()
  const page = { png, width: 24, height: 16 }
  let calls = 0
  const options = { directory, store, accountId: '9001', clock: () => now,
    binding: () => ({ sessionId: 'original-session', generation }), authorize: async () => {},
    renderer: { async render() { calls++; return [page] } } }
  const service = createNativeMarkdownService(options)
  const restored = createNativeMarkdownService(options)
  context.after(async () => { await service.close(); await restored.close(); store.close(); await rm(directory, { force: true, recursive: true }) })
  const content = await service.render({ format: 'markdown-image', body: '# hello', event, signal })
  const image = content[0]; assert(image?.type === 'image')
  const request = { assetId: image.assetId, type: 'image' as const, conversationId: event.conversationId, sessionId: event.sessionId, generation: 1, signal }
  assert.deepEqual(await restored.resolve(request), { file: `base64://${png.toString('base64')}` })
  assert.deepEqual(await service.render({ format: 'markdown-image', body: '# hello', event, signal }), content)
  assert.equal(calls, 2)
  assert.equal((await readdir(join(directory, 'markdown-assets'))).length, 1)
  await assert.rejects(restored.resolve({ ...request, conversationId: 'group:123' }), { code: 'NATIVE_MARKDOWN_ASSET_SCOPE' })
  const otherAccount = createNativeMarkdownService({ ...options, accountId: '9009' })
  await assert.rejects(otherAccount.resolve(request), { code: 'NATIVE_MARKDOWN_ASSET_SCOPE' }); await otherAccount.close()
  generation = 2
  await assert.rejects(restored.resolve(request), { code: 'NATIVE_MARKDOWN_SESSION_STALE' })
  generation = 1; now += 24 * 60 * 60 * 1000 + 1
  await assert.rejects(restored.resolve(request), { code: 'NATIVE_MARKDOWN_ASSET_SCOPE' })
  await restored.maintenance()
  assert.deepEqual(await readdir(join(directory, 'markdown-assets')), [], 'periodic maintenance removes expired bytes without needing another render')
})

test('revoked or aborted rendering publishes no assets, and invalid PNG bytes never reach the outbox', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-markdown-cancel-'))
  const store = createSqliteStore({ filename: ':memory:' })
  const controller = new AbortController()
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } }).png().toBuffer()
  let allowed = true
  const service = createNativeMarkdownService({ directory, store, accountId: '9001', signal: controller.signal,
    binding: () => ({ sessionId: 'original-session', generation: 1 }), authorize: async () => { assert(allowed, 'revoked') },
    renderer: { async render() { allowed = false; return [{ png, width: 2, height: 2 }] } } })
  context.after(async () => { await service.close(); store.close(); await rm(directory, { force: true, recursive: true }) })
  await assert.rejects(service.render({ format: 'markdown-image', body: '# revoked', event, signal }), /revoked/)
  assert.equal(store.list('native-chat.markdown-assets').length, 0)
  const invalid = createNativeMarkdownService({ directory, store, accountId: '9001',
    binding: () => ({ sessionId: 'original-session', generation: 1 }), authorize: async () => {},
    renderer: { async render() { return [{ png: Buffer.from('not a png'), width: 2, height: 2 }] } } })
  await assert.rejects(invalid.render({ format: 'markdown-image', body: '# broken', event, signal }), { code: 'NATIVE_MARKDOWN_INVALID_PNG' })
  await invalid.close()
  controller.abort(); allowed = true
  await assert.rejects(service.render({ format: 'markdown-image', body: '# stopped', event, signal }))
  assert.equal(store.list('native-chat.markdown-assets').length, 0)
})
