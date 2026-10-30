import { FrameworkError, identifier, isRecord, snapshot } from '../core/values.ts'
import { digest } from './data.ts'
import { NATIVE_REVISION_PATTERN } from '../contracts/native-revisions.ts'
import { isPackageConfigurationValue, type PackageConfigurationDescriptor, type PackageConfigurationSnapshot,
  type PackageConfigurationMetadata, type PackageConfigurationStore, type PackageConfigurationValue, type StoredPackageConfiguration } from '../contracts/package-configuration.ts'

export interface PackageConfigurationContribution<Value extends PackageConfigurationValue = PackageConfigurationValue> {
  readonly descriptor: PackageConfigurationDescriptor
  readonly defaults: Value
  readonly validate: (input: unknown) => Value
  readonly migrate?: (input: PackageConfigurationValue, fromVersion: number) => Value | Promise<Value>
}

function fail(code: string): never {
  throw new FrameworkError(code, 'The package configuration operation could not be completed.')
}

export function validatePackageConfigurationContribution(input: PackageConfigurationContribution): Readonly<PackageConfigurationContribution> {
  const descriptor = input.descriptor
  if (!identifier(descriptor.id) || !identifier(descriptor.owner) || typeof descriptor.title !== 'string'
    || descriptor.title.length === 0 || descriptor.title.length > 128 || typeof descriptor.description !== 'string'
    || descriptor.description.length > 2_000 || !Number.isSafeInteger(descriptor.schemaVersion) || descriptor.schemaVersion < 1
    || descriptor.schemaVersion > 1_000 || !['live', 'restart'].includes(descriptor.application)
    || !Array.isArray(descriptor.fields) || descriptor.fields.length > 128 || typeof input.validate !== 'function'
    || input.migrate !== undefined && typeof input.migrate !== 'function') fail('PACKAGE_CONFIGURATION_CONTRIBUTION_INVALID')
  const ids = new Set<string>()
  for (const field of descriptor.fields) {
    if (!identifier(field.id) || ids.has(field.id) || !Array.isArray(field.path) || field.path.length === 0 || field.path.length > 8
      || !field.path.every((segment: unknown) => typeof segment === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(segment)
        && !['__proto__', 'constructor', 'prototype'].includes(segment))
      || typeof field.label !== 'string' || field.label.length === 0 || field.label.length > 128
      || typeof field.description !== 'string' || field.description.length > 2_000
      || !['boolean', 'integer', 'string-list', 'choice'].includes(field.kind)) fail('PACKAGE_CONFIGURATION_CONTRIBUTION_INVALID')
    if (field.kind === 'integer' && (!Number.isSafeInteger(field.minimum) || !Number.isSafeInteger(field.maximum)
      || field.minimum > field.maximum) || field.kind === 'string-list' && (!Number.isSafeInteger(field.maximumEntries)
      || field.maximumEntries < 1 || field.maximumEntries > 1_024 || !Number.isSafeInteger(field.maximumLength)
      || field.maximumLength < 1 || field.maximumLength > 4_096)) fail('PACKAGE_CONFIGURATION_CONTRIBUTION_INVALID')
    if (field.kind === 'choice' && (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 32
      || !field.options.every((option: unknown) => isRecord(option) && typeof option.value === 'string' && option.value.length > 0 && option.value.length <= 128
        && typeof option.label === 'string' && option.label.length > 0 && option.label.length <= 128)
      || new Set(field.options.map((option: unknown) => isRecord(option) ? option.value : null)).size !== field.options.length)) fail('PACKAGE_CONFIGURATION_CONTRIBUTION_INVALID')
    ids.add(field.id)
  }
  const defaults = input.validate(snapshot(input.defaults))
  if (!isPackageConfigurationValue(defaults)) fail('PACKAGE_CONFIGURATION_CONTRIBUTION_INVALID')
  return Object.freeze({ descriptor: snapshot(descriptor), defaults: snapshot(defaults), validate: input.validate,
    ...(input.migrate === undefined ? {} : { migrate: input.migrate }) })
}

/** Configuration contributions share persistence and CAS; they cannot change the access policy. */
export function createPackageConfigurationRegistry(options: {
  readonly store: PackageConfigurationStore
  readonly contributions?: readonly PackageConfigurationContribution[]
}) {
  const entries = new Map<string, Readonly<PackageConfigurationContribution>>()
  function register(input: PackageConfigurationContribution): void {
    const entry = validatePackageConfigurationContribution(input)
    if (entries.has(entry.descriptor.id) || entries.size >= 128) fail('PACKAGE_CONFIGURATION_DUPLICATE')
    entries.set(entry.descriptor.id, entry)
  }
  for (const entry of options.contributions ?? []) register(entry)
  function requireEntry(id: string) {
    if (!identifier(id)) fail('PACKAGE_CONFIGURATION_INVALID')
    const entry = entries.get(id)
    if (!entry) fail('PACKAGE_CONFIGURATION_NOT_FOUND')
    return entry
  }
  function fallback(entry: Readonly<PackageConfigurationContribution>): StoredPackageConfiguration {
    return { schema: 1, id: entry.descriptor.id, schemaVersion: entry.descriptor.schemaVersion, configuration: entry.defaults }
  }
  function project(entry: Readonly<PackageConfigurationContribution>, document: Awaited<ReturnType<PackageConfigurationStore['read']>>): PackageConfigurationSnapshot {
    if (!NATIVE_REVISION_PATTERN.test(document.revision) || document.value.id !== entry.descriptor.id
      || document.value.schemaVersion !== entry.descriptor.schemaVersion) fail('PACKAGE_CONFIGURATION_MIGRATION_REQUIRED')
    let configuration: PackageConfigurationValue
    try { configuration = entry.validate(document.value.configuration) }
    catch { fail('PACKAGE_CONFIGURATION_STORED_INVALID') }
    if (!isPackageConfigurationValue(configuration)) fail('PACKAGE_CONFIGURATION_STORED_INVALID')
    return snapshot({ schema: 1, id: entry.descriptor.id, revision: document.revision,
      schemaVersion: entry.descriptor.schemaVersion, source: document.exists ? 'stored' : 'default',
      application: entry.descriptor.application, configuration })
  }
  return Object.freeze({
    register,
    unregister(id: string, owner: string) {
      if (entries.get(id)?.descriptor.owner === owner) entries.delete(id)
    },
    unregisterOwner(owner: string) {
      for (const [id, entry] of entries) if (entry.descriptor.owner === owner) entries.delete(id)
    },
    matches(input: PackageConfigurationContribution) {
      const entry = entries.get(input.descriptor.id)
      return !!entry && entry.validate === input.validate && entry.migrate === input.migrate
        && digest(entry.descriptor) === digest(input.descriptor) && digest(entry.defaults) === digest(input.defaults)
    },
    async inspect(id: string): Promise<PackageConfigurationMetadata> {
      const entry = requireEntry(id)
      const document = await options.store.read(id, fallback(entry))
      if (!NATIVE_REVISION_PATTERN.test(document.revision) || document.value.id !== id) fail('PACKAGE_CONFIGURATION_STORED_INVALID')
      return snapshot({ schema: 1, id, revision: document.revision, schemaVersion: document.value.schemaVersion,
        targetSchemaVersion: entry.descriptor.schemaVersion, source: document.exists ? 'stored' : 'default', application: entry.descriptor.application })
    },
    descriptors() { return Object.freeze([...entries.values()].map(entry => entry.descriptor)) },
    async read(id: string): Promise<PackageConfigurationSnapshot> {
      const entry = requireEntry(id)
      return project(entry, await options.store.read(id, fallback(entry)))
    },
    async compareAndSet(id: string, expectedRevision: string, input: unknown, signal: AbortSignal): Promise<PackageConfigurationSnapshot> {
      const entry = requireEntry(id)
      if (!NATIVE_REVISION_PATTERN.test(expectedRevision)) fail('PACKAGE_CONFIGURATION_INVALID')
      signal.throwIfAborted()
      let configuration: PackageConfigurationValue
      try { configuration = entry.validate(input) }
      catch { fail('PACKAGE_CONFIGURATION_INVALID') }
      if (!isPackageConfigurationValue(configuration)) fail('PACKAGE_CONFIGURATION_INVALID')
      const defaults = fallback(entry)
      const current = await options.store.read(id, defaults)
      if (current.value.schemaVersion !== entry.descriptor.schemaVersion) fail('PACKAGE_CONFIGURATION_MIGRATION_REQUIRED')
      const document = await options.store.compareAndSet(id, expectedRevision, defaults,
        { ...defaults, configuration: snapshot(configuration) }, signal)
      return project(entry, document)
    },
    async migrate(id: string, expectedRevision: string, signal: AbortSignal): Promise<PackageConfigurationSnapshot> {
      const entry = requireEntry(id)
      if (!NATIVE_REVISION_PATTERN.test(expectedRevision)) fail('PACKAGE_CONFIGURATION_INVALID')
      signal.throwIfAborted()
      const defaults = fallback(entry)
      const current = await options.store.read(id, defaults)
      if (current.revision !== expectedRevision) fail('PACKAGE_CONFIGURATION_CONFLICT')
      if (current.value.schemaVersion === entry.descriptor.schemaVersion) return project(entry, current)
      if (current.value.schemaVersion > entry.descriptor.schemaVersion || !entry.migrate) fail('PACKAGE_CONFIGURATION_MIGRATION_UNAVAILABLE')
      const migrated = entry.validate(await entry.migrate(current.value.configuration, current.value.schemaVersion))
      if (!isPackageConfigurationValue(migrated)) fail('PACKAGE_CONFIGURATION_STORED_INVALID')
      signal.throwIfAborted()
      return project(entry, await options.store.compareAndSet(id, expectedRevision, defaults, { ...defaults, configuration: snapshot(migrated) }, signal))
    }
  })
}

export type PackageConfigurationRegistry = ReturnType<typeof createPackageConfigurationRegistry>
