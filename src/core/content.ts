import { assert, isRecord, reference, snapshot } from './values.ts';
import type { MessageContent } from './types.ts';

export function normalizeContent(input: unknown): readonly MessageContent[] {
  const blocks = snapshot(input);
  assert(Array.isArray(blocks) && blocks.length > 0 && blocks.length <= 8,
    'INVALID_CONTENT', 'A bounded, nonempty message is required.');
  for (const block of blocks) {
    assert(isRecord(block), 'INVALID_CONTENT', 'Message segments must be objects.');
    const allowed = block.type === 'forward' ? ['type', 'nodes'] : block.type === 'text' ? ['type', 'text']
      : block.type === 'file' ? ['type', 'assetId', 'name']
      : block.type === 'mention' ? ['type', 'userId']
      : block.type === 'reply' ? ['type', 'messageId'] : ['type', 'assetId'];
    assert(Object.keys(block).every(key => allowed.includes(key)), 'INVALID_CONTENT', 'Unexpected message fields.');
    if (block.type === 'forward') {
      assert(blocks.length === 1 && Array.isArray(block.nodes) && block.nodes.length > 0 && block.nodes.length <= 32,
        'INVALID_CONTENT', 'A forward must contain bounded nodes and be sent separately.');
      for (const node of block.nodes) {
        assert(isRecord(node) && Object.keys(node).length === 1 && Array.isArray(node.content)
          && node.content.every(item => isRecord(item) && item.type !== 'forward'),
        'INVALID_CONTENT', 'Forward nodes contain only basic content and no sender impersonation.');
        normalizeContent(node.content);
      }
    } else if (block.type === 'text') {
      assert(typeof block.text === 'string' && block.text.length > 0 && block.text.length <= 8000,
        'INVALID_CONTENT', 'Text must be nonempty and bounded.');
    } else if (block.type === 'image' || block.type === 'audio' || block.type === 'file') {
      assert(reference(block.assetId), 'INVALID_CONTENT', 'Media requires a registered asset reference.');
      if (block.type === 'file') assert(typeof block.name === 'string' && block.name.length > 0 && block.name.length <= 255
        && !/[\x00-\x1f\x7f/\\]/.test(block.name), 'INVALID_CONTENT', 'A bounded filename is required.');
    } else if (block.type === 'mention') {
      assert(reference(block.userId), 'INVALID_CONTENT', 'A mention requires a user reference.');
    } else {
      assert(block.type === 'reply' && reference(block.messageId), 'INVALID_CONTENT', 'Unsupported message segment.');
    }
  }
  assert(Buffer.byteLength(JSON.stringify(blocks), 'utf8') <= 64 * 1024, 'INVALID_CONTENT', 'Message payload is too large.');
  return blocks as MessageContent[];
}
