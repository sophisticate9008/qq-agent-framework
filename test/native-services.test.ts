import assert from 'node:assert/strict'
import test from 'node:test'
import { createContextStore } from '../src/core/context.ts'
import type { FeatureDefinition } from '../src/core/types.ts'
import { createBridgeHost } from '../src/host/bridge.ts'
import { createNativeBootstrapMount, type LoadedNativeBootstrap } from '../src/host/native-bootstrap.ts'
import { createNativePackages, type NativePackageDefinition } from '../src/host/native-packages.ts'
import { createNativeServicesPackage, requireNativeHostService, type NativeAgentService, type NativeHostServicePorts, type NativeWorkService } from '../src/host/native-services.ts'
import { NATIVE_HOST_SERVICES_PACKAGE_ID, NATIVE_HOST_SERVICE_IDS } from '../src/contracts/native-services.ts'
import { createNativeMessageSources } from '../src/host/native-message-sources.ts'
import { createNativeWorkExecutor } from '../src/host/native-work.ts'
import { createNativeWorkEffects } from '../src/host/native-work-tools.ts'
import { createNativeInteractions } from '../src/host/native-interactions.ts'
import { createNativeExecutionController } from '../src/host/native-execution.ts'
import { createPackageConfigurationRegistry } from '../src/host/package-configuration.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

function configurationRegistry() { return createPackageConfigurationRegistry({ store: {
  async read() { throw new Error('No configuration read expected') }, async compareAndSet() { throw new Error('No configuration write expected') }
} }) }

test('two external packages share versioned host facades and work invocation preserves caller policy and actual owner source', async () => {
  const store = createSqliteStore({ filename: ':memory:' })
  const signal = new AbortController().signal
  const context = createContextStore()
  const persona = context.registerPersona({ id: 'fixture', version: '1', name: 'Fixture', identity: {}, style: {} })
  const sources = createNativeMessageSources({ owner: 'owner', signal, async validate() {} })
  let starts = 0
  const executor = createNativeWorkExecutor({ store, messageSources: sources.reader, async authorize() {},
    async loadConfiguration() { return { schema: 1, enabled: true, provider: 'provider', model: 'model', agentPreset: 'work', fullAccess: false, timeoutMs: 1000 } },
    isCurrentParent: binding => binding.conversationId === 'group:123' && binding.sessionId === 'parent' && binding.generation === 3,
    backend: { async verify() {}, async start(request) { starts++; return { childId: request.childId,
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'result' }] }), async dispose() {} } } } })
  const executions = createNativeExecutionController({ store })
  const interactions = createNativeInteractions({ state: () => 'running' })
  const ports: NativeHostServicePorts = {
    agent: { status: () => ({ available: true, missingReasons: [], secret: 'not-public' }),
      binding: conversationId => ({ conversationId, sessionId: 'parent', generation: 3, secret: 'not-public' }) },
    interactions: { snapshot: interactions.snapshot },
    executions: { read: executions.get, list: executions.list },
    tools: { async catalog() { return { state: 'available', scope: 'session', items: [], limited: false, missingReasons: [], externalToolAuthorizationVerified: false } } },
    work: { status: () => ({ available: true, missingReasons: [] }), read: executor.read, list: executor.list }
  }
  let firstWork: NativeWorkService | undefined
  let secondWork: NativeWorkService | undefined
  let firstAgent: NativeAgentService | undefined
  let secondAgent: NativeAgentService | undefined
  const consumer = (id: string, active: boolean): NativePackageDefinition => ({
    manifest: { schema: 1, id, version: '1.0.0', dependencies: [NATIVE_HOST_SERVICES_PACKAGE_ID], provides: [],
      requires: Object.values(NATIVE_HOST_SERVICE_IDS).map(id => ({ id, version: 1 })),
      contributions: active ? [{ kind: 'feature', id: 'external-worker' }, { kind: 'event-validator', id: 'external.work' }] : [] },
    install(packageContext) {
      const work = requireNativeHostService(packageContext, 'native-work')
      const agent = requireNativeHostService(packageContext, 'native-agent')
      assert.equal(requireNativeHostService(packageContext, 'native-interactions').snapshot().available, false)
      assert.deepEqual(requireNativeHostService(packageContext, 'native-executions').list(), [])
      assert.equal(typeof requireNativeHostService(packageContext, 'native-tools').catalog, 'function')
      if (active) {
        firstWork = work; firstAgent = agent
        const feature: FeatureDefinition = { id: 'external-worker', version: '1.0.0', apiVersion: 1,
          capabilities: ['native.work.start'], subscriptions: ['external.work'], setup(services) {
            services.on('external.work', execution => work.start(execution, { task: 'Explicit owner task' }))
          } }
        packageContext.contribute('feature', feature.id, feature)
        packageContext.contribute('event-validator', 'external.work', () => true)
      } else { secondWork = work; secondAgent = agent }
    }
  })
  const bootstrap: LoadedNativeBootstrap = { metadata: { manifest: { id: 'external', version: '1.0.0', apiVersion: 1 }, codeFingerprint: 'a'.repeat(64),
    trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true }, create: () => ({ packages: [consumer('first', true), consumer('second', false)] }) }
  const mount = await createNativeBootstrapMount({ bootstrap, context: { directory: '/unused', store, context, persona, signal } })
  const host = createBridgeHost({ store, context, persona, ...mount.bridgeOptions,
    effectAdapters: { ...mount.bridgeOptions.effectAdapters, ...createNativeWorkEffects({ executor: () => executor, sources: () => sources.reader }) },
    authorizeIncoming: () => true, transport: { send() { assert.fail('No send expected') } },
    agent: { async createSession() { return { sessionId: 'unused' } }, async submit() { return { status: 'accepted' } }, async follow() { return () => {} } } })
  const manager = createNativePackages({ packages: [...mount.packageDefinitions, createNativeServicesPackage({ ports })], configurationRegistry: configurationRegistry() })
  try {
    await mount.install(host); await manager.start(); await mount.bindPackages(host, manager); await mount.start(host)
    assert.notEqual(firstWork, secondWork); assert.notEqual(firstAgent, secondAgent)
    assert.deepEqual(firstAgent?.status(), secondAgent?.status())
    assert(firstWork && firstAgent)
    assert.equal('executor' in firstWork, false); assert.equal('send' in firstAgent, false)
    assert.deepEqual(firstAgent.status(), { available: true, missingReasons: [] })
    assert.deepEqual(firstAgent.binding('group:123'), { conversationId: 'group:123', sessionId: 'parent', generation: 3 })
    assert.equal(host.policy.describe().grants.length, 0)
    const event = (id: string) => ({ id, type: 'external.work', conversationId: 'group:123', sessionId: 'parent', data: { generation: 3 } })
    const denied = await host.engine.emit(event('no-grant'))
    assert.equal(denied.outcomes.find(item => item.featureId === 'external-worker')?.errorCode, 'POLICY_DENIED')
    host.policy.grant({ id: 'worker-grant', featureId: 'external-worker', conversationId: 'group:123', capabilities: ['native.work.start'], maxUses: { 'native.work.start': 4 } })
    const missing = await host.engine.emit(event('no-source'))
    assert.equal(missing.outcomes.find(item => item.featureId === 'external-worker')?.errorCode, 'NATIVE_MESSAGE_SOURCE_MISSING')
    sources.capture({ id: 'visitor', conversationId: 'group:123', userId: 'visitor' }, { receivedAt: Date.now(), expiresAt: Date.now() + 10000, signal })
    const visitor = await host.engine.emit(event('visitor'))
    assert.equal(visitor.outcomes.find(item => item.featureId === 'external-worker')?.errorCode, 'NATIVE_MESSAGE_SOURCE_NOT_OWNER')
    assert.equal(starts, 0)
    sources.capture({ id: 'owner', conversationId: 'group:123', userId: 'owner' }, { receivedAt: Date.now(), expiresAt: Date.now() + 10000, signal })
    const owner = await host.engine.emit(event('owner'))
    assert.equal(owner.outcomes.find(item => item.featureId === 'external-worker')?.status, 'completed')
    assert.equal(starts, 1)
    await mount.stop(host); await manager.stop()
    assert.throws(() => firstAgent!.status())
    assert.throws(() => firstWork!.list())
    assert.throws(() => firstWork!.start({ signal, async invoke() { assert.fail('Retained service must never invoke') } }, { task: 'late' }))
  } finally { await mount.stop(host); await manager.stop(); await executor.close(signal); await host.stop(); store.close() }
})

test('host service versions and declared dependency remain required before package code executes', () => {
  const consumer: NativePackageDefinition = { manifest: { schema: 1, id: 'consumer', version: '1.0.0', dependencies: [], provides: [],
    requires: [{ id: 'native-work', version: 2 }], contributions: [] } }
  assert.throws(() => createNativePackages({ packages: [consumer], configurationRegistry: configurationRegistry() }), { code: 'NATIVE_PACKAGE_SERVICE_VERSION_UNAVAILABLE' })
})
