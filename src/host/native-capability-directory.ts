import type { QqCapabilitiesPort } from '../adapters/onebot-capabilities.ts'
import { QQ_CAPABILITIES, QQ_CAPABILITY_CATEGORIES, findQqCapability } from '../contracts/qq-capabilities.ts'
import type { QqCapabilitiesInspection } from '../contracts/qq-capabilities.ts'
import type { EffectAdapter, EffectRequest, JsonObject, JsonValue } from '../core/types.ts'
import { assert, isRecord } from '../core/values.ts'
import type { NativeToolContribution } from './native-framework-tools.ts'
import type { NativeMessageSourceReader } from './native-message-sources.ts'
import type { DurableStore } from './types.ts'
import { digest, json, object } from './data.ts'

export interface DirectoryTool { readonly tool: NativeToolContribution; readonly effect: EffectAdapter; readonly category: string; readonly permission: 'owner' | 'autonomous' }
const source = { origin: 'framework-builtin', ownerId: 'qq-agent-framework', ownerName: '框架内置工具', transport: 'native' } as const
function catalogInput(input: JsonValue): { id?: string; category?: string; query?: string } {
  assert(isRecord(input) && Object.keys(input).every(k => ['id', 'category', 'query'].includes(k))
    && Object.values(input).every(v => typeof v === 'string' && v.length > 0 && v.length <= 160), 'INVALID_CAPABILITY_QUERY', 'Use a category, tool ID or short query.')
  return input as { id?: string; category?: string; query?: string }
}
function callInput(input: JsonValue): { id: string; input: JsonValue } {
  assert(isRecord(input) && Object.keys(input).length === 2 && typeof input.id === 'string' && input.id.length <= 160
    && isRecord(input.input), 'INVALID_CAPABILITY_CALL', 'A registered tool ID and input object are required.')
  return { id: input.id, input: input.input as JsonObject }
}
export const NATIVE_DIRECTORY_TOOLS: readonly NativeToolContribution[] = [
  { definition: { name: 'qaf_capability_catalog', capability: 'native.capabilities.catalog', featureId: 'framework-tools', registrationSource: source, timeoutMs: 10000,
    description: '按需查找低频能力，包括空间说说、账号资料、好友和群管理、文件、协议运维、会话绑定管理。无参数返回分类；category或query只返回工具摘要；id返回该工具的完整参数和调用范围。找到后用qaf_capability_call调用。不需要先展开全部工具。',
    parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', maxLength: 160 }, category: { type: 'string', maxLength: 160 }, query: { type: 'string', maxLength: 160 } } } }, validate: input => json(catalogInput(input)) },
  { definition: { name: 'qaf_capability_call', capability: 'native.capabilities.call', featureId: 'framework-tools', registrationSource: source, timeoutMs: 120000,
    description: '调用能力目录中的一个工具。先读取该id的参数说明，再提交id和input对象。返回结果区分confirmed、rejected、unknown；unknown不重复写操作。日常回复、贴表情和收藏使用直接提供的常用工具。',
    parameters: { type: 'object', additionalProperties: false, required: ['id', 'input'], properties: { id: { type: 'string', maxLength: 160 }, input: { type: 'object' } } } }, validate: input => json(callInput(input)) },
]
export function createNativeCapabilityDirectory(options: {
  readonly port: QqCapabilitiesPort; readonly inventory: QqCapabilitiesInspection | null; readonly store: DurableStore
  readonly selfId: string; readonly sources: () => NativeMessageSourceReader | undefined
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>
  readonly tools: () => readonly DirectoryTool[]
}) {
  async function guard(request: EffectRequest, owner: boolean) {
    await options.authorize(request.scope.conversationId, request.signal)
    const sources = options.sources(); assert(sources, 'NATIVE_MESSAGE_SOURCE_MISSING', 'Current message source is unavailable.')
    return owner ? sources.requireOwner(request.scope, request.signal) : sources.lookup(request.scope, request.signal)
  }
  const supported = new Set(options.inventory?.supportedIds ?? [])
  // Raw account APIs are owner-only. Public/autonomous operations use scoped daily or directory wrappers.
  const entries = () => [
    ...options.tools().map(t => ({ id: t.tool.definition.name, category: t.category, description: t.tool.definition.description,
      permission: t.permission, inputSchema: t.tool.definition.parameters })),
    ...QQ_CAPABILITIES.filter(t => supported.has(t.id)).map(t => ({ id: `qq.${t.id}`, category: t.category,
      description: t.description, permission: 'owner' as const, inputSchema: t.inputSchema })),
  ]
  async function execute(request: EffectRequest): Promise<JsonValue> {
    const input = callInput(request.input)
    const delegated = options.tools().find(t => t.tool.definition.name === input.id)
    await guard(request, !delegated || delegated.permission === 'owner')
    if (delegated) return delegated.effect.execute({ ...request, input: delegated.tool.validate(input.input) })
    assert(input.id.startsWith('qq.'), 'CAPABILITY_NOT_FOUND', 'Read a valid capability ID from the directory.')
    const id = input.id.slice(3), definition = findQqCapability(id)
    assert(definition && supported.has(id), 'CAPABILITY_UNSUPPORTED', 'The connected protocol has not confirmed this capability.')
    if (!definition.write) return bounded(await options.port.call({ id, input: input.input, signal: request.signal }))
    const namespace = 'native-chat.protocol-writes', key = digest([options.selfId, request.scope.accountScope ?? null,
      request.scope.conversationId, request.scope.eventId, id]), fingerprint = digest(input)
    const prior = options.store.read(namespace, key)
    if (prior) { const value = object(prior.value); assert(value.fingerprint === fingerprint, 'PROTOCOL_WRITE_CONFLICT', 'Input changed for the same operation.')
      return value.result ?? { status: 'unknown', retry: false } }
    const record = options.store.write(namespace, key, { schema: 1, fingerprint, operation: id, conversationId: request.scope.conversationId,
      status: 'dispatching', at: Date.now() }, { expectedRevision: null })
    let result: JsonValue
    try { await guard(request, true); result = bounded(await options.port.call({ id, input: input.input, signal: request.signal })) }
    catch { result = { status: 'unknown', code: 'PROTOCOL_WRITE_RESULT_UNKNOWN', retry: false } }
    options.store.write(namespace, key, { ...object(record.value), status: isRecord(result) ? String(result.status) : 'unknown', result }, { expectedRevision: record.revision })
    return result
  }
  return Object.freeze({ effects: {
    'native.capabilities.catalog': { async execute(request) {
      await guard(request, false)
      const input = catalogInput(request.input), all = entries()
      if (input.id) { const entry = all.find(t => t.id === input.id); return entry ? json(entry) : { status: 'rejected', code: 'CAPABILITY_NOT_FOUND' } }
      if (!input.category && !input.query) return json({ categories: [...QQ_CAPABILITY_CATEGORIES, { id: 'sessions', label: '会话管理', description: '查询和切换QQ与插件会话绑定' }]
        .map(c => ({ ...c, count: all.filter(t => t.category === c.id).length })).filter(c => c.count > 0) })
      const matches = all.filter(t => (!input.category || t.category === input.category)
        && (!input.query || `${t.id} ${t.description}`.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())))
      return json({ tools: matches.slice(0, 40).map(({ inputSchema: _schema, ...t }) => t), limited: matches.length > 40 })
    } } satisfies EffectAdapter,
    'native.capabilities.call': { execute } satisfies EffectAdapter,
  }, inventory: entries })
}
function bounded(value: unknown): JsonValue {
  const result = json(value)
  if (Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024) return result
  return { status: isRecord(result) ? String(result.status) : 'unknown', resultOmitted: true,
    reason: '结果超过聊天展示范围，请缩小查询范围；完整读取可由主人交给插件或助手完成。' }
}
