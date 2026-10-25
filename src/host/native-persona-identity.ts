import { snapshot } from '../core/values.ts'
import { validateChatPersona, type ChatPersona } from './chat-plans.ts'
import { digest } from './data.ts'

export interface NativePersonaIdentity {
  readonly schema: 1
  readonly nativeId: string
  readonly contextId: string
  readonly version: string
  readonly reference: string
  readonly persona: {
    readonly id: string
    readonly version: string
    readonly name: string
    readonly identity: string
    readonly style: string
  }
}

export function createNativePersonaIdentity(input: ChatPersona): NativePersonaIdentity {
  const persona = validateChatPersona(input)
  const contextId = `native-${digest(persona.id).slice(0, 32)}`
  const version = digest({ schema: 1, id: persona.id, name: persona.name, identity: persona.identity, style: persona.style })
  return snapshot({ schema: 1, nativeId: persona.id, contextId, version, reference: `${contextId}@${version}`,
    persona: { id: contextId, version, name: persona.name, identity: persona.identity, style: persona.style } })
}

export function inspectNativePersonaScope(identity: NativePersonaIdentity, existingVersion: string | null) {
  return snapshot({ identity,
    migrationRequired: existingVersion !== null && existingVersion !== identity.version,
    previousVersion: existingVersion,
    automaticAliasAvailable: false as const })
}
