export const BRIDGE_PLUGIN_PROTOCOL = 'qq-agent-framework.dsh-bridge/1' as const
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

export interface ClaimReceiptPageBase {
  readonly protocol: typeof BRIDGE_PLUGIN_PROTOCOL
  readonly issuerEpoch: string
  readonly sessionId: string
  readonly oldestAvailableAfter: number
  readonly head: number
  readonly retention: typeof RECEIPT_LIMITS
  readonly absenceProven: false
  readonly nextAfter: number
  readonly hasMore: boolean
}
export type ClaimReceiptPage = ClaimReceiptPageBase & (
  { readonly state: 'page'; readonly coverage: 'retained-window-only' | 'after-cursor'; readonly receipts: ClaimReceipt[] }
  | { readonly state: 'unknown-epoch' | 'cursor-gap'; readonly receipts: ClaimReceipt[] }
)
