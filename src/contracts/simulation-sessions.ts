import { isRecord, reference } from '../core/values.ts'
import { validSimulationRunId } from './admin-activity.ts'

export interface SimulationSession {
  readonly runId: string
  readonly key: string
  readonly originalConversationId: string
  readonly ledgerConversationId: string
  readonly sessionId: string | null
  readonly generation: number
  readonly bindingRevision: string | null
  readonly state: 'creating' | 'ready' | 'unknown' | 'retired'
  readonly updatedAt: number
  readonly origin: 'simulation'
  readonly runtimeState: 'stopped' | 'busy'
  readonly resetAvailable: boolean
  readonly resetUnavailableReason: string | null
}

export interface SimulationSessionSnapshot {
  readonly schema: 1
  readonly sessions: readonly SimulationSession[]
  readonly limited: boolean
  readonly unavailableRuns: number
}

export interface SimulationSessionResetRequest {
  readonly runId: string
  readonly key: string
  readonly sessionId: string
  readonly generation: number
  readonly bindingRevision: string
  readonly confirm: true
}

export interface SimulationSessionResetResult {
  readonly schema: 1
  readonly runId: string
  readonly key: string
  readonly previousSessionId: string
  readonly previousGeneration: number
  readonly nextGeneration: number
  readonly bridgeBindingRemoved: true
  readonly historyPreserved: true
  readonly contextReset: true
  readonly ok: true
}

function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }

export function parseSimulationSessionResetRequest(input: unknown): SimulationSessionResetRequest | null {
  if (!isRecord(input) || Object.keys(input).length !== 6 || !validSimulationRunId(input.runId)
    || !reference(input.key) || !reference(input.sessionId) || !positive(input.generation)
    || !hash(input.bindingRevision) || input.confirm !== true) return null
  return { runId: input.runId, key: input.key, sessionId: input.sessionId, generation: input.generation,
    bindingRevision: input.bindingRevision, confirm: true }
}

export function parseSimulationSessionSnapshot(input: unknown): SimulationSessionSnapshot | null {
  if (!isRecord(input) || input.schema !== 1 || !Array.isArray(input.sessions) || input.sessions.length > 4096
    || typeof input.limited !== 'boolean' || typeof input.unavailableRuns !== 'number'
    || !Number.isSafeInteger(input.unavailableRuns) || input.unavailableRuns < 0 || input.unavailableRuns > 2048) return null
  const sessions: SimulationSession[] = []
  const ids = new Set<string>()
  for (const row of input.sessions) {
    if (!isRecord(row) || !validSimulationRunId(row.runId) || !reference(row.key) || row.originalConversationId !== row.key
      || row.ledgerConversationId !== `simulation:${row.runId}:${row.key}` || !positive(row.generation)
      || !(row.sessionId === null || reference(row.sessionId)) || !(row.bindingRevision === null || hash(row.bindingRevision))
      || !['creating', 'ready', 'unknown', 'retired'].includes(String(row.state)) || row.origin !== 'simulation'
      || !['stopped', 'busy'].includes(String(row.runtimeState)) || typeof row.resetAvailable !== 'boolean'
      || !(row.resetUnavailableReason === null || typeof row.resetUnavailableReason === 'string'
        && /^simulation_[a-z_]{1,80}$/.test(row.resetUnavailableReason))
      || typeof row.updatedAt !== 'number' || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0
      || row.resetAvailable && (row.state !== 'ready' || row.sessionId === null || row.bindingRevision === null
        || row.runtimeState !== 'stopped' || row.resetUnavailableReason !== null)) return null
    const id = JSON.stringify([row.runId, row.key])
    if (ids.has(id)) return null
    ids.add(id)
    sessions.push({ runId: row.runId, key: row.key, originalConversationId: row.key,
      ledgerConversationId: row.ledgerConversationId, sessionId: row.sessionId, generation: row.generation,
      bindingRevision: row.bindingRevision, state: row.state as SimulationSession['state'], updatedAt: row.updatedAt,
      origin: 'simulation', runtimeState: row.runtimeState as SimulationSession['runtimeState'],
      resetAvailable: row.resetAvailable, resetUnavailableReason: row.resetUnavailableReason })
  }
  return { schema: 1, sessions, limited: input.limited, unavailableRuns: input.unavailableRuns }
}

export function parseSimulationSessionResetResult(input: unknown): SimulationSessionResetResult | null {
  if (!isRecord(input) || input.schema !== 1 || !validSimulationRunId(input.runId) || !reference(input.key)
    || !reference(input.previousSessionId) || !positive(input.previousGeneration) || !positive(input.nextGeneration)
    || input.nextGeneration !== input.previousGeneration + 1 || input.bridgeBindingRemoved !== true
    || input.historyPreserved !== true || input.contextReset !== true || input.ok !== true) return null
  return { schema: 1, runId: input.runId, key: input.key, previousSessionId: input.previousSessionId,
    previousGeneration: input.previousGeneration, nextGeneration: input.nextGeneration,
    bridgeBindingRemoved: true, historyPreserved: true, contextReset: true, ok: true }
}
