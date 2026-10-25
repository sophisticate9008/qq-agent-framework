import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { AccountScope } from '../contracts/account-scope.ts'
import { parseNativeAccountRegistry, type NativeAccountConfiguration, type NativeAccountRegistry, type NativeAccountsSnapshot, type NativeAccountView, type NativeLegacyAdoptionPreview } from '../contracts/native-accounts.ts'
import { assertAccountScope, normalizeAccountScope } from '../core/account-scope.ts'
import { assert, errorCode, isRecord, snapshot } from '../core/values.ts'
import { ensurePrivateDirectory, readDocument, updateDocument, withDirectoryWriteLock, writeDocumentLocked } from '../storage/private-json.ts'
import { ACCOUNT_STORE_KEY, ACCOUNT_STORE_NAMESPACE, assertAccountStore } from '../storage/account-scope.ts'
import { createSqliteStore } from '../storage/sqlite.ts'
import { openReadonlySqliteStore } from '../storage/sqlite-readonly.ts'
import { withDeadline } from './deadlines.ts'

const EMPTY: NativeAccountRegistry = Object.freeze({ schema: 1, accounts: Object.freeze([]) })
const DATABASES = ['native-chat.sqlite', 'native-control.sqlite', 'native-memory.sqlite', 'native-reminders.sqlite'] as const
function registry(input: unknown): NativeAccountRegistry {
  const value = parseNativeAccountRegistry(input)
  assert(value, 'ACCOUNT_REGISTRY_INVALID', 'The account registry is invalid.')
  for (const entry of value.accounts) assert(entry.id === nativeAccountId(entry.accountScope), 'ACCOUNT_REGISTRY_INVALID', 'An account ID does not match its scope.')
  return value
}
export function nativeAccountId(input: AccountScope): string {
  const scope = normalizeAccountScope(input)
  return createHash('sha256').update(JSON.stringify([scope.protocolId, scope.accountId])).digest('hex')
}
export interface NativeAccountRuntime {
  state?(): NativeAccountView['state']
  start(signal: AbortSignal, revisions?: Readonly<Record<string, string>>): Promise<void>
  stop(signal: AbortSignal): Promise<void>
  close(): void | Promise<void>
}
export interface NativeAccountProtocol {
  readonly id: string
  readonly validateAccountId?: (accountId: string) => boolean
  /** Construct only. Network and other asynchronous work belongs in start(signal). */
  create(options: { readonly directory: string; readonly accountScope: AccountScope; readonly expectedSelfId: string }): NativeAccountRuntime
}
export type { NativeLegacyAdoptionPreview } from '../contracts/native-accounts.ts'
/** Each account receives real independent files and runtime; namespaced facades do not substitute for this boundary. */
export function createNativeAccounts(options: {
  readonly directory: string
  readonly protocols: readonly NativeAccountProtocol[]
  readonly timeoutMs?: number
  readonly legacy?: {
    isStopped(): boolean
    close?(): void | Promise<void>
    verifyIdentity(scope: AccountScope, signal: AbortSignal): Promise<{ readonly verified: boolean; readonly accountScope: AccountScope; readonly evidence: string }>
  }
}) {
  assert(isAbsolute(options.directory) && resolve(options.directory) === options.directory, 'ACCOUNT_DIRECTORY_INVALID', 'Accounts require a canonical private root.')
  assert(options.protocols.length <= 32, 'ACCOUNT_PROTOCOL_INVALID', 'The protocol registry is bounded.')
  const protocols = new Map<string, NativeAccountProtocol>()
  for (const protocol of options.protocols) {
    assert(/^[a-z][a-z0-9-]{0,63}$/.test(protocol.id) && typeof protocol.create === 'function' && !protocols.has(protocol.id),
      'ACCOUNT_PROTOCOL_DUPLICATE', 'Protocol adapters must be distinct registered factories.')
    protocols.set(protocol.id, protocol)
  }
  const timeoutMs = options.timeoutMs ?? 30_000
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300_000, 'INVALID_TIMEOUT', 'Account operations require a bounded deadline.')
  const filename = join(options.directory, 'native-accounts.json')
  const adoptionFilename = join(options.directory, 'native-account-adoption.json')
  function adoptionEvidence(input: unknown) {
    assert(isRecord(input) && Object.keys(input).length === 4 && input.schema === 1 && typeof input.id === 'string'
      && /^[a-f0-9]{64}$/.test(input.id) && Array.isArray(input.databases) && input.databases.length <= 4
      && input.databases.every(name => DATABASES.some(candidate => candidate === name))
      && new Set(input.databases).size === input.databases.length, 'ACCOUNT_ADOPTION_EVIDENCE_INVALID', 'The original adoption inventory must remain available.')
    return { schema: 1 as const, id: input.id, accountScope: normalizeAccountScope(input.accountScope), databases: input.databases as readonly string[] }
  }
  const identityFile = (directory: string) => join(directory, 'native-account-identity.json')
  type Instance = { runtime: NativeAccountRuntime; state: NativeAccountView['state']; reason: string | null; operation: number; start?: Promise<void>; stop?: Promise<void> }
  const instances = new Map<string, Instance>()
  const creating = new Map<string, Promise<NativeAccountRuntime>>()
  const invalidFactories = new Set<string>()
  const runtimeClosures = new WeakMap<NativeAccountRuntime, Promise<void>>()
  let closed = false
  let closeTask: Promise<void> | undefined
  const read = () => readDocument(filename, EMPTY, registry)
  function active() { assert(!closed, 'ACCOUNT_MANAGER_CLOSED', 'The account manager is closed.') }
  function closeRuntime(entry: Instance): Promise<void> {
    const prior = runtimeClosures.get(entry.runtime)
    if (prior) return prior
    // Install the shared task before invoking operator code, including reentrant close calls.
    const operation = ++entry.operation
    const task = Promise.resolve().then(() => withDeadline({ signal: new AbortController().signal, timeoutMs,
      code: 'ACCOUNT_CLOSE_UNKNOWN', run: () => entry.runtime.close() })).then(() => {
      if (entry.operation === operation) { entry.state = 'stopped'; entry.reason = null }
    }, error => {
      entry.state = 'unknown'; entry.reason = 'ACCOUNT_CLOSE_UNKNOWN'
      throw error
    })
    runtimeClosures.set(entry.runtime, task)
    return task
  }
  function directory(entry: NativeAccountConfiguration) {
    return entry.source === 'legacy-adopted' ? options.directory : join(options.directory, 'accounts', entry.id)
  }
  async function account(id: string) {
    active()
    const document = await read()
    const entry = document.value.accounts.find(item => item.id === id)
    assert(entry, 'ACCOUNT_NOT_FOUND', 'The account is not configured.')
    return entry
  }
  function identity(input: unknown) {
    assert(isRecord(input) && input.schema === 1 && (input.legacyAdopted === true || input.legacyAdopted === false), 'ACCOUNT_DIRECTORY_INVALID', 'The account directory has no valid identity.')
    return { schema: 1 as const, accountScope: normalizeAccountScope(input.accountScope), legacyAdopted: input.legacyAdopted }
  }
  async function verifyDirectory(entry: NativeAccountConfiguration) {
    const document = await readDocument(identityFile(directory(entry)), null, identity)
    assert(document.exists && document.value, 'ACCOUNT_DIRECTORY_UNBOUND', 'The account directory must be explicitly bound before use.')
    assertAccountScope(entry.accountScope, document.value.accountScope)
  }
  async function snapshotView(): Promise<NativeAccountsSnapshot> {
    const document = await read()
    return snapshot({ schema: 1, revision: document.revision, protocols: [...protocols.keys()],
      accounts: document.value.accounts.map(entry => ({ ...entry, state: entry.adoption === 'unknown' || invalidFactories.has(entry.id) || instances.get(entry.id)?.state === 'unknown' ? 'unknown' as const : instances.get(entry.id)?.runtime.state?.() ?? instances.get(entry.id)?.state ?? 'configured' as const,
        missingReasons: entry.adoption === 'unknown' ? ['account_adoption_reconciliation_required'] : !protocols.has(entry.accountScope.protocolId)
          ? ['account_protocol_unavailable'] : invalidFactories.has(entry.id) ? ['account_protocol_factory_invalid'] : instances.get(entry.id)?.reason ? [instances.get(entry.id)!.reason!] : [] })),
      legacy: { source: 'legacy-single', isolated: true, adoptedBy: document.value.accounts.find(item => item.source === 'legacy-adopted')?.id ?? null } })
  }
  async function runtime(id: string): Promise<NativeAccountRuntime> {
    active()
    assert(!invalidFactories.has(id), 'ACCOUNT_PROTOCOL_FACTORY_INVALID', 'A protocol factory must construct synchronously before account use.')
    const existing = instances.get(id); if (existing) return existing.runtime
    const pending = creating.get(id); if (pending) return pending
    const operation = (async () => {
      const entry = await account(id)
      assert(entry.adoption === 'ready', 'ACCOUNT_ADOPTION_RECONCILIATION_REQUIRED', 'Interrupted account adoption must be reconciled without replay.')
      const protocol = protocols.get(entry.accountScope.protocolId)
      assert(protocol, 'ACCOUNT_PROTOCOL_UNAVAILABLE', 'The selected protocol has no registered factory.')
      await verifyDirectory(entry)
      const result = protocol.create({ directory: directory(entry), accountScope: entry.accountScope, expectedSelfId: entry.accountScope.accountId })
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
        // Observe a rejected Promise without awaiting or claiming cleanup of unknown operator code.
        Promise.resolve(result).catch(() => undefined)
        invalidFactories.add(id)
        assert(false, 'ACCOUNT_PROTOCOL_FACTORY_INVALID', 'Protocol construction must be synchronous; asynchronous work belongs in start(signal).')
      }
      if (!result || typeof result.start !== 'function' || typeof result.stop !== 'function' || typeof result.close !== 'function') {
        invalidFactories.add(id)
        assert(false, 'ACCOUNT_PROTOCOL_FACTORY_INVALID', 'A protocol must synchronously create a complete isolated runtime.')
      }
      const instance: Instance = { runtime: result, state: 'configured', reason: null, operation: 0 }
      instances.set(id, instance)
      if (closed) { await closeRuntime(instance); active() }
      return result
    })()
    creating.set(id, operation)
    try { return await operation } finally { creating.delete(id) }
  }
  async function inventory() {
    const files: { name: string; ino: string; revision: number }[] = []
    for (const name of DATABASES) {
      const file = join(options.directory, name)
      let reader: ReturnType<typeof openReadonlySqliteStore>
      try { reader = openReadonlySqliteStore(file) }
      catch (error) { if (errorCode(error) === 'STORE_NOT_FOUND') continue; throw error }
      try {
        assert(!reader.read(ACCOUNT_STORE_NAMESPACE, ACCOUNT_STORE_KEY), 'ACCOUNT_LEGACY_ALREADY_BOUND', 'This legacy database already belongs to an account.')
        const stat = await lstat(file)
        files.push({ name, ino: `${stat.dev}:${stat.ino}`, revision: reader.revision() })
      } finally { reader.close() }
    }
    return { files, fingerprint: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
  }
  return Object.freeze({ read: snapshotView, runtime,
    async accountDirectory(id: string) { const entry = await account(id); await verifyDirectory(entry); return directory(entry) },
    async create(input: { readonly revision: string; readonly label: string; readonly accountScope: AccountScope }, signal: AbortSignal) {
      active(); signal.throwIfAborted()
      const scope = normalizeAccountScope(input.accountScope)
      const protocol = protocols.get(scope.protocolId)
      assert(protocol && (protocol.validateAccountId === undefined || protocol.validateAccountId(scope.accountId) === true)
        && typeof input.label === 'string' && !!input.label.trim() && input.label.length <= 80 && !/[\x00-\x1f\x7f]/.test(input.label), 'ACCOUNT_CONFIGURATION_INVALID', 'A registered protocol and account label are required.')
      const id = nativeAccountId(scope)
      await ensurePrivateDirectory(options.directory)
      await updateDocument(options.directory, filename, input.revision, EMPTY, registry, async current => {
        assert(current.accounts.length < 32 && !current.accounts.some(entry => entry.id === id), 'ACCOUNT_EXISTS', 'The account is already configured or capacity is exhausted.')
        signal.throwIfAborted()
        const entry: NativeAccountConfiguration = { id, label: input.label, accountScope: scope, source: 'isolated-account', adoption: 'ready' }
        await ensurePrivateDirectory(join(options.directory, 'accounts'))
        await ensurePrivateDirectory(directory(entry))
        const prior = await readDocument(identityFile(directory(entry)), null, identity)
        if (prior.value) assertAccountScope(scope, prior.value.accountScope)
        else await writeDocumentLocked(directory(entry), identityFile(directory(entry)), prior.revision, null, identity, { schema: 1, accountScope: scope, legacyAdopted: false })
        signal.throwIfAborted()
        return { schema: 1 as const, accounts: [...current.accounts, entry] }
      })
      return snapshotView()
    },
    async start(id: string, signal: AbortSignal, revisions?: Readonly<Record<string, string>>) {
      const target = await runtime(id); const entry = instances.get(id)!
      if (entry.start) return entry.start
      assert(entry.state !== 'unknown', 'ACCOUNT_RUNTIME_RECONCILIATION_REQUIRED', 'Unknown runtime work must be reconciled through its own domain controls.')
      if (entry.state === 'running') return
      const operation = ++entry.operation
      entry.state = 'starting'
      entry.start = withDeadline({ signal, timeoutMs, code: 'ACCOUNT_START_UNKNOWN', run: current => target.start(current, revisions) }).then(() => { if (entry.operation === operation) { entry.state = 'running'; entry.reason = null } }, error => {
        if (entry.operation === operation) { entry.state = 'unknown'; entry.reason = errorCode(error, 'ACCOUNT_START_UNKNOWN') }; throw error
      }).finally(() => { entry.start = undefined })
      return entry.start
    },
    async stop(id: string, signal: AbortSignal) {
      const target = await runtime(id); const entry = instances.get(id)!
      if (entry.stop) return entry.stop
      const operation = ++entry.operation
      entry.state = 'stopping'
      entry.stop = withDeadline({ signal, timeoutMs, code: 'ACCOUNT_STOP_UNKNOWN', run: current => target.stop(current) }).then(() => { if (entry.operation === operation) { entry.state = 'stopped'; entry.reason = null } }, error => {
        if (entry.operation === operation) { entry.state = 'unknown'; entry.reason = errorCode(error, 'ACCOUNT_STOP_UNKNOWN') }; throw error
      }).finally(() => { entry.stop = undefined })
      return entry.stop
    },
    async previewLegacyAdoption(scopeInput: AccountScope): Promise<NativeLegacyAdoptionPreview> {
      active(); const scope = normalizeAccountScope(scopeInput)
      assert(options.legacy?.isStopped(), 'ACCOUNT_LEGACY_REQUIRES_STOPPED', 'Legacy adoption requires the original runtime to be stopped.')
      const document = await read()
      assert(!document.value.accounts.some(entry => entry.source === 'legacy-adopted' || entry.id === nativeAccountId(scope)), 'ACCOUNT_EXISTS', 'The source or target already has an account binding.')
      const source = await inventory()
      return snapshot({ schema: 1, revision: document.revision, accountScope: scope, sourceFingerprint: source.fingerprint,
        databases: source.files.filter(file => DATABASES.some(name => file.name === name)).map(file => file.name) })
    },
    async adoptLegacy(input: { readonly preview: NativeLegacyAdoptionPreview; readonly label: string }, signal: AbortSignal) {
      active(); signal.throwIfAborted()
      const scope = normalizeAccountScope(input.preview.accountScope)
      assert(options.legacy?.isStopped() && protocols.has(scope.protocolId), 'ACCOUNT_LEGACY_REQUIRES_STOPPED', 'Adoption requires a registered protocol and a stopped original runtime.')
      assert(typeof input.label === 'string' && input.label.trim() && input.label.length <= 80 && !/[\x00-\x1f\x7f]/.test(input.label), 'ACCOUNT_CONFIGURATION_INVALID', 'A bounded account label is required.')
      const proof = await withDeadline({ signal, timeoutMs, code: 'ACCOUNT_IDENTITY_UNAVAILABLE', run: current => options.legacy!.verifyIdentity(scope, current) })
      assert(proof.verified && typeof proof.evidence === 'string' && proof.evidence.length > 0 && proof.evidence.length <= 256, 'ACCOUNT_IDENTITY_UNVERIFIED', 'Actual transport identity evidence is required.')
      assertAccountScope(scope, proof.accountScope)
      await withDirectoryWriteLock(options.directory, async () => {
        const current = await read()
        assert(current.revision === input.preview.revision && !current.value.accounts.some(entry => entry.source === 'legacy-adopted' || entry.id === nativeAccountId(scope)), 'ACCOUNT_ADOPTION_CONFLICT', 'The adoption target changed.')
        assert(options.legacy!.isStopped(), 'ACCOUNT_LEGACY_REQUIRES_STOPPED', 'The original runtime became active.')
        const source = await inventory()
        assert(source.fingerprint === input.preview.sourceFingerprint && JSON.stringify(source.files.filter(file => DATABASES.some(name => file.name === name)).map(file => file.name)) === JSON.stringify(input.preview.databases), 'ACCOUNT_ADOPTION_CONFLICT', 'The legacy source changed since preview.')
        await options.legacy!.close?.()
        signal.throwIfAborted()
        assert(options.legacy!.isStopped() && (await inventory()).fingerprint === source.fingerprint, 'ACCOUNT_ADOPTION_CONFLICT', 'The legacy source changed while closing its old runtime.')
        const entry: NativeAccountConfiguration = { id: nativeAccountId(scope), label: input.label, accountScope: scope, source: 'legacy-adopted', adoption: 'unknown' }
        const claim = await writeDocumentLocked(options.directory, filename, current.revision, EMPTY, registry, { schema: 1, accounts: [...current.value.accounts, entry] })
        // The unknown journal precedes every identity mutation. An interruption never starts or replays the source.
        signal.throwIfAborted()
        const priorEvidence = await readDocument(adoptionFilename, null, adoptionEvidence)
        assert(!priorEvidence.exists, 'ACCOUNT_LEGACY_ALREADY_BOUND', 'An earlier adoption inventory already exists.')
        await writeDocumentLocked(options.directory, adoptionFilename, priorEvidence.revision, null, adoptionEvidence,
          { schema: 1, id: entry.id, accountScope: scope, databases: input.preview.databases })
        for (const name of input.preview.databases) {
          assert(DATABASES.some(value => value === name), 'ACCOUNT_ADOPTION_CONFLICT', 'Only known host databases may be adopted.')
          const store = createSqliteStore({ filename: join(options.directory, name), requireExisting: true })
          try { store.write(ACCOUNT_STORE_NAMESPACE, ACCOUNT_STORE_KEY, { schema: 1, accountScope: { ...scope }, legacyAdopted: true, evidence: proof.evidence }, { expectedRevision: null }) }
          finally { store.close() }
        }
        const prior = await readDocument(identityFile(options.directory), null, identity)
        assert(!prior.exists, 'ACCOUNT_LEGACY_ALREADY_BOUND', 'The legacy directory already has an identity.')
        await writeDocumentLocked(options.directory, identityFile(options.directory), prior.revision, null, identity, { schema: 1, accountScope: scope, legacyAdopted: true })
        signal.throwIfAborted()
        await writeDocumentLocked(options.directory, filename, claim.revision, EMPTY, registry,
          { schema: 1, accounts: claim.value.accounts.map(item => item.id === entry.id ? { ...item, adoption: 'ready' as const } : item) })
      })
      return snapshotView()
    },
    async reconcileLegacyAdoption(id: string, revision: string, signal: AbortSignal) {
      active(); signal.throwIfAborted()
      const entry = await account(id)
      assert(entry.source === 'legacy-adopted' && entry.adoption === 'unknown' && options.legacy?.isStopped(), 'ACCOUNT_ADOPTION_RECONCILIATION_REQUIRED', 'Only a stopped unresolved adoption may be checked.')
      await verifyDirectory(entry)
      const evidence = await readDocument(adoptionFilename, null, adoptionEvidence)
      assert(evidence.exists && evidence.value?.id === id, 'ACCOUNT_ADOPTION_EVIDENCE_INVALID', 'The original adoption inventory cannot be reconstructed from missing files.')
      assertAccountScope(entry.accountScope, evidence.value.accountScope)
      for (const name of evidence.value.databases) {
        const reader = openReadonlySqliteStore(join(options.directory, name))
        try { assertAccountStore(reader, entry.accountScope) } finally { reader.close() }
      }
      await updateDocument(options.directory, filename, revision, EMPTY, registry, current => {
        signal.throwIfAborted()
        assert(options.legacy!.isStopped(), 'ACCOUNT_LEGACY_REQUIRES_STOPPED', 'The original runtime became active.')
        return { schema: 1 as const, accounts: current.accounts.map(item => item.id === id && item.adoption === 'unknown' ? { ...item, adoption: 'ready' as const } : item) }
      })
      return snapshotView()
    },
    close(): Promise<void> {
      if (closeTask) return closeTask
      closed = true
      closeTask = (async () => {
        await Promise.allSettled([...creating.values()])
        const failures = await Promise.allSettled([...instances.values()].map(closeRuntime))
        assert(failures.every(result => result.status === 'fulfilled'), 'ACCOUNT_CLOSE_UNKNOWN', 'An account runtime did not close cleanly.')
      })()
      return closeTask
    }
  })
}
export type NativeAccounts = ReturnType<typeof createNativeAccounts>
