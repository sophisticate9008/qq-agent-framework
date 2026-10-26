import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'
import { createNativeDshRestartStorage } from '../src/storage/native-dsh-restart.ts'
import { isNativeConfigurationRevisions } from '../src/contracts/native-revisions.ts'
import { parseNativeDshRestartSnapshot } from '../src/contracts/native-dsh-restart.ts'
import { createNativeChatGatewayFixture } from './fixtures/native-chat-gateway.ts'

test('actual administrator routes expose restart availability and preserve maintenance guards after a lost process', { timeout: 40_000 }, async context => {
  const fixture = await createNativeChatGatewayFixture(context)
  await fixture.launch()
  const availability = parseNativeDshRestartSnapshot(await fixture.api('/api/chat/dsh/restart'))
  assert(availability)
  assert.equal(availability.available, false)
  assert.deepEqual(availability.missingReasons, ['LOCAL_DSH_RESTART_NOT_CONFIGURED'])
  assert.equal(availability.operation, null)
  const revisions = (await fixture.runtime()).revisions
  assert(isNativeConfigurationRevisions(revisions))
  const operationId = randomUUID()
  await fixture.api('/api/chat/dsh/restart', { operationId, revisions, command: 'untrusted-browser-command' }, 400)
  const denied = await fixture.api('/api/chat/dsh/restart', { operationId, revisions }, 503)
  assert.equal(denied.error, 'local_dsh_restart_not_configured')
  const storage = createNativeDshRestartStorage(join(fixture.directory, 'runtime'))
  const before = await storage.read()
  assert.deepEqual(before.value.records, [])
  const at = Date.now()
  await storage.write(before.revision, { schema: 1, records: [{ instanceId: randomUUID(), targetIdentity: 'a'.repeat(64),
    operation: { schema: 1, id: operationId, state: 'running', phase: 'restart', phaseState: 'in-flight', revisions,
      wasRunning: false, restartExecutionVerified: false, createdAt: at, updatedAt: at, reasons: [] } }] })
  const original = parseNativeDshRestartSnapshot(await fixture.api(`/api/chat/dsh/restart?id=${operationId}`))
  assert.equal(original?.operation?.id, operationId)
  assert.equal(original?.operation?.state, 'unknown')
  assert.equal((await fixture.api('/api/chat/runtime/start', { revisions }, 409)).error, 'dsh_restart_reconciliation_required')
  assert.equal((await fixture.api('/api/chat/plans', {}, 409)).error, 'dsh_restart_reconciliation_required')
  assert.equal((await fixture.runtime()).state, 'stopped')
  assert.equal(fixture.controls.creates, 0)
  assert.deepEqual(fixture.calls, [])
  assert.deepEqual(fixture.sends, [])
})
