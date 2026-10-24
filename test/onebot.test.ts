import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import test from 'node:test'

import {
  createOneBotReceiver,
  createOneBotTransport,
  normalizeOneBotMessage,
  type OneBotAuthorizationContext,
  type OneBotIncomingAsset,
} from '../src/adapters/onebot.ts'
import type { SendRequest } from '../src/core/types.ts'
import type { InboundMessage } from '../src/host/types.ts'

function request(overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    conversationId: 'group:12345',
    content: [{ type: 'text', text: 'hello' }],
    idempotencyKey: 'send-1',
    signal: new AbortController().signal,
    ...overrides,
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('OneBot transport maps structured content and confirms only a valid receipt', async () => {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = []
  const resolutions: Array<{ assetId: string; type: string; conversationId: string; persona?: string }> = []
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url: String(input), init, body })
    return response({ status: 'ok', retcode: 0, data: { message_id: -9988 } })
  }
  const transport = createOneBotTransport({
    endpoint: 'http://onebot.invalid/api',
    accessToken: 'transport-secret',
    persona: 'whale',
    fetch: fetchMock,
    resolveAsset(asset) {
      resolutions.push({
        assetId: asset.assetId,
        type: asset.type,
        conversationId: asset.conversationId,
        persona: asset.persona,
      })
      return { file: asset.type === 'image' ? 'base64://trusted-image' : 'file:///trusted/audio.silk' }
    },
  })
  const receipt = await transport.send(request({
    content: [
      { type: 'reply', messageId: '-17' },
      { type: 'mention', userId: '7788' },
      { type: 'text', text: '你好' },
      { type: 'image', assetId: '../../untrusted-image' },
      { type: 'audio', assetId: '/untrusted/audio' },
    ],
  }))

  assert.deepEqual(receipt, { status: 'confirmed', messageId: '-9988' })
  assert.deepEqual(resolutions, [
    { assetId: '../../untrusted-image', type: 'image', conversationId: 'group:12345', persona: 'whale' },
    { assetId: '/untrusted/audio', type: 'audio', conversationId: 'group:12345', persona: 'whale' },
  ])
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, 'http://onebot.invalid/api/send_group_msg')
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer transport-secret')
  assert.deepEqual(calls[0]!.body, {
    group_id: 12345,
    message: [
      { type: 'reply', data: { id: '-17' } },
      { type: 'at', data: { qq: '7788' } },
      { type: 'text', data: { text: '你好' } },
      { type: 'image', data: { file: 'base64://trusted-image' } },
      { type: 'record', data: { file: 'file:///trusted/audio.silk' } },
    ],
  })
  assert.doesNotMatch(JSON.stringify(calls[0]!.body), /untrusted-image|untrusted\/audio/)
})

test('OneBot transport distinguishes explicit rejection from uncertain delivery without retrying', async () => {
  const cases: Array<{ reply: () => Promise<Response>; expected: 'rejected' | 'unknown' }> = [
    { reply: async () => response({ status: 'async', retcode: 1, data: null }), expected: 'unknown' },
    { reply: async () => response({ status: 'async', retcode: 0, data: { message_id: 1 } }), expected: 'unknown' },
    { reply: async () => response({ status: 'ok', retcode: 1404, data: null }), expected: 'unknown' },
    { reply: async () => response({ retcode: 0, data: { message_id: 1 } }), expected: 'unknown' },
    { reply: async () => response({ status: 'failed', retcode: 1404, data: null }), expected: 'rejected' },
    { reply: async () => response({ status: 'failed', retcode: 0, data: { message_id: 1 } }), expected: 'unknown' },
    { reply: async () => response({ status: 'ok', retcode: 0, data: {} }), expected: 'unknown' },
    { reply: async () => response({ status: 'ok', retcode: 0, data: { message_id: 0 } }), expected: 'unknown' },
    { reply: async () => response({ status: 'ok', retcode: 0, data: { message_id: 1.5 } }), expected: 'unknown' },
    { reply: async () => response({ status: 'ok', retcode: '0', data: { message_id: 1 } }), expected: 'unknown' },
    { reply: async () => new Response('gateway failure', { status: 500 }), expected: 'unknown' },
    { reply: async () => new Response('proxy failure', { status: 502 }), expected: 'unknown' },
    { reply: async () => new Response('unauthorized', { status: 401 }), expected: 'rejected' },
    { reply: async () => new Response('forbidden', { status: 403 }), expected: 'rejected' },
    { reply: async () => new Response('not-json'), expected: 'unknown' },
    { reply: async () => { throw new Error('network detail') }, expected: 'unknown' },
  ]
  for (const fixture of cases) {
    let calls = 0
    const transport = createOneBotTransport({
      endpoint: 'http://onebot.invalid',
      fetch: async () => {
        calls += 1
        return fixture.reply()
      },
    })
    assert.deepEqual(await transport.send(request({ conversationId: 'private:42' })), { status: fixture.expected })
    assert.equal(calls, 1)
  }

  let timeoutCalls = 0
  const timeoutTransport = createOneBotTransport({
    endpoint: 'http://onebot.invalid',
    timeoutMs: 5,
    fetch: (_input, init) => new Promise<Response>((_resolvePromise, rejectPromise) => {
      timeoutCalls += 1
      const signal = init?.signal
      if (!signal) throw new Error('Missing timeout signal')
      signal.addEventListener('abort', () => rejectPromise(signal.reason), { once: true })
    }),
  })
  assert.deepEqual(await timeoutTransport.send(request()), { status: 'unknown' })
  assert.equal(timeoutCalls, 1)

  const resolverTimeout = createOneBotTransport({
    endpoint: 'http://onebot.invalid',
    timeoutMs: 5,
    resolveAsset: () => new Promise<string>(() => {}),
    fetch: async () => {
      throw new Error('HTTP must not start after resolver timeout')
    },
  })
  assert.deepEqual(await resolverTimeout.send(request({
    content: [{ type: 'image', assetId: 'slow-asset' }],
  })), { status: 'unknown' })

  const bodyTimeout = createOneBotTransport({
    endpoint: 'http://onebot.invalid',
    timeoutMs: 5,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })
  assert.deepEqual(await bodyTimeout.send(request()), { status: 'unknown' })

  let oversizedBodyCancelled = false
  const oversizedBody = createOneBotTransport({
    endpoint: 'http://onebot.invalid',
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1))
      },
      cancel() {
        oversizedBodyCancelled = true
      },
    }), { status: 200 }),
  })
  assert.deepEqual(await oversizedBody.send(request()), { status: 'unknown' })
  assert.equal(oversizedBodyCancelled, true)

  const largeIdentifier = createOneBotTransport({
    endpoint: 'http://onebot.invalid',
    fetch: async () => response({
      status: 'ok',
      retcode: 0,
      data: { message_id: '9223372036854775807' },
    }),
  })
  assert.deepEqual(await largeIdentifier.send(request()), {
    status: 'confirmed',
    messageId: '9223372036854775807',
  })
})

test('OneBot transport rejects unsupported files and unresolved assets before HTTP', async () => {
  let calls = 0
  const transport = createOneBotTransport({
    endpoint: 'http://onebot.invalid',
    fetch: async () => {
      calls += 1
      return response({ status: 'ok', retcode: 0, data: { message_id: 1 } })
    },
  })
  assert.deepEqual(await transport.send(request({
    content: [{ type: 'file', assetId: 'asset-file', name: 'report.pdf' }],
  })), { status: 'rejected' })
  assert.deepEqual(await transport.send(request({
    content: [{ type: 'image', assetId: '/etc/passwd' }],
  })), { status: 'rejected' })
  assert.deepEqual(await transport.send(request({ conversationId: 'channel:123' })), { status: 'rejected' })
  assert.equal(calls, 0)

  const resolverFailure = createOneBotTransport({
    endpoint: 'http://onebot.invalid',
    resolveAsset() { throw new Error('/private/path/credential') },
    fetch: async () => {
      calls += 1
      return response({ status: 'ok', retcode: 0, data: { message_id: 1 } })
    },
  })
  const failed = await resolverFailure.send(request({
    content: [{ type: 'image', assetId: 'opaque-image-id' }],
  }))
  assert.deepEqual(failed, { status: 'rejected' })
  assert.doesNotMatch(JSON.stringify(failed), /private|path|credential|opaque-image-id/)
  assert.equal(calls, 0)
})

function sign(secret: string, body: string): string {
  return `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise)
      resolvePromise()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Receiver has no TCP address')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close(error => error ? rejectPromise(error) : resolvePromise())
  })
}

async function post(origin: string, body: string, signature?: string): Promise<Response> {
  return fetch(origin, {
    method: 'POST',
    headers: signature === undefined ? {} : { 'x-signature': signature },
    body,
  })
}

test('OneBot receiver authenticates raw bytes and normalizes group identity, quote and media', async t => {
  const secret = 'receiver-secret'
  const delivered: InboundMessage[] = []
  const assets: OneBotIncomingAsset[] = []
  const authorizationViews: Array<{ message: InboundMessage; context: OneBotAuthorizationContext }> = []
  const receiver = createOneBotReceiver({
    secret,
    selfId: '10001',
    maxBodyBytes: 4096,
    registerIncomingAsset(asset) {
      assets.push(asset)
      return `registered-${asset.kind}-${assets.length}`
    },
    allow(message, context) {
      authorizationViews.push({ message, context })
      return message.conversationId === 'group:9000'
    },
    onMessage(message) {
      delivered.push(message)
    },
  })
  const server = createServer(receiver)
  const origin = await listen(server)
  t.after(async () => close(server))
  const event = {
    post_type: 'message',
    message_type: 'group',
    self_id: 10001,
    user_id: 20002,
    group_id: 9000,
    message_id: -77,
    time: 1_700_000_000,
    message: [
      { type: 'reply', data: { id: '-66' } },
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' 看一下' } },
      { type: 'image', data: { file: 'gateway-image', url: 'https://media.invalid/image' } },
      { type: 'record', data: { file: 'gateway-audio' } },
      { type: 'file', data: { file_id: 'gateway-file-id', name: '报告.txt' } },
    ],
  }
  const body = JSON.stringify(event)

  assert.equal((await post(origin, body)).status, 401)
  assert.equal((await post(origin, `${body} `, sign(secret, body))).status, 401)
  assert.equal(delivered.length, 0)
  assert.equal((await post(origin, body, sign(secret, body))).status, 204)
  assert.equal((await post(origin, body, sign(secret, body))).status, 204)

  assert.equal(delivered.length, 2)
  assert.deepEqual(authorizationViews[0]!.message.content, [
    { type: 'reply', messageId: '-66' },
    { type: 'mention', userId: '10001' },
    { type: 'text', text: ' 看一下' },
  ])
  assert.deepEqual(authorizationViews[0]!.context.media, [
    { type: 'image' },
    { type: 'audio' },
    { type: 'file' },
  ])
  assert.doesNotMatch(JSON.stringify(authorizationViews[0]!.context.media), /gateway|media\.invalid|报告/)
  assert(Object.isFrozen(authorizationViews[0]!.context))
  assert(Object.isFrozen(authorizationViews[0]!.context.media))
  assert.deepEqual(delivered[0], {
    id: '-77',
    conversationId: 'group:9000',
    userId: '20002',
    receivedAt: 1_700_000_000_000,
    content: [
      { type: 'reply', messageId: '-66' },
      { type: 'mention', userId: '10001' },
      { type: 'text', text: ' 看一下' },
      { type: 'image', assetId: 'registered-image-1' },
      { type: 'audio', assetId: 'registered-audio-2' },
      { type: 'file', assetId: 'registered-file-3', name: '报告.txt' },
    ],
    directed: true,
    isSelf: false,
  })
  assert.equal(delivered[1]!.id, '-77')
  assert.equal(assets.length, 6)
  assert.deepEqual(assets[0], {
    kind: 'image',
    messageId: '-77',
    conversationId: 'group:9000',
    source: { file: 'gateway-image', url: 'https://media.invalid/image' },
  })
  assert(Object.isFrozen(delivered[0]))
  assert(Object.isFrozen(delivered[0]!.content))

  const deniedEvent = JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    self_id: 10001,
    user_id: 30003,
    message_id: 88,
    message: [{ type: 'image', data: { file: 'denied-image' } }],
  })
  assert.equal((await post(origin, deniedEvent, sign(secret, deniedEvent))).status, 403)
  assert.deepEqual(authorizationViews.at(-1)!.message.content, [])
  assert.deepEqual(authorizationViews.at(-1)!.context.media, [{ type: 'image' }])
  assert.equal(assets.length, 6)
  assert.equal(delivered.length, 2)
})

test('OneBot receiver enforces body limits and authorization before host delivery', async t => {
  const secret = 'receiver-secret'
  let deliveries = 0
  const server = createServer(createOneBotReceiver({
    secret,
    selfId: 1,
    maxBodyBytes: 256,
    allow: () => false,
    onMessage() { deliveries += 1 },
  }))
  const origin = await listen(server)
  t.after(async () => close(server))

  const oversized = JSON.stringify({ value: 'x'.repeat(300) })
  assert.equal((await post(origin, oversized, sign(secret, oversized))).status, 413)
  const malformed = '{"post_type":'
  assert.equal((await post(origin, malformed, sign(secret, malformed))).status, 400)
  const privateEvent = JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    self_id: 1,
    user_id: 2,
    message_id: 3,
    message: 'hello',
  })
  assert.equal((await post(origin, privateEvent, sign(secret, privateEvent))).status, 403)
  assert.equal(deliveries, 0)
})

test('OneBot receiver bounds identifiers and content before callbacks', async t => {
  const secret = 'receiver-secret'
  let allowed = 0
  let registered = 0
  let delivered = 0
  const server = createServer(createOneBotReceiver({
    secret,
    selfId: 1,
    allow() { allowed += 1; return true },
    registerIncomingAsset() { registered += 1; return 'asset-1' },
    onMessage() { delivered += 1 },
  }))
  const origin = await listen(server)
  t.after(async () => close(server))

  const fixtures = [
    {
      post_type: 'message', message_type: 'private', self_id: 1,
      user_id: '1'.repeat(33), message_id: 1, message: 'hello',
    },
    {
      post_type: 'message', message_type: 'private', self_id: 1,
      user_id: 2, message_id: '1'.repeat(33), message: 'hello',
    },
    {
      post_type: 'message', message_type: 'private', self_id: 1,
      user_id: 2, message_id: 2,
      message: Array.from({ length: 9 }, () => ({ type: 'text', data: { text: 'x' } })),
    },
    {
      post_type: 'message', message_type: 'private', self_id: 1,
      user_id: 2, message_id: 3,
      message: [{ type: 'text', data: { text: 'x'.repeat(8001) } }],
    },
  ]
  for (const event of fixtures) {
    const body = JSON.stringify(event)
    assert.equal((await post(origin, body, sign(secret, body))).status, 204)
  }
  assert.equal(allowed, 0)
  assert.equal(registered, 0)
  assert.equal(delivered, 0)
})

test('OneBot receiver applies one bounded deadline to allow, asset registration and delivery callbacks', async t => {
  const secret = 'receiver-secret'
  let mode: 'allow' | 'register' | 'deliver' = 'allow'
  let registrations = 0
  let deliveries = 0
  const never = (): Promise<never> => new Promise(() => {})
  const server = createServer(createOneBotReceiver({
    secret,
    selfId: 1,
    callbackTimeoutMs: 10,
    allow() {
      return mode === 'allow' ? never() : true
    },
    registerIncomingAsset() {
      registrations += 1
      return mode === 'register' ? never() : 'asset-1'
    },
    onMessage() {
      deliveries += 1
      return mode === 'deliver' ? never() : undefined
    },
  }))
  const origin = await listen(server)
  t.after(async () => close(server))
  const textEvent = JSON.stringify({
    post_type: 'message', message_type: 'private', self_id: 1,
    user_id: 2, message_id: 10, message: 'hello',
  })
  assert.equal((await post(origin, textEvent, sign(secret, textEvent))).status, 504)
  assert.equal(registrations, 0)
  assert.equal(deliveries, 0)

  mode = 'register'
  const mediaEvent = JSON.stringify({
    post_type: 'message', message_type: 'private', self_id: 1,
    user_id: 2, message_id: 11, message: [{ type: 'image', data: { file: 'gateway-file' } }],
  })
  assert.equal((await post(origin, mediaEvent, sign(secret, mediaEvent))).status, 504)
  assert.equal(registrations, 1)
  assert.equal(deliveries, 0)

  mode = 'deliver'
  assert.equal((await post(origin, textEvent, sign(secret, textEvent))).status, 504)
  assert.equal(registrations, 1)
  assert.equal(deliveries, 1)
})

test('normalizer uses the configured self boundary and preserves self-sent private identity', async () => {
  const ignored = await normalizeOneBotMessage({
    post_type: 'message',
    message_type: 'private',
    self_id: 999,
    user_id: 2,
    message_id: 4,
    message: 'wrong bot',
  }, { selfId: 1 })
  assert.equal(ignored, null)

  const own = await normalizeOneBotMessage({
    post_type: 'message',
    message_type: 'private',
    self_id: 1,
    user_id: 1,
    target_id: 2,
    message_id: 5,
    message: 'sent by self',
  }, { selfId: 1, now: () => 123 })
  assert.deepEqual(own, {
    id: '5',
    conversationId: 'private:2',
    userId: '1',
    receivedAt: 123,
    content: [{ type: 'text', text: 'sent by self' }],
    directed: true,
    isSelf: true,
  })
})
