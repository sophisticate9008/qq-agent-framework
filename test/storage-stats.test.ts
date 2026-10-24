import test from 'node:test';
import assert from 'node:assert/strict';

import { createSqliteStore } from '../src/storage/sqlite.ts';

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

test('stats report physical capacity without exposing records or cleaning conservative history', context => {
  let now = 10;
  const store = createSqliteStore({ filename: ':memory:', clock: () => now, maxRecords: 3 });
  context.after(() => store.close());
  store.write('ttl', 'expired-private-key', { secret: 'expired-private-value' }, {
    expectedRevision: null,
    expiresAt: 20,
  });
  now = 30;
  store.write('outbox', 'unknown-private-key', { status: 'unknown', body: 'unknown-private-message' }, {
    expectedRevision: null,
  });
  now = 40;
  store.write('host.inbox', 'dedupe-private-key', { status: 'accepted', fingerprint: 'private-fingerprint' }, {
    expectedRevision: null,
  });

  assert.equal(store.read('ttl', 'expired-private-key'), null);
  assert.deepEqual(store.list('ttl'), []);
  const result = store.stats({ limit: 10 });
  assert.deepEqual(result, {
    maxRecords: 3,
    totalRecords: 3,
    expiredRecords: 1,
    remainingRecords: 0,
    namespaces: [
      { namespace: 'host.inbox', totalRecords: 1, expiredRecords: 0, oldestUpdatedAt: 40 },
      { namespace: 'outbox', totalRecords: 1, expiredRecords: 0, oldestUpdatedAt: 30 },
      { namespace: 'ttl', totalRecords: 1, expiredRecords: 1, oldestUpdatedAt: 10 },
    ],
    next: null,
  });
  assert.throws(() => store.write('other', 'capacity-private-key', null, { expectedRevision: null }),
    (error: unknown) => hasCode(error, 'STORE_CAPACITY_EXCEEDED'));
  assert.equal(store.read('outbox', 'unknown-private-key') !== null, true);
  assert.equal(store.read('host.inbox', 'dedupe-private-key') !== null, true);
  assert.equal(store.stats().totalRecords, 3);

  const serialized = JSON.stringify(result);
  for (const sensitive of ['expired-private-key', 'expired-private-value', 'unknown-private-key',
    'unknown-private-message', 'dedupe-private-key', 'private-fingerprint', 'body', 'fingerprint', 'status']) {
    assert.doesNotMatch(serialized, new RegExp(sensitive));
  }

  store.close();
  assert.throws(() => store.stats(), (error: unknown) => hasCode(error, 'STORE_CLOSED'));
});

test('stats bound and page namespace summaries', context => {
  let now = 100;
  const store = createSqliteStore({ filename: ':memory:', clock: () => now, maxRecords: 10 });
  context.after(() => store.close());
  for (const namespace of ['alpha', 'beta', 'gamma', 'omega']) {
    store.write(namespace, `private-key-${namespace}`, { secret: `private-value-${namespace}` }, { expectedRevision: null });
    now++;
  }

  const first = store.stats({ limit: 2 });
  assert.deepEqual(first.namespaces.map(item => item.namespace), ['alpha', 'beta']);
  assert.equal(first.next, 'beta');
  assert.equal(first.totalRecords, 4);
  assert.equal(first.remainingRecords, 6);
  const second = store.stats({ limit: 2, after: first.next });
  assert.deepEqual(second.namespaces.map(item => item.namespace), ['gamma', 'omega']);
  assert.equal(second.next, null);
  assert.equal(JSON.stringify([first, second]).includes('private-key'), false);
  assert.equal(JSON.stringify([first, second]).includes('private-value'), false);
  assert.throws(() => store.stats({ limit: 1_001 }),
    (error: unknown) => hasCode(error, 'STORE_INVALID_ARGUMENT'));
});
