import type { JsonObject, JsonValue, EffectAdapter, EffectRequest } from '../core/types.ts';
import { assert, isRecord } from '../core/values.ts';
import type { NativeToolContribution } from './native-framework-tools.ts';
import type { createNativeWorkExecutor } from './native-work.ts';
import type { NativeMessageSourceReader } from './native-message-sources.ts';
import { json } from './data.ts';

const definitions: readonly { name: string; capability: string; description: string; properties: JsonObject }[] = [
  { name: 'qaf_work_start', capability: 'native.work.start', description: '接受当前实际主人的明确工作委派，在独立助手运行并将结果送回当前QQ会话。聊天可继续。仅当前配置主人可以发起；失败或未知不自动重复执行。',
    properties: { task: { type: 'string', minLength: 1, maxLength: 16000 }, context: { type: 'string', maxLength: 32000 } } },
  { name: 'qaf_work_status', capability: 'native.work.status', description: '读取当前会话内一项工作的实际状态、结果和投递回执。查询不会重放工作。', properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
  { name: 'qaf_work_followup', capability: 'native.work.followup', description: '按当前实际主人的明确要求给原工作追加内容。queue排队，steer调整正在进行的工作。只限原会话和当前父会话代次。',
    properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' }, text: { type: 'string', minLength: 1, maxLength: 16000 }, delivery: { enum: ['queue', 'steer'] } } },
  { name: 'qaf_work_interrupt', capability: 'native.work.interrupt', description: '按当前实际主人的明确要求停止原工作，保留实际停止状态和已产出的结果。未知结果不重复停止。', properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
  { name: 'qaf_work_reconcile', capability: 'native.work.reconcile', description: '按当前实际主人的明确要求核对未知工作的SDK证据；不重新执行工作，也不自动补发结果。', properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } } }
];
export const NATIVE_WORK_TOOLS: readonly NativeToolContribution[] = definitions.map(tool => ({
  definition: { name: tool.name, capability: tool.capability, description: tool.description, featureId: 'framework-tools', timeoutMs: 10000,
    parameters: { type: 'object', additionalProperties: false, required: Object.keys(tool.properties), properties: tool.properties } },
  validate(input: JsonValue): JsonValue {
    assert(isRecord(input) && Object.keys(input).length === Object.keys(tool.properties).length
      && Object.keys(tool.properties).every(key => Object.hasOwn(input, key)), 'INVALID_NATIVE_WORK_INPUT', 'Unexpected work input fields.');
    for (const [key, value] of Object.entries(input)) assert(typeof value === 'string' && (key === 'id' ? /^[a-f0-9]{64}$/.test(value)
      : key === 'delivery' ? ['queue', 'steer'].includes(value) : value.length <= (key === 'context' ? 32000 : 16000)
        && (key === 'context' || value.trim().length > 0)), 'INVALID_NATIVE_WORK_INPUT', 'Invalid work input value.');
    return input as JsonObject;
  }
}));

export function createNativeWorkEffects(options: {
  readonly executor: () => ReturnType<typeof createNativeWorkExecutor> | undefined;
  readonly sources: () => NativeMessageSourceReader | undefined;
}): Readonly<Record<string, EffectAdapter>> {
  function executor() { const value = options.executor(); assert(value, 'NATIVE_WORK_BACKEND_UNAVAILABLE', 'The independent work backend is unavailable.'); return value; }
  return Object.freeze({
    'native.work.start': { execute: (request: EffectRequest) => executor().execute(request) },
    'native.work.followup': { execute: (request: EffectRequest) => executor().followup(request) },
    'native.work.interrupt': { execute: (request: EffectRequest) => executor().interrupt(request) },
    'native.work.reconcile': { execute: async (request: EffectRequest) => json(await executor().reconcile(request)) },
    'native.work.status': { async execute(request: EffectRequest) {
      assert(isRecord(request.input) && Object.keys(request.input).length === 1 && typeof request.input.id === 'string',
        'INVALID_NATIVE_WORK_INPUT', 'One work identifier is required.');
      const source = options.sources(); assert(source, 'NATIVE_MESSAGE_SOURCE_MISSING', 'The current message source is unavailable.');
      await source.lookup(request.scope, request.signal);
      const view = executor().read(request.input.id);
      assert(view && view.conversationId === request.scope.conversationId && view.parentSessionId === request.scope.sessionId
        && view.generation === request.scope.generation, 'NATIVE_WORK_SCOPE_MISMATCH', 'This work belongs to another parent scope.');
      return json(view);
    } }
  });
}
