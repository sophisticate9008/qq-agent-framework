export const DSH_EXECUTION_EVIDENCE_PROTOCOL = 'qq-bridge-framework.execution-evidence/1' as const
export interface DshExecutionEvidenceRequest {
  readonly sessionId: string
  readonly requestId: string
  readonly userMessageId?: string
  readonly turn?: number
}
export interface DshExecutionEvidence extends DshExecutionEvidenceRequest {
  readonly schema: 1
  readonly protocol: typeof DSH_EXECUTION_EVIDENCE_PROTOCOL
  readonly issuerEpoch: string
  readonly state: 'settled' | 'pending' | 'not-observed' | 'unavailable'
  readonly matchedUserMessageId: string | null
  readonly matchedTurn: number | null
  readonly outcome: 'completed' | 'failed' | 'cancelled' | null
  readonly userSequence: number | null
  readonly terminalSequence: number | null
  readonly checkpointSequence: number | null
  readonly checkpointHash: string | null
  readonly quiescent: boolean
  readonly missingReasons: readonly string[]
}
