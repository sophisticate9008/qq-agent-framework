import { recommendChatCapacity, type ChatCapacityRecommendation } from '../contracts/chat-capacity.ts'
import { constants } from 'node:fs'
import { isUtf8 } from 'node:buffer'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { composeStaticDshLayers, readStaticDshProfileValues } from '../adapters/dsh-static-profile.ts'
import { parseDshInputModalities, validateDshModelSettings, type DshDeploymentModelSettings } from '../contracts/dsh-model-settings.ts'
import { FrameworkError, isRecord, snapshot } from '../core/values.ts'
import type { NativeChatConfiguration } from './native-chat-configuration.ts'
import { modelProviderApi } from './model-provider-protocols.ts'
import type { NativeModelProvider } from './model-providers.ts'
import { createProviderModelCapabilityCache } from './provider-model-capability-cache.ts'

type DeploymentTarget = NonNullable<NativeChatConfiguration['deployment']['target']>
export interface LocalDshModelSettings {
  readonly modelSettings: DshDeploymentModelSettings
  readonly source: 'profile' | 'saved' | 'cache' | 'provider'
  readonly profilePath: string | null
}

export interface LocalDshModelCapabilities {
  readonly cache?: { readonly source: 'dsh' | 'provider' | 'manual'; readonly updatedAt: number }
  readonly cacheRevision?: string
  readonly modelSettings?: DshDeploymentModelSettings
  readonly capacity?: ChatCapacityRecommendation | null
  readonly provider: string
  readonly model: string
  readonly state: 'available' | 'unavailable'
  readonly reasoningEfforts: readonly ('off' | 'low' | 'medium' | 'high' | 'max')[]
  readonly missingReasons: readonly string[]
}

const publicReasoningEfforts = ['off', 'low', 'medium', 'high', 'max'] as const
const dshReasoningEfforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function missing(): never {
  throw new FrameworkError('LOCAL_DSH_MODEL_SETTINGS_MISSING', '未找到同一服务、同一模型的完整容量设置，请先保存模型设置。')
}
function reasoningMissing(): never {
  throw new FrameworkError('LOCAL_DSH_MODEL_REASONING_UNAVAILABLE', '已找到模型容量，但未找到适用于当前协议和思考等级的映射。')
}
function canonicalBase(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4_096 || /[\u0000-\u0020\u007f]/.test(value)) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    return url.href.replace(/\/+$/, '')
  } catch { return null }
}

async function readProfile(filename: string, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  if (filename.length > 4_096 || !isAbsolute(filename) || resolve(filename) !== filename
    || /[\u0000-\u001f\u007f]/.test(filename) || await realpath(dirname(filename)) !== dirname(filename)) missing()
  const parent = await lstat(dirname(filename))
  if (!parent.isDirectory() || (parent.mode & 0o022) !== 0) missing()
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > 1_048_576 || (before.mode & 0o022) !== 0
      || typeof process.getuid === 'function' && before.uid !== process.getuid()) missing()
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      signal?.throwIfAborted()
      const result = await handle.read(bytes, length, bytes.length - length, null)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    const after = await handle.stat()
    const current = await lstat(filename)
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
      || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) missing()
    const content = bytes.subarray(0, length)
    if (!isUtf8(content)) missing()
    const value = readStaticDshProfileValues(content.toString('utf8') || '[]\n')
    signal?.throwIfAborted()
    return value
  } finally { await handle.close() }
}

function compose(layers: readonly unknown[]): readonly Record<string, unknown>[] {
  try { return composeStaticDshLayers(layers) }
  catch { return missing() }
}

function selectReasoningCandidates<T extends { readonly api: unknown }>(candidates: readonly T[], api: string): readonly T[] {
  const matching = candidates.filter(candidate => candidate.api === api)
  return matching.length > 0 ? matching : candidates
}

/** Prefer the saved provider's original declaration over historical generated routes at the same endpoint. */
function modelProviderRoutes(routes: Record<string, unknown>, provider: NativeModelProvider, model: string): readonly [string, unknown][] {
  const named = routes[provider.id]
  if (isRecord(named) && canonicalBase(named.baseURL) === canonicalBase(provider.baseUrl)
    && named.api === modelProviderApi(provider) && Array.isArray(named.models)
    && named.models.some(entry => isRecord(entry) && entry.id === model)) return [[provider.id, named]]
  return Object.entries(routes)
}

/** Generated conversation caps are deployment limits, not new observations of the model's capacity. */
function managedConversationRoutes(entries: readonly Record<string, unknown>[]): ReadonlySet<string> {
  const routes = new Set<string>()
  for (const entry of entries) {
    if (entry.name !== '@deepseek-ai/dsh-agent-preset' || typeof entry.id !== 'string' || !isRecord(entry.config)) continue
    const match = /^([a-z0-9][a-z0-9_-]{0,15})-preset-([a-f0-9]{24})-(group|private)$/.exec(entry.id)
    if (!match) continue
    const route = `${match[1]}-${match[2]}-${match[3]}`
    if (entry.config.id === route && entry.config.name === `Native chat (${match[3]})`) routes.add(route)
  }
  return routes
}

export async function readLocalDshModelCapabilities(provider: NativeModelProvider, modelId: string,
  target: DeploymentTarget, signal?: AbortSignal): Promise<LocalDshModelCapabilities> {
  const unavailable = (reason: string): LocalDshModelCapabilities => snapshot({ provider: provider.id, model: modelId,
    state: 'unavailable', reasoningEfforts: [], missingReasons: [reason] })
  signal?.throwIfAborted()
  if (!provider.enabled) return unavailable('model_provider_unavailable')
  if (!provider.models.some(model => model.id === modelId)) return unavailable('model_not_configured')
  try {
    if (target.schemaVersion !== '0.2.1-rc.2' || basename(target.profilePath) !== 'cordis.patch.yml'
      || (target.layerPaths?.length ?? 0) > 16) return unavailable('local_dsh_metadata_unavailable')
    const paths = [...target.layerPaths ?? [], target.profilePath]
    if (new Set(paths).size !== paths.length) return unavailable('local_dsh_metadata_unavailable')
    const layers: unknown[] = []
    for (const filename of paths) layers.push(await readProfile(filename, signal))
    const composed = compose(layers)
    const generatedRoutes = managedConversationRoutes(composed)
    const entries = composed.filter(entry => entry.name === '@deepseek-ai/dsh-llm-pi-ai'
      && (entry.disabled === undefined || entry.disabled === false))
    if (entries.length !== 1 || !isRecord(entries[0]!.config) || !isRecord(entries[0]!.config.providers)) {
      return unavailable('local_dsh_metadata_unavailable')
    }
    const base = canonicalBase(provider.baseUrl)
    if (base === null) return unavailable('model_metadata_not_observed')
    const candidates: { api: unknown; reasoningEfforts: unknown; contextWindow: unknown; maxTokens: unknown }[] = []
    for (const [routeId, route] of modelProviderRoutes(entries[0]!.config.providers, provider, modelId)) {
      if (generatedRoutes.has(routeId)) continue
      if (!isRecord(route) || canonicalBase(route.baseURL) !== base || !Array.isArray(route.models)) continue
      for (const model of route.models) {
        if (!isRecord(model) || model.id !== modelId) continue
        let selected = model
        if (route.modelOverrides !== undefined) {
          if (!isRecord(route.modelOverrides)) return unavailable('model_reasoning_metadata_invalid')
          const override = route.modelOverrides[modelId]
          if (override !== undefined) {
            if (!isRecord(override) || Object.hasOwn(override, 'id')) return unavailable('model_reasoning_metadata_invalid')
            selected = { ...model, ...override }
          }
        }
        candidates.push({ api: route.api, reasoningEfforts: selected.reasoningEfforts, contextWindow: selected.contextWindow ?? route.defaultContextWindow, maxTokens: selected.maxTokens ?? route.defaultMaxTokens })
      }
    }
    if (candidates.length === 0) return unavailable('model_metadata_not_observed')
    const reasoningCandidates = selectReasoningCandidates(candidates, modelProviderApi(provider))
    if (reasoningCandidates.some(candidate => !isRecord(candidate) || !isRecord(reasoningCandidates[0]) || !isDeepStrictEqual(candidate.reasoningEfforts, reasoningCandidates[0].reasoningEfforts))) return unavailable('model_metadata_conflict')
    const candidate = reasoningCandidates[0]
    if (!isRecord(candidate)) return unavailable('model_metadata_invalid')
    const declared = candidate.reasoningEfforts
    const capacity = candidates.every(item => isRecord(item) && item.contextWindow === candidate.contextWindow && item.maxTokens === candidate.maxTokens) ? recommendChatCapacity(candidate) : null
    if (declared === false) return snapshot({ provider: provider.id, model: modelId, state: 'available' as const,
      reasoningEfforts: ['off'] as const, missingReasons: [], ...(capacity ? { capacity } : {}) })
    if (declared === undefined) return unavailable('model_reasoning_metadata_unknown')
    if (!isRecord(declared) || Object.keys(declared).length === 0
      || Object.entries(declared).some(([level, wire]) => !(dshReasoningEfforts as readonly string[]).includes(level)
        || !(typeof wire === 'string' && wire.length > 0 || level === 'off' && wire === null))
      || !Object.keys(declared).some(level => level !== 'off')) return unavailable('model_reasoning_metadata_invalid')
    const reasoningEfforts = publicReasoningEfforts.filter(level => Object.hasOwn(declared, level))
    if (reasoningEfforts.length === 0) return unavailable('model_reasoning_metadata_unknown')
    return snapshot({ provider: provider.id, model: modelId, state: 'available' as const, reasoningEfforts, missingReasons: [], ...(capacity ? { capacity } : {}) })
  } catch {
    signal?.throwIfAborted()
    return unavailable('local_dsh_metadata_unavailable')
  }
}

export async function readLocalDshModelMetadata(provider: NativeModelProvider, modelId: string, target: DeploymentTarget,
  signal?: AbortSignal): Promise<DshDeploymentModelSettings | null> {
  signal?.throwIfAborted()
  if (!provider.enabled || !provider.models.some(value => value.id === modelId)) return null
  try {
    if (target.schemaVersion !== '0.2.1-rc.2' || basename(target.profilePath) !== 'cordis.patch.yml'
      || (target.layerPaths?.length ?? 0) > 16) missing()
    const paths = [...target.layerPaths ?? [], target.profilePath]
    if (new Set(paths).size !== paths.length) missing()
    const layers: unknown[] = []
    for (const filename of paths) layers.push(await readProfile(filename, signal))
    const composed = compose(layers)
    const generatedRoutes = managedConversationRoutes(composed)
    const entries = composed.filter(entry => entry.name === '@deepseek-ai/dsh-llm-pi-ai' && entry.disabled !== true)
    if (entries.length !== 1 || !isRecord(entries[0]!.config) || !isRecord(entries[0]!.config.providers)) missing()
    const base = canonicalBase(provider.baseUrl)
    if (base === null) missing()
    const candidates: { api: unknown; settings: DshDeploymentModelSettings; reasoning: unknown }[] = []
    for (const [routeId, route] of modelProviderRoutes(entries[0]!.config.providers, provider, modelId)) {
      if (generatedRoutes.has(routeId)) continue
      if (!isRecord(route) || canonicalBase(route.baseURL) !== base || !Array.isArray(route.models)) continue
      for (const model of route.models) {
        if (!isRecord(model) || model.id !== modelId) continue
        let selected = model
        if (route.modelOverrides !== undefined) {
          if (!isRecord(route.modelOverrides)) missing()
          const override = route.modelOverrides[modelId]
          if (override !== undefined) {
            if (!isRecord(override) || Object.hasOwn(override, 'id')) missing()
            selected = { ...model, ...override }
          }
        }
        const inputModalities = selected.input === undefined ? undefined : parseDshInputModalities(selected.input)
        if (inputModalities === null) throw new FrameworkError('LOCAL_DSH_MODEL_INPUT_UNAVAILABLE', 'The selected model input metadata is not supported.')
        const settings = validateDshModelSettings({ ...(inputModalities === undefined ? {} : { inputModalities }), contextWindow: selected.contextWindow ?? route.defaultContextWindow,
          maxTokens: selected.maxTokens ?? route.defaultMaxTokens, reasoningEfforts: false })
        candidates.push({ api: route.api, settings, reasoning: selected.reasoningEfforts })
      }
    }
    if (candidates.length === 0 || candidates.some(candidate => candidate.settings.contextWindow !== candidates[0]!.settings.contextWindow
      || candidate.settings.maxTokens !== candidates[0]!.settings.maxTokens)) missing()
    const reasoningCandidates = selectReasoningCandidates(candidates, modelProviderApi(provider))
    if (reasoningCandidates.some(candidate => !isDeepStrictEqual(candidate.settings.inputModalities ?? ['text'], reasoningCandidates[0]!.settings.inputModalities ?? ['text'])))
      throw new FrameworkError('LOCAL_DSH_MODEL_INPUT_UNAVAILABLE', 'The selected model input metadata is ambiguous.')
    if (reasoningCandidates.some(candidate => !isDeepStrictEqual(candidate.reasoning, reasoningCandidates[0]!.reasoning))) reasoningMissing()
    const resolved: DshDeploymentModelSettings[] = []
    for (const candidate of reasoningCandidates) {
      try {
        const settings = validateDshModelSettings({ ...candidate.settings, reasoningEfforts: candidate.reasoning })
        resolved.push(settings)
      } catch {}
    }
    if (resolved.length === 0) {
      if (reasoningCandidates.some(candidate => isRecord(candidate.reasoning)
        && Object.values(candidate.reasoning).some(value => typeof value === 'number' || isRecord(value)))) {
        throw new FrameworkError('LOCAL_DSH_REASONING_MAPPING_UNSUPPORTED', '已找到模型容量，但数字或对象形式的思考映射暂不支持自动准备。')
      }
      reasoningMissing()
    }
    if (resolved.some(settings => !isDeepStrictEqual(settings, resolved[0]))) reasoningMissing()
    return snapshot(resolved[0]!)
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof FrameworkError && error.code === 'LOCAL_DSH_MODEL_INPUT_UNAVAILABLE') throw error
    if (error instanceof FrameworkError) throw error
    missing()
  }
}

/** Expose model controls and editable metadata without provider credentials. */
export function modelSettingsCapabilities(provider: string, model: string, settings: DshDeploymentModelSettings,
  cache?: LocalDshModelCapabilities['cache']): LocalDshModelCapabilities {
  const validated = validateDshModelSettings(settings)
  const declared = validated.reasoningEfforts
  return snapshot({ provider, model, state: 'available',
    reasoningEfforts: declared === false ? ['off']
      : publicReasoningEfforts.filter(level => Object.hasOwn(declared, level)),
    missingReasons: [], capacity: recommendChatCapacity(validated)!, modelSettings: validated, ...(cache ? { cache } : {}) })
}

export async function resolveLocalDshModelSettings(configuration: NativeChatConfiguration, target: DeploymentTarget,
  signal?: AbortSignal, directory?: string): Promise<LocalDshModelSettings> {
  signal?.throwIfAborted()
  const plan = configuration.catalog.plans.find(value => value.id === configuration.catalog.activePlanId)
  const provider = configuration.providers.find(value => value.id === plan?.provider)
  if (!plan || !provider?.enabled || !provider.models.some(value => value.id === plan.model)) missing()
  if (directory !== undefined) {
    const cached = await createProviderModelCapabilityCache(directory).resolve({ provider, model: plan.model,
      providersRevision: configuration.revisions.providers, signal,
      loadDsh: () => readLocalDshModelMetadata(provider, plan.model, target, signal) })
    if (!cached) missing()
    return snapshot({ modelSettings: cached.modelSettings, source: 'cache' as const, profilePath: null })
  }
  const modelSettings = await readLocalDshModelMetadata(provider, plan.model, target, signal)
  if (!modelSettings) missing()
  return snapshot({ modelSettings, source: 'profile' as const, profilePath: target.profilePath })
}
