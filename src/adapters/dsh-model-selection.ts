import type { JsonObject, JsonValue } from '../contracts/data.ts'
import type { ChatSessionDefinition } from '../contracts/chat-session.ts'
import { buildChatSessionDefinition } from '../host/chat-plans.ts'
import type { NativeDeploymentPresetBinding } from '../contracts/native-deployment.ts'
import type { DshCreateSessionRequest, DshPortResult } from './dsh.ts'
import { DshAdapterError } from './dsh.ts'

function failure(code: string): DshAdapterError { return new DshAdapterError(code, 'DSH network operation did not complete safely.') }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) }
export function normalizeDshSessionDefinition(value: ChatSessionDefinition): ChatSessionDefinition {
  try {
    return buildChatSessionDefinition({
      id: value.planId, name: value.planId, description: '', instructions: value.instructions,
      personaId: value.personaId, provider: value.model.provider, model: value.model.name,
      reasoningEffort: value.model.reasoningEffort,
      ...(Object.hasOwn(value, 'contextLimits') ? { contextLimits: value.contextLimits } : {}),
      ...(Object.hasOwn(value, 'capabilitySelection') ? { capabilitySelection: value.capabilitySelection } : {}),
    }, { id: value.personaId, name: value.personaId, identity: value.persona.identity, style: value.persona.style })
  } catch {
    throw failure('DSH_INVALID_SESSION_DEFINITION')
  }
}

function sameDefinition(left: ChatSessionDefinition, right: ChatSessionDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}


export function catalogToken(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
}

export function resolveDshOffSelection(catalog: JsonValue, provider: string, model: string): 'omit' | 'explicit' | 'unsupported' | 'unverified' {
  if (!record(catalog) || !record(catalog.default) || !catalogToken(catalog.default.provider) || !catalogToken(catalog.default.model)
    || catalog.default.reasoningEffort !== undefined && !catalogToken(catalog.default.reasoningEffort)
    || !Array.isArray(catalog.routableProviders) || catalog.routableProviders.length > 128 || !catalog.routableProviders.every(identifier)
    || new Set(catalog.routableProviders).size !== catalog.routableProviders.length
    || !Array.isArray(catalog.groups) || catalog.groups.length > 128 || !Array.isArray(catalog.failures) || catalog.failures.length > 128) return 'unverified'
  const groups = catalog.groups
  if (groups.some(group => !record(group) || !identifier(group.id) || typeof group.name !== 'string' || !group.name.trim()
    || !Array.isArray(group.models) || group.models.length === 0 || group.models.length > 4096
    || group.models.some(entry => !record(entry) || !catalogToken(entry.id) || typeof entry.name !== 'string' || !entry.name.trim())
    || new Set(group.models.map(entry => (entry as Record<string, unknown>).id)).size !== group.models.length)) return 'unverified'
  const identifiers = groups.map(group => (group as Record<string, unknown>).id)
  if (new Set(identifiers).size !== identifiers.length
    || JSON.stringify([...identifiers].sort()) !== JSON.stringify([...catalog.routableProviders].sort())
    || catalog.failures.some(entry => !record(entry) || !identifier(entry.id) || typeof entry.name !== 'string' || !entry.name.trim()
      || typeof entry.message !== 'string' || entry.id === provider)) return 'unverified'
  const selectedGroup = groups.find(group => record(group) && group.id === provider)
  if (!record(selectedGroup) || !Array.isArray(selectedGroup.models)) return 'unverified'
  const selectedModel = selectedGroup.models.find(entry => record(entry) && entry.id === model)
  if (!record(selectedModel)) return 'unverified'
  if (!Object.hasOwn(selectedModel, 'reasoning')) return 'omit'
  const reasoning = selectedModel.reasoning
  if (!record(reasoning) || !Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0 || reasoning.efforts.length > 64
    || reasoning.efforts.some(effort => !record(effort) || !catalogToken(effort.id) || typeof effort.name !== 'string' || !effort.name.trim())) return 'unverified'
  const efforts = reasoning.efforts.map(effort => (effort as Record<string, unknown>).id)
  if (new Set(efforts).size !== efforts.length || reasoning.defaultEffort !== undefined
    && (!catalogToken(reasoning.defaultEffort) || !efforts.includes(reasoning.defaultEffort))) return 'unverified'
  return efforts.includes('off') ? 'explicit' : 'unsupported'
}


function rejected(code: string): DshPortResult<never> {
  return { ok: false, error: { code } }
}

export function createDshSessionCreator(options: {
  readonly configuredDefinition: ChatSessionDefinition | ((request: DshCreateSessionRequest) => ChatSessionDefinition) | undefined
  readonly bindings: readonly Pick<NativeDeploymentPresetBinding, 'agentPreset' | 'definition' | 'externalProvider' | 'conversationKind'>[]
  readonly rpc: (method: 'session/modelCatalog' | 'session/create' | 'session/selectModel', input: JsonObject | undefined,
    signal: AbortSignal) => Promise<DshPortResult<JsonValue>>
}) {
  const { configuredDefinition, bindings, rpc } = options
  return async (request: DshCreateSessionRequest): Promise<DshPortResult<{ sessionId: string }>> => {
      request.signal.throwIfAborted()
      if (configuredDefinition === undefined) return rejected('DSH_SESSION_DEFINITION_REQUIRED')
      const selectedDefinition = normalizeDshSessionDefinition(typeof configuredDefinition === 'function' ? configuredDefinition(request) : configuredDefinition)
      const conversationKind = request.conversationId.startsWith('group:') ? 'group'
        : request.conversationId.startsWith('private:') ? 'private' : undefined
      const matches = bindings.filter(candidate => sameDefinition(candidate.definition, selectedDefinition)
        && (candidate.conversationKind === undefined || candidate.conversationKind === conversationKind))
      if (matches.length !== 1) return rejected('DSH_INSTRUCTIONS_UNSUPPORTED')
      const binding = matches[0]!
      const model = selectedDefinition.model
      const externalProvider = binding.externalProvider ?? model.provider
      let offSelection: 'omit' | 'explicit' | undefined
      if (model.reasoningEffort === 'off') {
        const catalog = await rpc('session/modelCatalog', undefined, request.signal)
        if (!catalog.ok) return rejected('DSH_MODEL_CAPABILITIES_UNVERIFIED')
        const selection = resolveDshOffSelection(catalog.value, externalProvider, model.name)
        if (selection === 'unverified') return rejected('DSH_MODEL_CAPABILITIES_UNVERIFIED')
        if (selection === 'unsupported') return rejected('DSH_REASONING_UNSUPPORTED')
        offSelection = selection
      }
      const effort = offSelection === 'omit' ? undefined : model.reasoningEffort
      const created = await rpc('session/create', { agentPreset: binding.agentPreset }, request.signal)
      if (!created.ok) return created
      if (!record(created.value) || !identifier(created.value.sessionId) || created.value.agentPreset !== binding.agentPreset) {
        throw failure('DSH_CREATE_CONFIGURATION_UNKNOWN')
      }
      const sessionId = created.value.sessionId
      const selected = await rpc('session/selectModel', { sessionId, provider: externalProvider, model: model.name,
        ...(effort === undefined ? {} : { reasoningEffort: effort }) }, request.signal)
      if (!selected.ok || !record(selected.value) || !record(selected.value.selected)
        || selected.value.selected.provider !== externalProvider || selected.value.selected.model !== model.name
        || selected.value.selected.reasoningEffort !== effort) {
        throw failure('DSH_CREATE_CONFIGURATION_UNKNOWN')
      }
      if (offSelection !== undefined) {
        let catalog: DshPortResult<JsonValue>
        try {
          catalog = await rpc('session/modelCatalog', undefined, request.signal)
        } catch {
          throw failure('DSH_CREATE_CONFIGURATION_UNKNOWN')
        }
        if (!catalog.ok || resolveDshOffSelection(catalog.value, externalProvider, model.name) !== offSelection) {
          throw failure('DSH_CREATE_CONFIGURATION_UNKNOWN')
        }
      }
      return { ok: true, value: { sessionId } }
    }
}
