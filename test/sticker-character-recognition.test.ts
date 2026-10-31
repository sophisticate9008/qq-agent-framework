import assert from 'node:assert/strict'
import test from 'node:test'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createStickerCharacterRecognition } from '../src/host/sticker-character-recognition.ts'
import type { StickerAnnotation } from '../src/host/sticker-semantics.ts'

const annotation: StickerAnnotation = { description: '白色小猫挥手', tags: ['问候'], avoid: '',
  visual: { colors: ['白色'], styles: ['Q版'], entities: ['白猫'] } }
const rule = { character: '白猫角色', aliases: ['小白'], entities: ['白猫'], evidence: '本账号将白猫形象关联为此角色' }

test('account recognition rules use visible entities and preserve inference provenance', () => {
  const store = createSqliteStore({ filename: ':memory:' })
  try {
    const rules = createStickerCharacterRecognition(store, 'account-a')
    rules.remember(rule)
    assert.equal(rules.apply(annotation).identity?.character, '白猫角色')
    assert.equal(rules.apply(annotation).identity?.source, 'model')
    assert.equal(createStickerCharacterRecognition(store, 'account-b').apply(annotation).identity, undefined)
    assert.equal(rules.apply({ ...annotation, visual: { colors: ['白色'], styles: [], entities: ['小狗'] } }).identity, undefined)
    assert.equal(rules.apply({ description: '白猫角色', tags: ['白猫'], avoid: '' }).identity, undefined)
    assert.equal(rules.apply({ ...annotation, visual: { colors: [], styles: [], entities: ['非白猫', '没有白猫元素'] } }).identity, undefined)
    assert.throws(() => rules.remember({ ...rule, aliases: ['HUG', 'ｈｕｇ'] }))
  } finally { store.close() }
})

test('ambiguous rules abstain and confirmed image identity remains intact', () => {
  const store = createSqliteStore({ filename: ':memory:' })
  try {
    const rules = createStickerCharacterRecognition(store, 'account-a')
    rules.remember(rule)
    rules.remember({ ...rule, character: '另一只白猫' })
    assert.equal(rules.apply(annotation).identity, undefined)
    const confirmed: StickerAnnotation = { ...annotation, identity: { character: '用户确认的猫', aliases: [], source: 'user' } }
    assert.deepEqual(rules.apply(confirmed), confirmed)
  } finally { store.close() }
})
