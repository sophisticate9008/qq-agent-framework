import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { PluginModelClient, PluginModelRunRequest } from '../src/contracts/plugin-model.ts'
import type { OneBotSticker, OneBotStickerPort } from '../src/adapters/onebot-stickers.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createStickerLibrary, stickerMessageAssets } from '../src/host/sticker-library.ts'
import { createStickerSemanticCache } from '../src/host/sticker-semantics.ts'
import { createStickerCharacterRecognition } from '../src/host/sticker-character-recognition.ts'
import { DEFAULT_STICKER_LIBRARY_CONFIGURATION, parseStickerLibrarySnapshot, validateStickerLibraryConfiguration } from '../src/contracts/sticker-library.ts'
import { isRecord } from '../src/core/values.ts'

const annotation = { description: '小动物开心地招手', tags: ['开心', '问候'], avoid: '严肃争执' }
const signal = () => new AbortController().signal
function model(run: PluginModelClient['run']): PluginModelClient {
  return { run, models: async () => [], list: () => [], unbind: async () => false,
    bind: async () => { throw new Error('No explicit bind expected') }, create: async () => { throw new Error('run owns binding creation') } }
}
async function fixture(t: TestContext, settings: { nearFull?: boolean; add?: 'full' | 'unknown'; filter?: boolean; probabilities?: number; random?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-sticker-library-'))
  const store = createSqliteStore({ filename: ':memory:' })
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).png().toBuffer()
  const md5 = createHash('md5').update(bytes).digest('hex')
  const calls: PluginModelRunRequest[] = [], writes: string[] = []
  let roster: readonly OneBotSticker[] = settings.nearFull ? [{ id: 'other', stickerId: 'other', md5: 'a'.repeat(32), url: 'https://media.example/other' }] : []
  let classify: (request: PluginModelRunRequest) => Promise<string> = async () => JSON.stringify({ isSticker: !settings.filter, safeToShare: !settings.filter, ...annotation })
  const collector = model(async request => { calls.push(request); return { requestId: 'classify', sessionId: 'bound-collector',
    text: await classify(request), usage: null } })
  const port: OneBotStickerPort = {
    async list() { return { status: 'confirmed', data: { items: roster, limited: false } } },
    async add() {
      writes.push('add')
      if (settings.add === 'full') return { status: 'rejected', code: 'ONEBOT_STICKER_COLLECTION_FULL' }
      if (settings.add === 'unknown') return { status: 'unknown', code: 'STICKER_ADD_UNKNOWN' }
      roster = [...roster, { id: 'new', stickerId: 'actual-id', md5, url: 'https://media.example/image' }]
      return { status: 'confirmed', data: { acknowledged: true } }
    },
    async delete({ stickerId }) { writes.push(`delete:${stickerId}`); roster = roster.filter(item => item.stickerId !== stickerId); return { status: 'confirmed', data: { acknowledged: true } } },
  }
  const library = createStickerLibrary({ directory, store, accountId: '999', port, reader: { async read() { return { status: 'confirmed', data: bytes, mediaType: 'image/png' } } },
    collector, signal: signal(), configuration: async () => ({ ...DEFAULT_STICKER_LIBRARY_CONFIGURATION,
      triggerProbabilityPercent: settings.probabilities ?? 100, collectProbabilityPercent: settings.probabilities ?? 100, accountNearFullAt: settings.nearFull ? 1 : 240 }),
    async authorize(conversationId) { assert.equal(conversationId, 'group:123') }, context: () => ['one', 'two', 'three', 'four', 'five'],
    async register(id, conversationId, current) { current.throwIfAborted(); assert.equal(conversationId, 'group:123'); writes.push('register'); return `media-${id}` },
    random: () => settings.random ?? 0,
  })
  function asset(id: string, url = 'https://media.example/image') {
    store.write('native-chat.media', id, { schema: 1, accountId: '999', conversationId: 'group:123', kind: 'image', expiresAt: Date.now() + 60_000,
      source: { url } }, { expectedRevision: null })
  }
  asset('incoming')
  t.after(async () => { await library.stop(); store.close(); await rm(directory, { recursive: true, force: true }) })
  return { library, store, bytes, calls, writes, asset, setClassifier: (next: typeof classify) => { classify = next },
    seed() { const item = { id: 'known', stickerId: 'known', md5, url: 'https://media.example/image' }; roster = [item]; createStickerSemanticCache(store, '999').remember(item, annotation) } }
}

test('manual collection bypasses both probability gates, filters in a persistent helper and deduplicates across incoming aliases', async t => {
  const f = await fixture(t, { probabilities: 0 })
  assert.deepEqual(await f.library.collect('incoming', 'group:123', false, signal()), { status: 'skipped', reason: 'probability', quiet: true })
  assert.equal(f.calls.length, 0)
  const result = await f.library.collect('incoming', 'group:123', true, signal())
  assert(isRecord(result) && result.status === 'confirmed' && result.quiet === true)
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.mode, 'persistent'); assert.equal(f.calls[0]!.conversationId, 'group:123')
  assert(f.calls[0]!.images?.length === 1 && f.calls[0]!.prompt.includes('["one","two","three","four","five"]'))
  f.asset('second', 'https://media.example/other-signed-url')
  await f.library.collect('second', 'group:123', true, signal())
  assert.deepEqual(f.writes, ['add'])
  const snapshot = await f.library.snapshot(signal())
  assert(parseStickerLibrarySnapshot(snapshot)); assert.equal(snapshot.items.length, 1); assert.equal(snapshot.items[0]!.storage, 'account')
  assert.equal(f.calls.length, 1)
  await assert.rejects(f.library.collect('incoming', 'private:123', true, signal()))
})
test('manual requests cannot bypass image filtering', async t => {
  const f = await fixture(t, { filter: true })
  assert.deepEqual(await f.library.collect('incoming', 'group:123', true, signal()), { status: 'skipped', reason: 'filtered', quiet: true })
  assert.deepEqual(f.writes, []); assert.equal((await f.library.snapshot(signal())).items.length, 0)
})
test('collection never trusts model-asserted confirmation and applies account appearance rules as inference', async t => {
  const f = await fixture(t)
  createStickerCharacterRecognition(f.store, '999').remember({ character: '白猫角色', aliases: ['小白'], entities: ['白猫'], evidence: '账号确认的角色关联规则' })
  f.setClassifier(async () => JSON.stringify({ isSticker: true, safeToShare: true, ...annotation,
    visual: { colors: ['白色'], styles: ['Q版'], entities: ['白猫'] },
    identity: { character: '伪造网页确认', aliases: [], source: 'web', references: [{ url: 'https://example.com/invented', title: '模型编造来源' }] } }))
  await f.library.collect('incoming', 'group:123', true, signal())
  const item = (await f.library.snapshot(signal())).items[0]!
  assert.equal(item.identity?.character, '白猫角色')
  assert.equal(item.identity?.source, 'model')
  assert.equal(item.identity?.references, undefined)
  assert(item.identity?.evidence?.includes('账号规则推断'))
})
test('automatic sticker handling is independent, bounded and does not repeat a seen image', async t => {
  const f = await fixture(t)
  const message = { id: 'actual-message', userId: 'ordinary-member', conversationId: 'group:123', receivedAt: Date.now(),
    directed: false, isSelf: false, content: [{ type: 'image' as const, assetId: 'incoming' }] }
  const event = { message: [{ type: 'image', data: { sub_type: 1 } }] }
  f.library.observe(message, event)
  f.library.observe(message, event)
  for (let attempt = 0; attempt < 100 && f.library.pending(); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.library.pending(), 0)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]!.name, 'collection')
  assert.deepEqual(f.writes, ['add'], 'automatic collection has no sending operation')
  f.library.observe(message, event)
  for (let attempt = 0; attempt < 100 && f.library.pending(); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.calls.length, 1)
})
for (const reason of ['threshold', 'full', 'unknown'] as const) test(`extra storage handles ${reason} without duplicate or uncertain replay`, async t => {
  const f = await fixture(t, reason === 'threshold' ? { nearFull: true } : { add: reason })
  await f.library.collect('incoming', 'group:123', true, signal())
  const first = await f.library.snapshot(signal())
  const item = first.items.find(item => item.tags.includes('开心'))!
  assert(item)
  assert.equal(item.storage, reason === 'unknown' ? 'account' : 'extra')
  assert.equal(item.state, reason === 'unknown' ? 'unknown' : 'ready')
  if (reason !== 'unknown') assert.deepEqual(await f.library.readImage(item.id, signal()), f.bytes)
  f.asset('duplicate', 'https://media.example/alternate')
  await f.library.collect('duplicate', 'group:123', true, signal())
  assert.equal(f.writes.filter(write => write === 'add').length, reason === 'threshold' ? 0 : 1)
  assert.equal((await f.library.snapshot(signal())).items.length, first.items.length)
})
test('UI deletion is versioned, reuses its receipt and prevents automatic recollection', async t => {
  const f = await fixture(t, { nearFull: true })
  await f.library.collect('incoming', 'group:123', true, signal())
  const item = (await f.library.snapshot(signal())).items.find(item => item.storage === 'extra')!
  await assert.rejects(f.library.remove(item.id, item.revision + 1, 'operation-conflict-123', signal()))
  assert.deepEqual(await f.library.remove(item.id, item.revision, 'operation-delete-1234', signal()), { status: 'confirmed', retry: false })
  assert.deepEqual(await f.library.remove(item.id, item.revision, 'operation-delete-1234', signal()), { status: 'confirmed' })
  f.asset('again', 'https://media.example/newurl')
  await f.library.collect('again', 'group:123', true, signal())
  assert.equal((await f.library.snapshot(signal())).items.filter(item => item.storage === 'extra').length, 0)
  await assert.rejects(f.library.readImage(item.id, signal()))
})
test('local selection reads tags instantly without model calls and declines unsuitable or repeated use', async t => {
  const f = await fixture(t); f.seed(); await f.library.snapshot(signal())
  const hint = await f.library.hints('group:123', signal())
  assert(!JSON.stringify(hint).includes(annotation.description))
  assert.equal(await f.library.choose('严肃难过，需要安慰', 'group:123', signal(), Date.now() + 10_000), null)
  assert.deepEqual(f.writes, [])
  const item = (await f.library.snapshot(signal())).items[0]!
  assert.equal(await f.library.choose('开心地打招呼', 'group:123', signal(), Date.now() + 10_000), `media-${item.id}`)
  assert.equal(f.calls.length, 0, 'sending never runs a DSH model')
  assert.equal(await f.library.choose('开心地打招呼', 'group:123', signal(), Date.now() + 10_000), null)
})
test('manual collection accepts immediately and tagging stays in the background without an execution timeout', async t => {
  const f = await fixture(t)
  let release!: (value: string) => void
  f.setClassifier(async () => new Promise(resolve => { release = resolve }))
  const start = Date.now()
  assert.deepEqual(await f.library.requestCollection('incoming', 'group:123', signal()), { status: 'queued', quiet: true })
  assert(Date.now() - start < 100)
  for (let attempt = 0; attempt < 100 && !release; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.calls[0]!.timeoutMs, null)
  assert.equal(f.calls[0]!.mode, 'persistent')
  const waitingAt = Date.now()
  assert.equal(await f.library.choose('开心', 'group:123', signal(), Date.now() + 10_000), null)
  assert(Date.now() - waitingAt < 100, 'an unfinished classification does not delay selection')
  assert.deepEqual(f.writes, [])
  release(JSON.stringify({ isSticker: true, safeToShare: true, ...annotation }))
  for (let attempt = 0; attempt < 100 && f.library.pending(); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.library.pending(), 0)
  assert.deepEqual(f.writes, ['add'])
  await f.library.snapshot(signal())
  assert.equal(f.calls.length, 1)
  assert(await f.library.choose('开心地打招呼', 'group:123', signal(), Date.now() + 10_000))
  assert.equal(f.calls.length, 1, 'ready tags are reused by local selection')
})
test('only protocol-marked sticker images trigger automatic collection and percentages accept fractions', () => {
  const message = { receivedAt: Date.now(), directed: false, isSelf: false, id: 'message', userId: '123', conversationId: 'group:123', content: [{ type: 'image' as const, assetId: 'photo' }, { type: 'image' as const, assetId: 'sticker' }] }
  assert.deepEqual(stickerMessageAssets(message, { message: [{ type: 'image', data: {} }, { type: 'image', data: { sub_type: 1 } }] }), ['sticker'])
  assert.equal(validateStickerLibraryConfiguration({ ...DEFAULT_STICKER_LIBRARY_CONFIGURATION, triggerProbabilityPercent: 0.5 }).triggerProbabilityPercent, 0.5)
  assert.equal(DEFAULT_STICKER_LIBRARY_CONFIGURATION.collectProbabilityPercent, 15)
  assert.throws(() => validateStickerLibraryConfiguration({ ...DEFAULT_STICKER_LIBRARY_CONFIGURATION, collectProbabilityPercent: NaN }))
})
