import { defineServiceContract, validateServiceContractImplementation, type ServiceContract } from '../contracts/service-contract.ts'
import { FrameworkError, assert } from '../core/values.ts'
import { digest } from './data.ts'
import { createReloadableExtension, type ReloadableExtension } from './reloadable-extensions.ts'

/** Only methods declared to return a promise can be placed on the automatic lease facade. */
export type AsyncServiceMethod<Value extends object> = {
  [Method in Extract<keyof Value, string>]-?: Value[Method] extends (...args: infer _Arguments) => PromiseLike<unknown> ? Method : never
}[Extract<keyof Value, string>]

export type ReloadableAsyncService<Value extends object, Method extends AsyncServiceMethod<Value> = AsyncServiceMethod<Value>> = {
  readonly [Name in Method]: Value[Name] extends (...args: infer Arguments) => PromiseLike<infer Result>
    ? (...args: Arguments) => Promise<Awaited<Result>> : never
}

/** The implementation and its declared contract are decoded before becoming the active generation. */
export interface ReloadableServiceCandidate {
  readonly revision: string
  readonly contract: unknown
  readonly value: unknown
  readonly dispose?: () => void | Promise<void>
}

export interface ReloadableService<Value extends object, Method extends AsyncServiceMethod<Value> = AsyncServiceMethod<Value>> {
  readonly contract: ServiceContract<Value>
  readonly contractFingerprint: string
  readonly service: ReloadableAsyncService<Value, Method>
  /** Manual leases remain available for synchronous interfaces and compound asynchronous work. */
  readonly manager: ReloadableExtension<Value>
}

interface PreparedService {
  readonly contract: unknown
  readonly implementation: unknown
}

function fail(code: string): never { throw new FrameworkError(code, 'The reloadable service candidate is incompatible with its stable contract.') }
function promiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    && 'then' in value && typeof value.then === 'function'
}
function fingerprint<Value extends object>(contract: ServiceContract<Value>) {
  return digest({ id: contract.id, version: contract.version, methods: [...contract.methods].sort() })
}

/**
 * Reuse one extension manager while the facade keeps a stable identity.
 * Each declared asynchronous method retains its generation until the returned promise settles.
 * Synchronous methods are deliberately absent: borrow them explicitly with manager.withCurrent().
 */
export async function createReloadableService<Value extends object, Method extends AsyncServiceMethod<Value>>(options: {
  readonly id?: string
  readonly displayName: string
  readonly contract: ServiceContract<Value>
  readonly asyncMethods: readonly Method[]
  readonly load: (signal: AbortSignal) => Promise<ReloadableServiceCandidate>
  readonly signal?: AbortSignal
}): Promise<ReloadableService<Value, Method>> {
  const contract = defineServiceContract(options.contract)
  const contractFingerprint = fingerprint(contract)
  assert(Array.isArray(options.asyncMethods) && options.asyncMethods.length <= contract.methods.length
    && new Set(options.asyncMethods).size === options.asyncMethods.length
    && options.asyncMethods.every(method => contract.methods.includes(method)),
    'EXTENSION_SERVICE_METHODS_INVALID', 'Select distinct asynchronous methods declared by the stable contract.')
  assert(typeof options.load === 'function', 'EXTENSION_LOADER_INVALID', 'A service candidate loader is required.')
  const methods = Object.freeze([...options.asyncMethods])
  const internal = await createReloadableExtension<PreparedService>({
    id: options.id ?? contract.id, displayName: options.displayName, signal: options.signal,
    async load(signal) {
      const candidate = await options.load(signal)
      assert(candidate !== null && typeof candidate === 'object', 'EXTENSION_CANDIDATE_INVALID', 'A prepared service candidate is required.')
      return { revision: candidate.revision, value: Object.freeze({ contract: candidate.contract, implementation: candidate.value }),
        dispose: candidate.dispose }
    },
    validate(candidate) {
      let candidateFingerprint: string
      try {
        candidateFingerprint = fingerprint(defineServiceContract(candidate.contract as ServiceContract<Value>))
      } catch { return fail('EXTENSION_SERVICE_CONTRACT_INVALID') }
      if (candidateFingerprint !== contractFingerprint) fail('EXTENSION_SERVICE_CONTRACT_MISMATCH')
      try { validateServiceContractImplementation(contract, candidate.implementation) }
      catch { return fail('EXTENSION_SERVICE_IMPLEMENTATION_INVALID') }
    },
  })
  // This projects values only; lifecycle, revision CAS, retirement and failures stay in the original manager.
  const manager: ReloadableExtension<Value> = Object.freeze({
    id: internal.id, displayName: internal.displayName,
    current: () => internal.current().implementation as Value,
    withCurrent: <Result>(run: (value: Value) => Result | Promise<Result>) =>
      internal.withCurrent(candidate => run(candidate.implementation as Value)),
    reload: internal.reload, describe: internal.describe, close: internal.close,
  })
  const facade: Record<string, (...args: unknown[]) => Promise<unknown>> = Object.create(null) as Record<string, (...args: unknown[]) => Promise<unknown>>
  for (const method of methods) {
    facade[method] = (...args: unknown[]) => manager.withCurrent(async value => {
      const implementation: unknown = Reflect.get(value, method)
      assert(typeof implementation === 'function', 'EXTENSION_SERVICE_IMPLEMENTATION_INVALID', 'The selected service method is unavailable.')
      const result: unknown = Reflect.apply(implementation, value, args)
      assert(promiseLike(result), 'EXTENSION_SERVICE_ASYNC_REQUIRED', 'An automatic service lease requires a promise-returning method.')
      return await result
    })
  }
  return Object.freeze({ contract, contractFingerprint, service: Object.freeze(facade) as ReloadableAsyncService<Value, Method>, manager })
}

/** Fixed registrations delegate their complete execution to the currently leased behavior. */
export function createReloadableHandler<Value, Arguments extends readonly unknown[], Result>(
  manager: Pick<ReloadableExtension<Value>, 'withCurrent'>,
  run: (value: Value, ...args: Arguments) => Result | Promise<Result>,
): (...args: Arguments) => Promise<Result> {
  return (...args: Arguments) => manager.withCurrent(value => run(value, ...args))
}
