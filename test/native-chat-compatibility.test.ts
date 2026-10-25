import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { buildChatSessionDefinition } from '../src/host/chat-plans.ts'
import { captureNativeConfigurationBaseline, inspectNativeConfigurationCompatibility, readNativeConfigurationBaseline,
  NATIVE_CONFIGURATION_BASELINE_NAMESPACE, type NativeConfigurationCandidate } from '../src/host/native-chat-compatibility.ts'
import { createNativePersonaIdentity } from '../src/host/native-persona-identity.ts'
import { json } from '../src/host/data.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { FrameworkError } from '../src/core/values.ts'

const persona = { id: 'operator', name: 'Original display name', identity: 'Original identity', style: 'Original style' }
const plan = { id: 'daily', name: 'Daily', description: '', instructions: 'Original instructions, not a composed prefix.',
  personaId: persona.id, provider: 'local', model: 'model', reasoningEffort: 'off' as const,
  contextLimits: { group: 100_000, private: 120_000 } }
const definition = buildChatSessionDefinition(plan, persona)
const candidate: NativeConfigurationCandidate = { definition, persona, endpoint: 'http://127.0.0.1:8010/dsh',
  bindings: [{ agentPreset: 'original', definition, conversationKind: 'private', externalProvider: 'external' }] }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function fixture(context: TestContext, current = candidate) {
  const directory = mkdtempSync(join(tmpdir(), 'native-compatibility-'))
  const filename = join(directory, 'native-chat.sqlite')
  const store = createSqliteStore({ filename })
  const identity = fingerprint({ definition: current.definition, endpoint: current.endpoint, bindings: current.bindings })
  store.write('native-chat.meta', 'session-definition', { identity })
  const version = createNativePersonaIdentity(current.persona!).version
  store.write('native-chat.meta', 'persona-identity', { schema: 1, nativeId: current.persona!.id, contentVersion: version, scopeVersion: version })
  store.write('host.sessions', 'private:123', { schema: 1, state: 'ready', generation: 1, requestId: 'old-create', sessionId: 'old-session', updatedAt: 1 })
  context.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const records = () => [store.list('native-chat.meta'), store.list('host.sessions'), store.list(NATIVE_CONFIGURATION_BASELINE_NAMESPACE)]
  return { directory, filename, store, records }
}

test('legacy omitted context limits capture and read preserve exact definition and same persisted identity', context => {
  const { contextLimits, ...legacyDefinition } = definition
  assert.deepEqual(contextLimits, plan.contextLimits)
  const legacy = { ...candidate, definition: legacyDefinition,
    bindings: candidate.bindings.map(binding => ({ ...binding, definition: legacyDefinition })) }
  const fake = fixture(context, legacy)
  const identity = fake.store.read('native-chat.meta', 'session-definition')
  const sessions = fake.store.list('host.sessions')
  assert.equal(Object.hasOwn(legacy.definition, 'contextLimits'), false)
  assert.equal(captureNativeConfigurationBaseline(fake.store, legacy, []), true)
  const stored = fake.store.list(NATIVE_CONFIGURATION_BASELINE_NAMESPACE)[0]!
  const values = (stored.value as { values: { definition: object } }).values
  assert.equal(Object.hasOwn(values.definition, 'contextLimits'), false)
  const baseline = readNativeConfigurationBaseline(fake.directory)
  assert.equal(baseline.state, 'available')
  assert.deepEqual(baseline.values?.definition, legacyDefinition)
  assert.equal(Object.hasOwn(baseline.values!.definition, 'contextLimits'), false)
  const compatible = inspectNativeConfigurationCompatibility(fake.directory, legacy)
  assert.equal(compatible.state, 'compatible')
  assert.deepEqual(compatible.reasons, [])
  assert.deepEqual(compatible.differences, [])
  assert.equal(compatible.baseline.state, 'available')
  assert.equal(captureNativeConfigurationBaseline(fake.store, legacy, []), true)
  assert.deepEqual(fake.store.list(NATIVE_CONFIGURATION_BASELINE_NAMESPACE), [stored])
  assert.deepEqual(fake.store.read('native-chat.meta', 'session-definition'), identity)
  assert.deepEqual(fake.store.list('host.sessions'), sessions)
})

test('explicit default context limits stay present in exact baseline capture and read', context => {
  const explicitDefinition = { ...definition, contextLimits: { group: 128_000, private: 128_000 } }
  const explicit = { ...candidate, definition: explicitDefinition,
    bindings: candidate.bindings.map(binding => ({ ...binding, definition: explicitDefinition })) }
  const fake = fixture(context, explicit)
  assert.equal(captureNativeConfigurationBaseline(fake.store, explicit, []), true)
  const baseline = readNativeConfigurationBaseline(fake.directory)
  assert.equal(baseline.state, 'available')
  assert.equal(Object.hasOwn(baseline.values!.definition, 'contextLimits'), true)
  assert.deepEqual(baseline.values!.definition, explicitDefinition)
  assert.equal(inspectNativeConfigurationCompatibility(fake.directory, explicit).state, 'compatible')
})

test('own invalid context limits are rejected rather than treated as legacy omission', context => {
  const fake = fixture(context)
  const before = fake.records()
  for (const contextLimits of [undefined, null, { group: 0, private: 120_000 }, { group: 100_000 }, { group: 100_000, private: 120_000, extra: true }]) {
    const invalid = { ...candidate, definition: { ...definition, contextLimits } } as unknown as NativeConfigurationCandidate
    assert.throws(() => captureNativeConfigurationBaseline(fake.store, invalid, []), TypeError)
    assert.deepEqual(fake.records(), before)
  }
})

test('compatibility and baseline reads never create a missing directory or database', context => {
  const directory = mkdtempSync(join(tmpdir(), 'native-compatibility-absent-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const path of [directory, join(directory, 'absent')]) {
    assert.equal(inspectNativeConfigurationCompatibility(path, candidate).state, 'no-history')
    assert.deepEqual(readNativeConfigurationBaseline(path), { schema: 1, state: 'missing', capturedAt: null, values: null, unavailableReason: 'not-recorded' })
  }
  assert.deepEqual(readdirSync(directory), [])
})

test('readonly preflight reports exact definition, endpoint, binding and persona differences without mutating any original record', context => {
  const fake = fixture(context)
  assert.equal(captureNativeConfigurationBaseline(fake.store, candidate, ['credential-never-included']), true)
  const before = fake.records()
  const changes: Array<{ value: NativeConfigurationCandidate; difference: string; reason: string }> = [
    { value: { ...candidate, definition: { ...definition, instructions: 'Changed' } }, difference: 'instructions', reason: 'persisted_session_configuration_conflict' },
    { value: { ...candidate, definition: { ...definition, contextLimits: { group: 110_000, private: 120_000 } } }, difference: 'contextLimits', reason: 'persisted_session_configuration_conflict' },
    { value: { ...candidate, definition: { ...definition, model: { ...definition.model, name: 'new-model' } } }, difference: 'model.name', reason: 'persisted_session_configuration_conflict' },
    { value: { ...candidate, definition: { ...definition, capabilitySelection: { schema: 1, presetId: 'source-work', revision: 'a'.repeat(64) } } }, difference: 'capabilitySelection', reason: 'persisted_session_configuration_conflict' },
    { value: { ...candidate, endpoint: `${candidate.endpoint}/` }, difference: 'endpoint', reason: 'persisted_session_configuration_conflict' },
    { value: { ...candidate, persona: { ...persona, name: 'Changed name' } }, difference: 'persona.name', reason: 'persisted_persona_identity_conflict' },
    { value: { ...candidate, bindings: [{ ...candidate.bindings[0]!, agentPreset: 'different' }] }, difference: 'bindings', reason: 'persisted_session_configuration_conflict' }
  ]
  assert.equal(inspectNativeConfigurationCompatibility(fake.directory, candidate).state, 'compatible')
  for (const change of changes) {
    const result = inspectNativeConfigurationCompatibility(fake.directory, change.value)
    assert.equal(result.state, 'blocked')
    assert(result.differences.includes(change.difference))
    assert(result.reasons.includes(change.reason))
    assert.equal(result.recovery.mode, 'restore-original-values')
  }
  assert.deepEqual(fake.records(), before)
})

test('legacy missing or malformed baselines never invent recoverable original values or overwrite same-identity evidence', context => {
  const fake = fixture(context)
  const changed = { ...candidate, endpoint: `${candidate.endpoint}/` }
  const missing = inspectNativeConfigurationCompatibility(fake.directory, changed)
  assert.equal(missing.state, 'blocked')
  assert.equal(missing.baseline.state, 'missing')
  assert.equal(missing.recovery.mode, 'operator-original-values-required')
  assert.deepEqual(missing.differences, [])
  assert.equal(captureNativeConfigurationBaseline(fake.store, candidate, []), true)
  const baseline = fake.store.list(NATIVE_CONFIGURATION_BASELINE_NAMESPACE)[0]!
  assert.equal(captureNativeConfigurationBaseline(fake.store, candidate, []), true)
  assert.deepEqual(fake.store.read(NATIVE_CONFIGURATION_BASELINE_NAMESPACE, baseline.key), baseline)
  fake.store.write(NATIVE_CONFIGURATION_BASELINE_NAMESPACE, baseline.key, json({ ...baseline.value as object, checksum: 'bad' }))
  const before = fake.records()
  assert.equal(readNativeConfigurationBaseline(fake.directory).state, 'invalid')
  assert.equal(captureNativeConfigurationBaseline(fake.store, candidate, []), false)
  assert.deepEqual(fake.records(), before)
})

test('successful baseline projection retains exact raw instructions, selection and persona name but excludes credentials and refuses known-secret text', context => {
  const selectedDefinition = { ...definition, capabilitySelection: { schema: 1 as const, presetId: 'work-source', revision: 'b'.repeat(64) } }
  const selected = { ...candidate, definition: selectedDefinition }
  const fake = fixture(context, selected)
  assert.equal(captureNativeConfigurationBaseline(fake.store, selected, ['operator-private-key']), true)
  const values = readNativeConfigurationBaseline(fake.directory).values!
  assert.deepEqual(values.definition, selectedDefinition)
  assert.deepEqual(values.persona, persona)
  assert.equal(values.endpoint, candidate.endpoint)
  assert.deepEqual(Object.keys(values).sort(), ['bindings', 'definition', 'endpoint', 'persona'])
  assert(!JSON.stringify(values).includes('operator-private-key'))
  const secretDefinition = { ...definition, instructions: 'Do not retain operator-private-key here.' }
  const unsafe = { ...candidate, definition: secretDefinition }
  const withheld = fixture(context, unsafe)
  assert.equal(captureNativeConfigurationBaseline(withheld.store, unsafe, ['operator-private-key']), false)
  assert.equal(readNativeConfigurationBaseline(withheld.directory).state, 'missing')
  assert.equal(readNativeConfigurationBaseline(withheld.directory).unavailableReason, 'sensitive-content')
})

test('corruption and unsafe history remain explicitly unavailable and hard baseline writes propagate failure', context => {
  const fake = fixture(context)
  const before = fake.records()
  chmodSync(fake.filename, 0o644)
  assert.equal(inspectNativeConfigurationCompatibility(fake.directory, candidate).state, 'unavailable')
  assert.equal(readNativeConfigurationBaseline(fake.directory).state, 'unavailable')
  chmodSync(fake.filename, 0o600)
  assert.deepEqual(fake.records(), before)
  assert.throws(() => captureNativeConfigurationBaseline({ ...fake.store, write() { throw new Error('SYNTHETIC_STORAGE_FAILURE') } }, candidate, []), /SYNTHETIC_STORAGE_FAILURE/)
  const directory = mkdtempSync(join(tmpdir(), 'native-compatibility-corrupt-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'native-chat.sqlite')
  writeFileSync(filename, 'synthetic-corrupt-database', { mode: 0o600 })
  const corrupt = readFileSync(filename)
  assert.equal(readNativeConfigurationBaseline(directory).state, 'unavailable')
  assert.equal(inspectNativeConfigurationCompatibility(directory, candidate).state, 'unavailable')
  assert.deepEqual(readFileSync(filename), corrupt)
})

test('baseline keys include actual persona content and scope versions even when persona name leaves definition identity unchanged', context => {
  const fake = fixture(context)
  fake.store.delete('host.sessions', 'private:123')
  assert.equal(captureNativeConfigurationBaseline(fake.store, candidate, []), true)
  const original = fake.store.list(NATIVE_CONFIGURATION_BASELINE_NAMESPACE)[0]!
  const renamed = { ...persona, name: 'Different original name' }
  const version = createNativePersonaIdentity(renamed).version
  fake.store.write('native-chat.meta', 'persona-identity', { schema: 1, nativeId: persona.id, contentVersion: version, scopeVersion: version })
  assert.equal(readNativeConfigurationBaseline(fake.directory).state, 'missing')
  assert.equal(captureNativeConfigurationBaseline(fake.store, { ...candidate, persona: renamed }, []), true)
  assert.equal(readNativeConfigurationBaseline(fake.directory).values?.persona.name, renamed.name)
  fake.store.write('native-chat.meta', 'persona-identity', { schema: 1, nativeId: persona.id, contentVersion: version, scopeVersion: 'c'.repeat(64) })
  assert.equal(readNativeConfigurationBaseline(fake.directory).state, 'missing')
  assert.equal(captureNativeConfigurationBaseline(fake.store, { ...candidate, persona: renamed }, []), true)
  assert.equal(fake.store.list(NATIVE_CONFIGURATION_BASELINE_NAMESPACE).length, 3)
  assert.deepEqual(fake.store.read(NATIVE_CONFIGURATION_BASELINE_NAMESPACE, original.key), original)
})

test('maximum valid Unicode instructions and persona sections with 128 repeated binding definitions retain exact originals in bounded descriptors', context => {
  const largePersona = { ...persona, identity: '身'.repeat(16_000), style: '风'.repeat(16_000) }
  const largeDefinition = buildChatSessionDefinition({ ...plan, instructions: '规'.repeat(32_000) }, largePersona)
  const large = { ...candidate, definition: largeDefinition, persona: largePersona,
    bindings: Array.from({ length: 128 }, (_value, index) => ({ agentPreset: `preset-${index}`, definition: largeDefinition,
      conversationKind: 'private' as const, externalProvider: `provider-${index}` })) }
  const fake = fixture(context, large)
  assert.equal(captureNativeConfigurationBaseline(fake.store, large, []), true)
  const baseline = readNativeConfigurationBaseline(fake.directory)
  assert.equal(baseline.state, 'available')
  assert.deepEqual(baseline.values?.definition, largeDefinition)
  assert.deepEqual(baseline.values?.persona, largePersona)
  assert.equal(baseline.values?.bindings.length, 128)
  const bytes = Buffer.byteLength(JSON.stringify(baseline.values))
  assert(bytes <= 524_288)
  assert(!Object.hasOwn(baseline.values!.bindings[0]!, 'definition'))
  context.diagnostic(`large valid baseline bytes=${bytes}; full repeated bindings bytes=${Buffer.byteLength(JSON.stringify(large.bindings))}`)
})

test('baseline record exhaustion is explicit and never renews existing records or changes configuration', context => {
  const fake = fixture(context)
  for (let index = 0; index < 64; index++) fake.store.write(NATIVE_CONFIGURATION_BASELINE_NAMESPACE, `other-${index}`, { schema: 1 })
  const before = fake.records()
  assert.equal(captureNativeConfigurationBaseline(fake.store, candidate, []), false)
  const baseline = readNativeConfigurationBaseline(fake.directory)
  assert.equal(baseline.state, 'missing')
  assert.equal(baseline.unavailableReason, 'record-limit')
  assert.deepEqual(fake.records(), before)
})

test('real storage failures during existing-baseline validation propagate instead of becoming missing or invalid guidance', context => {
  const fake = fixture(context)
  captureNativeConfigurationBaseline(fake.store, candidate, [])
  let reads = 0
  assert.throws(() => captureNativeConfigurationBaseline({ ...fake.store, read(namespace, key) {
    if (namespace === NATIVE_CONFIGURATION_BASELINE_NAMESPACE && ++reads === 2) throw new FrameworkError('STORE_IO_ERROR', 'Synthetic storage read failure')
    return fake.store.read(namespace, key)
  } }, candidate, []), { code: 'STORE_IO_ERROR' })
})

test('64 actual withheld markers exhaust the shared quota and additional anchors cannot append more markers', context => {
  const fake = fixture(context)
  const version = createNativePersonaIdentity(persona).version
  for (let index = 0; index < 64; index++) {
    fake.store.write('native-chat.meta', 'persona-identity', { schema: 1, nativeId: persona.id,
      contentVersion: version, scopeVersion: fingerprint(['synthetic-verified-scope', index]) })
    assert.equal(captureNativeConfigurationBaseline(fake.store, candidate, [plan.instructions]), false)
    assert.equal(readNativeConfigurationBaseline(fake.directory).unavailableReason, 'sensitive-content')
  }
  const markers = fake.store.list(NATIVE_CONFIGURATION_BASELINE_NAMESPACE)
  assert.equal(markers.length, 64)
  for (let index = 64; index < 70; index++) {
    fake.store.write('native-chat.meta', 'persona-identity', { schema: 1, nativeId: persona.id,
      contentVersion: version, scopeVersion: fingerprint(['synthetic-verified-scope', index]) })
    assert.equal(captureNativeConfigurationBaseline(fake.store, candidate, [plan.instructions]), false)
    const before = fake.records()
    assert.equal(readNativeConfigurationBaseline(fake.directory).unavailableReason, 'record-limit')
    assert.equal(inspectNativeConfigurationCompatibility(fake.directory, candidate).baseline.unavailableReason, 'record-limit')
    assert.deepEqual(fake.records(), before)
    assert.deepEqual(fake.store.list(NATIVE_CONFIGURATION_BASELINE_NAMESPACE), markers)
  }
})

test('actual SQLite baseline insert failures are not swallowed and roll back the attempted row and revision', context => {
  const fake = fixture(context)
  const database = new DatabaseSync(fake.filename)
  try {
    database.exec(`CREATE TRIGGER fail_baseline BEFORE INSERT ON durable_records
      WHEN NEW.namespace = 'native-chat.configuration-baselines'
      BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_BASELINE_STORAGE_FAILURE'); END`)
    const before = fake.records()
    const revision = database.prepare("SELECT value FROM durable_meta WHERE name='revision'").get()
    assert.throws(() => captureNativeConfigurationBaseline(fake.store, candidate, []), { code: 'STORE_IO_ERROR' })
    assert.deepEqual(fake.records(), before)
    assert.deepEqual(database.prepare("SELECT value FROM durable_meta WHERE name='revision'").get(), revision)
    assert.equal(readNativeConfigurationBaseline(fake.directory).state, 'missing')
  } finally { database.close() }
})
