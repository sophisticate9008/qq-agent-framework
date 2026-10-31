import type { EffectAdapter, JsonValue } from '../core/types.ts'
import { assert, isRecord } from '../core/values.ts'
import { digest, json } from './data.ts'
import { DEFAULT_STICKER_SENDING_CONFIGURATION, type StickerSendingConfiguration } from '../contracts/sticker-sending.ts'
import type { StickerSelectionRequest } from './sticker-dsh-selector.ts'
import type { NativeToolContribution } from './native-framework-tools.ts'
import type { NativeMessageSourceReader } from './native-message-sources.ts'
import { NATIVE_REPLY_TOOLS } from './native-reply-tools.ts'
import type { StickerLibrary } from './sticker-library.ts'

export const NATIVE_STICKER_SEND_TOOLS: readonly NativeToolContribution[] = [{
  definition: { name: 'qbf_sticker_send', capability: 'native.stickers.send', featureId: 'framework-tools', timeoutMs: 120_000,
    registrationSource: { origin: 'framework-builtin', ownerId: 'qq-bridge-framework', ownerName: '框架内置工具', transport: 'native' },
    description: '向当前QQ会话发表情，按普通回复发送，无主人权限。给简短表达意图；只有明确指定角色时才填写character，未知或没有该角色就静默放弃，不换角色。通常优先表达用途、情绪和语境。按设置使用本地标注匹配，并可由独立DSH会话筛选少量候选；无需主会话列库、看图或打标。可附一句随图文字。没有合适图或辅助请求超过配置等待上限就静默放弃，不补发。本工具无论成功、失败、不适合或超时均结束当前回合，回执不需要解释或追加文字；不要为了补发再调用。先完成本轮其他必要工作再调用。',
    parameters: { type: 'object', additionalProperties: false, required: ['intent'], properties: {
      intent: { type: 'string', minLength: 1, maxLength: 240, description: '想表达的情绪与语境；例如轻松回应朋友的夸奖。' },
      character: { type: 'string', minLength: 1, maxLength: 64, description: '可选，明确要求的角色名称或别名；找不到时放弃，不换角色。' },
      text: { type: 'string', maxLength: 500, description: '可选，与表情一起发送的自然短句；不适合或超时则一起放弃。' },
    } } },
  validate(input) {
    assert(isRecord(input) && Object.keys(input).every(key => ['intent', 'character', 'text'].includes(key))
      && typeof input.intent === 'string' && input.intent.trim().length > 0 && input.intent.length <= 240
      && (input.character === undefined || typeof input.character === 'string' && input.character.trim().length > 0
        && input.character.length <= 64 && !/[\x00-\x1f\x7f]/.test(input.character))
      && (input.text === undefined || typeof input.text === 'string' && input.text.length <= 500), 'INVALID_STICKER_INPUT', 'Use a short expression intent.')
    return input
  }, deliveryCapabilities: ['messaging.send'],
  async afterInvoke(value, execution, event, host) {
    execution.signal.throwIfAborted()
    if (!isRecord(value) || value.status !== 'selected')
      return { status: 'skipped', quiet: true }
    const deliver = NATIVE_REPLY_TOOLS[0]!.afterInvoke!
    // The configured timer limits auxiliary model work. Once selected, delivery
    // follows the original ticket, reply policy and outbox cancellation fences.
    return deliver(value, execution, event, host)
  },
}]

export function createNativeStickerSendEffect(options: {
  readonly library: () => Pick<StickerLibrary, 'choose'> | undefined
  readonly sources: () => NativeMessageSourceReader | undefined
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>
  readonly configuration?: () => Promise<StickerSendingConfiguration>
  readonly selector?: (request: StickerSelectionRequest) => Promise<string | null>
}): EffectAdapter {
  return { async execute(request): Promise<JsonValue> {
    const startedAt = Date.now(), signal = request.signal
    const configuration = options.configuration ? await options.configuration() : { ...DEFAULT_STICKER_SENDING_CONFIGURATION, useAiSelection: false }
    signal.throwIfAborted()
    const deadlineAt = configuration.useAiSelection ? startedAt + 1000 * configuration.dshSelectionTimeoutSeconds : Infinity
    if (configuration.useAiSelection && !options.selector) return { status: 'skipped', quiet: true }
    await options.authorize(request.scope.conversationId, signal)
    signal.throwIfAborted()
    const sources = options.sources(), library = options.library()
    assert(sources && library, 'NATIVE_STICKERS_UNAVAILABLE', 'The sticker helper is unavailable.')
    const source = await sources.lookup(request.scope, signal)
    signal.throwIfAborted()
    assert(isRecord(request.input) && typeof request.input.intent === 'string', 'INVALID_STICKER_INPUT', 'Use a short expression intent.')
    const assetId = await library.choose(request.input.intent, request.scope.conversationId, signal, deadlineAt,
      typeof request.input.character === 'string' ? request.input.character : undefined,
      configuration.useAiSelection ? options.selector : undefined)
    if (!assetId || signal.aborted || Date.now() >= deadlineAt) return { status: 'skipped', quiet: true }
    return { status: 'selected', nativeRequestId: digest([source.conversationId, source.sourceMessageId, 'prompt']),
      content: json([...(typeof request.input.text === 'string' && request.input.text.trim() ? [{ type: 'text', text: request.input.text }] : []), { type: 'image', assetId }]) }
  } }
}
