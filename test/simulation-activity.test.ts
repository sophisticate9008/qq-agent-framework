import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readAdminActivity, readSimulationActivity } from '../src/admin/simulation-activity.ts'
import { parseAdminActivitySnapshot } from '../src/contracts/admin-activity.ts'
import { createNativeActivity } from '../src/host/native-activity.ts'

test('simulation activity follows the account fixed pointer independently of cwd, isolates accounts and preserves local receipt evidence', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'simulation-activity-pointer-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const sourceDirectory = join(directory, 'account-a')
  const otherAccount = join(directory, 'account-b')
  const root = join(directory, 'private-simulations')
  const runId = 'qq-fixture-run'
  const runDirectory = join(root, runId)
  await Promise.all([sourceDirectory, otherAccount, runDirectory].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const now = Date.now()
  const activity = createNativeActivity({ now: () => now })
  activity.record('received', 'private:123', '模拟输入')
  activity.record('send_confirmed', 'private:123', '模拟回复')
  activity.record('send_unknown', 'private:123')
  activity.record('send_rejected', 'private:123')
  const saved = activity.read('stopped')
  await writeFile(join(runDirectory, 'activity.json'), JSON.stringify({ schema: 1, source: 'simulation', simulation: true,
    runId, sourceDirectory, updatedAt: now, activity: saved }), { mode: 0o600 })
  const pointer = JSON.stringify({ schema: 1, root, latestRunId: runId, sourceDirectory, updatedAt: now })
  await Promise.all([sourceDirectory, otherAccount].map(path => writeFile(join(path, 'simulation-activity-index.json'), pointer, { mode: 0o600 })))
  // No root/index.json is created: the account pointer is the only registration.
  const simulation = await readSimulationActivity(AbortSignal.timeout(2000), undefined, now, sourceDirectory)
  assert.equal(simulation.status.state, 'available')
  assert.equal(simulation.status.runId, runId)
  assert.equal(simulation.items.length, saved.items.length)
  assert.deepEqual(simulation.items.map(item => item.nativeSummary), saved.items.map(item => item.summary))
  assert.deepEqual(simulation.items.map(item => item.at), saved.items.map(item => item.at))
  assert(simulation.items.every(item => item.origin === 'simulation' && item.simulationRunId === runId))
  const confirmed = simulation.items.find(item => item.nativeSummary === '协议已确认发送回复。')!
  assert.equal(confirmed.content, '模拟回复')
  assert.match(confirmed.summary, /本地捕获.*未向真实 QQ 发送/)
  for (const summary of ['回复发送结果未确认，未自动重复发送。', '协议未接受回复发送。']) {
    const item = simulation.items.find(entry => entry.nativeSummary === summary)!
    assert.equal(item.summary, summary)
    assert.equal(item.level, 'warning')
    assert.equal(item.content, null)
  }
  const foreign = await readSimulationActivity(AbortSignal.timeout(2000), undefined, now, otherAccount)
  assert.equal(foreign.status.state, 'none')
  assert.deepEqual(foreign.items, [])

  const qq = createNativeActivity({ now: () => now + 1 })
  qq.record('send_confirmed', 'private:456', 'QQ 协议回执正文')
  const merged = await readAdminActivity(qq.read('running'), 'all', AbortSignal.timeout(2000), sourceDirectory)
  assert(parseAdminActivitySnapshot(merged))
  assert.equal(merged.items.length, 5)
  assert.equal(merged.items[0]!.origin, 'qq')
  assert.equal(merged.items[0]!.summary, '协议已确认发送回复。')
  assert(!JSON.stringify(merged).includes(directory))
  const qqOnly = await readAdminActivity(qq.read('running'), 'qq', AbortSignal.timeout(2000), sourceDirectory)
  assert.equal(qqOnly.items.length, 1)
  assert(qqOnly.items.every(item => item.origin === 'qq'))
  const simulationOnly = await readAdminActivity(qq.read('running'), 'simulation', AbortSignal.timeout(2000), sourceDirectory)
  assert.equal(simulationOnly.items.length, 4)
  assert(simulationOnly.items.every(item => item.origin === 'simulation'))
})

test('simulation activity does not follow unregistered runs, expired pointers or symbolic-link snapshots', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'simulation-activity-bounds-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const sourceDirectory = join(directory, 'account')
  const root = join(directory, 'simulations')
  const runId = 'qq-expired'
  const runDirectory = join(root, runId)
  await mkdir(sourceDirectory, { mode: 0o700 })
  await mkdir(runDirectory, { recursive: true, mode: 0o700 })
  const now = Date.now()
  const pointerFile = join(sourceDirectory, 'simulation-activity-index.json')
  const pointer = { schema: 1, root, latestRunId: runId, sourceDirectory, updatedAt: now }
  const read = () => readSimulationActivity(AbortSignal.timeout(2000), undefined, now, sourceDirectory)
  assert.equal((await read()).status.state, 'none')
  await writeFile(pointerFile, JSON.stringify({ ...pointer, updatedAt: now - 8 * 86400000 }), { mode: 0o600 })
  assert.equal((await read()).status.state, 'none')
  await writeFile(pointerFile, JSON.stringify({ ...pointer, latestRunId: '../outside' }))
  assert.equal((await read()).status.state, 'unavailable')
  await writeFile(pointerFile, JSON.stringify(pointer))
  const elsewhere = join(directory, 'elsewhere.json')
  await writeFile(elsewhere, '{}', { mode: 0o600 })
  await symlink(elsewhere, join(runDirectory, 'activity.json'))
  assert.equal((await read()).status.state, 'unavailable')
})

test('simulation activity merges registered parallel runs, bounds the result and skips a foreign or broken run', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'simulation-activity-parallel-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const sourceDirectory = join(directory, 'account')
  const root = join(directory, 'simulations')
  await mkdir(sourceDirectory, { mode: 0o700 })
  const now = Date.now()
  async function saveRun(runId: string, count: number, offset: number, account = sourceDirectory) {
    const runDirectory = join(root, runId)
    await mkdir(runDirectory, { recursive: true, mode: 0o700 })
    let at = now - offset
    const activity = createNativeActivity({ now: () => at++ })
    for (let index = 0; index < count; index++) activity.record('received', 'private:123', `${runId} message ${index}`)
    await writeFile(join(runDirectory, 'activity.json'), JSON.stringify({ schema: 1, source: 'simulation', simulation: true,
      runId, sourceDirectory: account, updatedAt: now, activity: activity.read('running') }), { mode: 0o600 })
  }
  await saveRun('qq-extended', 100, 1000)
  await saveRun('qq-work', 3, 100)
  await saveRun('qq-foreign', 1, 0, join(directory, 'other-account'))
  const pointerFile = join(sourceDirectory, 'simulation-activity-index.json')
  const pointer = { schema: 1, root, latestRunId: 'qq-work', sourceDirectory, updatedAt: now,
    runIds: ['qq-work', 'qq-extended', 'qq-foreign'] }
  await writeFile(pointerFile, JSON.stringify(pointer), { mode: 0o600 })
  const read = () => readSimulationActivity(AbortSignal.timeout(2000), undefined, now, sourceDirectory)
  const merged = await read()
  assert.equal(merged.status.state, 'available')
  assert.equal(merged.status.runId, 'qq-work')
  assert.equal(merged.items.length, 100)
  assert.deepEqual(new Set(merged.items.map(item => item.simulationRunId)), new Set(['qq-work', 'qq-extended']))
  assert.equal(merged.items.filter(item => item.simulationRunId === 'qq-work').length, 3)
  assert.equal(merged.items.filter(item => item.simulationRunId === 'qq-extended').length, 97)
  assert.equal(new Set(merged.items.map(item => item.id)).size, 100)
  assert(merged.items.every((item, index) => index === 0 || item.at <= merged.items[index - 1]!.at))
  await writeFile(join(root, 'qq-work', 'activity.json'), 'invalid JSON')
  const remaining = await read()
  assert.equal(remaining.status.state, 'available')
  assert.equal(remaining.items.length, 100)
  assert(remaining.items.every(item => item.simulationRunId === 'qq-extended'))
  await writeFile(pointerFile, JSON.stringify({ ...pointer, runIds: [...pointer.runIds, 'qq-four', 'qq-five'] }))
  assert.equal((await read()).status.state, 'unavailable')
})
