import { validateNativeChatAccess } from '../contracts/native-access.ts'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isNativeConfigurationRevisions, NATIVE_CONFIGURATION_REVISION_KEYS,
  type NativeConfigurationRevisionKey } from '../contracts/native-revisions.ts'
import { isChatSessionDefinition } from '../contracts/chat-session.ts'
import type { NativeDeploymentPresetBinding } from '../contracts/native-deployment.ts'
import { isRecord } from '../core/values.ts'
import { validateDshModelSettings } from '../adapters/dsh-deployment.ts'
import { validateAdapterConfiguration } from './adapter-configuration.ts'
import { buildChatSessionDefinition, validateChatPlanCatalog, validateChatPersonas } from './chat-plans.ts'
import { validateModelProviders } from './model-providers.ts'
import { modelProviderApi } from './model-provider-protocols.ts'
import { validateNativeChatAuthorization, type NativeChatConfiguration } from './native-chat-configuration.ts'
import { validateNativeExecutionPolicy } from './native-execution.ts'
import { validateChatCapabilityCompositionApproval } from './chat-capabilities.ts'

export type { NativeConfigurationDependency, NativeConfigurationImpact, NativeConfigurationImpactOptions } from '../contracts/native-configuration-impact.ts'
import type { NativeConfigurationDependency, NativeConfigurationImpact, NativeConfigurationImpactOptions } from '../contracts/native-configuration-impact.ts'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function requireValid(condition: boolean): asserts condition {
  if (!condition) throw new TypeError('Native configuration dependencies are unavailable')
}

function deployment(configuration: NativeChatConfiguration) {
  const value = configuration.deployment
  requireValid(isRecord(value) && typeof value.namespace === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.namespace)
    && Object.keys(value).every(key => ['namespace', 'target', 'modelSettings', 'capabilityApproval'].includes(key)))
  if (value.target !== null) {
    const target = value.target
    requireValid(isRecord(target) && target.schemaVersion === '0.2.1-rc.2'
      && Object.keys(target).every(key => ['profilePath', 'credentialsPath', 'layerPaths', 'schemaVersion'].includes(key))
      && [target.profilePath, target.credentialsPath, ...target.layerPaths ?? []].every(path =>
        typeof path === 'string' && path.length <= 4_096 && isAbsolute(path) && !/[\u0000-\u001f\u007f]/.test(path))
      && (target.layerPaths === undefined || Array.isArray(target.layerPaths) && target.layerPaths.length <= 16))
  }
  return { namespace: value.namespace, target: value.target,
    modelSettings: value.modelSettings === null ? null : validateDshModelSettings(value.modelSettings),
    capabilityApproval: value.capabilityApproval == null ? null : validateChatCapabilityCompositionApproval(value.capabilityApproval) }
}

function bindings(values: readonly NativeDeploymentPresetBinding[] | undefined) {
  if (values === undefined) return null
  requireValid(Array.isArray(values) && values.length <= 256)
  const projected = values.map(binding => {
    requireValid(isRecord(binding) && typeof binding.agentPreset === 'string' && binding.agentPreset.length > 0
      && binding.agentPreset.length <= 128 && isChatSessionDefinition(binding.definition)
      && (binding.externalProvider === undefined || typeof binding.externalProvider === 'string')
      && (binding.conversationKind === undefined || binding.conversationKind === 'group' || binding.conversationKind === 'private'))
    return { agentPreset: binding.agentPreset, definition: binding.definition,
      externalProvider: binding.externalProvider ?? null, conversationKind: binding.conversationKind ?? null }
  })
  const keys = projected.map(binding => `${binding.conversationKind}:${binding.agentPreset}`)
  requireValid(new Set(keys).size === keys.length)
  return projected.sort((left, right) => canonical(left).localeCompare(canonical(right)))
}

function dependencies(configuration: NativeChatConfiguration, deployed: readonly NativeDeploymentPresetBinding[] | undefined) {
  requireValid(isNativeConfigurationRevisions(configuration.revisions))
  const catalog = validateChatPlanCatalog(configuration.catalog)
  const personas = validateChatPersonas(configuration.personas)
  const providers = validateModelProviders(configuration.providers)
  const plan = catalog.plans.find(candidate => candidate.id === catalog.activePlanId)
  const persona = personas.find(candidate => candidate.id === plan?.personaId)
  const provider = providers.find(candidate => candidate.id === plan?.provider)
  requireValid(plan !== undefined && persona !== undefined && provider?.enabled === true
    && provider.models.some(model => model.id === plan.model))
  const inputAccess = configuration.access as NativeChatConfiguration['access'] & { readonly schema?: unknown }
  const access = validateNativeChatAccess(inputAccess, { maximumDigits: 32, allowOverlap: true,
    storedSchema: Object.hasOwn(inputAccess, 'schema') })
  const adapters = validateAdapterConfiguration(configuration.adapters)
  const enabledAdapter = (adapter: { readonly enabled: boolean }) => adapter.enabled ? adapter : { enabled: false }
  return {
    definition: buildChatSessionDefinition(plan, persona),
    'persona-name': persona.name,
    provider: { id: provider.id, api: modelProviderApi(provider), baseUrl: provider.baseUrl,
      enabled: provider.enabled, apiKey: provider.apiKey, model: plan.model },
    adapters: { onebotHttp: enabledAdapter(adapters.onebotHttp), onebotWs: enabledAdapter(adapters.onebotWs),
      onebotWebhook: enabledAdapter(adapters.onebotWebhook), dshAgent: enabledAdapter(adapters.dshAgent) },
    deployment: deployment(configuration), bindings: bindings(deployed), owner: access.owner,
    access: { allow: [...access.allow].sort(), deny: [...access.deny].sort() },
    authorization: validateNativeChatAuthorization(configuration.authorization),
    execution: validateNativeExecutionPolicy(configuration.execution)
  }
}

/** Pure dependency comparison. No configuration values or credentials are exposed by the result. */
export function analyzeNativeConfigurationImpact(previous: NativeChatConfiguration, next: NativeChatConfiguration,
  options: NativeConfigurationImpactOptions = {}): NativeConfigurationImpact {
  const bindingsCompared = options.previousBindings !== undefined && options.nextBindings !== undefined
  const unavailable = (): NativeConfigurationImpact => ({ schema: 1, state: 'unavailable', action: 'restart', canContinue: false,
    sessionMigrationRequired: false, immediatePolicyCheck: true, changedDependencies: [], changedRevisions: [],
    ignoredCatalogRevisions: [], withdrawnConversations: [], bindingsCompared, fingerprints: { previous: null, next: null },
    reasons: ['configuration_dependencies_unavailable'] })
  try {
    if ((options.previousBindings === undefined) !== (options.nextBindings === undefined)) return unavailable()
    const before = dependencies(previous, options.previousBindings)
    const after = dependencies(next, options.nextBindings)
    const changedDependencies = (Object.keys(before) as NativeConfigurationDependency[])
      .filter(key => fingerprint(before[key]) !== fingerprint(after[key]))
    const changedRevisions = NATIVE_CONFIGURATION_REVISION_KEYS.filter(key => previous.revisions[key] !== next.revisions[key])
    const sessionMigrationRequired = changedDependencies.includes('definition')
    const restart = changedDependencies.some(key => !['definition', 'access'].includes(key))
    const action = restart ? 'restart' : sessionMigrationRequired ? 'migrate' : 'none'
    const beforeAllowed = new Set(before.access.allow.filter(scope => !before.access.deny.includes(scope)))
    const afterAllowed = new Set(after.access.allow.filter(scope => !after.access.deny.includes(scope)))
    const withdrawn = new Set([...beforeAllowed].filter(scope => !afterAllowed.has(scope)))
    if (changedDependencies.includes('authorization')) {
      for (const grant of before.authorization.grants) {
        const current = after.authorization.grants.find(candidate => candidate.conversationId === grant.conversationId)
        if (!current || current.submitUses < grant.submitUses || current.sendUses < grant.sendUses
          || (current.toolDelegationUses ?? 0) < (grant.toolDelegationUses ?? 0)
          || current.expiresAt !== null && (grant.expiresAt === null || current.expiresAt < grant.expiresAt)) withdrawn.add(grant.conversationId)
      }
    }
    const catalogs: readonly NativeConfigurationRevisionKey[] = ['plans', 'personas', 'providers']
    return { schema: 1, state: 'verified', action, canContinue: action === 'none', sessionMigrationRequired,
      immediatePolicyCheck: changedDependencies.some(key => ['access', 'owner', 'authorization'].includes(key)),
      changedDependencies, changedRevisions,
      ignoredCatalogRevisions: action === 'none' ? changedRevisions.filter(key => catalogs.includes(key)) : [],
      withdrawnConversations: [...withdrawn].sort(), bindingsCompared,
      fingerprints: { previous: fingerprint(before), next: fingerprint(after) },
      reasons: changedDependencies.map(key => `configuration_dependency_changed:${key}`) }
  } catch { return unavailable() }
}
