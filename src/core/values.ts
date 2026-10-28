export class FrameworkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'FrameworkError';
    this.code = code;
  }
}

export function assert(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new FrameworkError(code, message);
}

export function snapshot<Value>(value: Value): Value {
  const visiting = new Set<object>();
  function copy(current: unknown, depth: number): unknown {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    assert(current && typeof current === 'object' && depth <= 64 && !visiting.has(current),
      'INVALID_DATA', 'Expected finite, acyclic JSON data.');
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    assert(array || prototype === null || Object.getPrototypeOf(prototype) === null,
      'INVALID_DATA', 'Expected plain data objects.');
    visiting.add(current);
    const output: unknown[] | Record<string, unknown> = array ? [] : {};
    for (const key of Reflect.ownKeys(current)) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      assert(typeof key === 'string' && descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'),
        'INVALID_DATA', 'Accessors, symbols and hidden properties are not data.');
      assert(!array || /^(0|[1-9]\d*)$/.test(key), 'INVALID_DATA', 'Array properties must be indices.');
      Object.defineProperty(output, key, { value: copy(descriptor.value, depth + 1),
        enumerable: true, configurable: true, writable: true });
    }
    assert(!Array.isArray(current) || (Array.isArray(output) && output.length === current.length && Object.keys(output).length === current.length),
      'INVALID_DATA', 'Sparse arrays are not supported.');
    visiting.delete(current);
    return Object.freeze(output);
  }
  return copy(value, 0) as Value;
}

export { isRecord, reference } from '../contracts/values.ts';

export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value) && value.length <= 100;
}

export function errorCode(error: unknown, fallback = 'INTERNAL_ERROR'): string {
  return error instanceof FrameworkError && /^[A-Z][A-Z_]{1,63}$/.test(error.code) ? error.code : fallback;
}
