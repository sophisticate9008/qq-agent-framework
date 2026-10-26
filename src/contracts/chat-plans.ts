import { isPersonaWake, validatePersonaWake, type PersonaWake } from './persona-wake.ts'

export const CHAT_PLAN_REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'max'] as const

export type ChatPlanReasoningEffort = typeof CHAT_PLAN_REASONING_EFFORTS[number]

export interface ChatContextLimits {
  readonly group: number
  readonly private: number
}

export const DEFAULT_CHAT_CONTEXT_LIMITS: ChatContextLimits = Object.freeze({ group: 128_000, private: 128_000 })

export interface ChatPlanCapabilitySelection {
  readonly schema: 1
  readonly presetId: string
  readonly revision: string
}

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
  readonly capabilitySelection?: ChatPlanCapabilitySelection | null
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
  readonly wake?: PersonaWake
}

const PLAN_KEYS = [
  'id', 'name', 'description', 'instructions', 'personaId', 'provider', 'model', 'reasoningEffort'
] as const
const PERSONA_KEYS = ['id', 'name', 'identity', 'style'] as const
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const CHAT_PLAN_LIMITS = Object.freeze({
  identifier: 128,
  name: 128,
  description: 2_000,
  instructions: 32_000,
  personaSection: 16_000,
  catalog: 128,
  contextMinimum: 1,
  contextMaximum: 16_777_216,
})

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

export function isChatPlanIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value)
}

export function isChatPlanReference(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value)
    && !value.includes('..') && !value.includes('//') && !value.endsWith('/')
}

export function isChatPlanReasoningEffort(value: unknown): value is ChatPlanReasoningEffort {
  return typeof value === 'string'
    && (CHAT_PLAN_REASONING_EFFORTS as readonly string[]).includes(value)
}

export function isChatContextLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= CHAT_PLAN_LIMITS.contextMinimum && value <= CHAT_PLAN_LIMITS.contextMaximum
}

export function isChatContextLimits(value: unknown): value is ChatContextLimits {
  return isRecord(value) && hasExactKeys(value, ['group', 'private'])
    && isChatContextLimit(value.group) && isChatContextLimit(value.private)
}

export function isChatPlanCapabilitySelection(value: unknown): value is ChatPlanCapabilitySelection {
  return isRecord(value) && hasExactKeys(value, ['schema', 'presetId', 'revision'])
    && value.schema === 1 && isChatPlanReference(value.presetId)
    && typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision)
}

export function isChatPlan(value: unknown): value is ChatPlan {
  return isRecord(value)
    && hasExactKeys(value, [...PLAN_KEYS, ...(Object.hasOwn(value, 'contextLimits') ? ['contextLimits'] : []),
      ...(Object.hasOwn(value, 'capabilitySelection') ? ['capabilitySelection'] : [])])
    && isChatPlanIdentifier(value.id)
    && boundedString(value.name, CHAT_PLAN_LIMITS.name, false)
    && boundedString(value.description, CHAT_PLAN_LIMITS.description, true)
    && boundedString(value.instructions, CHAT_PLAN_LIMITS.instructions, false)
    && isChatPlanIdentifier(value.personaId)
    && isChatPlanReference(value.provider)
    && isChatPlanReference(value.model)
    && isChatPlanReasoningEffort(value.reasoningEffort)
    && (!Object.hasOwn(value, 'contextLimits') || isChatContextLimits(value.contextLimits))
    && (!Object.hasOwn(value, 'capabilitySelection') || value.capabilitySelection === null || isChatPlanCapabilitySelection(value.capabilitySelection))
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
    contextLimits: Object.freeze({ ...(value.contextLimits ?? DEFAULT_CHAT_CONTEXT_LIMITS) }),
    ...(Object.hasOwn(value, 'capabilitySelection') ? { capabilitySelection: value.capabilitySelection === null
      ? null : Object.freeze({ ...value.capabilitySelection! }) } : {})
  })
}

export function isChatPersona(value: unknown): value is ChatPersona {
  return isRecord(value)
    && hasExactKeys(value, Object.hasOwn(value, 'wake') ? [...PERSONA_KEYS, 'wake'] : PERSONA_KEYS)
    && (!Object.hasOwn(value, 'wake') || isPersonaWake(value.wake))
    && isChatPlanIdentifier(value.id)
    && boundedString(value.name, CHAT_PLAN_LIMITS.name, false)
    && boundedString(value.identity, CHAT_PLAN_LIMITS.personaSection, false)
    && boundedString(value.style, CHAT_PLAN_LIMITS.personaSection, false)
}

export function validateChatPersona(value: unknown): ChatPersona {
  if (!isChatPersona(value)) throw new TypeError('Invalid chat persona')
  return Object.freeze({
    id: value.id,
    name: value.name,
    identity: value.identity,
    style: value.style,
    ...(value.wake ? { wake: validatePersonaWake(value.wake) } : {})
  })
}

export function validateChatPlanCatalog(value: unknown): ChatPlanCatalog {
  if (!isRecord(value) || !hasExactKeys(value, ['activePlanId', 'plans'])
    || value.activePlanId !== null && !isChatPlanIdentifier(value.activePlanId)
    || !Array.isArray(value.plans) || value.plans.length > CHAT_PLAN_LIMITS.catalog) {
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
  if (!Array.isArray(value) || value.length > CHAT_PLAN_LIMITS.catalog) throw new TypeError('Invalid chat personas')
  const personas = value.map(validateChatPersona)
  if (new Set(personas.map(persona => persona.id)).size !== personas.length) {
    throw new TypeError('Invalid chat personas')
  }
  return Object.freeze(personas)
}
