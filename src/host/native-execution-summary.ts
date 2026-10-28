import type { FrameworkEvent, MessageContent } from '../core/types.ts'
import { isRecord, snapshot } from '../core/values.ts'
import { normalizeSenderDisplayName } from '../contracts/sender-display-name.ts'
import type { FrameworkToolCall } from '../contracts/framework-tools.ts'
import type { AgentMessageDelivery } from './bridge.ts'
import type { NativeExecutionRecord } from './native-execution.ts'
import type { DurableStore, SessionBinding } from './types.ts'
import { nativeActivityContent } from './native-activity.ts'
import { redactNativeText } from './native-redacted-text.ts'
import { digest, json } from './data.ts'

export interface NativeExecutionSummary {
  readonly schema: 1
  readonly input: { readonly messageId: string | null; readonly senderId: string | null; readonly displayName: string | null; readonly text: string | null }
  /** Only content with a confirmed QQ delivery receipt; never a model final draft. */
  readonly reply: { readonly text: string | null; readonly reason: string | null; readonly outcome: 'sent' | 'rejected' | 'unknown' | null }
  readonly delivery: { readonly confirmed: number | null; readonly rejected: number | null; readonly unknown: number | null; readonly pending: number | null }
  readonly mergedMessages: number | null
  /** Admission through the first durable terminal observation, including queueing. */
  readonly durationMs: number | null
  /** Observed successful framework calls only, without arguments or model output. */
  readonly tools: { readonly count: number; readonly names: readonly string[] } | null
  readonly partial: boolean
}

type Input = NativeExecutionSummary['input']
interface Attempt { key: string; outcome: 'sent' | 'rejected' | 'unknown'; confirmed: number; rejected: number; unknown: number; text: string | null; reason: string | null }
interface Evidence {
  schema: 1; executionId: string; binding: SessionBinding; requestId: string
  input: Input | null; mergedMessages: number | null; attempts: Attempt[]
  tools: { key: string; name: string }[]; truncated: boolean
}
const namespace = 'native-chat.execution-summaries'
const retentionMs = 7 * 24 * 60 * 60 * 1000
const allowedReasons = new Set(['no-explicit-send', 'not-addressed', 'already-answered', 'no-useful-addition',
  'user-requested', 'invalid_reply_decision'])
const safeCode = (input: unknown): string | null => typeof input === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(input) ? input : null
const toolName = (input: unknown): input is string => typeof input === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(input)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
function text(input: unknown): string | null {
  const value = typeof input === 'string' ? redactNativeText(input) : null
  if (!value) return null
  const truncated = value.length > 400
  let bounded = value.slice(0, truncated ? 399 : 400)
  if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1)
  return bounded + (truncated ? '…' : '')
}
function content(input: unknown): string | null {
  if (!Array.isArray(input)) return null
  // The summary is a projection, not a content decoder. Ignore malformed legacy evidence.
  const pieces: string[] = []
  for (const part of input.slice(0, 8)) {
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') pieces.push(part.text.slice(0, 8192))
    else if (['image', 'audio', 'file', 'face', 'reply', 'mention', 'forward', 'forward-reference'].includes(String(part.type))) {
      pieces.push(({ image: '[图片]', audio: '[语音]', file: '[文件]', face: '[QQ表情]', reply: '[引用消息]',
        mention: '[提及成员]', forward: '[合并转发]', 'forward-reference': '[合并转发]' } as Record<string, string>)[String(part.type)])
    }
  }
  return text(pieces.join('\n'))
}
function source(messageId: unknown, actor: unknown, displayName: unknown, body: unknown): Input | null {
  if (typeof messageId !== 'string' || typeof actor !== 'string' || actor === 'assistant' || actor === 'system') return null
  return { messageId, senderId: actor, displayName: normalizeSenderDisplayName(text(normalizeSenderDisplayName(displayName))) ?? null, text: content(body) }
}
function matches(value: unknown, execution: NativeExecutionRecord): value is Record<string, unknown> {
  return isRecord(value) && value.schema === 1 && value.executionId === execution.id && value.requestId === execution.requestId
    && isRecord(value.binding) && value.binding.conversationId === execution.binding.conversationId
    && value.binding.sessionId === execution.binding.sessionId && value.binding.generation === execution.binding.generation
}
function readEvidence(store: Pick<DurableStore, 'read'>, execution: NativeExecutionRecord): Evidence | null {
  const value = store.read(namespace, execution.id)?.value
  if (!matches(value, execution) || !Array.isArray(value.attempts) || value.attempts.length > 16
    || !Array.isArray(value.tools) || value.tools.length > 64 || typeof value.truncated !== 'boolean'
    || !(value.mergedMessages === null || count(value.mergedMessages) && value.mergedMessages >= 1)) return null
  const input = value.input
  if (input !== null && (!isRecord(input) || typeof input.messageId !== 'string' || typeof input.senderId !== 'string'
    || !(input.displayName === null || typeof input.displayName === 'string' && input.displayName.length <= 128)
    || !(input.text === null || typeof input.text === 'string' && input.text.length <= 400)
    || digest([execution.binding.conversationId, input.messageId, 'prompt']) !== execution.requestId)) return null
  if (!value.attempts.every(attempt => isRecord(attempt) && typeof attempt.key === 'string'
    && ['sent', 'rejected', 'unknown'].includes(String(attempt.outcome))
    && count(attempt.confirmed) && count(attempt.rejected) && count(attempt.unknown)
    && (attempt.text === null || typeof attempt.text === 'string' && attempt.text.length <= 400)
    && (attempt.reason === null || safeCode(attempt.reason) !== null))
    || !value.tools.every(tool => isRecord(tool) && typeof tool.key === 'string'
      && toolName(tool.name))) return null
  return value as unknown as Evidence
}
function executionFor(store: Pick<DurableStore, 'read'>, binding: SessionBinding, requestId: string): NativeExecutionRecord | null {
  const id = digest([{ conversationId: binding.conversationId, sessionId: binding.sessionId, generation: binding.generation }, requestId])
  const value = store.read('host.executions', id)?.value
  if (!isRecord(value) || value.id !== id || value.requestId !== requestId || !isRecord(value.binding)
    || value.binding.conversationId !== binding.conversationId || value.binding.sessionId !== binding.sessionId
    || value.binding.generation !== binding.generation) return null
  return value as unknown as NativeExecutionRecord
}
/** Diagnostics must never affect message admission, tool execution, or delivery. */
function record(store: DurableStore, execution: NativeExecutionRecord, update: (value: Evidence) => void): void {
  try {
    const prior = store.read(namespace, execution.id)
    const existing = readEvidence(store, execution)
    const value: Evidence = existing ? { ...existing, attempts: existing.attempts.map(attempt => ({ ...attempt })),
      tools: existing.tools.map(tool => ({ ...tool })) } : { schema: 1, executionId: execution.id, binding: execution.binding,
      requestId: execution.requestId, input: null, mergedMessages: null, attempts: [], tools: [], truncated: false }
    update(value)
    if (existing && digest(value) === digest(existing)) return
    store.write(namespace, execution.id, json(value), { expectedRevision: prior?.revision ?? null, expiresAt: Date.now() + retentionMs })
  } catch { /* Optional diagnostic evidence is not an execution dependency. */ }
}
function merged(store: Pick<DurableStore, 'read'>, conversationId: string, messageId: string): number | null {
  return mergedQueue(store.read('native-chat.inbox', digest(conversationId))?.value, conversationId, messageId)
}
function mergedQueue(queue: unknown, conversationId: string, messageId: string): number | null {
  if (!isRecord(queue) || queue.conversationId !== conversationId || !Array.isArray(queue.receipts)) return null
  const ids = new Set(queue.receipts.filter(receipt => isRecord(receipt) && receipt.requestMessageId === messageId
    && ['coalesced', 'accepted', 'rejected', 'unknown'].includes(String(receipt.outcome))).map(receipt => isRecord(receipt) ? receipt.id : null))
  if (queue.phase === 'dispatching' && Array.isArray(queue.dispatchingIds) && queue.dispatchingIds.includes(messageId)) {
    for (const id of queue.dispatchingIds) if (typeof id === 'string') ids.add(id)
  }
  if (!ids.size) return null
  ids.add(messageId)
  return ids.size
}

export function recordNativeExecutionInput(store: DurableStore, execution: NativeExecutionRecord): void {
  try {
    const timeline = store.read('history', digest(execution.binding.conversationId))?.value
    if (!isRecord(timeline) || !Array.isArray(timeline.messages)) return
    const entry = timeline.messages.slice(-1000).find(message => isRecord(message) && typeof message.id === 'string'
      && digest([execution.binding.conversationId, message.id, 'prompt']) === execution.requestId)
    if (!isRecord(entry) || typeof entry.id !== 'string') return
    const input = source(entry.id, entry.actor, entry.displayName, entry.content)
    const mergedMessages = merged(store, execution.binding.conversationId, entry.id)
    record(store, execution, value => {
      value.input = input
      value.mergedMessages = mergedMessages
    })
  } catch {}
}

export function recordNativeExecutionDelivery(store: DurableStore, event: FrameworkEvent, result: AgentMessageDelivery,
  confirmedContent: readonly MessageContent[]): void {
  try {
    const agentData = event.data.agentData
    if (!isRecord(agentData) || typeof agentData.nativeRequestId !== 'string' || typeof event.sessionId !== 'string'
      || !Number.isSafeInteger(event.data.generation)) return
    const execution = executionFor(store, { conversationId: event.conversationId, sessionId: event.sessionId,
      generation: Number(event.data.generation) }, agentData.nativeRequestId)
    if (!execution) return
    const attempt: Attempt = { key: digest([event.id, event.data.content]), outcome: result.status,
      confirmed: result.receipts.filter(receipt => receipt.status === 'confirmed').length,
      rejected: result.receipts.filter(receipt => receipt.status === 'rejected').length,
      unknown: result.receipts.filter(receipt => receipt.status === 'unknown').length,
      text: confirmedContent.length ? text(nativeActivityContent(confirmedContent)) : null, reason: safeCode(result.errorCode) }
    record(store, execution, value => {
      const index = value.attempts.findIndex(item => item.key === attempt.key)
      if (index >= 0) value.attempts[index] = attempt
      else if (value.attempts.length < 16) value.attempts.push(attempt)
      else value.truncated = true
    })
  } catch {}
}

export function recordNativeExecutionTool(store: DurableStore, binding: SessionBinding, call: FrameworkToolCall): void {
  try {
    if (!toolName(call.name)) return
    const execution = executionFor(store, binding, call.requestId)
    if (!execution || execution.userMessage?.messageId !== call.userMessageId || execution.turn?.id !== String(call.turn)) return
    record(store, execution, value => {
      const key = digest([call.sessionId, call.id])
      if (value.tools.some(tool => tool.key === key)) return
      if (value.tools.length < 64) value.tools.push({ key, name: call.name })
      else value.truncated = true
    })
  } catch {}
}

/** One page builds a scoped index once; no per-row namespace scans or remote calls. */
export function readNativeExecutionSummaries(store: Pick<DurableStore, 'read' | 'list'>,
  executions: readonly NativeExecutionRecord[]): ReadonlyMap<string, NativeExecutionSummary> {
  const evidence = new Map(executions.map(execution => [execution.id, readEvidence(store, execution)]))
  const inputs = new Map<string, Input>()
  const wanted = new Map(executions.filter(execution => !evidence.get(execution.id)?.input)
    .map(execution => [execution.requestId, execution.binding.conversationId]))
  const missingInputs = new Set(wanted.values())
  const conversations = new Set(executions.map(execution => execution.binding.conversationId))
  const queues = new Map<string, unknown>()
  for (const conversationId of conversations) {
    queues.set(conversationId, store.read('native-chat.inbox', digest(conversationId))?.value)
    if (!missingInputs.has(conversationId)) continue
    const timeline = store.read('history', digest(conversationId))?.value
    if (!isRecord(timeline) || !Array.isArray(timeline.messages)) continue
    for (const entry of timeline.messages.slice(-1000)) {
      if (!isRecord(entry) || typeof entry.id !== 'string') continue
      const requestId = digest([conversationId, entry.id, 'prompt'])
      if (wanted.get(requestId) !== conversationId) continue
      const input = source(entry.id, entry.actor, entry.displayName, entry.content)
      if (input) inputs.set(requestId, input)
    }
  }
  const missing = new Set(executions.filter(execution => !evidence.get(execution.id)?.input && !inputs.has(execution.requestId)).map(execution => execution.requestId))
  // Old execution IDs did not retain their QQ source. Read bounded ingress pages once for the whole page.
  let after: string | undefined
  let scannedBytes = 0
  for (let scanned = 0; missing.size && scanned < 1024 && scannedBytes < 1024 * 1024; scanned += 32) {
    const rows = store.list('host.inbox', { limit: 32, ...(after === undefined ? {} : { after }) })
    for (const row of rows) {
      scannedBytes += Buffer.byteLength(JSON.stringify(row.value))
      if (scannedBytes > 1024 * 1024) break
      const value = row.value
      if (!isRecord(value) || !isRecord(value.event)) continue
      const event = value.event
      if (event.type !== 'message.received' || typeof event.id !== 'string' || typeof event.conversationId !== 'string'
        || !isRecord(event.data)) continue
      const requestId = digest([event.conversationId, event.id, 'prompt'])
      if (!missing.has(requestId) || wanted.get(requestId) !== event.conversationId) continue
      const input = source(event.id, event.userId, event.data.senderDisplayName, event.data.content)
      if (input) { inputs.set(requestId, input); missing.delete(requestId) }
    }
    if (rows.length < 32) break
    after = rows.at(-1)!.key
  }
  const result = new Map<string, NativeExecutionSummary>()
  for (const execution of executions) {
    const saved = evidence.get(execution.id)
    const input = saved?.input ?? inputs.get(execution.requestId) ?? { messageId: null, senderId: null, displayName: null, text: null }
    const decisionValue = store.read('native-chat.reply-decisions', execution.id)?.value
    const decision = isRecord(decisionValue) && decisionValue.schema === 1 && decisionValue.executionId === execution.id
      && decisionValue.conversationId === execution.binding.conversationId && decisionValue.sessionId === execution.binding.sessionId
      && decisionValue.generation === execution.binding.generation && ['silent', 'invalid'].includes(String(decisionValue.state))
      && allowedReasons.has(String(decisionValue.reason)) ? String(decisionValue.reason) : null
    const attempts = saved?.attempts ?? []
    const uncertain = attempts.find(attempt => attempt.outcome === 'unknown')
    const failed = attempts.find(attempt => attempt.outcome === 'rejected' && attempt.reason !== 'AGENT_MESSAGE_SUPPRESSED')
    const attemptOutcome = uncertain ? 'unknown' : failed ? 'rejected' : attempts.some(attempt => attempt.outcome === 'sent') ? 'sent' : attempts.length ? 'rejected' : null
    const hasDelivery = attempts.length > 0
    const confirmed = hasDelivery ? attempts.reduce((sum, attempt) => sum + attempt.confirmed, 0) : null
    const rejected = hasDelivery ? attempts.reduce((sum, attempt) => sum + attempt.rejected, 0) : null
    const unknown = hasDelivery ? attempts.reduce((sum, attempt) => sum + attempt.unknown, 0) : null
    const mergedMessages = saved?.mergedMessages ?? (input.messageId
      ? mergedQueue(queues.get(execution.binding.conversationId), execution.binding.conversationId, input.messageId) : null)
    let durationMs: number | null = null
    if (!execution.deadlineReached && execution.lateOutcome === null && execution.lastEventId !== null
      && execution.turn !== null && ['completed', 'failed'].includes(execution.status)
      && ['completed', 'failed', 'cancelled'].includes(execution.externalStatus)) {
      const receipt = store.read('host.execution-receipts', digest([execution.id, execution.lastEventId]))
      const expected = digest({ eventId: execution.lastEventId, binding: execution.binding, turnId: execution.turn.id, kind: execution.externalStatus })
      if (receipt && isRecord(receipt.value) && receipt.value.executionId === execution.id && receipt.value.signature === expected
        && receipt.updatedAt >= execution.admittedAt) durationMs = receipt.updatedAt - execution.admittedAt
    }
    result.set(execution.id, snapshot({ schema: 1, input,
      reply: { text: text(attempts.flatMap(attempt => attempt.text ? [attempt.text] : []).join('\n')),
        reason: uncertain ? uncertain.reason ?? 'DELIVERY_UNKNOWN' : failed ? failed.reason ?? 'DELIVERY_REJECTED' : attempts.at(-1)?.reason ?? decision,
        outcome: attemptOutcome },
      delivery: { confirmed, rejected, unknown, pending: null }, mergedMessages, durationMs,
      tools: saved?.tools.length ? { count: saved.tools.length, names: [...new Set(saved.tools.map(tool => tool.name))].slice(0, 16) } : null,
      partial: saved?.truncated === true || input.messageId === null || !hasDelivery || mergedMessages === null
        || new Set(saved?.tools.map(tool => tool.name) ?? []).size > 16 }))
  }
  return result
}
