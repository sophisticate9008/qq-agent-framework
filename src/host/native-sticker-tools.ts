import type { OneBotStickerPort } from '../adapters/onebot-stickers.ts';
import type { OneBotIncomingAssetRegistrar } from '../adapters/onebot.ts';
import type { EffectAdapter, JsonValue } from '../core/types.ts';
import { assert, isRecord } from '../core/values.ts';
import { digest } from './data.ts';
import type { NativeToolContribution } from './native-framework-tools.ts';

function validate(input: JsonValue): { query: string; limit: number } {
  assert(isRecord(input) && Object.keys(input).every(key => ['query', 'limit'].includes(key))
    && (input.query === undefined || typeof input.query === 'string' && input.query.length <= 128 && !/[\x00-\x1f\x7f]/.test(input.query))
    && (input.limit === undefined || typeof input.limit === 'number' && Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 50),
  'INVALID_STICKER_INPUT', 'Sticker listing accepts an optional bounded query and a limit from 1 to 50.');
  return { query: typeof input.query === 'string' ? input.query.trim() : '', limit: typeof input.limit === 'number' ? input.limit : 24 };
}

export const NATIVE_STICKER_TOOLS: readonly NativeToolContribution[] = Object.freeze([{
  definition: { name: 'qaf_sticker_list', capability: 'native.stickers.list', featureId: 'framework-tools', timeoutMs: 15000,
    registrationSource: { origin: 'framework-builtin', ownerId: 'qq-agent-framework', ownerName: '框架内置工具', transport: 'native' },
    description: '查看或按备注搜索QQ账号当前收藏的表情包，返回当前会话可用的图片assetId。没有收藏或匹配项时返回空列表。可用qaf_media_read读取图片；选择后用qaf.output/1的image内容和该assetId发送。读取列表不等于已经发送，实际发送由宿主核验会话权限、资源归属和协议端支持情况。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', maxLength: 128, description: '按表情备注或标识搜索；无备注时可以读取图片判断。' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回数量，默认24。' },
    } } },
  validate,
}]);

/** Candidate discovery only; content reads and sends retain their existing policy and scoped media paths. */
export function createNativeStickerService(options: {
  readonly port: OneBotStickerPort;
  readonly register: OneBotIncomingAssetRegistrar;
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>;
}): { readonly list: EffectAdapter } {
  return Object.freeze({ list: Object.freeze<EffectAdapter>({
    async execute(request): Promise<JsonValue> {
      const input = validate(request.input);
      const conversationId = request.scope.conversationId;
      await options.authorize(conversationId, request.signal);
      request.signal.throwIfAborted();
      const result = await options.port.list({ limit: 500, signal: request.signal });
      await options.authorize(conversationId, request.signal);
      request.signal.throwIfAborted();
      if (result.status !== 'confirmed') return { status: result.status, code: result.code, items: [], contentRead: false, sent: false };
      const query = input.query.toLocaleLowerCase();
      const matches = result.data.items.filter(item => !query || `${item.id} ${item.name ?? ''}`.toLocaleLowerCase().includes(query));
      const items: JsonValue[] = [];
      for (const item of matches.slice(0, input.limit)) {
        const assetId = await options.register({ kind: 'image', conversationId,
          messageId: `sticker-${digest([item.id, item.url])}`, ...(item.name === undefined ? {} : { name: item.name }),
          source: { url: item.url } }, request.signal);
        items.push({ assetId, kind: 'image', name: item.name ?? null });
      }
      await options.authorize(conversationId, request.signal);
      request.signal.throwIfAborted();
      return { status: 'confirmed', items, limited: result.data.limited || matches.length > input.limit,
        empty: items.length === 0, contentRead: false, sent: false };
    },
  }) });
}
