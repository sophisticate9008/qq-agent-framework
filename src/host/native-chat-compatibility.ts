import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { DshPresetBinding } from '../adapters/dsh-jsonrpc.ts'
import { FrameworkError, snapshot } from '../core/values.ts'
import { openReadonlySqliteStore } from '../storage/sqlite-readonly.ts'
import { validateAdapterEndpoint } from './adapter-configuration.ts'
import { buildChatSessionDefinition, validateChatPlan, validateChatPersona, type ChatPersona, type ChatSessionDefinition } from './chat-plans.ts'
import { digest, json, object } from './data.ts'
import { createNativePersonaIdentity } from './native-persona-identity.ts'
import type { DurableStore } from './types.ts'
import { readSessionMetadata } from './sessions.ts'
import { listMigrationPlans } from './native-session-migration-state.ts'

export const NATIVE_CONFIGURATION_BASELINE_NAMESPACE = 'native-chat.configuration-baselines'
const MAX_BASELINE_BYTES = 524_288
const MAX_BASELINES = 64
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
const containsSecret = (value: unknown, secret: string): boolean => typeof value === 'string' ? value.includes(secret)
  : Array.isArray(value) ? value.some(entry => containsSecret(entry, secret))
    : value !== null && typeof value === 'object' && Object.values(value).some(entry => containsSecret(entry, secret))

export interface NativeConfigurationCandidate {
  readonly definition: ChatSessionDefinition | null
  readonly persona: ChatPersona | null
  readonly endpoint: string
  readonly bindings: readonly DshPresetBinding[]
}
export interface NativeConfigurationBaselineValues {
  readonly definition: ChatSessionDefinition
  readonly persona: ChatPersona
  readonly endpoint: string
  readonly bindings: readonly {
    readonly agentPreset: string
    readonly conversationKind: 'group' | 'private' | null
    readonly externalProvider: string | null
    readonly definitionFingerprint: string
  }[]
}
export interface NativeConfigurationBaseline {
  readonly schema: 1
  readonly state: 'available' | 'missing' | 'invalid' | 'unavailable'
  readonly capturedAt: number | null
  readonly values: NativeConfigurationBaselineValues | null
  readonly unavailableReason: 'not-recorded' | 'invalid-record' | 'sensitive-content' | 'value-too-large' | 'record-limit' | 'storage-unavailable' | null
}
export interface NativeConfigurationCompatibility {
  readonly schema: 1
  readonly state: 'no-history' | 'compatible' | 'blocked' | 'unavailable'
  readonly hasPersistedSessions: boolean | null
  readonly reasons: readonly string[]
  readonly differences: readonly string[]
  readonly baseline: { readonly state: 'available' | 'missing' | 'invalid' | 'not-required'; readonly capturedAt: number | null;
    readonly unavailableReason: NativeConfigurationBaseline['unavailableReason'] }
  readonly recovery: {
    readonly mode: 'none' | 'restore-original-values' | 'operator-original-values-required' | 'storage-unavailable'
    readonly automaticRestoreAvailable: false
    readonly forwardMigrationAvailable: false
  }
}

function baselineState(state: NativeConfigurationBaseline['state'], reason?: NativeConfigurationBaseline['unavailableReason']): NativeConfigurationBaseline {
  return Object.freeze({ schema: 1, state, capturedAt: null, values: null, unavailableReason: reason
    ?? (state === 'invalid' ? 'invalid-record' : state === 'unavailable' ? 'storage-unavailable' : 'not-recorded') })
}

function projectedValues(candidate: NativeConfigurationCandidate): NativeConfigurationBaselineValues {
  if (!candidate.definition || !candidate.persona) throw new TypeError('Missing configuration definition')
  const persona = validateChatPersona(candidate.persona)
  const source = candidate.definition
  const plan = validateChatPlan({ id: source.planId, name: source.planId, description: '', instructions: source.instructions,
    personaId: source.personaId, provider: source.model.provider, model: source.model.name, reasoningEffort: source.model.reasoningEffort,
    ...(Object.hasOwn(source, 'contextLimits') ? { contextLimits: source.contextLimits } : {}),
    ...(Object.hasOwn(source, 'capabilitySelection') ? { capabilitySelection: source.capabilitySelection } : {}) })
  const { contextLimits, ...planWithoutContextLimits } = plan
  const definition = buildChatSessionDefinition(Object.hasOwn(source, 'contextLimits')
    ? { ...planWithoutContextLimits, contextLimits } : planWithoutContextLimits, persona)
  const endpoint = validateAdapterEndpoint(candidate.endpoint)
  if (endpoint === '' || !isDeepStrictEqual(definition, source) || candidate.bindings.length > 128) throw new TypeError('Invalid baseline configuration')
  const bindings = candidate.bindings.map(binding => ({ agentPreset: binding.agentPreset,
    conversationKind: binding.conversationKind ?? null, externalProvider: binding.externalProvider ?? null,
    definitionFingerprint: hash(binding.definition) }))
  return snapshot({ definition, persona, endpoint, bindings })
}

function parseValues(input: unknown): NativeConfigurationBaselineValues {
  const value = object(input)
  if (Object.keys(value).length !== 4 || !Array.isArray(value.bindings) || value.bindings.length > 128
    || Buffer.byteLength(JSON.stringify(value)) > MAX_BASELINE_BYTES) throw new TypeError('Invalid baseline values')
  const persona = validateChatPersona(value.persona)
  const source = object(value.definition)
  const model = object(source.model)
  const plan = validateChatPlan({ id: source.planId, name: source.planId, description: '', instructions: source.instructions,
    personaId: source.personaId, provider: model.provider, model: model.name, reasoningEffort: model.reasoningEffort,
    ...(Object.hasOwn(source, 'contextLimits') ? { contextLimits: source.contextLimits } : {}),
    ...(Object.hasOwn(source, 'capabilitySelection') ? { capabilitySelection: source.capabilitySelection } : {}) })
  const { contextLimits, ...planWithoutContextLimits } = plan
  const definition = buildChatSessionDefinition(Object.hasOwn(source, 'contextLimits')
    ? { ...planWithoutContextLimits, contextLimits } : planWithoutContextLimits, persona)
  const endpoint = validateAdapterEndpoint(value.endpoint)
  if (endpoint === '' || !isDeepStrictEqual(definition, source)) throw new TypeError('Invalid baseline definition')
  const bindings = value.bindings.map(raw => {
    const binding = object(raw)
    if (Object.keys(binding).length !== 4 || !identifier(binding.agentPreset)
      || !['group', 'private', null].includes(binding.conversationKind as string | null)
      || binding.externalProvider !== null && !identifier(binding.externalProvider)
      || !validHash(binding.definitionFingerprint)) throw new TypeError('Invalid baseline binding')
    return { agentPreset: binding.agentPreset, conversationKind: binding.conversationKind as 'group' | 'private' | null,
      externalProvider: binding.externalProvider as string | null, definitionFingerprint: binding.definitionFingerprint }
  })
  return snapshot({ definition, persona, endpoint, bindings })
}

function baselineAnchor(store: Pick<DurableStore, 'read'>) {
  const definition = store.read('native-chat.meta', 'session-definition')
  const personaIdentity = store.read('native-chat.meta', 'persona-identity')
  if (!definition || !personaIdentity) return null
  const identity = object(definition.value).identity
  const persona = object(personaIdentity.value)
  if (!validHash(identity) || !validHash(persona.contentVersion) || !validHash(persona.scopeVersion)) return null
  return { identity, personaVersion: persona.contentVersion, personaScopeVersion: persona.scopeVersion,
    key: hash([identity, persona.contentVersion, persona.scopeVersion]) }
}

function storedBaseline(store: Pick<DurableStore, 'read' | 'list'>): NativeConfigurationBaseline {
  try {
    const anchor = baselineAnchor(store)
    if (!anchor) return baselineState('missing')
    const record = store.read(NATIVE_CONFIGURATION_BASELINE_NAMESPACE, anchor.key)
    if (!record) return baselineState('missing', store.list(NATIVE_CONFIGURATION_BASELINE_NAMESPACE,
      { limit: MAX_BASELINES }).length >= MAX_BASELINES ? 'record-limit' : 'not-recorded')
    const value = object(record.value)
    if (value.schema !== 1 || value.identity !== anchor.identity || value.personaVersion !== anchor.personaVersion
      || value.personaScopeVersion !== anchor.personaScopeVersion) return baselineState('invalid')
    if (value.withheld === 'value-too-large' || value.withheld === 'sensitive-content') return baselineState('missing', value.withheld)
    const values = parseValues(value.values)
    if (Object.keys(value).length !== 7 || value.personaVersion !== createNativePersonaIdentity(values.persona).version
      || typeof value.capturedAt !== 'number' || !Number.isSafeInteger(value.capturedAt) || value.capturedAt <= 0
      || value.checksum !== digest(values)) return baselineState('invalid')
    return snapshot({ schema: 1, state: 'available', capturedAt: value.capturedAt, values, unavailableReason: null })
  } catch (error) {
    if (error instanceof TypeError || error instanceof FrameworkError && error.code === 'INVALID_STORED_DATA') return baselineState('invalid')
    throw error
  }
}

function withReadonly<Result>(directory: string, read: (store: DurableStore) => Result): Result {
  const store = openReadonlySqliteStore(join(directory, 'native-chat.sqlite'))
  try { return store.withSnapshot(() => read(store)) } finally { store.close() }
}

export function readNativeConfigurationBaseline(directory: string): NativeConfigurationBaseline {
  try { return withReadonly(directory, storedBaseline) }
  catch (error) { return baselineState(error instanceof Error && 'code' in error && error.code === 'STORE_NOT_FOUND' ? 'missing' : 'unavailable') }
}

export function readNativeConfigurationBaselineFromStore(store: Pick<DurableStore, 'read' | 'list'>): NativeConfigurationBaseline {
  return storedBaseline(store)
}

export function nativeSessionMigrationEligibility(baseline: NativeConfigurationBaseline,
  candidate: NativeConfigurationCandidate, allowModelSelection = false): readonly string[] {
  if (baseline.state !== 'available' || !baseline.values) return ['migration_baseline_unavailable']
  if (!candidate.definition || !candidate.persona) return ['current_configuration_unavailable']
  try {
    const original = baseline.values
    const current = projectedValues(candidate)
    const { planId: originalPlan, instructions: originalInstructions, persona: originalBody, model: originalModel, contextLimits: originalLimits, ...originalStable } = original.definition
    const { planId: currentPlan, instructions: currentInstructions, persona: currentBody, model: currentModel, contextLimits: currentLimits, ...currentStable } = current.definition
    if (original.endpoint !== current.endpoint || original.persona.id !== current.persona.id
      || !isDeepStrictEqual(originalStable, currentStable)
      || !allowModelSelection && (!isDeepStrictEqual(originalModel, currentModel) || !isDeepStrictEqual(originalLimits, currentLimits))) return ['migration_configuration_change_unsupported']
    if (originalPlan === currentPlan && originalInstructions === currentInstructions && isDeepStrictEqual(originalBody, currentBody)
      && isDeepStrictEqual(originalModel, currentModel) && isDeepStrictEqual(originalLimits, currentLimits)
      && (!allowModelSelection || isDeepStrictEqual(original.bindings, current.bindings))) {
      return ['migration_instruction_change_missing']
    }
    return []
  } catch { return ['migration_configuration_unavailable'] }
}

export function hasActiveNativeSessions(store: Pick<DurableStore, 'list'>): boolean {
  let after: string | undefined
  for (;;) {
    const batch = readSessionMetadata(store, { limit: 1_000, ...(after === undefined ? {} : { after }) })
    if (batch.some(binding => binding.state !== 'retired')) return true
    if (batch.length < 1_000) return false
    after = batch[batch.length - 1].conversationId
  }
}

export function captureNativeConfigurationBaseline(store: DurableStore, candidate: NativeConfigurationCandidate,
  credentials: readonly string[]): boolean {
  const values = projectedValues(candidate)
  const serialized = JSON.stringify(values)
  const identity = hash({ definition: candidate.definition, endpoint: candidate.endpoint, bindings: candidate.bindings })
  const personaVersion = createNativePersonaIdentity(values.persona).version
  const anchor = baselineAnchor(store)
  if (!anchor || anchor.identity !== identity || anchor.personaVersion !== personaVersion) {
    throw new TypeError('Baseline requires verified native identities')
  }
  if (store.read(NATIVE_CONFIGURATION_BASELINE_NAMESPACE, anchor.key)) return storedBaseline(store).state === 'available'
  if (store.list(NATIVE_CONFIGURATION_BASELINE_NAMESPACE, { limit: MAX_BASELINES }).length >= MAX_BASELINES) return false
  const withheld = Buffer.byteLength(serialized) > MAX_BASELINE_BYTES ? 'value-too-large'
    : credentials.some(secret => secret !== '' && containsSecret(values, secret)) ? 'sensitive-content' : null
  store.write(NATIVE_CONFIGURATION_BASELINE_NAMESPACE, anchor.key, { schema: 1, identity, personaVersion,
    personaScopeVersion: anchor.personaScopeVersion,
    ...(withheld ? { withheld } : { capturedAt: Date.now(), values: json(values), checksum: digest(values) }) }, { expectedRevision: null })
  if (withheld) return false
  return true
}

export function inspectNativeConfigurationCompatibility(directory: string, candidate: NativeConfigurationCandidate): NativeConfigurationCompatibility {
  const result = (state: NativeConfigurationCompatibility['state'], hasPersistedSessions: boolean | null, reasons: readonly string[],
    differences: readonly string[], baseline = baselineState('missing')): NativeConfigurationCompatibility => snapshot({ schema: 1,
    state, hasPersistedSessions, reasons, differences,
    baseline: { state: baseline.state === 'unavailable' ? 'invalid' : baseline.state, capturedAt: baseline.capturedAt,
      unavailableReason: baseline.unavailableReason },
    recovery: { mode: state === 'unavailable' ? 'storage-unavailable' : state !== 'blocked' ? 'none'
      : baseline.state === 'available' ? 'restore-original-values' : 'operator-original-values-required',
    automaticRestoreAvailable: false, forwardMigrationAvailable: false } })
  try {
    return withReadonly(directory, store => {
      const hasSessions = hasActiveNativeSessions(store)
      const prior = store.read('native-chat.meta', 'session-definition')
      const priorPersona = store.read('native-chat.meta', 'persona-identity')
      const baseline = storedBaseline(store)
      if (!candidate.definition || !candidate.persona) return result('blocked', hasSessions, ['current_configuration_unavailable'], [], baseline)
      const identity = prior ? object(prior.value) : null
      const persona = priorPersona ? object(priorPersona.value) : null
      if (hasSessions && (!identity || !validHash(identity.identity)) || persona && (persona.schema !== 1
        || !validHash(persona.contentVersion) || !validHash(persona.scopeVersion))) {
        return result('unavailable', hasSessions, ['persisted_configuration_unavailable'], [], baseline)
      }
      const currentIdentity = hash({ definition: candidate.definition, endpoint: candidate.endpoint, bindings: candidate.bindings })
      const reasons: string[] = []
      if (listMigrationPlans(store).some(plan => ['committing', 'unknown', 'partial'].includes(plan.state))) {
        reasons.push('session_migration_reconciliation_required')
      }
      if (hasSessions && identity?.identity !== currentIdentity) reasons.push('persisted_session_configuration_conflict')
      if (persona && (persona.nativeId !== candidate.persona.id || persona.contentVersion !== createNativePersonaIdentity(candidate.persona).version)
        || !persona && identity && identity.identity !== currentIdentity && (hasSessions || store.list('outbox', { limit: 1 }).length > 0)) {
        reasons.push('persisted_persona_identity_conflict')
      }
      const differences: string[] = []
      if (baseline.values) {
        const original = baseline.values
        for (const field of ['planId', 'instructions', 'personaId', 'contextLimits', 'capabilitySelection'] as const) {
          if (!isDeepStrictEqual(original.definition[field], candidate.definition[field])
            || Object.hasOwn(original.definition, field) !== Object.hasOwn(candidate.definition, field)) differences.push(field)
        }
        for (const field of ['provider', 'name', 'reasoningEffort'] as const) {
          if (original.definition.model[field] !== candidate.definition.model[field]) differences.push(`model.${field}`)
        }
        for (const field of ['name', 'identity', 'style'] as const) {
          if (original.persona[field] !== candidate.persona[field]) differences.push(`persona.${field}`)
        }
        if (original.endpoint !== candidate.endpoint) differences.push('endpoint')
        if (!isDeepStrictEqual(original.bindings, projectedValues(candidate).bindings)) differences.push('bindings')
      }
      return result(reasons.length > 0 ? 'blocked' : hasSessions ? 'compatible' : 'no-history', hasSessions, reasons, differences, baseline)
    })
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'STORE_NOT_FOUND'
      ? result('no-history', false, [], []) : result('unavailable', null, ['persisted_configuration_unavailable'], [])
  }
}
