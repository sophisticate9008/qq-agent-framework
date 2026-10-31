import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_STICKER_LIBRARY_CONFIGURATION, parseStickerLibraryDeleteResult, parseStickerLibrarySnapshot,
  parseStickerLibraryThumbnail, validateStickerLibraryConfiguration } from '../src/contracts/sticker-library.ts'

const item = { id: 'a'.repeat(64), revision: 1, name: '招手', description: '开心招手', tags: ['开心', '问候'], avoid: '',
  storage: 'account', state: 'ready', canDelete: true, createdAt: 1 }
const snapshot = { schema: 1, accountCollection: 'confirmed', capacity: { count: 1, nearFullAt: 240, capacityKnown: false },
  items: [item], limited: false, pending: 0 }

test('sticker settings use two separate 15 percent defaults and accept fractional percentages', () => {
  assert.equal(DEFAULT_STICKER_LIBRARY_CONFIGURATION.triggerProbabilityPercent, 15)
  assert.equal(DEFAULT_STICKER_LIBRARY_CONFIGURATION.collectProbabilityPercent, 15)
  assert.deepEqual(validateStickerLibraryConfiguration({ ...DEFAULT_STICKER_LIBRARY_CONFIGURATION,
    triggerProbabilityPercent: 0.5, collectProbabilityPercent: 99.9 }), { ...DEFAULT_STICKER_LIBRARY_CONFIGURATION,
    triggerProbabilityPercent: 0.5, collectProbabilityPercent: 99.9 })
  for (const invalid of [-1, 101, Infinity, NaN, '15']) assert.throws(() => validateStickerLibraryConfiguration({
    ...DEFAULT_STICKER_LIBRARY_CONFIGURATION, triggerProbabilityPercent: invalid }))
  assert.throws(() => validateStickerLibraryConfiguration({ ...DEFAULT_STICKER_LIBRARY_CONFIGURATION, accountNearFullAt: 1.5 }))
  assert.throws(() => validateStickerLibraryConfiguration({ ...DEFAULT_STICKER_LIBRARY_CONFIGURATION, ownerOnly: true }))
})

test('sticker snapshot strips private fields and refuses ambiguous identifiers or deletion state', () => {
  const parsed = parseStickerLibrarySnapshot({ ...snapshot, accountId: 'private-account', directory: '/private',
    items: [{ ...item, url: 'https://private.example', source: { path: '/private/image' } }] })
  assert.deepEqual(parsed, snapshot)
  for (const invalid of [{ ...item, state: 'unknown' }, { ...item, revision: 0 }, { ...item, id: '../image' },
    { ...item, tags: ['开心', '开心'] }, { ...item, tags: [''] }, { ...item, createdAt: -1 }]) {
    assert.equal(parseStickerLibrarySnapshot({ ...snapshot, items: [invalid] }), null)
  }
  assert.equal(parseStickerLibrarySnapshot({ ...snapshot, items: [item, item] }), null)
  assert.equal(parseStickerLibrarySnapshot({ ...snapshot, capacity: { ...snapshot.capacity, capacityKnown: true } }), null)
})

test('sticker snapshot accommodates full account and extra storage without truncating the contract', () => {
  const items = Array.from({ length: 6100 }, (_, index) => ({ ...item, id: index.toString(16).padStart(64, '0') }))
  assert.equal(parseStickerLibrarySnapshot({ ...snapshot, items })?.items.length, 6100)
  assert.equal(parseStickerLibrarySnapshot({ ...snapshot, items: Array.from({ length: 7001 }, (_, index) => ({ ...item,
    id: index.toString(16).padStart(64, '0') })) }), null)
})

test('sticker previews accept only bounded JPEG data and deletion receipts cannot request retries', () => {
  assert.deepEqual(parseStickerLibraryThumbnail({ image: 'data:image/jpeg;base64,/9j/', url: 'private' }), { image: 'data:image/jpeg;base64,/9j/' })
  for (const image of ['https://private.example', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,',
    'data:image/jpeg;base64,abc==', `data:image/jpeg;base64,${'a'.repeat(200_000)}`]) assert.equal(parseStickerLibraryThumbnail({ image }), null)
  for (const status of ['confirmed', 'rejected', 'unknown']) {
    assert.deepEqual(parseStickerLibraryDeleteResult({ status, debugPath: '/private' }), { status, retry: false })
  }
  assert.equal(parseStickerLibraryDeleteResult({ status: 'confirmed', retry: true }), null)
  assert.equal(parseStickerLibraryDeleteResult({ status: 'success' }), null)
})
