import { validateServiceContractImplementation, type ServiceContract, type ServiceMetadata } from '../contracts/service-contract.ts'
import type { NativeServiceConsumer } from './native-packages.ts'
import { FrameworkError } from '../core/values.ts'

function validate<Value extends object>(contract: ServiceContract<Value>, value: unknown): asserts value is Value {
  try { validateServiceContractImplementation(contract, value) }
  catch { throw new FrameworkError('SERVICE_IMPLEMENTATION_INVALID', 'The service does not implement its declared interface.') }
}

export function serviceDeclaration<Value extends object>(contract: ServiceContract<Value>) {
  return Object.freeze({ id: contract.id, version: contract.version })
}
export function useService<Value extends object>(context: { service(id: string, version: number): unknown }, contract: ServiceContract<Value>): Value {
  const value = context.service(contract.id, contract.version)
  validate(contract, value)
  return value
}
export function publishService<Value extends object>(context: {
  publish(id: string, version: number, value: unknown, metadata?: ServiceMetadata): void
}, contract: ServiceContract<Value>, value: Value): void {
  validate(contract, value)
  context.publish(contract.id, contract.version, value, { description: contract.description, methods: contract.methods })
}

export function publishScopedService<Value extends object>(context: {
  publishScoped(id: string, version: number, factory: (consumer: NativeServiceConsumer) => unknown, metadata?: ServiceMetadata): void
}, contract: ServiceContract<Value>, factory: (consumer: NativeServiceConsumer) => Value): void {
  context.publishScoped(contract.id, contract.version, consumer => {
    const value = factory(consumer)
    validate(contract, value)
    return value
  }, { description: contract.description, methods: contract.methods })
}

/** A facade also works for frozen implementations; every retained method checks both lifetimes. */
export function guardService(value: unknown, active: () => void): unknown {
  const objects = new WeakMap<object, object>()
  function wrap(current: unknown): unknown {
    if (current === null || typeof current !== 'object') return current
    // Native data containers keep their semantics. Service records and arrays use facades.
    if (current instanceof Date || current instanceof Map || current instanceof Set
      || ArrayBuffer.isView(current) || current instanceof ArrayBuffer) return current
    const previous = objects.get(current)
    if (previous) return previous
    const methods = new Map<PropertyKey, { original: unknown; wrapped: (...args: unknown[]) => unknown }>()
    const target: object = Array.isArray(current) ? new Array(current.length) : Object.create(null) as object
    const facade: object = new Proxy(target, {
      get(_target, key): unknown {
        active()
        const member: unknown = Reflect.get(current, key)
        if (typeof member !== 'function') return wrap(member)
        const cached = methods.get(key)
        if (cached?.original === member) return cached.wrapped
        const wrapped = (...args: unknown[]) => { active(); return Reflect.apply(member, Array.isArray(current) ? facade : current, args) as unknown }
        methods.set(key, { original: member, wrapped })
        return wrapped
      },
      ownKeys() { active(); return Reflect.ownKeys(current) },
      has(_target, key) { active(); return Reflect.has(current, key) },
      getOwnPropertyDescriptor(_target, key) {
        active()
        if (Array.isArray(current) && key === 'length') return Reflect.getOwnPropertyDescriptor(target, key)
        const descriptor = Reflect.getOwnPropertyDescriptor(current, key)
        return descriptor ? { configurable: true, enumerable: descriptor.enumerable, writable: false,
          value: Reflect.get(facade, key) } : undefined
      },
      set() { return false }, defineProperty() { return false }, deleteProperty() { return false },
      preventExtensions() { return false }, setPrototypeOf() { return false },
    })
    objects.set(current, facade)
    return facade
  }
  return wrap(value)
}
