import { FrameworkError, assert, errorCode, identifier, snapshot } from '../core/values.ts'
import type { DurableStore } from '../contracts/ports.ts'
import type { NativePackageManifest, NativePackagePhase, NativePackageResourceKind, NativePackageSnapshot,
  NativePackageState } from '../contracts/native-packages.ts'
import type { PackageConfigurationSnapshot, PackageConfigurationMetadata } from '../contracts/package-configuration.ts'
import { createNativePackageState, type NativePackageState as OwnedPackageState } from './native-package-state.ts'
import { createNativePackageLifecycleState } from './native-package-lifecycle-state.ts'
import type { NativePackageContent } from './native-package-content.ts'
import { withDeadline } from './deadlines.ts'
import { validatePackageConfigurationContribution, type PackageConfigurationContribution,
  type PackageConfigurationRegistry } from './package-configuration.ts'

export interface NativePackageContext {
  readonly owner: string
  readonly signal: AbortSignal
  readonly state: OwnedPackageState | undefined
  readonly configuration: {
    read(id: string): Promise<PackageConfigurationSnapshot>
    inspect(id: string): Promise<PackageConfigurationMetadata>
    migrate(id: string, expectedRevision: string): Promise<PackageConfigurationSnapshot>
  }
  namespace(name: string): string
  store(store: DurableStore): DurableStore
  service(id: string, version: number): unknown
  publish(id: string, version: number, value: unknown): void
  contribute(kind: NativePackageManifest['contributions'][number]['kind'], id: string, value: unknown): void
  own(kind: NativePackageResourceKind, id: string, dispose: (signal: AbortSignal) => void | Promise<void>): void
}

export interface NativePackageDefinition {
  readonly content?: NativePackageContent
  readonly manifest: NativePackageManifest
  readonly configurations?: readonly PackageConfigurationContribution[]
  readonly configurationIds?: readonly string[]
  readonly prepare?: (context: NativePackageContext) => void | Promise<void>
  readonly migrate?: (context: NativePackageContext) => void | Promise<void>
  readonly install?: (context: NativePackageContext) => void | Promise<void>
  readonly recover?: (context: NativePackageContext) => void | Promise<void>
  readonly start?: (context: NativePackageContext) => void | Promise<void>
  readonly drain?: (context: NativePackageContext) => void | Promise<void>
  readonly dispose?: (context: NativePackageContext) => void | Promise<void>
}

interface Resource {
  readonly id: string
  readonly kind: NativePackageResourceKind
  readonly dispose: (signal: AbortSignal) => void | Promise<void>
  state: 'active' | 'disposed' | 'unknown'
}
interface Entry {
  readonly definition: NativePackageDefinition
  readonly lifetime: AbortController
  readonly resources: Resource[]
  state: NativePackageState
  phase: NativePackagePhase | null
  reason: string | null
  context?: NativePackageContext
  ownedState?: OwnedPackageState
  lifecycle?: ReturnType<typeof createNativePackageLifecycleState>
}

function failure(code: string): never { throw new FrameworkError(code, 'The package operation could not be completed.') }
function version(input: unknown): input is number { return Number.isSafeInteger(input) && Number(input) >= 1 && Number(input) <= 1_000 }
function key(kind: string, id: string): string { return `${kind}:${id}` }

/** Preflight all declarations before running package code. Array order resolves independent packages. */
export function createNativePackages(options: {
  readonly packages: readonly NativePackageDefinition[]
  readonly configurationRegistry: PackageConfigurationRegistry
  readonly stateStore?: DurableStore
  readonly bootstrapContent?: NativePackageContent & { readonly packageIds: readonly string[] }
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}) {
  const definitions: readonly NativePackageDefinition[] = options.packages
  const timeoutMs = options.timeoutMs ?? 10_000
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300_000, 'INVALID_TIMEOUT', 'A finite package timeout is required.')
  assert(Array.isArray(options.packages) && options.packages.length <= 128, 'NATIVE_PACKAGE_MANIFEST_INVALID', 'Package declarations are bounded.')
  const entries = new Map<string, Entry>()
  const serviceOwners = new Map<string, { owner: string; version: number }>()
  const contributionOwners = new Map<string, string>()
  const configurationIds = new Set<string>()
  for (const definition of definitions) {
    const manifest = snapshot(definition.manifest)
    assert(manifest.schema === 1 && identifier(manifest.id) && typeof manifest.version === 'string'
      && /^\d+\.\d+\.\d+$/.test(manifest.version)
      && (manifest.stateSchemaVersion === undefined || Number.isSafeInteger(manifest.stateSchemaVersion) && manifest.stateSchemaVersion >= 1 && manifest.stateSchemaVersion <= 1000)
      && Array.isArray(manifest.dependencies)
      && manifest.dependencies.length <= 128 && new Set(manifest.dependencies).size === manifest.dependencies.length
      && manifest.dependencies.every((id: unknown) => identifier(id) && id !== manifest.id)
      && Array.isArray(manifest.provides) && manifest.provides.length <= 128
      && Array.isArray(manifest.requires) && manifest.requires.length <= 128
      && Array.isArray(manifest.contributions) && manifest.contributions.length <= 128,
    'NATIVE_PACKAGE_MANIFEST_INVALID', 'The package manifest is invalid.')
    if (entries.has(manifest.id)) failure('NATIVE_PACKAGE_DUPLICATE')
    for (const phase of ['prepare', 'migrate', 'install', 'recover', 'start', 'drain', 'dispose'] as const)
      if (definition[phase] !== undefined && typeof definition[phase] !== 'function') failure('NATIVE_PACKAGE_MANIFEST_INVALID')
    const requires = new Set<string>()
    for (const service of manifest.requires) {
      if (!identifier(service.id) || !version(service.version) || requires.has(service.id)) failure('NATIVE_PACKAGE_MANIFEST_INVALID')
      requires.add(service.id)
    }
    for (const service of manifest.provides) {
      if (!identifier(service.id) || !version(service.version)) failure('NATIVE_PACKAGE_MANIFEST_INVALID')
      if (serviceOwners.has(service.id)) failure('NATIVE_PACKAGE_SERVICE_DUPLICATE')
      serviceOwners.set(service.id, { owner: manifest.id, version: service.version })
    }
    for (const item of manifest.contributions) {
      if (!['effect', 'input-provider', 'feature', 'event-validator'].includes(item.kind) || !identifier(item.id)) failure('NATIVE_PACKAGE_MANIFEST_INVALID')
      const capabilities = item.capabilities ?? []
      if (item.kind !== 'input-provider' && (item.capabilities !== undefined || item.order !== undefined)
        || !Array.isArray(capabilities) || capabilities.length > 32 || !capabilities.every(identifier)
        || new Set(capabilities).size !== capabilities.length || item.order !== undefined && !Number.isSafeInteger(item.order))
        failure('NATIVE_PACKAGE_MANIFEST_INVALID')
      const id = key(item.kind, item.id)
      if (contributionOwners.has(id)) failure('NATIVE_PACKAGE_CONTRIBUTION_DUPLICATE')
      contributionOwners.set(id, manifest.id)
    }
    const configurations = (definition.configurations ?? []).map(validatePackageConfigurationContribution)
    const declaredIds = definition.configurationIds ?? configurations.map(item => item.descriptor.id)
    assert(Array.isArray(declaredIds) && declaredIds.length <= 128 && declaredIds.every(identifier)
      && new Set(declaredIds).size === declaredIds.length, 'NATIVE_PACKAGE_CONFIGURATION_OWNER_INVALID', 'Owned configuration IDs must be bounded and distinct.')
    const existing = options.configurationRegistry.descriptors()
    for (const item of configurations) {
      if (item.descriptor.owner !== manifest.id || !declaredIds.includes(item.descriptor.id)) failure('NATIVE_PACKAGE_CONFIGURATION_OWNER_INVALID')
      if (existing.some(descriptor => descriptor.id === item.descriptor.id) && !options.configurationRegistry.matches(item)) failure('NATIVE_PACKAGE_CONFIGURATION_DECLARATION_MISMATCH')
    }
    for (const id of declaredIds) {
      if (configurationIds.has(id)) failure('PACKAGE_CONFIGURATION_DUPLICATE')
      configurationIds.add(id)
      const descriptor = existing.find(item => item.id === id) ?? configurations.find(item => item.descriptor.id === id)?.descriptor
      if (!descriptor || descriptor.owner !== manifest.id) failure('NATIVE_PACKAGE_CONFIGURATION_OWNER_INVALID')
    }
    const content = options.bootstrapContent?.packageIds.includes(manifest.id) ? options.bootstrapContent : definition.content
    const stateIdentity = content ? { packageVersion: manifest.version, stateSchemaVersion: manifest.stateSchemaVersion ?? 1,
      contentFingerprint: content.identity.fingerprint } : undefined
    if (options.stateStore) assert(content && stateIdentity, 'NATIVE_PACKAGE_CONTENT_IDENTITY_REQUIRED', 'Persistent packages require a verified content identity.')
    entries.set(manifest.id, { definition: Object.freeze({ ...definition, manifest, configurations, configurationIds: Object.freeze([...declaredIds]) }),
      lifetime: new AbortController(), resources: [], state: 'registered', phase: null, reason: null,
      ...(options.stateStore && content && stateIdentity ? {
        ownedState: createNativePackageState({ store: options.stateStore, owner: manifest.id, identity: stateIdentity,
          verifyIdentity: (_identity, signal) => content.verify(signal), timeoutMs }),
        lifecycle: createNativePackageLifecycleState({ store: options.stateStore, owner: manifest.id, identity: stateIdentity })
      } : {}) })
  }
  const order: Entry[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(id: string): void {
    const entry = entries.get(id)
    if (!entry) failure('NATIVE_PACKAGE_DEPENDENCY_MISSING')
    if (visiting.has(id)) failure('NATIVE_PACKAGE_DEPENDENCY_CYCLE')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of entry.definition.manifest.dependencies) visit(dependency)
    visiting.delete(id); visited.add(id); order.push(entry)
  }
  for (const id of entries.keys()) visit(id)
  function dependsOn(entry: Entry, target: string): boolean {
    return entry.definition.manifest.dependencies.some(id => id === target || dependsOn(entries.get(id)!, target))
  }
  for (const entry of order) for (const requirement of entry.definition.manifest.requires) {
    const owner = serviceOwners.get(requirement.id)
    if (!owner || owner.version !== requirement.version) failure('NATIVE_PACKAGE_SERVICE_VERSION_UNAVAILABLE')
    if (!dependsOn(entry, owner.owner)) failure('NATIVE_PACKAGE_SERVICE_DEPENDENCY_REQUIRED')
  }
  // Registration happens only after all dependency, version and duplicate checks succeed.
  const registered: { id: string; owner: string }[] = []
  try {
    for (const entry of order) for (const item of entry.definition.configurations ?? []) {
      if (options.configurationRegistry.descriptors().some(descriptor => descriptor.id === item.descriptor.id)) continue
      options.configurationRegistry.register(item)
      registered.push({ id: item.descriptor.id, owner: item.descriptor.owner })
    }
  } catch (error) {
    for (const item of registered) options.configurationRegistry.unregister(item.id, item.owner)
    throw error
  }
  const services = new Map<string, { owner: string; version: number; value: unknown }>()
  const contributions = new Map<string, { owner: string; kind: NativePackageManifest['contributions'][number]['kind']; id: string; value: unknown }>()
  let startTask: Promise<readonly NativePackageSnapshot[]> | undefined
  let stopTask: Promise<readonly NativePackageSnapshot[]> | undefined
  let stopping = false
  function describe(): readonly NativePackageSnapshot[] {
    return snapshot(order.map(entry => ({ schema: 1 as const, id: entry.definition.manifest.id,
      version: entry.definition.manifest.version, state: entry.state, phase: entry.phase, reason: entry.reason,
      resources: entry.resources.map(({ id, kind, state }) => ({ id, kind, state })) })))
  }
  function context(entry: Entry, phaseSignal?: AbortSignal, phaseName?: NativePackagePhase, migrationSignal?: AbortSignal): NativePackageContext {
    const manifest = entry.definition.manifest
    const signal = phaseSignal ? AbortSignal.any([entry.lifetime.signal, phaseSignal]) : entry.lifetime.signal
    function active(): void { signal.throwIfAborted(); if (stopping || !['starting', 'running'].includes(entry.state)) failure('NATIVE_PACKAGE_INACTIVE') }
    function namespace(name: string): string {
      if (!identifier(name) || name.includes('.')) failure('NATIVE_PACKAGE_NAMESPACE_INVALID')
      return `package.${manifest.id}.${name}`
    }
    const owned = entry.ownedState
    const stateSignal = (current: AbortSignal) => AbortSignal.any([signal, current])
    function migrating(): void {
      active()
      if (phaseName !== 'migrate' || entry.phase !== 'migrate' || entry.state !== 'starting') failure('NATIVE_PACKAGE_STATE_MIGRATION_DENIED')
    }
    const state: OwnedPackageState | undefined = owned ? Object.freeze({
      status() { active(); return owned.status() },
      read(key: string) { active(); return owned.read(key) },
      async initialize(current: AbortSignal) { active(); const result = await owned.initialize(stateSignal(current)); active(); return result },
      async compareAndSet(...args: Parameters<OwnedPackageState['compareAndSet']>) {
        active(); const [key, revision, value, current] = args
        const result = await owned.compareAndSet(key, revision, value, stateSignal(current)); active(); return result
      },
      async prepare(revision: number, current: AbortSignal) { migrating(); return owned.prepare(revision, stateSignal(current)) },
      async prepareLegacyAdoption(current: AbortSignal) { migrating(); return owned.prepareLegacyAdoption(stateSignal(current)) },
      async applyPage(...args: Parameters<OwnedPackageState['applyPage']>) {
        migrating(); const [revision, operationId, transform, current] = args
        return owned.applyPage(revision, operationId, transform, stateSignal(current))
      },
      async reconcile(revision: number, operationId: string, current: AbortSignal) { migrating(); return owned.reconcile(revision, operationId, stateSignal(current)) }
    }) : undefined
    return Object.freeze({ owner: manifest.id, signal, namespace, state,
      configuration: Object.freeze({
        async read(id: string) {
          active()
          if (!entry.definition.configurationIds?.includes(id)) failure('NATIVE_PACKAGE_CONFIGURATION_UNDECLARED')
          const result = await options.configurationRegistry.read(id)
          active()
          return result
        },
        async inspect(id: string) {
          active()
          if (!entry.definition.configurationIds?.includes(id)) failure('NATIVE_PACKAGE_CONFIGURATION_UNDECLARED')
          const result = await options.configurationRegistry.inspect(id)
          active()
          return result
        },
        async migrate(id: string, expectedRevision: string) {
          active()
          if (!entry.definition.configurationIds?.includes(id)) failure('NATIVE_PACKAGE_CONFIGURATION_UNDECLARED')
          if (phaseName !== 'migrate' || entry.phase !== 'migrate' || entry.state !== 'starting') failure('NATIVE_PACKAGE_CONFIGURATION_MIGRATION_DENIED')
          const result = await options.configurationRegistry.migrate(id, expectedRevision, migrationSignal ? AbortSignal.any([signal, migrationSignal]) : signal)
          active()
          return result
        }
      }),
      store(store: DurableStore): DurableStore {
        return Object.freeze({
          read(name, id) { active(); return store.read(namespace(name), id) },
          write(name, id, value, writeOptions) { active(); return store.write(namespace(name), id, value, writeOptions) },
          delete(name, id, expected) { active(); return store.delete(namespace(name), id, expected) },
          list(name, listOptions) { active(); return store.list(namespace(name), listOptions) },
          ...(store.compareAndSetBatch ? { compareAndSetBatch(mutations: readonly import('../contracts/ports.ts').DurableCasMutation[]) {
            active()
            const result = store.compareAndSetBatch!(mutations.map(mutation => ({ ...mutation, namespace: namespace(mutation.namespace) })))
            return snapshot(result.map(record => record ? { ...record, namespace: record.namespace.slice(`package.${manifest.id}.`.length) } : null))
          } } : {}),
          purgeExpired() { failure('NATIVE_PACKAGE_GLOBAL_STORAGE_OPERATION_FORBIDDEN') },
          close() { /* Shared store lifetime belongs to the host. */ }
        } satisfies DurableStore)
      },
      service(id, requestedVersion) {
        active()
        if (!manifest.requires.some(item => item.id === id && item.version === requestedVersion)) failure('NATIVE_PACKAGE_SERVICE_UNDECLARED')
        const service = services.get(id)
        if (!service || service.version !== requestedVersion || entries.get(service.owner)?.state !== 'running') failure('NATIVE_PACKAGE_SERVICE_UNAVAILABLE')
        return service.value
      },
      publish(id, publishedVersion, value) {
        active()
        if (!manifest.provides.some(item => item.id === id && item.version === publishedVersion)) failure('NATIVE_PACKAGE_SERVICE_UNDECLARED')
        if (services.has(id) || entry.resources.some(resource => resource.id === `service.${id}`)) failure('NATIVE_PACKAGE_SERVICE_DUPLICATE')
        services.set(id, { owner: manifest.id, version: publishedVersion, value })
        entry.resources.push({ id: `service.${id}`, kind: 'service', state: 'active', dispose() { services.delete(id) } })
      },
      contribute(kind, id, value) {
        active()
        const contributionId = key(kind, id)
        if (contributionOwners.get(contributionId) !== manifest.id) failure('NATIVE_PACKAGE_CONTRIBUTION_UNDECLARED')
        if (contributions.has(contributionId) || entry.resources.some(resource => resource.id === `contribution.${contributionId}`)) failure('NATIVE_PACKAGE_CONTRIBUTION_DUPLICATE')
        contributions.set(contributionId, { owner: manifest.id, kind, id, value })
        entry.resources.push({ id: `contribution.${contributionId}`, kind: 'contribution', state: 'active', dispose() { contributions.delete(contributionId) } })
      },
      own(kind, id, dispose) {
        active()
        if (!['task', 'timer', 'subscription', 'service', 'contribution', 'other'].includes(kind) || !identifier(id)
          || typeof dispose !== 'function' || entry.resources.length >= 256) failure('NATIVE_PACKAGE_RESOURCE_INVALID')
        if (entry.resources.some(resource => resource.id === id)) failure('NATIVE_PACKAGE_RESOURCE_DUPLICATE')
        entry.resources.push({ kind, id, dispose, state: 'active' })
      }
    } satisfies NativePackageContext)
  }
  async function phase(entry: Entry, name: NativePackagePhase, cleanup = false): Promise<void> {
    const callback = entry.definition[name]
    entry.phase = name
    if (!callback) return
    const migrationLifetime = new AbortController()
    try {
      await withDeadline({ signal: cleanup ? new AbortController().signal : entry.lifetime.signal, timeoutMs,
        code: 'NATIVE_PACKAGE_PHASE_TIMEOUT_UNKNOWN', run: signal => {
          const operation = () => callback(cleanup ? Object.freeze({ ...context(entry), signal }) : context(entry, signal, name, migrationLifetime.signal))
          return entry.lifecycle ? entry.lifecycle.run(name, signal, operation, cleanup) : operation()
        } })
    } finally { migrationLifetime.abort() }
  }
  async function release(entry: Entry): Promise<boolean> {
    let unknown = false
    entry.lifetime.abort(new FrameworkError('NATIVE_PACKAGE_STOPPED', 'The package has stopped.'))
    for (const resource of [...entry.resources].reverse()) {
      if (resource.state !== 'active') { unknown ||= resource.state === 'unknown'; continue }
      // Once invoked, an unresolved disposer is never replayed.
      resource.state = 'unknown'
      try {
        await withDeadline({ signal: new AbortController().signal, timeoutMs, code: 'NATIVE_PACKAGE_RESOURCE_TIMEOUT_UNKNOWN', run: signal => entry.lifecycle
          ? entry.lifecycle.run(`resource.${resource.id}`, signal, () => resource.dispose(signal), true) : resource.dispose(signal) })
        resource.state = 'disposed'
      } catch { unknown = true }
    }
    return unknown
  }
  async function start(): Promise<readonly NativePackageSnapshot[]> {
    if (startTask) return startTask
    if (stopping) return describe()
    startTask = (async () => {
      for (const entry of order) {
        if (stopping) break
        if (entry.definition.manifest.dependencies.some(id => entries.get(id)?.state !== 'running')) {
          entry.state = 'blocked'; entry.reason = 'native_package_dependency_unavailable'; continue
        }
        entry.state = 'starting'
        try {
          entry.lifecycle?.assertSettled()
          if (entry.ownedState) {
            const state = entry.ownedState.status()
            if (state.migration) failure('NATIVE_PACKAGE_STATE_RECONCILIATION_REQUIRED')
            if (state.revision === null) await entry.ownedState.initialize(entry.lifetime.signal)
            else if (!state.ready) {
              if (state.identity?.stateSchemaVersion === (entry.definition.manifest.stateSchemaVersion ?? 1)) {
                let migration = await entry.ownedState.prepare(state.revision, entry.lifetime.signal)
                while (migration.migration) migration = await entry.ownedState.applyPage(migration.revision!, migration.migration.operationId,
                  entries => entries.map(entry => ({ key: entry.key, value: entry.value })), entry.lifetime.signal)
              } else await entry.ownedState.prepare(state.revision, entry.lifetime.signal)
            }
          }
          for (const name of ['prepare', 'migrate', 'install', 'recover', 'start'] as const) {
            await phase(entry, name)
            if (name === 'migrate') {
              for (const id of entry.definition.configurationIds ?? []) await options.configurationRegistry.read(id)
              if (entry.ownedState && !entry.ownedState.status().ready) failure('PACKAGE_STATE_MIGRATION_REQUIRED')
            }
          }
          for (const service of entry.definition.manifest.provides) if (!services.has(service.id)) failure('NATIVE_PACKAGE_SERVICE_NOT_PUBLISHED')
          for (const item of entry.definition.manifest.contributions) if (!contributions.has(key(item.kind, item.id))) failure('NATIVE_PACKAGE_CONTRIBUTION_NOT_PUBLISHED')
          entry.lifetime.signal.throwIfAborted()
          entry.state = 'running'; entry.phase = null
        } catch (error) {
          entry.reason = errorCode(error, 'NATIVE_PACKAGE_START_FAILED')
          const unknown = entry.reason.endsWith('_UNKNOWN') || entry.reason.endsWith('_RECONCILIATION_REQUIRED')
          const cleanupUnknown = await release(entry)
          try { await phase(entry, 'dispose', true) } catch { entry.state = 'unknown' }
          entry.state = unknown || cleanupUnknown || entry.state === 'unknown' ? 'unknown' : 'failed'
        }
      }
      return describe()
    })()
    return startTask
  }
  function stop(): Promise<readonly NativePackageSnapshot[]> {
    if (stopTask) return stopTask
    stopping = true
    for (const entry of order) entry.lifetime.abort()
    stopTask = (async () => {
      await startTask
      for (const entry of [...order].reverse()) {
        if (['failed', 'unknown', 'blocked', 'stopped'].includes(entry.state)) continue
        if (entry.state === 'registered') { entry.state = 'stopped'; continue }
        const running = entry.state === 'running'
        entry.state = 'stopping'
        let unknown = false
        if (running) try { await phase(entry, 'drain', true) } catch { unknown = true }
        unknown = await release(entry) || unknown
        try { await phase(entry, 'dispose', true) } catch { unknown = true }
        entry.state = unknown ? 'unknown' : 'stopped'
        entry.reason = unknown ? 'native_package_cleanup_unknown' : null
      }
      return describe()
    })()
    return stopTask
  }
  options.signal?.addEventListener('abort', () => { void stop() }, { once: true })
  if (options.signal?.aborted) void stop()
  return Object.freeze({ start, stop, describe,
    lifecycleEvidence(owner: string) {
      const entry = entries.get(owner)
      if (!entry) failure('NATIVE_PACKAGE_NOT_FOUND')
      return entry.lifecycle?.evidence() ?? null
    },
    async reconcileLifecycle(owner: string, revision: number, verify: Parameters<ReturnType<typeof createNativePackageLifecycleState>['reconcile']>[1], signal: AbortSignal) {
      const entry = entries.get(owner)
      if (!entry?.lifecycle) failure('NATIVE_PACKAGE_NOT_FOUND')
      await withDeadline({ signal, timeoutMs, code: 'NATIVE_PACKAGE_LIFECYCLE_RECONCILIATION_TIMEOUT_UNKNOWN',
        run: current => entry.lifecycle!.reconcile(revision, verify, current) })
      return entry.lifecycle.evidence()
    },
    service(id: string, requestedVersion: number): unknown {
      const service = services.get(id)
      if (stopping || !service || service.version !== requestedVersion || entries.get(service.owner)?.state !== 'running') failure('NATIVE_PACKAGE_SERVICE_UNAVAILABLE')
      return service.value
    },
    contributions() { return Object.freeze([...contributions.values()].filter(item => entries.get(item.owner)?.state === 'running').map(item => Object.freeze({ ...item }))) }
  })
}

export type NativePackages = ReturnType<typeof createNativePackages>
