import test from 'node:test'
import assert from 'node:assert/strict'
import { createDshWorkPort } from '../src/adapters/dsh-work.ts'

const address = { issuerEpoch: 'epoch', id: 'work', parentSessionId: 'parent', childId: 'child', generation: 3 }
const asset = { type: 'media-reference' as const, kind: 'file' as const, attachmentId: 'attachment-123', name: 'report.txt', bytes: 400000 }

test('typed SDK attachment reads aggregate bounded pages and reject cross-work or malformed evidence', async () => {
  const content = Buffer.alloc(asset.bytes, 7)
  const offsets: number[] = []
  let corrupt = false
  const port = createDshWorkPort(async (method, input) => {
    assert.equal(method, 'bridgePlugin/readWorkAsset')
    const request = input as { offset: number; limit: number }
    assert(request.limit <= 192 * 1024)
    offsets.push(request.offset)
    const end = Math.min(content.length, request.offset + request.limit)
    return { schema: 1, ...address, ...(corrupt ? { parentSessionId: 'different-parent' } : {}),
      asset, offset: request.offset, nextOffset: end === content.length ? null : end,
      data: content.subarray(request.offset, end).toString('base64') }
  })
  assert(port.readAsset)
  const result = await port.readAsset({ ...address, kind: 'file', attachmentId: asset.attachmentId }, new AbortController().signal)
  assert.deepEqual(result.data, content)
  assert.deepEqual(offsets, [0, 196608, 393216])
  corrupt = true
  await assert.rejects(port.readAsset({ ...address, kind: 'file', attachmentId: asset.attachmentId }, new AbortController().signal),
    { code: 'DSH_WORK_INVALID_RESPONSE' })
})


test('full-access start requires explicit supported scope and verified child permission evidence', async () => {
  let available = true
  let supported: boolean | undefined
  let fullAccess: boolean | undefined
  const port = createDshWorkPort(async method => method === 'bridgePlugin/verifyWork'
    ? { schema: 1, issuerEpoch: 'epoch', available, provider: 'spawn', continuable: true,
      externalToolAuthorizationVerified: false, childFullAccessSupported: supported }
    : { ...address, schema: 1, state: 'running', result: null, error: null, ...(fullAccess === undefined ? {} : { fullAccess }) })
  const target = { issuerEpoch: 'epoch', parentSessionId: 'parent', modelProvider: 'provider', model: 'model', agentPreset: 'assistant', fullAccess: true }
  const signal = new AbortController().signal
  await assert.rejects(port.verify(target, signal), { code: 'DSH_WORK_INVALID_RESPONSE' })
  available = false
  assert.equal(await port.verify(target, signal), false)
  available = true; supported = true
  assert.equal(await port.verify(target, signal), true)
  const start = { ...address, ...target, task: 'Owner task', context: '', timeoutMs: 1000 }
  await assert.rejects(port.start(start, signal), { code: 'DSH_WORK_INVALID_RESPONSE' })
  fullAccess = true
  assert.equal((await port.start(start, signal)).fullAccess, true)
})
