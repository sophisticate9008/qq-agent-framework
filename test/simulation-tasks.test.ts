import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createSimulationSessionManagement } from '../src/host/simulation-sessions.ts'

test('simulation task history survives definition deletion, paginates tied timestamps and isolates account paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'simulation-tasks-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sourceDirectory = join(directory, 'account'), root = join(directory, 'simulations'), runId = 'qq-task-test'
  const nativeDirectory = join(root, runId, 'native')
  await mkdir(sourceDirectory, { mode: 0o700 })
  await mkdir(nativeDirectory, { recursive: true, mode: 0o700 })
  await writeFile(join(sourceDirectory, 'simulation-activity-index.json'), JSON.stringify({ schema: 1, sourceDirectory, root, latestRunId: runId }), { mode: 0o600 })
  const manifestPath = join(root, runId, 'simulation.json')
  const manifest = { schema: 1, sourceDirectory, nativeDirectory, protocolMode: 'local-capture', productionBootstrapMounted: false }
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
  const store = createSqliteStore({ filename: join(nativeDirectory, 'native-chat.sqlite') })
  for (let n = 1; n <= 25; n++) {
    const id = n.toString(16).padStart(64, '0')
    store.write('conversation-tasks.runs', id, { schema: 1, id, taskId: 'a'.repeat(64), title: '临时验证',
      conversationId: 'private:123', state: 'completed', startedAt: 1000, finishedAt: 1200 })
  }
  store.close()
  const service = createSimulationSessionManagement({ sourceDirectory }), signal = AbortSignal.timeout(5000)
  const first = await service.tasks(runId, signal)
  assert.equal(first.tasks.items.length, 0); assert.equal(first.runs.length, 20)
  assert(first.runs.every(run => run.taskDeleted && run.title === '临时验证'))
  assert(first.nextRun)
  const second = await service.tasks(runId, signal, undefined, first.nextRun)
  assert.equal(second.runs.length, 5); assert.equal(second.nextRun, null)
  assert.equal(new Set([...first.runs, ...second.runs].map(run => run.id)).size, 25)
  await assert.rejects(service.tasks('../account', signal))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, sourceDirectory: join(directory, 'foreign') }))
  await assert.rejects(service.tasks(runId, signal))
  await writeFile(manifestPath, JSON.stringify(manifest))
  await symlink(join(root, runId), join(root, 'qq-linked'))
  await assert.rejects(service.tasks('qq-linked', signal))
})
