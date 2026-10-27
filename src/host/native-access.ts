import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { FrameworkError, assert } from '../core/values.ts'
import { openReadonlySqliteStore } from '../storage/sqlite-readonly.ts'
import { DEFAULT_NATIVE_CHAT_AUTHORIZATION, LEGACY_NATIVE_CHAT_AUTHORIZATION,
  type NativeChatAuthorization, type NativeChatConfiguration } from './native-chat-configuration.ts'

export function nativeAuthorizationMode(authorization: NativeChatAuthorization): 'whitelist' | 'counted' {
  // Legacy quota documents remain readable; runtime access is governed by the whitelist.
  return 'whitelist'
}

export async function nativeAuthorizationFallback(directory: string) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const database = await lstat(join(directory, `native-chat.sqlite${suffix}`)).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    })
    if (database !== null) return { authorization: LEGACY_NATIVE_CHAT_AUTHORIZATION, source: 'missing-with-history' as const }
  }
  return { authorization: DEFAULT_NATIVE_CHAT_AUTHORIZATION, source: 'new-default' as const }
}

export function nativeAuthorizationProjection(authorization: NativeChatAuthorization,
  source: NonNullable<NativeChatConfiguration['authorizationSource']>) {
  return { ...authorization, mode: authorization.mode ?? 'counted', effectiveMode: 'whitelist', whitelistAvailable: true,
    modeSource: source === 'new-default' ? 'new-default-whitelist' : source === 'missing-with-history' ? 'missing-with-history'
      : authorization.mode === undefined ? 'legacy-counted' : 'explicit',
    authorizationDocumentPresent: source === 'stored', migrationRequired: source === 'missing-with-history',
    cancelAvailable: true, toolDelegationAvailable: true, taskDelegationAvailable: false }
}

export function nativeAuthorizationSignature(authorization: NativeChatAuthorization): string {
  return createHash('sha256').update(JSON.stringify(authorization)).digest('hex')
}

export function readNativeAuthorizationVersion(directory: string, version: string): string | null {
  let store: ReturnType<typeof openReadonlySqliteStore>
  try { store = openReadonlySqliteStore(join(directory, 'native-chat.sqlite')) }
  catch (error) {
    if (error instanceof FrameworkError && error.code === 'STORE_NOT_FOUND') return null
    throw error
  }
  try {
    return store.withSnapshot(() => {
      const record = store.read('native-chat.authorization', version)
      if (!record) return null
      const value = record.value
      assert(value && typeof value === 'object' && !Array.isArray(value)
        && typeof value.signature === 'string' && /^[a-f0-9]{64}$/.test(value.signature),
      'NATIVE_CHAT_AUTHORIZATION_INVALID', 'The authorization history is invalid.')
      return value.signature
    })
  } finally { store.close() }
}

export function nativeWhitelistCapabilities(configuration: NativeChatConfiguration, conversationId?: string): readonly string[] {
  return ['agent.submit', 'messaging.send', 'messaging.forward', 'agent.tools.delegate', ...(configuration.execution.cancelOnTimeout ? ['agent.cancel'] : [])]
}

export function nativeChatGrantId(configuration: NativeChatConfiguration, identity: string, conversationId: string,
  generation = 0): string {
  const whitelist = nativeAuthorizationMode(configuration.authorization) === 'whitelist'
  const input = whitelist ? [identity, configuration.authorization.version, configuration.revisions.access,
    configuration.revisions.execution, nativeWhitelistCapabilities(configuration), generation, conversationId]
    : [identity, configuration.authorization.version, conversationId]
  return `${whitelist ? 'native-chat-whitelist:' : 'native-chat:'}${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`
}

export function nativeChatGrantAvailable(grant: {
  readonly featureId: string; readonly active: boolean; readonly expiresAt: number | null
  readonly maxUses: Readonly<Record<string, number | null>>; readonly used: Readonly<Record<string, number>>
}): boolean {
  return grant.featureId === 'agent-relay' && grant.active && (grant.expiresAt === null || grant.expiresAt > Date.now())
    && ['agent.submit', 'messaging.send'].every(capability =>
      Object.hasOwn(grant.maxUses, capability) && Object.hasOwn(grant.used, capability)
        && Number.isSafeInteger(grant.used[capability]) && grant.used[capability] >= 0
        && (grant.maxUses[capability] === null || typeof grant.maxUses[capability] === 'number'
          && grant.maxUses[capability]! > grant.used[capability]))
}
