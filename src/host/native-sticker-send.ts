import type { EffectAdapter, JsonValue } from '../core/types.ts'
import { assert, isRecord } from '../core/values.ts'
import { digest, json } from './data.ts'
import { withDeadline } from './deadlines.ts'
import type { NativeToolContribution } from './native-framework-tools.ts'
import type { NativeMessageSourceReader } from './native-message-sources.ts'
import { NATIVE_REPLY_TOOLS } from './native-reply-tools.ts'
import type { StickerLibrary } from './sticker-library.ts'

export const NATIVE_STICKER_SEND_TOOLS: readonly NativeToolContribution[] = [{
  definition: { name: 'qbf_sticker_send', capability: 'native.stickers.send', featureId: 'framework-tools', timeoutMs: 10_000,
    registrationSource: { origin: 'framework-builtin', ownerId: 'qq-bridge-framework', ownerName: '框架内置工具', transport: 'native' },
    description: '向当前QQ会话发表情，按普通回复发送，无主人权限。只给简短表达意图，内置机制按表情库语义标签即时匹配，不调用模型选图；可附一句随图文字。无需主会话列库、看图或打标。没有合适的图或从调用起10秒内未完成就静默放弃，晚到不补发。本工具无论成功、失败、不适合或超时均结束当前回合，回执不需要解释或追加文字；不要为了补发再调用。先完成本轮其他必要工作再调用。',
    parameters: { type: 'object', additionalProperties: false, required: ['intent'], properties: {
      intent: { type: 'string', minLength: 1, maxLength: 240, description: '想表达的情绪与语境；例如轻松回应朋友的夸奖。' },
      text: { type: 'string', maxLength: 500, description: '可选，与表情一起发送的自然短句；不适合或超时则一起放弃。' },
    } } },
  validate(input) {
    assert(isRecord(input) && Object.keys(input).every(key => ['intent', 'text'].includes(key))
      && typeof input.intent === 'string' && input.intent.trim().length > 0 && input.intent.length <= 240
      && (input.text === undefined || typeof input.text === 'string' && input.text.length <= 500), 'INVALID_STICKER_INPUT', 'Use a short expression intent.')
    return input
  }, deliveryCapabilities: ['messaging.send'],
  async afterInvoke(value, execution, event, host) {
    execution.signal.throwIfAborted()
    if (!isRecord(value) || value.status === 'skipped' || typeof value.deadlineAt !== 'number' || Date.now() >= value.deadlineAt)
      return { status: 'skipped', quiet: true }
    const deadlineAt = value.deadlineAt
    const deliver = NATIVE_REPLY_TOOLS[0]!.afterInvoke!
    // Keep the admitted policy/outbox execution. The wrapper fences the final
    // dispatch too, in case output preparation finishes after the selection budget.
    return withDeadline({ signal: execution.signal, timeoutMs: Math.max(1, deadlineAt - Date.now()),
      code: 'STICKER_SEND_TIMEOUT', run: signal => deliver(value, { ...execution, signal,
        async send(content) {
          signal.throwIfAborted()
          assert(Date.now() < deadlineAt, 'STICKER_SEND_TIMEOUT', 'The expression selection expired.')
          return execution.send(content)
        },
      }, event, host) })
  },
}]

export function createNativeStickerSendEffect(options: {
  readonly library: () => Pick<StickerLibrary, 'choose'> | undefined
  readonly sources: () => NativeMessageSourceReader | undefined
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>
}): EffectAdapter {
  return { async execute(request): Promise<JsonValue> {
    const deadlineAt = Date.now() + 10_000
    return withDeadline<JsonValue>({ signal: request.signal, timeoutMs: 10_000, code: 'STICKER_SEND_TIMEOUT', run: async (signal): Promise<JsonValue> => {
      await options.authorize(request.scope.conversationId, signal)
      signal.throwIfAborted()
      const sources = options.sources(), library = options.library()
      assert(sources && library, 'NATIVE_STICKERS_UNAVAILABLE', 'The sticker helper is unavailable.')
      const source = await sources.lookup(request.scope, signal)
      signal.throwIfAborted()
      assert(isRecord(request.input) && typeof request.input.intent === 'string', 'INVALID_STICKER_INPUT', 'Use a short expression intent.')
      const assetId = await library.choose(request.input.intent, request.scope.conversationId, signal, deadlineAt)
      if (!assetId || signal.aborted || Date.now() >= deadlineAt) return { status: 'skipped', quiet: true }
      return { status: 'selected', deadlineAt, nativeRequestId: digest([source.conversationId, source.sourceMessageId, 'prompt']),
        content: json([...(typeof request.input.text === 'string' && request.input.text.trim() ? [{ type: 'text', text: request.input.text }] : []), { type: 'image', assetId }]) }
    } })
  } }
}
