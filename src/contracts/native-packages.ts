export interface NativePackageServiceDeclaration {
  readonly id: string
  readonly version: number
}

export interface NativePackageContributionDeclaration {
  readonly kind: 'effect' | 'input-provider' | 'feature' | 'event-validator'
  readonly id: string
  readonly capabilities?: readonly string[]
  readonly order?: number
}

export interface NativePackageManifest {
  readonly schema: 1
  readonly id: string
  readonly version: string
  readonly stateSchemaVersion?: number
  readonly dependencies: readonly string[]
  readonly provides: readonly NativePackageServiceDeclaration[]
  readonly requires: readonly NativePackageServiceDeclaration[]
  readonly contributions: readonly NativePackageContributionDeclaration[]
}

export type NativePackagePhase = 'prepare' | 'migrate' | 'install' | 'recover' | 'start' | 'drain' | 'dispose'
export type NativePackageState = 'registered' | 'starting' | 'running' | 'blocked' | 'failed' | 'stopping' | 'stopped' | 'unknown'
export type NativePackageResourceKind = 'task' | 'timer' | 'subscription' | 'service' | 'contribution' | 'other'

export interface NativePackageSnapshot {
  readonly schema: 1
  readonly id: string
  readonly version: string
  readonly state: NativePackageState
  readonly phase: NativePackagePhase | null
  readonly reason: string | null
  readonly resources: readonly {
    readonly id: string
    readonly kind: NativePackageResourceKind
    readonly state: 'active' | 'disposed' | 'unknown'
  }[]
}
