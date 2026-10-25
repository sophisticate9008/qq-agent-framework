import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import { validIdentifier } from './receipts.js'
import { migrationDigest } from './migration-journal.js'
import { DSH_EXECUTION_EVIDENCE_PROTOCOL, type DshExecutionEvidence, type DshExecutionEvidenceRequest } from './execution-evidence-protocol.js'

/** Positive evidence only: a missing request never proves that an uncertain submission did not execute. */
export async function inspectSdkExecution(ctx: Context, request: DshExecutionEvidenceRequest, issuerEpoch: string, signal: AbortSignal): Promise<DshExecutionEvidence> {
  if (!request || Object.keys(request).some(key => !['sessionId', 'requestId', 'userMessageId', 'turn'].includes(key))
    || !validIdentifier(request.sessionId) || !validIdentifier(request.requestId)
    || request.userMessageId !== undefined && !validIdentifier(request.userMessageId)
    || request.turn !== undefined && (!Number.isSafeInteger(request.turn) || request.turn < 1)) throw new TypeError('Invalid execution evidence address')
  const base: DshExecutionEvidence = { ...request, schema: 1, protocol: DSH_EXECUTION_EVIDENCE_PROTOCOL, issuerEpoch,
    state: 'unavailable', matchedUserMessageId: null, matchedTurn: null, outcome: null, userSequence: null,
    terminalSequence: null, checkpointSequence: null, checkpointHash: null, quiescent: false, missingReasons: [] }
  const unavailable = (reason: string, partial: Partial<DshExecutionEvidence> = {}): DshExecutionEvidence =>
    ({ ...base, ...partial, state: 'unavailable', missingReasons: [reason] })
  const query = ctx.get('sessionQuery')
  const persistence = ctx.get('sessionPersistence')
  if (!query || !persistence) return unavailable('execution_checkpoint_unavailable')
  signal.throwIfAborted()
  try {
    const sessionId = SessionId(request.sessionId)
    const observation = await query.observeSession(sessionId, { signal, projectionMode: 'none' })
    try {
      const events = observation.events
      if (observation.header.id !== sessionId || events.length > 100000 || Buffer.byteLength(JSON.stringify(events)) > 16777216)
        return unavailable('execution_checkpoint_unsupported')
      let activeTurn: number | null = null
      let match: { messageId: string; turn: number; sequence: number } | undefined
      let terminal: { sequence: number; outcome: 'completed' | 'failed' | 'cancelled' } | undefined
      for (const event of events) {
        if (event.type === 'turn/start') activeTurn = event.data.turn
        if (event.type === 'user/message' && event.data.source?.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === request.requestId) {
          if (match || activeTurn === null) return unavailable('execution_request_ambiguous')
          match = { messageId: event.data.id, turn: activeTurn, sequence: Number(event.seq) }
        }
        if (event.type === 'turn/end') {
          if (match?.turn === event.data.turn) {
            const kind = event.data.reason.kind
            if (!['completed', 'error', 'aborted'].includes(kind)) return unavailable('execution_terminal_unverifiable')
            terminal = { sequence: Number(event.seq), outcome: kind === 'completed' ? 'completed' : kind === 'aborted' ? 'cancelled' : 'failed' }
          }
          activeTurn = null
        }
      }
      const live = ctx.agents.get(sessionId)
      const quiescent = (!live || live.status === 'idle') && (!live || live.inbox.nextTurn.length === 0 && live.inbox.nextStep.length === 0)
      if (!match) return { ...base, state: 'not-observed', quiescent, missingReasons: ['execution_request_not_observed'] }
      const partial = { matchedUserMessageId: match.messageId, matchedTurn: match.turn, userSequence: match.sequence, quiescent }
      if (request.userMessageId !== undefined && request.userMessageId !== match.messageId || request.turn !== undefined && request.turn !== match.turn)
        return unavailable('execution_correlation_conflict', partial)
      if (!terminal) return { ...base, ...partial, state: 'pending', missingReasons: ['execution_turn_not_settled'] }
      if (!quiescent) return { ...base, ...partial, state: 'pending', missingReasons: ['execution_session_not_quiescent'] }
      const durable = await persistence.open(sessionId, 'read', { signal })
      try {
        const checkpoint = await durable.read()
        signal.throwIfAborted()
        // The JSONL SDK persists an omitted live delegationDepth as zero. Compare that documented storage form.
        if (durable.header.id !== sessionId || migrationDigest({ header: durable.header, events: checkpoint.events })
          !== migrationDigest({ header: { ...observation.header, delegationDepth: observation.header.delegationDepth ?? 0 }, events })) return unavailable('execution_checkpoint_not_confirmed', partial)
        const current = ctx.agents.get(sessionId)
        if (current !== live || current && (current.status !== 'idle' || current.inbox.nextTurn.length || current.inbox.nextStep.length
          || current.session.seq - 1 !== observation.cursor)) return unavailable('execution_observation_changed', partial)
        return { ...base, ...partial, state: 'settled', outcome: terminal.outcome, terminalSequence: terminal.sequence,
          checkpointSequence: Number(observation.cursor), checkpointHash: migrationDigest({ header: durable.header, events: checkpoint.events }), missingReasons: [] }
      } finally { await durable.close() }
    } finally { observation[Symbol.dispose]() }
  } catch {
    signal.throwIfAborted()
    return unavailable('execution_checkpoint_read_unavailable')
  }
}
