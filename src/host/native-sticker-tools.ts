import type { OneBotStickerPort } from '../adapters/onebot-stickers.ts';
import type { OneBotAssetResolver, OneBotIncomingAssetRegistrar } from '../adapters/onebot.ts';
import type { EffectAdapter, EffectRequest, JsonValue } from '../core/types.ts';
import { assert, isRecord } from '../core/values.ts';
import { digest, json, object } from './data.ts';
import type { NativeToolContribution } from './native-framework-tools.ts';
import type { NativeMessageSourceReader } from './native-message-sources.ts';
import type { DurableStore } from './types.ts';

function validate(input: JsonValue): { query: string; limit: number } {
  assert(isRecord(input) && Object.keys(input).every(key => ['query', 'limit'].includes(key))
    && (input.query === undefined || typeof input.query === 'string' && input.query.length <= 128 && !/[\x00-\x1f\x7f]/.test(input.query))
    && (input.limit === undefined || typeof input.limit === 'number' && Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 50),
  'INVALID_STICKER_INPUT', 'Sticker listing accepts an optional bounded query and a limit from 1 to 50.');
  return { query: typeof input.query === 'string' ? input.query.trim() : '', limit: typeof input.limit === 'number' ? input.limit : 24 };
}

type ManageInput = { action: 'add'; assetId: string } | { action: 'delete'; stickerId: string }
  | { action: 'describe'; stickerId: string; description: string };
function manageInput(input: JsonValue): ManageInput {
  assert(isRecord(input), 'INVALID_STICKER_INPUT', 'Sticker management requires an action.');
  if (input.action === 'add') {
    assert(Object.keys(input).length === 2 && typeof input.assetId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,511}$/.test(input.assetId),
      'INVALID_STICKER_INPUT', 'Adding a sticker requires one current image assetId.');
    return { action: 'add', assetId: input.assetId };
  }
  assert((input.action === 'delete' || input.action === 'describe') && typeof input.stickerId === 'string'
    && input.stickerId.length >= 1 && input.stickerId.length <= 512 && !/[\x00-\x1f\x7f]/.test(input.stickerId)
    && Object.keys(input).every(key => ['action', 'stickerId', ...(input.action === 'describe' ? ['description'] : [])].includes(key)),
  'INVALID_STICKER_INPUT', 'Deleting or describing a sticker requires its real stickerId from the collection.');
  if (input.action === 'delete') return { action: 'delete', stickerId: input.stickerId };
  assert(typeof input.description === 'string' && input.description.length <= 255 && !/[\x00-\x1f\x7f]/.test(input.description),
    'INVALID_STICKER_INPUT', 'A sticker description must be a single line of at most 255 characters.');
  return { action: 'describe', stickerId: input.stickerId, description: input.description };
}

export const NATIVE_STICKER_TOOLS: readonly NativeToolContribution[] = Object.freeze<readonly NativeToolContribution[]>([{
  definition: { name: 'qaf_sticker_list', capability: 'native.stickers.list', featureId: 'framework-tools', timeoutMs: 15000,
    registrationSource: { origin: 'framework-builtin', ownerId: 'qq-agent-framework', ownerName: '框架内置工具', transport: 'native' },
    description: '查看或按备注搜索QQ账号当前收藏的表情包，返回当前会话可用的图片assetId及真实stickerId；stickerId为null时只能读取或发送。没有收藏或匹配项时返回空列表。可用qaf_media_read读取图片；选择后调用qaf_reply({content:[{type:"image",assetId:"实际返回的assetId"}]})发送。读取列表不等于已经发送，实际发送由宿主核验会话权限、资源归属和协议端支持情况。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', maxLength: 128, description: '按表情备注或标识搜索；无备注时可以读取图片判断。' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回数量，默认24。' },
    } } },
  validate,
}, {
  definition: { name: 'qaf_sticker_manage', capability: 'native.stickers.manage', featureId: 'framework-tools', timeoutMs: 30000,
    registrationSource: { origin: 'framework-builtin', ownerId: 'qq-agent-framework', ownerName: '框架内置工具', transport: 'native' },
    description: '管理QQ账号收藏表情。add收藏当前会话已登记图片assetId；delete删除列表返回的真实stickerId；describe修改该stickerId的description（空字符串清除描述）。先用qaf_sticker_list选择，禁止编造标识。收藏需协议与宿主在同一本机且图片资源可解析；收藏与删除影响账号收藏。confirmed表示协议已确认，unknown时不重复同一次动作；可重新查询收藏核对。',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { enum: ['add', 'delete', 'describe'] }, assetId: { type: 'string', minLength: 1, maxLength: 512 },
      stickerId: { type: 'string', minLength: 1, maxLength: 512 }, description: { type: 'string', maxLength: 255 },
    } } },
  validate: input => json(manageInput(input)),
}]);

/** Collection reads and writes retain scoped source, media and durable operation boundaries. */
export function createNativeStickerService(options: {
  readonly port: OneBotStickerPort;
  readonly register: OneBotIncomingAssetRegistrar;
  readonly store?: DurableStore;
  readonly selfId?: string;
  readonly sources?: () => NativeMessageSourceReader | undefined;
  readonly resolveAsset?: OneBotAssetResolver;
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>;
}): { readonly list: EffectAdapter; readonly manage: EffectAdapter } {
  async function guard(request: EffectRequest) {
    await options.authorize(request.scope.conversationId, request.signal);
    request.signal.throwIfAborted();
    const sources = options.sources?.();
    assert(sources, 'NATIVE_MESSAGE_SOURCE_MISSING', 'Sticker writes require a current normalized source.');
    return sources.lookup(request.scope, request.signal);
  }
  return Object.freeze({ manage: Object.freeze<EffectAdapter>({
    async execute(request): Promise<JsonValue> {
      const input = manageInput(request.input);
      const source = await guard(request);
      const store = options.store;
      assert(store && options.selfId, 'STICKER_WRITE_UNAVAILABLE', 'Sticker writes require durable account storage.');
      const namespace = 'native-chat.protocol-writes';
      const operation = `sticker-${input.action}`;
      const key = digest([options.selfId, request.scope.accountScope ?? null, request.scope.conversationId, request.scope.eventId, operation]);
      const fingerprint = digest(request.input);
      const prior = store.read(namespace, key);
      if (prior) {
        const value = object(prior.value);
        assert(value.fingerprint === fingerprint, 'PROTOCOL_WRITE_CONFLICT', 'The sticker operation input changed.');
        return value.result ?? { status: 'unknown', code: 'PROTOCOL_WRITE_ALREADY_DISPATCHED', retry: false };
      }
      // Prepare and validate before recording dispatch; only fixed protocol writes run after the durable record.
      let run: () => Promise<JsonValue>;
      if (input.action === 'add') {
        const add = options.port.add;
        const resolve = options.resolveAsset;
        if (!add || !resolve) return { status: 'rejected', code: 'STICKER_ADD_UNSUPPORTED' };
        const resolution = await resolve({ assetId: input.assetId, type: 'image', conversationId: request.scope.conversationId,
          sessionId: request.scope.sessionId, generation: request.scope.generation, signal: request.signal });
        const file = typeof resolution === 'string' ? resolution : resolution.file;
        run = async () => json(await add({ file, signal: request.signal }));
      } else {
        const listed = await options.port.list({ limit: 500, signal: request.signal });
        if (listed.status !== 'confirmed') return json(listed);
        const sticker = listed.data.items.find(item => item.stickerId === input.stickerId);
        if (!sticker) return { status: 'rejected', code: 'STICKER_NOT_IN_CURRENT_COLLECTION', limited: listed.data.limited };
        if (input.action === 'delete') {
          const remove = options.port.delete;
          if (!remove) return { status: 'rejected', code: 'STICKER_DELETE_UNSUPPORTED' };
          run = async () => json(await remove({ stickerId: input.stickerId, signal: request.signal }));
        } else {
          const describe = options.port.describe;
          const emojiId = sticker.emojiId;
          const md5 = sticker.md5;
          if (!describe || emojiId === undefined || md5 === undefined)
            return { status: 'rejected', code: 'STICKER_DESCRIPTION_METADATA_UNAVAILABLE' };
          run = async () => json(await describe({ stickerId: input.stickerId, emojiId, md5,
            description: input.description, signal: request.signal }));
        }
      }
      await guard(request);
      const record = store.write(namespace, key, { schema: 1, fingerprint, operation, sourceMessageId: source.sourceMessageId,
        conversationId: request.scope.conversationId, status: 'dispatching', at: Date.now() }, { expectedRevision: null });
      let result: JsonValue;
      try {
        result = await run();
        if (isRecord(result) && result.status === 'unknown') result = { ...result, retry: false };
      }
      catch { result = { status: 'unknown', code: 'PROTOCOL_WRITE_RESULT_UNKNOWN', retry: false }; }
      store.write(namespace, key, { ...object(record.value), status: isRecord(result) ? String(result.status) : 'unknown', result },
        { expectedRevision: record.revision });
      return result;
    },
  }), list: Object.freeze<EffectAdapter>({
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
        items.push({ assetId, stickerId: item.stickerId ?? null, kind: 'image', name: item.name ?? null,
          canDelete: item.stickerId !== undefined, canDescribe: item.stickerId !== undefined && item.emojiId !== undefined && item.md5 !== undefined });
      }
      await options.authorize(conversationId, request.signal);
      request.signal.throwIfAborted();
      return { status: 'confirmed', items, limited: result.data.limited || matches.length > input.limit,
        empty: items.length === 0, contentRead: false, sent: false };
    },
  }) });
}
