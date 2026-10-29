import assert from 'node:assert/strict'
import test from 'node:test'
import { MIGRATION_PROTOCOL } from '../packages/dsh-bridge-plugin/src/migration-protocol.ts'
import { BRIDGE_PLUGIN_PROTOCOL, RECEIPT_LIMITS } from '../packages/dsh-bridge-plugin/src/receipts.ts'
import { createDshBridgePluginPort, type DshBridgePluginDescription } from '../src/adapters/dsh-tool-scope.ts'
import { createDshSessionMigrationPort, type DshSessionMigrationMethod, type DshSessionMigrationPreviewRequest,
  type DshSessionMigrationReceipt, type DshSessionMigrationRequest } from '../src/adapters/dsh-session-migration.ts'

const previewRequest: DshSessionMigrationPreviewRequest = {
  migrationId: 'migration-1', sourceSessionId: 'source-1', expectedPreset: 'preset-old', targetPreset: 'preset-new',
}
const request: DshSessionMigrationRequest = { ...previewRequest, issuerEpoch: 'epoch-1', expectedCursor: 17,
  expectedSourceDigest: 'a'.repeat(64), expectedTargetRevision: 'b'.repeat(64) }
const signal = () => new AbortController().signal

function description(overrides: Partial<DshBridgePluginDescription> = {}): DshBridgePluginDescription {
  return { protocol: BRIDGE_PLUGIN_PROTOCOL, pluginVersion: '0.1.0', sdkVersion: '0.2.1-rc.2', issuerEpoch: request.issuerEpoch,
    authentication: 'dsh-owner-peer', durableReceipts: false, claimMeaning: 'inbox-claimed-not-completed', retention: RECEIPT_LIMITS,
    externalToolAuthorizationVerified: false, migrationProtocol: MIGRATION_PROTOCOL,
    methods: ['bridgePlugin/describe', 'bridgePlugin/forkPreview', 'bridgePlugin/forkWithPreset', 'bridgePlugin/inspectMigration'], ...overrides }
}

function preview() {
  return { ...previewRequest, migrationProtocol: MIGRATION_PROTOCOL, issuerEpoch: request.issuerEpoch, state: 'available',
    sourceCursor: request.expectedCursor, sourceDigest: request.expectedSourceDigest, targetRevision: request.expectedTargetRevision, missingReasons: [] }
}

function receipt(overrides: Partial<DshSessionMigrationReceipt> = {}): DshSessionMigrationReceipt {
  return { ...request, migrationProtocol: MIGRATION_PROTOCOL, state: 'completed', childSessionId: 'child-1',
    idempotency: 'created', missingReasons: [], ...overrides }
}

function fixture(reply: (method: DshSessionMigrationMethod, input: Record<string, unknown>) => unknown | Promise<unknown>,
  offered = description()) {
  const calls: { method: DshSessionMigrationMethod; input: Record<string, unknown> }[] = []
  const port = createDshSessionMigrationPort({ describe: async () => offered,
    async invoke(method, input) { calls.push({ method, input }); return reply(method, input) } })
  return { port, calls, forks: () => calls.filter(call => call.method === 'bridgePlugin/forkWithPreset').length }
}

test('migration preview and commit preserve every reference and expected constraint without other RPCs', async () => {
  for (const pluginVersion of ['0.1.0', '0.2.0', '1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.3.1', '1.4.0'] as const) {
    const fake = fixture(method => method === 'bridgePlugin/forkPreview' ? preview() : receipt(), description({ pluginVersion }))
    assert.deepEqual(await fake.port.forkPreview(previewRequest, signal()), preview())
    assert.deepEqual(await fake.port.forkWithPreset(request, signal()), receipt())
    assert.deepEqual(fake.calls, [{ method: 'bridgePlugin/forkPreview', input: previewRequest },
      { method: 'bridgePlugin/forkWithPreset', input: request }])
  }
})

test('blocked preview retains unknown facts as null and never forks a child', async () => {
  const blocked = { ...preview(), state: 'blocked', sourceCursor: null, sourceDigest: null, targetRevision: null,
    missingReasons: ['source_not_available'] }
  const fake = fixture(() => blocked)
  assert.deepEqual(await fake.port.forkPreview(previewRequest, signal()), blocked)
  assert.equal(fake.forks(), 0)
})

test('migration requires the advertised protocol and all three methods before invoking', async () => {
  for (const offered of [description({ migrationProtocol: 'other/1' }), description({ methods: ['bridgePlugin/forkPreview'] }),
    description({ methods: ['bridgePlugin/forkPreview', 'bridgePlugin/forkWithPreset', 'bridgePlugin/inspectMigration', 'bridgePlugin/inspectMigration'] })]) {
    const fake = fixture(() => preview(), offered)
    await assert.rejects(fake.port.forkPreview(previewRequest, signal()), /DSH_MIGRATION_UNAVAILABLE/)
    assert.equal(fake.calls.length, 0)
  }
})

test('commit requires its execution epoch while restart inspection verifies the original receipt under a stable current epoch', async () => {
  const before = fixture(() => receipt(), description({ issuerEpoch: 'epoch-other' }))
  await assert.rejects(before.port.forkWithPreset(request, signal()), /DSH_MIGRATION_EPOCH_CHANGED/)
  assert.equal(before.forks(), 0)
  const after = fixture(() => ({ ...preview(), issuerEpoch: 'epoch-other' }))
  await assert.rejects(after.port.forkPreview(previewRequest, signal()), /DSH_MIGRATION_INVALID_RESPONSE/)
  assert.equal(after.forks(), 0)
  const inspectionCalls: Record<string, unknown>[] = []
  let descriptions = 0
  const recovered = createDshSessionMigrationPort({
    describe: async () => { descriptions++; return description({ issuerEpoch: 'epoch-restarted' }) },
    invoke: async (method, input) => {
      assert.equal(method, 'bridgePlugin/inspectMigration')
      inspectionCalls.push(input)
      return receipt({ idempotency: 'replayed' })
    },
  })
  assert.deepEqual(await recovered.inspectMigration(request, signal()), receipt({ idempotency: 'replayed' }))
  assert.deepEqual(inspectionCalls, [request])
  assert.equal(descriptions, 2)
  await assert.rejects(recovered.forkWithPreset(request, signal()), /DSH_MIGRATION_ALREADY_ATTEMPTED/)
  let driftingDescriptions = 0
  let driftingInvocations = 0
  const drifting = createDshSessionMigrationPort({
    describe: async () => description({ issuerEpoch: ++driftingDescriptions === 1 ? 'epoch-restarted' : 'epoch-drifted' }),
    invoke: async method => { assert.equal(method, 'bridgePlugin/inspectMigration'); driftingInvocations++; return receipt() },
  })
  await assert.rejects(drifting.inspectMigration(request, signal()), /DSH_MIGRATION_EPOCH_CHANGED/)
  await assert.rejects(drifting.forkWithPreset(request, signal()), /DSH_MIGRATION_ALREADY_ATTEMPTED/)
  assert.equal(driftingInvocations, 1)
})

test('commit rejects source, target, cursor, digest or revision drift and never retries it', async () => {
  const changes: readonly Partial<DshSessionMigrationReceipt>[] = [
    { sourceSessionId: 'source-other' }, { targetPreset: 'target-other' }, { expectedCursor: 18 },
    { expectedSourceDigest: 'c'.repeat(64) }, { expectedTargetRevision: 'd'.repeat(64) },
  ]
  for (const change of changes) {
    const fake = fixture(() => receipt(change))
    await assert.rejects(fake.port.forkWithPreset(request, signal()), /DSH_MIGRATION_INVALID_RESPONSE/)
    await assert.rejects(fake.port.forkWithPreset(request, signal()), /DSH_MIGRATION_ALREADY_ATTEMPTED/)
    assert.equal(fake.forks(), 1)
  }
})

test('strict request and response fields reject extras, invalid cursors and fabricated available facts', async () => {
  const requestExtra = { ...previewRequest, unexpected: true }
  const requestFake = fixture(() => preview())
  await assert.rejects(requestFake.port.forkPreview(requestExtra, signal()), /DSH_MIGRATION_INVALID_RESPONSE/)
  assert.equal(requestFake.calls.length, 0)
  for (const value of [{ ...preview(), unexpected: true }, { ...preview(), sourceCursor: -1 },
    { ...preview(), sourceDigest: null }, { ...preview(), targetRevision: 'not-a-hash' }]) {
    const fake = fixture(() => value)
    await assert.rejects(fake.port.forkPreview(previewRequest, signal()), /DSH_MIGRATION_INVALID_RESPONSE/)
    assert.equal(fake.forks(), 0)
  }
  const receiptFake = fixture(() => ({ ...receipt(), unexpected: true }))
  await assert.rejects(receiptFake.port.forkWithPreset(request, signal()), /DSH_MIGRATION_INVALID_RESPONSE/)
  assert.equal(receiptFake.forks(), 1)
})

test('a timed-out commit stays single-send even after read-only inspect reports not-found', async () => {
  const absent = receipt({ state: 'not-found', childSessionId: null, idempotency: 'not-found', missingReasons: ['migration_not_found'] })
  const fake = fixture(method => {
    if (method === 'bridgePlugin/forkWithPreset') throw new Error('DSH_TIMEOUT')
    return absent
  })
  await assert.rejects(fake.port.forkWithPreset(request, signal()), /DSH_TIMEOUT/)
  assert.deepEqual(await fake.port.inspectMigration(request, signal()), absent)
  await assert.rejects(fake.port.forkWithPreset(request, signal()), /DSH_MIGRATION_ALREADY_ATTEMPTED/)
  assert.equal(fake.forks(), 1)
  assert.equal(fake.calls.filter(call => call.method === 'bridgePlugin/inspectMigration').length, 1)
})

test('an unknown commit and unknown inspection cannot authorize a second fork or changed target', async () => {
  const unknown = receipt({ state: 'unknown', childSessionId: null, idempotency: 'unknown', missingReasons: ['result_unknown'] })
  const fake = fixture(() => unknown)
  assert.deepEqual(await fake.port.forkWithPreset(request, signal()), unknown)
  assert.deepEqual(await fake.port.inspectMigration(request, signal()), unknown)
  await assert.rejects(fake.port.forkWithPreset(request, signal()), /DSH_MIGRATION_ALREADY_ATTEMPTED/)
  await assert.rejects(fake.port.forkWithPreset({ ...request, targetPreset: 'target-other' }, signal()), /DSH_MIGRATION_CONFLICT/)
  assert.equal(fake.forks(), 1)
})

test('inflight and aborted non-cooperative commits never dispatch another fork', async () => {
  let release: ((value: unknown) => void) | undefined
  let markStarted: (() => void) | undefined
  const response = new Promise<unknown>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const fake = fixture(() => { markStarted?.(); return response })
  const controller = new AbortController()
  const pending = fake.port.forkWithPreset(request, controller.signal)
  await started
  await assert.rejects(fake.port.forkWithPreset(request, signal()), /DSH_MIGRATION_ALREADY_ATTEMPTED/)
  controller.abort()
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  release?.(receipt())
  await rejected
  await assert.rejects(fake.port.forkWithPreset(request, signal()), /DSH_MIGRATION_ALREADY_ATTEMPTED/)
  assert.equal(fake.forks(), 1)
})

test('legacy base describe remains readable without advertising migration support', async () => {
  const legacy = { protocol: BRIDGE_PLUGIN_PROTOCOL, pluginVersion: '0.1.0', sdkVersion: '0.2.1-rc.2', issuerEpoch: 'epoch-legacy',
    authentication: 'dsh-owner-peer', durableReceipts: false, claimMeaning: 'inbox-claimed-not-completed', retention: RECEIPT_LIMITS,
    externalToolAuthorizationVerified: false }
  const baseCalls: string[] = []
  const base = createDshBridgePluginPort(async method => { baseCalls.push(method); return legacy })
  const read = await base.describe(signal())
  assert.equal(read.pluginVersion, '0.1.0')
  assert.equal(read.migrationProtocol, undefined)
  assert.equal(read.methods, undefined)
  let migrationCalls = 0
  const port = createDshSessionMigrationPort({ describe: base.describe, invoke: async () => { migrationCalls++; return preview() } })
  await assert.rejects(port.forkPreview(previewRequest, signal()), /DSH_MIGRATION_UNAVAILABLE/)
  assert.equal(migrationCalls, 0)
  assert.deepEqual(baseCalls, ['bridgePlugin/describe', 'bridgePlugin/describe'])
})

test('one unknown commit at epoch A recovers its durable receipt at epoch B without reforking and rejects an inspection epoch change', async () => {
  let currentEpoch = request.issuerEpoch
  let forkInvocations = 0
  let inspectionInvocations = 0
  let driftDuringInspection = false
  const port = createDshSessionMigrationPort({
    describe: async () => description({ issuerEpoch: currentEpoch }),
    async invoke(method, input) {
      assert.deepEqual(input, request)
      if (method === 'bridgePlugin/forkWithPreset') {
        forkInvocations++
        return receipt({ state: 'unknown', childSessionId: null, idempotency: 'unknown', missingReasons: ['result_unknown'] })
      }
      assert.equal(method, 'bridgePlugin/inspectMigration')
      inspectionInvocations++
      if (driftDuringInspection) currentEpoch = 'epoch-C'
      return receipt({ idempotency: 'replayed' })
    },
  })
  assert.equal((await port.forkWithPreset(request, signal())).state, 'unknown')
  currentEpoch = 'epoch-B'
  const recovered = await port.inspectMigration(request, signal())
  assert.equal(recovered.state, 'completed')
  assert.equal(recovered.issuerEpoch, request.issuerEpoch)
  assert.equal(recovered.childSessionId, 'child-1')
  assert.equal(currentEpoch, 'epoch-B')
  await assert.rejects(port.forkWithPreset(request, signal()), /DSH_MIGRATION_ALREADY_ATTEMPTED/)
  driftDuringInspection = true
  await assert.rejects(port.inspectMigration(request, signal()), /DSH_MIGRATION_EPOCH_CHANGED/)
  await assert.rejects(port.forkWithPreset(request, signal()), /DSH_MIGRATION_ALREADY_ATTEMPTED/)
  assert.equal(forkInvocations, 1)
  assert.equal(inspectionInvocations, 2)
})

test('explicit model and capacity selection requires API 2 and survives preview, commit and durable inspection without omission',async()=>{
  const targetSelection={provider:'verified-route',model:'model-2',reasoningEffort:'high',contextLimits:{contextWindow:8192,maxTokens:1024,headroomTokens:0}}
  const chosen={...previewRequest,targetSelection}
  const legacy=fixture(()=>preview())
  await assert.rejects(legacy.port.forkPreview(chosen,signal()),/DSH_MIGRATION_TARGET_SELECTION_UNSUPPORTED/)
  assert.equal(legacy.calls.length,0)
  const modern=fixture(method=>method==='bridgePlugin/forkPreview'?{...preview(),targetSelection}:{...receipt(),targetSelection},description({migrationApiVersion:2}))
  assert.deepEqual((await modern.port.forkPreview(chosen,signal())).targetSelection,targetSelection)
  const commit={...request,targetSelection}
  assert.deepEqual((await modern.port.forkWithPreset(commit,signal())).targetSelection,targetSelection)
  assert.deepEqual((await modern.port.inspectMigration(commit,signal())).targetSelection,targetSelection)
  assert.equal(modern.forks(),1)
  const forged=fixture(()=>({...preview(),targetSelection:{...targetSelection,contextLimits:{...targetSelection.contextLimits,maxTokens:2048}}}),description({migrationApiVersion:2}))
  await assert.rejects(forged.port.forkPreview(chosen,signal()),/DSH_MIGRATION_INVALID_RESPONSE/)
})
