import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeExecutionController } from '../src/host/native-execution.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { executionCancelLabel, executionContinuationLabel, executionConversationLabel, executionJournalPath, executionLateLabel, executionNoticeLabel, executionPresentation, mergeExecutionJournalPages, parseExecutionJournalEntry, parseExecutionJournalPage } from '../web/lib/execution-journal.ts';
import { executionRecord } from './fixtures/execution-records.ts';

function page(items: readonly unknown[], next: string | null = null, partial = false) {
  return { native: true, items, next, manualCancelAvailable: false, partial };
}

test('execution parser uses trusted record shape and does not retain policy text, extra bodies or raw response', () => {
  const source = executionRecord(1, { userMessage: { eventId: 'message-proof', messageId: 'accepted-message' },
    turn: { id: 'turn:1', evidenceId: 'turn-proof' } });
  const parsed = parseExecutionJournalEntry({ ...source, messageBody: 'private fixture body', token: 'synthetic-never-retain' });
  assert(parsed);
  assert.equal(parsed.id, source.id);
  assert.equal(parsed.userMessage?.messageId, 'accepted-message');
  assert.equal(parsed.turn?.id, 'turn:1');
  assert.equal(Object.hasOwn(parsed, 'policy'), false);
  assert.equal(Object.hasOwn(parsed, 'messageBody'), false);
  assert.equal(JSON.stringify(parsed).includes('private fixture body'), false);
  assert.equal(JSON.stringify(parsed).includes('synthetic-never-retain'), false);
});

test('malformed execution identities, states, clocks, counters and missing fields are rejected rather than defaulted', () => {
  const source = executionRecord(1);
  for (const changed of [
    { schema: 2 }, { id: 'not-a-native-cursor' }, { cursor: 'b'.repeat(64) }, { revision: null }, { revision: 0 },
    { requestId: 'unsafe\nrequest' }, { policyRevision: 'other' }, { binding: { ...source.binding, generation: 0 } },
    { admittedAt: null }, { deadlineAt: source.admittedAt - 1 }, { admittedAt: 9e15 },
    { progressEvents: -1 }, { progressEvents: null }, { status: 'success' }, { externalStatus: 'partial' },
    { isolated: undefined }, { deadlineReached: null }, { cancelStatus: 'stopped' }, { noticeStatus: 'sent' },
    { userMessage: undefined }, { turn: { id: 'turn' } }, { lastEventId: undefined }, { lastError: 500 },
    { lateOutcome: { eventId: 'late', outcome: 'success' } },
  ]) assert.equal(parseExecutionJournalEntry({ ...source, ...changed }), null, JSON.stringify(changed));
});

test('only the explicit read-only envelope is accepted, preserving partial and remaining positions', () => {
  const parsed = parseExecutionJournalPage(page([executionRecord(1)], executionRecord(1).cursor, true));
  assert(parsed);
  assert.equal(parsed.partial, true);
  assert.equal(parsed.next, executionRecord(1).cursor);
  assert.equal(parsed.manualCancelAvailable, false);
  for (const changed of [{ native: false }, { items: null }, { next: undefined }, { next: 'unsafe' },
    { manualCancelAvailable: undefined }, { manualCancelAvailable: true }, { partial: 'unknown' },
    { items: [executionRecord(1), executionRecord(1)] },
    { items: Array.from({ length: 1001 }, (_, index) => executionRecord(index)) },
  ]) assert.equal(parseExecutionJournalPage({ ...page([]), ...changed }), null);
  assert.equal(parseExecutionJournalPage(page([], 'c'.repeat(64), true))?.partial, true);
});

test('execution page merge deduplicates and refuses state regression while retaining partial uncertainty', () => {
  const first = parseExecutionJournalPage(page([executionRecord(1), executionRecord(2)], executionRecord(2).cursor, true));
  const newer = parseExecutionJournalPage(page([{ ...executionRecord(1, { status: 'unknown', externalStatus: 'unknown', isolated: true }), revision: 2 }, executionRecord(3)]));
  assert(first && newer);
  const merged = mergeExecutionJournalPages(first, newer);
  assert.equal(merged.page.items.length, 3);
  assert.equal(merged.changed, 1);
  assert.equal(merged.page.items[0].status, 'unknown');
  assert.equal(merged.page.partial, true);
  const stale = parseExecutionJournalPage(page([executionRecord(1, { status: 'completed', externalStatus: 'completed' })]));
  assert(stale);
  assert.equal(mergeExecutionJournalPages(merged.page, stale).page.items[0].status, 'unknown');
  const contradictory = parseExecutionJournalPage(page([{ ...executionRecord(1, { status: 'completed', externalStatus: 'completed', isolated: false }), revision: 2 }]));
  assert(contradictory);
  assert.equal(mergeExecutionJournalPages(merged.page, contradictory).page.items[0].status, 'unknown');
});

test('execution pagination is same-origin and bounded with only trusted hex cursors', () => {
  assert.equal(executionJournalPath(), '/api/chat/executions?limit=100&order=recent');
  assert.equal(executionJournalPath('a'.repeat(64)), `/api/chat/executions?limit=100&order=recent&after=${'a'.repeat(64)}`);
  for (const cursor of ['//elsewhere', 'a&limit=50000', '', 'A'.repeat(64), 'a'.repeat(63)]) assert.throws(() => executionJournalPath(cursor));
});

test('unknown, inconsistent and timed-out results cannot become green success from a late external completion', () => {
  const complete = executionRecord(1, { status: 'completed', externalStatus: 'completed', isolated: false,
    userMessage: { eventId: 'message-proof', messageId: 'message-1' }, turn: { id: 'turn-1', evidenceId: 'turn-proof' }, lastEventId: 'final-1' });
  assert.equal(executionPresentation(complete).tone, 'success');
  for (const record of [
    { ...complete, isolated: true }, { ...complete, externalStatus: 'unknown' as const },
    { ...complete, cancelStatus: 'accepted' as const },
    { ...complete, turn: null }, { ...complete, userMessage: null }, { ...complete, lastEventId: null },
    { ...complete, deadlineReached: true },
    { ...complete, lateOutcome: { eventId: 'late', outcome: 'completed' as const } },
    executionRecord(2, { status: 'unknown', externalStatus: 'completed' }),
    executionRecord(3, { status: 'timed-out', externalStatus: 'completed', deadlineReached: true }),
  ]) assert.notEqual(executionPresentation(record).tone, 'success');
  assert.equal(executionPresentation(executionRecord(1, { status: 'unknown', externalStatus: 'unknown', isolated: true })).label, '结果未知');
  assert.equal(executionPresentation(executionRecord(1, { deadlineReached: true })).label, '已超时');
});

test('normal task waiting remains distinct from uncertain-result isolation and never suggests a reset', () => {
  assert.equal(executionContinuationLabel(executionRecord(1)), '等待本次任务结束');
  assert.equal(executionContinuationLabel(executionRecord(1, { status: 'unknown', externalStatus: 'unknown' })), '暂停后续任务');
  assert.equal(executionContinuationLabel(executionRecord(1, { deadlineReached: true })), '暂停后续任务');
  assert.equal(executionContinuationLabel(executionRecord(1, { isolated: false })), '本轮未暂停后续处理');
  assert.equal(executionPresentation(executionRecord(1, { status: 'rejected', externalStatus: 'rejected', isolated: false })).label, '未受理');
  assert.equal(executionPresentation(executionRecord(1, { status: 'failed', externalStatus: 'cancelled', isolated: false, cancelStatus: 'confirmed' })).label, '已确认停止');
});

test('accepted cancellation, unknown notices and record-only late finals remain explicitly unconfirmed', () => {
  assert.match(executionCancelLabel('accepted'), /仅已受理.*尚未确认/);
  assert.match(executionCancelLabel('unknown'), /未知/);
  assert.match(executionNoticeLabel('unknown'), /未知.*不自动重发/);
  assert.match(executionLateLabel(executionRecord(1, { lateOutcome: { eventId: 'late', outcome: 'completed' } })) ?? '', /仅留档.*不补发.*不归属/);
  assert.equal(executionLateLabel(executionRecord(1)), null);
  assert.equal(executionConversationLabel('private:123'), '私聊 123');
  assert.equal(executionConversationLabel('internal:uuid-synthetic'), '其他会话（标识见技术详情）');
});

test('actual native controller list records parse without reassembling production data or invoking external adapters', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const controller = createNativeExecutionController({ store, clock: () => 1000 });
  try {
    controller.start();
    controller.admit({ binding: { conversationId: 'private:123', sessionId: 'isolated-test-session', generation: 1 }, requestId: 'isolated-request', policyRevision: 'a'.repeat(64) });
    const records = controller.list({ limit: 100 });
    assert.equal(records.length, 1);
    const parsed = parseExecutionJournalPage(page(records));
    assert(parsed);
    assert.equal(parsed.items[0].status, 'prepared');
    assert.equal(executionPresentation(parsed.items[0]).label, '准备中');
    assert.equal(Object.hasOwn(parsed.items[0], 'policy'), false);
  } finally { await controller.stop(); store.close(); }
});

test('actual controller timeout and lost-stream records stay unknown without calling model, notice or cancel adapters', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  let now = 1000;
  const controller = createNativeExecutionController({ store, clock: () => now });
  try {
    controller.start();
    const execution = controller.admit({ binding: { conversationId: 'private:123', sessionId: 'isolated-session', generation: 1 }, requestId: 'isolated-request', policyRevision: 'a'.repeat(64) });
    await controller.submit(execution.id, async () => ({ status: 'accepted' }));
    controller.lost(execution.id);
    now = execution.deadlineAt;
    controller.tick();
    const parsed = parseExecutionJournalPage(page(controller.list()));
    assert(parsed);
    assert.equal(parsed.items[0].externalStatus, 'unknown');
    assert.equal(parsed.items[0].deadlineReached, true);
    assert.equal(executionPresentation(parsed.items[0]).label, '已超时');
    assert.equal(executionContinuationLabel(parsed.items[0]), '暂停后续任务');
    assert.notEqual(executionPresentation(parsed.items[0]).tone, 'success');
  } finally { await controller.stop(); store.close(); }
});
