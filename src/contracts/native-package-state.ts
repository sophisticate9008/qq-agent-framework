import type { JsonValue } from './data.ts'

export interface NativePackageStateIdentity {
  readonly packageVersion: string
  readonly stateSchemaVersion: number
  readonly contentFingerprint: string
}
export interface NativePackageStateEntry {
  readonly key: string
  readonly revision: number
  /** Zero only for an explicitly adopted raw migration source whose old schema is unknown. */
  readonly stateSchemaVersion: number
  readonly contentFingerprint: string
  readonly value: JsonValue
}
export interface NativePackageStateMigration {
  /** Explicit adoption of previously unversioned raw values; no source schema is inferred. */
  readonly legacy?: true
  readonly operationId: string
  readonly target: NativePackageStateIdentity
  readonly phase: 'prepared' | 'applying' | 'unknown'
  readonly cursor: string | null
  readonly source: readonly { readonly key: string; readonly revision: number; readonly checksum: string }[]
  readonly lastError: string | null
}
export interface NativePackageStateSnapshot {
  readonly schema: 1
  readonly owner: string
  readonly revision: number | null
  readonly identity: NativePackageStateIdentity | null
  readonly migration: NativePackageStateMigration | null
  readonly ready: boolean
}
