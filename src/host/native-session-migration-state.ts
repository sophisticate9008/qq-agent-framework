import { validMigrationTargetSelection, type MigrationTargetSelection } from '../contracts/dsh-session-migration.ts'
import { createHash } from 'node:crypto'
import { FrameworkError, reference, snapshot } from '../core/values.ts'
import { digest, json, object, records } from './data.ts'
import { nativeAuthorizationMode, nativeChatGrantId, nativeWhitelistCapabilities } from './native-access.ts'
import type { ChatPersona } from './chat-plans.ts'
import { createNativePersonaIdentity } from './native-persona-identity.ts'
import type { NativeChatConfiguration } from './native-chat-configuration.ts'
import type { DurableStore, StoredRecord } from './types.ts'
import type { JsonObject } from '../core/types.ts'

export const NATIVE_SESSION_MIGRATIONS = 'native-chat.session-migrations'
export const NATIVE_SESSION_ARCHIVES = 'native-chat.session-archives'
const LINEAGES = 'native-chat.migration-lineages'

export type NativeSessionMigrationState = 'available' | 'blocked' | 'committing' | 'unknown' | 'partial' | 'completed'
export interface NativeSessionPersonaTransition {
  readonly sourceRevision: number
  readonly sourceValue: JsonObject
  readonly targetValue: JsonObject
}
export interface NativeSessionMigrationBinding {
  readonly migrationId: string
  readonly conversationId: string
  readonly sourceSessionId: string
  readonly sourceGeneration: number
  readonly sourceRevision: number
  readonly sourceRequestId: string | null
  readonly expectedPreset: string
  readonly targetPreset: string
  readonly targetSelection?: MigrationTargetSelection
  readonly issuerEpoch: string
  readonly sourceCursor: number
  readonly sourceDigest: string
  readonly targetRevision: string
  readonly state: 'available' | 'requested' | 'unknown' | 'rejected' | 'confirmed' | 'bound'
  readonly childSessionId: string | null
}
export interface NativeSessionMigrationPlan {
  readonly schema: 1
  readonly migrationId: string
  readonly revision: string
  readonly revisions: Readonly<Record<string, string>>
  readonly sourceIdentity: string
  readonly targetIdentity: string
  readonly sourceMetaRevision: number
  readonly authorizationIdentity: string
  readonly policyDigest: string
  readonly personaTransition?: NativeSessionPersonaTransition
  readonly state: NativeSessionMigrationState
  readonly createdAt: number
  readonly bindings: readonly NativeSessionMigrationBinding[]
  readonly missingReasons: readonly string[]
}
export interface NativeSessionMigrationResult {
  readonly schema: 1
  readonly state: 'available' | 'blocked' | 'unknown' | 'partial' | 'completed'
  readonly migrationId: string | null
  readonly revision: string | null
  readonly revisions: Readonly<Record<string, string>>
  readonly bindings: readonly NativeSessionMigrationBinding[]
  readonly missingReasons: readonly string[]
}

export function migrationFailure(code: string): never {
  throw new FrameworkError(code, 'Session migration requires explicit verified reconciliation.')
}

function requireMigration(condition: unknown): asserts condition {
  if (!condition) migrationFailure('NATIVE_SESSION_MIGRATION_INVALID')
}

const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function migrationRevision(plan: Omit<NativeSessionMigrationPlan, 'revision'>): string {
  return digest({ migrationId: plan.migrationId, revisions: plan.revisions, sourceIdentity: plan.sourceIdentity,
    targetIdentity: plan.targetIdentity, sourceMetaRevision: plan.sourceMetaRevision,
    authorizationIdentity: plan.authorizationIdentity, policyDigest: plan.policyDigest, createdAt: plan.createdAt,
    ...(plan.personaTransition ? { personaTransition: plan.personaTransition } : {}),
    bindings: plan.bindings.map(({ state, childSessionId, ...constraints }) => constraints) })
}

export function readMigrationPlan(record: StoredRecord): NativeSessionMigrationPlan {
  const value = object(record.value)
  const { checksum, ...plan } = value
  requireMigration(value.schema === 1 && reference(value.migrationId) && value.migrationId === record.key
    && hash(value.revision) && hash(value.sourceIdentity) && hash(value.targetIdentity)
    && hash(value.authorizationIdentity) && hash(value.policyDigest) && integer(value.sourceMetaRevision)
    && value.sourceMetaRevision > 0 && integer(value.createdAt) && checksum === digest(plan)
    && ['available', 'blocked', 'committing', 'unknown', 'partial', 'completed'].includes(String(value.state))
    && Array.isArray(value.bindings) && value.bindings.length > 0 && value.bindings.length <= 128
    && Array.isArray(value.missingReasons) && value.missingReasons.length <= 32
    && value.missingReasons.every(reason => typeof reason === 'string' && /^[a-z0-9_]{1,128}$/.test(reason)))
  const revisions = object(value.revisions)
  requireMigration(Object.keys(revisions).length > 0 && Object.keys(revisions).length <= 32
    && Object.values(revisions).every(revision => typeof revision === 'string' && revision.length > 0 && revision.length <= 256))
  const conversations = new Set<string>()
  const sources = new Set<string>()
  const children = new Set<string>()
  for (const [index, raw] of value.bindings.entries()) {
    const binding = object(raw)
    requireMigration(binding.migrationId === `${value.migrationId}:${index}` && reference(binding.conversationId) && reference(binding.sourceSessionId)
      && reference(binding.expectedPreset) && reference(binding.targetPreset) && reference(binding.issuerEpoch)
      && integer(binding.sourceGeneration) && binding.sourceGeneration > 0 && binding.sourceGeneration < Number.MAX_SAFE_INTEGER
      && integer(binding.sourceRevision) && binding.sourceRevision > 0 && integer(binding.sourceCursor)
      && (binding.targetSelection === undefined || validMigrationTargetSelection(binding.targetSelection))
      && hash(binding.sourceDigest) && hash(binding.targetRevision)
      && (binding.sourceRequestId === null || reference(binding.sourceRequestId))
      && ['available', 'requested', 'unknown', 'rejected', 'confirmed', 'bound'].includes(String(binding.state))
      && (binding.childSessionId === null || reference(binding.childSessionId) && binding.childSessionId !== binding.sourceSessionId)
      && (!['confirmed', 'bound'].includes(String(binding.state)) || reference(binding.childSessionId))
      && !conversations.has(binding.conversationId) && !sources.has(binding.sourceSessionId))
    conversations.add(binding.conversationId)
    sources.add(binding.sourceSessionId)
    if (typeof binding.childSessionId === 'string') {
      requireMigration(!children.has(binding.childSessionId))
      children.add(binding.childSessionId)
    }
  }
  requireMigration([...children].every(child => !sources.has(child)))
  if (Object.hasOwn(value, 'personaTransition')) {
    const transition = object(value.personaTransition)
    requireMigration(Object.keys(transition).length === 3 && integer(transition.sourceRevision) && transition.sourceRevision > 0)
    const source = personaMetadata(transition.sourceValue)
    const target = personaMetadata(transition.targetValue)
    requireMigration(source.nativeId === target.nativeId && source.contentVersion !== target.contentVersion
      && target.contentVersion === target.scopeVersion && target.migrationId === value.migrationId
      && digest(target) === digest({ ...source, contentVersion: target.contentVersion, scopeVersion: target.contentVersion,
        source: 'persona-content-migration-v1', migrationId: value.migrationId }))
  }
  const result = plan as unknown as NativeSessionMigrationPlan
  requireMigration(result.revision === migrationRevision(result))
  return snapshot(result)
}

export function listMigrationPlans(store: Pick<DurableStore, 'list'>): readonly NativeSessionMigrationPlan[] {
  const batch = store.list(NATIVE_SESSION_MIGRATIONS, { limit: 65 })
  if (batch.length > 64) migrationFailure('NATIVE_SESSION_MIGRATION_CAPACITY')
  return batch.map(readMigrationPlan)
}

export function writeMigrationPlan(store: DurableStore, plan: NativeSessionMigrationPlan,
  expectedRevision: number | null): StoredRecord {
  return store.write(NATIVE_SESSION_MIGRATIONS, plan.migrationId, json({ ...plan, checksum: digest(plan) }), { expectedRevision })
}

export function migrationResult(plan: NativeSessionMigrationPlan): NativeSessionMigrationResult {
  return snapshot({ schema: 1, state: plan.state === 'committing' ? 'unknown' : plan.state,
    migrationId: plan.migrationId, revision: plan.revision, revisions: plan.revisions,
    bindings: plan.bindings, missingReasons: plan.missingReasons })
}

export function readMigrationAuthorizationIdentity(store: Pick<DurableStore, 'read'>, identity: string): string {
  const lineage = store.read(LINEAGES, identity)
  if (!lineage) return identity
  const value = object(lineage.value)
  requireMigration(value.schema === 1 && value.identity === identity && hash(value.authorizationIdentity) && reference(value.migrationId))
  const ledger = store.read(NATIVE_SESSION_MIGRATIONS, value.migrationId)
  requireMigration(ledger)
  const plan = readMigrationPlan(ledger)
  requireMigration(plan.targetIdentity === identity && plan.authorizationIdentity === value.authorizationIdentity
    && plan.state === 'completed' && plan.bindings.every(binding => binding.state === 'bound'))
  return value.authorizationIdentity
}

export function writeMigrationLineage(store: DurableStore, plan: NativeSessionMigrationPlan): void {
  const value = { schema: 1, identity: plan.targetIdentity, authorizationIdentity: plan.authorizationIdentity,
    migrationId: plan.migrationId }
  const previous = store.read(LINEAGES, plan.targetIdentity)
  if (previous) requireMigration(digest(previous.value) === digest(value))
  else store.write(LINEAGES, plan.targetIdentity, value, { expectedRevision: null })
}

function personaMetadata(value: unknown): JsonObject {
  const metadata = object(value)
  requireMigration(metadata.schema === 1 && reference(metadata.nativeId) && hash(metadata.contentVersion) && hash(metadata.scopeVersion)
    && Object.keys(metadata).every(key => ['schema', 'nativeId', 'contentVersion', 'scopeVersion', 'source', 'migrationId'].includes(key))
    && (metadata.source === undefined || typeof metadata.source === 'string' && metadata.source.length <= 128)
    && (metadata.migrationId === undefined || reference(metadata.migrationId)))
  return metadata
}

export function prepareMigrationPersonaTransition(store: DurableStore, source: ChatPersona, target: ChatPersona,
  migrationId: string): NativeSessionPersonaTransition | undefined {
  const current = store.read('native-chat.meta', 'persona-identity')
  requireMigration(current)
  const original = personaMetadata(current.value)
  const from = createNativePersonaIdentity(source)
  const to = createNativePersonaIdentity(target)
  requireMigration(from.nativeId === to.nativeId && original.nativeId === from.nativeId && original.contentVersion === from.version)
  if (from.version === to.version) return undefined
  return snapshot({ sourceRevision: current.revision, sourceValue: original,
    targetValue: { ...original, contentVersion: to.version, scopeVersion: to.version,
      source: 'persona-content-migration-v1', migrationId } })
}

function personaAnchor(record: StoredRecord, transition: NativeSessionPersonaTransition): 'source' | 'target' {
  if (record.revision === transition.sourceRevision && digest(record.value) === digest(transition.sourceValue)) return 'source'
  if (record.revision > transition.sourceRevision && digest(record.value) === digest(transition.targetValue)) return 'target'
  migrationFailure('NATIVE_SESSION_MIGRATION_PERSONA_CHANGED')
}

export function verifyMigrationPersona(store: DurableStore, plan: NativeSessionMigrationPlan): void {
  if (!plan.personaTransition) return
  const current = store.read('native-chat.meta', 'persona-identity')
  if (!current) migrationFailure('NATIVE_SESSION_MIGRATION_PERSONA_CHANGED')
  if (personaAnchor(current, plan.personaTransition) === 'target' && !plan.bindings.every(binding => binding.state === 'bound')) {
    migrationFailure('NATIVE_SESSION_MIGRATION_PERSONA_CHANGED')
  }
}

export function writeMigrationPersona(store: DurableStore, plan: NativeSessionMigrationPlan): void {
  if (!plan.personaTransition) return
  requireMigration(plan.bindings.every(binding => binding.state === 'bound'))
  const current = store.read('native-chat.meta', 'persona-identity')
  if (!current) migrationFailure('NATIVE_SESSION_MIGRATION_PERSONA_CHANGED')
  if (personaAnchor(current, plan.personaTransition) === 'source') store.write('native-chat.meta', 'persona-identity',
    plan.personaTransition.targetValue, { expectedRevision: plan.personaTransition.sourceRevision })
}

export function migrationPersonaScope(transition: NativeSessionPersonaTransition | undefined): { id: string; version: string } | undefined {
  return transition ? { id: `native-${digest(transition.sourceValue.nativeId).slice(0, 32)}`,
    version: String(transition.sourceValue.scopeVersion) } : undefined
}

export function migrationPolicyDigest(store: DurableStore, transition?: NativeSessionPersonaTransition): string {
  const values: unknown[] = []
  for (const namespace of ['policy.grants', 'policy.meta', 'native-chat.authorization', 'native-chat.whitelist-policy', 'native-chat.meta']) {
    for (const record of records(store, namespace)) {
      if (namespace === 'native-chat.meta' && record.key === 'session-definition') continue
      if (values.length >= 4_096) migrationFailure('NATIVE_SESSION_MIGRATION_CAPACITY')
      if (namespace === 'native-chat.meta' && record.key === 'persona-identity' && transition) {
        personaAnchor(record, transition)
        values.push([namespace, record.key, transition.sourceRevision, transition.sourceValue])
      } else values.push([namespace, record.key, record.revision, record.value])
    }
  }
  return digest(values)
}

export function verifyMigrationAuthorization(store: DurableStore, configuration: NativeChatConfiguration,
  authorizationIdentity: string): void {
  if (nativeAuthorizationMode(configuration.authorization) !== 'whitelist') migrationFailure('NATIVE_SESSION_MIGRATION_COUNTED_UNSUPPORTED')
  const policy = store.read('native-chat.whitelist-policy', 'current')
  const value = policy ? object(policy.value) : null
  const expected = createWhitelistSignature(configuration, authorizationIdentity)
  requireMigration(value?.schema === 1 && value.signature === expected && integer(value.generation) && value.generation > 0)
  const authorization = store.read('native-chat.authorization', configuration.authorization.version)
  requireMigration(authorization && object(authorization.value).signature === nativeMigrationFingerprint(configuration.authorization))
  for (const conversationId of configuration.access.allow) {
    if (configuration.access.deny.includes(conversationId)) continue
    const grant = store.read('policy.grants', nativeChatGrantId(configuration, authorizationIdentity, conversationId, value.generation))
    requireMigration(grant)
    const record = object(grant.value)
    const limits = object(record.maxUses)
    requireMigration(record.featureId === 'agent-relay' && record.conversationId === conversationId
      && nativeWhitelistCapabilities(configuration, conversationId).every(capability => Object.hasOwn(limits, capability) && limits[capability] === null))
  }
}

function createWhitelistSignature(configuration: NativeChatConfiguration, identity: string): string {
  return nativeMigrationFingerprint([identity, configuration.authorization.version, configuration.revisions.access,
    configuration.revisions.execution, nativeWhitelistCapabilities(configuration)])
}

export function nativeMigrationFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function verifyMigrationQuiescence(store: DurableStore, conversations: ReadonlySet<string>, sessions: ReadonlySet<string>,
  personaScope?: { readonly id: string; readonly version: string }): void {
  let count = 0
  for (const namespace of ['host.executions', 'host.replies', 'outbox', 'tasks', 'host.inbox', 'native-work.executions']) {
    for (const record of records(store, namespace)) {
      if (++count > 100_000) migrationFailure('NATIVE_SESSION_MIGRATION_CAPACITY')
      const value = object(record.value)
      const binding = value.binding && typeof value.binding === 'object' && !Array.isArray(value.binding) ? object(value.binding) : value
      let scoped = conversations.has(String(binding.conversationId ?? value.scope ?? '')) || sessions.has(String(binding.sessionId ?? value.parentSessionId ?? ''))
      if (namespace === 'outbox' && personaScope && !['confirmed', 'rejected'].includes(String(value.status))) {
        const scope = object(value.scope)
        const persona = object(scope.persona)
        if (!reference(persona.id) || !reference(persona.version) || persona.id === personaScope.id) {
          migrationFailure('NATIVE_SESSION_MIGRATION_UNSETTLED')
        }
        scoped ||= conversations.has(String(value.conversationId))
      }
      if (!scoped) continue
      // AGENT_UNKNOWN is a completed ingress receipt, not a live dispatch. Keep
      // its uncertain acceptance history; execution/outbox checks below and the
      // DSH fork preview still require the source session and queues to be idle.
      const settledAgentReceipt = namespace === 'host.inbox' && value.status === 'unknown'
        && value.errorCode === 'AGENT_UNKNOWN' && reference(value.eventId)
        && value.event !== null && typeof value.event === 'object' && !Array.isArray(value.event)
        && value.event.type === 'message.received' && value.event.id === value.eventId
        && value.event.conversationId === value.scope
      if (namespace === 'host.executions') {
        if (value.schema !== 1 || value.isolated !== false
          // Late completion releases execution isolation while retaining the original
          // unknown delivery outcome. That history is not an active model request.
          || typeof value.status !== 'string' || !['completed', 'failed', 'rejected', 'timed-out', 'unknown'].includes(value.status)
          || typeof value.externalStatus !== 'string' || !['completed', 'failed', 'rejected', 'cancelled'].includes(value.externalStatus)
          || typeof value.cancelStatus !== 'string' || !['not-requested', 'unavailable', 'rejected', 'confirmed'].includes(value.cancelStatus)
          || typeof value.noticeStatus !== 'string' || !['not-requested', 'unavailable', 'confirmed', 'rejected'].includes(value.noticeStatus)) {
          migrationFailure('NATIVE_SESSION_MIGRATION_UNSETTLED')
        }
      } else if (namespace === 'native-work.executions' && (!['completed', 'failed'].includes(String(value.status))
        || ['delivering', 'unknown'].includes(String(value.delivery)))
        || namespace === 'outbox' && !['confirmed', 'rejected'].includes(String(value.status))
        || namespace === 'host.replies' && value.status === 'waiting'
        || namespace === 'tasks' && ['waiting', 'running', 'unknown'].includes(String(value.status))
        || namespace === 'host.inbox' && !settledAgentReceipt && !['accepted', 'rejected'].includes(String(value.status))) {
        migrationFailure('NATIVE_SESSION_MIGRATION_UNSETTLED')
      }
    }
  }
}
