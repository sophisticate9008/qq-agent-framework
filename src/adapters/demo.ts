import { FrameworkError, assert, snapshot } from '../core/values.ts'
import { normalizeContent } from '../core/content.ts'
import type {
  DeliveryReceipt,
  JsonObject,
  JsonValue,
  ModelAdapter,
  ModelRequest,
  SendRequest,
  MessageContent,
  TransportAdapter,
} from '../core/types.ts'

type ConfirmedReceipt = Extract<DeliveryReceipt, { status: 'confirmed' }>

export interface DemoMessage {
  readonly conversationId: string
  readonly content: readonly MessageContent[]
  readonly idempotencyKey: string
  readonly status: 'confirmed'
  readonly messageId: string
}

export interface DemoTransport extends TransportAdapter {
  send(request: SendRequest): Promise<DeliveryReceipt>
  describe(): readonly DemoMessage[]
}

export interface DemoModel extends ModelAdapter {
  generate(request: ModelRequest): Promise<{ text: string }>
}

function stableValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stableValue)
  }
  if (value !== null && typeof value === 'object') {
    const sorted: JsonObject = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = stableValue(value[key]!)
    }
    return sorted
  }
  return value
}

function stableStringify(value: unknown): string {
  const serialized = JSON.stringify(stableValue(snapshot(value) as JsonValue))
  if (serialized === undefined) {
    throw new FrameworkError('INVALID_DATA', 'Expected JSON data.')
  }
  return serialized
}

function assertRequest(request: SendRequest): void {
  assert(request && typeof request === 'object', 'INVALID_REQUEST', 'Demo transport request must be an object.')
  assert(typeof request.conversationId === 'string' && request.conversationId.length > 0,
    'INVALID_REQUEST', 'Demo transport requires a conversation identifier.')
  assert(Array.isArray(request.content), 'INVALID_REQUEST', 'Demo transport content must be an array.')
  assert(typeof request.idempotencyKey === 'string' && request.idempotencyKey.length > 0,
    'INVALID_REQUEST', 'Demo transport requires an idempotency key.')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new FrameworkError('ABORTED', 'Demo operation was aborted.')
  }
}

export function createDemoTransport(): DemoTransport {
  const messages: DemoMessage[] = []
  const deliveries = new Map<string, { fingerprint: string; receipt: ConfirmedReceipt }>()

  return Object.freeze({
    async send(request: SendRequest): Promise<DeliveryReceipt> {
      assertRequest(request)
      throwIfAborted(request.signal)
      const storedRequest = snapshot({
        conversationId: request.conversationId,
        content: normalizeContent(request.content),
        idempotencyKey: request.idempotencyKey,
      })
      const fingerprint = stableStringify({
        conversationId: storedRequest.conversationId,
        content: storedRequest.content,
      })
      const previous = deliveries.get(storedRequest.idempotencyKey)

      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          return snapshot({ status: 'rejected' })
        }
        return previous.receipt
      }

      const receipt: ConfirmedReceipt = snapshot({
        status: 'confirmed',
        messageId: `demo-message-${messages.length + 1}`,
      })
      const message: DemoMessage = snapshot({ ...storedRequest, ...receipt })
      messages.push(message)
      deliveries.set(storedRequest.idempotencyKey, { fingerprint, receipt })
      return receipt
    },

    describe(): readonly DemoMessage[] {
      return snapshot(messages)
    },
  })
}

export function createDemoModel(): DemoModel {
  return Object.freeze({
    async generate({ prompt, signal }: ModelRequest): Promise<{ text: string }> {
      throwIfAborted(signal)
      const promptSnapshot = snapshot(prompt)
      const renderedPrompt = typeof promptSnapshot === 'string'
        ? promptSnapshot
        : stableStringify(promptSnapshot)
      return snapshot({ text: `[演示] ${renderedPrompt}` })
    },
  })
}
