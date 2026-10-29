import { validMigrationTargetSelection, type MigrationTargetSelection } from '../contracts/dsh-session-migration.ts'
import { randomUUID } from 'node:crypto'
import type { DshSessionMigrationPort, DshSessionMigrationRequest, DshSessionMigrationReceipt } from '../adapters/dsh-session-migration.ts'
import type { DshPresetBinding } from '../adapters/dsh-jsonrpc.ts'
import { reference, snapshot } from '../core/values.ts'
import { digest, json, object } from './data.ts'
import { nativeAuthorizationMode } from './native-access.ts'
import { nativeSessionMigrationEligibility, readNativeConfigurationBaselineFromStore,
  type NativeConfigurationCandidate, type NativeConfigurationBaselineValues } from './native-chat-compatibility.ts'
import type { NativeChatConfiguration } from './native-chat-configuration.ts'
import { readSessionMetadata, reserveSessionId } from './sessions.ts'
import type { DurableStore, StoredRecord } from './types.ts'
import { NATIVE_SESSION_ARCHIVES, NATIVE_SESSION_MIGRATIONS, listMigrationPlans, migrationFailure,
  migrationPolicyDigest, migrationPersonaScope, migrationResult, migrationRevision, nativeMigrationFingerprint,
  prepareMigrationPersonaTransition, readMigrationAuthorizationIdentity,
  readMigrationPlan, verifyMigrationAuthorization, verifyMigrationPersona, verifyMigrationQuiescence,
  writeMigrationLineage, writeMigrationPersona, writeMigrationPlan,
  type NativeSessionMigrationBinding, type NativeSessionMigrationPlan, type NativeSessionMigrationResult } from './native-session-migration-state.ts'

export type { NativeSessionMigrationResult } from './native-session-migration-state.ts'

export interface NativeSessionMigrationOptions {
  readonly store: DurableStore
  readonly configuration: NativeChatConfiguration
  readonly candidate: NativeConfigurationCandidate
  readonly port: DshSessionMigrationPort
  readonly signal: AbortSignal
  readonly resolveTargetSelection?: (conversationId: string, targetPreset: string, signal: AbortSignal) => Promise<MigrationTargetSelection>
  readonly recheck: () => Promise<void>
  readonly finalize: () => void
}

export interface NativeSessionMigrationCommit {
  readonly revisions: Readonly<Record<string, string>>
  readonly confirm: true
  readonly migrationId?: string
  readonly revision?: string
}

function blocked(options: NativeSessionMigrationOptions, reasons: readonly string[]): NativeSessionMigrationResult {
  return snapshot({ schema: 1, state: 'blocked', migrationId: null, revision: null,
    revisions: options.configuration.revisions, bindings: [], missingReasons: reasons })
}

function currentIdentity(options: NativeSessionMigrationOptions): string {
  return nativeMigrationFingerprint({ definition: options.candidate.definition, endpoint: options.candidate.endpoint,
    bindings: options.candidate.bindings })
}

function matchingPreset(bindings: readonly { readonly agentPreset: string; readonly conversationKind: 'group' | 'private' | null }[],
  conversationId: string): string {
  const kind = conversationId.startsWith('group:') ? 'group' : 'private'
  const matches = bindings.filter(binding => binding.conversationKind === null || binding.conversationKind === kind)
  if (matches.length !== 1) migrationFailure('NATIVE_SESSION_MIGRATION_PRESET_AMBIGUOUS')
  return matches[0].agentPreset
}

function targetPresets(bindings: readonly DshPresetBinding[], definition: NativeConfigurationCandidate['definition']) {
  return bindings.filter(binding => digest(binding.definition) === digest(definition))
    .map(binding => ({ agentPreset: binding.agentPreset, conversationKind: binding.conversationKind ?? null }))
}

function activeRecords(store: DurableStore): readonly StoredRecord[] {
  const result: StoredRecord[] = []
  let after: string | undefined
  for (;;) {
    const page = readSessionMetadata(store, { limit: 1_000, ...(after === undefined ? {} : { after }) })
    for (const metadata of page) {
      if (metadata.state === 'retired') continue
      if (metadata.state !== 'ready' || !metadata.sessionId) migrationFailure('NATIVE_SESSION_MIGRATION_SESSION_UNSETTLED')
      if (result.length >= 128) migrationFailure('NATIVE_SESSION_MIGRATION_CAPACITY')
      const record = store.read('host.sessions', metadata.conversationId)
      if (!record) migrationFailure('NATIVE_SESSION_MIGRATION_BINDING_CHANGED')
      result.push(record)
    }
    if (page.length < 1_000) return result
    after = page[page.length - 1].conversationId
  }
}

function assertSource(record: StoredRecord | null, binding: NativeSessionMigrationBinding): asserts record is StoredRecord {
  if (!record || record.revision !== binding.sourceRevision) migrationFailure('NATIVE_SESSION_MIGRATION_BINDING_CHANGED')
  const value = object(record.value)
  if (value.schema !== 1 || value.state !== 'ready' || value.sessionId !== binding.sourceSessionId
    || value.generation !== binding.sourceGeneration || value.requestId !== binding.sourceRequestId) {
    migrationFailure('NATIVE_SESSION_MIGRATION_BINDING_CHANGED')
  }
}

function boundRecord(record: StoredRecord | null, binding: NativeSessionMigrationBinding): boolean {
  if (!record || binding.childSessionId === null) return false
  const value = object(record.value)
  return value.schema === 1 && value.state === 'ready' && value.sessionId === binding.childSessionId
    && value.generation === binding.sourceGeneration + 1 && value.requestId === binding.migrationId
}

function requestFor(binding: NativeSessionMigrationBinding): DshSessionMigrationRequest {
  return { migrationId: binding.migrationId, sourceSessionId: binding.sourceSessionId,
    expectedPreset: binding.expectedPreset, targetPreset: binding.targetPreset, issuerEpoch: binding.issuerEpoch,
    expectedCursor: binding.sourceCursor, expectedSourceDigest: binding.sourceDigest, expectedTargetRevision: binding.targetRevision,
    ...(binding.targetSelection ? { targetSelection: binding.targetSelection } : {}) }
}

function verifyReceipt(receipt: DshSessionMigrationReceipt, binding: NativeSessionMigrationBinding): void {
  const expected = requestFor(binding)
  if (receipt.migrationProtocol !== 'qbf-session-migration/1'
    || Object.entries(expected).some(([key, value]) => digest(receipt[key as keyof DshSessionMigrationRequest] ?? null) !== digest(value))
    || receipt.state === 'completed' && (!reference(receipt.childSessionId) || receipt.childSessionId === binding.sourceSessionId)) {
    migrationFailure('NATIVE_SESSION_MIGRATION_RECEIPT_INVALID')
  }
}

function verifyLocalState(options: NativeSessionMigrationOptions, plan: NativeSessionMigrationPlan): void {
  if (currentIdentity(options) !== plan.targetIdentity || digest(options.configuration.revisions) !== digest(plan.revisions)) {
    migrationFailure('NATIVE_SESSION_MIGRATION_CONFIGURATION_CHANGED')
  }
  verifyMigrationPersona(options.store, plan)
  if (migrationPolicyDigest(options.store, plan.personaTransition) !== plan.policyDigest) migrationFailure('NATIVE_SESSION_MIGRATION_POLICY_CHANGED')
  const meta = options.store.read('native-chat.meta', 'session-definition')
  const identity = meta ? object(meta.value).identity : null
  if (!meta || !(identity === plan.sourceIdentity && meta.revision === plan.sourceMetaRevision
    || identity === plan.targetIdentity && plan.bindings.every(binding => binding.state === 'bound'))) {
    migrationFailure('NATIVE_SESSION_MIGRATION_SOURCE_CHANGED')
  }
  const records = activeRecords(options.store)
  if (records.length !== plan.bindings.length || records.some(record => !plan.bindings.some(binding => binding.conversationId === record.key))) {
    migrationFailure('NATIVE_SESSION_MIGRATION_BINDING_CHANGED')
  }
  for (const binding of plan.bindings) {
    const record = options.store.read('host.sessions', binding.conversationId)
    if (boundRecord(record, binding)) continue
    assertSource(record, binding)
  }
  verifyMigrationQuiescence(options.store, new Set(plan.bindings.map(binding => binding.conversationId)),
    new Set(plan.bindings.map(binding => binding.sourceSessionId)), migrationPersonaScope(plan.personaTransition))
}

function archiveSource(store: DurableStore, binding: NativeSessionMigrationBinding): void {
  const previous = store.read(NATIVE_SESSION_ARCHIVES, binding.migrationId)
  if (previous) {
    const value = object(previous.value)
    const source = object(value.source)
    if (value.schema !== 1 || value.migrationId !== binding.migrationId || value.targetPreset !== binding.targetPreset
      || source.key !== binding.conversationId || source.revision !== binding.sourceRevision
      || object(source.value).sessionId !== binding.sourceSessionId || object(source.value).generation !== binding.sourceGeneration) {
      migrationFailure('NATIVE_SESSION_MIGRATION_ARCHIVE_INVALID')
    }
    return
  }
  const source = store.read('host.sessions', binding.conversationId)
  assertSource(source, binding)
  store.write(NATIVE_SESSION_ARCHIVES, binding.migrationId, json({ schema: 1, migrationId: binding.migrationId,
    source, targetPreset: binding.targetPreset }), { expectedRevision: null })
}

export async function previewNativeSessionMigration(options: NativeSessionMigrationOptions): Promise<NativeSessionMigrationResult> {
  options.signal.throwIfAborted()
  if (options.configuration.authorization.mode !== 'whitelist') return blocked(options, ['migration_counted_mode_unsupported'])
  const plans = listMigrationPlans(options.store)
  const unresolved = plans.filter(plan => ['committing', 'unknown', 'partial'].includes(plan.state))
  if (unresolved.length > 1) migrationFailure('NATIVE_SESSION_MIGRATION_INVALID')
  if (unresolved.length === 1) return migrationResult(unresolved[0])
  const existing = plans.find(plan => plan.state === 'available' && plan.targetIdentity === currentIdentity(options)
    && digest(plan.revisions) === digest(options.configuration.revisions))
  if (existing) {
    verifyLocalState(options, existing)
    for (const binding of existing.bindings) {
      const preview = await options.port.forkPreview({ migrationId: binding.migrationId, sourceSessionId: binding.sourceSessionId,
        expectedPreset: binding.expectedPreset, targetPreset: binding.targetPreset,
        ...(binding.targetSelection ? { targetSelection: binding.targetSelection } : {}) }, options.signal)
      if (preview.state !== 'available' || preview.issuerEpoch !== binding.issuerEpoch || preview.sourceCursor !== binding.sourceCursor
        || preview.sourceDigest !== binding.sourceDigest || preview.targetRevision !== binding.targetRevision) {
        const record = options.store.read(NATIVE_SESSION_MIGRATIONS, existing.migrationId)
        if (!record) migrationFailure('NATIVE_SESSION_MIGRATION_PLAN_MISSING')
        const changed = { ...existing, state: 'blocked' as const, missingReasons: ['migration_preview_changed'] }
        writeMigrationPlan(options.store, changed, record.revision)
        return migrationResult(changed)
      }
    }
    await options.recheck()
    verifyLocalState(options, existing)
    return migrationResult(existing)
  }
  const baseline = readNativeConfigurationBaselineFromStore(options.store)
  const reasons = nativeSessionMigrationEligibility(baseline, options.candidate, options.resolveTargetSelection !== undefined)
  if (reasons.length > 0 || !baseline.values) return blocked(options, reasons)
  if (plans.length >= 64) return blocked(options, ['migration_record_capacity'])
  return preparePlan(options, baseline.values)
}

async function preparePlan(options: NativeSessionMigrationOptions,
  original: NativeConfigurationBaselineValues): Promise<NativeSessionMigrationResult> {
  const prior = options.store.read('native-chat.meta', 'session-definition')
  const sourceIdentity = prior ? object(prior.value).identity : null
  if (!prior || typeof sourceIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(sourceIdentity)) {
    return blocked(options, ['migration_source_identity_unavailable'])
  }
  const authorizationIdentity = readMigrationAuthorizationIdentity(options.store, sourceIdentity)
  verifyMigrationAuthorization(options.store, options.configuration, authorizationIdentity)
  const sources = activeRecords(options.store)
  if (sources.length === 0) return blocked(options, ['migration_active_session_missing'])
  const policyDigest = migrationPolicyDigest(options.store)
  const migrationId = `migration-${randomUUID()}`
  const personaTransition = prepareMigrationPersonaTransition(options.store, original.persona, options.candidate.persona!, migrationId)
  const bindings: NativeSessionMigrationBinding[] = []
  const sourcePresets = original.bindings.filter(binding => binding.definitionFingerprint === nativeMigrationFingerprint(original.definition))
  const targets = targetPresets(options.candidate.bindings, options.candidate.definition)
  const sourceSessions = new Set(sources.map(source => String(object(source.value).sessionId)))
  verifyMigrationQuiescence(options.store, new Set(sources.map(source => source.key)), sourceSessions, migrationPersonaScope(personaTransition))
  for (const [index, source] of sources.entries()) {
    options.signal.throwIfAborted()
    const value = object(source.value)
    const targetPreset = matchingPreset(targets, source.key)
    const targetSelection = options.resolveTargetSelection ? await options.resolveTargetSelection(source.key, targetPreset, options.signal) : undefined
    if (options.resolveTargetSelection && !validMigrationTargetSelection(targetSelection)) {
      return blocked(options, ['migration_target_selection_unavailable'])
    }
    const request = { migrationId: `${migrationId}:${index}`, sourceSessionId: String(value.sessionId),
      expectedPreset: matchingPreset(sourcePresets, source.key), targetPreset, ...(targetSelection ? { targetSelection } : {}) }
    const preview = await options.port.forkPreview(request, options.signal).catch(() => null)
    if (!preview) return blocked(options, ['migration_plugin_unavailable'])
    if (preview.state !== 'available') return blocked(options, ['migration_source_or_target_unavailable', ...preview.missingReasons].slice(0, 32))
    if (preview.migrationProtocol !== 'qbf-session-migration/1' || preview.sourceCursor === null || preview.sourceDigest === null
      || preview.targetRevision === null || Object.entries(request).some(([key, entry]) => digest(preview[key as keyof typeof request] ?? null) !== digest(entry))) {
      migrationFailure('NATIVE_SESSION_MIGRATION_PREVIEW_INVALID')
    }
    bindings.push({ ...request, conversationId: source.key, sourceGeneration: Number(value.generation), sourceRevision: source.revision,
      sourceRequestId: value.requestId === null ? null : String(value.requestId), issuerEpoch: preview.issuerEpoch,
      sourceCursor: preview.sourceCursor, sourceDigest: preview.sourceDigest, targetRevision: preview.targetRevision,
      childSessionId: null, state: 'available' })
  }
  await options.recheck()
  const draft = { schema: 1 as const, migrationId, revisions: options.configuration.revisions, sourceIdentity,
    targetIdentity: currentIdentity(options), sourceMetaRevision: prior.revision, authorizationIdentity, policyDigest,
    state: 'available' as const, createdAt: Date.now(), bindings, missingReasons: [] }
  const withPersona = { ...draft, ...(personaTransition ? { personaTransition } : {}) }
  const plan = { ...withPersona, revision: migrationRevision(withPersona) }
  verifyLocalState(options, plan)
  writeMigrationPlan(options.store, plan, null)
  return migrationResult(plan)
}

export async function commitNativeSessionMigration(options: NativeSessionMigrationOptions,
  input: NativeSessionMigrationCommit): Promise<NativeSessionMigrationResult> {
  if (input.confirm !== true || digest(input.revisions) !== digest(options.configuration.revisions)
    || (input.migrationId === undefined) !== (input.revision === undefined)) migrationFailure('NATIVE_SESSION_MIGRATION_CONFIRMATION_REQUIRED')
  if (options.configuration.authorization.mode !== 'whitelist') return blocked(options, ['migration_counted_mode_unsupported'])
  let record: StoredRecord | null
  if (input.migrationId !== undefined) record = options.store.read(NATIVE_SESSION_MIGRATIONS, input.migrationId)
  else {
    const preview = await previewNativeSessionMigration(options)
    if (preview.state !== 'available' && preview.state !== 'unknown' && preview.state !== 'partial') return preview
    record = preview.migrationId ? options.store.read(NATIVE_SESSION_MIGRATIONS, preview.migrationId) : null
  }
  if (!record) migrationFailure('NATIVE_SESSION_MIGRATION_PLAN_MISSING')
  let plan = readMigrationPlan(record)
  const unresolved = listMigrationPlans(options.store).filter(entry => ['committing', 'unknown', 'partial'].includes(entry.state))
  if (unresolved.length > 1) migrationFailure('NATIVE_SESSION_MIGRATION_INVALID')
  if (unresolved[0] && unresolved[0].migrationId !== plan.migrationId) return migrationResult(unresolved[0])
  if (input.revision !== undefined && plan.revision !== input.revision) migrationFailure('NATIVE_SESSION_MIGRATION_REVISION_CONFLICT')
  if (plan.state === 'completed') {
    verifyLocalState(options, plan)
    return migrationResult(plan)
  }
  if (plan.state === 'blocked') return migrationResult(plan)
  const update = (changes: Partial<Pick<NativeSessionMigrationPlan, 'state' | 'bindings' | 'missingReasons'>>) => {
    plan = snapshot({ ...plan, ...changes })
    record = writeMigrationPlan(options.store, plan, record!.revision)
  }
  try {
    await options.recheck()
    verifyLocalState(options, plan)
    update({ state: 'committing', missingReasons: [] })
    for (let index = 0; index < plan.bindings.length; index++) {
      options.signal.throwIfAborted()
      await options.recheck()
      verifyLocalState(options, plan)
      let binding = plan.bindings[index]
      if (binding.state === 'bound') {
        if (!boundRecord(options.store.read('host.sessions', binding.conversationId), binding)) migrationFailure('NATIVE_SESSION_MIGRATION_BINDING_CHANGED')
        continue
      }
      archiveSource(options.store, binding)
      if (binding.state !== 'confirmed') {
        const firstAttempt = binding.state === 'available'
        if (firstAttempt) {
          binding = { ...binding, state: 'requested' }
          update({ bindings: plan.bindings.map((entry, offset) => offset === index ? binding : entry) })
        }
        let receipt: DshSessionMigrationReceipt
        try {
          receipt = firstAttempt ? await options.port.forkWithPreset(requestFor(binding), options.signal)
            : await options.port.inspectMigration(requestFor(binding), options.signal)
          verifyReceipt(receipt, binding)
        } catch {
          binding = { ...binding, state: 'unknown' }
          update({ state: plan.bindings.some(entry => entry.state === 'bound') ? 'partial' : 'unknown',
            bindings: plan.bindings.map((entry, offset) => offset === index ? binding : entry), missingReasons: ['migration_fork_result_unknown'] })
          return migrationResult(plan)
        }
        if (receipt.state !== 'completed' || receipt.childSessionId === null) {
          const rejected = receipt.state === 'rejected' && receipt.childSessionId === null && receipt.idempotency !== 'conflict'
          binding = { ...binding, state: rejected ? 'rejected' : 'unknown' }
          update({ state: plan.bindings.some(entry => entry.state === 'bound') ? 'partial' : rejected ? 'blocked' : 'unknown',
            bindings: plan.bindings.map((entry, offset) => offset === index ? binding : entry),
            missingReasons: [rejected ? 'migration_fork_rejected' : 'migration_fork_result_unknown'] })
          return migrationResult(plan)
        }
        if (plan.bindings.some(entry => entry.sourceSessionId === receipt.childSessionId || entry.childSessionId === receipt.childSessionId)) {
          migrationFailure('NATIVE_SESSION_MIGRATION_CHILD_CONFLICT')
        }
        binding = { ...binding, state: 'confirmed', childSessionId: receipt.childSessionId }
        update({ bindings: plan.bindings.map((entry, offset) => offset === index ? binding : entry) })
      }
      await options.recheck()
      verifyLocalState(options, plan)
      const source = options.store.read('host.sessions', binding.conversationId)
      reserveSessionId(options.store, binding.conversationId, binding.childSessionId!, binding.sourceGeneration + 1)
      if (!boundRecord(source, binding)) {
        assertSource(source, binding)
        reserveSessionId(options.store, binding.conversationId, binding.sourceSessionId, binding.sourceGeneration)
        options.store.write('host.sessions', binding.conversationId, { schema: 1, state: 'ready',
          generation: binding.sourceGeneration + 1, requestId: binding.migrationId,
          sessionId: binding.childSessionId, updatedAt: Date.now() }, { expectedRevision: binding.sourceRevision })
      }
      binding = { ...binding, state: 'bound' }
      update({ bindings: plan.bindings.map((entry, offset) => offset === index ? binding : entry) })
    }
    await options.recheck()
    verifyLocalState(options, plan)
    const meta = options.store.read('native-chat.meta', 'session-definition')
    if (!meta) migrationFailure('NATIVE_SESSION_MIGRATION_SOURCE_CHANGED')
    const identity = object(meta.value).identity
    if (identity !== plan.targetIdentity && (identity !== plan.sourceIdentity || meta.revision !== plan.sourceMetaRevision)) {
      migrationFailure('NATIVE_SESSION_MIGRATION_SOURCE_CHANGED')
    }
    writeMigrationLineage(options.store, plan)
    writeMigrationPersona(options.store, plan)
    if (identity !== plan.targetIdentity) options.store.write('native-chat.meta', 'session-definition',
      { identity: plan.targetIdentity }, { expectedRevision: plan.sourceMetaRevision })
    options.finalize()
    update({ state: 'completed', missingReasons: [] })
    return migrationResult(plan)
  } catch {
    const hasEffects = plan.bindings.some(binding => binding.state !== 'available' && binding.state !== 'rejected')
    update({ state: plan.bindings.some(binding => binding.state === 'bound') ? 'partial' : hasEffects ? 'unknown' : 'blocked',
      missingReasons: ['migration_reconciliation_required'] })
    return migrationResult(plan)
  }
}
