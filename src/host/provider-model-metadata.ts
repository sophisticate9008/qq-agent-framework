import { validateDshModelSettings, type DshDeploymentModelSettings } from '../contracts/dsh-model-settings.ts'
import { isRecord } from '../core/values.ts'
import { modelProviderApi } from './model-provider-protocols.ts'
import type { NativeModelProvider } from './model-providers.ts'

const maximumBytes = 1_048_576
const supportedEfforts = ['off', 'low', 'medium', 'high', 'max'] as const

/** Read declared metadata only. A model ID by itself does not establish capabilities. */
function parseMetadata(model: Record<string, unknown>, officialDeepSeek: boolean): DshDeploymentModelSettings | null {
  let reasoning: unknown = model.reasoningEfforts
  if (reasoning === undefined && isRecord(model.effort)) {
    const levels = model.effort.supported_levels
    if (!Array.isArray(levels) || levels.length === 0 || levels.length > 16
      || new Set(levels).size !== levels.length
      || levels.includes('none') && levels.includes('off')
      || levels.some(level => typeof level !== 'string' || !['none', ...supportedEfforts].includes(level))) return null
    // The official OpenAI-compatible endpoint documents `none` as the thinking-off wire value.
    // Other endpoints must explicitly declare it; never infer it from their model name.
    reasoning = Object.fromEntries([
      ...(officialDeepSeek && !levels.includes('none') && !levels.includes('off') ? [['off', 'none']] : []),
      ...levels.map(level => [level === 'none' ? 'off' : level, level]),
    ])
  }
  if (reasoning === undefined) return null
  const input = model.input_modalities ?? model.input
  try {
    return validateDshModelSettings({
      contextWindow: model.context_window ?? model.contextWindow,
      maxTokens: model.max_output_tokens ?? model.maxTokens,
      reasoningEfforts: reasoning,
      ...(input === undefined ? {} : { inputModalities: input }),
    })
  } catch { return null }
}

/** Fetch the selected, saved provider's model catalog without inference or redirects. */
export async function readProviderModelMetadata(provider: NativeModelProvider, modelId: string,
  signal?: AbortSignal): Promise<DshDeploymentModelSettings | null> {
  signal?.throwIfAborted()
  if (!provider.enabled || !provider.models.some(model => model.id === modelId)
    || !['openai-completions', 'openai-responses'].includes(modelProviderApi(provider))) return null
  const deadline = AbortSignal.timeout(8_000)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  try {
    const url = new URL(provider.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    const officialDeepSeek = url.origin === 'https://api.deepseek.com' && /^\/(?:v1\/?)?$/.test(url.pathname)
    url.pathname = url.pathname.replace(/\/+$/, '') + '/models'
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: combined,
      headers: { accept: 'application/json', ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) } })
    if (!response.ok || Number(response.headers.get('content-length')) > maximumBytes) {
      await response.body?.cancel()
      return null
    }
    const reader = response.body?.getReader()
    if (!reader) return null
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        combined.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > maximumBytes) return null
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    if (!isRecord(body) || !Array.isArray(body.data) || body.data.length > 4_096) return null
    const matches = body.data.filter((model): model is Record<string, unknown> => isRecord(model) && model.id === modelId)
    if (matches.length !== 1) return null
    return parseMetadata(matches[0]!, officialDeepSeek)
  } catch {
    signal?.throwIfAborted()
    return null
  }
}
