import assert from 'node:assert/strict';
import test from 'node:test';
import { reminderConfiguration, reminderDraft, reminderWallTime } from '../web/lib/reminder-ui.ts';

test('reminder times use the selected IANA zone and reject skipped or ambiguous DST times', () => {
  assert.equal(reminderWallTime('2026-07-08T09:30', 'America/New_York'), Date.UTC(2026, 6, 8, 13, 30));
  assert.equal(reminderWallTime('2026-07-08T09:30', 'Asia/Shanghai'), Date.UTC(2026, 6, 8, 1, 30));
  assert.throws(() => reminderWallTime('2026-03-08T02:30', 'America/New_York'), /不存在/);
  assert.throws(() => reminderWallTime('2026-11-01T01:30', 'America/New_York'), /重复/);
  assert.throws(() => reminderWallTime('2026-02-30T09:30', 'UTC'), /不存在/);
});

test('reminder drafts preserve schedule and disabled defaults without creating or enabling a rule', () => {
  const base = { conversationId: 'group:123', text: '定时提醒', timeZone: 'Asia/Shanghai', enabled: false };
  for (const schedule of [{ kind: 'delay' as const, delayMs: 1_001 }, { kind: 'once' as const, at: Date.UTC(2026, 10, 2, 1, 30, 23, 555) },
    { kind: 'daily' as const, hour: 9, minute: 30 }, { kind: 'weekly' as const, dayOfWeek: 7 as const, hour: 22, minute: 10 }]) {
    const configuration = { ...base, schedule };
    assert.deepEqual(reminderConfiguration(reminderDraft(configuration)), configuration);
  }
  assert.equal(reminderDraft().enabled, false);
  assert.throws(() => reminderConfiguration({ ...reminderDraft(), conversationId: 'group:123', text: '提醒', delayMinutes: '0' }));
});
