import { createHash } from 'node:crypto'
import { isChatSessionDefinition } from '../contracts/chat-session.ts'
import { FrameworkError, reference, snapshot } from '../core/values.ts'
import { validateAdapterEndpoint } from './adapter-configuration.ts'
import { validateChatPersona } from './chat-plans.ts'
import { json, object } from './data.ts'
import type { NativeConfigurationBaseline, NativeConfigurationCandidate } from './native-chat-compatibility.ts'
import { createNativePersonaIdentity, type NativePersonaIdentity } from './native-persona-identity.ts'
import { listMigrationPlans } from './native-session-migration-state.ts'
import { readSessionMetadata } from './sessions.ts'
import type { DurableCasMutation, DurableStore, StoredRecord } from './types.ts'

export const NATIVE_PERSONA_SCOPES_NAMESPACE = 'native-chat.persona-scopes'
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export interface NativeChatPersonaMetadata {
  readonly schema: 1
  readonly nativeId: string
  readonly contentVersion: string
  readonly scopeVersion: string
  readonly source?: string
  readonly migrationId?: string
}

export interface NativeChatConfigurationState {
  /** Stable anchor for existing sessions, authorization lineage and tool scope evidence. */
  readonly identity: string
  readonly configurationFingerprint: string
  readonly endpoint: string
  readonly contentIdentity: NativePersonaIdentity
  readonly personaMetadata: NativeChatPersonaMetadata
  readonly personaScope: { readonly id: string; readonly version: string }
}

function failure(code: string): never {
  throw new FrameworkError(code, 'Persisted chat configuration authority could not be verified.')
}

/** Uses the existing serialization so legacy session-definition identities remain readable. */
export function nativeConfigurationFingerprint(candidate: NativeConfigurationCandidate): string {
  return createHash('sha256').update(JSON.stringify({ definition: candidate.definition,
    endpoint: candidate.endpoint, bindings: candidate.bindings })).digest('hex')
}

function personaMetadata(record: StoredRecord): NativeChatPersonaMetadata {
  const value = object(record.value)
  if (value.schema !== 1 || !reference(value.nativeId) || !validHash(value.contentVersion) || !validHash(value.scopeVersion)
    || !Object.keys(value).every(key => ['schema', 'nativeId', 'contentVersion', 'scopeVersion', 'source', 'migrationId'].includes(key))
    || value.source !== undefined && (typeof value.source !== 'string' || value.source.length > 128)
    || value.migrationId !== undefined && !reference(value.migrationId)) failure('NATIVE_CHAT_PERSONA_IDENTITY_CONFLICT')
  return value as unknown as NativeChatPersonaMetadata
}

function hasSessions(store: Pick<DurableStore, 'list'>): boolean {
  let after: string | undefined
  for (;;) {
    const page = readSessionMetadata(store, { limit: 1_000, ...(after === undefined ? {} : { after }) })
    if (page.some(binding => binding.state !== 'retired')) return true
    if (page.length < 1_000) return false
    after = page[page.length - 1].conversationId
  }
}

/** Prepare mutations for the atomic configuration-and-baseline writer. Do not commit these alone. */
export function prepareNativeChatConfigurationState(store: Pick<DurableStore, 'read' | 'list'>, candidate: NativeConfigurationCandidate,
  baseline: NativeConfigurationBaseline): { state: NativeChatConfigurationState; mutations: readonly DurableCasMutation[] } {
  if (!candidate.definition || !isChatSessionDefinition(candidate.definition) || !candidate.persona) failure('NATIVE_CHAT_CONFIGURATION_INCOMPLETE')
  const persona = validateChatPersona(candidate.persona)
  if (candidate.definition.personaId !== persona.id || candidate.definition.persona.identity !== persona.identity
    || candidate.definition.persona.style !== persona.style) failure('NATIVE_CHAT_CONFIGURATION_INCOMPLETE')
  const endpoint = validateAdapterEndpoint(candidate.endpoint)
  if (endpoint === '' || endpoint !== candidate.endpoint) failure('NATIVE_CHAT_CONFIGURATION_INCOMPLETE')
  const configurationFingerprint = nativeConfigurationFingerprint(candidate)
  const priorDefinition = store.read('native-chat.meta', 'session-definition')
  const priorPersona = store.read('native-chat.meta', 'persona-identity')
  const priorValue = priorDefinition ? object(priorDefinition.value) : null
  if (priorValue && (!validHash(priorValue.identity)
    || !Object.keys(priorValue).every(key => ['identity', 'configurationFingerprint', 'endpoint'].includes(key))
    || Object.hasOwn(priorValue, 'configurationFingerprint') !== Object.hasOwn(priorValue, 'endpoint')
    || Object.hasOwn(priorValue, 'configurationFingerprint') && (!validHash(priorValue.configurationFingerprint)
      || typeof priorValue.endpoint !== 'string' || priorValue.endpoint === ''
      || validateAdapterEndpoint(priorValue.endpoint) !== priorValue.endpoint))) failure('NATIVE_CHAT_SESSION_CONFIGURATION_INVALID')
  const originalPersona = priorPersona ? personaMetadata(priorPersona) : null
  const persistedSessions = hasSessions(store)
  const legacyData = !priorPersona && priorDefinition !== null
    && (store.list('host.sessions', { limit: 1 }).length > 0 || store.list('outbox', { limit: 1 }).length > 0)
  if (!priorDefinition && (persistedSessions || priorPersona || store.list('outbox', { limit: 1 }).length > 0)) {
    failure('NATIVE_CHAT_SESSION_CONFIGURATION_INVALID')
  }
  if (listMigrationPlans(store).some(plan => ['committing', 'unknown', 'partial'].includes(plan.state))) {
    failure('NATIVE_SESSION_MIGRATION_RECONCILIATION_REQUIRED')
  }
  // Old records contain only a configuration hash. A matching hash or its recorded
  // baseline proves the endpoint; a changed configuration alone cannot establish it.
  const originalEndpoint = priorValue?.endpoint ?? (baseline.state === 'available' ? baseline.values?.endpoint : null)
    ?? (priorValue?.identity === configurationFingerprint ? endpoint : null)
  if (priorValue && originalEndpoint === null) failure('NATIVE_CHAT_SESSION_ENDPOINT_UNVERIFIED')
  if (originalEndpoint !== null && originalEndpoint !== endpoint) failure('NATIVE_CHAT_SESSION_ENDPOINT_CONFLICT')
  if (legacyData && priorValue?.identity !== configurationFingerprint) failure('NATIVE_CHAT_PERSONA_VERSION_MIGRATION_REQUIRED')
  const identity = priorValue ? String(priorValue.identity) : configurationFingerprint
  const contentIdentity = createNativePersonaIdentity(persona)
  const mutations: DurableCasMutation[] = []
  const addScope = (nativeId: string, scopeVersion: string): StoredRecord | null => {
    const saved = store.read(NATIVE_PERSONA_SCOPES_NAMESPACE, nativeId)
    if (saved) {
      const value = object(saved.value)
      if (value.schema !== 1 || value.nativeId !== nativeId || !validHash(value.scopeVersion)
        || Object.keys(value).length !== 3 || value.scopeVersion !== scopeVersion) failure('NATIVE_CHAT_PERSONA_IDENTITY_CONFLICT')
    }
    mutations.push(saved ? { kind: 'check', namespace: NATIVE_PERSONA_SCOPES_NAMESPACE, key: nativeId, expectedRevision: saved.revision }
      : { kind: 'write', namespace: NATIVE_PERSONA_SCOPES_NAMESPACE, key: nativeId, expectedRevision: null,
        value: { schema: 1, nativeId, scopeVersion } })
    return saved
  }
  if (originalPersona && originalPersona.nativeId !== persona.id) addScope(originalPersona.nativeId, originalPersona.scopeVersion)
  const savedScope = store.read(NATIVE_PERSONA_SCOPES_NAMESPACE, persona.id)
  const scopeValue = savedScope ? object(savedScope.value) : null
  if (scopeValue && (scopeValue.schema !== 1 || scopeValue.nativeId !== persona.id || !validHash(scopeValue.scopeVersion)
    || Object.keys(scopeValue).length !== 3)) failure('NATIVE_CHAT_PERSONA_IDENTITY_CONFLICT')
  const scopeVersion = originalPersona?.nativeId === persona.id ? originalPersona.scopeVersion
    : scopeValue ? String(scopeValue.scopeVersion) : legacyData
      ? createHash('sha256').update(JSON.stringify(candidate.definition)).digest('hex') : contentIdentity.version
  addScope(persona.id, scopeVersion)
  const metadata: NativeChatPersonaMetadata = originalPersona?.nativeId === persona.id
    ? { ...originalPersona, contentVersion: contentIdentity.version }
    : { schema: 1, nativeId: persona.id, contentVersion: contentIdentity.version, scopeVersion,
      source: legacyData ? 'preserved-v15-definition-version' : 'persona-scope-v1' }
  const metadataMutation = (key: string, previous: StoredRecord | null, value: unknown): DurableCasMutation =>
    previous && JSON.stringify(previous.value) === JSON.stringify(value)
      ? { kind: 'check', namespace: 'native-chat.meta', key, expectedRevision: previous.revision }
      : { kind: 'write', namespace: 'native-chat.meta', key, expectedRevision: previous?.revision ?? null, value: json(value) }
  mutations.push(metadataMutation('persona-identity', priorPersona, metadata),
    metadataMutation('session-definition', priorDefinition, { identity, configurationFingerprint, endpoint }))
  return { state: snapshot({ identity, configurationFingerprint, endpoint, contentIdentity, personaMetadata: metadata,
    personaScope: { id: contentIdentity.contextId, version: scopeVersion } }), mutations }
}

/** Read-only verification; configuration edits do not require a new session or a resource alias. */
export function inspectNativeChatConfigurationState(store: Pick<DurableStore, 'read' | 'list'>,
  candidate: NativeConfigurationCandidate, baseline: NativeConfigurationBaseline): NativeChatConfigurationState {
  return prepareNativeChatConfigurationState(store, candidate, baseline).state
}
