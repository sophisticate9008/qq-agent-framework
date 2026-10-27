import type { JsonObject, JsonValue } from '../contracts/data.ts'
import { isRecord } from '../core/values.ts'
import { DshAdapterError } from './dsh.ts'

const annotations = new Set(['description', 'title', 'default', 'examples'])
const constraints = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties'])
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
function invalid(): never {
  throw new DshAdapterError('DSH_TOOL_SCHEMA_UNSUPPORTED', 'The tool schema cannot be represented by the DSH schema subset.')
}
function scalarType(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return typeof value
  return invalid()
}

/** DSH accepts a restricted schema vocabulary. Host tool validators still enforce every input constraint. */
export function projectDshToolSchema(schema: JsonObject, depth = 0): JsonObject {
  if (depth > 32) return invalid()
  const result: JsonObject = {}
  const requirements: string[] = []
  for (const [key, value] of Object.entries(schema)) {
    if (annotations.has(key)) result[key] = value
    else if (constraints.has(key)) requirements.push(`${key}=${JSON.stringify(value)}`)
    else if (key === 'properties') {
      if (!isRecord(value)) return invalid()
      result.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => {
        if (!isRecord(child)) return invalid()
        return [name, projectDshToolSchema(child as JsonObject, depth + 1)]
      }))
    } else if (key === 'items' || key === 'additionalProperties' && isRecord(value)) {
      if (!isRecord(value)) return invalid()
      result[key] = projectDshToolSchema(value as JsonObject, depth + 1)
    } else if (key === 'oneOf') {
      if (!Array.isArray(value) || value.length < 2 || schema.type !== undefined) return invalid()
      result.oneOf = value.map(child => {
        if (!isRecord(child)) return invalid()
        return projectDshToolSchema(child as JsonObject, depth + 1)
      })
    } else if (['type', 'required', 'additionalProperties', 'enum', 'const'].includes(key)) result[key] = value
    else return invalid()
  }
  if (requirements.length) result.description = [result.description, `输入约束（宿主校验）：${requirements.join('；')}。`]
    .filter(value => typeof value === 'string' && value.length > 0).join('\n')
  if (Array.isArray(result.type)) {
    const alternatives = result.type
    if (alternatives.length < 1 || new Set(alternatives).size !== alternatives.length
      || !alternatives.every(value => typeof value === 'string' && types.has(value))) return invalid()
    const { type: _type, description, title, default: defaultValue, examples, ...branch } = result
    const choices = alternatives.map(type => projectDshToolSchema({ ...branch, type }, depth + 1))
    return { ...(choices.length === 1 ? choices[0]! : { oneOf: choices }),
      ...(description === undefined ? {} : { description }), ...(title === undefined ? {} : { title }),
      ...(defaultValue === undefined ? {} : { default: defaultValue }), ...(examples === undefined ? {} : { examples }) }
  }
  if (result.type === undefined && (result.const !== undefined || Array.isArray(result.enum))) {
    const values = result.const !== undefined ? [result.const] : result.enum as JsonValue[]
    const inferred = [...new Set(values.map(scalarType))]
    if (inferred.length !== 1) return invalid()
    result.type = inferred[0]!
  }
  if (result.type !== undefined && (typeof result.type !== 'string' || !types.has(result.type))) return invalid()
  return result
}
