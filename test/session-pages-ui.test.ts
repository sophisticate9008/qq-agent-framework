import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSessionSnapshot } from '../web/lib/activity.ts';
import { mergeSessionPages, sessionPagePath } from '../web/lib/session-pages.ts';

test('session parser preserves cursor and explicit reset capability with bounded pages above 256 rows', () => {
  const sessions = Array.from({ length: 500 }, (_, index) => ({ key: `group:${100_000 + index}`, sessionId: `synthetic-${index}`, owner: false }));
  const page = parseSessionSnapshot({ revision: 'page-one', sessions, next: 'group:100499', resetAvailable: false });
  assert(page);
  assert.equal(page.sessions.length, 500);
  assert.equal(page.next, 'group:100499');
  assert.equal(page.resetAvailable, false);
  assert.equal(parseSessionSnapshot({ ...page, next: 123 }), null);
  assert.equal(parseSessionSnapshot({ ...page, next: 'group:123\n' }), null);
  assert.equal(parseSessionSnapshot({ ...page, resetAvailable: 'true' }), null);
  assert.equal(parseSessionSnapshot({ ...page, sessions: Array.from({ length: 1001 }, (_, index) => ({ key: `group:${index + 1}`, sessionId: String(index), owner: false })) }), null);
});

test('session page merge deduplicates without losing per-binding page revisions or inferring write capability', () => {
  const first = { revision: 'page-one', sessions: [{ key: 'group:1', sessionId: 'first', owner: false }], next: 'group:1', resetAvailable: true };
  const mergedFirst = mergeSessionPages(null, first).snapshot;
  const second = mergeSessionPages(mergedFirst, { revision: 'page-two', sessions: [{ key: 'group:1', sessionId: 'changed', owner: true }, { key: 'group:2', sessionId: 'second', owner: false }], next: null, resetAvailable: true });
  assert.equal(second.snapshot.sessions.length, 2);
  assert.equal(second.changed, 1);
  assert.equal(second.snapshot.sessions[0].bindingRevision, 'page-two');
  assert.equal(second.snapshot.sessions[1].bindingRevision, 'page-two');
  assert.equal(second.snapshot.next, null);
  assert.equal(second.snapshot.resetAvailable, true);
  assert.equal(mergeSessionPages(null, { revision: 'legacy', sessions: [] }).snapshot.resetAvailable, false);
  assert.equal(mergeSessionPages(second.snapshot, { revision: 'page-three', sessions: [], resetAvailable: false }).snapshot.resetAvailable, false);
});

test('only an encoded cursor is appended to the same-origin bounded session page endpoint', () => {
  assert.equal(sessionPagePath(), '/api/chat/sessions?limit=100');
  assert.equal(sessionPagePath('group:123'), '/api/chat/sessions?limit=100&after=group%3A123');
  assert.ok(sessionPagePath('a&limit=50000').includes('after=a%26limit%3D50000'));
});
