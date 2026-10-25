import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNativeReplyDecision } from '../src/contracts/native-reply-decision.ts';
import { createReplyWatchdog } from '../src/host/replies.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

test('only an exact versioned final reply decision is consumed as control', () => {
  const parse = (input: unknown) => parseNativeReplyDecision([{ type: 'text', text: JSON.stringify(input) }]);
  assert.deepEqual(parse({ schema: 'qaf.reply/1', action: 'silent', reason: 'not-addressed' }), { state: 'silent', reason: 'not-addressed' });
  assert.equal(parse({ message: 'hello' }), null);
  assert.equal(parseNativeReplyDecision([{ type: 'text', text: 'hello' }]), null);
  assert.deepEqual(parse({ schema: 'qaf.reply/1', action: 'send', reason: 'unknown' }), { state: 'invalid', reason: 'invalid_reply_decision' });
  assert.equal(parseNativeReplyDecision([{ type: 'image', assetId: 'resource' }]), null);
});

test('suppression is durable, can precede acceptance acknowledgement and does not suppress the next request', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const binding = { conversationId: 'group:123', sessionId: 'session-1', generation: 1 };
  const replies = createReplyWatchdog({ store, timeoutMs: 1000, onTimeout() { assert.fail('No timeout for a suppressed reply'); } });
  try {
    replies.suppress(binding, 'message-1'); replies.watch(binding, 'message-1');
    assert.equal(replies.get(binding.conversationId)?.status, 'suppressed');
    assert.equal(replies.metrics().pending, 0);
    replies.watch(binding, 'message-2'); assert.equal(replies.get(binding.conversationId)?.status, 'waiting');
    replies.suppress(binding, 'message-2'); assert.equal(replies.metrics().pending, 0);
  } finally { await replies.stop(); store.close(); }
});
