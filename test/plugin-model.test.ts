import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshPluginModelBackend } from '../src/adapters/dsh-plugin-model.ts'
import { parsePluginModelImages, PLUGIN_MODEL_IMAGE_LIMITS } from '../src/contracts/plugin-model.ts'
import type { DshFollowRequest } from '../src/adapters/dsh.ts'
import type { AgentEvent } from '../src/contracts/ports.ts'
import type { JsonObject } from '../src/contracts/data.ts'

test('plugin image contract bounds encoded bytes and rejects malformed or noncanonical Base64', () => {
  assert.deepEqual(parsePluginModelImages([{ mediaType: 'image/png', data: 'aGVsbG8=' }]), [{ mediaType: 'image/png', data: 'aGVsbG8=' }])
  for (const value of [null, [{ mediaType: 'image/gif', data: 'aGVsbG8=' }], [{ mediaType: 'image/png', data: 'aGVsbG9=' }],
    [{ mediaType: 'image/png', data: 'aG==' }], [{ mediaType: 'image/png', data: 'aGVsbG8=\n' }],
    [{ mediaType: 'image/png', data: 'aGVsbG8=', url: 'https://untrusted.invalid' }],
    Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: 'aGVsbG8=' }))]) assert.throws(() => parsePluginModelImages(value))
  assert.throws(() => parsePluginModelImages([{ mediaType: 'image/png', data: Buffer.alloc(PLUGIN_MODEL_IMAGE_LIMITS.bytesPerImage + 1).toString('base64') }]))
  const image = { mediaType: 'image/png', data: Buffer.alloc(PLUGIN_MODEL_IMAGE_LIMITS.bytesPerImage).toString('base64') }
  assert.throws(() => parsePluginModelImages([image, image, image]))
})

test('plugin follower claims consumed inbox source before model admission and observes its terminal failure only', async () => {
  let follower: DshFollowRequest | undefined
  const backend = createDshPluginModelBackend({
    client: { async createSession() { return { ok: true, value: { sessionId: 'fixture' } } },
      async prompt() { return { ok: true, value: null } }, async cancel() { return { ok: true, value: null } },
      async follow(request) { follower = request; return () => {} } },
    async invoke() { return { ok: true, value: {} } },
  })
  const events: AgentEvent[] = []
  await backend.follow({ sessionId: 'fixture', requestId: 'plugin-request', owner: 'plugin', signal: new AbortController().signal,
    onEvent(event) { events.push(event) } })
  assert(follower)
  let seq = 0
  const emit = (type: string, data: JsonObject) =>
    follower!.onEvent({ type: 'session/event', sessionId: 'fixture', event: { type, seq: seq++, data } })
  await emit('turn/start', { turn: 10 })
  await emit('turn/end', { turn: 10, reason: { kind: 'completed' } })
  assert.equal(events.length, 0)
  await emit('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ source: { kind: 'qbf-plugin', owner: 'plugin', requestId: 'plugin-request' }, content: [] }] })
  await emit('turn/start', { turn: 11 })
  await emit('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  await emit('turn/end', { turn: 11, reason: { kind: 'error', error: { code: 'INVALID_MODEL_INFO', message: 'Configuration refused before user/message' } } })
  assert.equal(events.at(-1)?.type, 'failed')
  assert.equal(events.at(-1)?.data?.turn, 11)
})

test('plugin model transport sends images as separate fields and retains explicit pre-admission refusal', async () => {
  let input: JsonObject | undefined
  const backend = createDshPluginModelBackend({
    client: { async createSession() { return { ok: true, value: { sessionId: 'fixture' } } },
      async prompt() { return { ok: true, value: null } }, async cancel() { return { ok: true, value: null } },
      async follow() { return () => {} } },
    async invoke(_method, request) { input = request; return { ok: true, value: { accepted: false, code: 'PLUGIN_MODEL_IMAGE_UNSUPPORTED' } } },
  })
  assert.deepEqual(await backend.start({ sessionId: 'fixture', requestId: 'image-request', owner: 'plugin', prompt: 'Read actual image',
    images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }], signal: new AbortController().signal }),
  { status: 'rejected', code: 'PLUGIN_MODEL_IMAGE_UNSUPPORTED' })
  assert.equal(input?.prompt, 'Read actual image')
  assert.deepEqual(input?.images, [{ mediaType: 'image/png', data: 'aGVsbG8=' }])
})

test('plugin refusal diagnostics retain known stages and discard untrusted detail', async () => {
  let code = 'PLUGIN_MODEL_SESSION_UNAVAILABLE'
  const backend = createDshPluginModelBackend({
    client: { async createSession() { return { ok: true, value: { sessionId: 'fixture' } } },
      async prompt() { return { ok: true, value: null } }, async cancel() { return { ok: true, value: null } },
      async follow() { return () => {} } },
    async invoke() { return { ok: true, value: { accepted: false, code } } },
  })
  const request = { sessionId: 'fixture', requestId: 'request', owner: 'plugin', prompt: 'Plan', signal: new AbortController().signal }
  for (const stage of ['SESSION_UNAVAILABLE', 'SELECTION_UNAVAILABLE', 'SESSION_BUSY', 'CONTEXT_UNAVAILABLE']) {
    code = `PLUGIN_MODEL_${stage}`
    assert.deepEqual(await backend.start(request), { status: 'rejected', code })
  }
  code = 'private provider error text'
  assert.deepEqual(await backend.start(request), { status: 'rejected' })
})
