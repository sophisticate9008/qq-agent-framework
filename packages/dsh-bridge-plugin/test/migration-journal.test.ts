import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMigrationJournal, migrationDigest } from '../dist/migration-journal.js'
import type { ForkWithPresetRequest } from '../dist/migration-protocol.js'

test('durable migration retains original complete request across restart and never retries unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qbf-migration-journal-'))
  const directory = join(root, 'journal')
  let creates = 0
  let uncertain = false
  const prepare = async () => ({ sourceCursor: 4, sourceDigest: 'a'.repeat(64), targetRevision: 'b'.repeat(64),
    async create() { creates++; if (uncertain) throw new Error('migration_child_verification_failed') } })
  const signal = new AbortController().signal
  const refs = { migrationId: 'first', sourceSessionId: 'source', expectedPreset: 'old', targetPreset: 'new' }
  try {
    const first = createMigrationJournal({ directory, issuerEpoch: 'epoch-a', prepare })
    const preview = await first.preview(refs, signal)
    assert.equal(preview.state, 'available')
    assert.deepEqual(await readdir(root), [])
    const request: ForkWithPresetRequest = { ...refs, issuerEpoch: 'epoch-a', expectedCursor: 4,
      expectedSourceDigest: 'a'.repeat(64), expectedTargetRevision: 'b'.repeat(64) }
    assert.equal((await first.commit(request, signal)).state, 'completed')
    assert.equal((await first.commit(request, signal)).idempotency, 'replayed')
    assert.equal(creates, 1)
    const stored = JSON.parse(await readFile(join(directory, `${migrationDigest(refs.migrationId)}.json`), 'utf8')) as { request: unknown }
    assert.deepEqual(stored.request, request)
    const restarted = createMigrationJournal({ directory, issuerEpoch: 'epoch-b', prepare })
    const recovered = await restarted.inspect(request)
    assert.equal(recovered.state, 'completed')
    assert.equal(recovered.issuerEpoch, 'epoch-a')
    assert.equal((await restarted.commit(request, signal)).state, 'rejected')
    assert.equal((await restarted.inspect({ ...request, issuerEpoch: 'epoch-b' })).state, 'rejected')
    uncertain = true
    const unknownRequest = { ...request, migrationId: 'uncertain' }
    assert.equal((await first.commit(unknownRequest, signal)).state, 'unknown')
    assert.equal(creates, 2)
    const recoveredUnknown = await restarted.inspect(unknownRequest)
    assert.equal(recoveredUnknown.state, 'unknown')
    assert.equal(recoveredUnknown.issuerEpoch, 'epoch-a')
    assert.equal((await first.commit(unknownRequest, signal)).state, 'unknown')
    assert.equal(creates, 2)
    assert.equal((await restarted.inspect({ ...request, migrationId: 'absent' })).state, 'not-found')
    assert.equal(creates, 2)
    assert.equal((await first.commit({ ...request, migrationId: 'drift', expectedCursor: 5 }, signal)).state, 'rejected')
    assert.equal(creates, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
