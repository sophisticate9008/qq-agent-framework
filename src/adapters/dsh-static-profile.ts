import { isAlias, isMap, isScalar, parseDocument, visit } from 'yaml'
import type { JsonObject, JsonValue } from '../contracts/data.ts'
import { isRecord, snapshot } from '../core/values.ts'

export type StaticDshYamlDocument = ReturnType<typeof parseDocument>

export class StaticDshProfileError extends Error {
  readonly code: string
  constructor(code: string) { super('The static DSH profile cannot be interpreted safely.'); this.code = code }
}
function fail(code: string): never { throw new StaticDshProfileError(code) }

/** Parse bounded YAML without aliases, executable tags, merge keys or JavaScript evaluation. */
export function readStaticDshProfile(text: string): StaticDshYamlDocument {
  if (Buffer.byteLength(text) > 1_048_576) fail('dsh_document_too_large')
  const document = parseDocument(text, {
    version: '1.2', strict: true, uniqueKeys: true, stringKeys: true,
    prettyErrors: false, logLevel: 'silent', keepSourceTokens: true,
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }]
  })
  if (document.errors.length || document.warnings.length) fail('dsh_yaml_invalid')
  let nodes = 0
  visit(document, (_key, node, path) => {
    if (++nodes > 30_000 || path.length > 80 || isAlias(node)) fail('dsh_yaml_complexity_unsupported')
    if (isScalar(node) && node.tag !== undefined && !['tag:yaml.org,2002:js', 'tag:yaml.org,2002:str',
      'tag:yaml.org,2002:int', 'tag:yaml.org,2002:float', 'tag:yaml.org,2002:bool', 'tag:yaml.org,2002:null'].includes(node.tag))
      fail('dsh_yaml_tag_unsupported')
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string'
        || ['__proto__', 'constructor', 'prototype', '<<'].includes(pair.key.value)) fail('dsh_yaml_key_unsupported')
    }
  })
  return document
}

/** Expressions are inert markers. Cloning preserves the caller's AST and unmanaged source formatting. */
export function staticDshProfileValues(document: StaticDshYamlDocument): JsonValue {
  const copy = document.clone()
  visit(copy, { Scalar(_key, node) {
    if (node.tag === 'tag:yaml.org,2002:js') node.value = { __jsExpr: node.value }
  } })
  try { return snapshot(copy.toJS({ maxAliasCount: 0 }) as unknown) as JsonValue }
  catch { return fail('dsh_yaml_invalid') }
}

/** Compose insertions and explicit patches over cloned data, returning parents and nested rows in insertion order. */
export function composeStaticDshLayers(layers: readonly unknown[]): JsonObject[] {
  const indexed = new Map<string, JsonObject>()
  function validateKeys(value: JsonValue): void {
    if (Array.isArray(value)) { for (const item of value) validateKeys(item); return }
    if (!isRecord(value)) return
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype', '<<'].includes(key)) fail('dsh_yaml_key_unsupported')
      validateKeys(item)
    }
  }
  function indexRows(entries: JsonValue[]): void {
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string' || indexed.has(entry.id))
        fail('dsh_entry_schema_unsupported')
      const row = entry as JsonObject
      indexed.set(entry.id, row)
      if (row.group === true && Array.isArray(row.config)) indexRows(row.config)
    }
  }
  for (const source of layers) {
    let layer: JsonValue
    try { layer = structuredClone(snapshot(source)) as JsonValue }
    catch { fail('dsh_patch_schema_unsupported') }
    validateKeys(layer)
    if (!Array.isArray(layer)) fail('dsh_patch_sequence_required')
    for (const value of layer) {
      if (!isRecord(value)) fail('dsh_patch_schema_unsupported')
      const patch = value as JsonObject
      if (Object.hasOwn(patch, 'insert')) {
        if (!Array.isArray(patch.insert)) fail('dsh_patch_schema_unsupported')
        if (patch.id !== undefined) {
          const parent = typeof patch.id === 'string' ? indexed.get(patch.id) : undefined
          if (!parent || parent.group !== true || !Array.isArray(parent.config)) fail('dsh_patch_target_missing')
          parent.config.push(...patch.insert)
        }
        indexRows(patch.insert)
      } else {
        const target = typeof patch.id === 'string' ? indexed.get(patch.id) : undefined
        if (!target || patch.name !== undefined && patch.name !== target.name) fail('dsh_explicit_layers_required')
        if (target.group === true && patch.config !== undefined) fail('dsh_group_replacement_unsupported')
        for (const [key, value] of Object.entries(patch)) if (key !== 'id' && key !== 'name') target[key] = value
      }
    }
  }
  return [...indexed.values()]
}
