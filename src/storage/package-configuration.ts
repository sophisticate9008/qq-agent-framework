import { isAbsolute, join, resolve } from 'node:path'
import { FrameworkError, identifier, isRecord, snapshot } from '../core/values.ts'
import { isPackageConfigurationValue, type PackageConfigurationStore, type StoredPackageConfiguration } from '../contracts/package-configuration.ts'
import { ensurePrivateDirectory, readDocument, updateDocument, PrivateJsonStorageError } from './private-json.ts'

function stored(input: unknown): StoredPackageConfiguration {
  if (!isRecord(input) || Object.keys(input).length !== 4 || input.schema !== 1 || !identifier(input.id)
    || typeof input.schemaVersion !== 'number' || !Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1
    || input.schemaVersion > 1_000 || !isPackageConfigurationValue(input.configuration)) {
    throw new TypeError('Invalid package configuration document')
  }
  return snapshot({ schema: 1, id: input.id, schemaVersion: input.schemaVersion, configuration: input.configuration })
}

function failure(error: unknown): never {
  if (error instanceof PrivateJsonStorageError) {
    const code = error.code === 'chat_revision_conflict' ? 'PACKAGE_CONFIGURATION_CONFLICT'
      : error.code === 'chat_storage_busy' ? 'PACKAGE_CONFIGURATION_BUSY'
        : error.code === 'chat_write_unknown' ? 'PACKAGE_CONFIGURATION_WRITE_UNKNOWN' : 'PACKAGE_CONFIGURATION_STORAGE_UNAVAILABLE'
    throw new FrameworkError(code, 'The package configuration file could not be verified or committed.')
  }
  throw error
}

export function createPackageConfigurationFileStore(directory: string): PackageConfigurationStore {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute package configuration directory is required')
  const root = resolve(directory)
  const filename = (id: string) => {
    if (!identifier(id)) throw new FrameworkError('PACKAGE_CONFIGURATION_INVALID', 'A package configuration identity is required.')
    return join(root, `package-${id}.configuration.json`)
  }
  return Object.freeze({
    async read(id: string, fallback: StoredPackageConfiguration) {
      try {
        const document = await readDocument(filename(id), stored(fallback), stored)
        if (document.value.id !== id) throw new FrameworkError('PACKAGE_CONFIGURATION_STORED_INVALID', 'The package identity changed.')
        return document
      } catch (error) { return failure(error) }
    },
    async compareAndSet(id: string, expectedRevision: string, fallback: StoredPackageConfiguration,
      next: StoredPackageConfiguration, signal: AbortSignal) {
      try {
        signal.throwIfAborted()
        await ensurePrivateDirectory(root)
        const captured = stored(next)
        if (captured.id !== id) throw new FrameworkError('PACKAGE_CONFIGURATION_INVALID', 'The package identity must remain unchanged.')
        return await updateDocument(root, filename(id), expectedRevision, stored(fallback), stored,
          () => captured, () => signal.throwIfAborted())
      } catch (error) { return failure(error) }
    }
  })
}
