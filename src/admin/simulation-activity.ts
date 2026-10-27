import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseAdminActivitySnapshot, validSimulationRunId, type AdminActivitySnapshot, type SimulationActivityStatus } from '../contracts/admin-activity.ts'
import { redactNativeText } from '../host/native-redacted-text.ts'

const WEEK = 7 * 24 * 60 * 60 * 1000
const empty = (state: SimulationActivityStatus['state']) => ({ items: [] as AdminActivitySnapshot['items'], status: { state, runId: null, updatedAt: null } as SimulationActivityStatus })
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_simulation_activity')
  return value as Record<string, unknown>
}
async function readJson(filename: string, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const information = await file.stat()
    if (!information.isFile() || information.size > maxBytes) throw new Error('invalid_simulation_activity_file')
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxBytes) throw new Error('simulation_activity_too_large')
    signal.throwIfAborted()
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown
  } finally { await file.close() }
}
async function directory(pathname: string): Promise<void> {
  const information = await lstat(pathname)
  if (!information.isDirectory() || information.isSymbolicLink()) throw new Error('invalid_simulation_activity_directory')
}
/** One small index and at most four registered snapshots; never enumerate directories. */
export async function readSimulationActivity(signal: AbortSignal, root?: string, now = Date.now(), sourceDirectory?: string) {
  try {
    if (root === undefined && sourceDirectory === undefined) return empty('none')
    const indexDirectory = root ?? sourceDirectory!
    await directory(indexDirectory)
    const index = record(await readJson(join(indexDirectory, root === undefined ? 'simulation-activity-index.json' : 'index.json'), 4096, signal))
    if (index.schema !== 1 || !validSimulationRunId(index.latestRunId) || typeof index.updatedAt !== 'number'
      || !Number.isSafeInteger(index.updatedAt) || index.updatedAt > now + 60000) return empty('unavailable')
    if (index.runIds !== undefined && (!Array.isArray(index.runIds) || index.runIds.length > 4
      || !index.runIds.every(validSimulationRunId))) return empty('unavailable')
    const registered = index.runIds === undefined ? [] : index.runIds as string[]
    const runIds = [...new Set([index.latestRunId, ...registered])].slice(0, 4)
    if (sourceDirectory !== undefined && (typeof index.sourceDirectory !== 'string' || !isAbsolute(index.sourceDirectory)
      || resolve(index.sourceDirectory) !== resolve(sourceDirectory))) return empty('none')
    if (index.updatedAt < now - WEEK) return empty('none')
    const simulationRoot = root ?? (typeof index.root === 'string' && isAbsolute(index.root) ? resolve(index.root) : null)
    if (!simulationRoot) return empty('unavailable')
    await directory(simulationRoot)
    const items: AdminActivitySnapshot['items'][number][] = []
    let updatedAt: number | null = null
    let invalid = false
    for (const runId of runIds) {
      try {
        const runDirectory = join(simulationRoot, runId)
        await directory(runDirectory)
        const saved = record(await readJson(join(runDirectory, 'activity.json'), 1048576, signal))
        if (sourceDirectory !== undefined && saved.sourceDirectory !== index.sourceDirectory) continue
        if (saved.schema !== 1 || saved.source !== 'simulation' || saved.simulation !== true || saved.runId !== runId
          || typeof saved.updatedAt !== 'number' || !Number.isSafeInteger(saved.updatedAt) || saved.updatedAt > now + 60000) {
          invalid = true; continue
        }
        if (saved.updatedAt < now - WEEK) continue
        const activity = parseAdminActivitySnapshot(saved.activity)
        if (!activity) { invalid = true; continue }
        updatedAt = Math.max(updatedAt ?? 0, saved.updatedAt)
        items.push(...activity.items.filter(item => item.at >= now - WEEK && item.at <= now + 60000).map(item => ({ ...item,
          id: `simulation:${runId}:${createHash('sha256').update(item.id).digest('hex').slice(0, 20)}`, origin: 'simulation' as const, simulationRunId: runId,
          nativeSummary: redactNativeText(item.summary) ?? '活动记录',
          summary: item.type === 'sent' && item.summary === '协议已确认发送回复。'
            ? '模拟协议已在本地捕获回复；未向真实 QQ 发送。'
            : redactNativeText(item.summary) ?? '活动记录',
          content: redactNativeText(item.content ?? undefined) })))
      } catch (error) {
        signal.throwIfAborted()
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) invalid = true
      }
    }
    if (updatedAt === null) return empty(invalid ? 'unavailable' : 'none')
    return { items: items.sort((left, right) => right.at - left.at).slice(0, 100),
      status: { state: 'available' as const, runId: index.latestRunId, updatedAt } }
  } catch (error) {
    signal.throwIfAborted()
    return empty(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? 'none' : 'unavailable')
  }
}
export async function readAdminActivity(native: AdminActivitySnapshot, source: 'all' | 'qq' | 'simulation', signal: AbortSignal, sourceDirectory?: string): Promise<AdminActivitySnapshot> {
  const simulation = source === 'qq' ? empty('none') : await readSimulationActivity(signal, undefined, undefined, sourceDirectory)
  const qq = native.items.map(item => ({ ...item, origin: 'qq' as const }))
  return { ...native, items: [...(source === 'simulation' ? [] : qq), ...simulation.items]
    .sort((left, right) => right.at - left.at).slice(0, 100), simulation: simulation.status }
}
