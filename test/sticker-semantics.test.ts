import assert from 'node:assert/strict'
import test from 'node:test'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createStickerSemanticCache, stickerSemanticKey, stickerSemanticScore, validateStickerAnnotation } from '../src/host/sticker-semantics.ts'

const sticker = { id: 'actual-collection-item', md5: 'a'.repeat(32), url: 'https://media.example.test/item?signature=old' }
const annotation = { description: '笑着伸手要抱抱的小动物', tags: ['亲近', '开心', '贴贴'], avoid: '争执或认真批评时' }
test('semantic search bridges emotion synonyms without inventing image labels or importing private conversation facts', () => {
  assert(stickerSemanticScore('hug', '', annotation) > 0)
  assert(stickerSemanticScore('可爱', '', annotation) > 0)
  assert.equal(stickerSemanticScore('愤怒', '', annotation), 0)
  assert.equal(stickerSemanticScore('得意', 'unknown.png', null), 0)
  assert.equal(stickerSemanticScore('开心', '不开心', { description: '低落地坐着，不太开心', tags: ['委屈'], avoid: '' }), 0)
  assert(stickerSemanticScore('难过', '不开心', null) > 0)
  assert.throws(() => validateStickerAnnotation({ ...annotation, senderId: '123' }))
  assert.throws(() => validateStickerAnnotation({ ...annotation, tags: Array(13).fill('亲近') }))
})
test('annotations persist across service recreation, remain account-scoped, and invalidate when image identity changes', context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close())
  createStickerSemanticCache(store, '999').remember(sticker, annotation)
  assert.deepEqual(createStickerSemanticCache(store, '999').read({ ...sticker, url: 'https://media.example.test/item?signature=new' }), annotation)
  assert.equal(createStickerSemanticCache(store, '998').read(sticker), null)
  assert.equal(createStickerSemanticCache(store, '999').read({ ...sticker, md5: 'b'.repeat(32) }), null)
  assert.notEqual(stickerSemanticKey('999', { ...sticker, md5: undefined }), stickerSemanticKey('999', { ...sticker, md5: undefined, url: 'https://media.example.test/other' }))
})
