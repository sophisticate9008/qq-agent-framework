import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { publishSimulationUsage } from '../scripts/simulation-usage.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createNativeUsage, NATIVE_USAGE_TURNS_NAMESPACE } from '../src/host/native-usage.ts'
import { createNativeUsageMaintenance } from '../src/host/native-usage-maintenance.ts'
import { object } from '../src/host/data.ts'

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

async function fixture(runId: string, run: (input: {
  options: { sourceDirectory: string; simulationDirectory: string; runId: string }
  modelStore: ReturnType<typeof createSqliteStore>
  target: ReturnType<typeof createSqliteStore>
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'qbf-plugin-usage-'))
  const sourceDirectory = join(directory, 'source'), simulationDirectory = join(directory, runId)
  await mkdir(sourceDirectory, { mode: 0o700 })
  await mkdir(join(simulationDirectory, 'native'), { recursive: true, mode: 0o700 })
  await writeFile(join(simulationDirectory, 'simulation.json'), JSON.stringify({ schema: 1, sourceDirectory }))
  const modelStore = createSqliteStore({ filename: join(simulationDirectory, 'native/native-chat.sqlite') })
  const target = createSqliteStore({ filename: join(sourceDirectory, 'native-chat.sqlite') })
  target.write('native-chat.meta', 'session-definition', { identity: 'b'.repeat(64) })
  try { await run({ options: { sourceDirectory, simulationDirectory, runId }, modelStore, target }) }
  finally { modelStore.close(); target.close(); await rm(directory, { recursive: true, force: true }) }
}
function append(store: ReturnType<typeof createSqliteStore>, conversationId: string, turnId = 'turn-1') {
  return createNativeUsage({ store }).append({ conversationId, sessionId: 'helper-session', generation: 1, turnId,
    provider: 'fixture-provider', model: 'fixture-model', status: 'completed', coverage: 'complete',
    tokens: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, total: 6 }, reportedCost: null })
}

test('host-attributed plugin usage preserves full provenance and idempotent clearing', async () => {
  await fixture('qq-PluginUsage', async ({ options, modelStore, target }) => {
    append(modelStore, 'group:123')
    append(modelStore, 'plugin:generic-helper')
    const original = modelStore.list(NATIVE_USAGE_TURNS_NAMESPACE).find(row =>
      (row.value as { turn: { conversationId: string } }).turn.conversationId.startsWith('plugin:'))!
    assert.deepEqual(await publishSimulationUsage(options), { imported: 2, existing: 0, retired: 0 })
    const row = target.list(NATIVE_USAGE_TURNS_NAMESPACE).find(row =>
      (row.value as { turn: { conversationId: string } }).turn.conversationId.includes(':plugin:'))!
    const value = row.value as { simulation: { runId: string; originalConversationId: string; sourceRecord: string } }
    assert.deepEqual(value.simulation, { runId: options.runId, originalConversationId: 'plugin:generic-helper', sourceRecord: original.key })
    assert.equal(createNativeUsage({ store: target }).snapshot().items.length, 2)
    assert.deepEqual(await publishSimulationUsage(options), { imported: 0, existing: 2, retired: 0 })
    createNativeUsageMaintenance({ store: target }).clearLedger()
    assert.deepEqual(await publishSimulationUsage(options), { imported: 0, existing: 0, retired: 2 })
    assert.equal(target.list(NATIVE_USAGE_TURNS_NAMESPACE).length, 0)
  })
})

test('bounded long plugin owners remain readable and distinct without losing original attribution', async () => {
  await fixture(`qq-${'R'.repeat(80)}`, async ({ options, modelStore, target }) => {
    const first = `plugin:${'a'.repeat(153)}`, second = `plugin:${'a'.repeat(152)}b`
    append(modelStore, first); append(modelStore, second)
    assert.deepEqual(await publishSimulationUsage(options), { imported: 2, existing: 0, retired: 0 })
    const usage = createNativeUsage({ store: target }).snapshot().items
    assert.equal(usage.length, 2)
    assert.equal(new Set(usage.map(row => row.conversationId)).size, 2)
    assert(usage.every(row => row.conversationId.length <= 160 && row.conversationId.startsWith(`simulation:${options.runId}:`)))
    const originalIds = target.list(NATIVE_USAGE_TURNS_NAMESPACE).map(row =>
      (row.value as { simulation: { originalConversationId: string } }).simulation.originalConversationId)
    assert.deepEqual(new Set(originalIds), new Set([first, second]))
    assert.deepEqual(await publishSimulationUsage(options), { imported: 0, existing: 2, retired: 0 })
  })
})

test('invalid and already published sources cannot partially import a mixed ledger', async () => {
  for (const invalid of ['arbitrary-source', 'plugin:', 'plugin:helper name', 'plugin:../helper', 'plugin:helper?query',
    'simulation:qq-Other:plugin:helper']) {
    await fixture('qq-InvalidSource', async ({ options, modelStore, target }) => {
      append(modelStore, 'private:123'); append(modelStore, invalid)
      await assert.rejects(publishSimulationUsage(options), { code: 'SIMULATION_USAGE_SOURCE_INVALID' })
      assert.equal(target.list(NATIVE_USAGE_TURNS_NAMESPACE).length, 0)
    })
  }
  await fixture('qq-ForeignMarker', async ({ options, modelStore, target }) => {
    append(modelStore, 'plugin:generic-helper')
    const row = modelStore.list(NATIVE_USAGE_TURNS_NAMESPACE)[0]!
    modelStore.write(NATIVE_USAGE_TURNS_NAMESPACE, row.key, { ...object(row.value),
      simulation: { runId: 'qq-Other', originalConversationId: 'private:123', sourceRecord: 'foreign-source' } }, { expectedRevision: row.revision })
    await assert.rejects(publishSimulationUsage(options), { code: 'SIMULATION_USAGE_SOURCE_INVALID' })
    assert.equal(target.list(NATIVE_USAGE_TURNS_NAMESPACE).length, 0)
  })
})

test('plugin usage cannot cross configuration sources or bypass published fingerprint conflicts', async () => {
  await fixture('qq-PluginConflict', async ({ options, modelStore, target }) => {
    append(modelStore, 'plugin:vendor.helper/name:v1')
    await writeFile(join(options.simulationDirectory, 'simulation.json'), JSON.stringify({ schema: 1, sourceDirectory: join(options.sourceDirectory, 'other') }))
    await assert.rejects(publishSimulationUsage(options), { code: 'SIMULATION_USAGE_SOURCE_MISMATCH' })
    assert.equal(target.list(NATIVE_USAGE_TURNS_NAMESPACE).length, 0)
    await writeFile(join(options.simulationDirectory, 'simulation.json'), JSON.stringify({ schema: 1, sourceDirectory: options.sourceDirectory }))
    assert.deepEqual(await publishSimulationUsage(options), { imported: 1, existing: 0, retired: 0 })
    const row = target.list(NATIVE_USAGE_TURNS_NAMESPACE)[0]!
    target.write(NATIVE_USAGE_TURNS_NAMESPACE, row.key, { ...object(row.value), fingerprint: 'changed-fingerprint' }, { expectedRevision: row.revision })
    await assert.rejects(publishSimulationUsage(options), { code: 'SIMULATION_USAGE_CONFLICT' })
  })
})
