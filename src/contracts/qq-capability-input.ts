import type { JsonObject, JsonValue } from './data.ts';
import type { QqCapabilityDefinition } from './qq-capabilities.ts';
import { isRecord } from './values.ts';

const MAX_DEPTH = 48;
const MAX_NODES = 20_000;
const MAX_INPUT_BYTES = 524_288;

/** Reject non-JSON values before cloning; JSON.stringify alone silently drops them. */
export function isBoundedQqJson(value: unknown, maximumNodes = MAX_NODES): value is JsonValue {
  const active = new Set<object>();
  let nodes = 0;
  function visit(current: unknown, depth: number): boolean {
    if (++nodes > maximumNodes || depth > MAX_DEPTH) return false;
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return true;
    if (typeof current === 'number') return Number.isFinite(current);
    if (typeof current !== 'object' || active.has(current)) return false;
    const prototype: unknown = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) return false;
    if (Array.isArray(current) && (current.length > maximumNodes || Object.keys(current).length !== current.length)) return false;
    if (Reflect.ownKeys(current).some(key => typeof key !== 'string')) return false;
    active.add(current);
    const valid = Array.isArray(current)
      ? Array.from({ length: current.length }, (_, index) => Object.hasOwn(current, index) && visit(current[index], depth + 1)).every(Boolean)
      : Object.values(current).every(child => visit(child, depth + 1));
    active.delete(current);
    return valid;
  }
  return visit(value, 0);
}

function branches(schema: JsonObject, key: string): readonly JsonObject[] {
  const value = schema[key];
  return Array.isArray(value) ? value.filter(isRecord) as JsonObject[] : [];
}
function matches(schema: JsonObject, value: JsonValue, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (isRecord(schema.not) && matches(schema.not as JsonObject, value, depth + 1)) return false;
  if (Object.hasOwn(schema, 'const') && schema.const !== value) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (Array.isArray(schema.anyOf) && !branches(schema, 'anyOf').some(branch => matches(branch, value, depth + 1))) return false;
  if (Array.isArray(schema.allOf) && !branches(schema, 'allOf').every(branch => matches(branch, value, depth + 1))) return false;
  switch (schema.type) {
    case 'null': if (value !== null) return false; break;
    case 'string': if (typeof value !== 'string') return false; break;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) return false; break;
    case 'integer': if (typeof value !== 'number' || !Number.isSafeInteger(value)) return false; break;
    case 'boolean': if (typeof value !== 'boolean') return false; break;
    case 'array': if (!Array.isArray(value)) return false; break;
    case 'object': if (!isRecord(value)) return false; break;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
    if (typeof schema.multipleOf === 'number' && !Number.isInteger(value / schema.multipleOf)) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (isRecord(schema.items) && !value.every(child => matches(schema.items as JsonObject, child, depth + 1))) return false;
  }
  if (isRecord(value)) {
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(value, key))) return false;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(value)) {
      const rule = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (isRecord(rule)) { if (!matches(rule as JsonObject, child, depth + 1)) return false; }
      else if (schema.additionalProperties === false) return false;
      else if (isRecord(schema.additionalProperties) && !matches(schema.additionalProperties as JsonObject, child, depth + 1)) return false;
    }
  }
  return true;
}
function defaults(schema: JsonObject, value: JsonValue, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) return value;
  const selected = branches(schema, 'anyOf').find(branch => matches(branch, value));
  if (selected) value = defaults(selected, value, depth + 1);
  if (Array.isArray(value)) return value.map(child => isRecord(schema.items) ? defaults(schema.items as JsonObject, child, depth + 1) : child);
  if (!isRecord(value)) return value;
  const output: JsonObject = Object.assign(Object.create(null) as JsonObject, value);
  if (isRecord(schema.properties)) for (const [key, rule] of Object.entries(schema.properties)) {
    if (!isRecord(rule)) continue;
    if (!Object.hasOwn(output, key) && Object.hasOwn(rule, 'default')) output[key] = rule.default as JsonValue;
    if (Object.hasOwn(output, key)) output[key] = defaults(rule as JsonObject, output[key], depth + 1);
  }
  return output;
}

/** Returns a private, defaulted JSON snapshot. No coercion or configuration evaluation. */
export function decodeQqCapabilityInput(capability: QqCapabilityDefinition, input: unknown): JsonObject | null {
  try {
    if (!isRecord(input) || !isBoundedQqJson(input)) return null;
    const encoded = JSON.stringify(input);
    if (new TextEncoder().encode(encoded).byteLength > MAX_INPUT_BYTES) return null;
    const cloned: unknown = JSON.parse(encoded);
    if (!isRecord(cloned)) return null;
    const normalized = defaults(capability.inputSchema, cloned as JsonObject);
    return isRecord(normalized) && matches(capability.inputSchema, normalized) ? normalized as JsonObject : null;
  } catch { return null; }
}
