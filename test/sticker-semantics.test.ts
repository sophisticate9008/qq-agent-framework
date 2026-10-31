import assert from 'node:assert/strict'
import test from 'node:test'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createStickerSemanticCache, stickerSemanticKey, stickerSemanticScore, stickerEmotions, validateStickerAnnotation } from '../src/host/sticker-semantics.ts'

const sticker = { id: 'actual-collection-item', md5: 'a'.repeat(32), url: 'https://media.example.test/item?signature=old' }
const annotation = { description: '笑着伸手要抱抱的小动物', tags: ['亲近', '开心', '贴贴', '可爱'], avoid: '争执或认真批评时' }
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

const facets = { emotions: ['无语'], actions: ['扶额'], intents: ['调侃'], scenes: ['室内'], visibleText: '你礼貌吗' }
test('structured facets keep OCR, expression, action and communicative intent separately searchable', () => {
  const labelled = validateStickerAnnotation({ description: '角色用手扶额，抬眼看向前方', tags: ['扶额'], avoid: '认真道歉时', facets })
  assert.deepEqual(labelled.facets, facets)
  assert(stickerSemanticScore('你礼貌吗', '', labelled) > 0)
  assert(stickerSemanticScore('facepalm', '', labelled) > 0)
  assert(stickerSemanticScore('banter', '', labelled) > 0)
  assert(stickerSemanticScore('室内', '', labelled) > 0)
  assert.equal(stickerSemanticScore('道歉', '', labelled), 0)
  assert.equal(stickerSemanticScore('开心', '', labelled), 0)
  assert(stickerSemanticScore('调侃', '', labelled) > stickerSemanticScore('调侃', '', {
    description: '角色站在空白背景前，适合调侃', tags: [], avoid: '',
  }))
})
test('recall does not equate cute appearance, food or praise with affection, happiness or pride', () => {
  const neutral = { description: '可爱的小动物抱着饭碗', tags: ['可爱', '饭碗'], avoid: '' }
  assert.equal(stickerSemanticScore('hug', '', neutral), 0)
  assert.equal(stickerSemanticScore('开心', '', neutral), 0)
  assert.equal(stickerSemanticScore('得意', '', { ...neutral, tags: ['夸奖'] }), 0)
  assert.equal(stickerSemanticScore('亲近', '', { ...neutral, tags: ['傲娇'] }), 0)
  assert.equal(stickerSemanticScore('hi', 'white.png', null), 0)
  assert.equal(stickerSemanticScore('开心', '', { description: '不太开心，不想高兴', tags: [], avoid: '' }), 0)
  assert.equal(stickerSemanticScore('happy', '', { description: 'not happy', tags: [], avoid: '' }), 0)
  assert.equal(stickerSemanticScore('happy', '', { description: 'unhappy', tags: [], avoid: '' }), 0)
  assert.deepEqual(stickerEmotions('傲娇的角色受到夸奖，举着饭碗'), [])
  assert(stickerSemanticScore('ｈｕｇ', '', { ...neutral, tags: ['拥抱'] }) > 0)
})
test('annotation decoder bounds each facet and rejects invented fields and duplicate normalized labels', () => {
  assert.throws(() => validateStickerAnnotation({ ...annotation, facets: { ...facets, sender: 'somebody' } }))
  assert.throws(() => validateStickerAnnotation({ ...annotation, facets: { ...facets, intents: Array(5).fill('调侃') } }))
  assert.throws(() => validateStickerAnnotation({ ...annotation, facets: { ...facets, visibleText: 'a'.repeat(161) } }))
  assert.throws(() => validateStickerAnnotation({ ...annotation, facets: { ...facets, actions: ['扶额', '扶额'] } }))
  assert.throws(() => validateStickerAnnotation({ ...annotation, facets: { ...facets, scenes: ['室内\n餐桌'] } }))
  assert.throws(() => validateStickerAnnotation({ ...annotation, tags: ['HUG', 'ｈｕｇ'] }))
  assert.throws(() => validateStickerAnnotation({ ...annotation, facets: {} }))
  assert.equal(validateStickerAnnotation(annotation).facets, undefined)
})
test('structured annotations persist without migrating legacy account cache records', context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close())
  const cache = createStickerSemanticCache(store, '999')
  cache.remember(sticker, annotation)
  assert.deepEqual(cache.read(sticker), annotation)
  const updated = { ...annotation, facets }
  cache.remember(sticker, updated)
  assert.deepEqual(createStickerSemanticCache(store, '999').read(sticker), updated)
  assert.equal(createStickerSemanticCache(store, '998').read(sticker), null)
  cache.forget(sticker)
  assert.equal(cache.read(sticker), null)
})
