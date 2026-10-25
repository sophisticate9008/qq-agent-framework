import { validateAdapterEndpoint } from './adapter-configuration.ts'
import { validModelProviderApi, type ModelProviderApi, type ModelProviderType } from './model-provider-protocols.ts'

export type { ModelProviderType, ModelProviderApi } from './model-provider-protocols.ts'

export interface NamedModel {
  readonly id: string
  readonly name: string
}

export interface NativeModelProvider {
  readonly id: string
  readonly name: string
  readonly type?: ModelProviderType
  readonly api?: ModelProviderApi
  readonly allowInsecureHttp?: boolean
  readonly baseUrl: string
  readonly enabled: boolean
  readonly apiKey: string
  readonly models: readonly NamedModel[]
}

export interface PublicModelProvider extends Omit<NativeModelProvider, 'apiKey'> {
  readonly apiKeyConfigured: boolean
}

const PROVIDER_KEYS = ['id', 'name', 'baseUrl', 'enabled', 'models'] as const
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
  const parsed = keys(value, [...PROVIDER_KEYS, 'apiKey'], ['type', 'api', 'allowInsecureHttp'])
  if (Object.hasOwn(parsed, 'type') && parsed.type !== 'openai' && parsed.type !== 'anthropic'
    || typeof parsed.enabled !== 'boolean') return invalid()
  if (Object.hasOwn(parsed, 'api') ? !validModelProviderApi(parsed.api) : parsed.type === undefined) return invalid()
  if (parsed.api !== undefined && parsed.type !== undefined
    && (parsed.type === 'openai' ? !String(parsed.api).startsWith('openai-') : parsed.api !== 'anthropic-messages')) return invalid()
  if (Object.hasOwn(parsed, 'allowInsecureHttp') && typeof parsed.allowInsecureHttp !== 'boolean') return invalid()
  let baseUrl: string
  try {
    if (parsed.allowInsecureHttp === true && typeof parsed.baseUrl === 'string' && parsed.baseUrl.startsWith('http://')) {
      validateAdapterEndpoint(parsed.baseUrl.replace(/^http:/, 'https:'))
      baseUrl = parsed.baseUrl
    } else baseUrl = validateAdapterEndpoint(parsed.baseUrl)
  } catch {
    return invalid()
  }
  if (baseUrl === '') return invalid()
  const models = uniqueEntries(parsed.models, entry => {
    const model = keys(entry, ['id', 'name'])
    return Object.freeze({ id: identifier(model.id, true), name: name(model.name) })
  })
  return Object.freeze({
    id: identifier(parsed.id), name: name(parsed.name), baseUrl,
    ...(parsed.type === undefined ? {} : { type: parsed.type as ModelProviderType }),
    ...(parsed.api === undefined ? {} : { api: parsed.api as string }),
    ...(parsed.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: parsed.allowInsecureHttp as boolean }),
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
    const parsed = keys(entry, PROVIDER_KEYS, ['type', 'apiKey', 'clearApiKey', 'api', 'allowInsecureHttp'])
    const nextKey = Object.hasOwn(parsed, 'apiKey') ? apiKey(parsed.apiKey) : ''
    if (Object.hasOwn(parsed, 'clearApiKey') && typeof parsed.clearApiKey !== 'boolean'
      || parsed.clearApiKey === true && nextKey !== '') return invalid()
    return {
      id: parsed.id, name: parsed.name, baseUrl: parsed.baseUrl,
      ...(Object.hasOwn(parsed, 'type') ? { type: parsed.type } : {}),
      enabled: parsed.enabled, models: parsed.models,
      ...(Object.hasOwn(parsed, 'api') ? { api: parsed.api } : {}),
      ...(Object.hasOwn(parsed, 'allowInsecureHttp') ? { allowInsecureHttp: parsed.allowInsecureHttp } : {}),
      apiKey: parsed.clearApiKey === true ? '' : nextKey || previous.get(identifier(parsed.id))?.apiKey || ''
    }
  }))
}

export function publicModelProviders(value: readonly NativeModelProvider[]): readonly PublicModelProvider[] {
  return Object.freeze(validateModelProviders(value).map(entry => Object.freeze({
    id: entry.id, name: entry.name, baseUrl: entry.baseUrl,
    ...(entry.type === undefined ? {} : { type: entry.type }),
    enabled: entry.enabled, apiKeyConfigured: entry.apiKey !== '', models: entry.models,
    ...(entry.api === undefined ? {} : { api: entry.api }),
    ...(entry.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: entry.allowInsecureHttp })
  })))
}
