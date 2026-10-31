import assert from 'node:assert/strict'
import test from 'node:test'
import { createPluginToolDirectory } from '../src/host/plugin-tool-directory.ts'
import { createNativeCapabilityDirectory } from '../src/host/native-capability-directory.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { QQ_CAPABILITIES } from '../src/contracts/qq-capabilities.ts'
import type { EffectRequest, JsonValue } from '../src/core/types.ts'
import type { NativeMessageSource } from '../src/host/native-message-sources.ts'

test('installed extension tools are discovered on demand with owner checks and durable duplicate protection', async context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close())
  const registry = createPluginToolDirectory({ store }), lifetime = new AbortController()
  let calls = 0, owner = false
  const unregister = registry.forPlugin('example', lifetime.signal).register({ id: 'schedule',
    description: '安排扩展日程', permission: 'owner', readOnly: false,
    parameters: { type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string' } } },
    async execute(input) { calls++; return { status: 'confirmed', label: input.label } } })
  const source = (): NativeMessageSource => ({ conversationId: 'group:123', sourceMessageId: 'message', userId: 'user',
    receivedAt: 0, expiresAt: Date.now() + 10000, isOwner: owner, assurance: 'normalized-onebot-source-only',
    workIntentVerified: false, capabilityAuthorizationVerified: false, externalToolAuthorizationVerified: false })
  const directory = createNativeCapabilityDirectory({ store, selfId: 'bot', tools: registry.entries,
    inventory: { protocol: 'napcat', version: 'fixture', source: 'reported-actions', supportedIds: QQ_CAPABILITIES.map(t => t.id) },
    sources: () => ({ lookup: async () => source(), requireOwner: async () => { assert(owner, 'owner required'); return source() } }),
    authorize: async () => {}, port: { inspect: async () => ({ status: 'rejected', code: 'unused' }),
      call: async () => { throw Error('Protocol should not be called') } } })
  const request = (input: JsonValue): EffectRequest => ({ input, signal: new AbortController().signal,
    scope: { eventId: 'invocation', conversationId: 'group:123', featureId: 'framework-tools', version: '1.0.0' } })
  const catalog = directory.effects['native.capabilities.catalog'], call = directory.effects['native.capabilities.call']
  const categories = JSON.stringify(await catalog.execute(request({})))
  assert(categories.includes('extensions')); assert(!categories.includes('inputSchema'))
  const summaries = JSON.stringify(await catalog.execute(request({ category: 'extensions' })))
  assert(summaries.includes('extension.example.schedule')); assert(!summaries.includes('inputSchema'))
  assert(JSON.stringify(await catalog.execute(request({ id: 'extension.example.schedule' }))).includes('inputSchema'))
  const input = { id: 'extension.example.schedule', input: { label: 'today' } }
  await assert.rejects(async () => call.execute(request(input)), /owner required/); assert.equal(calls, 0)
  owner = true
  await call.execute(request(input)); await call.execute(request(input)); assert.equal(calls, 1)
  await assert.rejects(async () => call.execute(request({ ...input, input: { label: 'changed' } })), /same invocation/)
  unregister(); assert.equal(registry.entries().length, 0)
  assert(JSON.stringify(await catalog.execute(request({ id: input.id }))).includes('CAPABILITY_NOT_FOUND'))
  lifetime.abort()
  assert.throws(() => registry.forPlugin('example', lifetime.signal).register({ id: 'another', description: '状态',
    parameters: { type: 'object' }, permission: 'autonomous', readOnly: true, async execute() { return {} } }))
})

test('chat directory cannot expose or invoke raw collection while the host protocol capability remains declared', async context => {
  const store = createSqliteStore({ filename: ':memory:' }); context.after(() => store.close())
  let protocolCalls = 0
  const source: NativeMessageSource = { conversationId: 'group:123', sourceMessageId: 'request', userId: 'owner',
    receivedAt: 0, expiresAt: Date.now() + 10000, isOwner: true, assurance: 'normalized-onebot-source-only',
    workIntentVerified: false, capabilityAuthorizationVerified: false, externalToolAuthorizationVerified: false }
  const directory = createNativeCapabilityDirectory({ store, selfId: 'bot', tools: () => [],
    inventory: { protocol: 'napcat', version: 'fixture', source: 'reported-actions', supportedIds: ['add_custom_face', 'fetch_custom_face_detail'] },
    sources: () => ({ lookup: async () => source, requireOwner: async () => source }), authorize: async () => {},
    port: { inspect: async () => ({ status: 'rejected', code: 'unused' }), call: async () => { protocolCalls++; return { status: 'confirmed', data: {} } } } })
  const request = (input: JsonValue): EffectRequest => ({ input, signal: new AbortController().signal,
    scope: { eventId: 'collection-attempt', conversationId: 'group:123', featureId: 'framework-tools', version: '1.0.0' } })
  const catalog = directory.effects['native.capabilities.catalog'], call = directory.effects['native.capabilities.call']
  assert(QQ_CAPABILITIES.some(entry => entry.id === 'add_custom_face'), 'trusted host protocol integrations keep the low-level capability')
  assert(!directory.inventory().some(entry => entry.id === 'qq.add_custom_face'))
  assert(!JSON.stringify(await catalog.execute(request({ category: 'stickers' }))).includes('add_custom_face'))
  assert.deepEqual(await catalog.execute(request({ id: 'qq.add_custom_face' })), { status: 'rejected', code: 'CAPABILITY_NOT_FOUND' })
  await assert.rejects(call.execute(request({ id: 'qq.add_custom_face', input: { file: 'base64://unused' } })), { code: 'CAPABILITY_USE_SCOPED_TOOL' })
  assert.equal(protocolCalls, 0)
  assert.equal(store.list('native-chat.protocol-writes').length, 0)
  await call.execute(request({ id: 'qq.fetch_custom_face_detail', input: {} }))
  assert.equal(protocolCalls, 1, 'unrelated read-only protocol tools still work')
})
