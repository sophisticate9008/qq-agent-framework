import { createHash } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isAlias, isMap, isScalar, parseDocument, visit } from 'yaml'
import type { JsonObject, JsonValue } from '../core/types.ts'
import { snapshot } from '../core/values.ts'
import type { DshJsonRpcPort } from '../adapters/dsh-jsonrpc.ts'
import type { DshDeploymentPreset } from '../adapters/dsh-deployment.ts'

export const CHAT_CAPABILITY_BOUNDARY = Object.freeze({
  mounted: false as const,
  effectiveToolScopeVerified: false as const,
  externalToolAuthorizationVerified: false as const,
  requiresSeparateExternalToolAuthorization: true as const,
})

export const CHAT_CAPABILITY_SOURCE_REFS = Object.freeze([
  '@deepseek-ai/dsh-agent-preset-registry/lib/types/definition.d.ts (plugins list; no inheritance field)',
  '@deepseek-ai/cordis-plugin-loader/lib/types/config/entry.d.ts (entry options)',
  '@deepseek-ai/cordis-plugin-loader/lib/types/config/isolate.d.ts (private versus named shared realms)',
  '@deepseek-ai/dsh-agent-preset-registry/lib/index.js:219 (activation audit; compatibility may disable rows)',
  '@deepseek-ai/dsh-tools/lib/types/index.d.ts:632 (global inheritance/scoped shadow/restrictions)',
  '@deepseek-ai/dsh-agent-preset-registry/lib/typert.remote-client.d.ts (only list/read/select)',
])

export interface ChatCapabilitySelection {
  readonly presetId: string
  readonly revision: string
}

export interface ChatCapabilityPreset extends ChatCapabilitySelection {
  readonly name: string
  readonly description: string
  readonly composable: boolean
  readonly packages: readonly string[]
  readonly missingReasons: readonly string[]
}

export interface ChatCapabilityApproval {
  readonly approvalId: string
  readonly authority: 'owner'
  readonly externalTools: 'separate-runtime-authorization-required'
}

export interface ChatCapabilityCompositionRequest {
  readonly selection: ChatCapabilitySelection
  readonly basePreset: DshDeploymentPreset
  readonly target: { readonly profilePath: string; readonly expectedRevision: string; readonly presetId: string }
}

export interface ChatCapabilityDeclarationRequest {
  readonly profilePath: string
  readonly expectedRevision: string
  readonly source: ChatCapabilitySelection
  readonly approvalId: string
  readonly preset: DshDeploymentPreset
}

export type ChatCapabilityDeclare = (request: ChatCapabilityDeclarationRequest, signal: AbortSignal) => Promise<
  | { readonly status: 'committed'; readonly backupId: string }
  | { readonly status: 'conflict' | 'unknown' }
>

export interface ChatCapabilityOptions {
  readonly client: Pick<DshJsonRpcPort, 'listAgentPresets' | 'readAgentPreset'>
  readonly authorize?: (selection: ChatCapabilitySelection, signal: AbortSignal) => Promise<ChatCapabilityApproval | null>
}

interface Declaration {
  readonly metadata: ChatCapabilityPreset
  readonly plugins: readonly JsonObject[] | undefined
}

class CapabilityError extends Error {
  readonly code: string
  constructor(code: string) {
    super('External capability declaration did not complete safely.')
    this.code = code
  }
}

function fail(code: string): never {
  throw new CapabilityError(code)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function safePlugins(text: string): readonly JsonObject[] {
  if (Buffer.byteLength(text) > 262_144) fail('capability_document_too_large')
  const document = parseDocument(text, { strict: true, uniqueKeys: true, stringKeys: true, prettyErrors: false, logLevel: 'silent' })
  if (document.errors.length || document.warnings.length) fail('capability_yaml_or_expression_unsupported')
  let count = 0
  visit(document, (_key, node, path) => {
    if (++count > 8_000 || path.length > 40 || isAlias(node)) fail('capability_yaml_complexity_unsupported')
    if (isScalar(node) && node.tag && !['tag:yaml.org,2002:str', 'tag:yaml.org,2002:int', 'tag:yaml.org,2002:float', 'tag:yaml.org,2002:bool', 'tag:yaml.org,2002:null'].includes(node.tag)) fail('capability_yaml_or_expression_unsupported')
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || ['__proto__', 'prototype', 'constructor', '<<'].includes(pair.key.value)) fail('capability_yaml_key_unsupported')
    }
  })
  const value: unknown = document.toJS({ maxAliasCount: 0 })
  const ids = new Set<string>()
  const checkRows = (rows: unknown): void => {
    if (!Array.isArray(rows) || rows.length > 128) fail('capability_entry_schema_unsupported')
    for (const row of rows) {
      if (!object(row) || !identifier(row.id) || ids.has(row.id) || typeof row.name !== 'string'
        || Object.keys(row).some(key => !['id', 'name', 'config', 'group', 'disabled', 'isolate'].includes(key))
        || row.disabled !== undefined && typeof row.disabled !== 'boolean') fail('capability_entry_schema_unsupported')
      ids.add(row.id)
      if (row.group === true) {
        if (row.name !== 'cordis:group') fail('capability_group_unsupported')
        checkRows(row.config)
      } else if (row.group !== undefined && row.group !== false
        || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(row.name)) fail('capability_module_specifier_unsupported')
      if (row.isolate !== undefined && (!object(row.isolate) || Object.entries(row.isolate).some(([service, realm]) =>
        !/^[a-zA-Z][a-zA-Z0-9]*$/.test(service) || realm !== true))) fail('capability_shared_realm_unsupported')
    }
  }
  checkRows(value)
  return snapshot(value) as readonly JsonObject[]
}

function packages(plugins: readonly JsonObject[]): string[] {
  return [...new Set(plugins.flatMap(row => row.group === true && Array.isArray(row.config)
    ? [String(row.name), ...packages(row.config as JsonObject[])] : [String(row.name)]))]
}

function compositionProblems(plugins: readonly JsonObject[]): string[] {
  const names = packages(plugins)
  const problems: string[] = []
  if (names.some(name => ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-system-prompt'].includes(name))) problems.push('capability_preset_contains_persona')
  if (names.some(name => /^@deepseek-ai\/(?:dsh-llm(?:-|$)|dsh-credentials(?:-|$)|dsh-agent-default-model$|dsh-agent-preset(?:-|$)|cordis-plugin-include$)/.test(name))) problems.push('capability_preset_changes_host_authority')
  return problems
}

function rowIds(plugins: readonly JsonObject[]): string[] {
  return plugins.flatMap(row => [String(row.id), ...(row.group === true && Array.isArray(row.config) ? rowIds(row.config as JsonObject[]) : [])])
}

function missing(error: unknown): string[] {
  return [error instanceof CapabilityError ? error.code : 'capability_read_or_apply_failed']
}

export function createChatCapabilityService(options: ChatCapabilityOptions) {
  if (typeof options.client?.listAgentPresets !== 'function' || typeof options.client?.readAgentPreset !== 'function'
    || options.authorize !== undefined && typeof options.authorize !== 'function') throw new TypeError('Explicit DSH capability client required')
  let applying = false
  const roster = async (signal: AbortSignal): Promise<Record<string, unknown>[]> => {
    const result: unknown = await options.client.listAgentPresets(signal)
    if (!object(result) || !Array.isArray(result.presets) || result.presets.length > 128) fail('capability_roster_invalid')
    const ids = new Set<string>()
    return result.presets.map(row => {
      if (!object(row) || !identifier(row.id) || ids.has(row.id) || typeof row.isDefault !== 'boolean') fail('capability_roster_invalid')
      ids.add(row.id)
      return row
    })
  }
  const read = async (row: Record<string, unknown>, signal: AbortSignal): Promise<Declaration> => {
    const id = String(row.id)
    if (row.broken !== undefined) return { metadata: { presetId: id, revision: hash({ id, broken: true }), name: id, description: '', composable: false,
      packages: [], missingReasons: ['capability_preset_broken'] }, plugins: undefined }
    const result: unknown = await options.client.readAgentPreset(id, signal)
    if (!object(result) || result.agentPreset !== id || typeof result.content !== 'string') fail('capability_document_invalid')
    let plugins: readonly JsonObject[] | undefined
    let missingReasons: string[] = []
    try { plugins = safePlugins(result.content); missingReasons = compositionProblems(plugins) } catch (error) { missingReasons = missing(error) }
    const name = typeof row.name === 'string' ? row.name.slice(0, 128) : id
    const description = typeof row.description === 'string' ? row.description.slice(0, 512) : ''
    return { metadata: snapshot({ presetId: id, revision: hash({ id, content: result.content }), name, description,
      composable: missingReasons.length === 0, packages: plugins ? packages(plugins) : [], missingReasons }), plugins }
  }
  const selected = async (selection: ChatCapabilitySelection, signal: AbortSignal): Promise<Declaration> => {
    if (!identifier(selection.presetId) || !/^[a-f0-9]{64}$/.test(selection.revision)) fail('capability_selection_invalid')
    const rows = await roster(signal)
    const row = rows.find(candidate => candidate.id === selection.presetId)
    if (!row) fail('capability_preset_missing')
    const declaration = await read(row, signal)
    if (declaration.metadata.revision !== selection.revision) fail('capability_source_revision_conflict')
    return declaration
  }
  return Object.freeze({
    async catalog(signal: AbortSignal) {
      const presets: ChatCapabilityPreset[] = []
      let bytes = 0
      for (const row of await roster(signal)) {
        signal.throwIfAborted()
        const declaration = await read(row, signal)
        bytes += Buffer.byteLength(JSON.stringify(declaration.plugins ?? []))
        if (bytes > 2_097_152) fail('capability_catalog_too_large')
        presets.push(declaration.metadata)
      }
      return snapshot({ presets, sourceRefs: CHAT_CAPABILITY_SOURCE_REFS, ...CHAT_CAPABILITY_BOUNDARY })
    },
    async prepare(request: ChatCapabilityCompositionRequest, signal: AbortSignal) {
      const captured = snapshot(request)
      let candidate: DshDeploymentPreset | undefined
      let missingReasons: string[] = []
      let declaration: Declaration | undefined
      try {
        if (!isAbsolute(captured.target.profilePath) || basename(captured.target.profilePath) !== 'cordis.patch.yml'
          || !/^[a-f0-9]{64}$/.test(captured.target.expectedRevision) || !identifier(captured.target.presetId)) fail('capability_target_invalid')
        declaration = await selected(captured.selection, signal)
        missingReasons = [...declaration.metadata.missingReasons]
        const base = safePlugins(JSON.stringify(captured.basePreset.config.plugins))
        if (!declaration.plugins || missingReasons.length) fail(missingReasons[0] ?? 'capability_composition_unsupported')
        const ids = rowIds(base)
        if (rowIds(declaration.plugins).some(id => ids.includes(id))) fail('capability_entry_id_conflict')
        candidate = snapshot({ entryId: `cap-${hash(captured).slice(0, 24)}`, config: {
          ...captured.basePreset.config, id: captured.target.presetId, plugins: [...base, ...declaration.plugins],
        } })
      } catch (error) { missingReasons = missing(error) }
      const summary = snapshot({ ready: candidate !== undefined && missingReasons.length === 0, missingReasons,
        selection: captured.selection, packages: declaration?.metadata.packages ?? [], ownerApprovalRequired: true,
        sourceRefs: CHAT_CAPABILITY_SOURCE_REFS, ...CHAT_CAPABILITY_BOUNDARY })
      let attempted = false
      return Object.freeze({
        summary,
        async applyDeclaration(declare: ChatCapabilityDeclare, applySignal: AbortSignal) {
          if (!summary.ready || !candidate) return { state: 'blocked', missingReasons: summary.missingReasons, ...CHAT_CAPABILITY_BOUNDARY }
          if (attempted || applying) return { state: 'blocked', missingReasons: ['capability_prepare_again'], ...CHAT_CAPABILITY_BOUNDARY }
          if (!options.authorize) return { state: 'blocked', missingReasons: ['capability_owner_approval_required'], ...CHAT_CAPABILITY_BOUNDARY }
          attempted = true
          applying = true
          try {
            applySignal.throwIfAborted()
            const approval = await options.authorize(captured.selection, applySignal)
            if (!approval || !identifier(approval.approvalId) || approval.authority !== 'owner'
              || approval.externalTools !== 'separate-runtime-authorization-required') fail('capability_owner_approval_required')
            await selected(captured.selection, applySignal)
            const receipt = await declare({ profilePath: captured.target.profilePath, expectedRevision: captured.target.expectedRevision,
              source: captured.selection, approvalId: approval.approvalId, preset: candidate }, applySignal)
            if (receipt.status !== 'committed') return { state: receipt.status, missingReasons: ['capability_declaration_not_confirmed'], ...CHAT_CAPABILITY_BOUNDARY }
            if (!receipt.backupId) fail('capability_backup_required')
            const rows = await roster(applySignal)
            const row = rows.find(item => item.id === captured.target.presetId)
            if (!row || row.broken !== undefined) fail('capability_declaration_readback_required')
            const actual: unknown = await options.client.readAgentPreset(captured.target.presetId, applySignal)
            if (!object(actual) || actual.agentPreset !== captured.target.presetId || typeof actual.content !== 'string'
              || !isDeepStrictEqual(safePlugins(actual.content), candidate.config.plugins)) fail('capability_declaration_readback_required')
            return snapshot({ state: 'declaration-verified', presetId: captured.target.presetId, revision: hash(actual.content),
              backupId: receipt.backupId, missingReasons: [], ...CHAT_CAPABILITY_BOUNDARY })
          } catch (error) {
            return { state: 'unverified', missingReasons: missing(error), ...CHAT_CAPABILITY_BOUNDARY }
          } finally { applying = false }
        },
      })
    },
  })
}
