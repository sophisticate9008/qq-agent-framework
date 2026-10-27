export interface WorkProgress {
  readonly id: string
  readonly at: number
  readonly text: string
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }

export function validWorkProgress(value: unknown): value is readonly WorkProgress[] {
  if (!Array.isArray(value) || value.length > 8) return false
  let length = 0
  const ids = new Set<string>()
  return value.every(input => {
    const row = object(input)
    if (!row || Object.keys(row).sort().join(',') !== 'at,id,text'
      || typeof row.id !== 'string' || !/^assistant\/message:seq:\d{1,16}$/.test(row.id) || ids.has(row.id)
      || !count(row.at) || typeof row.text !== 'string' || !row.text.trim()) return false
    ids.add(row.id)
    length += row.text.length
    return length <= 8000
  })
}

/** Read settled assistant text only. Streams, reasoning and tool output are never display text. */
export function readWorkProgress(events: readonly unknown[]): readonly WorkProgress[] {
  const lastMessages = new Map<number, number>()
  const lastSteps = new Map<number, number>()
  const ended = new Set<number>()
  for (let index = 0; index < events.length; index++) {
    const event = object(events[index]); const data = object(event?.data)
    if (!count(data?.turn)) continue
    if (event?.type === 'assistant/message') lastMessages.set(data.turn, index)
    if (event?.type === 'step/start') lastSteps.set(data.turn, index)
    if (event?.type === 'turn/end' || event?.type === 'turn/error') ended.add(data.turn)
  }
  const result: WorkProgress[] = []
  const ids = new Set<string>()
  let remaining = 8000
  for (let index = events.length - 1; index >= 0 && result.length < 8 && remaining > 0; index--) {
    const event = object(events[index]); const data = object(event?.data)
    const message = object(data?.message); const source = object(message?.source)
    if (event?.type !== 'assistant/message' || !count(event.seq) || !count(event.time) || !count(data?.turn)
      || data.interrupted === true || data.visibility !== undefined || data.channel !== undefined
      || message?.role !== 'assistant' || message.visibility !== undefined || message.channel !== undefined
      || source?.kind !== 'model' || !Array.isArray(message.content)) continue
    // A text-only last response is final output. Tool calls or a later step prove continuation.
    if (ended.has(data.turn) && lastMessages.get(data.turn) === index) continue
    if (!message.content.some(block => object(block)?.type === 'tool-call')
      && (lastMessages.get(data.turn) ?? index) <= index && (lastSteps.get(data.turn) ?? index) <= index) continue
    const id = `assistant/message:seq:${event.seq}`
    if (ids.has(id)) continue
    let text = ''
    for (const input of message.content) {
      const block = object(input)
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      const separator = text ? '\n' : ''
      text += separator + block.text.slice(0, Math.max(0, remaining - text.length - separator.length))
      if (text.length >= remaining) break
    }
    // Keep UTF-16 truncation from splitting a Unicode surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
    if (!text.trim()) continue
    ids.add(id); remaining -= text.length
    result.push({ id, at: event.time, text })
  }
  return result.reverse()
}
