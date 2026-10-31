import { DEFAULT_CHAT_INPUT_CONFIGURATION, validateChatInputConfiguration } from './chat-input-configuration.ts'

export interface PersonaWake {
  readonly nicknames: readonly string[]
  readonly wakeOnReply: boolean
  readonly continuationMs: number
  readonly replyExtensionMs?: number
  readonly groupWakeProbabilityPercent?: number
}

export const DEFAULT_PERSONA_WAKE: PersonaWake = Object.freeze({
  nicknames: Object.freeze([]), wakeOnReply: true, continuationMs: 90_000, replyExtensionMs: 500, groupWakeProbabilityPercent: 1
})

export function validatePersonaWake(value: unknown): PersonaWake {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['nicknames', 'wakeOnReply', 'continuationMs', 'replyExtensionMs', 'groupWakeProbabilityPercent'].includes(key))
    || !['nicknames', 'wakeOnReply', 'continuationMs'].every(key => Object.hasOwn(value, key))) {
    throw new TypeError('Invalid persona wake configuration')
  }
  const configuration = validateChatInputConfiguration({ ...DEFAULT_CHAT_INPUT_CONFIGURATION, ...value })
  return Object.freeze({ nicknames: configuration.nicknames, wakeOnReply: configuration.wakeOnReply,
    continuationMs: configuration.continuationMs,
    ...(Object.hasOwn(value, 'replyExtensionMs') ? { replyExtensionMs: configuration.replyExtensionMs ?? 500 } : {}),
    ...(Object.hasOwn(value, 'groupWakeProbabilityPercent') ? { groupWakeProbabilityPercent: configuration.groupWakeProbabilityPercent ?? 1 } : {}) })
}

export function isPersonaWake(value: unknown): value is PersonaWake {
  try { validatePersonaWake(value); return true } catch { return false }
}
