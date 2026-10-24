import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'

import type {
  DeliveryReceipt,
  MessageContent,
  SendRequest,
  TransportAdapter,
} from '../core/types.ts'
import { normalizeContent } from '../core/content.ts'
import type { InboundMessage } from '../host/types.ts'

type MaybePromise<Value> = Value | Promise<Value>

export interface OneBotAssetResolutionRequest {
  assetId: string
  type: 'image' | 'audio'
  conversationId: string
  persona?: string
  signal: AbortSignal
}

export type OneBotResolvedAsset = string | { file: string }
export type OneBotAssetResolver = (
  request: OneBotAssetResolutionRequest,
) => MaybePromise<OneBotResolvedAsset>

export interface OneBotTransportOptions {
  endpoint: string
  accessToken?: string
  resolveAsset?: OneBotAssetResolver
  persona?: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export interface OneBotIncomingAssetSource {
  file?: string
  url?: string
  id?: string
}

export interface OneBotIncomingAsset {
  kind: 'image' | 'audio' | 'file'
  messageId: string
  conversationId: string
  name?: string
  source: OneBotIncomingAssetSource
}

export type OneBotIncomingAssetRegistrar = (
  asset: OneBotIncomingAsset,
  signal: AbortSignal,
) => MaybePromise<string>

export interface OneBotInboundMediaPreview {
  type: 'image' | 'audio' | 'file'
}

export interface OneBotAuthorizationContext {
  media: readonly OneBotInboundMediaPreview[]
  signal: AbortSignal
}

export interface NormalizeOneBotOptions {
  selfId: string | number
  registerIncomingAsset?: OneBotIncomingAssetRegistrar
  now?: () => number
  signal?: AbortSignal
}

export interface OneBotReceiverOptions extends NormalizeOneBotOptions {
  secret: string
  allow?: (message: InboundMessage, context: OneBotAuthorizationContext) => MaybePromise<boolean>
  onMessage: (message: InboundMessage) => MaybePromise<void>
  maxBodyBytes?: number
  callbackTimeoutMs?: number
}

interface OneBotSegment {
  type: string
  data: Record<string, string>
}

const MAX_IDENTIFIER_LENGTH = 32
const MAX_CONTENT_SEGMENTS = 8
const MAX_RESPONSE_BODY_BYTES = 64 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveIdentifier(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length <= MAX_IDENTIFIER_LENGTH && /^[1-9]\d*$/.test(normalized) ? normalized : null
}

function messageIdentifier(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value !== 0 ? String(value) : null
  }
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length <= MAX_IDENTIFIER_LENGTH && /^-?[1-9]\d*$/.test(normalized) ? normalized : null
}

function safeString(value: unknown, maximum = 4096): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : undefined
}

function actionUrl(endpoint: string, action: string): URL {
  const base = new URL(endpoint)
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError('OneBot endpoint must use HTTP or HTTPS.')
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return new URL(action, base)
}

function conversationTarget(conversationId: string):
  | { action: 'send_private_msg'; key: 'user_id'; value: number }
  | { action: 'send_group_msg'; key: 'group_id'; value: number }
  | null {
  const match = /^(private|group):([1-9]\d*)$/.exec(conversationId)
  if (!match) return null
  const value = Number(match[2])
  if (!Number.isSafeInteger(value)) return null
  return match[1] === 'private'
    ? { action: 'send_private_msg', key: 'user_id', value }
    : { action: 'send_group_msg', key: 'group_id', value }
}

function resolvedFile(value: OneBotResolvedAsset): string | null {
  const file = typeof value === 'string' ? value : value.file
  return typeof file === 'string' && file.length > 0 ? file : null
}

function waitWithSignal<Value>(value: MaybePromise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<Value>((resolvePromise, rejectPromise) => {
    const aborted = (): void => rejectPromise(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve(value).then(
      resolved => {
        signal.removeEventListener('abort', aborted)
        resolvePromise(resolved)
      },
      error => {
        signal.removeEventListener('abort', aborted)
        rejectPromise(error)
      },
    )
  })
}

async function outboundSegments(
  content: readonly MessageContent[],
  resolveAsset: OneBotAssetResolver | undefined,
  context: { conversationId: string; persona?: string },
  signal: AbortSignal,
): Promise<OneBotSegment[] | null> {
  if (content.length === 0 || content.some(block => block.type === 'file')) return null
  const segments: OneBotSegment[] = []
  for (const block of content) {
    if (signal.aborted) return null
    if (block.type === 'text') {
      if (typeof block.text !== 'string') return null
      segments.push({ type: 'text', data: { text: block.text } })
      continue
    }
    if (block.type === 'mention') {
      const userId = positiveIdentifier(block.userId)
      if (userId === null) return null
      segments.push({ type: 'at', data: { qq: userId } })
      continue
    }
    if (block.type === 'reply') {
      const messageId = messageIdentifier(block.messageId)
      if (messageId === null) return null
      segments.push({ type: 'reply', data: { id: messageId } })
      continue
    }
    if (block.type === 'image' || block.type === 'audio') {
      if (!resolveAsset || typeof block.assetId !== 'string' || block.assetId.length === 0) return null
      let resolution: OneBotResolvedAsset
      try {
        resolution = await waitWithSignal(
          resolveAsset({
            assetId: block.assetId,
            type: block.type,
            conversationId: context.conversationId,
            ...(context.persona === undefined ? {} : { persona: context.persona }),
            signal,
          }),
          signal,
        )
      } catch {
        return null
      }
      const file = resolvedFile(resolution)
      if (file === null) return null
      segments.push({ type: block.type === 'image' ? 'image' : 'record', data: { file } })
      continue
    }
    return null
  }
  return segments
}

function receiptFromResponse(value: unknown): DeliveryReceipt {
  if (!record(value)) return { status: 'unknown' }
  if (!Number.isSafeInteger(value.retcode)) return { status: 'unknown' }
  if (value.retcode !== 0) return { status: 'rejected' }
  if (value.status === 'failed' || !record(value.data)) return { status: 'unknown' }
  const messageId = messageIdentifier(value.data.message_id)
  return messageId === null
    ? { status: 'unknown' }
    : { status: 'confirmed', messageId }
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined)
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new TypeError('OneBot response has no body.')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const result = await waitWithSignal(reader.read(), signal)
      if (result.done) break
      size += result.value.byteLength
      if (size > MAX_RESPONSE_BODY_BYTES) {
        throw new TypeError('OneBot response body is too large.')
      }
      chunks.push(Buffer.from(result.value))
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  }
  reader.releaseLock()
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown
}

export function createOneBotTransport(options: OneBotTransportOptions): TransportAdapter {
  const sendPrivateUrl = actionUrl(options.endpoint, 'send_private_msg')
  const sendGroupUrl = actionUrl(options.endpoint, 'send_group_msg')
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  if (typeof fetchImplementation !== 'function') throw new TypeError('OneBot transport requires fetch.')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new TypeError('OneBot timeout must be a bounded positive integer.')
  }
  const accessToken = options.accessToken

  return Object.freeze({
    async send(request: SendRequest): Promise<DeliveryReceipt> {
      const target = conversationTarget(request.conversationId)
      if (target === null) return { status: 'rejected' }
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
      const segments = await outboundSegments(request.content, options.resolveAsset, {
        conversationId: request.conversationId,
        ...(options.persona === undefined ? {} : { persona: options.persona }),
      }, signal)
      if (segments === null) return signal.aborted ? { status: 'unknown' } : { status: 'rejected' }
      const headers = new Headers({ 'content-type': 'application/json' })
      if (accessToken) headers.set('authorization', `Bearer ${accessToken}`)
      try {
        const response = await fetchImplementation(
          target.action === 'send_private_msg' ? sendPrivateUrl : sendGroupUrl,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ [target.key]: target.value, message: segments }),
            signal,
          },
        )
        if (!response.ok) {
          cancelResponseBody(response)
          return response.status === 401 || response.status === 403
            ? { status: 'rejected' }
            : { status: 'unknown' }
        }
        let body: unknown
        try {
          body = await readBoundedJson(response, signal)
        } catch {
          cancelResponseBody(response)
          return { status: 'unknown' }
        }
        return receiptFromResponse(body)
      } catch {
        return { status: 'unknown' }
      }
    },
  })
}

function sourceFromData(data: Record<string, unknown>): OneBotIncomingAssetSource {
  const source: OneBotIncomingAssetSource = {}
  const file = safeString(data.file)
  const url = safeString(data.url)
  const id = safeString(data.file_id, 512) ?? safeString(data.id, 512)
  if (file !== undefined) source.file = file
  if (url !== undefined) source.url = url
  if (id !== undefined) source.id = id
  return source
}

function fileName(data: Record<string, unknown>): string {
  const candidate = safeString(data.name, 255) ?? safeString(data.file) ?? 'file'
  const parts = candidate.split(/[\\/]/)
  const name = parts.at(-1) || 'file'
  return name.length <= 255 && !/[\x00-\x1f\x7f/\\]/.test(name) ? name : 'file'
}

async function normalizeSegments(
  rawMessage: unknown,
  fallbackText: unknown,
  context: {
    messageId: string
    conversationId: string
    register?: OneBotIncomingAssetRegistrar
    signal: AbortSignal
  },
): Promise<{
  content: MessageContent[]
  mentioned: Set<string>
  media: OneBotInboundMediaPreview[]
} | null> {
  const content: MessageContent[] = []
  const mentioned = new Set<string>()
  const media: OneBotInboundMediaPreview[] = []
  if (typeof rawMessage === 'string') {
    if (rawMessage.length === 0 || rawMessage.length > 8000) return null
    content.push({ type: 'text', text: rawMessage })
    return { content, mentioned, media }
  }
  if (!Array.isArray(rawMessage)) {
    if (typeof fallbackText === 'string' && fallbackText.length > 0 && fallbackText.length <= 8000) {
      content.push({ type: 'text', text: fallbackText })
    }
    return { content, mentioned, media }
  }
  if (rawMessage.length === 0 || rawMessage.length > MAX_CONTENT_SEGMENTS) return null
  for (const rawSegment of rawMessage) {
    if (!record(rawSegment) || typeof rawSegment.type !== 'string' || !record(rawSegment.data)) continue
    const data = rawSegment.data
    if (rawSegment.type === 'text' && typeof data.text === 'string') {
      if (data.text.length === 0) continue
      if (data.text.length > 8000) return null
      content.push({ type: 'text', text: data.text })
      continue
    }
    if (rawSegment.type === 'at') {
      const userId = positiveIdentifier(data.qq)
      if (userId !== null) {
        mentioned.add(userId)
        content.push({ type: 'mention', userId })
      }
      continue
    }
    if (rawSegment.type === 'reply') {
      const replyId = messageIdentifier(data.id)
      if (replyId !== null) content.push({ type: 'reply', messageId: replyId })
      continue
    }
    const kind = rawSegment.type === 'image' || rawSegment.type === 'mface'
      ? 'image'
      : rawSegment.type === 'record'
        ? 'audio'
        : rawSegment.type === 'file'
          ? 'file'
          : null
    if (kind === null) continue
    media.push(Object.freeze({ type: kind }))
    if (!context.register) continue
    const name = kind === 'file' ? fileName(data) : undefined
    const assetId = await waitWithSignal(context.register({
        kind,
        messageId: context.messageId,
        conversationId: context.conversationId,
        ...(name === undefined ? {} : { name }),
        source: sourceFromData(data),
      }, context.signal),
      context.signal,
    )
    if (typeof assetId !== 'string' || assetId.length === 0) {
      throw new TypeError('Incoming asset registrar returned an invalid asset identifier.')
    }
    if (kind === 'image') content.push({ type: 'image', assetId })
    else if (kind === 'audio') content.push({ type: 'audio', assetId })
    else content.push({ type: 'file', assetId, name: name ?? 'file' })
  }
  return { content, mentioned, media }
}

interface NormalizedOneBotEvent {
  message: InboundMessage
  media: readonly OneBotInboundMediaPreview[]
}

async function normalizeOneBotEvent(
  event: unknown,
  options: NormalizeOneBotOptions,
  allowEmptyContent: boolean,
): Promise<NormalizedOneBotEvent | null> {
  if (!record(event) || event.post_type !== 'message') return null
  const configuredSelfId = positiveIdentifier(options.selfId)
  const eventSelfId = positiveIdentifier(event.self_id)
  const userId = positiveIdentifier(event.user_id)
  const messageId = messageIdentifier(event.message_id)
  if (configuredSelfId === null || eventSelfId !== configuredSelfId || userId === null || messageId === null) return null
  const isSelf = userId === configuredSelfId
  let conversationId: string
  if (event.message_type === 'group') {
    const groupId = positiveIdentifier(event.group_id)
    if (groupId === null) return null
    conversationId = `group:${groupId}`
  } else if (event.message_type === 'private') {
    const peerId = isSelf ? positiveIdentifier(event.target_id) : userId
    if (peerId === null) return null
    conversationId = `private:${peerId}`
  } else {
    return null
  }
  const signal = options.signal ?? new AbortController().signal
  const normalized = await normalizeSegments(event.message, event.raw_message, {
    messageId,
    conversationId,
    register: options.registerIncomingAsset,
    signal,
  })
  if (normalized === null) return null
  if (normalized.content.length === 0 && normalized.media.length === 0) return null
  let content: readonly MessageContent[]
  if (normalized.content.length === 0 && allowEmptyContent) {
    content = Object.freeze([])
  } else {
    try {
      content = normalizeContent(normalized.content)
    } catch {
      return null
    }
  }
  const eventTime = typeof event.time === 'number' && Number.isFinite(event.time) && event.time >= 0
    ? Math.trunc(event.time * 1000)
    : (options.now ?? Date.now)()
  return Object.freeze({
    message: Object.freeze({
      id: messageId,
      conversationId,
      userId,
      receivedAt: eventTime,
      content,
      directed: event.message_type === 'private' || normalized.mentioned.has(configuredSelfId),
      isSelf,
    }),
    media: Object.freeze(normalized.media),
  })
}

export async function normalizeOneBotMessage(
  event: unknown,
  options: NormalizeOneBotOptions,
): Promise<InboundMessage | null> {
  return (await normalizeOneBotEvent(event, options, false))?.message ?? null
}

function signatureHeader(request: IncomingMessage): string {
  const value = request.headers['x-signature']
  return typeof value === 'string' ? value : ''
}

function validSignature(secret: string, body: Buffer, header: string): boolean {
  const expected = createHmac('sha1', secret).update(body).digest()
  const validFormat = /^sha1=[a-fA-F0-9]{40}$/.test(header)
  const supplied = validFormat ? Buffer.from(header.slice(5), 'hex') : Buffer.alloc(expected.length)
  return supplied.length === expected.length && timingSafeEqual(expected, supplied) && validFormat
}

function readBody(request: IncomingMessage, maximum: number): Promise<Buffer | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: Buffer | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(value)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(error)
    }
    const cleanup = (): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', fail)
      request.off('aborted', onAborted)
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.byteLength
      if (size > maximum) {
        request.resume()
        finish(null)
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => finish(Buffer.concat(chunks, size))
    const onAborted = (): void => fail(new Error('Request aborted.'))
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', fail)
    request.once('aborted', onAborted)
  })
}

function respond(response: ServerResponse, status: number): void {
  if (response.headersSent || response.destroyed) return
  response.statusCode = status
  response.setHeader('cache-control', 'no-store')
  response.end()
}

export function createOneBotReceiver(options: OneBotReceiverOptions): RequestListener {
  if (typeof options.secret !== 'string' || options.secret.length === 0) {
    throw new TypeError('OneBot receiver requires a secret.')
  }
  if (typeof options.onMessage !== 'function') throw new TypeError('OneBot receiver requires onMessage.')
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new TypeError('OneBot receiver body limit must be a positive integer.')
  }
  const callbackTimeoutMs = options.callbackTimeoutMs ?? 10_000
  if (!Number.isSafeInteger(callbackTimeoutMs) || callbackTimeoutMs <= 0 || callbackTimeoutMs > 2_147_483_647) {
    throw new TypeError('OneBot receiver callback timeout must be a bounded positive integer.')
  }
  if (positiveIdentifier(options.selfId) === null) {
    throw new TypeError('OneBot receiver requires a valid self identifier.')
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') {
      respond(response, 405)
      return
    }
    const declaredLength = Number(request.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      request.resume()
      respond(response, 413)
      return
    }
    const body = await readBody(request, maxBodyBytes)
    if (body === null) {
      respond(response, 413)
      return
    }
    if (!validSignature(options.secret, body, signatureHeader(request))) {
      respond(response, 401)
      return
    }
    let event: unknown
    try {
      event = JSON.parse(body.toString('utf8')) as unknown
    } catch {
      respond(response, 400)
      return
    }
    const callbackSignal = AbortSignal.timeout(callbackTimeoutMs)
    const authorization = await normalizeOneBotEvent(event, {
      selfId: options.selfId,
      now: options.now,
      signal: callbackSignal,
    }, true)
    if (authorization === null) {
      respond(response, 204)
      return
    }
    try {
      const authorizationContext: OneBotAuthorizationContext = Object.freeze({
        media: authorization.media,
        signal: callbackSignal,
      })
      if (options.allow) {
        const allowed = await waitWithSignal(
          options.allow(authorization.message, authorizationContext),
          callbackSignal,
        )
        if (allowed !== true) {
          respond(response, 403)
          return
        }
      }
      const normalized = await normalizeOneBotEvent(event, {
        selfId: options.selfId,
        now: options.now,
        signal: callbackSignal,
        registerIncomingAsset: options.registerIncomingAsset,
      }, false)
      if (normalized === null) {
        respond(response, 400)
        return
      }
      await waitWithSignal(options.onMessage(normalized.message), callbackSignal)
      respond(response, 204)
    } catch {
      respond(response, callbackSignal.aborted ? 504 : 500)
    }
  }

  return (request, response) => {
    void handle(request, response).catch(() => respond(response, 500))
  }
}
