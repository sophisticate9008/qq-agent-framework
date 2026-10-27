export interface WorkUsageStep {
  readonly eventId: string
  readonly turn: string
  readonly step: number
  readonly at: number
  readonly provider: string
  readonly model: string
  readonly status: 'completed' | 'failed'
  readonly usage: Readonly<Partial<Record<'inputTokens' | 'outputTokens' | 'totalTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens', number>>>
}
const counts = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function turn(value: unknown): string | null { return text(value) ? value : count(value) ? String(value) : null }
export function validWorkUsage(value: unknown): value is readonly WorkUsageStep[] {
  return Array.isArray(value) && value.length <= 256 && Buffer.byteLength(JSON.stringify(value)) <= 131072 && value.every(input => {
    const row = object(input); const usage = object(row?.usage)
    return row !== null && Object.keys(row).sort().join(',') === 'at,eventId,model,provider,status,step,turn,usage'
      && [row.eventId, row.turn, row.provider, row.model].every(text) && count(row.step) && count(row.at)
      && (row.status === 'completed' || row.status === 'failed') && usage !== null
      && Object.keys(usage).every(key => counts.some(allowed => allowed === key)) && Object.values(usage).every(count)
  })
}

/** Select immutable terminal-turn token facts only; no prompt, model text or replay state crosses the wire. */
export function readWorkUsage(events: readonly unknown[]): readonly WorkUsageStep[] {
  const ended = new Map<string, 'completed' | 'failed'>()
  for (const input of events) {
    const event = object(input); const data = object(event?.data); const id = turn(data?.turn)
    if (id !== null && event?.type === 'turn/end') ended.set(id, object(data?.reason)?.kind === 'completed' ? 'completed' : 'failed')
    if (id !== null && event?.type === 'turn/error') ended.set(id, 'failed')
  }
  const result: WorkUsageStep[] = []
  for (const input of events) {
    const event = object(input); const data = object(event?.data); const id = turn(data?.turn)
    const source = object(object(data?.message)?.source); const usage = object(data?.usage)
    if (event?.type !== 'assistant/message' || id === null || !ended.has(id) || !count(event.seq) || !count(event.time)
      || !count(data?.step) || source?.kind !== 'model' || !text(source.provider) || !text(source.model) || !usage
      || !count(usage.inputTokens) || !count(usage.outputTokens)) continue
    const copied: Partial<Record<typeof counts[number], number>> = {}
    let valid = true
    for (const key of counts) if (usage[key] !== undefined) {
      if (!count(usage[key])) { valid = false; break }
      copied[key] = usage[key]
    }
    if (!valid) continue
    // Match the chat adapter: an omitted cache split cannot be counted as zero cache reads.
    if (copied.cacheReadTokens === undefined) delete copied.inputTokens
    if (copied.cacheReadTokens !== undefined && copied.totalTokens !== undefined && copied.inputTokens !== undefined
      && copied.totalTokens === copied.inputTokens + copied.outputTokens! + copied.cacheReadTokens + (copied.cacheWriteTokens ?? 0)) copied.cacheWriteTokens ??= 0
    const row: WorkUsageStep = { eventId: `assistant/message:seq:${event.seq}`, turn: id, step: data.step, at: event.time,
      provider: source.provider, model: source.model, status: ended.get(id)!, usage: copied }
    if (result.length >= 256 || Buffer.byteLength(JSON.stringify([...result, row])) > 131072) break
    result.push(row)
  }
  return result
}
