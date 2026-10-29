import { declaredMcpToolSource, readToolRegistrationSource, type ToolRegistrationSource } from './tool-registration.js'
import { legacyToolRegistrationReader } from './legacy-tool-registration.js'
import { basename, dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'

const LIMIT = 1000
export interface Module { name: string; kind: 'package' | 'local' | 'builtin' | 'unknown'; state: 'loaded' | 'configured' }
export interface Source { id: string; kind: 'dsh-global' | 'dsh-preset'; label: string; agentPreset: string | null; modules: Module[] }
export interface Item { registrationSource?: ToolRegistrationSource; id: string; name: string; description: string | null; sourceId: string; registration: 'registered'; loadedInSession: null }

// DSH 0.2.1-rc.2 has no public registration-only view: schemas(), preset
// inspection and scope acquisition may construct PTC transport or evaluate
// configuration expressions. Observe its pinned data layout without invoking
// those APIs. Unsupported layouts fail closed; never traverse arbitrary config.
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value as unknown
}
function string(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}
function moduleInfo(raw: unknown, state: Module['state']): Module | undefined {
  if (typeof raw !== 'string' || !raw || raw.length > 4096) return undefined
  if (/^(?:@[-\w.]+\/)?[-\w.]+(?:\/[-\w./]+)?$/.test(raw) && !raw.startsWith('.')) return { name: raw.slice(0, 256), kind: 'package', state }
  if (/^cordis:[-\w./]+$/.test(raw)) return { name: raw.slice(0, 256), kind: 'builtin', state }
  if (raw.startsWith('.') || raw.startsWith('/') || raw.startsWith('file:')) {
    // Retain the package directory for generic entry names so unrelated local
    // plugins do not collapse into a single "index.js". Never publish full paths.
    const path = raw.split(/[?#]/, 1)[0] ?? ''
    const file = basename(path)
    const name = (/^(?:index|main)\.[cm]?[jt]s$/.test(file) ? `${basename(dirname(path))}/${file}` : file).slice(0, 256)
    return string(name) ? { name, kind: 'local', state } : undefined
  }
  return { name: '未识别模块', kind: 'unknown', state }
}
function uniqueModules(modules: Module[]): Module[] {
  const found = new Map<string, Module>()
  for (const module of modules) {
    const key = `${module.kind}:${module.name}`
    if (found.get(key)?.state !== 'loaded') found.set(key, module)
  }
  return [...found.values()].slice(0, 256)
}
function declaredModules(rows: unknown, result: Module[], depth = 0): void {
  if (!Array.isArray(rows) || depth > 12) return
  for (const row of rows.slice(0, 256)) {
    if (own(row, 'group') === true) declaredModules(own(row, 'config'), result, depth + 1)
    else { const module = moduleInfo(own(row, 'name'), 'configured'); if (module) result.push(module) }
    if (result.length >= 256) break
  }
}
function loadedModules(tree: unknown, includeConfigured = false): Module[] {
  // Only an actual Loader tree supplied by the pinned SDK is passed here.
  if (!tree || typeof tree !== 'object' || !('entries' in tree) || typeof tree.entries !== 'function') return []
  const entries: unknown = tree.entries()
  if (!entries || typeof entries !== 'object' || !(Symbol.iterator in entries)) return []
  const modules: Module[] = []
  let visited = 0
  for (const entry of entries as Iterable<unknown>) {
    if (++visited > 1024) break
    const options = own(entry, 'options')
    const active = own(own(entry, 'fiber'), 'state') === 2
    if (own(options, 'group') === true || !active && !includeConfigured) continue
    const module = moduleInfo(own(options, 'name'), active ? 'loaded' : 'configured')
    if (module) modules.push(module)
    if (modules.length >= 256) break
  }
  return modules
}
export function inspectRegisteredToolInventory(ctx: Context) {
  const items: Item[] = []
  const sources: Source[] = []
  const missingReasons = ['local_unregistered_plugins_not_scanned']
  let limited = false
  let incomplete = false
  let moduleBudget = 1024
  const layers = own(ctx.tools, 'layers')
  const definitions = own(ctx.agentPresets, 'definitions')
  const scopes = own(layers, 'scoped')
  const readLayer = (layer: unknown, source: Source, tree: unknown): boolean => {
    if (layer === undefined && source.kind === 'dsh-preset') return true
    const data = own(own(layer, 'tools'), 'data')
    if (!(data instanceof Map)) return false
    const legacySource = legacyToolRegistrationReader(tree)
    let visited = 0
    for (const [key, definition] of data as Map<unknown, unknown>) {
      if (++visited > 2048) { limited = true; break }
      if (!string(key) || own(definition, 'name') !== key) { incomplete = true; continue }
      if (items.length >= LIMIT) { limited = true; break }
      const rawDescription = own(definition, 'description')
      const description = typeof rawDescription === 'string' ? rawDescription.slice(0, 2000) : null
      const registrationSource = readToolRegistrationSource(own(definition, 'qbfRegistration'))
        ?? declaredMcpToolSource(source.id, key) ?? legacySource(key)
      items.push({ ...(registrationSource ? { registrationSource } : {}), id: `${source.id}:${key}`, name: key, description, sourceId: source.id, registration: 'registered', loadedInSession: null })
    }
    return true
  }
  const global: Source = { id: 'dsh-global', kind: 'dsh-global', label: 'DSH 全局注册', agentPreset: null,
    modules: uniqueModules(loadedModules(ctx.get('loader'), true)) }
  sources.push(global)
  moduleBudget -= global.modules.length
  const globalRead = readLayer(own(layers, 'global'), global, ctx.get('loader'))
  if (!(definitions instanceof Map) || !(scopes instanceof Map)) incomplete = true
  else for (const [id, record] of definitions as Map<unknown, unknown>) {
    if (sources.length >= 128) { limited = true; break }
    if (!string(id)) { incomplete = true; continue }
    const config = own(record, 'config')
    const generation = own(record, 'generation')
    const declared: Module[] = []
    declaredModules(own(config, 'plugins'), declared)
    const modules = uniqueModules([...declared, ...loadedModules(own(own(generation, 'mount'), 'tree'))])
    if (modules.length > moduleBudget) { modules.splice(moduleBudget); limited = true }
    moduleBudget -= modules.length
    const label = own(config, 'name')
    const source: Source = { id: `dsh-preset:${id}`, kind: 'dsh-preset', label: string(label) ? label : id, agentPreset: id, modules }
    sources.push(source)
    const key = own(generation, 'key')
    if (key !== undefined && !readLayer(scopes.get(key), source, own(own(generation, 'mount'), 'tree'))) incomplete = true
    if (generation === undefined && declared.length > 0) incomplete = true
  }
  if (!globalRead) { incomplete = true; missingReasons.push('dsh_registration_layout_unsupported') }
  if (items.some(item => !item.registrationSource)) missingReasons.push('some_tool_origins_unavailable')
  if (incomplete) missingReasons.push('some_registration_scopes_unavailable')
  const result = { schema: 1 as const, state: !globalRead ? 'unavailable' as const : incomplete ? 'partial' as const : 'available' as const,
    items: items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), sources, limited,
    missingReasons, externalToolAuthorizationVerified: false as const }
  // Leave room for the RPC envelope under the transport's one MiB ceiling.
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > 786432 && result.items.length > 0) {
    result.items.splice(Math.max(0, result.items.length - 32)); result.limited = true
  }
  return result
}
