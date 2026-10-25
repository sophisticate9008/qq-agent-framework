export * from '../contracts/chat-plans.ts'
import { isChatPlanIdentifier, validateChatPlan, validateChatPersona, validateChatPlanCatalog, validateChatPersonas,
  type ChatPlan, type ChatPlanCatalog, type ChatPersona, type ChatContextLimits, type ChatPlanCapabilitySelection,
  type ChatPlanReasoningEffort } from '../contracts/chat-plans.ts'

export type { ChatSessionDefinition } from '../contracts/chat-session.ts'
import type { ChatSessionDefinition } from '../contracts/chat-session.ts'

export function selectChatPlan(catalog: ChatPlanCatalog, planId: string | null = catalog.activePlanId): ChatPlan | null {
  const validated = validateChatPlanCatalog(catalog)
  if (planId === null) return null
  if (!isChatPlanIdentifier(planId)) throw new TypeError('Invalid chat plan identifier')
  return validated.plans.find(plan => plan.id === planId) ?? null
}

export function selectChatPersona(personas: readonly ChatPersona[], personaId: string): ChatPersona | null {
  if (!isChatPlanIdentifier(personaId)) throw new TypeError('Invalid chat persona identifier')
  return validateChatPersonas(personas).find(persona => persona.id === personaId) ?? null
}

export function buildChatSessionDefinition(plan: ChatPlan, persona: ChatPersona): ChatSessionDefinition {
  const selectedPlan = validateChatPlan(plan)
  const selectedPersona = validateChatPersona(persona)
  if (selectedPlan.personaId !== selectedPersona.id) throw new TypeError('Chat plan persona does not match')
  return Object.freeze({
    planId: selectedPlan.id,
    personaId: selectedPersona.id,
    instructions: selectedPlan.instructions,
    persona: Object.freeze({ identity: selectedPersona.identity, style: selectedPersona.style }),
    model: Object.freeze({
      provider: selectedPlan.provider,
      name: selectedPlan.model,
      reasoningEffort: selectedPlan.reasoningEffort
    }),
    ...(Object.hasOwn(plan, 'contextLimits') ? { contextLimits: selectedPlan.contextLimits } : {}),
    ...(Object.hasOwn(plan, 'capabilitySelection') ? { capabilitySelection: selectedPlan.capabilitySelection } : {})
  })
}
