import { isAlias, parseDocument, visit } from 'yaml'
import { validMigrationTargetSelection, type MigrationTargetSelection } from '../contracts/dsh-session-migration.ts'
import type { JsonValue } from '../contracts/data.ts'
import { DshAdapterError } from './dsh.ts'

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function invalid(): never { throw new DshAdapterError('DSH_MIGRATION_TARGET_UNVERIFIED', 'The current target model and preset cannot be verified.') }

/** Read-only preparation; the plugin independently verifies the live SDK metadata at preview and commit. */
export function deriveDshMigrationTargetSelection(request: { readonly provider: string; readonly model: string; readonly reasoningEffort: string;
  readonly agentPreset: string; readonly catalog: JsonValue; readonly settings: JsonValue; readonly presetDocument: JsonValue }): MigrationTargetSelection {
  const { catalog, settings, presetDocument } = request
  if (!object(catalog) || !Array.isArray(catalog.groups) || catalog.groups.length > 128
    || !Array.isArray(catalog.routableProviders) || !catalog.routableProviders.includes(request.provider)
    || !Array.isArray(catalog.failures) || catalog.failures.some(row => !object(row) || row.id === request.provider)
    || !object(settings) || !Array.isArray(settings.namespaces) || settings.namespaces.length > 256
    || !object(presetDocument) || presetDocument.agentPreset !== request.agentPreset || typeof presetDocument.content !== 'string'
    || Buffer.byteLength(presetDocument.content) > 524288) return invalid()
  const groups = catalog.groups.filter(row => object(row) && row.id === request.provider)
  const group = groups[0]
  if (groups.length !== 1 || !object(group) || !Array.isArray(group.models)) return invalid()
  const models = group.models.filter(row => object(row) && row.id === request.model)
  if (models.length !== 1 || !object(models[0])) return invalid()
  let reasoningEffort: string | undefined
  if (models[0].reasoning === undefined) {
    if (request.reasoningEffort !== 'off') return invalid()
  } else {
    const reasoning = models[0].reasoning
    if (!object(reasoning) || !Array.isArray(reasoning.efforts) || reasoning.efforts.length < 1 || reasoning.efforts.length > 64
      || reasoning.efforts.some(row => !object(row) || typeof row.id !== 'string')) return invalid()
    const efforts = reasoning.efforts.map(row => (row as Record<string, unknown>).id)
    if (new Set(efforts).size !== efforts.length) return invalid()
    if (efforts.includes(request.reasoningEffort)) reasoningEffort = request.reasoningEffort
    else if (request.reasoningEffort === 'off' && efforts.includes('none')) reasoningEffort = 'none'
    else return invalid()
  }
  const routes = settings.namespaces.flatMap(row => object(row) && object(row.value) && object(row.value.providers)
    && object(row.value.providers[request.provider]) ? [row.value.providers[request.provider]] : [])
  if (routes.length !== 1 || !object(routes[0]) || !Array.isArray(routes[0].models)) return invalid()
  const configured = routes[0].models.filter(row => object(row) && row.id === request.model)
  if (configured.length !== 1 || !object(configured[0])) return invalid()
  const document = parseDocument(presetDocument.content, { strict: true, uniqueKeys: true, prettyErrors: false, logLevel: 'silent' })
  if (document.errors.length || document.warnings.length) return invalid()
  let nodes = 0
  visit(document, (_key, node, ancestry) => { if (++nodes > 16384 || ancestry.length > 32 || isAlias(node)) invalid() })
  const parsed: unknown = document.toJS({ maxAliasCount: 0 })
  const compactions: Record<string, unknown>[] = []
  function inspect(rows: unknown): void {
    if (!Array.isArray(rows)) invalid()
    for (const row of rows) {
      if (!object(row)) invalid()
      if (row.name === 'cordis:group' && row.group === true) inspect(row.config)
      if (row.name === '@deepseek-ai/dsh-compaction-basic') {
        if (!object(row.config)) invalid()
        compactions.push(row.config)
      }
    }
  }
  inspect(parsed)
  const compaction = compactions[0]
  if (compactions.length !== 1 || !compaction || compaction.auto !== true || compaction.summarizationProvider !== request.provider
    || compaction.summarizationModel !== request.model || compaction.maxTokens !== configured[0].maxTokens) return invalid()
  const selection = { provider: request.provider, model: request.model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    contextLimits: { contextWindow: configured[0].contextWindow, maxTokens: configured[0].maxTokens, headroomTokens: compaction.headroomTokens } }
  if (!validMigrationTargetSelection(selection)) return invalid()
  return selection
}
