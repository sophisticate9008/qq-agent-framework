import { randomUUID } from 'node:crypto'

export const BRIDGE_PLUGIN_PROTOCOL = 'qq-bridge-framework.dsh-bridge/1' as const
export const RECEIPT_LIMITS = Object.freeze({ maxReceipts: 4096, maxAgeMs: 300_000, maxPage: 128 })

export interface ClaimReceipt {
  readonly kind: 'dsh.agent-inbox-claimed'
  readonly issuerEpoch: string
  readonly receiptSeq: number
  readonly evidenceId: string
  readonly sessionId: string
  readonly requestId: string
  readonly userMessageId: string
  readonly turn: number
}

export interface ClaimReceiptQuery {
  readonly sessionId: string
  readonly issuerEpoch?: string
  readonly after?: number
  readonly limit?: number
}

export function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
}

export function createClaimReceiptJournal(now: () => number = Date.now) {
  const issuerEpoch: string = randomUUID()
  const entries: { receipt: ClaimReceipt; at: number }[] = []
  let head = 0
  let floor = 0
  function prune() {
    const cutoff = now() - RECEIPT_LIMITS.maxAgeMs
    while (entries.length > RECEIPT_LIMITS.maxReceipts || entries[0] && entries[0].at <= cutoff) {
      const removed = entries.shift()
      if (removed) floor = removed.receipt.receiptSeq
    }
  }
  return Object.freeze({
    issuerEpoch,
    record(input: { sessionId: string; requestId: string; userMessageId: string; turn: number }) {
      if (!validIdentifier(input.sessionId) || !validIdentifier(input.requestId) || !validIdentifier(input.userMessageId)
        || !Number.isSafeInteger(input.turn) || input.turn < 0) return
      prune()
      if (entries.some(entry => entry.receipt.sessionId === input.sessionId
        && entry.receipt.userMessageId === input.userMessageId && entry.receipt.turn === input.turn)) return
      const receipt: ClaimReceipt = Object.freeze({ kind: 'dsh.agent-inbox-claimed', issuerEpoch,
        receiptSeq: ++head, evidenceId: `${issuerEpoch}:${head}`, sessionId: input.sessionId,
        requestId: input.requestId, userMessageId: input.userMessageId, turn: input.turn })
      entries.push({ receipt, at: now() })
      prune()
    },
    read(request: ClaimReceiptQuery) {
      if (!request || !validIdentifier(request.sessionId)
        || request.issuerEpoch !== undefined && !validIdentifier(request.issuerEpoch)
        || request.after !== undefined && (!Number.isSafeInteger(request.after) || request.after < 0 || request.issuerEpoch === undefined)
        || request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > RECEIPT_LIMITS.maxPage)) {
        throw new TypeError('Invalid claim receipt query')
      }
      prune()
      const base = { protocol: BRIDGE_PLUGIN_PROTOCOL, issuerEpoch, sessionId: request.sessionId,
        oldestAvailableAfter: floor, head, retention: RECEIPT_LIMITS, absenceProven: false as const }
      if (request.issuerEpoch !== undefined && request.issuerEpoch !== issuerEpoch) {
        return { ...base, state: 'unknown-epoch' as const, receipts: [], nextAfter: head, hasMore: false }
      }
      const after = request.after ?? floor
      if (after < floor || after > head) {
        return { ...base, state: 'cursor-gap' as const, receipts: [], nextAfter: head, hasMore: false }
      }
      const matching = entries.filter(entry => entry.receipt.receiptSeq > after && entry.receipt.sessionId === request.sessionId)
      const selected = matching.slice(0, request.limit ?? RECEIPT_LIMITS.maxPage)
      const hasMore = selected.length < matching.length
      const last = selected.at(-1)
      return { ...base, state: 'page' as const, coverage: request.after === undefined ? 'retained-window-only' as const : 'after-cursor' as const,
        receipts: selected.map(entry => ({ ...entry.receipt })), hasMore,
        nextAfter: hasMore && last ? last.receipt.receiptSeq : head }
    },
  })
}

export type ClaimReceiptPage = ReturnType<ReturnType<typeof createClaimReceiptJournal>['read']>
