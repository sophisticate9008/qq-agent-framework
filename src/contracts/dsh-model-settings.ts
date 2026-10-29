import type { ChatPlanReasoningEffort } from './chat-plans.ts'

export type DshInputModality = 'text' | 'image'
export interface DshDeploymentModelSettings {
  readonly contextWindow: number
  readonly maxTokens: number
  readonly reasoningEfforts: false | Readonly<Partial<Record<ChatPlanReasoningEffort, string | null>>>
  readonly inputModalities?: readonly DshInputModality[]
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 16_777_216 }

/** A managed chat route must retain text support; images require explicit observed metadata. */
export function parseDshInputModalities(input: unknown): readonly DshInputModality[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 2 || Object.keys(input).length !== input.length
    || input.some(value => value !== 'text' && value !== 'image') || !input.includes('text') || new Set(input).size !== input.length) return null
  return Object.freeze(input.includes('image') ? ['text', 'image'] : ['text'])
}

export function validateDshModelSettings(value: unknown): DshDeploymentModelSettings {
  if (!record(value) || Object.keys(value).some(key => !['contextWindow', 'maxTokens', 'reasoningEfforts', 'inputModalities'].includes(key))
    || !positive(value.contextWindow) || !positive(value.maxTokens) || value.maxTokens >= value.contextWindow) throw new TypeError('Invalid DSH model settings')
  const efforts = value.reasoningEfforts
  if (efforts !== false && (!record(efforts) || !Object.keys(efforts).some(level => level !== 'off')
    || Object.entries(efforts).some(([level, wire]) => !['off', 'low', 'medium', 'high', 'max'].includes(level)
      || wire === null && level !== 'off' || wire !== null && (typeof wire !== 'string' || wire.length === 0 || wire.length > 128)))) throw new TypeError('Invalid DSH model settings')
  const inputModalities = Object.hasOwn(value, 'inputModalities') ? parseDshInputModalities(value.inputModalities) : undefined
  if (inputModalities === null) throw new TypeError('Invalid DSH model input modalities')
  return Object.freeze({ contextWindow: value.contextWindow, maxTokens: value.maxTokens,
    reasoningEfforts: efforts === false ? false : Object.freeze({ ...efforts }) as DshDeploymentModelSettings['reasoningEfforts'],
    ...(inputModalities === undefined ? {} : { inputModalities }) })
}

/** Operator input is a literal wire token, never a configuration expression. */
export function validateManualDshModelSettings(value: unknown): DshDeploymentModelSettings {
  const settings = validateDshModelSettings(value)
  if (settings.reasoningEfforts !== false && Object.values(settings.reasoningEfforts).some(wire =>
    wire !== null && (typeof wire !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(wire)))) {
    throw new TypeError('Invalid manual reasoning wire value')
  }
  return settings
}
