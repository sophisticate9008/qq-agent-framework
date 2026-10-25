import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { DshSessionMigrationPort, DshSessionMigrationReceipt } from '../src/adapters/dsh-session-migration.ts'
import { createDefaultAdapterConfiguration } from '../src/host/adapter-configuration.ts'
import { buildChatSessionDefinition } from '../src/host/chat-plans.ts'
import { digest, object } from '../src/host/data.ts'
import { nativeChatGrantId, nativeWhitelistCapabilities } from '../src/host/native-access.ts'
import { captureNativeConfigurationBaseline, hasActiveNativeSessions, nativeSessionMigrationEligibility,
  inspectNativeConfigurationCompatibility, readNativeConfigurationBaselineFromStore } from '../src/host/native-chat-compatibility.ts'
import { DEFAULT_NATIVE_CHAT_DEPLOYMENT, type NativeChatConfiguration } from '../src/host/native-chat-configuration.ts'
import { DEFAULT_NATIVE_EXECUTION_POLICY } from '../src/host/native-execution.ts'
import { createNativePersonaIdentity } from '../src/host/native-persona-identity.ts'
import { commitNativeSessionMigration, previewNativeSessionMigration, type NativeSessionMigrationOptions } from '../src/host/native-session-migration.ts'
import type { NativeSessionMigrationResult } from '../src/host/native-session-migration.ts'
import { NATIVE_SESSION_ARCHIVES, nativeMigrationFingerprint, readMigrationAuthorizationIdentity,
  verifyMigrationQuiescence } from '../src/host/native-session-migration-state.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'

function fixture(context: TestContext, count = 1, filename = ':memory:') {
  const store = createSqliteStore({ filename })
  context.after(() => store.close())
  const persona = { id: 'persona', name: 'Persona', identity: 'Stable identity', style: 'Stable style' }
  const plan = { id: 'before', name: 'Before', description: '', personaId: persona.id,
    instructions: 'Before instructions', provider: 'provider', model: 'model', reasoningEffort: 'off' as const }
  const original = buildChatSessionDefinition(plan, persona)
  const definition = buildChatSessionDefinition({ ...plan, id: 'after', instructions: 'After instructions' }, persona)
  const endpoint = 'http://127.0.0.1:3080'
  const source = { definition: original, persona, endpoint, bindings: [{ definition: original, agentPreset: 'before-preset' }] }
  const candidate = { definition, persona, endpoint, bindings: [{ definition, agentPreset: 'after-preset' }] }
  const identity = nativeMigrationFingerprint({ definition: original, endpoint, bindings: source.bindings })
  const contentVersion = createNativePersonaIdentity(persona).version
  store.write('native-chat.meta', 'session-definition', { identity })
  store.write('native-chat.meta', 'persona-identity', { schema: 1, nativeId: persona.id, contentVersion, scopeVersion: contentVersion })
  captureNativeConfigurationBaseline(store, source, [])
  const revisions = Object.fromEntries(['plans', 'personas', 'access', 'adapters', 'providers', 'authorization', 'deployment', 'execution']
    .map(key => [key, digest(key)]))
  const conversations = Array.from({ length: count }, (_entry, index) => `private:${index + 1}`)
  const configuration: NativeChatConfiguration = { revisions, catalog: { activePlanId: 'after', plans: [{ ...plan, id: 'after', instructions: 'After instructions' }] },
    personas: [persona], access: { allow: conversations, deny: [], owner: 'owner' }, adapters: createDefaultAdapterConfiguration(), providers: [],
    authorization: { version: 'whitelist-1', mode: 'whitelist', grants: [] }, deployment: DEFAULT_NATIVE_CHAT_DEPLOYMENT,
    execution: DEFAULT_NATIVE_EXECUTION_POLICY }
  store.write('native-chat.authorization', 'whitelist-1', { signature: nativeMigrationFingerprint(configuration.authorization) })
  store.write('native-chat.whitelist-policy', 'current', { schema: 1, generation: 1,
    signature: nativeMigrationFingerprint([identity, 'whitelist-1', revisions.access, revisions.execution, nativeWhitelistCapabilities(configuration)]) })
  store.write('policy.grants', 'existing-revoked', { active: false, maxUses: { 'agent.submit': null }, used: { 'agent.submit': 19 } })
  for (const conversationId of conversations) store.write('policy.grants', nativeChatGrantId(configuration, identity, conversationId, 1),
    { featureId: 'agent-relay', conversationId, active: false,
      maxUses: Object.fromEntries(nativeWhitelistCapabilities(configuration).map(capability => [capability, null])),
      used: { 'agent.submit': 11, 'messaging.send': 9 } })
  for (const [index, conversationId] of conversations.entries()) store.write('host.sessions', conversationId,
    { schema: 1, state: 'ready', generation: 1, requestId: `original-${index}`, sessionId: `source-${index}`, updatedAt: 1 })
  for (const namespace of ['native-chat.tool-scopes', 'native-usage.turns', 'host.agent-events', 'outbox']) {
    store.write(namespace, 'historical', { conversationId: conversations[0], status: 'confirmed', source: 'preserved' })
  }
  const receipts = new Map<string, DshSessionMigrationReceipt>()
  const calls: string[] = []
  const controls = { unknownAt: 0, forks: 0, notFound: false, finalizeFails: false,
    beforeReply: undefined as (() => void) | undefined }
  const port: DshSessionMigrationPort = {
    async forkPreview(request) {
      calls.push('preview')
      return { ...request, migrationProtocol: 'qaf-session-migration/1', issuerEpoch: 'epoch', state: 'available',
        sourceCursor: 12, sourceDigest: 'a'.repeat(64), targetRevision: 'b'.repeat(64), missingReasons: [] }
    },
    async forkWithPreset(request) {
      calls.push('fork')
      const receipt: DshSessionMigrationReceipt = { ...request, migrationProtocol: 'qaf-session-migration/1',
        state: 'completed', childSessionId: `child-${++controls.forks}`, idempotency: 'created', missingReasons: [] }
      receipts.set(request.migrationId, receipt)
      controls.beforeReply?.()
      if (controls.unknownAt === controls.forks) throw new Error('Synthetic response loss')
      return receipt
    },
    async inspectMigration(request) {
      calls.push('inspect')
      if (controls.notFound) return { ...request, migrationProtocol: 'qaf-session-migration/1', state: 'not-found',
        childSessionId: null, idempotency: 'not-found', missingReasons: [] }
      return { ...receipts.get(request.migrationId)!, idempotency: 'replayed' }
    }
  }
  const options: NativeSessionMigrationOptions = { store, configuration, candidate, port, signal: new AbortController().signal,
    async recheck() {}, finalize() {
      if (controls.finalizeFails) throw new Error('Synthetic finalize failure')
      captureNativeConfigurationBaseline(store, candidate, [])
    } }
  async function preview() { return previewNativeSessionMigration(options) }
  async function commit(prepared: Awaited<ReturnType<typeof preview>>) {
    assert(prepared.migrationId && prepared.revision)
    return commitNativeSessionMigration(options, { revisions, confirm: true, migrationId: prepared.migrationId, revision: prepared.revision })
  }
  return { store, options, controls, calls, identity, candidate, preview, commit, conversations }
}

function personaOptions(fake: ReturnType<typeof fixture>, update: { identity?: string; style?: string; name?: string }): NativeSessionMigrationOptions {
  const baseline = readNativeConfigurationBaselineFromStore(fake.store)
  assert(baseline.values)
  const original = baseline.values
  const persona = { ...original.persona, ...update }
  const definition = { ...original.definition, persona: { identity: persona.identity, style: persona.style } }
  const candidate = { definition, persona, endpoint: original.endpoint,
    bindings: [{ definition, agentPreset: `persona-${digest(persona).slice(0, 24)}` }] }
  const plan = { ...fake.options.configuration.catalog.plans[0], id: definition.planId, instructions: definition.instructions }
  const configuration = { ...fake.options.configuration, personas: [persona], catalog: { activePlanId: plan.id, plans: [plan] },
    revisions: { ...fake.options.configuration.revisions, personas: digest(persona) } }
  return { ...fake.options, configuration, candidate, finalize() {
    if (fake.controls.finalizeFails) throw new Error('Synthetic persona finalize interruption')
    captureNativeConfigurationBaseline(fake.store, candidate, [])
  } }
}

async function commitOptions(options: NativeSessionMigrationOptions, prepared: NativeSessionMigrationResult) {
  assert(prepared.migrationId && prepared.revision)
  return commitNativeSessionMigration(options, { revisions: options.configuration.revisions, confirm: true,
    migrationId: prepared.migrationId, revision: prepared.revision })
}

test('migration retains historical namespaces and revoked grant bytes while CAS switching to a child', async context => {
  const fake = fixture(context)
  const preserved = ['native-chat.tool-scopes', 'native-usage.turns', 'host.agent-events', 'outbox', 'policy.grants', 'native-chat.whitelist-policy']
    .map(namespace => [namespace, digest(fake.store.list(namespace))] as const)
  const prepared = await fake.preview()
  assert.equal(prepared.state, 'available')
  assert.deepEqual(fake.calls, ['preview'])
  const result = await fake.commit(prepared)
  assert.equal(result.state, 'completed')
  const binding = object(fake.store.read('host.sessions', 'private:1')!.value)
  assert.equal(binding.sessionId, 'child-1')
  assert.equal(binding.generation, 2)
  assert.equal(fake.store.list(NATIVE_SESSION_ARCHIVES).length, 1)
  const archive = object(fake.store.list(NATIVE_SESSION_ARCHIVES)[0].value)
  assert.equal(object(object(archive.source).value).sessionId, 'source-0')
  for (const [namespace, before] of preserved) assert.equal(digest(fake.store.list(namespace)), before)
  const target = String(object(fake.store.read('native-chat.meta', 'session-definition')!.value).identity)
  assert.equal(readMigrationAuthorizationIdentity(fake.store, target), fake.identity)
  assert.equal((await fake.commit(prepared)).state, 'completed')
  assert.equal(fake.controls.forks, 1)
})

test('lost fork response remains unknown and a later explicit commit only inspects the same migration', async context => {
  const fake = fixture(context)
  fake.controls.unknownAt = 1
  const prepared = await fake.preview()
  assert.equal((await fake.commit(prepared)).state, 'unknown')
  assert.equal(object(fake.store.read('host.sessions', 'private:1')!.value).sessionId, 'source-0')
  assert.equal((await fake.preview()).migrationId, prepared.migrationId)
  assert.equal((await fake.commit(prepared)).state, 'completed')
  assert.deepEqual(fake.calls, ['preview', 'fork', 'inspect'])
})

test('inspect not-found never authorizes a second fork', async context => {
  const fake = fixture(context)
  fake.controls.unknownAt = 1
  const prepared = await fake.preview()
  assert.equal((await fake.commit(prepared)).state, 'unknown')
  fake.controls.notFound = true
  assert.equal((await fake.commit(prepared)).state, 'unknown')
  assert.equal((await fake.commit(prepared)).state, 'unknown')
  assert.equal(fake.controls.forks, 1)
})

test('a partial multi-conversation migration resumes without repeating the first fork', async context => {
  const fake = fixture(context, 2)
  fake.controls.unknownAt = 2
  const prepared = await fake.preview()
  assert.equal((await fake.commit(prepared)).state, 'partial')
  assert.equal(object(fake.store.read('native-chat.meta', 'session-definition')!.value).identity, fake.identity)
  assert.equal((await fake.commit(prepared)).state, 'completed')
  assert.equal(fake.controls.forks, 2)
  assert.equal(fake.calls.filter(call => call === 'inspect').length, 1)
  for (const conversation of fake.conversations) assert.equal(object(fake.store.read('host.sessions', conversation)!.value).generation, 2)
})

test('binding CAS drift after an acknowledged fork never overwrites the changed mapping', async context => {
  const fake = fixture(context)
  const prepared = await fake.preview()
  fake.controls.beforeReply = () => {
    const record = fake.store.read('host.sessions', 'private:1')!
    fake.store.write('host.sessions', record.key, { ...object(record.value), sessionId: 'other-session', generation: 3 }, { expectedRevision: record.revision })
  }
  assert.equal((await fake.commit(prepared)).state, 'unknown')
  assert.equal(object(fake.store.read('host.sessions', 'private:1')!.value).sessionId, 'other-session')
  assert.equal(object(fake.store.read('native-chat.meta', 'session-definition')!.value).identity, fake.identity)
  assert.equal((await fake.commit(prepared)).state, 'unknown')
  assert.equal(fake.controls.forks, 1)
})

test('whitelist-only migration does not invent counted budget lineage', async context => {
  const fake = fixture(context)
  const options = { ...fake.options, configuration: { ...fake.options.configuration,
    authorization: { version: 'counted', grants: [] } } }
  assert.equal((await previewNativeSessionMigration(options)).state, 'blocked')
  assert.deepEqual(fake.calls, [])
})

test('model, context, capability, endpoint and persona changes remain outside the first migration scope', context => {
  const fake = fixture(context)
  const baseline = readNativeConfigurationBaselineFromStore(fake.store)
  const candidates = [
    { ...fake.candidate, endpoint: 'http://127.0.0.1:3081' },
    { ...fake.candidate, persona: { ...fake.candidate.persona, style: 'Changed' } },
    { ...fake.candidate, definition: { ...fake.candidate.definition, model: { ...fake.candidate.definition.model, name: 'other' } } },
    { ...fake.candidate, definition: { ...fake.candidate.definition, contextLimits: { group: 9_000, private: 10_000 } } },
    { ...fake.candidate, definition: { ...fake.candidate.definition, capabilitySelection: null } }
  ]
  for (const candidate of candidates) assert(nativeSessionMigrationEligibility(baseline, candidate).length > 0)
})

test('an unknown old outbox outcome blocks preview without remote calls', async context => {
  const fake = fixture(context)
  fake.store.write('outbox', 'unknown', { conversationId: 'private:1', status: 'unknown' })
  await assert.rejects(fake.preview, { code: 'NATIVE_SESSION_MIGRATION_UNSETTLED' })
  assert.deepEqual(fake.calls, [])
})

test('policy drift after preview blocks before the fork and preserves the original identity', async context => {
  const fake = fixture(context)
  const prepared = await fake.preview()
  fake.store.write('policy.meta', 'global', { schema: 1, paused: true, nextGrantOrder: 1 })
  assert.equal((await fake.commit(prepared)).state, 'blocked')
  assert.equal(fake.controls.forks, 0)
  assert.equal(object(fake.store.read('native-chat.meta', 'session-definition')!.value).identity, fake.identity)
})

test('metadata-finalization interruption keeps the migration blocked until explicit same-plan reconciliation', async context => {
  const fake = fixture(context)
  const prepared = await fake.preview()
  fake.controls.finalizeFails = true
  assert.equal((await fake.commit(prepared)).state, 'partial')
  fake.controls.finalizeFails = false
  assert.equal((await fake.commit(prepared)).state, 'completed')
  assert.equal(fake.controls.forks, 1)
})

test('only retired bindings release the active-session guard; creating and unknown remain active', context => {
  const fake = fixture(context)
  assert.equal(hasActiveNativeSessions(fake.store), true)
  fake.store.write('host.sessions', 'private:1', { schema: 1, state: 'retired', generation: 2, requestId: null, sessionId: null, updatedAt: 2 })
  assert.equal(hasActiveNativeSessions(fake.store), false)
  for (const state of ['creating', 'unknown']) {
    fake.store.write('host.sessions', 'private:1', { schema: 1, state, generation: 3, requestId: 'request', sessionId: null, updatedAt: 3 })
    assert.equal(hasActiveNativeSessions(fake.store), true)
  }
})

test('actual readonly compatibility releases retired bindings but retains persona identity protection', context => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-compatibility-'))
  const fake = fixture(context, 1, join(directory, 'native-chat.sqlite'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  assert.equal(inspectNativeConfigurationCompatibility(directory, fake.candidate).state, 'blocked')
  fake.store.write('host.sessions', 'private:1', { schema: 1, state: 'retired', generation: 2, requestId: null, sessionId: null, updatedAt: 2 })
  const released = inspectNativeConfigurationCompatibility(directory, fake.candidate)
  assert.equal(released.state, 'no-history')
  assert.equal(released.hasPersistedSessions, false)
  assert.deepEqual(released.reasons, [])
  const persona = { ...fake.candidate.persona, style: 'Different identity content' }
  const definition = buildChatSessionDefinition(fake.options.configuration.catalog.plans[0], persona)
  const changed = { ...fake.candidate, persona, definition, bindings: [{ definition, agentPreset: 'changed-persona-preset' }] }
  assert(inspectNativeConfigurationCompatibility(directory, changed).reasons.includes('persisted_persona_identity_conflict'))
})

test('actual readonly compatibility blocks an interrupted migration even after identity finalization', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-interruption-'))
  const fake = fixture(context, 1, join(directory, 'native-chat.sqlite'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const prepared = await fake.preview()
  fake.controls.finalizeFails = true
  assert.equal((await fake.commit(prepared)).state, 'partial')
  const current = inspectNativeConfigurationCompatibility(directory, fake.candidate)
  assert.equal(current.state, 'blocked')
  assert(current.reasons.includes('session_migration_reconciliation_required'))
  fake.controls.finalizeFails = false
  assert.equal((await fake.commit(prepared)).state, 'completed')
  assert.equal(inspectNativeConfigurationCompatibility(directory, fake.candidate).state, 'compatible')
})

test('source configuration identity CAS drift is rejected before any fork', async context => {
  const fake = fixture(context)
  const prepared = await fake.preview()
  fake.store.write('native-chat.meta', 'session-definition', { identity: 'c'.repeat(64) })
  assert.equal((await fake.commit(prepared)).state, 'blocked')
  assert.equal(fake.controls.forks, 0)
})

test('quiescence accepts settled cancelled timeouts but rejects unknown terminal enums and corrupt schema', context => {
  const fake = fixture(context)
  const execution = { schema: 1, binding: { conversationId: 'private:1', sessionId: 'source-0', generation: 1 },
    status: 'timed-out', externalStatus: 'cancelled', isolated: false, cancelStatus: 'confirmed', noticeStatus: 'confirmed' }
  const check = () => verifyMigrationQuiescence(fake.store, new Set(['private:1']), new Set(['source-0']))
  for (const status of ['completed', 'failed', 'rejected', 'timed-out']) {
    fake.store.write('host.executions', 'settled', { ...execution, status })
    assert.doesNotThrow(check)
  }
  for (const invalid of [{ schema: 2 }, { status: 'future-terminal' }, { externalStatus: 'future-terminal' },
    { cancelStatus: 'future-terminal' }, { noticeStatus: 'future-terminal' }, { status: null },
    { externalStatus: 'unknown' }, { cancelStatus: 'accepted' }, { noticeStatus: 'unknown' }, { isolated: true }]) {
    fake.store.write('host.executions', 'settled', { ...execution, ...invalid })
    assert.throws(check, { code: 'NATIVE_SESSION_MIGRATION_UNSETTLED' })
  }
})

test('same-ID persona identity and style receive new content and scope versions only after a completed child migration', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'persona-migration-'))
  const fake = fixture(context, 1, join(directory, 'native-chat.sqlite'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const options = personaOptions(fake, { identity: 'One changed word', style: 'A new concise style' })
  const source = fake.store.read('native-chat.meta', 'persona-identity')!
  const before = ['policy.grants', 'native-chat.whitelist-policy', 'outbox', 'native-usage.turns', 'native-chat.tool-scopes']
    .map(namespace => [namespace, digest(fake.store.list(namespace))] as const)
  const prior = inspectNativeConfigurationCompatibility(directory, options.candidate)
  assert(prior.reasons.includes('persisted_session_configuration_conflict'))
  assert(prior.reasons.includes('persisted_persona_identity_conflict'))
  assert.deepEqual(nativeSessionMigrationEligibility(readNativeConfigurationBaselineFromStore(fake.store), options.candidate), [])
  const prepared = await previewNativeSessionMigration(options)
  assert.equal(prepared.state, 'available')
  assert.equal(fake.store.read('native-chat.meta', 'persona-identity')!.revision, source.revision)
  assert.equal((await commitOptions(options, prepared)).state, 'completed')
  const current = fake.store.read('native-chat.meta', 'persona-identity')!
  const persona = createNativePersonaIdentity(options.candidate.persona!)
  assert.equal(object(current.value).contentVersion, persona.version)
  assert.equal(object(current.value).scopeVersion, persona.version)
  assert.notEqual(persona.version, object(source.value).scopeVersion)
  assert(current.revision > source.revision)
  assert.equal(persona.contextId, createNativePersonaIdentity(fake.options.candidate.persona!).contextId)
  assert.equal(inspectNativeConfigurationCompatibility(directory, options.candidate).state, 'compatible')
  for (const [namespace, original] of before) assert.equal(digest(fake.store.list(namespace)), original)
  const target = String(object(fake.store.read('native-chat.meta', 'session-definition')!.value).identity)
  assert.equal(readMigrationAuthorizationIdentity(fake.store, target), fake.identity)
})

test('a same-ID persona change can migrate again without an intervening model request or new grants', async context => {
  const fake = fixture(context)
  const grants = digest(fake.store.list('policy.grants'))
  const first = personaOptions(fake, { identity: 'First body' })
  const firstPreview = await previewNativeSessionMigration(first)
  assert.equal((await commitOptions(first, firstPreview)).state, 'completed')
  const second = personaOptions(fake, { identity: 'Second body', style: 'Second expression' })
  const secondPreview = await previewNativeSessionMigration(second)
  assert.equal(secondPreview.bindings[0].sourceSessionId, 'child-1')
  assert.equal((await commitOptions(second, secondPreview)).state, 'completed')
  const current = object(fake.store.read('native-chat.meta', 'persona-identity')!.value)
  assert.equal(current.contentVersion, createNativePersonaIdentity(second.candidate.persona!).version)
  assert.equal(current.scopeVersion, current.contentVersion)
  assert.equal(object(fake.store.read('host.sessions', 'private:1')!.value).generation, 3)
  assert.equal(fake.store.list(NATIVE_SESSION_ARCHIVES).length, 2)
  assert.equal(digest(fake.store.list('policy.grants')), grants)
  const target = String(object(fake.store.read('native-chat.meta', 'session-definition')!.value).identity)
  assert.equal(readMigrationAuthorizationIdentity(fake.store, target), fake.identity)
  assert.equal(fake.controls.forks, 2)
})

test('unknown persona fork leaves the old persona anchor intact until the same-plan inspection completes', async context => {
  const fake = fixture(context)
  const options = personaOptions(fake, { identity: 'Changed body' })
  const source = digest(fake.store.read('native-chat.meta', 'persona-identity'))
  fake.controls.unknownAt = 1
  const prepared = await previewNativeSessionMigration(options)
  assert.equal((await commitOptions(options, prepared)).state, 'unknown')
  assert.equal(digest(fake.store.read('native-chat.meta', 'persona-identity')), source)
  assert.equal((await previewNativeSessionMigration(options)).migrationId, prepared.migrationId)
  assert.equal((await commitOptions(options, prepared)).state, 'completed')
  assert.equal(fake.controls.forks, 1)
  assert.deepEqual(fake.calls, ['preview', 'fork', 'inspect'])
})

test('persona target metadata and policy digest recover strictly after finalization is interrupted', async context => {
  const fake = fixture(context)
  const options = personaOptions(fake, { identity: 'Changed body' })
  const prepared = await previewNativeSessionMigration(options)
  fake.controls.finalizeFails = true
  assert.equal((await commitOptions(options, prepared)).state, 'partial')
  const targetRevision = fake.store.read('native-chat.meta', 'persona-identity')!.revision
  fake.controls.finalizeFails = false
  assert.equal((await commitOptions(options, prepared)).state, 'completed')
  assert.equal(fake.store.read('native-chat.meta', 'persona-identity')!.revision, targetRevision)
  assert.equal(fake.controls.forks, 1)
})

test('persona metadata CAS drift is not hidden by policy-digest normalization', async context => {
  const fake = fixture(context)
  const options = personaOptions(fake, { identity: 'Changed body' })
  const prepared = await previewNativeSessionMigration(options)
  const source = fake.store.read('native-chat.meta', 'persona-identity')!
  fake.store.write('native-chat.meta', source.key, { ...object(source.value), scopeVersion: 'f'.repeat(64) }, { expectedRevision: source.revision })
  assert.equal((await commitOptions(options, prepared)).state, 'blocked')
  assert.equal(object(fake.store.read('native-chat.meta', 'persona-identity')!.value).scopeVersion, 'f'.repeat(64))
  assert.equal(fake.controls.forks, 0)
})

test('persona target-anchor corruption after a partial commit is not treated as a verified target', async context => {
  const fake = fixture(context)
  const options = personaOptions(fake, { identity: 'Changed body' })
  const prepared = await previewNativeSessionMigration(options)
  fake.controls.finalizeFails = true
  assert.equal((await commitOptions(options, prepared)).state, 'partial')
  const target = fake.store.read('native-chat.meta', 'persona-identity')!
  fake.store.write('native-chat.meta', target.key, { ...object(target.value), scopeVersion: 'e'.repeat(64) }, { expectedRevision: target.revision })
  fake.controls.finalizeFails = false
  assert.equal((await commitOptions(options, prepared)).state, 'partial')
  assert.equal(object(fake.store.read('native-chat.meta', target.key)!.value).scopeVersion, 'e'.repeat(64))
  assert.equal(fake.controls.forks, 1)
})

test('same-persona unknown outbox from a retired conversation still blocks the persona transition', async context => {
  const fake = fixture(context)
  const options = personaOptions(fake, { identity: 'Changed body' })
  const metadata = object(fake.store.read('native-chat.meta', 'persona-identity')!.value)
  fake.store.write('outbox', 'retired-unknown', { conversationId: 'private:999', status: 'unknown',
    scope: { persona: { id: createNativePersonaIdentity(fake.options.candidate.persona!).contextId,
      version: metadata.scopeVersion! }, sessionId: 'retired-session', generation: 1 } })
  await assert.rejects(() => previewNativeSessionMigration(options), { code: 'NATIVE_SESSION_MIGRATION_UNSETTLED' })
  assert.deepEqual(fake.calls, [])
})

test('unattributable unknown outbox is not silently skipped during a persona transition', async context => {
  const fake = fixture(context)
  const options = personaOptions(fake, { identity: 'Changed body' })
  fake.store.write('outbox', 'unattributable', { conversationId: 'private:999', status: 'unknown' })
  await assert.rejects(() => previewNativeSessionMigration(options))
  assert.deepEqual(fake.calls, [])
})

test('changing persona ID remains forbidden and a name-only edit is not claimed as a DSH migration', context => {
  const fake = fixture(context)
  const original = readNativeConfigurationBaselineFromStore(fake.store)
  const changed = personaOptions(fake, { identity: 'Changed body' }).candidate
  const persona = { ...changed.persona!, id: 'another-persona' }
  const definition = { ...changed.definition!, personaId: persona.id }
  const candidate = { ...changed, persona, definition, bindings: [{ definition, agentPreset: 'another-persona-preset' }] }
  assert(nativeSessionMigrationEligibility(original, candidate).length > 0)
  assert(nativeSessionMigrationEligibility(original, personaOptions(fake, { name: 'Display only' }).candidate).length > 0)
})

test('model and capacity migration persists verified target selection and reconciles a lost receipt without refork', async context => {
  const fake = fixture(context)
  const definition = { ...fake.candidate.definition, model: { provider: 'next-provider', name: 'next-model', reasoningEffort: 'high' as const },
    contextLimits: { group: 64000, private: 128000 } }
  const candidate = { ...fake.candidate, definition, bindings: [{ definition, agentPreset: 'next-preset', externalProvider: 'actual-private' }] }
  const selection = { provider: 'actual-private', model: 'next-model', reasoningEffort: 'high',
    contextLimits: { contextWindow: 128000, maxTokens: 16000, headroomTokens: 0 } }
  const options: NativeSessionMigrationOptions = { ...fake.options, candidate,
    async resolveTargetSelection(conversationId, targetPreset) {
      assert.equal(conversationId, 'private:1')
      assert.equal(targetPreset, 'next-preset')
      return structuredClone(selection)
    }, finalize() { captureNativeConfigurationBaseline(fake.store, candidate, []) } }
  assert.equal((await previewNativeSessionMigration({ ...options, resolveTargetSelection: undefined })).state, 'blocked')
  const prepared = await previewNativeSessionMigration(options)
  assert.equal(prepared.state, 'available')
  assert.deepEqual(prepared.bindings[0].targetSelection, selection)
  assert.deepEqual((await previewNativeSessionMigration(options)).bindings[0].targetSelection, selection)
  fake.controls.unknownAt = 1
  assert.equal((await commitOptions(options, prepared)).state, 'unknown')
  assert.equal((await commitOptions(options, prepared)).state, 'completed')
  assert.equal(fake.controls.forks, 1)
  assert.deepEqual(fake.calls, ['preview', 'preview', 'fork', 'inspect'])
  assert.equal(object(fake.store.read('host.sessions', 'private:1')!.value).generation, 2)
})

test('migration refuses unresolved delegated work and unknown result delivery', context => {
  const fake = fixture(context)
  for (const value of [{ status: 'running', delivery: 'not-requested' }, { status: 'unknown', delivery: 'unavailable' },
    { status: 'completed', delivery: 'unknown' }]) {
    fake.store.write('native-work.executions', 'work', { conversationId: 'private:1', parentSessionId: 'source-0', ...value })
    assert.throws(() => verifyMigrationQuiescence(fake.store, new Set(['private:1']), new Set(['source-0'])),
      { code: 'NATIVE_SESSION_MIGRATION_UNSETTLED' })
  }
  fake.store.write('native-work.executions', 'work', { conversationId: 'private:1', parentSessionId: 'source-0',
    status: 'completed', delivery: 'confirmed' })
  verifyMigrationQuiescence(fake.store, new Set(['private:1']), new Set(['source-0']))
})
