import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeActivity, nativeActivityContent } from '../src/host/native-activity.ts'

test('native activity retains exactly the newest 100 observations in arrival order with immutable detached snapshots', () => {
  let now = 1000
  const activity = createNativeActivity({ now: () => now })
  for (let index = 0; index < 105; index++) {
    activity.record('received', 'group:456')
    now--
  }
  const first = activity.read('running')
  assert.equal(first.source, 'native-chat')
  assert.equal(first.retention, 'process')
  assert.equal(first.capacity, 100)
  assert.equal(first.state, 'running')
  assert.equal(first.items.length, 100)
  assert.equal(first.items[0]!.id, 'native-105')
  assert.equal(first.items.at(-1)!.id, 'native-6')
  assert(Object.isFrozen(first) && Object.isFrozen(first.items) && first.items.every(Object.isFrozen))
  assert.equal(Reflect.set(first.items[0]!, 'summary', 'modified'), false)
  activity.record('stopped')
  assert.equal(first.items[0]!.id, 'native-105')
  assert.equal(activity.read('stopped').items[0]!.id, 'native-106')
  assert.equal(createNativeActivity().read('stopped').items.length, 0)
})

test('native activity stores only bounded allowlisted summaries and validated conversation identifiers', () => {
  const activity = createNativeActivity({ now: () => 123 })
  activity.record('send_unknown', 'private:123')
  activity.record('error', `group:${'1'.repeat(10_000)}`)
  activity.record('received', 'secret\nraw-error')
  Reflect.apply(activity.record, undefined, ['raw-secret-model-thinking', 'private:123'])
  const entries = activity.read('error').items
  assert.equal(entries.length, 3)
  assert.equal(entries[0]!.conversationId, null)
  assert.equal(entries[1]!.conversationId, null)
  assert.equal(entries[2]!.conversationId, 'private:123')
  assert.equal(entries[2]!.level, 'warning')
  assert.equal(entries[2]!.type, 'sent')
  assert(entries.every(entry => entry.at === 123 && entry.summary.length <= 160))
  assert(!JSON.stringify(entries).includes('secret'))
  assert(!JSON.stringify(entries).includes('thinking'))
})

test('native activity observation failures never escape into the host lifecycle', () => {
  const throwing = createNativeActivity({ now() { throw new Error('credential must not escape') } })
  assert.doesNotThrow(() => throwing.record('error'))
  assert.deepEqual(throwing.read('stopped').items, [])
  const invalid = createNativeActivity({ now: () => Number.NaN })
  assert.doesNotThrow(() => invalid.record('received'))
  assert.deepEqual(invalid.read('stopped').items, [])
})

test('media-only activity shows the actual content kind without leaking internal resource handles', () => {
  const activity = createNativeActivity()
  activity.record('send_confirmed', 'group:456', nativeActivityContent([
    { type: 'image', assetId: 'internal-opaque-image' }, { type: 'face', id: '14' },
    { type: 'file', assetId: 'internal-opaque-file', name: 'hello.txt' },
  ]))
  assert.equal(activity.read('running').items[0]!.content, '[图片] [QQ表情] [文件：hello.txt]')
})
