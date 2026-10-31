import assert from 'node:assert/strict'
import test from 'node:test'
import { createStickerCharacterAliases } from '../src/host/sticker-character-aliases.ts'
import { normalizeStickerCharacterName } from '../src/host/sticker-semantics.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

test('character aliases survive service recreation and stay isolated by account', context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close())
  const dictionary = createStickerCharacterAliases(store, 'account-a')
  const remembered = dictionary.remember({ character: 'Fixture Character', aliases: ['示例角色'], source: 'user', evidence: '用户确认角色名称' })
  assert.equal(createStickerCharacterAliases(store, 'account-a').read('ｆｉｘｔｕｒｅ_character')?.id, remembered.id)
  assert.equal(normalizeStickerCharacterName('ＦＩＸＴＵＲＥ_Character'), 'fixture character')
  assert.equal(createStickerCharacterAliases(store, 'account-b').read('Fixture Character'), null)
  assert.deepEqual(createStickerCharacterAliases(store, 'account-b').list(), [])
  assert.equal(dictionary.resolve('示例角色', { includeTentative: false })[0]?.identity.source, 'user')
  assert.equal(dictionary.list()[0]?.revision, remembered.revision)
})

test('model aliases and source replacement never promote guesses or remove user-confirmed aliases', context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close())
  const dictionary = createStickerCharacterAliases(store, 'account')
  dictionary.remember({ character: 'Fixture', aliases: ['推测别名'], source: 'model', evidence: '模型猜测' })
  dictionary.remember({ character: 'Fixture', aliases: ['确认别名'], source: 'user', evidence: '用户确认' })
  const current = dictionary.remember({ character: 'Fixture', aliases: ['新推测'], source: 'model', evidence: '新的模型猜测' }, { replaceAliases: true })
  assert.equal(current.identity.source, 'user')
  assert.deepEqual(current.identity.aliases, ['确认别名'])
  assert.deepEqual(current.aliases, ['确认别名', '新推测'])
  assert.equal(dictionary.resolve('新推测', { includeTentative: false }).length, 0)
  assert.equal(dictionary.resolve('新推测')[0]?.claims.find(claim => claim.source === 'model')?.evidence, '新的模型猜测')
  assert.equal(dictionary.resolve('推测别名').length, 0)
  assert.equal(dictionary.read('新推测'), null, 'canonical lookup does not guess an alias merge')
})

test('same-source additions merge, reviewed source removal uses CAS and conflicting aliases remain ambiguous', context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close())
  const dictionary = createStickerCharacterAliases(store, 'account')
  const first = dictionary.remember({ character: 'Fixture One', aliases: ['共同别名'], source: 'user' })
  const added = dictionary.remember({ character: 'Fixture One', aliases: ['英文别名'], source: 'user' })
  assert.deepEqual(added.identity.aliases, ['共同别名', '英文别名'])
  assert.equal(dictionary.remember({ character: 'Fixture One', aliases: ['英文别名'], source: 'user' }).revision, added.revision)
  assert.throws(() => dictionary.remove('Fixture One', 'user', first.revision), { code: 'STORE_CONFLICT' })
  dictionary.remember({ character: 'Fixture Two', aliases: ['共同别名'], source: 'model' })
  assert.equal(dictionary.resolve('共同别名').length, 2)
  assert.equal(dictionary.resolve('共同别名', { includeTentative: false }).length, 1)
  dictionary.remember({ character: 'Fixture One', aliases: ['候选'], source: 'model' })
  const beforeRemoval = dictionary.read('Fixture One')!
  assert.equal(dictionary.remove('Fixture One', 'user', beforeRemoval.revision), true)
  assert.equal(dictionary.read('Fixture One')?.identity.source, 'model')
  assert.equal(dictionary.resolve('英文别名').length, 0)
})
