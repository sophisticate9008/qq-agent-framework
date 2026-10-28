import assert from 'node:assert/strict';
import test from 'node:test';
import { inboxDeadline, inboxStateLabel, type ChatInboxItem } from '../web/lib/chat-inbox.ts';
const item: ChatInboxItem = { conversationId: 'group:123', state: 'pending', pending: 2, oldestReceivedAt: 100,
  deadlineAt: 1000, lastError: null, expired: 0, automaticReplayAvailable: false };

test('inbox labels distinguish pending, active and isolated receipts without promising replay', () => {
  assert.equal(inboxStateLabel(item), '正在排队');
  assert.equal(inboxStateLabel({ ...item, state: 'dispatching' }), '正在处理');
  assert.equal(inboxStateLabel({ ...item, state: 'blocked' }), '旧队列待整理');
  assert.equal(inboxStateLabel(undefined), '空闲');
  assert.equal(inboxDeadline(item)?.iso, '1970-01-01T00:00:01.000Z');
  assert.equal(inboxDeadline({ ...item, deadlineAt: 1e100 }), null);
  assert.equal(inboxDeadline({ ...item, deadlineAt: null }), null);
});
