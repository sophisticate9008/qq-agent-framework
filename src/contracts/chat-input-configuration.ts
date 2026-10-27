import { isNativeAccessScope } from './native-access.ts'

export const CHAT_INPUT_PACKAGE_ID = 'chat-input'
export const CHAT_INPUT_CONFIGURATION_SCHEMA = 1 as const

export type ChatInputConfiguration = {
  readonly schema: 1
  readonly enabled: boolean
  readonly nicknames: readonly string[]
  readonly wakeOnMention: boolean
  readonly wakeOnReply: boolean
  readonly continuationMs: number
  readonly scopes: {
    readonly group: boolean
    readonly private: boolean
    readonly include: readonly string[]
    readonly exclude: readonly string[]
  }
}

export const DEFAULT_CHAT_INPUT_CONFIGURATION: ChatInputConfiguration = Object.freeze({ schema: 1,
  enabled: true, nicknames: Object.freeze([]), wakeOnMention: true, wakeOnReply: true, continuationMs: 90_000,
  scopes: Object.freeze({ group: true, private: true, include: Object.freeze([]), exclude: Object.freeze([]) }) })

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value, key))
}

export function validateChatInputConfiguration(input: unknown): ChatInputConfiguration {
  const invalid = (): never => { throw new TypeError('Invalid chat input configuration') }
  if (!record(input) || !keys(input, ['schema', 'enabled', 'nicknames', 'wakeOnMention', 'wakeOnReply', 'continuationMs', 'scopes'])
    || input.schema !== 1 || typeof input.enabled !== 'boolean' || typeof input.wakeOnMention !== 'boolean'
    || typeof input.wakeOnReply !== 'boolean' || typeof input.continuationMs !== 'number'
    || !Number.isSafeInteger(input.continuationMs) || input.continuationMs < 0 || input.continuationMs > 300_000
    || !Array.isArray(input.nicknames) || input.nicknames.length > 16
    || !input.nicknames.every(name => typeof name === 'string' && name.trim() === name && name.length > 0
      && name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(name))
    || new Set(input.nicknames.map(name => String(name).toLocaleLowerCase())).size !== input.nicknames.length
    || !record(input.scopes) || !keys(input.scopes, ['group', 'private', 'include', 'exclude'])) return invalid()
  const scopes = input.scopes
  if (typeof scopes.group !== 'boolean' || typeof scopes.private !== 'boolean') return invalid()
  const list = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length <= 256
    && new Set(value).size === value.length && value.every(scope => isNativeAccessScope(scope))
  if (!list(scopes.include) || !list(scopes.exclude)) return invalid()
  return Object.freeze({ schema: 1, enabled: input.enabled, nicknames: Object.freeze([...input.nicknames] as string[]),
    wakeOnMention: input.wakeOnMention, wakeOnReply: input.wakeOnReply, continuationMs: input.continuationMs,
    scopes: Object.freeze({ group: scopes.group, private: scopes.private,
      include: Object.freeze([...scopes.include]), exclude: Object.freeze([...scopes.exclude]) }) })
}

export interface EffectiveChatInputConfiguration {
  readonly enabled: boolean
  readonly reason: 'active' | 'disabled' | 'kind-disabled' | 'not-included' | 'excluded'
  readonly names: readonly string[]
  readonly wakeOnMention: boolean
  readonly wakeOnReply: boolean
  readonly continuationMs: number
}

/** Legacy switches and secondary scope lists are ignored; access is enforced by the whitelist. */
export function resolveChatInputConfiguration(configuration: ChatInputConfiguration, conversationId: string,
  personaName?: string): EffectiveChatInputConfiguration {
  const current = validateChatInputConfiguration(configuration)
  if (!isNativeAccessScope(conversationId)) throw new TypeError('A canonical conversation is required')
  const candidates = [...current.nicknames, ...(typeof personaName === 'string' && personaName.trim().length > 0 ? [personaName.trim()] : [])]
  const names = candidates.filter((name, index) => candidates.findIndex(candidate => candidate.toLocaleLowerCase() === name.toLocaleLowerCase()) === index)
    .filter(name => name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(name)).slice(0, 16)
  return Object.freeze({ enabled: true, reason: 'active', names: Object.freeze(names), wakeOnMention: true,
    wakeOnReply: current.wakeOnReply, continuationMs: current.continuationMs })
}
