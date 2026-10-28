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
