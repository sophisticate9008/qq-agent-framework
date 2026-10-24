import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createOneBotCompatGateway } from '../src/adapters/onebot-compat.ts'
import { createOneBotTransport } from '../src/adapters/onebot.ts'
import { classifyOneBotResponse } from '../src/adapters/onebot-response.ts'
import { createDurableTransport } from '../src/host/outbox.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { digest } from '../src/host/data.ts'
import { isRecord } from '../src/core/values.ts'

test('OneBot classifiers never treat asynchronous or contradictory acceptance as rejection', () => {
  assert.equal(classifyOneBotResponse({ status: 'ok', retcode: 0 }), 'confirmed')
  assert.equal(classifyOneBotResponse({ status: 'failed', retcode: 1404 }), 'rejected')
  for (const body of [{ status: 'async', retcode: 1 }, { status: 'async', retcode: 0 },
    { status: 'failed', retcode: 1 }, { status: 'failed', retcode: 0 }, { status: 'ok', retcode: 1 },
    { status: 'ok', retcode: '0' }, { retcode: 0 }, null]) {
    assert.equal(classifyOneBotResponse(body), 'unknown')
  }
})

test('asynchronous native sends persist unknown, suppress duplicate sends, and remain reconcilable', async () => {
  const store = createSqliteStore({ filename: ':memory:' })
  try {
    let sends = 0
    const transport = createOneBotTransport({ endpoint: 'http://127.0.0.1:39999', fetch: async () => {
      sends++
      return Response.json({ status: 'async', retcode: 1, data: null })
    } })
    const outbox = createDurableTransport({ store, transport })
    const request = { conversationId: 'group:123', content: [{ type: 'text' as const, text: 'synthetic' }],
      idempotencyKey: 'async-native', signal: new AbortController().signal }
    assert.deepEqual(await outbox.send(request), { status: 'unknown' })
    assert.deepEqual(await outbox.send(request), { status: 'unknown' })
    const restarted = createDurableTransport({ store, transport })
    restarted.recover()
    assert.deepEqual(await restarted.send(request), { status: 'unknown' })
    assert.equal(sends, 1)
    restarted.reconcile('async-native', { status: 'confirmed', messageId: 'observed-123' })
    assert.deepEqual(await restarted.send(request), { status: 'confirmed', messageId: 'observed-123' })
  } finally { store.close() }
})

test('asynchronous gateway responses pass through but commands and outbox stay unresolved across restart', async context => {
  const store = createSqliteStore({ filename: ':memory:' })
  const body = { status: 'async', retcode: 1, data: null }
  let sends = 0
  const options = { store, upstreamEndpoint: 'http://127.0.0.1:39999', token: 'synthetic-token',
    allowedConversations: ['group:123'], persona: { id: 'synthetic', version: '1' }, fetch: async () => {
      sends++
      return Response.json(body)
    } }
  let gateway = createOneBotCompatGateway(options)
  const server = createServer((request, response) => gateway.handle(request, response))
  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  context.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
    await gateway.close()
    store.close()
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  const send = () => fetch(`http://127.0.0.1:${address.port}/send_group_msg`, {
    method: 'POST', headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/json',
      'x-idempotency-key': 'async-gateway' }, body: JSON.stringify({ group_id: 123, message: 'synthetic' })
  })
  assert.deepEqual(await (await send()).json(), body)
  const namespace = `onebot.compat.${digest(options.persona)}.`
  const storedStatus = (suffix: string) => {
    const record = store.list(`${namespace}${suffix}`)[0]
    assert(record && isRecord(record.value))
    return record.value.status
  }
  assert.equal(storedStatus('outbox'), 'unknown')
  assert.equal(storedStatus('commands'), 'unknown')
  assert.equal(gateway.metrics().rejected, 0)
  await gateway.close()
  gateway = createOneBotCompatGateway(options)
  const repeated = await send()
  assert.equal(repeated.status, 200)
  assert.deepEqual(await repeated.json(), body)
  assert.equal(storedStatus('outbox'), 'unknown')
  assert.equal(storedStatus('commands'), 'unknown')
  assert.equal(sends, 1)
})
