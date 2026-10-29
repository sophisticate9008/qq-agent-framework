import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { BRIDGE_PLUGIN_PROTOCOL, RECEIPT_LIMITS, createClaimReceiptJournal } from '../packages/dsh-bridge-plugin/src/receipts.ts'
import { createDshBridgePluginPort } from '../src/adapters/dsh-tool-scope.ts'
import { createNativeExecutionController } from '../src/host/native-execution.ts'
import { createNativeExecutionClaims } from '../src/host/native-execution-claims.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

const binding = { conversationId: 'private:123', sessionId: 'session-1', generation: 1 }
const revision = 'c'.repeat(64)

function fixture(context: TestContext) {
  const store = createSqliteStore({ filename: ':memory:' })
  let clock = 1_000
  let journal = createClaimReceiptJournal(() => clock)
  let calls = 0
  const port = createDshBridgePluginPort(async (method, input) => {
    calls++
    if (method === 'bridgePlugin/describe') return { protocol: BRIDGE_PLUGIN_PROTOCOL, pluginVersion: '1.4.1', sdkVersion: '0.2.1-rc.2',
      issuerEpoch: journal.issuerEpoch, authentication: 'dsh-owner-peer', durableReceipts: false,
      claimMeaning: 'inbox-claimed-not-completed', externalToolAuthorizationVerified: false, retention: RECEIPT_LIMITS }
    assert.equal(method, 'bridgePlugin/claimReceipts')
    assert(input)
    return journal.read({ sessionId: String(input.sessionId), issuerEpoch: String(input.issuerEpoch),
      ...(input.after === undefined ? {} : { after: Number(input.after) }), limit: Number(input.limit) })
  })
  const executions = createNativeExecutionController({ store })
  executions.start()
  const claims = createNativeExecutionClaims({ store, port, issuerEpoch: journal.issuerEpoch, executions, signal: new AbortController().signal })
  context.after(async () => { await claims.drain(); await executions.stop(); store.close() })
  const claim = (requestId: string, turn = 5) => journal.record({ sessionId: binding.sessionId, requestId, userMessageId: `user-${requestId}`, turn })
  return { store, port, executions, claims, claim, calls: () => calls,
    advance: (milliseconds: number) => { clock += milliseconds },
    restartPlugin: () => { journal = createClaimReceiptJournal(() => clock) },
    async begin(requestId = 'request-1') {
      const baseline = await claims.baseline(binding.sessionId, new AbortController().signal)
      const execution = executions.admit({ binding, requestId, policyRevision: revision })
      claims.attach(execution, baseline)
      await executions.submit(execution.id, async () => ({ status: 'accepted' }))
      return execution
    } }
}

test('verified plugin baseline and official journal receipt bind only the exact post-submission request, never FIFO', async context => {
  const fake = fixture(context)
  fake.claim('old-request', 1)
  const execution = await fake.begin()
  fake.claim('unrelated-request', 2)
  await fake.claims.poll(execution.id)
  assert.equal(fake.executions.get(execution.id)?.turn, null)
  assert.equal(fake.executions.get(execution.id)?.externalStatus, 'accepted')
  fake.claim('request-1', 7)
  await fake.claims.poll(execution.id)
  assert.equal(fake.executions.get(execution.id)?.turn?.id, '7')
  assert.equal(fake.executions.forTurn(binding, '7')?.id, execution.id)
  assert.equal(fake.executions.forTurn(binding, '2'), null)
  assert.equal(fake.executions.observe(execution.id, { eventId: 'completed', binding, turnId: '7', kind: 'completed' }).decision, 'deliver')
})

test('plugin issuer restart is explicit unknown, retains old cursor, isolates work and never silently refreshes baseline', async context => {
  const fake = fixture(context)
  const execution = await fake.begin()
  fake.restartPlugin()
  await fake.claims.poll(execution.id)
  assert.equal(fake.executions.get(execution.id)?.status, 'unknown')
  const cursor = fake.store.read('host.execution-claim-cursors', execution.id)!
  assert.equal((cursor.value as Record<string, unknown>).state, 'unknown-epoch')
  const calls = fake.calls()
  await fake.claims.poll(execution.id)
  assert.equal(fake.calls(), calls)
  assert.throws(() => fake.executions.admit({ binding, requestId: 'next-request', policyRevision: revision }), { code: 'EXECUTION_SESSION_ISOLATED' })
})

test('retention gap is not a healthy empty page or proof a prompt was rejected', async context => {
  const fake = fixture(context)
  const execution = await fake.begin()
  fake.claim('request-1')
  fake.advance(RECEIPT_LIMITS.maxAgeMs + 1)
  await fake.claims.poll(execution.id)
  assert.equal(fake.executions.get(execution.id)?.status, 'unknown')
  assert.equal(fake.executions.get(execution.id)?.isolated, true)
  assert.equal((fake.store.read('host.execution-claim-cursors', execution.id)!.value as Record<string, unknown>).state, 'cursor-gap')
  assert.equal(fake.executions.get(execution.id)?.turn, null)
})

test('persisted cursor survives controller restart and late exact claim remains record-only', async context => {
  const fake = fixture(context)
  const execution = await fake.begin()
  await fake.executions.stop()
  const restored = createNativeExecutionController({ store: fake.store })
  restored.start()
  const description = await fake.port.describe(new AbortController().signal)
  const claims = createNativeExecutionClaims({ store: fake.store, port: fake.port, issuerEpoch: description.issuerEpoch,
    executions: restored, signal: new AbortController().signal })
  try {
    fake.claim('request-1', 9)
    await claims.poll(execution.id)
    assert.equal(restored.get(execution.id)?.turn?.id, '9')
    assert.equal(restored.observe(execution.id, { eventId: 'late-after-restart', binding, turnId: '9', kind: 'completed' }).decision, 'record-only')
  } finally { await claims.drain(); await restored.stop() }
})
