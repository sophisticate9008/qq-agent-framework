import type { MessageContent } from './messages.ts'

export interface NativeWorkBackendResult {
  readonly stopReason: string
  readonly output: readonly MessageContent[]
}

export interface NativeWorkResultDelivery extends NativeWorkBackendResult {
  readonly id: string
  readonly resultId: string
  readonly deliveryId: string
  readonly childId: string
  readonly parentSessionId: string
  readonly conversationId: string
  readonly generation: number
}

export interface NativeWorkView {
  readonly id: string
  readonly childId: string
  readonly parentSessionId: string
  readonly conversationId: string
  readonly generation: number
  readonly createdAt: number
  readonly deadlineAt: number
  readonly status: 'starting' | 'running' | 'completed' | 'failed' | 'unknown'
  readonly result: NativeWorkBackendResult | null
  readonly lateResult: NativeWorkBackendResult | null
  readonly delivery: 'not-requested' | 'delivering' | 'confirmed' | 'rejected' | 'unknown' | 'unavailable'
  readonly lastError: string | null
  readonly resultId: string | null
  readonly deliveryId: string | null
  readonly deliveryMessageId: string | null
  readonly deliveryError: string | null
  readonly deliveryFileId: string | null
}

export const NATIVE_WORK_PATH = '/api/chat/work'
export interface NativeWorkReadQuery {
  readonly conversationId?: string
  readonly limit?: number
  readonly after?: string
}
export interface NativeWorkListSnapshot {
  readonly schema: 1
  readonly records: readonly NativeWorkView[]
  readonly next: string | null
}
export interface NativeWorkDetailSnapshot {
  readonly schema: 1
  readonly record: NativeWorkView
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function ref(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value)
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function content(value: unknown, forward = true): value is MessageContent {
  if (!record(value)) return false
  switch (value.type) {
    case 'text': return exact(value, ['type', 'text']) && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 8000
    case 'image': case 'audio': case 'forward-reference': return exact(value, ['type', 'assetId']) && ref(value.assetId)
    case 'file': return exact(value, ['type', 'assetId', 'name']) && ref(value.assetId) && typeof value.name === 'string'
      && value.name.length > 0 && value.name.length <= 255 && !/[\x00-\x1f\x7f/\\]/.test(value.name)
    case 'mention': return exact(value, ['type', 'userId']) && ref(value.userId)
    case 'reply': return exact(value, ['type', 'messageId']) && ref(value.messageId)
    case 'forward': return forward && exact(value, ['type', 'nodes']) && Array.isArray(value.nodes)
      && value.nodes.length > 0 && value.nodes.length <= 32 && value.nodes.every(node => record(node)
        && exact(node, ['content']) && Array.isArray(node.content) && node.content.length > 0 && node.content.length <= 8
        && node.content.every(item => content(item, false)))
    default: return false
  }
}
export function parseNativeWorkBackendResult(input: unknown): NativeWorkBackendResult | null {
  if (!record(input) || !exact(input, ['stopReason', 'output']) || !ref(input.stopReason)
    || !Array.isArray(input.output) || input.output.length > 256 || !input.output.every(item => content(item))) return null
  if (new TextEncoder().encode(JSON.stringify(input.output)).length > 256 * 1024) return null
  return { stopReason: input.stopReason, output: input.output }
}

/** Accept only public execution evidence, never task prompts, credentials or authority. */
export function parseNativeWorkView(input: unknown): NativeWorkView | null {
  if (!record(input) || !exact(input, ['id', 'childId', 'parentSessionId', 'conversationId', 'generation', 'createdAt', 'deadlineAt',
    'status', 'result', 'lateResult', 'delivery', 'lastError', 'resultId', 'deliveryId', 'deliveryMessageId', 'deliveryError', 'deliveryFileId'])
    || !ref(input.id) || !ref(input.childId) || !ref(input.parentSessionId) || !ref(input.conversationId)
    || typeof input.generation !== 'number' || !Number.isSafeInteger(input.generation) || input.generation <= 0
    || typeof input.createdAt !== 'number' || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || typeof input.deadlineAt !== 'number' || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < input.createdAt
    || !['starting', 'running', 'completed', 'failed', 'unknown'].includes(String(input.status))
    || !['not-requested', 'delivering', 'confirmed', 'rejected', 'unknown', 'unavailable'].includes(String(input.delivery))
    || input.lastError !== null && (typeof input.lastError !== 'string' || !/^[A-Z][A-Z_]{1,63}$/.test(input.lastError))
    || input.deliveryError !== null && !ref(input.deliveryError)
    || !['resultId', 'deliveryId', 'deliveryMessageId', 'deliveryFileId'].every(key => input[key] === null || ref(input[key]))) return null
  const result = input.result === null ? null : parseNativeWorkBackendResult(input.result)
  const lateResult = input.lateResult === null ? null : parseNativeWorkBackendResult(input.lateResult)
  if (input.result !== null && result === null || input.lateResult !== null && lateResult === null) return null
  return { id: input.id, childId: input.childId, parentSessionId: input.parentSessionId, conversationId: input.conversationId,
    generation: input.generation, createdAt: input.createdAt, deadlineAt: input.deadlineAt,
    status: input.status as NativeWorkView['status'], result, lateResult, delivery: input.delivery as NativeWorkView['delivery'],
    lastError: input.lastError as string | null, resultId: input.resultId as string | null, deliveryId: input.deliveryId as string | null,
    deliveryMessageId: input.deliveryMessageId as string | null, deliveryError: input.deliveryError as string | null,
    deliveryFileId: input.deliveryFileId as string | null }
}
export function parseNativeWorkListSnapshot(input: unknown): NativeWorkListSnapshot | null {
  if (!record(input) || !exact(input, ['schema', 'records', 'next']) || input.schema !== 1
    || !Array.isArray(input.records) || input.records.length > 1000 || input.next !== null && !ref(input.next)) return null
  const records: NativeWorkView[] = []
  const seen = new Set<string>()
  for (const item of input.records) {
    const view = parseNativeWorkView(item)
    if (!view || seen.has(view.id)) return null
    seen.add(view.id)
    records.push(view)
  }
  return { schema: 1, records, next: input.next }
}
export function parseNativeWorkDetailSnapshot(input: unknown): NativeWorkDetailSnapshot | null {
  if (!record(input) || !exact(input, ['schema', 'record']) || input.schema !== 1) return null
  const view = parseNativeWorkView(input.record)
  return view ? { schema: 1, record: view } : null
}
