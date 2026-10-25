import assert from 'node:assert/strict';
import test from 'node:test';
import { createOneBotTransport, normalizeOneBotContent, normalizeOneBotMessage, type OneBotIncomingAsset } from '../src/adapters/onebot.ts';

test('incoming forwards register a scoped opaque reference and preserve mixed messages without reading remote content', async () => {
  const registered: OneBotIncomingAsset[] = [];
  const result = await normalizeOneBotMessage({ post_type: 'message', self_id: 999, user_id: 123, message_id: 1,
    message_type: 'group', group_id: 456, message: [{ type: 'text', data: { text: '看看合并转发' } },
      { type: 'forward', data: { id: 'remote-forward-id', url: 'https://ignored.example.test', sender: 'owner' } }] }, {
    selfId: '999', registerIncomingAsset: asset => { registered.push(asset); return 'opaque-forward-1'; },
  });
  assert(result);
  assert.deepEqual(result.content, [{ type: 'text', text: '看看合并转发' }, { type: 'forward-reference', assetId: 'opaque-forward-1' }]);
  assert.deepEqual(registered, [{ kind: 'forward', messageId: '1', conversationId: 'group:456', source: { id: 'remote-forward-id' } }]);
  assert.equal(JSON.stringify(result).includes('remote-forward-id'), false);
  const nested = await normalizeOneBotContent([{ type: 'forward', data: { id: 'nested-forward' } }], {
    messageId: '1', conversationId: 'group:456', registerIncomingAsset: asset => { registered.push(asset); return 'opaque-forward-2'; },
  });
  assert.deepEqual(nested, [{ type: 'forward-reference', assetId: 'opaque-forward-2' }]);
  let sends = 0;
  const transport = createOneBotTransport({ endpoint: 'http://127.0.0.1:1', fetch: async () => { sends++; throw new Error('Must not send incoming handles'); } });
  assert.deepEqual(await transport.send({ conversationId: 'group:456', content: result.content,
    idempotencyKey: 'forward-ref-send', signal: new AbortController().signal }), { status: 'rejected' });
  assert.equal(sends, 0);
});
