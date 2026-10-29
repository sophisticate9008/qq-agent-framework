/** Shared interface identity; it never grants permission or registers model tools. */
export interface ServiceContract<Value extends object> {
  readonly id: string
  readonly version: number
  readonly description: string
  readonly methods: readonly Extract<keyof Value, string>[]
}

export function defineServiceContract<Value extends object>(input: ServiceContract<Value>): ServiceContract<Value> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(input.id)
    || !Number.isSafeInteger(input.version) || input.version < 1 || input.version > 1000
    || typeof input.description !== 'string' || !input.description.trim() || input.description.length > 500
    || /[\x00-\x1f\x7f]/.test(input.description) || !Array.isArray(input.methods)
    || input.methods.length > 128 || new Set(input.methods).size !== input.methods.length
    || !input.methods.every(method => /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(method))) {
    throw new TypeError('SERVICE_CONTRACT_INVALID')
  }
  return Object.freeze({ ...input, methods: Object.freeze([...input.methods]) })
}

/** Shape validation supplements, rather than replaces, method boundary decoders. */
export function validateServiceContractImplementation<Value extends object>(contract: ServiceContract<Value>, value: unknown): asserts value is Value {
  if (typeof value !== 'object' || value === null
    || !contract.methods.every(method => typeof Reflect.get(value, method) === 'function')) {
    throw new TypeError('SERVICE_IMPLEMENTATION_INVALID')
  }
}

export interface ServiceMetadata {
  readonly description: string
  readonly methods: readonly string[]
}
export interface ServiceSnapshot extends ServiceMetadata {
  readonly id: string
  readonly version: number
  readonly owner: string
  readonly origin: 'framework-builtin' | 'extension'
  readonly state: 'declared' | 'registered' | 'ready' | 'unavailable'
  readonly scoped: boolean
}
