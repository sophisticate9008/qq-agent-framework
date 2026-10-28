import type { JsonObject, JsonValue } from '../contracts/data.ts';
import type { SessionBinding } from '../contracts/ports.ts';
import { pluginModelIdentifier } from '../contracts/plugin-model.ts';
import { parsePluginSessionManagementRequest, type PluginSessionManagementRequest } from '../contracts/plugin-sessions.ts';
import type { EffectRequest } from '../core/types.ts';
import { assert, isRecord } from '../core/values.ts';
import { json } from './data.ts';
import type { DirectoryTool } from './native-capability-directory.ts';
import type { NativeMessageSourceReader } from './native-message-sources.ts';
import type { PluginModelService } from './plugin-model-service.ts';
import type { SessionMetadata } from './sessions.ts';
import { nativeSessionBindingRevision, validNativeSessionResetTarget, type NativeSessionResetTarget } from './native-session-management.ts';

interface PluginTarget { readonly kind: 'plugin'; readonly pluginOwner: string; readonly name?: string; readonly conversationId?: string }
type ResolveInput = { readonly kind: 'qq'; readonly key: string } | PluginTarget;
interface ListInput { readonly kind: 'all' | 'qq' | 'plugin'; readonly pluginOwner?: string; readonly limit: number }
type MutationInput = { readonly kind: 'qq'; readonly target: NativeSessionResetTarget; readonly targetSessionId?: string }
  | { readonly kind: 'plugin'; readonly request: PluginSessionManagementRequest };
const conversation = (value: unknown): value is string => typeof value === 'string' && /^(group|private):[1-9]\d{0,19}$/.test(value);
const source = { origin: 'framework-builtin', ownerId: 'qq-agent-framework', ownerName: '框架内置工具', transport: 'native' } as const;
const identifierSchema: JsonObject = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$', maxLength: 256 };
const conversationSchema: JsonObject = { type: 'string', pattern: '^(group|private):[1-9][0-9]{0,19}$' };
const revisionSchema: JsonObject = { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }], description: '读取列表得到的当前revision；新绑定传null。' };
const targetSchema: JsonObject = { type: 'object', additionalProperties: false, required: ['key', 'sessionId', 'generation', 'bindingRevision'], properties: {
  key: conversationSchema, sessionId: identifierSchema, generation: { type: 'integer', minimum: 1 },
  bindingRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
} };
const pluginProperties: JsonObject = { kind: { const: 'plugin' }, pluginOwner: { ...identifierSchema, description: '目标插件标识。' },
  name: { ...identifierSchema, description: '插件具名会话，默认default。' }, conversationId: { ...conversationSchema, description: '插件按QQ地址分别绑定时使用；省略表示该具名会话不区分QQ地址。' } };
const modelSchema: JsonObject = { type: 'object', additionalProperties: false, required: ['provider', 'model'], properties: {
  provider: identifierSchema, model: identifierSchema, reasoningEffort: identifierSchema,
} };
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  assert(isRecord(value) && Object.keys(value).every(key => keys.includes(key)), 'INVALID_SESSION_TOOL_INPUT', 'Session tools accept only their declared fields.');
}
function pluginTarget(value: Record<string, unknown>): PluginTarget {
  assert(value.kind === 'plugin' && pluginModelIdentifier(value.pluginOwner)
    && (value.name === undefined || pluginModelIdentifier(value.name))
    && (value.conversationId === undefined || conversation(value.conversationId)),
  'INVALID_SESSION_TOOL_INPUT', 'A concrete plugin owner and optional session key are required.');
  return { kind: 'plugin', pluginOwner: value.pluginOwner, ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId }) };
}
function resolveInput(value: JsonValue): ResolveInput {
  assert(isRecord(value), 'INVALID_SESSION_TOOL_INPUT', 'A QQ or plugin target is required.');
  if (value.kind === 'qq') {
    exact(value, ['kind', 'key']);
    assert(conversation(value.key), 'INVALID_SESSION_TOOL_INPUT', 'Use a concrete group or private conversation key.');
    return { kind: 'qq', key: value.key };
  }
  exact(value, ['kind', 'pluginOwner', 'name', 'conversationId']);
  return pluginTarget(value);
}
function listInput(value: JsonValue): ListInput {
  exact(value, ['kind', 'pluginOwner', 'limit']);
  const kind = value.kind ?? 'all', limit = value.limit ?? 100;
  assert((kind === 'all' || kind === 'qq' || kind === 'plugin') && typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100
    && (value.pluginOwner === undefined || kind === 'plugin' && pluginModelIdentifier(value.pluginOwner)),
  'INVALID_SESSION_TOOL_INPUT', 'Choose a session kind and a limit from 1 to 100.');
  return { kind, limit, ...(value.pluginOwner === undefined ? {} : { pluginOwner: value.pluginOwner as string }) };
}
function mutationInput(value: JsonValue, action: 'bind' | 'create' | 'unbind'): MutationInput {
  assert(isRecord(value), 'INVALID_SESSION_TOOL_INPUT', 'Session management requires an explicit target.');
  if (value.kind === 'qq') {
    assert(action !== 'create', 'SESSION_TOOL_QQ_CREATE_UNAVAILABLE', 'QQ session creation uses the conversation runtime.');
    exact(value, ['kind', 'target', ...(action === 'bind' ? ['targetSessionId'] : [])]);
    exact(value.target, ['key', 'sessionId', 'generation', 'bindingRevision']);
    assert(Object.keys(value.target).length === 4 && validNativeSessionResetTarget(value.target)
      && (action !== 'bind' || pluginModelIdentifier(value.targetSessionId)),
    'INVALID_SESSION_TOOL_INPUT', 'QQ management requires the complete current binding revision.');
    return { kind: 'qq', target: { key: value.target.key, sessionId: value.target.sessionId, generation: value.target.generation,
      bindingRevision: value.target.bindingRevision }, ...(action === 'bind' ? { targetSessionId: value.targetSessionId as string } : {}) };
  }
  exact(value, ['kind', 'pluginOwner', 'name', 'conversationId', 'expectedRevision', ...(action === 'bind' ? ['targetSessionId'] : []),
    ...(action === 'create' ? ['model'] : [])]);
  const normalized = { ...value, kind: value.kind ?? (action === 'create' ? 'plugin' : undefined) };
  const target = pluginTarget(normalized);
  const parsed = parsePluginSessionManagementRequest({ action, owner: target.pluginOwner,
    ...(target.name === undefined ? {} : { name: target.name }), ...(target.conversationId === undefined ? {} : { conversationId: target.conversationId }),
    revision: value.expectedRevision, confirm: true, ...(action === 'bind' ? { sessionId: value.targetSessionId } : {}),
    ...(action === 'create' && value.model !== undefined ? { model: value.model } : {}) });
  assert(parsed, 'INVALID_SESSION_TOOL_INPUT', 'Plugin management requires a current expectedRevision and valid action parameters.');
  return { kind: 'plugin', request: parsed };
}
function mutationSchema(action: 'bind' | 'create' | 'unbind'): JsonObject {
  const plugin: JsonObject = { type: 'object', additionalProperties: false,
    required: [...(action === 'create' ? [] : ['kind']), 'pluginOwner', 'expectedRevision', ...(action === 'bind' ? ['targetSessionId'] : [])],
    properties: { ...pluginProperties, expectedRevision: action === 'unbind' ? { type: 'integer', minimum: 1 } : revisionSchema,
      ...(action === 'bind' ? { targetSessionId: identifierSchema } : {}), ...(action === 'create' ? { model: modelSchema } : {}) } };
  if (action === 'create') return plugin;
  const qq: JsonObject = { type: 'object', additionalProperties: false, required: ['kind', 'target', ...(action === 'bind' ? ['targetSessionId'] : [])],
    properties: { kind: { const: 'qq' }, target: targetSchema, ...(action === 'bind' ? { targetSessionId: identifierSchema } : {}) } };
  return { anyOf: [qq, plugin] };
}

/** Secondary owner-only management tools; pluginOwner is a management target, never caller identity. */
export function createNativeSessionDirectoryTools(options: {
  readonly sources: () => NativeMessageSourceReader | undefined;
  readonly modelService: () => PluginModelService | undefined;
  readonly resolveQQ: (key: string) => SessionBinding | null;
  readonly listQQ: () => readonly SessionMetadata[];
  readonly bindQQ: (target: NativeSessionResetTarget, targetSessionId: string, signal: AbortSignal) => unknown | Promise<unknown>;
  readonly unbindQQ: (target: NativeSessionResetTarget) => unknown | Promise<unknown>;
}): readonly DirectoryTool[] {
  async function guard(request: EffectRequest): Promise<void> {
    request.signal.throwIfAborted();
    const sources = options.sources();
    assert(sources, 'NATIVE_MESSAGE_SOURCE_MISSING', 'Session management requires a live normalized owner source.');
    await sources.requireOwner(request.scope, request.signal);
    request.signal.throwIfAborted();
  }
  function modelService(): PluginModelService {
    const service = options.modelService();
    assert(service, 'PLUGIN_MODEL_UNAVAILABLE', 'Plugin session management is unavailable.');
    return service;
  }
  function make<Input>(name: string, description: string, parameters: JsonObject, parse: (value: JsonValue) => Input,
    run: (input: Input, request: EffectRequest) => unknown | Promise<unknown>): DirectoryTool {
    return { category: 'sessions', permission: 'owner', tool: { definition: { name, capability: `native.sessions.${name.slice('qaf_session_'.length)}`,
      featureId: 'framework-tools', timeoutMs: 120000, registrationSource: source, description, parameters }, validate: value => { parse(value); return json(value); } },
    effect: { async execute(request) { const input = parse(request.input); await guard(request); return json(await run(input, request)); } } };
  }
  const tools: DirectoryTool[] = [
    make('qaf_session_resolve', '按QQ地址key或目标插件具名会话查询当前真实模型会话ID与绑定版本。QQ绑定返回target，可直接用于换绑或解绑；插件返回revision，用作expectedRevision。此查询不会创建会话。',
      { anyOf: [ { type: 'object', additionalProperties: false, required: ['kind', 'key'], properties: { kind: { const: 'qq' }, key: conversationSchema } },
        { type: 'object', additionalProperties: false, required: ['kind', 'pluginOwner'], properties: pluginProperties } ] }, resolveInput,
      input => {
        if (input.kind === 'plugin') {
          const binding = modelService().listBindings(input.pluginOwner).find(row => row.name === (input.name ?? 'default')
            && row.conversationId === (input.conversationId ?? null));
          return { status: 'confirmed', kind: 'plugin', binding: binding ?? null };
        }
        const binding = options.resolveQQ(input.key);
        const metadata = binding ? options.listQQ().find(row => row.conversationId === input.key && row.state === 'ready'
          && row.sessionId === binding.sessionId && row.generation === binding.generation) : undefined;
        const target = binding && metadata ? { key: input.key, sessionId: binding.sessionId, generation: binding.generation,
          bindingRevision: nativeSessionBindingRevision(metadata) } : null;
        return { status: 'confirmed', kind: 'qq', binding, target };
      }),
    make('qaf_session_list', '列出QQ和插件的会话绑定，最多100项。kind可为all、qq、plugin；按pluginOwner筛选时kind须为plugin。QQ条目含完整target版本；插件条目含revision、busy与共享的实际sessionId。',
      { type: 'object', additionalProperties: false, properties: { kind: { enum: ['all', 'qq', 'plugin'], default: 'all' },
        pluginOwner: identifierSchema, limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 } } }, listInput,
      input => {
        const qq: JsonValue[] = input.kind === 'plugin' ? [] : options.listQQ().map(row => json({ kind: 'qq', ...row,
          target: row.state === 'ready' && row.sessionId ? { key: row.conversationId, sessionId: row.sessionId, generation: row.generation,
            bindingRevision: nativeSessionBindingRevision(row) } : null }));
        const service = options.modelService();
        if (input.kind === 'plugin') assert(service, 'PLUGIN_MODEL_UNAVAILABLE', 'Plugin session management is unavailable.');
        const plugins: JsonValue[] = input.kind === 'qq' || !service ? [] : service.listBindings(input.pluginOwner).map(binding => json({ kind: 'plugin', ...binding }));
        const all = [...qq, ...plugins];
        return { status: 'confirmed', bindings: all.slice(0, input.limit), limited: all.length > input.limit,
          pluginManagementAvailable: service !== undefined };
      }),
    make('qaf_session_bind', '将空闲QQ或插件绑定切换到明确的targetSessionId。QQ传resolve/list得到的完整target，保持历史并推进generation；两个QQ不能占用同一实际会话。插件传pluginOwner、expectedRevision及可选具名键，可共享QQ或其他插件会话。',
      mutationSchema('bind'), value => mutationInput(value, 'bind'), async (input, request) => {
        if (input.kind === 'qq') {
          assert(input.targetSessionId, 'INVALID_SESSION_TOOL_INPUT', 'A concrete targetSessionId is required.');
          return options.bindQQ(input.target, input.targetSessionId, request.signal);
        }
        assert(input.request.action === 'bind', 'INVALID_SESSION_TOOL_INPUT', 'A plugin binding target is required.');
        const target = input.request;
        const binding = await modelService().bind(target.owner, { name: target.name, conversationId: target.conversationId,
          expectedRevision: target.revision, sessionId: target.sessionId }, request.signal);
        return { status: 'confirmed', kind: 'plugin', binding };
      }),
    make('qaf_session_create', '为目标插件创建一个新的持久模型会话并绑定；默认kind为plugin。先查询插件绑定，将当前revision作为expectedRevision，尚无绑定时传null。model可指定已配置provider/model，省略使用宿主默认模型。创建后返回真实sessionId。',
      mutationSchema('create'), value => mutationInput(value, 'create'), async (input, request) => {
        assert(input.kind === 'plugin' && input.request.action === 'create', 'INVALID_SESSION_TOOL_INPUT', 'Creation requires a concrete plugin target.');
        const target = input.request;
        const binding = await modelService().create(target.owner, { name: target.name, conversationId: target.conversationId,
          expectedRevision: target.revision, ...(target.model === undefined ? {} : { model: target.model }) }, request.signal);
        return { status: 'confirmed', kind: 'plugin', binding };
      }),
    make('qaf_session_unbind', '解除QQ或插件的当前会话绑定并保留实际模型会话历史。QQ使用完整target版本；插件使用pluginOwner、expectedRevision及具名键。仅处理已空闲且执行结果明确的目标；解绑后下次调用可建立新绑定。',
      mutationSchema('unbind'), value => mutationInput(value, 'unbind'), async (input, request) => {
        if (input.kind === 'qq') return options.unbindQQ(input.target);
        const target = input.request;
        assert(target.action === 'unbind', 'INVALID_SESSION_TOOL_INPUT', 'A plugin unbind target is required.');
        const unbound = await modelService().unbind(target.owner, { name: target.name, conversationId: target.conversationId,
          expectedRevision: target.revision }, request.signal);
        return { status: 'confirmed', kind: 'plugin', unbound };
      }),
  ];
  return Object.freeze(tools);
}
