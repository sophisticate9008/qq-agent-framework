import assert from 'node:assert/strict'
import test from 'node:test'
import { createContextStore } from '../src/core/context.ts'
import { createBridgeHost } from '../src/host/bridge.ts'
import { readNativeRuntimeProjection, nativeRuntimeFeatureResponse } from '../src/host/native-runtime-projection.ts'
import { parseNativeRuntimeProjection } from '../src/contracts/native-runtime-projection.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

test('runtime projection and legacy feature response share actual extension installation and keep readiness separate from authority', async () => {
  const store = createSqliteStore({ filename: ':memory:' })
  const context = createContextStore()
  const persona = context.registerPersona({ id: 'fixture', version: '1', name: 'Fixture', identity: {}, style: {} })
  const host = createBridgeHost({ store, context, persona, authorizeIncoming: () => true,
    effectAdapters: { 'extension.read': { execute: () => ({ ok: true }) } }, eventValidators: { 'extension.event': () => true },
    agent: { async createSession() { return { sessionId: 'unused' } }, async submit() { return { status: 'accepted' } }, async follow() { return () => {} } },
    transport: { send() { assert.fail('Readonly projection must not send') } } })
  let ready = false
  const source = { async status() { return { state: 'running' as const, chatReady: ready, missingReasons: ready ? [] : ['deployment_not_verified'] } }, host: () => host }
  try {
    host.engine.install({ id: 'extension', version: '1.0.0', apiVersion: 1, capabilities: ['extension.read'], subscriptions: ['extension.event'], setup(services) { services.on('extension.event', () => {}) } })
    const before = store.stats?.()
    const starting = await readNativeRuntimeProjection(source)
    const extension = starting.features.find(feature => feature.id === 'extension')!
    assert.equal(extension.installed, true); assert.equal(extension.ready, false); assert.equal(extension.authorized, null)
    assert.equal(starting.authorizationEvaluated, false)
    assert.equal(starting.capabilities.some(capability => capability.id === 'personas'), false)
    assert.equal(starting.editableResources.some(resource => resource.id === 'personas'), true)
    assert.deepEqual(store.stats?.(), before)
    ready = true
    const running = await readNativeRuntimeProjection(source)
    assert(parseNativeRuntimeProjection(running))
    const compatibility = nativeRuntimeFeatureResponse(running)
    assert.deepEqual(compatibility.features.map(feature => feature.id), running.features.map(feature => feature.id))
    assert.equal(compatibility.projection, running)
    assert.equal(running.features.find(feature => feature.id === 'extension')?.ready, true)
    assert.equal(host.policy.describe().grants.length, 0)
    await host.engine.uninstall('extension')
    const stopped = await readNativeRuntimeProjection(source)
    assert.equal(stopped.features.find(feature => feature.id === 'extension')?.installed, false)
    assert.equal(stopped.features.find(feature => feature.id === 'extension')?.ready, false)
    assert.equal(stopped.capabilities.find(capability => capability.id === 'extension.read')?.installed, false)
    assert(parseNativeRuntimeProjection(stopped))
  } finally { await host.stop(); store.close() }
})

test('projection decoder rejects invented authorization, readiness, unknown source and private fields', async () => {
  const projection = await readNativeRuntimeProjection()
  assert(parseNativeRuntimeProjection(projection))
  assert.equal(projection.state, 'not-connected')
  assert.equal(parseNativeRuntimeProjection({ ...projection, authorizationEvaluated: true }), null)
  assert.equal(parseNativeRuntimeProjection({ ...projection, chatReady: true }), null)
  assert.equal(parseNativeRuntimeProjection({ ...projection, source: 'dsh' }), null)
  assert.equal(parseNativeRuntimeProjection({ ...projection, credential: 'hidden' }), null)
  assert.equal(parseNativeRuntimeProjection({ ...projection, features: [{ id: 'invented', version: '1', status: 'stopped', installed: false, ready: true,
    authorized: null, declared: true, capabilities: [], subscriptions: [] }] }), null)
})
