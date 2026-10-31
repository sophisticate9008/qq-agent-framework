import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import { startSimulatedOneBot } from '../scripts/simulate-qq-onebot.ts'
import { createOneBotStickerPort } from '../src/adapters/onebot-stickers.ts'
import { isRecord } from '../src/core/values.ts'

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')

test('registered and injected images are not favorites until an actual adapter add, with content deduplication', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-simulation-favorites-'))
  const records: Readonly<Record<string, unknown>>[] = []
  const peer = await startSimulatedOneBot({ selfId: '900000000001', ownerId: '123', memberId: '900000000002',
    groupId: '900000000003', directory, record: value => records.push(value) })
  const socket = new WebSocket(peer.websocketEndpoint, { headers: { authorization: `Bearer ${peer.secret}` } })
  context.after(async () => { socket.terminate(); await peer.close(); await rm(directory, { recursive: true, force: true }) })
  await once(socket, 'open')
  const port = createOneBotStickerPort({ endpoint: peer.endpoint, accessToken: peer.secret })
  const list = async () => {
    const result = await port.list({ limit: 50, signal: AbortSignal.timeout(2000) })
    assert.equal(result.status, 'confirmed'); assert(result.status === 'confirmed')
    return result.data.items
  }
  assert.deepEqual(await list(), [])
  const file = join(directory, 'incoming.png')
  await writeFile(file, image)
  const registered = await peer.registerAsset(file, 'image')
  const incoming = once(socket, 'message')
  peer.inject({ actor: 'member', kind: 'group', text: '这个表情帮我收藏一下', segments: [registered] })
  await incoming
  assert.deepEqual(await list(), [], 'registration and injection never manufacture an account collection')
  const added = await port.add!({ file: `base64://${image.toString('base64')}`, signal: AbortSignal.timeout(2000) })
  assert.equal(added.status, 'confirmed', 'the production adapter creates and reads its system temporary file')
  const first = await list()
  assert.equal(first.length, 1); assert(first[0]!.md5); assert(first[0]!.stickerId)
  for (const key of [registered.data.file, first[0]!.stickerId]) {
    const response = await fetch(`${peer.endpoint}/get_image`, { method: 'POST',
      headers: { authorization: `Bearer ${peer.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ file: key }) })
    const resolved: unknown = await response.json()
    assert(isRecord(resolved) && isRecord(resolved.data)); assert.equal(resolved.status, 'ok')
    assert.equal(typeof resolved.data.url, 'string')
  }
  const download = await fetch(first[0]!.url)
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), image)
  assert.equal((await port.add!({ file, signal: AbortSignal.timeout(2000) })).status, 'confirmed')
  const second = await list()
  assert.equal(second.length, 1); assert.equal(second[0]!.stickerId, first[0]!.stickerId)
  assert.deepEqual(records.filter(row => row.type === 'collection-added').map(row => row.reused), [false, true])
  assert.equal(peer.sent(), 0, 'collection is not a captured QQ send')
})

test('raw simulated collection rejects arbitrary external paths, symlinks, oversized files and nonimages', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-simulation-favorite-safety-'))
  const external = await mkdtemp(join(tmpdir(), 'qbf-external-image-'))
  const peer = await startSimulatedOneBot({ selfId: '900000000001', ownerId: '123', memberId: '900000000002',
    groupId: '900000000003', directory, record() {} })
  context.after(async () => { await peer.close(); await rm(directory, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }) })
  const valid = join(directory, 'valid.png'), link = join(directory, 'link.png'), large = join(directory, 'large.png')
  const text = join(directory, 'text.png'), outside = join(external, 'outside.png')
  await writeFile(valid, image); await writeFile(outside, image); await symlink(valid, link)
  await writeFile(large, image); await truncate(large, 8 * 1024 * 1024 + 1); await writeFile(text, 'not an image')
  for (const file of [outside, link, large, text]) {
    const response = await fetch(`${peer.endpoint}/add_custom_face`, { method: 'POST',
      headers: { authorization: `Bearer ${peer.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ file }), signal: AbortSignal.timeout(2000) })
    const result: unknown = await response.json()
    assert(isRecord(result)); assert.equal(result.status, 'failed')
  }
  const port = createOneBotStickerPort({ endpoint: peer.endpoint, accessToken: peer.secret })
  const result = await port.list({ limit: 50, signal: AbortSignal.timeout(2000) })
  assert(result.status === 'confirmed'); assert.deepEqual(result.data.items, [])
})
