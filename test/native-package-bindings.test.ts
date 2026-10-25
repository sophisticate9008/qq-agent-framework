import assert from 'node:assert/strict'
import test from 'node:test'
import { createContextStore } from '../src/core/context.ts'
import type { FeatureDefinition, MessageContent } from '../src/core/types.ts'
import { createBridgeHost } from '../src/host/bridge.ts'
import { createNativeBootstrapMount, type LoadedNativeBootstrap, type NativeBootstrapExtension } from '../src/host/native-bootstrap.ts'
import { createNativePackages, type NativePackageDefinition } from '../src/host/native-packages.ts'
import { createPackageConfigurationRegistry } from '../src/host/package-configuration.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

function loaded(packages: readonly NativePackageDefinition[], extra: Partial<NativeBootstrapExtension> = {}): LoadedNativeBootstrap {
  return { metadata: { manifest: { id: 'extension', version: '1.0.0', apiVersion: 1 }, codeFingerprint: 'a'.repeat(64),
    trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true }, create: () => ({ packages, ...extra }) }
}
function configurationRegistry() { return createPackageConfigurationRegistry({ store: {
  async read() { throw new Error('No configuration read expected') }, async compareAndSet() { throw new Error('No configuration write expected') }
} }) }
function definition(id: string): NativePackageDefinition {
  return { manifest: { schema: 1, id, version: '1.0.0', dependencies: [], provides: [], requires: [], contributions: [] } }
}
function setup() {
  const store = createSqliteStore({ filename: ':memory:' })
  const context = createContextStore()
  const persona = context.registerPersona({ id: 'fixture', version: '1', name: 'Fixture', identity: {}, style: {} })
  const signal = new AbortController().signal
  const prompts: (readonly MessageContent[])[] = []
  return { store, context, persona, signal, prompts,
    options: { directory: '/unused-test-directory', store, context, persona, signal },
    hostOptions: { store, context, persona, authorizeIncoming: () => true,
      agent: { async createSession() { return { sessionId: 'trusted-parent' } },
        async submit(request: { content: readonly MessageContent[] }) { prompts.push(request.content); return { status: 'accepted' as const } },
        async follow() { return () => {} } },
      transport: { send() { assert.fail('No transport send expected') } } } }
}

test('bootstrap package contributions run real features, policy effects and ordered source-preserving input through shared registration', async () => {
  const f = setup()
  let reads = 0
  const disposal: string[] = []
  const tools: NativePackageDefinition = { ...definition('tools'), manifest: { ...definition('tools').manifest,
    provides: [{ id: 'test-service', version: 1 }], contributions: [{ kind: 'effect', id: 'test.read' }, { kind: 'event-validator', id: 'test.ready' }] },
    install(context) {
      context.publish('test-service', 1, { greeting: 'sourced' })
      context.contribute('effect', 'test.read', { execute() { reads++; return { text: 'fact' } } })
      context.contribute('event-validator', 'test.ready', (data: Record<string, unknown>) => data.ready === true)
      context.own('timer', 'tools-timer', () => { disposal.push('tools') })
    } }
  const feature: FeatureDefinition = { id: 'test-feature', version: '1.0.0', apiVersion: 1, capabilities: ['test.read'], subscriptions: ['test.ready'],
    setup(services) { services.on('test.ready', execution => execution.invoke('test.read', {})) } }
  const input: NativePackageDefinition = { ...definition('input'), manifest: { ...definition('input').manifest,
    dependencies: ['tools'], requires: [{ id: 'test-service', version: 1 }], contributions: [
      { kind: 'input-provider', id: 'test-late', order: 20, capabilities: ['test.read'] },
      { kind: 'input-provider', id: 'test-early', order: 10 }, { kind: 'feature', id: feature.id }] },
    install(context) {
      assert.deepEqual(context.service('test-service', 1), { greeting: 'sourced' })
      context.contribute('input-provider', 'test-early', { capabilities: [], prepare(_execution: unknown, event: { data: { text: string } }) {
        return [{ type: 'text', text: `early ${event.data.text}` }]
      } })
      context.contribute('input-provider', 'test-late', { capabilities: ['test.read'], async prepare(execution: { invoke(name: string, input: object): Promise<unknown> }, event: { userId: string; conversationId: string; data: { text: string } }) {
        assert.equal(event.userId, '42'); assert.equal(event.conversationId, 'group:123'); assert(Object.isFrozen(event))
        await execution.invoke('test.read', {})
        return [{ type: 'text', text: `${event.data.text} late` }]
      } })
      context.contribute('feature', feature.id, feature)
      context.own('subscription', 'input-subscription', () => { disposal.push('input') })
    } }
  const mount = await createNativeBootstrapMount({ bootstrap: loaded([input, tools]), context: f.options })
  const host = createBridgeHost({ ...f.hostOptions, ...mount.bridgeOptions })
  const packages = createNativePackages({ packages: mount.packageDefinitions, configurationRegistry: configurationRegistry() })
  try {
    await mount.install(host)
    assert.deepEqual((await packages.start()).map(item => item.id), ['tools', 'input'])
    await mount.bindPackages(host, packages)
    await mount.start(host)
    assert.equal(host.policy.describe().grants.length, 0)
    const denied = await host.engine.emit({ id: 'denied', type: 'test.ready', conversationId: 'group:123', data: { ready: true } })
    assert.equal(denied.outcomes.find(item => item.featureId === feature.id)?.errorCode, 'POLICY_DENIED')
    assert.equal(reads, 0)
    host.policy.grant({ id: 'feature-test', featureId: feature.id, conversationId: 'group:123', capabilities: ['test.read'], maxUses: { 'test.read': 1 } })
    await host.engine.emit({ id: 'allowed', type: 'test.ready', conversationId: 'group:123', data: { ready: true } })
    assert.equal(reads, 1)
    host.policy.grant({ id: 'relay', featureId: 'agent-relay', conversationId: 'group:123', capabilities: ['agent.submit', 'test.read'], maxUses: { 'agent.submit': 1, 'test.read': 1 } })
    const receipt = await host.receive({ id: 'message', conversationId: 'group:123', userId: '42', receivedAt: 100,
      content: [{ type: 'text', text: 'original' }], directed: true, isSelf: false })
    assert.equal(receipt.status, 'accepted')
    assert.equal(reads, 2)
    assert.deepEqual(f.prompts, [[{ type: 'text', text: 'early original late' }]])
    assert.deepEqual(host.history.snapshot('group:123').messages[0]?.content, [{ type: 'text', text: 'original' }])
    await mount.stop(host)
    assert.equal(host.engine.describe().features.find(item => item.id === feature.id)?.status, 'stopped')
    assert.equal(host.engine.describe().features.find(item => item.id === 'agent-relay')?.status, 'active')
    assert.throws(() => mount.bridgeOptions.effectAdapters['test.read']!.execute({ input: {}, signal: f.signal,
      scope: { eventId: 'late', conversationId: 'group:123', featureId: feature.id, version: '1.0.0' } }))
    await packages.stop()
    assert.deepEqual(disposal, ['input', 'tools'])
  } finally { await mount.stop(host); await packages.stop(); await host.stop(); f.store.close() }
})

test('general package input capabilities must match declarations and cannot be supplied by default specialized services', async () => {
  const f = setup()
  const input: NativePackageDefinition = { ...definition('bad-input'), manifest: { ...definition('bad-input').manifest,
    contributions: [{ kind: 'input-provider', id: 'bad-input' }] }, install(context) {
    context.contribute('input-provider', 'bad-input', { capabilities: ['messaging.send'], prepare() { return [] } })
  } }
  const mount = await createNativeBootstrapMount({ bootstrap: loaded([input]), context: f.options })
  const host = createBridgeHost({ ...f.hostOptions, ...mount.bridgeOptions })
  const packages = createNativePackages({ packages: mount.packageDefinitions, configurationRegistry: configurationRegistry() })
  try {
    await mount.install(host); await packages.start()
    await assert.rejects(mount.bindPackages(host, packages), { code: 'INVALID_NATIVE_PACKAGE_CONTRIBUTION' })
    assert.equal(host.policy.describe().grants.length, 0)
    assert.equal(host.engine.describe().features.find(item => item.id === 'agent-relay')?.status, 'active')
  } finally { await mount.stop(host); await packages.stop(); await host.stop(); f.store.close() }
})

test('package bindings reject reserved capabilities and legacy duplicate effects before host installation', async () => {
  const f = setup()
  try {
    const effect = (id: string): NativePackageDefinition => ({ ...definition('effect'), manifest: {
      ...definition('effect').manifest, contributions: [{ kind: 'effect', id }] } })
    await assert.rejects(createNativeBootstrapMount({ bootstrap: loaded([effect('messaging.send')]), context: f.options }), { code: 'INVALID_NATIVE_BOOTSTRAP' })
    await assert.rejects(createNativeBootstrapMount({ bootstrap: loaded([effect('test.read')], { effectAdapters: { 'test.read': { execute: () => null } } }), context: f.options }), { code: 'NATIVE_PACKAGE_CONTRIBUTION_DUPLICATE' })
  } finally { f.store.close() }
})
