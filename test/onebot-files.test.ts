import test from 'node:test'
import assert from 'node:assert/strict'
import { createOneBotTransport } from '../src/adapters/onebot.ts'
import { createDurableTransport } from '../src/host/outbox.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { deliveryMessageId, isFileUploadReceipt } from '../src/core/delivery.ts'
import { createEngine } from '../src/core/engine.ts'
import { createContextStore } from '../src/core/context.ts'
import { createPolicy } from '../src/core/policy.ts'
import type { SendRequest } from '../src/core/types.ts'

const request: SendRequest = { conversationId: 'group:123', content: [{ type: 'file', assetId: 'scoped-file', name: 'report.txt' }],
  idempotencyKey: 'file-effect', signal: new AbortController().signal,
  scope: { persona: { id: 'demo', version: '1' }, sessionId: 'parent', generation: 3 } }
const fileReceipt = { status: 'confirmed' as const, kind: 'file-upload' as const, fileId: 'real-file-id', name: 'report.txt' }

test('single scoped file uses the correct upload action with controlled bytes and a real file receipt', async () => {
  const calls: { url: string; body: unknown }[] = []
  const selections: unknown[] = []
  const transport = createOneBotTransport({ endpoint: 'http://onebot.invalid', resolveAsset(value) {
    selections.push({ ...value, signal: undefined }); return { file: 'base64://aGVsbG8=' }
  }, async fetch(url, init) { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ status: 'ok', retcode: 0, data: { file_id: 'real-file-id' } }) } })
  assert(transport.capabilities?.().contentTypes.includes('file'))
  assert.deepEqual(await transport.send(request), fileReceipt)
  assert.deepEqual(await transport.send({ ...request, conversationId: 'private:456' }), fileReceipt)
  assert(calls[0].url.endsWith('/upload_group_file'))
  assert(calls[1].url.endsWith('/upload_private_file'))
  assert.deepEqual(calls[0].body, { group_id: 123, file: 'base64://aGVsbG8=', name: 'report.txt', upload_file: true })
  assert.deepEqual(selections[0], { assetId: 'scoped-file', type: 'file', name: 'report.txt', conversationId: 'group:123',
    persona: 'demo@1', sessionId: 'parent', generation: 3, signal: undefined })
  assert.equal(deliveryMessageId(fileReceipt), null)
  assert(isFileUploadReceipt(fileReceipt))
  assert.equal((await transport.send({ ...request, content: [{ type: 'text', text: 'mixed' }, ...request.content] })).status, 'rejected')
  assert.equal(calls.length, 2)
})

test('file upload evidence survives outbox recovery and unknown or failed uploads are never replayed', async () => {
  for (const outcome of ['confirmed', 'rejected', 'unknown'] as const) {
    const store = createSqliteStore({ filename: ':memory:' })
    let calls = 0
    try {
      const transport = createOneBotTransport({ endpoint: 'http://onebot.invalid', resolveAsset: () => 'base64://aGVsbG8=',
        async fetch() { calls++; if (outcome === 'unknown') throw new Error('Reply lost after acceptance')
          return Response.json(outcome === 'confirmed' ? { status: 'ok', retcode: 0, data: { file_id: 'real-file-id' } }
            : { status: 'failed', retcode: 1403 }) } })
      const first = createDurableTransport({ store, transport })
      const expected = outcome === 'confirmed' ? fileReceipt : { status: outcome }
      assert.deepEqual(await first.send(request), expected)
      const recovered = createDurableTransport({ store, transport }); recovered.recover()
      assert.deepEqual(await recovered.send(request), expected)
      assert.equal(calls, 1)
    } finally { store.close() }
  }
})

test('malformed upload success and uncontrolled sources cannot manufacture a QQ message receipt', async () => {
  let calls = 0
  const transport = (source: string) => createOneBotTransport({ endpoint: 'http://onebot.invalid', resolveAsset: () => source,
    async fetch() { calls++; return Response.json({ status: 'ok', retcode: 0, data: { message_id: 999 } }) } })
  assert.deepEqual(await transport('base64://aGVsbG8=').send(request), { status: 'unknown' })
  assert.deepEqual(await transport('https://uncontrolled.invalid/file').send(request), { status: 'rejected' })
  assert.deepEqual(await transport('base64://invalid').send(request), { status: 'rejected' })
  assert.equal(calls, 1)
  const stalled = createOneBotTransport({ endpoint: 'http://onebot.invalid', resolveAsset: () => 'base64://aGVsbG8=',
    timeoutMs: 20, fetch: () => new Promise<Response>(() => {}) })
  // Keep the test alive independently of AbortSignal.timeout's unref timer.
  const guard = setTimeout(() => {}, 1000)
  try { assert.deepEqual(await stalled.send(request), { status: 'unknown' }) } finally { clearTimeout(guard) }
})

test('feature engine retains explicit file confirmation through the ordinary messaging policy boundary', async () => {
  const context = createContextStore()
  const persona = context.registerPersona({ id: 'demo', version: '1', name: 'Demo', identity: {}, style: {} })
  const policy = createPolicy()
  let calls = 0
  const engine = createEngine({ context, persona, policy, transport: { send() { calls++; return fileReceipt } } })
  engine.install({ id: 'files', version: '1.0.0', apiVersion: 1, capabilities: ['messaging.send'], subscriptions: ['message.received'],
    setup(api) { api.on('message.received', async execution => { assert.deepEqual(await execution.send(request.content), fileReceipt) }) } })
  assert.equal((await engine.emit({ id: 'denied', type: 'message.received', conversationId: request.conversationId, data: {} })).outcomes[0].status, 'failed')
  assert.equal(calls, 0)
  policy.grant({ id: 'file-grant', featureId: 'files', conversationId: request.conversationId, capabilities: ['messaging.send'], maxUses: { 'messaging.send': 1 } })
  assert.equal((await engine.emit({ id: 'allowed', type: 'message.received', conversationId: request.conversationId, data: {} })).outcomes[0].status, 'completed')
  assert.equal(calls, 1)
  await engine.stop()
})
