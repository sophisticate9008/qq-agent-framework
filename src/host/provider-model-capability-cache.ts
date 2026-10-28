import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { validateDshModelSettings, type DshDeploymentModelSettings } from '../contracts/dsh-model-settings.ts'
import { FrameworkError, assert, isRecord, reference, snapshot } from '../core/values.ts'
import { acquireDirectoryLock, ensurePrivateDirectory, readDocument, readPrivateJson, replacePrivateJson } from '../storage/private-json.ts'
import { digest } from './data.ts'
import { modelProviderApi } from './model-provider-protocols.ts'
import { validateModelProviders, type NativeModelProvider } from './model-providers.ts'
import { readProviderModelMetadata } from './provider-model-metadata.ts'

export interface ProviderModelCapabilityCacheEntry {
  readonly key: string
  readonly provider: string
  readonly model: string
  readonly source: 'dsh' | 'provider'
  readonly updatedAt: number
  readonly modelSettings: DshDeploymentModelSettings
}
interface CacheDocument {
  readonly schema: 1
  readonly epoch: string
  readonly versions: Readonly<Record<string, string>>
  readonly entries: readonly ProviderModelCapabilityCacheEntry[]
}
const fallback: CacheDocument = { schema: 1, epoch: 'initial', versions: {}, entries: [] }
const maximumBytes = 1_048_576
const maximumEntries = 512
const writes = new Map<string, Promise<void>>()

async function withCacheLock<Result>(directory: string, operation: () => Promise<Result>): Promise<Result> {
  const previous = writes.get(directory) ?? Promise.resolve()
  let complete: () => void = () => {}
  const held = new Promise<void>(resolve => { complete = resolve })
  const tail = previous.catch(() => {}).then(() => held)
  writes.set(directory, tail)
  await previous.catch(() => {})
  try {
    const release = await acquireDirectoryLock(directory, '.provider-model-capabilities.lock')
    try { return await operation() } finally { await release() }
  } finally {
    complete()
    if (writes.get(directory) === tail) writes.delete(directory)
  }
}

function fail(code: string): never { throw new FrameworkError(code, 'The saved provider model metadata could not be updated.') }
export function canonicalModelProviderBase(value: string): string {
  const url = new URL(value)
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    'MODEL_CAPABILITY_PROVIDER_INVALID', 'Expected a saved provider endpoint.')
  return url.href.replace(/\/+$/, '')
}
export function providerModelCapabilityKey(provider: NativeModelProvider, model: string): string {
  return digest([provider.id, canonicalModelProviderBase(provider.baseUrl), modelProviderApi(provider), model, digest(provider.apiKey)])
}
function validate(input: unknown): CacheDocument {
  if (!isRecord(input) || input.schema !== 1 || Object.keys(input).length !== 4
    || typeof input.epoch !== 'string' || input.epoch.length > 64 || !Array.isArray(input.entries)
    || input.entries.length > maximumEntries || !isRecord(input.versions) || Object.keys(input.versions).length > 1024
    || Object.entries(input.versions).some(([key, version]) => !/^[a-f0-9]{64}$/.test(key)
      || typeof version !== 'string' || !/^[a-f0-9-]{36}$/.test(version))) fail('MODEL_CAPABILITY_CACHE_INVALID')
  const keys = new Set<string>()
  const entries = input.entries.map((entry: unknown): ProviderModelCapabilityCacheEntry => {
    if (!isRecord(entry) || Object.keys(entry).length !== 6 || typeof entry.key !== 'string' || !/^[a-f0-9]{64}$/.test(entry.key)
      || !reference(entry.provider) || !reference(entry.model) || !['dsh', 'provider'].includes(String(entry.source))
      || typeof entry.updatedAt !== 'number' || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0
      || keys.has(entry.key)) fail('MODEL_CAPABILITY_CACHE_INVALID')
    keys.add(entry.key)
    return { key: entry.key, provider: entry.provider, model: entry.model, source: entry.source as 'dsh' | 'provider',
      updatedAt: entry.updatedAt, modelSettings: validateDshModelSettings(entry.modelSettings) }
  })
  return snapshot({ schema: 1, epoch: input.epoch, versions: input.versions as Readonly<Record<string, string>>, entries })
}
function providers(input: unknown) {
  if (!isRecord(input) || input.schema !== 1 || Object.keys(input).length !== 2) fail('MODEL_CAPABILITY_PROVIDER_INVALID')
  return { schema: 1 as const, providers: validateModelProviders(input.providers) }
}

export function createProviderModelCapabilityCache(directory: string) {
  const filename = join(directory, 'provider-model-capabilities.json')
  const read = () => readPrivateJson(filename, { maxBytes: maximumBytes, validate, fallback: { value: fallback },
    exactMode: 0o600, requireSingleLink: true, invalidCode: 'model_capability_cache_invalid', conflictCode: 'model_capability_cache_conflict' })
  async function mutate(provider: NativeModelProvider, model: string, expectedProvidersRevision: string,
    expectedCache: CacheDocument, next: ProviderModelCapabilityCacheEntry | null, signal?: AbortSignal) {
    await ensurePrivateDirectory(directory)
    return withCacheLock(directory, async () => {
      signal?.throwIfAborted()
      const configuration = await readDocument(join(directory, 'chat-providers.json'), { schema: 1 as const, providers: [] }, providers)
      const current = configuration.value.providers.find(entry => entry.id === provider.id)
      const key = providerModelCapabilityKey(provider, model)
      if (configuration.revision !== expectedProvidersRevision || !current || next !== null && !current.enabled
        || !current.models.some(entry => entry.id === model)
        || providerModelCapabilityKey(current, model) !== key) fail('MODEL_CAPABILITY_CONFIGURATION_CHANGED')
      const document = await read()
      if (document.value.epoch !== expectedCache.epoch
        || document.value.versions[key] !== expectedCache.versions[key]) fail('MODEL_CAPABILITY_CACHE_CONFLICT')
      const entries = document.value.entries.filter(entry => entry.key !== key)
      if (next) entries.push(next)
      entries.sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key))
      let versions = { ...document.value.versions, [key]: randomUUID() }
      let epoch = document.value.epoch
      if (Object.keys(versions).length > 1024) {
        // Compact old clear receipts only while invalidating all older in-flight observations.
        epoch = randomUUID()
        const keep = new Set([...entries.slice(0, maximumEntries).map(entry => entry.key), key])
        versions = Object.fromEntries(Object.entries(versions).filter(([entry]) => keep.has(entry)))
      }
      const value = validate({ schema: 1, epoch, versions, entries: entries.slice(0, maximumEntries) })
      const content = Buffer.from(JSON.stringify(value) + '\n')
      if (content.byteLength > maximumBytes) fail('MODEL_CAPABILITY_CACHE_FULL')
      await replacePrivateJson({ directory, filename, expectedRevision: document.revision, content,
        temporary: join(directory, `.model-capability-${randomUUID()}.tmp`), read,
        verifyTemporaryMetadata: true, directoryOpenFlags: constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        beforeRevisionCheck: async () => {
          signal?.throwIfAborted()
          const latest = await readDocument(join(directory, 'chat-providers.json'), { schema: 1 as const, providers: [] }, providers)
          if (latest.revision !== expectedProvidersRevision) fail('MODEL_CAPABILITY_CONFIGURATION_CHANGED')
        }, conflictCode: 'model_capability_cache_conflict', writeFailedCode: 'model_capability_cache_write_failed',
        writeUnknownCode: 'model_capability_cache_write_unknown' })
    })
  }
  return Object.freeze({
    read,
    find(document: Awaited<ReturnType<typeof read>>, provider: NativeModelProvider, model: string) {
      const key = providerModelCapabilityKey(provider, model)
      return document.value.entries.find(entry => entry.key === key && entry.provider === provider.id && entry.model === model) ?? null
    },
    async clear(provider: NativeModelProvider, model: string, providersRevision: string, signal?: AbortSignal) {
      const document = await read()
      await mutate(provider, model, providersRevision, document.value, null, signal)
    },
    async resolve(options: { provider: NativeModelProvider; model: string; providersRevision: string; signal?: AbortSignal;
      refresh?: boolean; loadDsh?: () => Promise<DshDeploymentModelSettings | null> }): Promise<ProviderModelCapabilityCacheEntry | null> {
      const { provider, model, providersRevision, signal } = options
      signal?.throwIfAborted()
      const document = await read()
      const cached = document.value.entries.find(entry => entry.key === providerModelCapabilityKey(provider, model))
      if (cached && !options.refresh) return cached
      let modelSettings: DshDeploymentModelSettings | null = null
      let source: 'dsh' | 'provider' = 'dsh'
      if (options.loadDsh) {
        try { modelSettings = await options.loadDsh() }
        catch { signal?.throwIfAborted() }
      }
      if (modelSettings === null) {
        source = 'provider'
        modelSettings = await readProviderModelMetadata(provider, model, signal)
      }
      signal?.throwIfAborted()
      if (modelSettings === null) return null
      const entry = { key: providerModelCapabilityKey(provider, model), provider: provider.id, model, source,
        updatedAt: Date.now(), modelSettings: validateDshModelSettings(modelSettings) }
      await mutate(provider, model, providersRevision, document.value, entry, signal)
      return snapshot(entry)
    },
  })
}
