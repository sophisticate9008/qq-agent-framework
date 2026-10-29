import { nativeToolCapabilityDefinition } from '../contracts/native-tool-capabilities.ts';
import { normalizeContent } from '../core/content.ts';
import { boundedTextChunks } from '../core/text-chunks.ts';
import type { EffectAdapter, JsonValue, MessageContent } from '../core/types.ts';
import { assert, isRecord } from '../core/values.ts';
import { digest, json } from './data.ts';
import type { NativeToolContribution } from './native-framework-tools.ts';
import { parseNativeOutputContent } from './native-output.ts';
import type { NativeMessageSourceReader } from './native-message-sources.ts';

/** Convert the tool wire value into the existing output planner's bounded message format. */
function replyContent(value: unknown): readonly MessageContent[] {
  if (Array.isArray(value)) return normalizeContent(value);
  assert(typeof value === 'string' || isRecord(value) && value.schema === 'qbf.output/1',
    'INVALID_REPLY_INPUT', 'Reply content must be text, message content, or a qbf.output/1 envelope.');
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const chunks = boundedTextChunks(text, 8000, 8);
  assert(chunks, 'INVALID_REPLY_INPUT', 'Reply text exceeds its bounded size.');
  return normalizeContent(chunks.map(text => ({ type: 'text', text })));
}
function replyInput(input: JsonValue): JsonValue {
  assert(isRecord(input) && Object.keys(input).length === 1 && input.content !== undefined,
    'INVALID_REPLY_INPUT', 'Reply accepts one content field for the current conversation.');
  return { content: json(replyContent(input.content)) };
}
const tool = nativeToolCapabilityDefinition('native.reply');
export const NATIVE_REPLY_TOOLS: readonly NativeToolContribution[] = Object.freeze<readonly NativeToolContribution[]>([
  { definition: { name: tool.tool, capability: tool.capability, description: tool.description, featureId: 'framework-tools', timeoutMs: 120000,
    registrationSource: { origin: 'framework-builtin', ownerId: 'qq-bridge-framework', ownerName: '框架内置工具', transport: 'native' },
    parameters: { type: 'object', additionalProperties: false, required: ['content'], properties: {
      content: { description: '发送的文字、结构化消息数组，或包含schema:qbf.output/1的对象。资源仅使用当前会话已登记assetId。',
        oneOf: [ { type: 'string', minLength: 1, maxLength: 64000 }, { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object' } },
          { type: 'object', required: ['schema'], properties: { schema: { const: 'qbf.output/1' } } } ] }
    } } }, validate: replyInput, deliveryCapabilities: ['messaging.send', 'messaging.forward'],
    async afterInvoke(value, execution, event, host) {
      assert(isRecord(value) && typeof value.nativeRequestId === 'string', 'INVALID_REPLY_INPUT', 'A trusted reply source is required.');
      const content = normalizeContent(value.content);
      let contentFingerprint: string;
      try { contentFingerprint = digest(parseNativeOutputContent(content)); } catch { contentFingerprint = digest(content); }
      const result = await host.deliverAgentMessage(execution, { ...event, data: { ...event.data,
        content: json(content), agentData: { nativeRequestId: value.nativeRequestId, nativeContentFingerprint: contentFingerprint } } });
      return json(result);
    } }
]);

/** Capability invocation validates the real QQ source before the admitted execution sends. */
export function createNativeReplyEffects(options: {
  readonly sources: () => NativeMessageSourceReader | undefined;
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>;
}): Readonly<Record<string, EffectAdapter>> {
  return { 'native.reply': { async execute(request) {
    await options.authorize(request.scope.conversationId, request.signal);
    const reader = options.sources();
    assert(reader, 'NATIVE_MESSAGE_SOURCE_MISSING', 'A current normalized QQ source is required.');
    const source = await reader.lookup(request.scope, request.signal);
    request.signal.throwIfAborted();
    // Input has already passed the tool decoder; direct effect invocations get the same boundary.
    assert(isRecord(request.input) && Object.keys(request.input).length === 1,
      'INVALID_REPLY_INPUT', 'Reply accepts one content field.');
    return { content: json(replyContent(request.input.content)),
      nativeRequestId: digest([source.conversationId, source.sourceMessageId, 'prompt']) };
  } } };
}
