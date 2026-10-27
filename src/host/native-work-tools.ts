import { nativeToolCapabilityDefinition, type NativeToolCapability } from '../contracts/native-tool-capabilities.ts';
import type { JsonObject, JsonValue, EffectAdapter, EffectRequest } from '../core/types.ts';
import { assert, isRecord } from '../core/values.ts';
import type { NativeToolContribution } from './native-framework-tools.ts';
import type { createNativeWorkExecutor } from './native-work.ts';
import type { NativeMessageSourceReader } from './native-message-sources.ts';
import { json } from './data.ts';

const definitions: readonly { name: string; capability: NativeToolCapability; properties: JsonObject }[] = [
  { name: 'qaf_work_start', capability: 'native.work.start',
    properties: { task: { type: 'string', minLength: 1, maxLength: 16000, description: '交给助手执行的具体要求，保留用户指定的路径、内容和交付目标。' },
      context: { type: 'string', maxLength: 32000, description: '完成任务必需的上下文；没有补充时传空字符串，不复制整段聊天或把先前未经核实的能力判断当成限制。' } } },
  { name: 'qaf_work_status', capability: 'native.work.status', properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
  { name: 'qaf_work_followup', capability: 'native.work.followup',
    properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' }, text: { type: 'string', minLength: 1, maxLength: 16000 }, delivery: { enum: ['queue', 'steer'] } } },
  { name: 'qaf_work_interrupt', capability: 'native.work.interrupt', properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
  { name: 'qaf_work_reconcile', capability: 'native.work.reconcile', properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } } }
];
export const NATIVE_WORK_TOOLS: readonly NativeToolContribution[] = definitions.map(tool => ({
  definition: { registrationSource: { origin: 'framework-builtin' as const, ownerId: 'qq-agent-framework', ownerName: '框架内置工具', transport: 'native' as const }, name: tool.name, capability: tool.capability, description: nativeToolCapabilityDefinition(tool.capability).description, featureId: 'framework-tools', timeoutMs: tool.name === 'qaf_work_start' ? 30000 : 10000,
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
