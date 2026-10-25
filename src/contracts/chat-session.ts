import type { ChatContextLimits, ChatPlanCapabilitySelection, ChatPlanReasoningEffort } from './chat-plans.ts'

export interface ChatSessionDefinition {
  readonly planId: string
  readonly personaId: string
  readonly instructions: string
  readonly contextLimits?: ChatContextLimits
  readonly capabilitySelection?: ChatPlanCapabilitySelection | null
  readonly persona: {
    readonly identity: string
    readonly style: string
  }
  readonly model: {
    readonly provider: string
    readonly name: string
    readonly reasoningEffort: ChatPlanReasoningEffort
  }
}


import { isChatPlanIdentifier, isChatPlanReference, isChatPlanReasoningEffort,
  isChatContextLimits, isChatPlanCapabilitySelection } from './chat-plans.ts'

export function isChatSessionDefinition(value: unknown): value is ChatSessionDefinition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if (entry.persona === null || typeof entry.persona !== 'object' || Array.isArray(entry.persona)
    || entry.model === null || typeof entry.model !== 'object' || Array.isArray(entry.model)) return false
  const persona = entry.persona as Record<string, unknown>
  const model = entry.model as Record<string, unknown>
  return isChatPlanIdentifier(entry.planId) && isChatPlanIdentifier(entry.personaId)
    && typeof entry.instructions === 'string' && entry.instructions.length <= 32_000
    && typeof persona.identity === 'string' && persona.identity.length <= 16_000
    && typeof persona.style === 'string' && persona.style.length <= 16_000
    && isChatPlanReference(model.provider) && isChatPlanReference(model.name) && isChatPlanReasoningEffort(model.reasoningEffort)
    && (entry.contextLimits === undefined || isChatContextLimits(entry.contextLimits))
    && (entry.capabilitySelection == null || isChatPlanCapabilitySelection(entry.capabilitySelection))
}
