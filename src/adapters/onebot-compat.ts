import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'

import type { JsonObject, JsonValue, DeliveryReceipt, SendRequest, TransportAdapter } from '../core/types.ts'
import { FrameworkError, isRecord, reference, snapshot } from '../core/values.ts'
import { createDurableTransport } from '../host/outbox.ts'
import { digest, json } from '../host/data.ts'
import type { DurableStore, StoredRecord } from '../host/types.ts'
import { createPersistentPolicy } from '../storage/policy.ts'

const FEATURE_ID = 'onebot.compat'
const COMMAND_NAMESPACE = 'commands'
const RESPONSE_NAMESPACE = 'responses'
const BUDGET_NAMESPACE = 'budget-settings'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_PENDING = 16
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_MAX_SEND_USES = Number.MAX_SAFE_INTEGER
const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_IDEMPOTENCY_KEY_BYTES = 512

type WriteAction = 'send_group_msg' | 'send_private_msg' | 'send_msg'
  | 'send_group_forward_msg' | 'send_private_forward_msg'
type CommandStatus = 'prepared' | 'authorized' | 'dispatching' | 'confirmed' | 'rejected' | 'unknown'

export interface OneBotCompatGatewayOptions {
  store: DurableStore
  upstreamEndpoint: string
  upstreamToken?: string
  token: string
  allowedConversations: readonly string[]
  persona: { id: string; version: string }
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxPending?: number
  maxBodyBytes?: number
  budgetEnabled?: boolean
  maxSendUses?: number
  grantTtlMs?: number | null
  authorizationVersion?: string
}

export interface OneBotCompatPolicyMetric {
  conversationId: string
  sendRemaining: number
  forwardRemaining: number
  expiresAt: number | null
  active: boolean
}

export interface OneBotCompatGatewayMetrics {
  closed: boolean
  pending: number
  maxPending: number
  requests: number
  reads: number
  writes: number
  rejected: number
  unknown: number
  recoveredUnknown: number
  policy: readonly OneBotCompatPolicyMetric[]
}

interface CompatCommand {
  schema: 1
  kind: 'onebot-compat-command'
  id: string
  action: WriteAction
  conversationId: string
  params: JsonObject
  fingerprint: string
  persona: { id: string; version: string }
  status: CommandStatus
  at: number
  receiptMessageId?: string
}

interface CompatResponse {
  schema: 1
  kind: 'onebot-compat-response'
  commandId: string
  statusCode: number
  body: JsonValue
}

interface BufferedResponse {
  statusCode: number
  body: JsonValue
}

interface ActionSelection {
  action: string
  conversationId?: string
  write: boolean
  forward: boolean
}

const READ_ACTIONS = new Set([
  'fetch_custom_face_detail',
  'fetch_face_entity',
  'fetch_ptt_text',
  'get_forward_msg',
  'get_friend_list',
  'get_group_list',
  'get_group_member_info',
  'get_group_member_list',
  'get_group_msg_history',
  'get_image',
  'get_login_info',
  'get_msg',
  'get_status',
  'get_stranger_info',
])

const WRITE_ACTIONS = new Set<WriteAction>([
  'send_group_msg',
  'send_private_msg',
  'send_msg',
  'send_group_forward_msg',
  'send_private_forward_msg',
])

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function sameToken(expected: Buffer, supplied: string): boolean {
  return timingSafeEqual(expected, sha256(supplied))
}

function positiveInteger(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) ? value : null
}

function conversation(value: string): { kind: 'group' | 'private'; id: string } | null {
  const match = /^(group|private):([1-9]\d*)$/.exec(value)
  if (!match || positiveInteger(match[2]) === null) return null
  return { kind: match[1] as 'group' | 'private', id: match[2]! }
}

function boundedInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || typeof selected !== 'number' || selected <= 0 || selected > maximum) {
    throw new TypeError(`${label} must be a bounded positive integer.`)
  }
  return selected
}

function scopedStore(store: DurableStore, prefix: string): DurableStore {
  const namespace = (value: string): string => `${prefix}${value}`
  const restore = (record: StoredRecord | null, requested: string): StoredRecord | null => record === null
    ? null
    : Object.freeze({ ...record, namespace: requested })
  const scoped: DurableStore = {
    read(requested, key) {
      return restore(store.read(namespace(requested), key), requested)
    },
    write(requested, key, value, options) {
      return restore(store.write(namespace(requested), key, value, options), requested)!
    },
    delete(requested, key, expectedRevision) {
      return store.delete(namespace(requested), key, expectedRevision)
    },
    list(requested, options) {
      return Object.freeze(store.list(namespace(requested), options).map(record => restore(record, requested)!))
    },
    purgeExpired(limit) {
      return store.purgeExpired(limit)
    },
    close() {},
  }
  return Object.freeze(scoped)
}

function actionUrl(endpoint: string, action: string): URL {
  const base = new URL(endpoint)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new TypeError('OneBot compatibility upstream must be a fixed HTTP endpoint.')
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return new URL(action, base)
}

function exactKeys(params: JsonObject, allowed: readonly string[], required: readonly string[] = []): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(params).every(key => allowedSet.has(key))
    && required.every(key => Object.hasOwn(params, key))
}

function optionalBoolean(value: JsonValue | undefined): boolean {
  return value === undefined || typeof value === 'boolean'
}

function messageId(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value !== 0
  return typeof value === 'string' && /^-?[1-9]\d*$/.test(value) && value.length <= 32
}

function validateRead(action: string, params: JsonObject): string | null | undefined {
  if (action === 'get_login_info' || action === 'get_status' || action === 'get_friend_list') {
    return exactKeys(params, []) ? null : undefined
  }
  if (action === 'get_group_list') {
    return exactKeys(params, ['no_cache']) && optionalBoolean(params.no_cache) ? null : undefined
  }
  if (action === 'get_group_member_list') {
    const groupId = positiveInteger(params.group_id)
    return groupId !== null && exactKeys(params, ['group_id', 'no_cache'], ['group_id'])
      && optionalBoolean(params.no_cache) ? `group:${groupId}` : undefined
  }
  if (action === 'get_group_member_info') {
    const groupId = positiveInteger(params.group_id)
    return groupId !== null && positiveInteger(params.user_id) !== null
      && exactKeys(params, ['group_id', 'user_id', 'no_cache'], ['group_id', 'user_id'])
      && optionalBoolean(params.no_cache) ? `group:${groupId}` : undefined
  }
  if (action === 'get_group_msg_history') {
    const groupId = positiveInteger(params.group_id)
    return groupId !== null && exactKeys(params, ['group_id', 'message_seq'], ['group_id'])
      && (params.message_seq === undefined || messageId(params.message_seq)) ? `group:${groupId}` : undefined
  }
  if (action === 'get_stranger_info') {
    return positiveInteger(params.user_id) !== null
      && exactKeys(params, ['user_id', 'no_cache'], ['user_id']) && optionalBoolean(params.no_cache)
      ? null : undefined
  }
  if (action === 'get_msg' || action === 'fetch_ptt_text') {
    return exactKeys(params, ['message_id'], ['message_id']) && messageId(params.message_id) ? null : undefined
  }
  if (action === 'get_forward_msg') {
    return exactKeys(params, ['id'], ['id'])
      && (typeof params.id === 'string' || typeof params.id === 'number')
      && String(params.id).length > 0 && String(params.id).length <= 160 ? null : undefined
  }
  if (action === 'get_image') {
    return exactKeys(params, ['file'], ['file']) && typeof params.file === 'string'
      && params.file.length > 0 && params.file.length <= 512 && !params.file.includes('..')
      && /^[A-Za-z0-9._+=@-]+$/.test(params.file)
      ? null : undefined
  }
  if (action === 'fetch_custom_face_detail') {
    return exactKeys(params, ['count'])
      && (params.count === undefined || typeof params.count === 'number'
        && Number.isSafeInteger(params.count) && params.count > 0 && params.count <= 500) ? null : undefined
  }
  if (action === 'fetch_face_entity') {
    return exactKeys(params, ['face_id', 'refresh'], ['face_id'])
      && typeof params.face_id === 'number' && Number.isSafeInteger(params.face_id) && params.face_id >= 0
      && optionalBoolean(params.refresh) ? null : undefined
  }
  return undefined
}

function selectAction(action: string, params: JsonObject): ActionSelection | null {
  if (READ_ACTIONS.has(action)) {
    const target = validateRead(action, params)
    return target === undefined ? null : { action, ...(target === null ? {} : { conversationId: target }), write: false, forward: false }
  }
  if (!WRITE_ACTIONS.has(action as WriteAction)) return null
  let kind: 'group' | 'private'
  let id: string | null
  if (action === 'send_group_msg' || action === 'send_group_forward_msg') {
    kind = 'group'
    id = positiveInteger(params.group_id)
  } else if (action === 'send_private_msg' || action === 'send_private_forward_msg') {
    kind = 'private'
    id = positiveInteger(params.user_id)
  } else {
    const messageType = params.message_type
    const groupId = positiveInteger(params.group_id)
    const userId = positiveInteger(params.user_id)
    if ((messageType === undefined || messageType === 'group') && groupId !== null && userId === null) {
      kind = 'group'
      id = groupId
    } else if ((messageType === undefined || messageType === 'private') && userId !== null && groupId === null) {
      kind = 'private'
      id = userId
    } else return null
  }
  if (id === null) return null
  const forward = action === 'send_group_forward_msg' || action === 'send_private_forward_msg'
  if (forward ? !Object.hasOwn(params, 'messages') : !Object.hasOwn(params, 'message')) return null
  return { action, conversationId: `${kind}:${id}`, write: true, forward }
}

function parseCommand(record: StoredRecord | null): CompatCommand | null {
  if (record === null || !isRecord(record.value)) return null
  const value = record.value
  if (value.schema !== 1 || value.kind !== 'onebot-compat-command' || typeof value.id !== 'string'
    || typeof value.action !== 'string' || !WRITE_ACTIONS.has(value.action as WriteAction)
    || typeof value.conversationId !== 'string' || !isRecord(value.params)
    || typeof value.fingerprint !== 'string' || !isRecord(value.persona)
    || typeof value.persona.id !== 'string' || typeof value.persona.version !== 'string'
    || !['prepared', 'authorized', 'dispatching', 'confirmed', 'rejected', 'unknown'].includes(String(value.status))
    || typeof value.at !== 'number' || !Number.isFinite(value.at)
    || value.receiptMessageId !== undefined && typeof value.receiptMessageId !== 'string') {
    throw new FrameworkError('INVALID_STORED_DATA', 'Stored compatibility command is invalid.')
  }
  return value as unknown as CompatCommand
}

function parseResponse(record: StoredRecord | null): CompatResponse | null {
  if (record === null || !isRecord(record.value)) return null
  const value = record.value
  if (value.schema !== 1 || value.kind !== 'onebot-compat-response' || typeof value.commandId !== 'string'
    || typeof value.statusCode !== 'number' || !Number.isSafeInteger(value.statusCode)
    || value.statusCode < 100 || value.statusCode > 599 || !Object.hasOwn(value, 'body')) {
    throw new FrameworkError('INVALID_STORED_DATA', 'Stored compatibility response is invalid.')
  }
  return value as unknown as CompatResponse
}

function readBody(request: IncomingMessage, maximum: number, signal: AbortSignal): Promise<Buffer | null> {
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
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(error)
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.byteLength
      if (size > maximum) {
        request.resume()
        finish(null)
      } else chunks.push(buffer)
    }
    const onEnd = (): void => finish(Buffer.concat(chunks, size))
    const onAborted = (): void => fail(new Error('Request aborted.'))
    const onSignal = (): void => fail(signal.reason)
    const cleanup = (): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', fail)
      request.off('aborted', onAborted)
      signal.removeEventListener('abort', onSignal)
    }
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', fail)
    request.once('aborted', onAborted)
    signal.addEventListener('abort', onSignal, { once: true })
    if (signal.aborted) onSignal()
  })
}

async function responseJson(response: Response, maximum: number, signal: AbortSignal): Promise<JsonValue> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maximum) throw new Error('Response too large.')
  if (!response.body) throw new Error('Response body missing.')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const result = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolvePromise, rejectPromise) => {
        const aborted = (): void => rejectPromise(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
        reader.read().then(value => {
          signal.removeEventListener('abort', aborted)
          resolvePromise(value)
        }, error => {
          signal.removeEventListener('abort', aborted)
          rejectPromise(error)
        })
        if (signal.aborted) aborted()
      })
      if (result.done) break
      size += result.value.byteLength
      if (size > maximum) throw new Error('Response too large.')
      chunks.push(Buffer.from(result.value))
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  }
  const parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown
  return snapshot(parsed) as JsonValue
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization
  if (typeof header !== 'string') return ''
  const match = /^Bearer ([^\s]+)$/.exec(header)
  return match?.[1] ?? ''
}

function sendJson(response: ServerResponse, statusCode: number, body: JsonValue): void {
  if (response.headersSent || response.destroyed) return
  const encoded = JSON.stringify(body)
  response.statusCode = statusCode
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', Buffer.byteLength(encoded))
  response.end(encoded)
}

function failure(statusCode: number, wording: string): BufferedResponse {
  return { statusCode, body: { status: 'failed', retcode: statusCode, data: null, wording } }
}

function classifyResponse(response: BufferedResponse, fallbackMessageId: string): DeliveryReceipt {
  if (response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 400
    || response.statusCode === 404 || response.statusCode === 409 || response.statusCode === 422) {
    return { status: 'rejected' }
  }
  if (response.statusCode < 200 || response.statusCode >= 300 || !isRecord(response.body)
    || !Number.isSafeInteger(response.body.retcode)) return { status: 'unknown' }
  if (response.body.retcode !== 0) return { status: 'rejected' }
  if (response.body.status === 'failed') return { status: 'unknown' }
  const data = response.body.data
  const rawMessageId = isRecord(data) ? data.message_id : undefined
  const confirmedId = messageId(rawMessageId) ? String(rawMessageId) : fallbackMessageId
  return { status: 'confirmed', messageId: confirmedId }
}

export function createOneBotCompatGateway(options: OneBotCompatGatewayOptions): Readonly<{
  handle: RequestListener
  metrics(): OneBotCompatGatewayMetrics
  close(): Promise<void>
}> {
  if (!options || !options.store || typeof options.store.read !== 'function') {
    throw new TypeError('OneBot compatibility gateway requires a durable store.')
  }
  if (typeof options.token !== 'string' || options.token.length === 0 || options.token.length > 4096) {
    throw new TypeError('OneBot compatibility gateway requires a bounded token.')
  }
  if (!isRecord(options.persona) || typeof options.persona.id !== 'string' || options.persona.id.length === 0
    || typeof options.persona.version !== 'string' || options.persona.version.length === 0) {
    throw new TypeError('OneBot compatibility gateway requires a persona identity.')
  }
  if (!Array.isArray(options.allowedConversations)
    || options.allowedConversations.length > 1_000) {
    throw new TypeError('OneBot compatibility gateway requires explicit allowed conversations.')
  }
  const allowed = new Set<string>()
  for (const value of options.allowedConversations) {
    if (typeof value !== 'string' || conversation(value) === null || allowed.has(value)) {
      throw new TypeError('Allowed conversations must be unique group or private identifiers.')
    }
    allowed.add(value)
  }
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 300_000, 'Gateway timeout')
  const maxPending = boundedInteger(options.maxPending, DEFAULT_MAX_PENDING, 256, 'Gateway pending limit')
  const maxBodyBytes = boundedInteger(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, MAX_BODY_BYTES, 'Gateway body limit')
  if (options.budgetEnabled !== undefined && typeof options.budgetEnabled !== 'boolean') {
    throw new TypeError('Gateway budget switch must be boolean.')
  }
  const configuredMaxSendUses = boundedInteger(options.maxSendUses, DEFAULT_MAX_SEND_USES,
    Number.MAX_SAFE_INTEGER, 'Gateway send budget')
  const configuredGrantTtlMs = options.grantTtlMs === undefined || options.grantTtlMs === null ? null
    : boundedInteger(options.grantTtlMs, 1, 366 * 24 * 60 * 60 * 1_000, 'Gateway grant TTL')
  const budgetEnabled = options.budgetEnabled !== false
  const maxSendUses = budgetEnabled ? configuredMaxSendUses : DEFAULT_MAX_SEND_USES
  const grantTtlMs = budgetEnabled ? configuredGrantTtlMs : null
  const authorizationVersion = options.authorizationVersion ?? '1'
  if (!reference(authorizationVersion)) {
    throw new TypeError('Gateway authorization version must be a bounded non-empty string.')
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch
  if (typeof fetchImplementation !== 'function') throw new TypeError('OneBot compatibility gateway requires fetch.')
  const persona = snapshot({ id: options.persona.id, version: options.persona.version })
  const personaDigest = digest(persona)
  const store = scopedStore(options.store, `onebot.compat.${personaDigest}.`)
  const policy = createPersistentPolicy({ store })
  const budgetSettings = snapshot({ schema: 1, budgetEnabled, maxSendUses: configuredMaxSendUses,
    grantTtlMs: configuredGrantTtlMs })
  const expectedToken = sha256(options.token)
  const upstreamToken = options.upstreamToken
  const urls = new Map<string, URL>()
  for (const action of [...READ_ACTIONS, ...WRITE_ACTIONS]) urls.set(action, actionUrl(options.upstreamEndpoint, action))
  const grantId = (conversationId: string): string => `compat-${digest({ persona, conversationId, authorizationVersion }).slice(0, 48)}`
  const currentGrantIds = new Set([...allowed].map(grantId))
  const configuredGrants = policy.describe().grants
  const ensureBudgetSettings = (id: string): void => {
    const current = store.read(BUDGET_NAMESPACE, id)
    if (current) {
      const value = current.value
      const matches = isRecord(value) && value.schema === budgetSettings.schema
        && value.budgetEnabled === budgetSettings.budgetEnabled
        && value.maxSendUses === budgetSettings.maxSendUses
        && value.grantTtlMs === budgetSettings.grantTtlMs
      if (!matches) throw new FrameworkError('POLICY_CONFLICT', 'Stored compatibility budget differs from configuration.')
      return
    }
    try {
      store.write(BUDGET_NAMESPACE, id, budgetSettings, { expectedRevision: null })
    } catch (error) {
      const stored = store.read(BUDGET_NAMESPACE, id)
      if (!stored || digest(stored.value) !== digest(budgetSettings)) throw error
    }
  }
  for (const grant of configuredGrants) {
    if (grant.featureId === FEATURE_ID && !currentGrantIds.has(grant.id)) policy.revoke(grant.id)
  }
  for (const conversationId of allowed) {
    const id = grantId(conversationId)
    const existing = configuredGrants.find(grant => grant.id === id)
    if (existing) {
      const sameGrant = existing.featureId === FEATURE_ID && existing.conversationId === conversationId
        && existing.maxUses['messaging.send'] === maxSendUses
        && existing.maxUses['messaging.forward'] === maxSendUses
        && (grantTtlMs === null ? existing.expiresAt === null : existing.expiresAt !== null)
      if (!sameGrant) throw new FrameworkError('POLICY_CONFLICT', 'Stored compatibility policy differs from configuration.')
      ensureBudgetSettings(id)
      continue
    }
    ensureBudgetSettings(id)
    try {
      policy.grant({
        id,
        featureId: FEATURE_ID,
        conversationId,
        capabilities: ['messaging.send', 'messaging.forward'],
        maxUses: { 'messaging.send': maxSendUses, 'messaging.forward': maxSendUses },
        expiresAt: grantTtlMs === null ? null : Date.now() + grantTtlMs,
      })
    } catch (error) {
      if (!(error instanceof FrameworkError && error.code === 'GRANT_EXISTS')) throw error
    }
  }

  let closed = false
  let requests = 0
  let reads = 0
  let writes = 0
  let rejected = 0
  let unknown = 0
  let recoveredUnknown = 0
  let closePromise: Promise<void> | null = null
  const shutdown = new AbortController()
  const pendingOperations = new Set<Promise<BufferedResponse>>()
  const activeWrites = new Map<string, { fingerprint: string; promise: Promise<BufferedResponse> }>()
  const activeHandlers = new Set<Promise<void>>()

  function updateCommand(record: StoredRecord, change: Partial<CompatCommand>): StoredRecord {
    const current = parseCommand(record)
    if (current === null) throw new FrameworkError('INVALID_STORED_DATA', 'Compatibility command is missing.')
    const nextStatus = change.status
    if (nextStatus === 'unknown' && current.status !== 'unknown') unknown += 1
    return store.write(COMMAND_NAMESPACE, record.key, json({ ...current, ...change, at: Date.now() }), {
      expectedRevision: record.revision,
    })
  }

  async function upstream(action: string, params: JsonObject, requestSignal: AbortSignal): Promise<BufferedResponse> {
    if (closed || pendingOperations.size >= maxPending) throw new FrameworkError('UPSTREAM_BACKPRESSURE', 'Upstream is unavailable.')
    const signal = AbortSignal.any([requestSignal, shutdown.signal, AbortSignal.timeout(timeoutMs)])
    const operation = (async (): Promise<BufferedResponse> => {
      const headers = new Headers({ 'content-type': 'application/json' })
      if (upstreamToken) headers.set('authorization', `Bearer ${upstreamToken}`)
      const response = await fetchImplementation(urls.get(action)!, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        redirect: 'error',
        signal,
      })
      return { statusCode: response.status, body: await responseJson(response, maxBodyBytes, signal) }
    })()
    pendingOperations.add(operation)
    void operation.then(() => pendingOperations.delete(operation), () => pendingOperations.delete(operation))
    return new Promise<BufferedResponse>((resolvePromise, rejectPromise) => {
      const aborted = (): void => {
        signal.removeEventListener('abort', aborted)
        rejectPromise(signal.reason)
      }
      signal.addEventListener('abort', aborted, { once: true })
      operation.then(result => {
        signal.removeEventListener('abort', aborted)
        resolvePromise(result)
      }, error => {
        signal.removeEventListener('abort', aborted)
        rejectPromise(error)
      })
      if (signal.aborted) aborted()
    })
  }

  const transport: TransportAdapter = {
    async send(request: SendRequest): Promise<DeliveryReceipt> {
      const key = digest(request.idempotencyKey)
      let stored = store.read(COMMAND_NAMESPACE, key)
      const command = parseCommand(stored)
      if (stored === null || command === null || command.id !== request.idempotencyKey) return { status: 'unknown' }
      if (command.status !== 'prepared') {
        if (command.status === 'confirmed') return { status: 'confirmed', messageId: command.receiptMessageId ?? command.fingerprint }
        return { status: command.status === 'rejected' ? 'rejected' : 'unknown' }
      }
      try {
        const sendReservation = policy.reserve({
          featureId: FEATURE_ID,
          conversationId: command.conversationId,
          capability: 'messaging.send',
        })
        const forwardReservation = command.action === 'send_group_forward_msg' || command.action === 'send_private_forward_msg'
          ? policy.reserve({ featureId: FEATURE_ID, conversationId: command.conversationId, capability: 'messaging.forward' })
          : null
        policy.begin(sendReservation)
        if (forwardReservation) policy.begin(forwardReservation)
        stored = updateCommand(stored, { status: 'authorized' })
      } catch {
        const denied = failure(403, 'compat gateway policy denied')
        try {
          store.write(RESPONSE_NAMESPACE, key, json({ schema: 1, kind: 'onebot-compat-response',
            commandId: command.id, statusCode: denied.statusCode, body: denied.body }), { expectedRevision: null })
          updateCommand(stored, { status: 'rejected' })
        } catch {}
        return { status: 'rejected' }
      }
      stored = updateCommand(stored, { status: 'dispatching' })
      let result: BufferedResponse
      try {
        result = await upstream(command.action, command.params, request.signal)
      } catch {
        try { updateCommand(stored, { status: 'unknown' }) } catch {}
        return { status: 'unknown' }
      }
      try {
        store.write(RESPONSE_NAMESPACE, key, json({ schema: 1, kind: 'onebot-compat-response',
          commandId: command.id, statusCode: result.statusCode, body: result.body }), { expectedRevision: null })
      } catch {
        try { updateCommand(stored, { status: 'unknown' }) } catch {}
        return { status: 'unknown' }
      }
      const receipt = classifyResponse(result, command.fingerprint)
      try {
        updateCommand(stored, {
          status: receipt.status,
          ...(receipt.status === 'confirmed' ? { receiptMessageId: receipt.messageId } : {}),
        })
      } catch {
        return { status: 'unknown' }
      }
      return receipt
    },
  }
  Object.freeze(transport)
  const outbox = createDurableTransport({ store, transport })
  recoveredUnknown += outbox.recover()

  let after: string | undefined
  do {
    const page = store.list(COMMAND_NAMESPACE, after === undefined ? { limit: 1_000 } : { limit: 1_000, after })
    for (const record of page) {
      const command = parseCommand(record)
      if (!command) continue
      if (command.status === 'unknown') unknown += 1
      else if (['prepared', 'authorized', 'dispatching'].includes(command.status)) {
        try {
          updateCommand(record, { status: 'unknown' })
          recoveredUnknown += 1
        } catch (error) {
          if (!(error instanceof FrameworkError && error.code === 'STORE_CONFLICT')) throw error
        }
      }
    }
    after = page.length === 1_000 ? page.at(-1)!.key : undefined
  } while (after !== undefined)

  function storedResult(commandId: string): BufferedResponse | null {
    const stored = parseResponse(store.read(RESPONSE_NAMESPACE, digest(commandId)))
    return stored === null ? null : { statusCode: stored.statusCode, body: stored.body }
  }

  async function process(request: IncomingMessage, response: ServerResponse): Promise<void> {
    requests += 1
    if (closed) {
      rejected += 1
      sendJson(response, 503, failure(503, 'compat gateway closed').body)
      return
    }
    if (request.method !== 'POST') {
      rejected += 1
      request.resume()
      sendJson(response, 405, failure(405, 'compat gateway method denied').body)
      return
    }
    if (!sameToken(expectedToken, bearer(request))) {
      rejected += 1
      request.resume()
      sendJson(response, 401, failure(401, 'compat gateway unauthorized').body)
      return
    }
    let url: URL
    try { url = new URL(request.url ?? '/', 'http://compat.invalid') } catch {
      rejected += 1
      request.resume()
      sendJson(response, 404, failure(404, 'compat gateway action denied').body)
      return
    }
    const actionMatch = /^\/([a-z][a-z0-9_]*)$/.exec(url.pathname)
    if (!actionMatch || url.search || url.hash) {
      rejected += 1
      request.resume()
      sendJson(response, 404, failure(404, 'compat gateway action denied').body)
      return
    }
    const declaredLength = Number(request.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      rejected += 1
      request.resume()
      sendJson(response, 413, failure(413, 'compat gateway request too large').body)
      return
    }
    let body: Buffer | null
    try { body = await readBody(request, maxBodyBytes, AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs)])) } catch {
      rejected += 1
      sendJson(response, 408, failure(408, 'compat gateway request timeout').body)
      return
    }
    if (body === null) {
      rejected += 1
      sendJson(response, 413, failure(413, 'compat gateway request too large').body)
      return
    }
    let params: JsonObject
    try {
      const parsed = JSON.parse(body.toString('utf8')) as unknown
      if (!isRecord(parsed)) throw new Error('not an object')
      params = snapshot(parsed) as JsonObject
    } catch {
      rejected += 1
      sendJson(response, 400, failure(400, 'compat gateway invalid request').body)
      return
    }
    const selected = selectAction(actionMatch[1]!, params)
    if (!selected || selected.conversationId !== undefined && !allowed.has(selected.conversationId)) {
      rejected += 1
      sendJson(response, selected ? 403 : 404, failure(selected ? 403 : 404, 'compat gateway action denied').body)
      return
    }
    const requestController = new AbortController()
    request.once('aborted', () => requestController.abort())
    response.once('close', () => { if (!response.writableEnded) requestController.abort() })
    if (!selected.write) {
      reads += 1
      try {
        const result = await upstream(selected.action, params, requestController.signal)
        sendJson(response, result.statusCode, result.body)
      } catch {
        rejected += 1
        sendJson(response, pendingOperations.size >= maxPending ? 503 : 502,
          failure(pendingOperations.size >= maxPending ? 503 : 502, 'compat gateway upstream unavailable').body)
      }
      return
    }
    writes += 1
    const suppliedKey = request.headers['x-idempotency-key']
    if (Array.isArray(suppliedKey) || suppliedKey !== undefined
      && (typeof suppliedKey !== 'string' || suppliedKey.length === 0
        || Buffer.byteLength(suppliedKey) > MAX_IDEMPOTENCY_KEY_BYTES || /[\x00-\x1f\x7f]/.test(suppliedKey))) {
      rejected += 1
      sendJson(response, 400, failure(400, 'compat gateway invalid idempotency key').body)
      return
    }
    const sourceKey = typeof suppliedKey === 'string' ? suppliedKey : randomUUID()
    const commandId = `onebot-compat-${digest({ persona, sourceKey })}`
    const commandKey = digest(commandId)
    const fingerprint = digest({ schema: 1, action: selected.action, conversationId: selected.conversationId, params, persona })
    let commandRecord = store.read(COMMAND_NAMESPACE, commandKey)
    if (commandRecord) {
      const existing = parseCommand(commandRecord)
      if (!existing || existing.id !== commandId || existing.fingerprint !== fingerprint) {
        rejected += 1
        sendJson(response, 409, failure(409, 'compat gateway idempotency conflict').body)
        return
      }
      const active = activeWrites.get(commandId)
      if (active) {
        if (active.fingerprint !== fingerprint) {
          rejected += 1
          sendJson(response, 409, failure(409, 'compat gateway idempotency conflict').body)
          return
        }
        const shared = await active.promise
        sendJson(response, shared.statusCode, shared.body)
        return
      }
      const prior = storedResult(commandId)
      if (prior) {
        sendJson(response, prior.statusCode, prior.body)
        return
      }
      if (existing.status !== 'prepared') {
        sendJson(response, 502, failure(502, 'compat delivery result unknown').body)
        return
      }
    } else {
      try {
        commandRecord = store.write(COMMAND_NAMESPACE, commandKey, json({
          schema: 1,
          kind: 'onebot-compat-command',
          id: commandId,
          action: selected.action,
          conversationId: selected.conversationId!,
          params,
          fingerprint,
          persona,
          status: 'prepared',
          at: Date.now(),
        }), { expectedRevision: null })
      } catch (error) {
        if (!(error instanceof FrameworkError && error.code === 'STORE_CONFLICT')) throw error
        commandRecord = store.read(COMMAND_NAMESPACE, commandKey)
        const existing = parseCommand(commandRecord)
        if (!existing || existing.id !== commandId || existing.fingerprint !== fingerprint) {
          rejected += 1
          sendJson(response, 409, failure(409, 'compat gateway idempotency conflict').body)
          return
        }
      }
    }
    const delivery = (async (): Promise<BufferedResponse> => {
      try {
        await outbox.send({
          conversationId: selected.conversationId!,
          idempotencyKey: commandId,
          content: [{ type: 'text', text: `onebot-compat:v1:${fingerprint}` }],
          scope: { persona },
          signal: requestController.signal,
        })
      } catch {
        try {
          const latest = store.read(COMMAND_NAMESPACE, commandKey)
          if (latest && parseCommand(latest)?.status !== 'unknown') updateCommand(latest, { status: 'unknown' })
        } catch {}
      }
      return storedResult(commandId) ?? failure(502, 'compat delivery result unknown')
    })()
    activeWrites.set(commandId, { fingerprint, promise: delivery })
    void delivery.then(() => activeWrites.delete(commandId), () => activeWrites.delete(commandId))
    const result = await delivery
    sendJson(response, result.statusCode, result.body)
  }

  const handle: RequestListener = (request, response) => {
    if (activeHandlers.size >= maxPending * 2) {
      rejected += 1
      request.resume()
      sendJson(response, 503, failure(503, 'compat gateway request capacity reached').body)
      return
    }
    const handler = process(request, response).catch(() => {
      rejected += 1
      sendJson(response, 500, failure(500, 'compat gateway internal failure').body)
    })
    activeHandlers.add(handler)
    void handler.then(() => activeHandlers.delete(handler), () => activeHandlers.delete(handler))
  }

  return Object.freeze({
    handle,
    metrics(): OneBotCompatGatewayMetrics {
      const grants = policy.describe().grants
      const policyMetrics = [...allowed].sort().map(conversationId => {
        const grant = grants.find(candidate => candidate.id === grantId(conversationId))!
        return {
          conversationId,
          sendRemaining: Math.max(0, grant.maxUses['messaging.send']! - grant.used['messaging.send']!),
          forwardRemaining: Math.max(0, grant.maxUses['messaging.forward']! - grant.used['messaging.forward']!),
          expiresAt: grant.expiresAt,
          active: grant.active,
        }
      })
      return snapshot({ closed, pending: pendingOperations.size, maxPending, requests, reads, writes,
        rejected, unknown, recoveredUnknown, policy: policyMetrics })
    },
    close(): Promise<void> {
      if (closePromise) return closePromise
      closed = true
      shutdown.abort()
      closePromise = (async () => {
        while (activeHandlers.size > 0 || activeWrites.size > 0 || pendingOperations.size > 0) {
          await Promise.allSettled([
            ...activeHandlers,
            ...[...activeWrites.values()].map(active => active.promise),
            ...pendingOperations,
          ])
        }
      })()
      return closePromise
    },
  })
}
