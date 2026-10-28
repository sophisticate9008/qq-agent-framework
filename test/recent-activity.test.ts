import assert from 'node:assert/strict';
import test from 'node:test';
import { activityConversationLabel, activityStateLabel, activityTypeLabel, parseRecentActivity } from '../web/lib/recent-activity.ts';

const entry = { id: 'one', at: 1_700_000_000_000, level: 'info', type: 'received', conversationId: 'group:123', summary: '收到一条消息' };
const snapshot = { source: 'native-chat', retention: 'process', capacity: 100, state: 'running', items: [entry] };

test('activity parser accepts the exact native process DTO and keeps server order without mutation', () => {
  const input = { ...snapshot, items: [{ ...entry, id: 'newer-label', at: 2 }, { ...entry, id: 'older-label', at: 9 }] };
  const before = JSON.stringify(input);
  const result = parseRecentActivity(input);
  assert(result);
  assert.deepEqual(result.items.map(item => item.id), ['newer-label', 'older-label']);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(result.items, input.items);
  assert.notEqual(result.items[0], input.items[0]);
});

test('activity snapshot accepts zero through 100 entries but rejects overflow and duplicate IDs', () => {
  const items = Array.from({ length: 100 }, (_, index) => ({ ...entry, id: `entry-${index}` }));
  assert.equal(parseRecentActivity({ ...snapshot, items })?.items.length, 100);
  assert.equal(parseRecentActivity({ ...snapshot, items: [] })?.items.length, 0);
  assert.equal(parseRecentActivity({ ...snapshot, items: [...items, { ...entry, id: 'overflow' }] }), null);
  assert.equal(parseRecentActivity({ ...snapshot, items: [entry, entry] }), null);
});

test('activity parser rejects unknown sources, retention, capacity, state and malformed items', () => {
  for (const value of [null, [], {}, { ...snapshot, source: 'legacy-bridge' }, { ...snapshot, retention: 'disk' },
    { ...snapshot, capacity: '100' }, { ...snapshot, capacity: 99 }, { ...snapshot, state: 'unknown' }, { ...snapshot, items: null }]) {
    assert.equal(parseRecentActivity(value), null);
  }
  for (const patch of [{ id: '' }, { at: '1' }, { at: -1 }, { at: 1.5 }, { at: Number.NaN }, { at: 8_640_000_000_000_001 },
    { level: 'debug' }, { type: 'thinking' }, { conversationId: 123 }, { conversationId: '' }, { summary: null }, { summary: '' }]) {
    assert.equal(parseRecentActivity({ ...snapshot, items: [{ ...entry, ...patch }] }), null);
  }
});

test('activity output keeps summary as text and discards unrecognized body/thinking/raw error fields', () => {
  const summary = '<img src=x onerror="alert(1)">';
  const content = '已脱敏的公开消息摘录 [已隐藏]';
  const result = parseRecentActivity({ ...snapshot, items: [{ ...entry, summary, content, body: 'never display', thinking: 'never display', rawError: 'never display' }] });
  assert(result);
  assert.equal(result.items[0]?.summary, summary);
  assert.equal(result.items[0]?.content, content);
  assert.equal(JSON.stringify(result).includes('never display'), false);
  for (const type of ['processed', 'timeout', 'error', 'runtime']) assert.equal(parseRecentActivity({ ...snapshot, items: [{ ...entry, type, content: 'not a public message excerpt' }] })?.items[0]?.content, null);
  assert.equal(parseRecentActivity({ ...snapshot, items: [{ ...entry, content: 'x'.repeat(2001) }] }), null);
  assert.deepEqual(Object.keys(result.items[0]!).sort(), ['at', 'content', 'conversationId', 'count', 'errorCode', 'id', 'level', 'summary', 'type']);
});

test('activity labels are human-readable and stopped explicitly excludes other bridge logs', () => {
  assert.equal(activityConversationLabel('group:123'), '群聊 123');
  assert.equal(activityConversationLabel('private:456'), '私聊 456');
  assert.equal(activityConversationLabel(null), '系统');
  assert.equal(activityConversationLabel('other:untrusted'), '会话');
  assert.equal(activityStateLabel('stopped'), '当前聊天宿主未启动；此处不读取其他桥接进程日志');
  assert.equal(activityTypeLabel('processed'), '消息处理');
  assert.equal(activityTypeLabel('sent'), '发送回执');
  assert.doesNotMatch(activityTypeLabel('processed') + activityTypeLabel('sent'), /完成|成功|已发送/);
  for (const type of ['received', 'processed', 'sent', 'timeout', 'error', 'runtime'] as const) assert.notEqual(activityTypeLabel(type), type);
});
