import type { DshBridgePluginPort } from '../adapters/dsh-tool-scope.ts'
import { DSH_EXECUTION_EVIDENCE_PROTOCOL, type DshExecutionEvidence } from '../contracts/dsh-execution-evidence.ts'
import { assert, errorCode, reference, snapshot } from '../core/values.ts'
import { digest, json, object } from './data.ts'
import { withDeadline } from './deadlines.ts'
import type { createNativeExecutionController, NativeExecutionRecord } from './native-execution.ts'
import type { DurableStore, SessionBinding } from './types.ts'

export interface NativeExecutionReconciliation {
  readonly state: 'released' | 'blocked'
  readonly execution: NativeExecutionRecord
  readonly evidence: DshExecutionEvidence | null
  readonly missingReasons: readonly string[]
  readonly automaticReplayAvailable: false
}

/** Owner management observes SDK evidence. It never prompts, cancels, delivers a final, or answers an interaction. */
export function createNativeExecutionReconciliation(options: { readonly store: DurableStore; readonly port: DshBridgePluginPort;
  readonly issuerEpoch: string; readonly executions: ReturnType<typeof createNativeExecutionController>; readonly signal: AbortSignal;
  readonly isCurrentBinding: (binding: Readonly<SessionBinding>) => boolean }) {
  assert(reference(options.issuerEpoch), 'EXECUTION_INVALID_EVIDENCE', 'Recovery requires a verified SDK epoch.')
  const pending = new Map<string, Promise<Readonly<NativeExecutionReconciliation>>>()
  return Object.freeze({
    reconcile(id: string, callerSignal: AbortSignal = options.signal): Promise<Readonly<NativeExecutionReconciliation>> {
      assert(/^[a-f0-9]{64}$/.test(id), 'EXECUTION_INVALID_QUERY', 'An execution identity is required.')
      const prior = pending.get(id)
      if (prior) return prior
      assert(pending.size < 16, 'EXECUTION_BACKPRESSURE', 'Execution evidence queries reached their bound.')
      const task = (async (): Promise<Readonly<NativeExecutionReconciliation>> => {
        const original = options.executions.get(id)
        assert(original, 'EXECUTION_NOT_FOUND', 'The addressed execution does not exist.')
        const blocked = (missingReasons: readonly string[], evidence: DshExecutionEvidence | null = null) =>
          snapshot({ state: 'blocked' as const, execution: options.executions.get(id)!, evidence, missingReasons, automaticReplayAvailable: false as const })
        if (!options.isCurrentBinding(original.binding)) return blocked(['execution_binding_changed'])
        if (!original.isolated && ['completed', 'failed', 'rejected'].includes(original.status)) return snapshot({ state: 'released',
          execution: original, evidence: null, missingReasons: [], automaticReplayAvailable: false })
        if (!options.port.inspectExecution) return blocked(['execution_checkpoint_unavailable'])
        let evidence: DshExecutionEvidence
        try {
          evidence = await withDeadline({ signal: AbortSignal.any([options.signal, callerSignal]), timeoutMs: 5000,
            code: 'EXECUTION_INSPECTION_UNKNOWN', run: signal => options.port.inspectExecution!({ sessionId: original.binding.sessionId, requestId: original.requestId,
              ...(original.userMessage ? { userMessageId: original.userMessage.messageId } : {}),
              ...(original.turn ? { turn: Number(original.turn.id) } : {}) }, options.issuerEpoch, signal) })
        } catch { return blocked(['execution_checkpoint_read_unavailable']) }
        const observationKey = digest({ id, evidence })
        if (!options.store.read(`host.execution-reconcile.${id}`, observationKey)) options.store.write(`host.execution-reconcile.${id}`, observationKey,
          json({ schema: 1, executionId: id, binding: original.binding, observedAt: Date.now(), evidence }), { expectedRevision: null })
        const current = options.executions.get(id)!
        if (!options.isCurrentBinding(current.binding) || digest(current.binding) !== digest(original.binding)) return blocked(['execution_binding_changed'], evidence)
        if (evidence.state !== 'settled') return blocked(evidence.missingReasons, evidence)
        if (evidence.protocol !== DSH_EXECUTION_EVIDENCE_PROTOCOL || evidence.schema !== 1 || evidence.issuerEpoch !== options.issuerEpoch
          || !evidence.quiescent || !evidence.checkpointHash || evidence.checkpointSequence === null || evidence.matchedTurn === null
          || !evidence.matchedUserMessageId || !evidence.outcome || evidence.sessionId !== current.binding.sessionId || evidence.requestId !== current.requestId)
          return blocked(['execution_correlation_conflict'], evidence)
        try {
          const execution = options.executions.reconcileCheckpoint(id, { binding: current.binding, requestId: current.requestId,
            userMessageId: evidence.matchedUserMessageId, turnId: String(evidence.matchedTurn), outcome: evidence.outcome,
            evidenceId: `checkpoint:${evidence.checkpointHash}`, checkpointHash: evidence.checkpointHash,
            checkpointSequence: evidence.checkpointSequence, quiescent: true })
          return snapshot({ state: 'released', execution, evidence, missingReasons: [], automaticReplayAvailable: false })
        } catch (error) {
          return blocked([errorCode(error) === 'EXECUTION_CANCEL_EVIDENCE_UNKNOWN' ? 'execution_cancel_evidence_unknown' : 'execution_correlation_conflict'], evidence)
        }
      })()
      pending.set(id, task)
      void task.finally(() => { if (pending.get(id) === task) pending.delete(id) }).catch(() => {})
      return task
    },
    observations(id: string, limit = 20) {
      assert(/^[a-f0-9]{64}$/.test(id) && Number.isSafeInteger(limit) && limit > 0 && limit <= 100,
        'EXECUTION_INVALID_QUERY', 'Evidence queries must be bounded.')
      // Bounded pages preserve evidence without scanning or returning session content.
      return snapshot(options.store.list(`host.execution-reconcile.${id}`, { limit }).map(record => object(record.value)).filter(value => value.executionId === id))
    }
  })
}
