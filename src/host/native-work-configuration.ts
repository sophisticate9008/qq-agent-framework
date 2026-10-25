import { isRecord } from '../core/values.ts'
import type { NativeModelProvider } from './model-providers.ts'

export interface NativeWorkConfiguration {
  readonly schema: 1
  readonly enabled: boolean
  readonly provider: string | null
  readonly model: string | null
  readonly agentPreset: string | null
  readonly reasoningEffort?: string
  readonly fullAccess: boolean
  readonly timeoutMs: number
}

export const DEFAULT_NATIVE_WORK_CONFIGURATION: NativeWorkConfiguration = Object.freeze({
  schema: 1, enabled: false, provider: null, model: null, agentPreset: null, fullAccess: false, timeoutMs: 300_000
})

const configurationKeys = ['schema', 'enabled', 'provider', 'model', 'agentPreset', 'fullAccess', 'timeoutMs'] as const

function validReference(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
    && !value.includes('..') && !value.includes('//') && !value.endsWith('/')
}

export function validateNativeWorkConfiguration(input: unknown): Readonly<NativeWorkConfiguration> {
  if (!isRecord(input) || !configurationKeys.every(key => Object.hasOwn(input, key))
    || Object.keys(input).some(key => !configurationKeys.some(expected => expected === key) && key !== 'reasoningEffort')
    || input.reasoningEffort !== undefined && !validReference(input.reasoningEffort)
    || input.schema !== 1 || typeof input.enabled !== 'boolean' || typeof input.fullAccess !== 'boolean'
    || input.provider !== null && !validReference(input.provider)
    || input.model !== null && !validReference(input.model)
    || input.agentPreset !== null && !validReference(input.agentPreset)
    || (input.provider === null) !== (input.model === null)
    || input.enabled && (input.provider === null || input.model === null || input.agentPreset === null)
    || typeof input.timeoutMs !== 'number' || !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs < 10 || input.timeoutMs > 300_000) {
    throw new TypeError('Invalid native work configuration')
  }
  return Object.freeze({ schema: 1, enabled: input.enabled, provider: input.provider as string | null,
    model: input.model as string | null, agentPreset: input.agentPreset as string | null,
    fullAccess: input.fullAccess, timeoutMs: input.timeoutMs,
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort as string }) })
}

export function validateNativeWorkModelReferences(
  input: unknown,
  providers: readonly NativeModelProvider[]
): Readonly<NativeWorkConfiguration> {
  const configuration = validateNativeWorkConfiguration(input)
  if (configuration.provider !== null) {
    const provider = providers.find(entry => entry.id === configuration.provider)
    if (!provider || !provider.models.some(model => model.id === configuration.model)
      || configuration.enabled && !provider.enabled) {
      throw new TypeError('Native work requires a configured model provider and model')
    }
  }
  return configuration
}
