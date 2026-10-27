import type { OneBotActionPort, OneBotReadResult } from '../adapters/onebot-actions.ts';
import type { OneBotConversationPort } from '../adapters/onebot-conversation.ts';
import { normalizeOneBotContent, type OneBotIncomingAssetRegistrar } from '../adapters/onebot.ts';
import type { EffectAdapter, EffectRequest, JsonObject, JsonValue } from '../core/types.ts';
import { assert, isRecord } from '../core/values.ts';
import { digest, json, object } from './data.ts';
import type { NativeToolContribution } from './native-framework-tools.ts';
import type { NativeMessageSourceReader } from './native-message-sources.ts';
import type { DurableStore } from './types.ts';
import { readScopedProtocolMessage } from './native-protocol-message.ts';

interface QueryInput {
  kind: 'info' | 'members' | 'history' | 'message' | 'directories'; query: string; offset: number; limit: number;
  messageId?: string; directory?: 'friends' | 'groups';
}
const userId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,31}$/.test(value);
const messageId = (value: unknown): value is string => typeof value === 'string' && /^-?[1-9]\d{0,31}$/.test(value);
function queryInput(input: JsonValue): QueryInput {
  assert(isRecord(input) && Object.keys(input).every(key => ['kind', 'query', 'offset', 'limit', 'messageId', 'directory'].includes(key))
    && ['info', 'members', 'history', 'message', 'directories'].includes(String(input.kind))
    && (input.query === undefined || typeof input.query === 'string' && input.query.length <= 128 && !/[\x00-\x1f\x7f]/.test(input.query))
    && (input.offset === undefined || typeof input.offset === 'number' && Number.isSafeInteger(input.offset) && input.offset >= 0 && input.offset <= 10000)
    && (input.limit === undefined || typeof input.limit === 'number' && Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 50)
    && (input.messageId === undefined || messageId(input.messageId))
    && (input.directory === undefined || input.directory === 'friends' || input.directory === 'groups'),
  'INVALID_CONVERSATION_INPUT', 'Conversation queries require a supported kind and bounded filters.');
  assert(input.kind !== 'message' || messageId(input.messageId), 'INVALID_CONVERSATION_INPUT', 'Message queries require one messageId.');
  assert(input.kind !== 'directories' || input.directory === 'friends' || input.directory === 'groups',
    'INVALID_CONVERSATION_INPUT', 'Directory queries require friends or groups.');
  return { kind: input.kind as QueryInput['kind'], query: typeof input.query === 'string' ? input.query.trim() : '',
    offset: typeof input.offset === 'number' ? input.offset : 0, limit: typeof input.limit === 'number' ? input.limit : 20,
    ...(typeof input.messageId === 'string' ? { messageId: input.messageId } : {}),
    ...(input.directory === 'friends' || input.directory === 'groups' ? { directory: input.directory } : {}) };
}
function pokeInput(input: JsonValue): { userId?: string } {
  assert(isRecord(input) && Object.keys(input).every(key => key === 'userId') && (input.userId === undefined || userId(input.userId)),
    'INVALID_CONVERSATION_INPUT', 'Poke accepts an optional userId in the current conversation.');
  return typeof input.userId === 'string' ? { userId: input.userId } : {};
}
function recallInput(input: JsonValue): { messageId: string } {
  assert(isRecord(input) && Object.keys(input).length === 1 && messageId(input.messageId),
    'INVALID_CONVERSATION_INPUT', 'Recall requires one messageId.');
  return { messageId: input.messageId };
}
const source = { origin: 'framework-builtin', ownerId: 'qq-agent-framework', ownerName: '框架内置工具', transport: 'native' } as const;
export const NATIVE_CONVERSATION_TOOLS: readonly NativeToolContribution[] = Object.freeze<readonly NativeToolContribution[]>([
  { definition: { name: 'qaf_conversation_query', capability: 'native.conversation.query', featureId: 'framework-tools', timeoutMs: 15000,
    registrationSource: source,
    description: '查询当前QQ会话：info为会话信息，members为当前群成员（可按昵称/群名片/QQ号搜索并分页），history为当前群或私聊最近最多10条消息，message按messageId读取当前会话单条消息，directories读取账号好友或群目录。媒体返回可读取和发送的会话assetId；查询不代表已经看懂图片。目录支持query/offset/limit，不要整份目录灌入回复。',
    parameters: { type: 'object', additionalProperties: false, required: ['kind'], properties: {
      kind: { enum: ['info', 'members', 'history', 'message', 'directories'] }, query: { type: 'string', maxLength: 128 },
      offset: { type: 'integer', minimum: 0, maximum: 10000 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
      messageId: { type: 'string', pattern: '^-?[1-9][0-9]{0,31}$' }, directory: { enum: ['friends', 'groups'] },
    } } }, validate: input => json(queryInput(input)) },
  { definition: { name: 'qaf_poke', capability: 'native.conversation.poke', featureId: 'framework-tools', timeoutMs: 15000,
    registrationSource: source, description: '在当前QQ会话戳一戳。userId省略时戳当前真实发言者；私聊固定当前对端，群聊目标必须是当前群成员。根据真实协议回执报告成功或失败；结果unknown时不能重复提交同一次动作。',
    parameters: { type: 'object', additionalProperties: false, properties: { userId: { type: 'string', pattern: '^[1-9][0-9]{0,31}$' } } } },
    validate: input => json(pokeInput(input)) },
  { definition: { name: 'qaf_recall', capability: 'native.conversation.recall', featureId: 'framework-tools', timeoutMs: 15000,
    registrationSource: source, description: '撤回当前QQ会话中机器人自己发送的一条消息。messageId须来自真实消息记录；先核对消息归属再执行，不能撤回其他发言者消息。结果unknown时不能重复提交同一次动作。',
    parameters: { type: 'object', additionalProperties: false, required: ['messageId'], properties: {
      messageId: { type: 'string', pattern: '^-?[1-9][0-9]{0,31}$' },
    } } }, validate: input => json(recallInput(input)) },
]);

/** Scope and sender policy stay in this host; adapters receive only validated fixed-action inputs. */
export function createNativeConversationService(options: {
  readonly port: OneBotConversationPort; readonly messagePort: Pick<OneBotActionPort, 'getMessage'>;
  readonly register: OneBotIncomingAssetRegistrar; readonly selfId: string; readonly store: DurableStore;
  readonly sources: () => NativeMessageSourceReader | undefined;
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>;
}): Readonly<Record<string, EffectAdapter>> {
  function sources() {
    const reader = options.sources();
    assert(reader, 'NATIVE_MESSAGE_SOURCE_MISSING', 'The current normalized message source is unavailable.');
    return reader;
  }
  async function guard(request: EffectRequest, owner = false) {
    await options.authorize(request.scope.conversationId, request.signal);
    request.signal.throwIfAborted();
    return owner ? sources().requireOwner(request.scope, request.signal) : sources().lookup(request.scope, request.signal);
  }
  async function readMessage(request: EffectRequest, expectedMessageId: string, requireOutbound = false) {
    const result = await readScopedProtocolMessage({ port: options.messagePort, store: options.store, selfId: options.selfId,
      messageId: expectedMessageId, conversationId: request.scope.conversationId, signal: request.signal,
      requireOutboundEvidence: requireOutbound, ...(request.scope.accountScope ? { accountScope: request.scope.accountScope } : {}) });
    await guard(request, requireOutbound);
    return result;
  }
  function page<Value>(items: readonly Value[], input: QueryInput, label: (item: Value) => string): JsonObject {
    const query = input.query.toLocaleLowerCase();
    const matches = items.filter(item => !query || label(item).toLocaleLowerCase().includes(query));
    const selected = matches.slice(input.offset, input.offset + input.limit);
    const next = input.offset + selected.length;
    return { status: 'confirmed', items: json(selected), totalMatched: matches.length, nextOffset: next < matches.length ? next : null };
  }
  async function normalizeMessages(items: readonly { readonly messageId: string; readonly userId: string; readonly conversationId: string;
    readonly time?: number | null; readonly message: readonly JsonObject[] }[], request: EffectRequest): Promise<JsonObject> {
    const messages: JsonValue[] = [];
    let remaining = 16000;
    let truncated = false;
    for (const item of items.slice(0, 10)) {
      assert(item.conversationId === request.scope.conversationId, 'CONVERSATION_SCOPE_MISMATCH', 'The protocol message belongs to another conversation.');
      const content = await normalizeOneBotContent(item.message, { conversationId: request.scope.conversationId,
        messageId: item.messageId, registerIncomingAsset: options.register, signal: request.signal });
      if (!content) { messages.push({ messageId: item.messageId, available: false, reason: 'unsupported_content' }); continue; }
      const bounded = content.map(part => {
        if (part.type !== 'text') return part;
        const text = part.text.slice(0, Math.min(2000, remaining));
        remaining -= text.length;
        if (text.length < part.text.length) truncated = true;
        return { type: 'text' as const, text };
      }).filter(part => part.type !== 'text' || part.text.length > 0);
      messages.push({ messageId: item.messageId, userId: item.userId, time: item.time ?? null,
        actor: item.userId === options.selfId ? 'assistant' : 'user', content: json(bounded), contentRead: false });
    }
    await guard(request);
    return { status: 'confirmed', messages, truncated };
  }
  async function write(request: EffectRequest, operation: string,
    run: () => Promise<OneBotReadResult<{ readonly acknowledged: true }>>): Promise<JsonValue> {
    const source = await guard(request, operation === 'recall');
    const namespace = 'native-chat.protocol-writes';
    const key = digest([options.selfId, request.scope.accountScope ?? null, request.scope.conversationId, request.scope.eventId, operation]);
    const fingerprint = digest(request.input);
    const prior = options.store.read(namespace, key);
    if (prior) {
      const value = object(prior.value);
      assert(value.fingerprint === fingerprint, 'PROTOCOL_WRITE_CONFLICT', 'The protocol operation input changed.');
      return value.result ?? { status: 'unknown', code: 'PROTOCOL_WRITE_ALREADY_DISPATCHED', retry: false };
    }
    const record = options.store.write(namespace, key, { schema: 1, fingerprint, operation,
      conversationId: request.scope.conversationId, sourceMessageId: source.sourceMessageId,
      status: 'dispatching', at: Date.now() }, { expectedRevision: null });
    let result: JsonValue;
    try { result = json(await run()); }
    catch { result = { status: 'unknown', code: 'PROTOCOL_WRITE_RESULT_UNKNOWN', retry: false }; }
    options.store.write(namespace, key, { ...object(record.value), status: isRecord(result) ? String(result.status) : 'unknown', result },
      { expectedRevision: record.revision });
    return result;
  }
  return Object.freeze({
    'native.conversation.query': Object.freeze<EffectAdapter>({ async execute(request) {
      const input = queryInput(request.input);
      await guard(request, input.kind === 'directories');
      const scope = /^(group|private):([1-9]\d{0,31})$/.exec(request.scope.conversationId);
      assert(scope, 'CONVERSATION_SCOPE_INVALID', 'A current QQ conversation is required.');
      if (input.kind === 'directories') {
        if (input.directory === 'friends') {
          const found = await options.port.friends({ signal: request.signal });
          await guard(request, true);
          return found.status === 'confirmed' ? page(found.data, input, row => `${row.userId} ${row.nickname ?? ''} ${row.remark ?? ''}`) : json(found);
        }
        const found = await options.port.groups({ signal: request.signal });
        await guard(request, true);
        return found.status === 'confirmed' ? page(found.data, input, row => `${row.groupId} ${row.name ?? ''}`) : json(found);
      }
      if (input.kind === 'message') {
        const found = await readMessage(request, input.messageId!);
        await guard(request);
        return found.status === 'confirmed' ? normalizeMessages([found.data], request) : json(found);
      }
      if (scope[1] === 'private') {
        if (input.kind === 'info') return { status: 'confirmed', conversationId: request.scope.conversationId,
          peerId: scope[2]!, selfId: options.selfId, profileAvailable: false };
        if (input.kind === 'members') return { status: 'rejected', code: 'PRIVATE_CONVERSATION_QUERY_UNSUPPORTED' };
        const found = await options.port.privateHistory({ userId: scope[2]!, selfId: options.selfId,
          limit: Math.min(10, input.limit), signal: request.signal });
        await guard(request);
        return found.status === 'confirmed' ? normalizeMessages(found.data, request) : json(found);
      }
      const groupId = scope[2]!;
      if (input.kind === 'info') {
        const found = await options.port.groupInfo({ groupId, signal: request.signal });
        await guard(request); return json(found);
      }
      if (input.kind === 'members') {
        const found = await options.port.groupMembers({ groupId, signal: request.signal });
        await guard(request);
        return found.status === 'confirmed' ? page(found.data, input, row => `${row.userId} ${row.nickname ?? ''} ${row.card ?? ''}`) : json(found);
      }
      const found = await options.port.groupHistory({ groupId, limit: Math.min(10, input.limit), signal: request.signal });
      await guard(request);
      return found.status === 'confirmed' ? normalizeMessages(found.data, request) : json(found);
    } }),
    'native.conversation.poke': Object.freeze<EffectAdapter>({ async execute(request) {
      const input = pokeInput(request.input);
      const source = await guard(request);
      const target = input.userId ?? source.userId;
      const scope = /^(group|private):([1-9]\d{0,31})$/.exec(request.scope.conversationId);
      assert(scope, 'CONVERSATION_SCOPE_INVALID', 'A current QQ conversation is required.');
      if (scope[1] === 'private') assert(target === scope[2], 'POKE_SCOPE_MISMATCH', 'Private pokes target the current conversation peer.');
      else {
        const members = await options.port.groupMembers({ groupId: scope[2]!, signal: request.signal });
        if (members.status !== 'confirmed') return json(members);
        assert(members.data.some(member => member.userId === target), 'POKE_TARGET_NOT_MEMBER', 'The target is not a verified member of this group.');
      }
      return write(request, 'poke', () => options.port.poke({ conversationId: request.scope.conversationId, userId: target, signal: request.signal }));
    } }),
    'native.conversation.recall': Object.freeze<EffectAdapter>({ async execute(request) {
      const input = recallInput(request.input);
      await guard(request, true);
      const found = await readMessage(request, input.messageId, true);
      if (found.status !== 'confirmed') return json(found);
      assert(found.data.conversationId === request.scope.conversationId && found.data.messageId === input.messageId && found.data.userId === options.selfId,
        'RECALL_MESSAGE_SCOPE_MISMATCH', 'Only this bot\'s verified message in the current conversation can be recalled.');
      return write(request, 'recall', () => options.port.recall({ messageId: input.messageId, signal: request.signal }));
    } }),
  });
}
