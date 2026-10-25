import type { DshBridgePluginPort } from '../adapters/dsh-tool-scope.ts'
import { assert, snapshot } from '../core/values.ts'
import { json, object } from './data.ts'
import { withDeadline } from './deadlines.ts'
import type { createNativeExecutionController, NativeExecutionRecord } from './native-execution.ts'
import type { DurableStore } from './types.ts'

const namespace = 'host.execution-claim-cursors'

export interface NativeExecutionClaimBaseline {
  readonly sessionId: string
  readonly issuerEpoch: string
  readonly after: number
}

export function createNativeExecutionClaims(options: {
  readonly store: DurableStore
  readonly port: DshBridgePluginPort
  readonly issuerEpoch: string
  readonly executions: ReturnType<typeof createNativeExecutionController>
  readonly signal: AbortSignal
  readonly onFault?: (code: string) => void
  readonly onCorrelationFault?: (code: string) => void
}) {
  const pending = new Map<string, Promise<void>>()

  async function baseline(sessionId: string, signal: AbortSignal): Promise<NativeExecutionClaimBaseline> {
    try {
      const page = await options.port.claimReceipts({ sessionId, issuerEpoch: options.issuerEpoch, limit: 128 }, signal)
      assert(page.state === 'page', 'EXECUTION_CLAIM_BASELINE_UNAVAILABLE', 'The trusted claim receipt baseline is unavailable.')
      return snapshot({ sessionId, issuerEpoch: page.issuerEpoch, after: page.head })
    } catch (error) {
      if (!signal.aborted && !options.signal.aborted) options.onCorrelationFault?.('EXECUTION_CLAIM_BASELINE_UNAVAILABLE')
      throw error
    }
  }

  return Object.freeze({
    baseline,
    attach(execution: NativeExecutionRecord, baseline: NativeExecutionClaimBaseline) {
      assert(execution.binding.sessionId === baseline.sessionId && execution.externalStatus === 'not-started',
        'EXECUTION_INVALID_EVIDENCE', 'A claim baseline must precede prompt submission.')
      options.store.write(namespace, execution.id, json({ ...baseline, state: 'following' }), { expectedRevision: null })
    },
    poll(id: string): Promise<void> {
      const prior = pending.get(id)
      if (prior) return prior
      const operation = withDeadline({ signal: options.signal, timeoutMs: 5_000, code: 'EXECUTION_CLAIM_POLL_UNKNOWN', async run(signal) {
        for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
          const stored = options.store.read(namespace, id)
          if (!stored) return
          const cursor = object(stored.value)
          if (cursor.state !== 'following') return
          const execution = options.executions.get(id)
          if (!execution) return
          const page = await options.port.claimReceipts({ sessionId: String(cursor.sessionId),
            issuerEpoch: String(cursor.issuerEpoch), after: Number(cursor.after), limit: 128 }, signal)
          if (signal.aborted || options.signal.aborted) return
          if (page.state !== 'page') {
            options.store.write(namespace, id, { ...cursor, state: page.state }, { expectedRevision: stored.revision })
            options.executions.lost(id)
            options.onCorrelationFault?.(page.state === 'unknown-epoch' ? 'EXECUTION_CLAIM_EPOCH_UNKNOWN' : 'EXECUTION_CLAIM_CURSOR_GAP')
            return
          }
          for (const proof of page.receipts) if (proof.requestId === execution.requestId) options.executions.claimed(id, proof)
          options.store.write(namespace, id, { ...cursor, after: page.nextAfter }, { expectedRevision: stored.revision })
          if (!page.hasMore) return
        }
        options.executions.lost(id)
      } }).catch(() => {
        if (!options.signal.aborted) {
          options.onCorrelationFault?.('EXECUTION_CLAIM_READ_UNKNOWN')
          try { options.executions.lost(id) }
          catch { try { options.onFault?.('EXECUTION_CLAIM_STORAGE_UNKNOWN') } catch {} }
        }
      })
      pending.set(id, operation)
      void operation.finally(() => pending.delete(id))
      return operation
    },
    async drain() { await Promise.allSettled([...pending.values()]) }
  })
}
