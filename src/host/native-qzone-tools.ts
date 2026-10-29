import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OneBotAssetResolver } from '../adapters/onebot.ts';
import type { QzoneToolInventory, QzoneToolPort } from '../contracts/qzone-tools.ts';
import { nativeToolCapabilityDefinition } from '../contracts/native-tool-capabilities.ts';
import type { EffectAdapter, EffectRequest, JsonObject, JsonValue } from '../core/types.ts';
import { assert, isRecord } from '../core/values.ts';
import { digest, json, object } from './data.ts';
import type { NativeToolContribution } from './native-framework-tools.ts';
import type { NativeMessageSourceReader } from './native-message-sources.ts';
import type { DurableStore } from './types.ts';

const imageId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._:-]{0,159}$/.test(value);
const postId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);
const rights = { public: 1, friends: 4, allow: 16, self: 64, deny: 128 } as const;
interface PublishInput { content: string; images: readonly string[]; visibility: keyof typeof rights; userIds?: readonly string[] }
function publishInput(input: JsonValue): PublishInput {
  assert(isRecord(input) && Object.keys(input).every(key => ['content', 'images', 'visibility', 'userIds'].includes(key))
    && (input.content === undefined || typeof input.content === 'string' && input.content.length <= 32768)
    && (input.images === undefined || Array.isArray(input.images) && input.images.length <= 32 && input.images.every(imageId))
    && typeof input.visibility === 'string' && Object.hasOwn(rights, input.visibility)
    && (input.userIds === undefined || Array.isArray(input.userIds) && input.userIds.length >= 1 && input.userIds.length <= 1000
      && input.userIds.every(id => typeof id === 'string' && /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)))),
  'INVALID_QZONE_INPUT', 'Publish accepts bounded text, scoped image asset IDs and explicit visibility.');
  assert(typeof input.content === 'string' && input.content.trim().length > 0 || Array.isArray(input.images) && input.images.length > 0,
    'INVALID_QZONE_INPUT', 'A post needs text or at least one image.');
  const selected = input.visibility as PublishInput['visibility'];
  assert(selected === 'allow' || selected === 'deny' ? input.userIds !== undefined : input.userIds === undefined,
    'INVALID_QZONE_INPUT', 'Selected visibility requires the corresponding user list.');
  return { content: typeof input.content === 'string' ? input.content : '', images: (input.images as string[] | undefined) ?? [], visibility: selected,
    ...(input.userIds === undefined ? {} : { userIds: input.userIds as string[] }) };
}
function deleteInput(input: JsonValue): { postId: string } {
  assert(isRecord(input) && Object.keys(input).length === 1 && postId(input.postId), 'INVALID_QZONE_INPUT', 'Delete requires one real postId.');
  return { postId: input.postId };
}
const source = { origin: 'framework-builtin', ownerId: 'qq-bridge-framework', ownerName: '框架内置工具', transport: 'native' } as const;
export const NATIVE_QZONE_TOOLS: readonly NativeToolContribution[] = Object.freeze<readonly NativeToolContribution[]>([
  { definition: { name: 'qbf_qzone_publish', capability: 'native.qzone.publish', featureId: 'framework-tools', timeoutMs: 60000,
    registrationSource: source, description: nativeToolCapabilityDefinition('native.qzone.publish').description,
    parameters: { type: 'object', additionalProperties: false, required: ['visibility'], properties: {
      content: { type: 'string', maxLength: 32768, description: '说说正文；有图片时可留空' },
      images: { type: 'array', maxItems: 32, items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._:-]{0,159}$' }, description: '当前会话可发送的图片 assetId，不接收路径或网址' },
      visibility: { enum: ['public', 'friends', 'self', 'allow', 'deny'], description: '公开、好友、仅自己、指定好友、排除指定好友；必须明确给出' },
      userIds: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' }, description: '仅 allow/deny 时提供对应好友账号列表' },
    } } }, validate: input => json(publishInput(input)) },
  { definition: { name: 'qbf_qzone_delete', capability: 'native.qzone.delete', featureId: 'framework-tools', timeoutMs: 60000,
    registrationSource: source, description: nativeToolCapabilityDefinition('native.qzone.delete').description,
    parameters: { type: 'object', additionalProperties: false, required: ['postId'], properties: { postId: { type: 'string', minLength: 1, maxLength: 512, description: '发布结果或实际读取结果中的真实说说编号' } } } },
    validate: input => deleteInput(input) },
]);
/** Select only the protocol actions that were actually observed at startup. */
export function availableNativeQzoneTools(inventory: QzoneToolInventory): readonly NativeToolContribution[] {
  if (inventory.state !== 'available') return [];
  const actions = new Set(inventory.tools.map(tool => tool.name));
  return NATIVE_QZONE_TOOLS.filter(tool => actions.has(tool.definition.capability === 'native.qzone.publish' ? 'send_qzone_msg' : 'delete_qzone_msg'));
}

/** Model-facing wrapper retains the normal source/whitelist boundary; the low-level Qzone port stays independent. */
export function createNativeQzoneEffects(options: {
  readonly port: QzoneToolPort;
  readonly store: DurableStore;
  readonly selfId: string;
  readonly sources: () => NativeMessageSourceReader | undefined;
  readonly resolveAsset: OneBotAssetResolver;
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>;
}): Readonly<Record<string, EffectAdapter>> {
  async function guard(request: EffectRequest) {
    request.signal.throwIfAborted();
    await options.authorize(request.scope.conversationId, request.signal);
    const sources = options.sources();
    assert(sources, 'NATIVE_MESSAGE_SOURCE_MISSING', 'A live QQ source is required.');
    return sources.lookup(request.scope, request.signal);
  }
  async function write(request: EffectRequest, operation: 'publish' | 'delete', input: JsonObject): Promise<JsonValue> {
    const source = await guard(request);
    const namespace = 'native-chat.qzone-writes';
    const key = digest([options.selfId, request.scope.accountScope ?? null, request.scope.conversationId, request.scope.eventId, operation]);
    const fingerprint = digest(request.input);
    const previous = options.store.read(namespace, key);
    if (previous) {
      const value = object(previous.value);
      assert(value.fingerprint === fingerprint, 'QZONE_WRITE_CONFLICT', 'The same invocation cannot change its input.');
      return value.result ?? { status: 'unknown', code: 'QZONE_ALREADY_DISPATCHED', retry: false };
    }
    const record = options.store.write(namespace, key, { schema: 1, fingerprint, operation, sourceMessageId: source.sourceMessageId,
      conversationId: request.scope.conversationId, state: 'dispatching', at: Date.now() }, { expectedRevision: null });
    let result: JsonValue;
    try {
      const receipt = await options.port.execute({ name: operation === 'publish' ? 'send_qzone_msg' : 'delete_qzone_msg', input, signal: request.signal });
      if (receipt.status !== 'confirmed') result = { ...receipt, retry: false };
      else if (operation === 'publish') {
        assert(isRecord(receipt.data) && postId(receipt.data.tid), 'QZONE_INVALID_RESPONSE', 'Publication requires a real post identifier.');
        result = { status: 'confirmed', data: { postId: receipt.data.tid,
          publishedAt: typeof receipt.data.time === 'number' && Number.isSafeInteger(receipt.data.time) && receipt.data.time >= 0 ? receipt.data.time : null } };
      } else {
        assert(receipt.data === null, 'QZONE_INVALID_RESPONSE', 'Deletion requires a confirmed void receipt.');
        result = { status: 'confirmed', data: null };
      }
    } catch { result = { status: 'unknown', code: 'QZONE_RESULT_UNKNOWN', retry: false }; }
    const settled = isRecord(result) && result.status !== 'unknown';
    options.store.write(namespace, key, { ...object(record.value), state: isRecord(result) ? String(result.status) : 'unknown', result },
      { expectedRevision: record.revision, ...(settled ? { expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 } : {}) });
    return result;
  }
  return Object.freeze({
    'native.qzone.publish': { async execute(request) {
      const input = publishInput(request.input);
      await guard(request);
      const images: string[] = [];
      for (const assetId of input.images) {
        const asset = await options.resolveAsset({ assetId, type: 'image', conversationId: request.scope.conversationId,
          sessionId: request.scope.sessionId, generation: request.scope.generation, signal: request.signal });
        const file = typeof asset === 'string' ? asset : asset.file;
        images.push(isAbsolute(file) ? pathToFileURL(file).href : file);
      }
      return write(request, 'publish', { content: input.content, ugc_right: rights[input.visibility],
        ...(images.length ? { images } : {}), ...(input.userIds ? { target_uins: input.userIds.map(Number) } : {}) });
    } },
    'native.qzone.delete': { async execute(request) {
      const input = deleteInput(request.input);
      return write(request, 'delete', { tid: input.postId });
    } },
  } satisfies Readonly<Record<string, EffectAdapter>>);
}
