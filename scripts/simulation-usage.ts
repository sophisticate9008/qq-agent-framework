import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { validSimulationRunId } from '../src/contracts/admin-activity.ts'
import { assert, isRecord } from '../src/core/values.ts'
import { digest, json, object } from '../src/host/data.ts'
import { NATIVE_USAGE_ARCHIVE_NAMESPACE, NATIVE_USAGE_RETIRED_NAMESPACE, NATIVE_USAGE_TURNS_NAMESPACE,
  readNativeUsageStoredTurn } from '../src/host/native-usage.ts'
import { openReadonlySqliteStore } from '../src/storage/sqlite-readonly.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import type { StoredRecord } from '../src/host/types.ts'

async function ordinary(path: string, directory = false): Promise<void> {
  const info = await lstat(path)
  assert(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()),
    'SIMULATION_USAGE_SOURCE_INVALID', 'Simulation usage requires ordinary local files.')
}

/** Publish observed model charges, preserving their original price and time. Never submit model/QQ work. */
export async function publishSimulationUsage(options: {
  sourceDirectory: string; simulationDirectory: string; runId: string
}): Promise<{ imported: number; existing: number; retired: number }> {
  const sourceDirectory = resolve(options.sourceDirectory)
  const simulationDirectory = resolve(options.simulationDirectory)
  assert(validSimulationRunId(options.runId) && basename(simulationDirectory) === options.runId
    && simulationDirectory !== sourceDirectory, 'SIMULATION_USAGE_SOURCE_INVALID', 'Invalid simulation identity.')
  await ordinary(sourceDirectory, true)
  await ordinary(simulationDirectory, true)
  const manifest = await open(join(simulationDirectory, 'simulation.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
  let metadata: unknown
  try {
    const info = await manifest.stat()
    assert(info.isFile() && info.size <= 65536, 'SIMULATION_USAGE_SOURCE_INVALID', 'Invalid simulation manifest.')
    metadata = JSON.parse(await manifest.readFile('utf8')) as unknown
  } finally { await manifest.close() }
  assert(isRecord(metadata) && metadata.schema === 1 && metadata.sourceDirectory === sourceDirectory,
    'SIMULATION_USAGE_SOURCE_MISMATCH', 'The simulation belongs to another configuration directory.')
  const sourceFilename = join(simulationDirectory, 'native/native-chat.sqlite')
  const destinationFilename = join(sourceDirectory, 'native-chat.sqlite')
  await ordinary(join(simulationDirectory, 'native'), true)
  await ordinary(sourceFilename)
  await ordinary(destinationFilename)
  const reader = openReadonlySqliteStore(sourceFilename)
  let rows: readonly StoredRecord[]
  try {
    rows = reader.withSnapshot(() => {
      const collected: StoredRecord[] = []
      let after: string | undefined
      for (let page = 0; page < 40; page++) {
        const batch = reader.list(NATIVE_USAGE_TURNS_NAMESPACE, { limit: 256, ...(after ? { after } : {}) })
        collected.push(...batch)
        if (batch.length < 256) return collected
        after = batch.at(-1)!.key
      }
      assert(reader.list(NATIVE_USAGE_TURNS_NAMESPACE, { limit: 1, after }).length === 0,
        'SIMULATION_USAGE_LIMIT', 'The simulation ledger exceeds the publication bound.')
      return collected
    })
  } finally { reader.close() }
  if (!rows.length) return { imported: 0, existing: 0, retired: 0 }
  const destination = createSqliteStore({ filename: destinationFilename, requireExisting: true })
  const counts = { imported: 0, existing: 0, retired: 0 }
  try {
    assert(destination.read('native-chat.meta', 'session-definition'), 'SIMULATION_USAGE_TARGET_INVALID',
      'An initialized framework ledger is required.')
    for (const record of rows) {
      const observed = readNativeUsageStoredTurn(record)
      assert(/^(group|private):[^:]+$/.test(observed.conversationId), 'SIMULATION_USAGE_SOURCE_INVALID',
        'Only original simulated conversation records may be published.')
      const original = object(record.value)
      const turn = { ...object(original.turn), conversationId: `simulation:${options.runId}:${observed.conversationId}` }
      const key = digest([turn.conversationId, observed.sessionId, observed.generation, observed.turnId, observed.stepId])
      const fingerprint = digest(turn)
      const prior = destination.read(NATIVE_USAGE_TURNS_NAMESPACE, key) ?? destination.read(NATIVE_USAGE_ARCHIVE_NAMESPACE, key)
      const retired = destination.read(NATIVE_USAGE_RETIRED_NAMESPACE, key)
      if (prior || retired) {
        assert(object((prior ?? retired)!.value).fingerprint === fingerprint, 'SIMULATION_USAGE_CONFLICT',
          'Previously published usage has changed.')
        counts[retired ? 'retired' : 'existing']++
        continue
      }
      const value = json({ ...original, turn, fingerprint,
        simulation: { runId: options.runId, originalConversationId: observed.conversationId, sourceRecord: record.key } })
      // Share the native ledger's reset tombstones and CAS boundary: cleared records never reappear.
      destination.compareAndSetBatch!([
        { kind: 'check', namespace: NATIVE_USAGE_ARCHIVE_NAMESPACE, key, expectedRevision: null },
        { kind: 'check', namespace: NATIVE_USAGE_RETIRED_NAMESPACE, key, expectedRevision: null },
        { kind: 'write', namespace: NATIVE_USAGE_TURNS_NAMESPACE, key, expectedRevision: null, value }
      ])
      counts.imported++
    }
  } finally { destination.close() }
  return counts
}
