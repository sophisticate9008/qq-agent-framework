export interface NativeChatRunningIntent {
  readonly schema: 1
  readonly desiredRunning: boolean
  readonly revisions: Readonly<Record<string, string>> | null
  readonly updatedAt: number
}

export interface NativeChatLifecycleDocument {
  readonly revision: string
  readonly exists: boolean
  readonly value: NativeChatRunningIntent
}

export interface NativeChatLifecycleStatus {
  readonly state: string
  readonly canStart: boolean
  readonly revisions: Readonly<Record<string, string>>
  readonly activeRevisions: Readonly<Record<string, string>> | null
}

export interface NativeChatRestoreResult {
  readonly state: 'not-attempted' | 'checking' | 'skipped' | 'restored' | 'failed'
  readonly reason: string | null
}
