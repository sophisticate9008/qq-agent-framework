import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { createStickerImageMetadata, readStickerImageDimensions, stickerImageIdentity } from '../src/host/sticker-image-metadata.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

test('image layout metadata remains account/content scoped without changing image records', context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close())
  const id = 'a'.repeat(64), source = { md5: 'b'.repeat(32), url: 'https://example.test/old' }
  const identity = stickerImageIdentity(source), metadata = createStickerImageMetadata(store, 'account')
  metadata.remember(id, identity, { width: 600, height: 300 })
  assert.deepEqual(metadata.read(id, stickerImageIdentity({ ...source, url: 'https://example.test/new' })), { width: 600, height: 300 })
  assert.equal(metadata.read(id, stickerImageIdentity({ ...source, md5: 'c'.repeat(32) })), null)
  assert.equal(createStickerImageMetadata(store, 'other-account').read(id, identity), null)
  assert.equal(store.list('native-chat.sticker-library').length, 0)
})

test('layout dimensions follow the actual image EXIF orientation', async () => {
  const image = await sharp({ create: { width: 80, height: 40, channels: 3, background: 'blue' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer()
  assert.deepEqual(await readStickerImageDimensions(image, new AbortController().signal), { width: 40, height: 80 })
})
