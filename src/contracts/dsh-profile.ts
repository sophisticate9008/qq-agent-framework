import type { JsonObject } from './data.ts'

export interface DshDeploymentPreset {
  readonly entryId: string
  readonly config: JsonObject
}

export interface DshDeploymentSnapshot {
  readonly profilePath: string
  readonly credentialsPath: string
  readonly schemaVersion: string
  readonly revision: string
  readonly providerEntryId: string
  readonly providerConfig: JsonObject
  readonly presets: readonly DshDeploymentPreset[]
  readonly credentialChecks: readonly {
    readonly ref: string
    readonly localValueMatches: boolean
    readonly liveConfigured: boolean
    readonly liveSource: string | null
    readonly targetPath: string | null
  }[]
  readonly configurationLoaded: boolean
}

export interface DshDeploymentProposal {
  readonly profilePath: string
  readonly expectedRevision: string
  readonly patch: readonly JsonObject[]
  readonly credentials: readonly { readonly ref: string; readonly value: string }[]
  readonly expected: {
    readonly providerConfig: JsonObject
    readonly presets: readonly DshDeploymentPreset[]
  }
}

export interface DshProfileTarget {
  readonly profilePath: string
  readonly credentialsPath: string
  readonly layerPaths?: readonly string[]
  readonly schemaVersion: '0.2.1-rc.2'
}
export interface DshProfileInspection {
  readonly target: DshProfileTarget
  readonly snapshot: DshDeploymentSnapshot
  readonly credentialEntryId: string | undefined
  readonly credentialEntryConfig: JsonObject | undefined
}
export interface DshProfileFilePort {
  read(target: DshProfileTarget): Promise<DshProfileInspection>
  matchCredentials(target: DshProfileTarget, expectedRevision: string, candidates: readonly { readonly ref: string; readonly value: string }[]):
    Promise<readonly { readonly ref: string; readonly matches: boolean }[]>
  write(target: DshProfileTarget, proposal: DshDeploymentProposal, signal: AbortSignal,
    backedUp: (id: string) => void): Promise<string>
}
