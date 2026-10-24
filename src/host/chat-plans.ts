export const CHAT_PLAN_REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'max'] as const

export type ChatPlanReasoningEffort = typeof CHAT_PLAN_REASONING_EFFORTS[number]

export interface ChatContextLimits {
  readonly group: number
  readonly private: number
}

export const DEFAULT_CHAT_CONTEXT_LIMITS: ChatContextLimits = Object.freeze({ group: 128_000, private: 128_000 })

export interface ChatPlan {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly personaId: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: ChatPlanReasoningEffort
  readonly contextLimits?: ChatContextLimits
}

export interface NormalizedChatPlan extends ChatPlan {
  readonly contextLimits: ChatContextLimits
}

export interface ChatPlanCatalog {
  readonly activePlanId: string | null
  readonly plans: readonly ChatPlan[]
}

export interface ChatPersona {
  readonly id: string
  readonly name: string
  readonly identity: string
  readonly style: string
}

export interface ChatSessionDefinition {
  readonly planId: string
  readonly personaId: string
  readonly instructions: string
  readonly contextLimits?: ChatContextLimits
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

const PLAN_KEYS = [
  'id', 'name', 'description', 'instructions', 'personaId', 'provider', 'model', 'reasoningEffort'
] as const
const PERSONA_KEYS = ['id', 'name', 'identity', 'style'] as const
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_NAME_LENGTH = 128
const MAX_DESCRIPTION_LENGTH = 2_000
const MAX_INSTRUCTIONS_LENGTH = 32_000
const MAX_PERSONA_SECTION_LENGTH = 16_000
const MAX_PLANS = 128

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function boundedString(value: unknown, maximum: number, allowEmpty: boolean): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim().length > 0)
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value)
}

function validReference(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value)
    && !value.includes('..') && !value.includes('//') && !value.endsWith('/')
}

function isReasoningEffort(value: unknown): value is ChatPlanReasoningEffort {
  return typeof value === 'string'
    && (CHAT_PLAN_REASONING_EFFORTS as readonly string[]).includes(value)
}

function isContextLimits(value: unknown): value is ChatContextLimits {
  return isRecord(value) && hasExactKeys(value, ['group', 'private'])
    && [value.group, value.private].every(limit => typeof limit === 'number'
      && Number.isSafeInteger(limit) && limit >= 1 && limit <= 16_777_216)
}

export function isChatPlan(value: unknown): value is ChatPlan {
  return isRecord(value)
    && hasExactKeys(value, Object.hasOwn(value, 'contextLimits') ? [...PLAN_KEYS, 'contextLimits'] : PLAN_KEYS)
    && validIdentifier(value.id)
    && boundedString(value.name, MAX_NAME_LENGTH, false)
    && boundedString(value.description, MAX_DESCRIPTION_LENGTH, true)
    && boundedString(value.instructions, MAX_INSTRUCTIONS_LENGTH, false)
    && validIdentifier(value.personaId)
    && validReference(value.provider)
    && validReference(value.model)
    && isReasoningEffort(value.reasoningEffort)
    && (!Object.hasOwn(value, 'contextLimits') || isContextLimits(value.contextLimits))
}

export function validateChatPlan(value: unknown): NormalizedChatPlan {
  if (!isChatPlan(value)) throw new TypeError('Invalid chat plan')
  return Object.freeze({
    id: value.id,
    name: value.name,
    description: value.description,
    instructions: value.instructions,
    personaId: value.personaId,
    provider: value.provider,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    contextLimits: Object.freeze({ ...(value.contextLimits ?? DEFAULT_CHAT_CONTEXT_LIMITS) })
  })
}

export function isChatPersona(value: unknown): value is ChatPersona {
  return isRecord(value)
    && hasExactKeys(value, PERSONA_KEYS)
    && validIdentifier(value.id)
    && boundedString(value.name, MAX_NAME_LENGTH, false)
    && boundedString(value.identity, MAX_PERSONA_SECTION_LENGTH, false)
    && boundedString(value.style, MAX_PERSONA_SECTION_LENGTH, false)
}

export function validateChatPersona(value: unknown): ChatPersona {
  if (!isChatPersona(value)) throw new TypeError('Invalid chat persona')
  return Object.freeze({
    id: value.id,
    name: value.name,
    identity: value.identity,
    style: value.style
  })
}

export function validateChatPlanCatalog(value: unknown): ChatPlanCatalog {
  if (!isRecord(value) || !hasExactKeys(value, ['activePlanId', 'plans'])
    || value.activePlanId !== null && !validIdentifier(value.activePlanId)
    || !Array.isArray(value.plans) || value.plans.length > MAX_PLANS) {
    throw new TypeError('Invalid chat plan catalog')
  }
  const plans = value.plans.map(validateChatPlan)
  const ids = new Set(plans.map(plan => plan.id))
  if (ids.size !== plans.length || value.activePlanId !== null && !ids.has(value.activePlanId)) {
    throw new TypeError('Invalid chat plan catalog')
  }
  return Object.freeze({ activePlanId: value.activePlanId, plans: Object.freeze(plans) })
}

export function validateChatPersonas(value: unknown): readonly ChatPersona[] {
  if (!Array.isArray(value) || value.length > MAX_PLANS) throw new TypeError('Invalid chat personas')
  const personas = value.map(validateChatPersona)
  if (new Set(personas.map(persona => persona.id)).size !== personas.length) {
    throw new TypeError('Invalid chat personas')
  }
  return Object.freeze(personas)
}

export function selectChatPlan(catalog: ChatPlanCatalog, planId: string | null = catalog.activePlanId): ChatPlan | null {
  const validated = validateChatPlanCatalog(catalog)
  if (planId === null) return null
  if (!validIdentifier(planId)) throw new TypeError('Invalid chat plan identifier')
  return validated.plans.find(plan => plan.id === planId) ?? null
}

export function selectChatPersona(personas: readonly ChatPersona[], personaId: string): ChatPersona | null {
  if (!validIdentifier(personaId)) throw new TypeError('Invalid chat persona identifier')
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
    ...(Object.hasOwn(plan, 'contextLimits') ? { contextLimits: selectedPlan.contextLimits } : {})
  })
}
