import type { EffectAdapter, EffectRequest } from '../core/types.ts';
import { assert, isRecord } from '../core/values.ts';
import type { NativeMessageSourceReader } from './native-message-sources.ts';
import type { NativeMemoryPackageService } from './default-native-packages.ts';
import { json } from './data.ts';

export function createNativeMemoryEffects(options: {
  readonly service: () => NativeMemoryPackageService | undefined;
  readonly sources: () => NativeMessageSourceReader | undefined;
}): Readonly<Record<string, EffectAdapter>> {
  async function source(request: EffectRequest) {
    const sources = options.sources();
    assert(sources, 'MEMORY_SOURCE_INVALID', 'The current normalized message source is unavailable.');
    return sources.lookup(request.scope, request.signal);
  }
  function service() {
    const value = options.service();
    assert(value, 'MEMORY_UNAVAILABLE', 'The memory package is not running.');
    return value;
  }
  return Object.freeze({
    'memory.query': { async execute(request: EffectRequest) {
      assert(isRecord(request.input) && Object.keys(request.input).length === 1 && typeof request.input.query === 'string'
        && request.input.query.length <= 256, 'MEMORY_INVALID', 'One bounded query is required.');
      const proof = await source(request);
      return json(await service().context({ conversationId: proof.conversationId, userId: proof.userId,
        query: request.input.query, limit: 8, maxCharacters: 4000, maxBytes: 12_000 }, request.signal));
    } },
    'memory.propose': { async execute(request: EffectRequest) {
      assert(isRecord(request.input) && Object.keys(request.input).length === 4
        && ['kind', 'content', 'tags', 'expiresAt'].every(key => Object.hasOwn(request.input as object, key)),
      'MEMORY_INVALID', 'A proposal contains only bounded memory data.');
      const proof = await source(request);
      const entry = await service().propose({ ...request.input,
        scope: { kind: 'user', conversationId: proof.conversationId, userId: proof.userId } },
      { kind: 'model-inference', conversationId: proof.conversationId, messageId: proof.sourceMessageId, userId: proof.userId }, request.signal);
      return json({ entry, confirmation: { method: 'qq-owner-command', command: `/确认记忆 ${entry.id}` },
        injected: false, authorization: false });
    } }
  });
}
