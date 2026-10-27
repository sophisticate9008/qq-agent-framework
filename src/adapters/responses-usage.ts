/** Compatibility for Responses gateways that expose Chat Completions usage names. */
import { randomUUID } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : {}
}

function count(...values: readonly unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number'
    && Number.isSafeInteger(value) && value >= 0)
}

function sum(left: number, right: number): number | undefined {
  const value = left + right
  return Number.isSafeInteger(value) ? value : undefined
}

const observedCounters = ['input_tokens', 'prompt_tokens', 'output_tokens', 'completion_tokens', 'total_tokens',
  'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'cached_tokens', 'cache_hit_tokens', 'cache_miss_tokens'] as const
const observedDetails = ['input_tokens_details', 'prompt_tokens_details', 'output_tokens_details', 'completion_tokens_details'] as const
let pendingObservation: { readonly filename: URL; readonly contents: string } | undefined
let observationWrite: Promise<void> | undefined

/** Only allowlisted usage counters reach disk; requests, content and credentials never do. */
function observeUsage(usage: Readonly<Record<string, unknown>>, parsed: ReturnType<typeof usageCounts>, filename: URL): void {
  const numericFields = (source: Readonly<Record<string, unknown>>, keys: readonly string[]) => Object.fromEntries(
    keys.flatMap(key => count(source[key]) === undefined ? [] : [[key, source[key]]]))
  const rawUsage = { ...numericFields(usage, observedCounters),
    ...Object.fromEntries(observedDetails.filter(key => Object.hasOwn(usage, key))
      .map(key => [key, numericFields(record(usage[key]), ['cached_tokens', 'cache_write_tokens', 'reasoning_tokens'])])) }
  pendingObservation = { filename, contents: JSON.stringify({ schema: 1, observedAt: new Date().toISOString(), rawUsage,
    cacheReadReported: parsed.qafCacheReadReported, cacheWriteReported: parsed.qafCacheWriteReported }) + '\n' }
  if (observationWrite) return
  observationWrite = (async () => {
    while (pendingObservation) {
      const next = pendingObservation
      pendingObservation = undefined
      const temporary = new URL(`${next.filename.href}.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, next.contents, { flag: 'wx', mode: 0o600 })
        await rename(temporary, next.filename)
      } catch { /* Diagnostics must never interrupt a model response. */ }
      finally { await unlink(temporary).catch(() => undefined) }
    }
  })().catch(() => undefined).finally(() => { observationWrite = undefined })
}

function usageCounts(usage: Readonly<Record<string, unknown>>) {
  const inputDetails = record(usage.input_tokens_details)
  const promptDetails = record(usage.prompt_tokens_details)
  const outputDetails = record(usage.output_tokens_details)
  const completionDetails = record(usage.completion_tokens_details)
  // Keep pi-ai's numeric counters while separately preserving explicit report presence.
  const explicitHit = count(inputDetails.cached_tokens, promptDetails.cached_tokens,
    usage.prompt_cache_hit_tokens, usage.cached_tokens, usage.cache_hit_tokens)
  const cacheRead = explicitHit ?? 0
  const explicitWrite = count(inputDetails.cache_write_tokens, promptDetails.cache_write_tokens)
  const cacheWrite = explicitWrite ?? 0
  const missed = count(usage.prompt_cache_miss_tokens, usage.cache_miss_tokens)
  const inputTotal = count(usage.input_tokens, usage.prompt_tokens)
    ?? (missed !== undefined && explicitHit !== undefined ? sum(missed, explicitHit) : undefined)
  const output = count(usage.output_tokens, usage.completion_tokens) ?? 0
  // Usage quirks must not interrupt an otherwise successful reply. Keep the SDK's
  // nonnegative-input behavior; downstream accounting can reject inconsistent totals.
  const input = inputTotal === undefined ? 0 : Math.max(0, inputTotal - cacheRead - cacheWrite)
  const derivedTotal = inputTotal === undefined ? undefined : sum(inputTotal, output)
  const cached = sum(cacheRead, cacheWrite)
  const totalTokens = count(usage.total_tokens) ?? derivedTotal
    ?? (cached === undefined ? undefined : sum(cached, output)) ?? 0
  return { input, output, cacheRead, cacheWrite,
    qafCacheReadReported: explicitHit !== undefined, qafCacheWriteReported: explicitWrite !== undefined,
    reasoning: count(outputDetails.reasoning_tokens, completionDetails.reasoning_tokens) ?? 0,
    totalTokens }
}

export function readResponsesUsage(value: unknown, observationFile?: URL) {
  const usage = record(value)
  const parsed = usageCounts(usage)
  if (observationFile) observeUsage(usage, parsed, observationFile)
  return parsed
}

/** Preserve Chat Completions' existing numeric mapping and attach only report presence. */
export function readCacheUsagePresence(value: unknown, observationFile?: URL) {
  const parsed = readResponsesUsage(value, observationFile)
  return { qafCacheReadReported: parsed.qafCacheReadReported, qafCacheWriteReported: parsed.qafCacheWriteReported }
}
