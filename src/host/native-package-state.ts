import { randomUUID } from 'node:crypto'
import type { JsonValue } from '../contracts/data.ts'
import type { DurableCasMutation, DurableStore, StoredRecord } from '../contracts/ports.ts'
import type { NativePackageStateEntry, NativePackageStateIdentity, NativePackageStateMigration, NativePackageStateSnapshot } from '../contracts/native-package-state.ts'
import { assert, errorCode, identifier, isRecord, reference, snapshot } from '../core/values.ts'
import { digest, json } from './data.ts'
import { withDeadline } from './deadlines.ts'

interface Metadata {
  readonly schema: 1
  readonly owner: string
  readonly identity: NativePackageStateIdentity
  readonly migration: NativePackageStateMigration | null
}
function identity(input: unknown): input is NativePackageStateIdentity {
  return isRecord(input) && Object.keys(input).length === 3 && typeof input.packageVersion === 'string'
    && /^\d+\.\d+\.\d+$/.test(input.packageVersion) && input.packageVersion.length <= 100
    && typeof input.stateSchemaVersion === 'number' && Number.isSafeInteger(input.stateSchemaVersion)
    && input.stateSchemaVersion > 0 && input.stateSchemaVersion <= 1000
    && typeof input.contentFingerprint === 'string' && /^[a-f0-9]{64}$/.test(input.contentFingerprint)
}
function same(left: NativePackageStateIdentity, right: NativePackageStateIdentity) { return digest(left) === digest(right) }

/** Migrations transform bounded package data only; external actions never participate in a storage transaction. */
export function createNativePackageState(options: {
  readonly store: DurableStore
  readonly owner: string
  readonly identity: NativePackageStateIdentity
  readonly verifyIdentity: (identity: NativePackageStateIdentity, signal: AbortSignal) => void | Promise<void>
  readonly timeoutMs?: number
}) {
  assert(identifier(options.owner) && identity(options.identity) && typeof options.verifyIdentity === 'function'
    && typeof options.store.compareAndSetBatch === 'function', 'PACKAGE_STATE_OPTIONS_INVALID', 'Package state requires verified content and atomic CAS storage.')
  const expected = snapshot(options.identity)
  const dataNamespace = `package.${options.owner}.state`
  const metadataNamespace = 'native-packages.state'
  const timeoutMs = options.timeoutMs ?? 10000
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300000, 'INVALID_TIMEOUT', 'A bounded migration deadline is required.')
  const batch = (mutations: readonly DurableCasMutation[]) => options.store.compareAndSetBatch!(mutations)
  function metadata(): { readonly stored: StoredRecord; readonly value: Metadata } | null {
    const stored = options.store.read(metadataNamespace, options.owner)
    if (!stored) return null
    const value = stored.value
    assert(isRecord(value) && Object.keys(value).length === 4 && value.schema === 1 && value.owner === options.owner
      && identity(value.identity), 'PACKAGE_STATE_INVALID', 'Package state metadata is invalid.')
    const pending = value.migration
    if (pending !== null) {
      assert(isRecord(pending) && Object.keys(pending).length === (pending.legacy === true ? 7 : 6)
        && (pending.legacy === undefined || pending.legacy === true) && reference(pending.operationId) && identity(pending.target)
        && ['prepared', 'applying', 'unknown'].includes(String(pending.phase)) && (pending.cursor === null || reference(pending.cursor))
        && Array.isArray(pending.source) && pending.source.length <= 60
        && (pending.lastError === null || typeof pending.lastError === 'string' && /^[A-Z][A-Z_]{1,63}$/.test(pending.lastError)),
      'PACKAGE_STATE_INVALID', 'Package migration evidence is invalid.')
      const seen = new Set<string>()
      for (const entry of pending.source) {
        assert(isRecord(entry) && Object.keys(entry).length === 3 && reference(entry.key) && !seen.has(entry.key)
          && typeof entry.revision === 'number' && Number.isSafeInteger(entry.revision) && entry.revision > 0
          && typeof entry.checksum === 'string' && /^[a-f0-9]{64}$/.test(entry.checksum), 'PACKAGE_STATE_INVALID', 'Package migration source evidence is invalid.')
        seen.add(entry.key)
      }
      assert(pending.phase !== 'prepared' || pending.source.length === 0, 'PACKAGE_STATE_INVALID', 'Prepared migrations cannot retain in-flight source evidence.')
    }
    return { stored, value: value as unknown as Metadata }
  }
  function status(): NativePackageStateSnapshot {
    const current = metadata()
    return snapshot({ schema: 1, owner: options.owner, revision: current?.stored.revision ?? null,
      identity: current?.value.identity ?? null, migration: current?.value.migration ?? null,
      ready: !!current && current.value.migration === null && same(current.value.identity, expected) })
  }
  function requireMetadata(revision?: number) {
    const current = metadata()
    assert(current, 'PACKAGE_STATE_NOT_INITIALIZED', 'Package state has not been explicitly initialized.')
    assert(revision === undefined || current.stored.revision === revision, 'PACKAGE_STATE_CONFLICT', 'Package state metadata changed.')
    return current
  }
  function ready() {
    const current = requireMetadata()
    assert(current.value.migration === null && same(current.value.identity, expected), 'PACKAGE_STATE_MIGRATION_REQUIRED', 'Package state must be explicitly migrated before use.')
    return current
  }
  function entry(stored: StoredRecord): NativePackageStateEntry {
    const value = stored.value
    assert(isRecord(value) && Object.keys(value).length === 6 && value.schema === 1 && value.owner === options.owner
      && value.key === stored.key && typeof value.stateSchemaVersion === 'number' && Number.isSafeInteger(value.stateSchemaVersion)
      && value.stateSchemaVersion >= 1 && value.stateSchemaVersion <= 1000 && typeof value.contentFingerprint === 'string'
      && /^[a-f0-9]{64}$/.test(value.contentFingerprint) && Object.hasOwn(value, 'value'), 'PACKAGE_STATE_INVALID', 'Stored package state is invalid.')
    return snapshot({ key: stored.key, revision: stored.revision, stateSchemaVersion: value.stateSchemaVersion,
      contentFingerprint: value.contentFingerprint, value: value.value as JsonValue })
  }
  function envelope(key: string, value: JsonValue, target = expected): JsonValue {
    return json({ schema: 1, owner: options.owner, key, stateSchemaVersion: target.stateSchemaVersion,
      contentFingerprint: target.contentFingerprint, value })
  }
  async function verify(signal: AbortSignal) {
    signal.throwIfAborted()
    await withDeadline({ signal, timeoutMs, code: 'PACKAGE_STATE_IDENTITY_UNAVAILABLE', run: currentSignal => options.verifyIdentity(expected, currentSignal) })
    signal.throwIfAborted()
  }
  function writeMetadata(current: ReturnType<typeof requireMetadata>, next: Metadata) {
    return options.store.write(metadataNamespace, options.owner, json(next), { expectedRevision: current.stored.revision })
  }
  return Object.freeze({ status,
    async prepareLegacyAdoption(signal: AbortSignal): Promise<NativePackageStateSnapshot> {
      await verify(signal)
      assert(metadata() === null, 'PACKAGE_STATE_CONFLICT', 'Only unclaimed legacy state may be explicitly adopted.')
      assert(options.store.list(dataNamespace, { limit: 1 }).length > 0, 'PACKAGE_STATE_ADOPTION_NOT_REQUIRED', 'Empty state must use explicit initialization.')
      batch([{ kind: 'write', namespace: metadataNamespace, key: options.owner, expectedRevision: null,
        value: json({ schema: 1, owner: options.owner, identity: expected,
          migration: { legacy: true, operationId: randomUUID(), target: expected, phase: 'prepared', cursor: null, source: [], lastError: null } }) }])
      return status()
    },
    async initialize(signal: AbortSignal): Promise<NativePackageStateSnapshot> {
      await verify(signal)
      const current = metadata()
      if (current) { ready(); return status() }
      assert(options.store.list(dataNamespace, { limit: 1 }).length === 0, 'PACKAGE_STATE_ADOPTION_REQUIRED', 'Unclaimed legacy state needs explicit adoption.')
      batch([{ kind: 'write', namespace: metadataNamespace, key: options.owner, expectedRevision: null,
        value: json({ schema: 1, owner: options.owner, identity: expected, migration: null }) }])
      return status()
    },
    read(key: string): NativePackageStateEntry | null {
      assert(reference(key), 'PACKAGE_STATE_QUERY_INVALID', 'A bounded package state key is required.')
      ready()
      const stored = options.store.read(dataNamespace, key)
      if (!stored) return null
      const value = entry(stored)
      assert(value.stateSchemaVersion === expected.stateSchemaVersion && value.contentFingerprint === expected.contentFingerprint,
        'PACKAGE_STATE_INVALID', 'A state entry does not match its committed schema.')
      return value
    },
    async compareAndSet(key: string, revision: number | null, value: JsonValue, signal: AbortSignal): Promise<NativePackageStateEntry> {
      assert(reference(key), 'PACKAGE_STATE_QUERY_INVALID', 'A bounded package state key is required.')
      await verify(signal)
      const current = ready()
      const written = batch([{ kind: 'check', namespace: metadataNamespace, key: options.owner, expectedRevision: current.stored.revision },
        { kind: 'write', namespace: dataNamespace, key, expectedRevision: revision, value: envelope(key, value) }])[1]
      assert(written, 'PACKAGE_STATE_INVALID', 'The state update did not return committed evidence.')
      return entry(written)
    },
    async prepare(revision: number, signal: AbortSignal): Promise<NativePackageStateSnapshot> {
      await verify(signal)
      const current = requireMetadata(revision)
      assert(current.value.migration === null, 'PACKAGE_STATE_RECONCILIATION_REQUIRED', 'An earlier migration is unresolved.')
      assert(!same(current.value.identity, expected) && expected.stateSchemaVersion >= current.value.identity.stateSchemaVersion,
        'PACKAGE_STATE_TARGET_INVALID', 'A migration needs a new content identity and cannot downgrade its state schema.')
      writeMetadata(current, { ...current.value, migration: { operationId: randomUUID(), target: expected,
        phase: 'prepared', cursor: null, source: [], lastError: null } })
      return status()
    },
    async applyPage(revision: number, operationId: string, transform: (entries: readonly NativePackageStateEntry[], signal: AbortSignal) =>
      readonly { readonly key: string; readonly value: JsonValue }[] | Promise<readonly { readonly key: string; readonly value: JsonValue }[]>, signal: AbortSignal): Promise<NativePackageStateSnapshot> {
      await verify(signal)
      const current = requireMetadata(revision)
      const pending = current.value.migration
      assert(pending && pending.operationId === operationId && same(pending.target, expected), 'PACKAGE_STATE_CONFLICT', 'The migration operation does not match.')
      assert(pending.phase === 'prepared', 'PACKAGE_STATE_RECONCILIATION_REQUIRED', 'Interrupted migration work requires explicit read-only reconciliation.')
      const page = options.store.list(dataNamespace, { limit: 60, ...(pending.cursor === null ? {} : { after: pending.cursor }) })
      const values = pending.legacy ? page.map(stored => snapshot({ key: stored.key, revision: stored.revision,
        stateSchemaVersion: 0, contentFingerprint: '0'.repeat(64), value: stored.value })) : page.map(entry)
      for (const value of values) assert(pending.legacy || value.stateSchemaVersion === current.value.identity.stateSchemaVersion
        && value.contentFingerprint === current.value.identity.contentFingerprint, 'PACKAGE_STATE_INVALID', 'A source entry does not match the migration identity.')
      const applying: Metadata = { ...current.value, migration: { ...pending, phase: 'applying',
        source: page.map(stored => ({ key: stored.key, revision: stored.revision, checksum: digest(stored.value) })), lastError: null } }
      const claim = writeMetadata(current, applying)
      try {
        const transformed = values.length === 0 ? [] : await withDeadline({ signal, timeoutMs, code: 'PACKAGE_STATE_MIGRATION_TIMEOUT_UNKNOWN',
          run: currentSignal => transform(snapshot(values), currentSignal) })
        signal.throwIfAborted()
        assert(Array.isArray(transformed) && transformed.length === values.length && new Set(transformed.map(item => item.key)).size === values.length,
          'PACKAGE_STATE_MIGRATION_RESULT_INVALID', 'Migration results must preserve the bounded source key set.')
        const writes: DurableCasMutation[] = values.map((value, index) => {
          const target = transformed.find(item => item.key === value.key)
          assert(target && Object.keys(target).length === 2, 'PACKAGE_STATE_MIGRATION_RESULT_INVALID', 'Migration results must preserve the source keys.')
          return { kind: 'write', namespace: dataNamespace, key: value.key, expectedRevision: value.revision,
            expiresAt: page[index]!.expiresAt, value: envelope(value.key, target.value) }
        })
        const complete = page.length < 60
        const next: Metadata = complete ? { schema: 1, owner: options.owner, identity: expected, migration: null }
          : { ...current.value, migration: { ...pending, phase: 'prepared', cursor: page.at(-1)!.key, source: [], lastError: null } }
        writes.push({ kind: 'write', namespace: metadataNamespace, key: options.owner, expectedRevision: claim.revision, value: json(next) })
        await verify(signal)
        batch(writes)
        return status()
      } catch (error) {
        try { options.store.write(metadataNamespace, options.owner, json({ ...applying, migration: { ...applying.migration!, phase: 'unknown',
          lastError: errorCode(error, 'PACKAGE_STATE_MIGRATION_UNKNOWN') } }), { expectedRevision: claim.revision }) } catch {}
        throw error
      }
    },
    async reconcile(revision: number, operationId: string, signal: AbortSignal): Promise<NativePackageStateSnapshot> {
      await verify(signal)
      const current = requireMetadata(revision)
      const pending = current.value.migration
      assert(pending && pending.operationId === operationId && same(pending.target, expected), 'PACKAGE_STATE_CONFLICT', 'The migration operation does not match.')
      assert(pending.phase !== 'prepared', 'PACKAGE_STATE_RECONCILIATION_NOT_REQUIRED', 'The migration is already at a verified checkpoint.')
      const checks: DurableCasMutation[] = []
      for (const source of pending.source) {
        const stored = options.store.read(dataNamespace, source.key)
        assert(stored && stored.revision === source.revision && digest(stored.value) === source.checksum,
          'PACKAGE_STATE_RECONCILIATION_CONFLICT', 'The interrupted source changed and cannot be replayed.')
        checks.push({ kind: 'check', namespace: dataNamespace, key: source.key, expectedRevision: source.revision })
      }
      checks.push({ kind: 'write', namespace: metadataNamespace, key: options.owner, expectedRevision: current.stored.revision,
        value: json({ ...current.value, migration: { ...pending, phase: 'prepared', source: [], lastError: null } }) })
      signal.throwIfAborted()
      batch(checks)
      return status()
    }
  })
}
export type NativePackageState = ReturnType<typeof createNativePackageState>
