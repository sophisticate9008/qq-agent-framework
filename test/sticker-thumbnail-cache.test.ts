import assert from 'node:assert/strict'
import test from 'node:test'
import { createStickerThumbnailCache } from '../src/host/sticker-thumbnail-cache.ts'
import type { StickerLibraryThumbnail } from '../src/contracts/sticker-library.ts'

const signal = () => new AbortController().signal
const preview = { image: 'data:image/jpeg;base64,/9j/', width: 640, height: 320 }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('shared previews reuse one job without allowing one cancelled viewer to cancel another', async () => {
  const cache = createStickerThumbnailCache()
  let loads = 0, release!: (value: StickerLibraryThumbnail) => void, shared!: AbortSignal
  const controller = new AbortController()
  const load = (current: AbortSignal) => { loads++; shared = current; return new Promise<StickerLibraryThumbnail>(resolve => { release = resolve }) }
  const first = cache.get('image', 'content', load, controller.signal)
  const second = cache.get('image', 'content', load, signal())
  const aborted = assert.rejects(first)
  await tick(); controller.abort(); await aborted
  assert.equal(loads, 1); assert.equal(shared.aborted, false)
  release(preview)
  assert.deepEqual(await second, preview)
  assert.deepEqual(await cache.get('image', 'content', async () => { loads++; return preview }, signal()), preview)
  assert.equal(loads, 2)
  await cache.close()
})

test('invalidated late work cannot overtake a new image version', async () => {
  const cache = createStickerThumbnailCache()
  let release!: (value: StickerLibraryThumbnail) => void
  const old = cache.get('image', 'old', () => new Promise<StickerLibraryThumbnail>(resolve => { release = resolve }), signal())
  const rejected = assert.rejects(old)
  await tick(); cache.invalidate('image'); await rejected
  const replacement = { ...preview, width: 320, height: 640 }
  const fresh = cache.get('image', 'new', async () => replacement, signal())
  release(preview); await tick()
  assert.deepEqual(await fresh, replacement)
  assert.deepEqual(await cache.get('image', 'new', async () => replacement, signal()), replacement)
  await cache.close()
})

test('cancelled raw work retains its concurrency slot until settlement', async () => {
  const cache = createStickerThumbnailCache(), controller = new AbortController()
  const releases: Array<(value: StickerLibraryThumbnail) => void> = []
  let loads = 0
  const pending = Array.from({ length: 4 }, (_, index) => cache.get(String(index), 'version', async () => {
    loads++; return new Promise<StickerLibraryThumbnail>(resolve => { releases.push(resolve) })
  }, index === 0 ? controller.signal : signal()))
  const completed = Promise.allSettled(pending)
  await tick(); assert.equal(loads, 1)
  controller.abort(); await tick(); assert.equal(loads, 1)
  for (let index = 0; index < 4; index++) { releases[index]!(preview); await tick(); assert.equal(loads, Math.min(index + 2, 4)) }
  const results = await completed
  assert.equal(results[0]!.status, 'rejected')
  assert(results.slice(1).every(result => result.status === 'fulfilled'))
  await cache.close()
})

test('completed previews are not retained in the process', async () => {
  const cache = createStickerThumbnailCache()
  let loads = 0
  const load = async () => { loads++; return { image: `data:image/jpeg;base64,${'a'.repeat(190_000)}` } }
  for (let index = 0; index < 50; index++) await cache.get(String(index), 'version', load, signal())
  await cache.get('0', 'version', load, signal())
  assert.equal(loads, 51)
  await cache.close()
})
