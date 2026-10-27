/** Read-only console projection; simulated protocol receipts never mean QQ delivery. */
export type AdminActivityState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
export type AdminActivityType = 'received' | 'processed' | 'sent' | 'timeout' | 'error' | 'runtime'
export interface AdminActivityEntry {
  readonly id: string
  readonly at: number
  readonly level: 'info' | 'warning' | 'error'
  readonly type: AdminActivityType
  readonly conversationId: string | null
  readonly summary: string
  readonly content?: string | null
  readonly count?: number
  readonly errorCode?: string | null
  readonly origin?: 'qq' | 'simulation'
  readonly simulationRunId?: string
  readonly nativeSummary?: string
}
export interface SimulationActivityStatus {
  readonly state: 'available' | 'none' | 'unavailable'
  readonly runId: string | null
  readonly updatedAt: number | null
}
export interface AdminActivitySnapshot {
  readonly source: 'native-chat'
  readonly retention: 'process'
  readonly capacity: 100
  readonly state: AdminActivityState
  readonly items: readonly AdminActivityEntry[]
  readonly simulation?: SimulationActivityStatus
}
export function validSimulationRunId(value: unknown): value is string {
  return typeof value === 'string' && /^qq-[A-Za-z0-9_-]{1,80}$/.test(value)
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
}
export function parseAdminActivitySnapshot(value: unknown): AdminActivitySnapshot | null {
  const root = object(value)
  if (root.source !== 'native-chat' || root.retention !== 'process' || root.capacity !== 100
    || typeof root.state !== 'string' || !['stopped', 'starting', 'running', 'stopping', 'error'].includes(root.state)
    || !Array.isArray(root.items) || root.items.length > 100) return null
  const ids = new Set<string>()
  const items: AdminActivityEntry[] = []
  for (const raw of root.items) {
    const entry = object(raw)
    if (typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 256 || ids.has(entry.id)
      || !timestamp(entry.at) || !['info', 'warning', 'error'].includes(String(entry.level))
      || !['received', 'processed', 'sent', 'timeout', 'error', 'runtime'].includes(String(entry.type))
      || entry.conversationId !== null && (typeof entry.conversationId !== 'string' || !entry.conversationId.trim() || entry.conversationId.length > 256)
      || typeof entry.summary !== 'string' || !entry.summary.trim() || entry.summary.length > 2048
      || entry.content !== undefined && entry.content !== null && (typeof entry.content !== 'string' || entry.content.length > 2000)
      || entry.origin !== undefined && entry.origin !== 'qq' && entry.origin !== 'simulation'
      || entry.simulationRunId !== undefined && !validSimulationRunId(entry.simulationRunId)
      || entry.nativeSummary !== undefined && (typeof entry.nativeSummary !== 'string' || entry.nativeSummary.length > 2048)
      || entry.origin === 'simulation' && !validSimulationRunId(entry.simulationRunId)) return null
    ids.add(entry.id)
    items.push({ id: entry.id, at: entry.at, level: entry.level as AdminActivityEntry['level'], type: entry.type as AdminActivityType,
      conversationId: entry.conversationId as string | null, summary: entry.summary,
      count: typeof entry.count === 'number' && Number.isSafeInteger(entry.count) && entry.count > 0 ? entry.count : 1,
      errorCode: typeof entry.errorCode === 'string' && /^[A-Z][A-Z_]{1,63}$/.test(entry.errorCode) ? entry.errorCode : null,
      content: (entry.type === 'received' || entry.type === 'sent') && typeof entry.content === 'string' ? entry.content : null,
      ...(entry.origin === undefined ? {} : { origin: entry.origin }),
      ...(entry.simulationRunId === undefined ? {} : { simulationRunId: entry.simulationRunId as string }),
      ...(entry.nativeSummary === undefined ? {} : { nativeSummary: entry.nativeSummary as string }) })
  }
  let simulation: SimulationActivityStatus | undefined
  if (root.simulation !== undefined) {
    const status = object(root.simulation)
    if (!['available', 'none', 'unavailable'].includes(String(status.state))
      || status.runId !== null && !validSimulationRunId(status.runId)
      || status.updatedAt !== null && !timestamp(status.updatedAt)) return null
    simulation = { state: status.state as SimulationActivityStatus['state'], runId: status.runId as string | null, updatedAt: status.updatedAt as number | null }
  }
  return { source: 'native-chat', retention: 'process', capacity: 100, state: root.state as AdminActivityState, items,
    ...(simulation === undefined ? {} : { simulation }) }
}
