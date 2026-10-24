import { validateAdapterEndpoint } from './adapter-configuration.ts'

export type ModelProviderType = 'openai' | 'anthropic'

export interface NamedModel {
  readonly id: string
  readonly name: string
}

export interface NativeModelProvider {
  readonly id: string
  readonly name: string
  readonly type: ModelProviderType
  readonly baseUrl: string
  readonly enabled: boolean
  readonly apiKey: string
  readonly models: readonly NamedModel[]
}

export interface PublicModelProvider extends Omit<NativeModelProvider, 'apiKey'> {
  readonly apiKeyConfigured: boolean
}

const PROVIDER_KEYS = ['id', 'name', 'type', 'baseUrl', 'enabled', 'models'] as const
const MAX_ENTRIES = 128

function invalid(): never {
  throw new TypeError('Invalid model providers')
}

function keys(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const parsed = value as Record<string, unknown>
  if (!required.every(key => Object.hasOwn(parsed, key))
    || !Object.keys(parsed).every(key => required.includes(key) || optional.includes(key))) return invalid()
  return parsed
}

function identifier(value: unknown, model = false): string {
  const pattern = model ? /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/ : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
  if (typeof value !== 'string' || !pattern.test(value)
    || value.includes('..') || value.includes('//') || value.endsWith('/')) return invalid()
  return value
}

function name(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || value.trim() === ''
    || /[\u0000-\u001f\u007f]/.test(value)) return invalid()
  return value
}

function apiKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4_096 || !/^[\x20-\x7e]*$/.test(value)) return invalid()
  return value
}

function uniqueEntries<Value extends { readonly id: string; readonly name: string }>(
  value: unknown,
  validate: (entry: unknown) => Value
): readonly Value[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) return invalid()
  const entries = value.map(validate)
  if (new Set(entries.map(entry => entry.id)).size !== entries.length
    || new Set(entries.map(entry => entry.name)).size !== entries.length) return invalid()
  return Object.freeze(entries)
}

function provider(value: unknown): NativeModelProvider {
  const parsed = keys(value, [...PROVIDER_KEYS, 'apiKey'])
  if (parsed.type !== 'openai' && parsed.type !== 'anthropic' || typeof parsed.enabled !== 'boolean') return invalid()
  let baseUrl: string
  try {
    baseUrl = validateAdapterEndpoint(parsed.baseUrl)
  } catch {
    return invalid()
  }
  if (baseUrl === '') return invalid()
  const models = uniqueEntries(parsed.models, entry => {
    const model = keys(entry, ['id', 'name'])
    return Object.freeze({ id: identifier(model.id, true), name: name(model.name) })
  })
  return Object.freeze({
    id: identifier(parsed.id), name: name(parsed.name), type: parsed.type, baseUrl,
    enabled: parsed.enabled, apiKey: apiKey(parsed.apiKey), models
  })
}

export function validateModelProviders(value: unknown): readonly NativeModelProvider[] {
  return uniqueEntries(value, provider)
}

export function updateModelProviders(
  current: readonly NativeModelProvider[],
  value: unknown
): readonly NativeModelProvider[] {
  const previous = new Map(validateModelProviders(current).map(entry => [entry.id, entry]))
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) return invalid()
  return validateModelProviders(value.map(entry => {
    const parsed = keys(entry, PROVIDER_KEYS, ['apiKey', 'clearApiKey'])
    const nextKey = Object.hasOwn(parsed, 'apiKey') ? apiKey(parsed.apiKey) : ''
    if (Object.hasOwn(parsed, 'clearApiKey') && typeof parsed.clearApiKey !== 'boolean'
      || parsed.clearApiKey === true && nextKey !== '') return invalid()
    return {
      id: parsed.id, name: parsed.name, type: parsed.type, baseUrl: parsed.baseUrl,
      enabled: parsed.enabled, models: parsed.models,
      apiKey: parsed.clearApiKey === true ? '' : nextKey || previous.get(identifier(parsed.id))?.apiKey || ''
    }
  }))
}

export function publicModelProviders(value: readonly NativeModelProvider[]): readonly PublicModelProvider[] {
  return Object.freeze(validateModelProviders(value).map(entry => Object.freeze({
    id: entry.id, name: entry.name, type: entry.type, baseUrl: entry.baseUrl,
    enabled: entry.enabled, apiKeyConfigured: entry.apiKey !== '', models: entry.models
  })))
}
