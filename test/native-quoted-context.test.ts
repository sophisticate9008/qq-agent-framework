import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeQuotedContext } from '../src/host/native-quoted-context.ts';
import type { OneBotReadResult, OneBotMessageInfo } from '../src/adapters/onebot-actions.ts';

test('quoted context validates scope, reads bounded references and caches without trusting forwarded sender claims', async () => {
  let allowed = true; let reads = 0;
  const context = createNativeQuotedContext({ selfId: '999',
    async authorize(scope) { assert.equal(scope, 'group:456'); if (!allowed) throw new Error('access withdrawn'); },
    async register(request) { assert.equal(request.conversationId, 'group:456'); return 'scoped-image'; },
    protocol: { async getMessage(request): Promise<OneBotReadResult<OneBotMessageInfo>> { reads++;
      return { status: 'confirmed', data: { messageId: request.messageId, conversationId: request.conversationId, userId: '999',
        message: [{ type: 'text', data: { text: '原来的回答' } }, { type: 'image', data: { file: 'opaque-file' } }] } }; } } });
  const message = { conversationId: 'group:456', content: [{ type: 'reply' as const, messageId: '123' }] };
  const first = await context.read(message, [], new AbortController().signal);
  assert.equal(first[0]?.actor, 'assistant'); assert.equal(first[0]?.content[1]?.type, 'image');
  assert(!JSON.stringify(first).includes('opaque-file'));
  assert.deepEqual(await context.read(message, [], new AbortController().signal), first); assert.equal(reads, 1);
  allowed = false;
  await assert.rejects(context.read(message, [], new AbortController().signal), /access withdrawn/);
  assert.equal(reads, 1);
});

test('unavailable or cross-scope quotes stay missing and local retained history needs no protocol read', async () => {
  let result: OneBotReadResult<OneBotMessageInfo> = { status: 'unknown', code: 'missing' };
  let calls = 0;
  const observations: { status: string; code: string | null }[] = [];
  const context = createNativeQuotedContext({ selfId: '999', async authorize() {}, async register() { return 'resource'; },
    observe(conversationId, result) { assert.equal(conversationId, 'group:456'); observations.push(result); },
    protocol: { async getMessage() { calls++; return result; } } });
  const message = { conversationId: 'group:456', content: [{ type: 'reply' as const, messageId: '123' }] };
  assert.deepEqual(await context.read(message, [], new AbortController().signal), []);
  result = { status: 'confirmed', data: { messageId: '123', conversationId: 'group:777', userId: '999',
    message: [{ type: 'text', data: { text: 'other scope' } }] } };
  assert.deepEqual(await context.read(message, [], new AbortController().signal), []);
  assert.equal(calls, 2);
  assert.deepEqual(observations.map(({ status, code }) => ({ status, code })), [
    { status: 'unknown', code: 'missing' }, { status: 'rejected', code: 'QUOTED_CONTEXT_SCOPE_MISMATCH' }]);
  assert.deepEqual(await context.read(message, [{ id: '123', actor: 'assistant', receivedAt: 1,
    content: [{ type: 'text', text: 'already retained' }] }], new AbortController().signal), []);
  assert.equal(calls, 2);
});
