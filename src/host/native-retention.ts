import { createSqliteStore, type SqliteStoreOptions } from '../storage/sqlite.ts'
import { isRecord } from '../core/values.ts'
import type { DurableCasMutation, StoredRecord } from './types.ts'
import { digest, json } from './data.ts'

export const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const ORDINARY_LIMIT = 10_000
const ordinary = new Set(['host.inbox', 'host.agent-events', 'host.executions', 'host.execution-receipts',
  'host.execution-turns', 'tasks', 'outbox', 'host.session-archives', 'native-usage.resets', 'native-chat.protocol-writes'])
export interface NativeRetentionStatus {
  readonly enabled: true; readonly retentionDays: 7; readonly lastRunAt: number | null;
  readonly removed: number; readonly totalRecords: number | null; readonly maxRecords: number | null;
  readonly state: 'pending' | 'healthy' | 'attention'; readonly reason: string | null;
}

/** One bounded page per timer turn; never invoked by receive(), send(), or model submission. */
export function createNativeDurableStore(options: SqliteStoreOptions) {
  const store = createSqliteStore(options)
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let cursor: { at: number; namespace: string; key: string } | undefined
  let cutoff = 0
  let pressureNamespaces = new Set<string>()
  let counts = new Map<string, number>()
  let total = 0
  let maximum = 100_000
  const workIndex = { namespace: 'native-work.executions', field: 'conversationId' } as const
  store.createIndex(workIndex)
  const protectedWork = new Map<string, boolean>()
  let status: NativeRetentionStatus = { enabled: true, retentionDays: 7, lastRunAt: null, removed: 0,
    totalRecords: null, maxRecords: null, state: 'pending', reason: null }
  const now = options.clock ?? Date.now

  function protectedConversation(conversation: unknown): boolean {
    if (typeof conversation !== 'string') return false
    if (store.read('host.execution-conversations', digest(conversation))) return true
    if (!protectedWork.has(conversation)) {
      const work = store.lookup({ ...workIndex, equals: conversation, limit: 1000 })
      protectedWork.set(conversation, work.length === 1000 || work.some(row => !isRecord(row.value)
        || !['completed', 'failed'].includes(String(row.value.status)) || ['delivering', 'unknown'].includes(String(row.value.delivery))))
    }
    if (protectedWork.get(conversation)) return true
    const inbox = store.read('native-chat.inbox', digest(conversation))?.value
    return isRecord(inbox) && Array.isArray(inbox.entries) && inbox.entries.length > 0
  }
  function mutations(row: StoredRecord, at: number): DurableCasMutation[] {
    if (!ordinary.has(row.namespace) || !isRecord(row.value)) return []
    const v = row.value
    const pressured = pressureNamespaces.has(row.namespace) && ((counts.get(row.namespace) ?? 0) > ORDINARY_LIMIT * 0.8 || total > maximum * 0.6)
    if (row.updatedAt > at - OPERATION_RETENTION_MS && !pressured) return []
    // Never recycle recent in-flight callbacks under capacity pressure.
    if (row.updatedAt > at - 60 * 60 * 1000) return []
    const conversation = isRecord(v.binding) ? v.binding.conversationId : v.conversationId ?? v.scope
    if (protectedConversation(conversation)) return []
    const extra: DurableCasMutation[] = []
    if (row.namespace === 'host.executions') {
      if (v.isolated !== false || !['completed', 'failed', 'rejected', 'timed-out'].includes(String(v.status))
        || !['completed', 'failed', 'rejected', 'cancelled', 'not-started'].includes(String(v.externalStatus))
        || ['requesting', 'accepted', 'unknown'].includes(String(v.cancelStatus)) || ['sending', 'unknown'].includes(String(v.noticeStatus))) return []
      if (isRecord(v.binding) && store.read('host.execution-sessions', digest(v.binding.sessionId))?.value) return []
    } else if (row.namespace === 'host.execution-receipts' || row.namespace === 'host.execution-turns') {
      if (typeof v.executionId !== 'string' || store.read('host.executions', v.executionId)) return []
    } else if (row.namespace === 'host.inbox') {
      if (!['accepted', 'rejected'].includes(String(v.status))) return []
      // Older inbound messages cannot be admitted again after their receipt has been collected.
      const floor = store.read('host.retention', 'inbound-floor')
      const prior = floor && isRecord(floor.value) && typeof floor.value.at === 'number' ? floor.value.at : 0
      if (row.updatedAt > prior) extra.push({ kind: 'write', namespace: 'host.retention', key: 'inbound-floor',
        expectedRevision: floor?.revision ?? null, value: { at: row.updatedAt } })
    } else if (row.namespace === 'tasks') {
      if (!['completed', 'failed', 'cancelled', 'expired'].includes(String(v.status))) return []
      if (store.read('tasks.pending', row.key)) return []
    } else if (row.namespace === 'outbox' || row.namespace === 'native-chat.protocol-writes') {
      if (!['confirmed', 'rejected'].includes(String(v.status))) return []
    } else if (row.namespace === 'host.agent-events') {
      if (!isRecord(v.payload) || !isRecord(v.payload.binding) || !isRecord(v.payload.event) || typeof v.deadlineAt !== 'number' || v.deadlineAt > at) return []
      const binding = v.payload.binding
      if (protectedConversation(binding.conversationId)) return []
      const id = `agent:${String(v.sequence).padStart(16, '0')}:${row.key}`
      const task = store.read('tasks', id)?.value
      if (isRecord(task) && !['completed', 'failed', 'cancelled', 'expired'].includes(String(task.status))) return []
      const match = typeof v.payload.event.id === 'string' ? /^(.*):seq:(\d+)$/.exec(v.payload.event.id) : null
      const current = typeof binding.conversationId === 'string' ? store.read('host.sessions', binding.conversationId)?.value : null
      if (isRecord(current) && current.sessionId === binding.sessionId && current.generation === binding.generation) {
        if (!match) return [] // Arbitrary plugin event IDs have no ordered replay boundary.
        const key = digest([binding.sessionId, binding.generation, match[1]])
        const floor = store.read('host.agent-event-floors', key)
        const sequence = Number(match[2])
        if (!Number.isSafeInteger(sequence)) return []
        if (!floor || !isRecord(floor.value) || Number(floor.value.sequence) < sequence) extra.push({ kind: 'write',
          namespace: 'host.agent-event-floors', key, expectedRevision: floor?.revision ?? null,
          value: json({ sequence, sessionId: binding.sessionId, generation: binding.generation }) })
      }
    } else if (row.namespace === 'native-usage.resets' && v.state !== 'completed') return []
    return [...extra, { kind: 'delete', namespace: row.namespace, key: row.key, expectedRevision: row.revision }]
  }
  function schedule(ms: number) { if (!closed) { timer = setTimeout(tick, ms); timer.unref() } }
  function tick(): void {
    if (closed) return
    const at = now()
    let continuation = false
    try {
      protectedWork.clear()
      let removed = store.purgeExpired(100)
      if (!cursor) {
        const stats = store.stats({ limit: 1000 })
        total = stats.totalRecords; maximum = stats.maxRecords
        counts = new Map(stats.namespaces.map(item => [item.namespace, item.totalRecords]))
        pressureNamespaces = new Set(stats.namespaces.filter(item => ordinary.has(item.namespace)
          && (item.totalRecords > ORDINARY_LIMIT || stats.totalRecords >= stats.maxRecords * 0.7)).map(item => item.namespace))
        cutoff = pressureNamespaces.size ? at - 60 * 60 * 1000 : at - OPERATION_RETENTION_MS
        status = { ...status, totalRecords: stats.totalRecords, maxRecords: stats.maxRecords,
          state: stats.totalRecords >= stats.maxRecords * 0.85 ? 'attention' : 'healthy',
          reason: stats.totalRecords >= stats.maxRecords * 0.85 ? 'protected_or_ledger_capacity' : null }
      }
      const page = store.maintenancePage(cutoff, cursor)
      const started = performance.now()
      for (const row of page) {
        const changes = mutations(row, at)
        if (changes.length) { store.compareAndSetBatch!(changes); removed++; total--; counts.set(row.namespace, (counts.get(row.namespace) ?? 1) - 1) }
        cursor = { at: row.updatedAt, namespace: row.namespace, key: row.key }
        if (performance.now() - started >= 8) { continuation = true; break }
      }
      continuation ||= page.length === 100 || removed >= 100
      if (!continuation) cursor = undefined
      status = { ...status, lastRunAt: at, removed: status.removed + removed }
    } catch {
      cursor = undefined
      status = { ...status, state: 'attention', reason: 'maintenance_failed' }
    }
    schedule(continuation ? 250 : 15 * 60 * 1000)
  }
  schedule(1000)
  return { ...store, retentionStatus: () => ({ ...status }), close() { closed = true; clearTimeout(timer); store.close() } }
}
