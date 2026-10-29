import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { publishSimulationUsage } from '../scripts/simulation-usage.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createNativeUsage, NATIVE_USAGE_TURNS_NAMESPACE } from '../src/host/native-usage.ts'
import { createNativeUsageMaintenance } from '../src/host/native-usage-maintenance.ts'

test('simulated real usage preserves original price/time, isolates conversations and stays cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qbf-usage-'))
  const sourceDirectory = join(root, 'source')
  const simulationDirectory = join(root, 'qq-ABC123')
  await mkdir(sourceDirectory, { mode: 0o700 })
  await mkdir(join(simulationDirectory, 'native'), { recursive: true, mode: 0o700 })
  const runId = basename(simulationDirectory)
  await writeFile(join(simulationDirectory, 'simulation.json'), JSON.stringify({ schema: 1, sourceDirectory }))
  const modelStore = createSqliteStore({ filename: join(simulationDirectory, 'native/native-chat.sqlite') })
  const target = createSqliteStore({ filename: join(sourceDirectory, 'native-chat.sqlite') })
  try {
    target.write('native-chat.meta', 'session-definition', { identity: 'a'.repeat(64) })
    const recordedAt = Date.now() - 600_000
    const ledger = createNativeUsage({ store: modelStore, clock: () => recordedAt })
    ledger.setPricing([{ provider: 'model-provider', model: 'test-model', currency: 'CNY',
      inputPerMillion: 7, outputPerMillion: 9, cacheReadPerMillion: 2, cacheWritePerMillion: 4 }], null)
    ledger.append({ conversationId: 'private:123', sessionId: 'session-1', generation: 1, turnId: 'turn-1',
      provider: 'model-provider', model: 'test-model', status: 'completed', coverage: 'complete',
      tokens: { input: 4, output: 2, cacheRead: 8, cacheWrite: 0, total: 14 }, reportedCost: null })
    const original = ledger.snapshot().items[0]!
    const options = { sourceDirectory, simulationDirectory, runId }
    assert.deepEqual(await publishSimulationUsage(options), { imported: 1, existing: 0, retired: 0 })
    const actual = createNativeUsage({ store: target }).snapshot().items[0]!
    assert.equal(actual.conversationId, `simulation:${runId}:private:123`)
    assert.equal(actual.sessionId, original.sessionId)
    assert.equal(actual.recordedAt, recordedAt)
    assert.deepEqual(actual.tokens, original.tokens)
    assert.deepEqual(actual.cost, original.cost)
    assert.deepEqual(actual.priceSnapshot, original.priceSnapshot)
    assert.deepEqual(await publishSimulationUsage(options), { imported: 0, existing: 1, retired: 0 })
    createNativeUsageMaintenance({ store: target }).clearLedger()
    assert.deepEqual(await publishSimulationUsage(options), { imported: 0, existing: 0, retired: 1 })
    assert.equal(target.list(NATIVE_USAGE_TURNS_NAMESPACE).length, 0)
    await writeFile(join(simulationDirectory, 'simulation.json'), JSON.stringify({ schema: 1, sourceDirectory: join(root, 'other') }))
    await assert.rejects(publishSimulationUsage(options), { code: 'SIMULATION_USAGE_SOURCE_MISMATCH' })
  } finally { modelStore.close(); target.close(); await rm(root, { recursive: true, force: true }) }
})
