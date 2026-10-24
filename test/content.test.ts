import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContent } from '../src/core/content.ts';

test('structured content is detached and deeply frozen', () => {
  const blocks = [{ type: 'text', text: 'hello' }, { type: 'image', assetId: 'approved-image' },
    { type: 'audio', assetId: 'approved-audio' }, { type: 'file', assetId: 'approved-file', name: 'report.pdf' },
    { type: 'mention', userId: '123' }, { type: 'reply', messageId: '456' }];
  const result = normalizeContent(blocks);
  blocks[0].text = 'changed';
  assert.equal(result[0].type === 'text' && result[0].text, 'hello');
  assert(Object.isFrozen(result) && result.every(Object.isFrozen));
});

test('media references cannot smuggle raw files, hidden fields or oversized data', () => {
  for (const input of [[], Array.from({ length: 9 }, () => ({ type: 'text', text: 'hello' })),
    [{ type: 'image', file: '/private' }], [{ type: 'image', assetId: 'asset', url: 'https://invalid.test' }],
    [{ type: 'file', assetId: 'asset', name: '../private' }], [{ type: 'mention', userId: '' }],
    [{ type: 'reply', messageId: '' }], [{ type: 'native', data: {} }],
    Array.from({ length: 8 }, () => ({ type: 'text', text: '图'.repeat(8000) }))]) {
    assert.throws(() => normalizeContent(input), { code: 'INVALID_CONTENT' });
  }
});
