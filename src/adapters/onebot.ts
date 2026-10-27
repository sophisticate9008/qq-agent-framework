import { createOneBotFileUploadPort, validOneBotUploadSource } from './onebot-files.ts'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'

import type {
  DeliveryReceipt,
  MessageContent,
  SendRequest,
  TransportAdapter,
  BasicMessageContent,
} from '../core/types.ts'
import { normalizeContent } from '../core/content.ts'
import { normalizeOutboundScope, personaKey } from '../core/scope.ts'
import type { InboundMessage } from '../contracts/ports.ts'
import { classifyOneBotResponse } from './onebot-response.ts'
import { normalizeOneBotProtocolEvent, projectOneBotNoticeForChat } from './onebot-events.ts'

type MaybePromise<Value> = Value | Promise<Value>

export interface OneBotAssetResolutionRequest {
  assetId: string
  type: 'image' | 'audio' | 'file'
  name?: string
  conversationId: string
  /** Versioned persona key (`id@version`), not a bare persona id. */
  persona?: string
  sessionId?: string
  generation?: number
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
  forward?: { senderId: string; senderName: string; group?: boolean; private?: boolean }
}

export interface OneBotIncomingAssetSource {
  file?: string
  url?: string
  id?: string
  busId?: number
  fileHash?: string
}

export interface OneBotIncomingAsset {
  kind: 'image' | 'audio' | 'file' | 'video' | 'forward'
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
  type: 'image' | 'audio' | 'file' | 'video' | 'forward'
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
  content: readonly BasicMessageContent[],
  resolveAsset: OneBotAssetResolver | undefined,
  context: { conversationId: string; persona?: string; sessionId?: string; generation?: number },
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
    if (block.type === 'face') {
      if (!/^(0|[1-9]\d{0,4})$/.test(block.id)) return null
      segments.push({ type: 'face', data: { id: block.id } })
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
            ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
            ...(context.generation === undefined ? {} : { generation: context.generation }),
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
  const result = classifyOneBotResponse(value)
  if (result !== 'confirmed') return { status: result }
  if (!record(value) || !record(value.data)) return { status: 'unknown' }
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
  const files = createOneBotFileUploadPort(options)
  const sendPrivateUrl = actionUrl(options.endpoint, 'send_private_msg')
  const sendGroupUrl = actionUrl(options.endpoint, 'send_group_msg')
  const sendPrivateForwardUrl = actionUrl(options.endpoint, 'send_private_forward_msg')
  const sendGroupForwardUrl = actionUrl(options.endpoint, 'send_group_forward_msg')
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  if (typeof fetchImplementation !== 'function') throw new TypeError('OneBot transport requires fetch.')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new TypeError('OneBot timeout must be a bounded positive integer.')
  }
  const accessToken = options.accessToken
  const forward = options.forward === undefined ? undefined : Object.freeze({ ...options.forward })
  if (forward && (positiveIdentifier(forward.senderId) === null || !safeString(forward.senderName, 100)
    || ['group', 'private'].some(key => forward[key as 'group' | 'private'] !== undefined
      && typeof forward[key as 'group' | 'private'] !== 'boolean'))) {
    throw new TypeError('Forward messages require an explicit sender and supported target kinds.')
  }

  return Object.freeze({
    capabilities() {
      const contentTypes: MessageContent['type'][] = ['text', 'mention', 'reply', 'face']
      if (options.resolveAsset) contentTypes.push('image', 'audio', 'file')
      if (forward?.group || forward?.private) contentTypes.push('forward')
      return Object.freeze({ contentTypes: Object.freeze(contentTypes), ...(contentTypes.includes('forward') ? { maxForwardNodes: 32 } : {}) })
    },
    async send(request: SendRequest): Promise<DeliveryReceipt> {
      const target = conversationTarget(request.conversationId)
      if (target === null) return { status: 'rejected' }
      let content: readonly MessageContent[]
      let selection: { conversationId: string; persona?: string; sessionId?: string; generation?: number }
      try {
        content = normalizeContent(request.content)
        const scope = request.scope === undefined ? undefined : normalizeOutboundScope(request.scope)
        const persona = scope === undefined ? options.persona : personaKey(scope)
        if (scope && options.persona !== undefined && options.persona !== persona) return { status: 'rejected' }
        selection = { conversationId: request.conversationId, ...(persona === undefined ? {} : { persona }),
          ...(scope?.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
          ...(scope?.generation === undefined ? {} : { generation: scope.generation }) }
      } catch { return { status: 'rejected' } }
      if (request.signal.aborted) return { status: 'rejected' }
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
      let url = target.action === 'send_private_msg' ? sendPrivateUrl : sendGroupUrl
      let payload: Record<string, unknown>
      const first = content[0]
      if (first.type === 'file') {
        if (content.length !== 1 || !options.resolveAsset) return { status: 'rejected' }
        try {
          const resolved = await waitWithSignal(options.resolveAsset({ ...selection, type: 'file', name: first.name, assetId: first.assetId, signal }), signal)
          const file = resolvedFile(resolved)
          if (!validOneBotUploadSource(file)) return { status: 'rejected' }
          return target.action === 'send_private_msg'
            ? files.uploadPrivate({ userId: String(target.value), file, name: first.name, signal })
            : files.uploadGroup({ groupId: String(target.value), file, name: first.name, signal })
        } catch { return { status: signal.aborted ? 'unknown' : 'rejected' } }
      }
      if (first.type === 'forward') {
        if (!forward || !(target.action === 'send_private_msg' ? forward.private : forward.group)) return { status: 'rejected' }
        const nodes: unknown[] = []
        for (const node of first.nodes) {
          const segments = await outboundSegments(node.content, options.resolveAsset, selection, signal)
          if (segments === null) return { status: 'rejected' }
          nodes.push({ type: 'node', data: { user_id: forward.senderId, nickname: forward.senderName, content: segments } })
        }
        url = target.action === 'send_private_msg' ? sendPrivateForwardUrl : sendGroupForwardUrl
        payload = { [target.key]: target.value, messages: nodes }
      } else {
        const segments = await outboundSegments(content as readonly BasicMessageContent[], options.resolveAsset, selection, signal)
        if (segments === null) return signal.aborted ? { status: 'unknown' } : { status: 'rejected' }
        payload = { [target.key]: target.value, message: segments }
      }
      const headers = new Headers({ 'content-type': 'application/json' })
      if (accessToken) headers.set('authorization', `Bearer ${accessToken}`)
      try {
        const response = await fetchImplementation(
          url,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
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
  const busId = typeof data.busid === 'number' ? data.busid : typeof data.busid === 'string' && /^\d+$/.test(data.busid) ? Number(data.busid) : undefined
  if (busId !== undefined && Number.isSafeInteger(busId) && busId >= 0) source.busId = busId
  const fileHash = safeString(data.file_hash, 512)
  if (fileHash !== undefined) source.fileHash = fileHash
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
    if (rawSegment.type === 'face') {
      const id = typeof data.id === 'number' && Number.isSafeInteger(data.id) ? String(data.id) : data.id
      if (typeof id === 'string' && /^(0|[1-9]\d{0,4})$/.test(id)) content.push({ type: 'face', id })
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
        : rawSegment.type === 'video' ? 'video'
          : rawSegment.type === 'file' ? /\.(?:mp4|m4v|mov|mkv|webm|avi|mpeg|mpg)$/i.test(fileName(data)) ? 'video' : 'file'
          : rawSegment.type === 'forward' && safeString(data.id, 512) !== undefined ? 'forward' : null
    if (kind === null) continue
    media.push(Object.freeze({ type: kind }))
    if (!context.register) continue
    const name = kind === 'video' ? rawSegment.type === 'file' ? fileName(data) : fileName({ name: data.name, file: '视频.mp4' })
      : kind === 'file' ? fileName(data) : undefined
    const assetId = await waitWithSignal(context.register({
        kind,
        messageId: context.messageId,
        conversationId: context.conversationId,
        ...(name === undefined ? {} : { name }),
        source: kind === 'forward' ? { id: String(data.id) } : sourceFromData(data),
      }, context.signal),
      context.signal,
    )
    if (typeof assetId !== 'string' || assetId.length === 0) {
      throw new TypeError('Incoming asset registrar returned an invalid asset identifier.')
    }
    if (kind === 'image') content.push({ type: 'image', assetId })
    else if (kind === 'audio') content.push({ type: 'audio', assetId })
    else if (kind === 'forward') content.push({ type: 'forward-reference', assetId })
    else content.push({ type: 'file', assetId, name: name ?? 'file' })
  }
  return { content, mentioned, media }
}

interface NormalizedOneBotEvent {
  message: InboundMessage
  media: readonly OneBotInboundMediaPreview[]
}

async function normalizeOneBotChatNotice(event: Record<string, unknown>, options: NormalizeOneBotOptions,
  allowEmptyContent: boolean): Promise<NormalizedOneBotEvent | null> {
  const configuredSelfId = positiveIdentifier(options.selfId)
  if (!configuredSelfId) return null
  const protocol = normalizeOneBotProtocolEvent(event, { selfId: configuredSelfId, receivedAt: (options.now ?? Date.now)() })
  if (!protocol || !projectOneBotNoticeForChat(protocol) || typeof protocol.userId !== 'string') return null
  const messageId = `onebot-notice:${protocol.id.slice('onebot:'.length)}`
  const signal = options.signal ?? new AbortController().signal
  let segments: readonly unknown[]
  const poke = protocol.type === 'protocol.group.poked' || protocol.type === 'protocol.private.poked'
  if (poke) segments = [{ type: 'text', data: { text: '[拍一拍] 对方戳了戳你。' } }]
  else {
    const file = protocol.data.file
    if (!record(file)) return null
    segments = [{ type: 'text', data: { text: '上传了一个群文件。' } }, { type: 'file', data: { id: file.id, name: file.name,
      ...(typeof file.busId === 'number' ? { busid: file.busId } : {}) } }]
  }
  const normalized = await normalizeSegments(segments, undefined, { messageId, conversationId: protocol.conversationId,
    register: options.registerIncomingAsset, signal })
  if (!normalized || normalized.content.length === 0 && !allowEmptyContent) return null
  let content: readonly MessageContent[]
  try { content = normalized.content.length ? normalizeContent(normalized.content) : Object.freeze([]) } catch { return null }
  return Object.freeze({ message: Object.freeze({ id: messageId, conversationId: protocol.conversationId, userId: protocol.userId,
    receivedAt: Number(protocol.data.occurredAt), content, directed: poke, isSelf: false }), media: Object.freeze(normalized.media) })
}

/** Normalize an authorized protocol read without inventing a new authenticated message sender. */
export async function normalizeOneBotContent(segments: unknown, options: {
  readonly messageId: string
  readonly conversationId: string
  readonly registerIncomingAsset?: OneBotIncomingAssetRegistrar
  readonly signal?: AbortSignal
}): Promise<readonly MessageContent[] | null> {
  if (messageIdentifier(options.messageId) === null || !/^(?:group|private):[1-9]\d{0,31}$/.test(options.conversationId)) return null
  const normalized = await normalizeSegments(segments, undefined, { messageId: options.messageId,
    conversationId: options.conversationId, register: options.registerIncomingAsset, signal: options.signal ?? new AbortController().signal })
  if (!normalized || normalized.content.length === 0) return null
  try { return normalizeContent(normalized.content) } catch { return null }
}

async function normalizeOneBotEvent(
  event: unknown,
  options: NormalizeOneBotOptions,
  allowEmptyContent: boolean,
): Promise<NormalizedOneBotEvent | null> {
  if (!record(event)) return null
  if (event.post_type === 'notice') return normalizeOneBotChatNotice(event, options, allowEmptyContent)
  if (event.post_type !== 'message') return null
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

export function isOneBotControlContent(event: unknown): boolean {
  if (!record(event)) return false
  if (typeof event.message === 'string') return !event.message.includes('[CQ:')
  return Array.isArray(event.message) && event.message.length > 0 && event.message.length <= MAX_CONTENT_SEGMENTS
    && event.message.every(segment => record(segment) && record(segment.data)
      && (segment.type === 'text' && typeof segment.data.text === 'string'
        || segment.type === 'at' && positiveIdentifier(segment.data.qq) !== null
        || segment.type === 'reply' && messageIdentifier(segment.data.id) !== null))
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
