import { createNativeApplicationStorage } from '../storage/native-application.ts'
import { createNativeDshRestartStorage } from '../storage/native-dsh-restart.ts'
import { digest } from './data.ts'
import { OPERATION_RETENTION_MS } from './native-retention.ts'

/** Compact only confirmed, old operation details. Small identity guards prevent destructive replay. */
export function startNativeOperationRetention(directory: string, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let fault: string | null = null
  async function tick() {
    if (signal.aborted) return
    const cutoff = Date.now() - OPERATION_RETENTION_MS
    try {
      const applications = createNativeApplicationStorage(directory)
      const application = await applications.read()
      // The latest application is also the saved running-configuration checkpoint.
      const last = application.value.records.at(-1)?.snapshot.id
      const retired = application.value.retired ?? []
      const retiring = application.value.records.filter(row => row.snapshot.id !== last
        && row.snapshot.state === 'completed' && row.snapshot.updatedAt < cutoff).slice(0, 8192 - retired.length)
      if (retiring.length && !signal.aborted) {
        const ids = new Set(retiring.map(row => row.snapshot.id))
        await applications.write(application.revision, { ...application.value,
          records: application.value.records.filter(row => !ids.has(row.snapshot.id)), retired: [...retired, ...ids] })
      }
      const restarts = createNativeDshRestartStorage(directory)
      const restart = await restarts.read()
      const latest = restart.value.records.at(-1)?.operation.id
      const tombstones = restart.value.retired ?? []
      const old = restart.value.records.filter(row => row.operation.id !== latest
        && row.operation.state === 'completed' && row.operation.updatedAt < cutoff).slice(0, 8192 - tombstones.length)
      if (old.length && !signal.aborted) {
        const ids = new Set(old.map(row => row.operation.id))
        await restarts.write(restart.revision, { ...restart.value, records: restart.value.records.filter(row => !ids.has(row.operation.id)),
          retired: [...tombstones, ...old.map(row => ({ id: row.operation.id, requestIdentity: digest(row.operation.revisions) }))] })
      }
      fault = null
    } catch { fault = 'operation_maintenance_failed' }
    if (!signal.aborted) { timer = setTimeout(() => void tick(), 15 * 60 * 1000); timer.unref() }
  }
  timer = setTimeout(() => void tick(), 5000); timer.unref()
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  return { status: () => fault }
}
