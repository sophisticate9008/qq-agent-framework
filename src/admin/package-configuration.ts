import { FrameworkError, identifier, isRecord } from '../core/values.ts'
import { PACKAGE_CONFIGURATION_PATH } from '../contracts/package-configuration.ts'
import { createDefaultPackageConfigurationRegistry } from '../host/chat-input-configuration.ts'
import type { PackageConfigurationRegistry } from '../host/package-configuration.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

function requestError(statusCode: number, code: string): never { throw new AdminRequestError(statusCode, code) }

function exact(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

async function operation<Result>(run: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
  try { return await run() }
  catch (error) {
    if (error instanceof AdminRequestError) throw error
    if (signal?.aborted) requestError(499, 'request_aborted')
    if (error instanceof FrameworkError) {
      const suffix = error.code.replace(/^PACKAGE_CONFIGURATION_/, '').toLowerCase()
      if (suffix === 'not_found') requestError(404, 'package_configuration_not_found')
      if (['conflict', 'busy', 'migration_required', 'migration_unavailable'].includes(suffix)) requestError(409, `package_configuration_${suffix}`)
      if (suffix === 'invalid') requestError(400, 'invalid_package_configuration')
      if (suffix === 'write_unknown') requestError(500, 'package_configuration_write_unknown')
    }
    requestError(503, 'package_configuration_unavailable')
  }
}

export function createPackageConfigurationRoutes(options: {
  readonly directory: string
  readonly registry?: PackageConfigurationRegistry
}): readonly AdminRoute[] {
  const registry = options.registry ?? createDefaultPackageConfigurationRegistry(options.directory)
  return Object.freeze([
    { method: 'GET', pathname: PACKAGE_CONFIGURATION_PATH, maxResponseBytes: 1_048_576,
      async handle({ query }: Parameters<AdminRoute['handle']>[0]) {
        if ([...query.keys()].some(key => key !== 'id') || query.getAll('id').length > 1) requestError(400, 'invalid_query')
        const id = query.get('id')
        if (id !== null) {
          if (!identifier(id)) requestError(400, 'invalid_query')
          return operation(() => registry.read(id))
        }
        const packages = await Promise.all(registry.descriptors().map(async descriptor => {
          try {
            const current = await registry.read(descriptor.id)
            return { descriptor, state: 'ready', revision: current.revision, source: current.source, errorCode: null }
          } catch (error) {
            const metadata = await registry.inspect(descriptor.id).catch(() => null)
            return { descriptor, state: 'unavailable', revision: metadata?.revision ?? null, source: metadata?.source ?? null,
              errorCode: error instanceof FrameworkError ? error.code : 'PACKAGE_CONFIGURATION_UNAVAILABLE' }
          }
        }))
        return { schema: 1, packages }
      } },
    { method: 'POST', pathname: PACKAGE_CONFIGURATION_PATH, maxRequestBytes: 64 * 1024,
      async handle({ query, body, signal }: Parameters<AdminRoute['handle']>[0]) {
        if (query.size !== 0 || !isRecord(body) || !exact(body, ['id', 'revision', 'configuration'])
          || !identifier(body.id) || typeof body.revision !== 'string') requestError(400, 'invalid_package_configuration')
        const { id, revision, configuration } = body
        return operation(() => registry.compareAndSet(id, revision, configuration, signal), signal)
      } },
    { method: 'POST', pathname: `${PACKAGE_CONFIGURATION_PATH}/migrate`, maxRequestBytes: 4_096,
      async handle({ query, body, signal }: Parameters<AdminRoute['handle']>[0]) {
        if (query.size !== 0 || !isRecord(body) || !exact(body, ['id', 'revision', 'confirm']) || body.confirm !== true
          || !identifier(body.id) || typeof body.revision !== 'string') requestError(400, 'invalid_package_configuration')
        const { id, revision } = body
        return operation(() => registry.migrate(id, revision, signal), signal)
      } }
  ] as const)
}
