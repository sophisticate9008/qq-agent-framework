import { snapshot } from '../core/values.ts'
import { normalizeContent } from '../core/content.ts'
import type { JsonObject, JsonValue, MessageContent } from '../core/types.ts'
import type { AgentAdapter, AgentEvent } from '../host/types.ts'

type MaybePromise<Value> = Value | Promise<Value>

export interface DshPortError {
  code: string
  message?: string
}

export type DshPortResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: DshPortError }

export interface DshCreateSessionRequest {
  conversationId: string
  requestId: string
  signal: AbortSignal
}

export interface DshPromptRequest {
  sessionId: string
  requestId: string
  mode: 'queue'
  content: readonly MessageContent[]
  signal: AbortSignal
}

export interface DshCancelRequest {
  sessionId: string
  signal: AbortSignal
}

export interface DshSessionEvent {
  type: 'session/event'
  sessionId: string
  event: {
    id?: string
    seq?: number
    type: string
    data?: JsonObject
  }
}

export interface DshQuestionEvent {
  type: 'question/requested'
  sessionId: string
  eventId: string
  clientId?: string
  questions: JsonValue[]
}

export interface DshApprovalEvent {
  type: 'approval/requested'
  sessionId: string
  eventId: string
  clientId?: string
  toolName?: string
  callId?: string
  reason?: string
}

export interface DshStreamErrorEvent {
  type: 'stream/error'
  sessionId: string
  eventId?: string
  error?: DshPortError
}

export type DshFollowEvent = DshSessionEvent | DshQuestionEvent | DshApprovalEvent | DshStreamErrorEvent

export interface DshFollowRequest {
  sessionId: string
  signal: AbortSignal
  onEvent(event: DshFollowEvent): void | Promise<void>
}

export interface DshClientPort {
  createSession(request: DshCreateSessionRequest): Promise<DshPortResult<{ sessionId: string }>>
  prompt(request: DshPromptRequest): Promise<DshPortResult<JsonValue>>
  follow(request: DshFollowRequest): Promise<() => void | Promise<void>>
  cancel(request: DshCancelRequest): Promise<DshPortResult<JsonValue>>
}

export interface DshSdkRpcResponse<Value> {
  result: DshPortResult<Value>
}

export interface DshSdkSessions {
  create(request: JsonObject, signal?: AbortSignal): Promise<DshSdkRpcResponse<{ sessionId: string }>>
  prompt(request: {
    sessionId: string
    requestId: string
    mode: 'queue'
    content: readonly MessageContent[]
  }, signal?: AbortSignal): Promise<DshSdkRpcResponse<JsonValue>>
}

export interface DshSdkEvents {
  follow(sessionId: string): MaybePromise<void | (() => void | Promise<void>)>
  forget?(sessionId: string): MaybePromise<void>
}

export interface DshSdkClient {
  sessions: DshSdkSessions
  events: DshSdkEvents
  stopSessionWork?(sessionId: string, options: { signal: AbortSignal }): Promise<unknown>
}

export type DshSdkSubscription = () => void | Promise<void>
export type DshSdkSubscribe = (
  onEvent: (event: unknown) => void | Promise<void>,
  signal: AbortSignal,
) => MaybePromise<DshSdkSubscription>

export type DshSdkCancel = (
  request: DshCancelRequest,
) => MaybePromise<DshSdkRpcResponse<JsonValue> | DshPortResult<JsonValue> | void>

export interface DshSdkPortOptions {
  client: DshSdkClient
  subscribe: DshSdkSubscribe
  createSessionRequest?: (request: DshCreateSessionRequest) => JsonObject
  cancel?: DshSdkCancel
}

export class DshAdapterError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'DshAdapterError'
    this.code = code
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function unknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function jsonObjectFromUnknown(value: unknown): JsonObject | undefined {
  if (!unknownRecord(value)) return undefined
  try {
    return snapshot(value) as JsonObject
  } catch {
    return undefined
  }
}

function jsonRecord(value: JsonValue | undefined): JsonObject | null {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null
}

function copyContent(content: readonly MessageContent[]): readonly MessageContent[] {
  return snapshot(content.map(block => {
    if (block.type === 'text') return { type: block.type, text: block.text }
    if (block.type === 'file') return { type: block.type, assetId: block.assetId, name: block.name }
    if (block.type === 'mention') return { type: block.type, userId: block.userId }
    if (block.type === 'reply') return { type: block.type, messageId: block.messageId }
    if (block.type === 'forward') return normalizeContent([block])[0]
    return { type: block.type, assetId: block.assetId }
  }))
}

function eventContent(data: JsonObject | undefined): readonly MessageContent[] | undefined {
  const message = jsonRecord(data?.message)
  const rawContent = message?.content
  if (!Array.isArray(rawContent)) return undefined
  const content: MessageContent[] = []
  for (const value of rawContent) {
    const block = jsonRecord(value)
    if (block === null) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image' && nonEmpty(block.assetId)) {
      content.push({ type: 'image', assetId: block.assetId })
    } else if (block.type === 'audio' && nonEmpty(block.assetId)) {
      content.push({ type: 'audio', assetId: block.assetId })
    } else if (block.type === 'file' && nonEmpty(block.assetId) && nonEmpty(block.name)) {
      content.push({ type: 'file', assetId: block.assetId, name: block.name })
    } else if (block.type === 'mention' && nonEmpty(block.userId)) {
      content.push({ type: 'mention', userId: block.userId })
    } else if (block.type === 'reply' && nonEmpty(block.messageId)) {
      content.push({ type: 'reply', messageId: block.messageId })
    } else if (block.type === 'forward') {
      try { content.push(...normalizeContent([block])) } catch { return undefined }
    }
  }
  return content.length === 0 ? undefined : snapshot(content)
}

function sessionEventId(frame: DshSessionEvent): string | null {
  if (nonEmpty(frame.event.id)) return frame.event.id
  if (typeof frame.event.seq === 'number' && Number.isSafeInteger(frame.event.seq) && frame.event.seq >= 0) {
    return `${frame.event.type}:seq:${frame.event.seq}`
  }
  const data = frame.event.data
  const message = jsonRecord(data?.message)
  const turn = data?.turn
  const sourceId = nonEmpty(message?.id)
    ? message.id
    : nonEmpty(turn) || (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0)
      ? String(turn)
      : nonEmpty(data?.eventId)
        ? data.eventId
        : null
  return sourceId === null ? null : `${frame.event.type}:${sourceId}`
}

function questionData(frame: DshQuestionEvent): JsonObject {
  return snapshot({
    eventId: frame.eventId,
    questions: frame.questions,
    ...(frame.clientId === undefined ? {} : { clientId: frame.clientId }),
  })
}

function approvalData(frame: DshApprovalEvent): JsonObject {
  return snapshot({
    eventId: frame.eventId,
    ...(frame.clientId === undefined ? {} : { clientId: frame.clientId }),
    ...(frame.toolName === undefined ? {} : { toolName: frame.toolName }),
    ...(frame.callId === undefined ? {} : { callId: frame.callId }),
    ...(frame.reason === undefined ? {} : { reason: frame.reason }),
  })
}

export function normalizeDshEvent(frame: DshFollowEvent): AgentEvent | null {
  if (!nonEmpty(frame.sessionId)) return null
  if (frame.type === 'question/requested') {
    if (!nonEmpty(frame.eventId) || !Array.isArray(frame.questions)) return null
    return snapshot({
      id: frame.eventId,
      sessionId: frame.sessionId,
      type: 'question',
      data: questionData(frame),
    })
  }
  if (frame.type === 'approval/requested') {
    if (!nonEmpty(frame.eventId)) return null
    return snapshot({
      id: frame.eventId,
      sessionId: frame.sessionId,
      type: 'approval',
      data: approvalData(frame),
    })
  }
  if (frame.type === 'stream/error') {
    const errorCode = frame.error && nonEmpty(frame.error.code) ? frame.error.code : 'unknown'
    const id = nonEmpty(frame.eventId) ? frame.eventId : `stream/error:${errorCode}`
    const data: JsonObject = frame.error && nonEmpty(frame.error.code) ? { code: frame.error.code } : {}
    return snapshot({
      id,
      sessionId: frame.sessionId,
      type: 'failed',
      data,
    })
  }
  const id = sessionEventId(frame)
  if (id === null) return null
  if (frame.event.type === 'assistant/message') {
    const content = eventContent(frame.event.data)
    return snapshot({
      id,
      sessionId: frame.sessionId,
      type: 'message',
      ...(content === undefined ? {} : { content }),
      ...(frame.event.data === undefined ? {} : { data: snapshot(frame.event.data) }),
    })
  }
  if (frame.event.type === 'turn/end') {
    const data = snapshot(frame.event.data ?? {})
    const reason = jsonRecord(data.reason)
    return snapshot({
      id,
      sessionId: frame.sessionId,
      type: reason?.kind === 'completed' ? 'completed' : 'failed',
      data,
    })
  }
  if (frame.event.type === 'turn/error' || frame.event.type === 'session/error') {
    return snapshot({
      id,
      sessionId: frame.sessionId,
      type: 'failed',
      data: snapshot(frame.event.data ?? {}),
    })
  }
  return null
}

function validatePort(client: DshClientPort): void {
  if (!client || typeof client !== 'object'
    || typeof client.createSession !== 'function'
    || typeof client.prompt !== 'function'
    || typeof client.follow !== 'function'
    || typeof client.cancel !== 'function') {
    throw new TypeError('DSH adapter requires a complete client port.')
  }
}

function rejected(result: DshPortResult<unknown>): boolean {
  return result !== null && typeof result === 'object' && result.ok === false
}

function sdkResult<Value>(response: unknown): DshPortResult<Value> {
  if (!unknownRecord(response) || !unknownRecord(response.result)) {
    throw new DshAdapterError('DSH_SDK_INVALID_RESPONSE', 'DSH SDK returned an invalid RPC response.')
  }
  const result = response.result
  if (result.ok === true && Object.hasOwn(result, 'value')) {
    return { ok: true, value: result.value as Value }
  }
  if (result.ok === false) {
    const error = unknownRecord(result.error) ? result.error : {}
    return {
      ok: false,
      error: {
        code: nonEmpty(error.code) ? error.code : 'sdk/rejected',
        ...(nonEmpty(error.message) ? { message: error.message } : {}),
      },
    }
  }
  throw new DshAdapterError('DSH_SDK_INVALID_RESPONSE', 'DSH SDK returned an invalid RPC result.')
}

function sdkFollowEvent(input: unknown): DshFollowEvent | null {
  if (!unknownRecord(input)) return null
  const candidate = unknownRecord(input.payload) ? input.payload : input
  if (!nonEmpty(candidate.type) || !nonEmpty(candidate.sessionId)) return null
  const sessionId = candidate.sessionId
  if (candidate.type === 'session/event') {
    if (!unknownRecord(candidate.event) || !nonEmpty(candidate.event.type)) return null
    const data = candidate.event.data === undefined ? undefined : jsonObjectFromUnknown(candidate.event.data)
    if (candidate.event.data !== undefined && data === undefined) return null
    const seq = candidate.event.seq
    return {
      type: 'session/event',
      sessionId,
      event: {
        ...(nonEmpty(candidate.event.id) ? { id: candidate.event.id } : {}),
        ...(Number.isSafeInteger(seq) && Number(seq) >= 0 ? { seq: Number(seq) } : {}),
        type: candidate.event.type,
        ...(data === undefined ? {} : { data }),
      },
    }
  }
  if (candidate.type === 'question/requested') {
    if (!nonEmpty(candidate.eventId) || !Array.isArray(candidate.questions)) return null
    let questions: JsonValue[]
    try {
      questions = snapshot(candidate.questions) as JsonValue[]
    } catch {
      return null
    }
    return {
      type: 'question/requested',
      sessionId,
      eventId: candidate.eventId,
      ...(nonEmpty(candidate.clientId) ? { clientId: candidate.clientId } : {}),
      questions,
    }
  }
  if (candidate.type === 'approval/requested') {
    if (!nonEmpty(candidate.eventId)) return null
    return {
      type: 'approval/requested',
      sessionId,
      eventId: candidate.eventId,
      ...(nonEmpty(candidate.clientId) ? { clientId: candidate.clientId } : {}),
      ...(nonEmpty(candidate.toolName) ? { toolName: candidate.toolName } : {}),
      ...(nonEmpty(candidate.callId) ? { callId: candidate.callId } : {}),
      ...(nonEmpty(candidate.reason) ? { reason: candidate.reason } : {}),
    }
  }
  if (candidate.type === 'stream/error') {
    const error = unknownRecord(candidate.error) && nonEmpty(candidate.error.code)
      ? {
        code: candidate.error.code,
        ...(nonEmpty(candidate.error.message) ? { message: candidate.error.message } : {}),
      }
      : undefined
    return {
      type: 'stream/error',
      sessionId,
      ...(nonEmpty(candidate.eventId) ? { eventId: candidate.eventId } : {}),
      ...(error === undefined ? {} : { error }),
    }
  }
  return null
}

async function disposeAll(disposers: ReadonlyArray<() => MaybePromise<void>>): Promise<void> {
  let failure: unknown
  for (const dispose of disposers) {
    try {
      await dispose()
    } catch (error) {
      failure ??= error
    }
  }
  if (failure !== undefined) throw failure
}

export function createDshSdkPort(options: DshSdkPortOptions): DshClientPort {
  const client = options?.client
  if (!client || typeof client !== 'object'
    || !client.sessions || typeof client.sessions.create !== 'function' || typeof client.sessions.prompt !== 'function'
    || !client.events || typeof client.events.follow !== 'function'
    || typeof options.subscribe !== 'function') {
    throw new TypeError('DSH SDK port requires sessions, events and subscribe.')
  }
  if (typeof client.stopSessionWork !== 'function' && typeof options.cancel !== 'function') {
    throw new TypeError('DSH SDK port requires stopSessionWork or cancel.')
  }
  return Object.freeze({
    async createSession(request: DshCreateSessionRequest): Promise<DshPortResult<{ sessionId: string }>> {
      const input = options.createSessionRequest?.(request) ?? {}
      return sdkResult(await client.sessions.create(snapshot(input), request.signal))
    },

    async prompt(request: DshPromptRequest): Promise<DshPortResult<JsonValue>> {
      return sdkResult(await client.sessions.prompt({
        sessionId: request.sessionId,
        requestId: request.requestId,
        mode: 'queue',
        content: copyContent(request.content),
      }, request.signal))
    },

    async follow(request: DshFollowRequest): Promise<DshSdkSubscription> {
      let subscription: DshSdkSubscription | undefined
      let followDisposer: (() => void | Promise<void>) | undefined
      let followOpened = false
      let disposed = false
      let subscriptionDisposed = false
      let followDisposed = false
      const dispose = async (): Promise<void> => {
        if (!disposed) {
          disposed = true
          request.signal.removeEventListener('abort', abort)
        }
        const disposers: Array<() => MaybePromise<void>> = []
        if (subscription && !subscriptionDisposed) {
          subscriptionDisposed = true
          disposers.push(subscription)
        }
        if (!followDisposed && followDisposer) {
          followDisposed = true
          disposers.push(followDisposer)
        } else if (!followDisposed && followOpened && client.events.forget) {
          followDisposed = true
          disposers.push(() => client.events.forget!(request.sessionId))
        }
        await disposeAll(disposers)
      }
      const abort = (): void => { void dispose().catch(() => undefined) }
      try {
        request.signal.addEventListener('abort', abort, { once: true })
        if (request.signal.aborted) abort()
        subscription = await options.subscribe(async input => {
          if (disposed) return
          const event = sdkFollowEvent(input)
          if (event !== null && event.sessionId === request.sessionId) await request.onEvent(event)
        }, request.signal)
        if (typeof subscription !== 'function') {
          throw new DshAdapterError('DSH_SDK_INVALID_SUBSCRIPTION', 'DSH SDK subscribe returned no disposer.')
        }
        if (request.signal.aborted) {
          await dispose()
          return dispose
        }
        const followed = await client.events.follow(request.sessionId)
        followOpened = true
        if (typeof followed === 'function') followDisposer = followed
        if (request.signal.aborted) await dispose()
        return dispose
      } catch (error) {
        await dispose().catch(() => undefined)
        throw error
      }
    },

    async cancel(request: DshCancelRequest): Promise<DshPortResult<JsonValue>> {
      if (client.stopSessionWork) {
        await client.stopSessionWork(request.sessionId, { signal: request.signal })
        return { ok: true, value: null }
      }
      const result = await options.cancel!(request)
      if (result === undefined) return { ok: true, value: null }
      if (unknownRecord(result) && Object.hasOwn(result, 'result')) return sdkResult(result)
      if (unknownRecord(result) && (result.ok === true || result.ok === false)) {
        return result as DshPortResult<JsonValue>
      }
      throw new DshAdapterError('DSH_SDK_INVALID_RESPONSE', 'DSH SDK cancel returned an invalid result.')
    },
  })
}

export function createDshAdapter(client: DshClientPort): AgentAdapter {
  validatePort(client)
  const adapter: AgentAdapter = {
    async createSession(request) {
      let result: DshPortResult<{ sessionId: string }>
      try {
        result = await client.createSession({
          conversationId: request.conversationId,
          requestId: request.requestId,
          signal: request.signal,
        })
      } catch {
        throw new DshAdapterError('DSH_CREATE_UNKNOWN', 'DSH session creation did not complete.')
      }
      if (rejected(result)) {
        throw new DshAdapterError('DSH_CREATE_REJECTED', 'DSH rejected session creation.')
      }
      if (!result || result.ok !== true || !nonEmpty(result.value?.sessionId)) {
        throw new DshAdapterError('DSH_CREATE_UNKNOWN', 'DSH returned an invalid session result.')
      }
      return snapshot({ sessionId: result.value.sessionId })
    },

    async submit(request) {
      let result: DshPortResult<JsonValue>
      try {
        result = await client.prompt({
          sessionId: request.sessionId,
          requestId: request.requestId,
          mode: 'queue',
          content: copyContent(request.content),
          signal: request.signal,
        })
      } catch {
        return { status: 'unknown' }
      }
      if (rejected(result)) return { status: 'rejected' }
      return result && result.ok === true ? { status: 'accepted' } : { status: 'unknown' }
    },

    async follow(request) {
      try {
        const stop = await client.follow({
          sessionId: request.sessionId,
          signal: request.signal,
          async onEvent(frame) {
            if (frame.sessionId !== request.sessionId) return
            const event = normalizeDshEvent(frame)
            if (event !== null) await request.onEvent(event)
          },
        })
        if (typeof stop !== 'function') {
          throw new DshAdapterError('DSH_FOLLOW_INVALID', 'DSH follow returned no disposer.')
        }
        return stop
      } catch (error) {
        if (error instanceof DshAdapterError) throw error
        throw new DshAdapterError('DSH_FOLLOW_UNKNOWN', 'DSH follow could not be established.')
      }
    },

    async cancel(request) {
      let result: DshPortResult<JsonValue>
      try {
        result = await client.cancel({ sessionId: request.sessionId, signal: request.signal })
      } catch {
        throw new DshAdapterError('DSH_CANCEL_UNKNOWN', 'DSH cancellation did not complete.')
      }
      if (rejected(result)) {
        throw new DshAdapterError('DSH_CANCEL_REJECTED', 'DSH rejected cancellation.')
      }
      if (!result || result.ok !== true) {
        throw new DshAdapterError('DSH_CANCEL_UNKNOWN', 'DSH returned an invalid cancellation result.')
      }
    },
  }
  return Object.freeze(adapter)
}
