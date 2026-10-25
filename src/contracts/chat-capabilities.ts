import type { ChatPlanCapabilitySelection } from './chat-plans.ts'

export interface ChatCapabilitySelection {
  readonly presetId: string
  readonly revision: string
}

export interface ChatCapabilityPreset extends ChatCapabilitySelection {
  readonly name: string
  readonly description: string
  readonly composable: boolean
  readonly packages: readonly string[]
  readonly missingReasons: readonly string[]
}

export interface ChatCapabilityApproval {
  readonly approvalId: string
  readonly authority: 'owner'
  readonly externalTools: 'separate-runtime-authorization-required'
}

export interface ChatCapabilityDeclaration {
  readonly selection: ChatCapabilitySelection
  readonly content: string
}

export interface ChatCapabilityComposition {
  readonly schema: 1
  readonly source: ChatPlanCapabilitySelection
  readonly revision: string
  readonly externalToolAuthorizationVerified: false
}

export interface ChatCapabilityApprovalRequest {
  readonly schema: 1
  readonly source: ChatPlanCapabilitySelection
  readonly compositionRevision: string
  readonly target: {
    readonly profilePath: string
    readonly credentialsPath: string
    readonly layerPaths: readonly string[]
    readonly schemaVersion: '0.2.1-rc.2'
  }
}

export interface ChatCapabilityCompositionApproval extends ChatCapabilityApprovalRequest, ChatCapabilityApproval {}
