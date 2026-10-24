import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { createPolicy } from '../src/core/policy.ts';
import type { JsonValue } from '../src/core/types.ts';
import type { DurableStore, WriteOptions } from '../src/host/types.ts';
import { createPersistentPolicy } from '../src/storage/policy.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

type Policy = ReturnType<typeof createPolicy>;

function temporaryDatabase(): { directory: string; filename: string } {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-policy-'));
  return { directory, filename: join(directory, 'policy.sqlite') };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function instrumentStore(base: DurableStore) {
  const listedNamespaces: string[] = [];
  const store: DurableStore = {
    read(namespace: string, key: string) {
      return base.read(namespace, key);
    },
    write(namespace: string, key: string, value: JsonValue, options?: WriteOptions) {
      return base.write(namespace, key, value, options);
    },
    delete(namespace: string, key: string, expectedRevision?: number) {
      return base.delete(namespace, key, expectedRevision);
    },
    list(namespace: string, options?: { limit?: number; after?: string }) {
      listedNamespaces.push(namespace);
      return base.list(namespace, options);
    },
    purgeExpired(limit?: number) {
      return base.purgeExpired(limit);
    },
    close() {
      base.close();
    }
  };
  return { store, listedNamespaces };
}

function grant(id: string, maxUses = 2, expiresAt: number | null = 500) {
  return {
    id,
    featureId: 'conversation',
    conversationId: 'room:one',
    capabilities: ['messaging.send'],
    maxUses: { 'messaging.send': maxUses },
    expiresAt
  };
}

const request = {
  featureId: 'conversation',
  conversationId: 'room:one',
  capability: 'messaging.send'
};

test('budgets, pause and revocation survive reopen without replenishment', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  let now = 100;
  const firstStore = createSqliteStore({ filename: temporary.filename });
  const first: Policy = createPersistentPolicy({ store: firstStore, clock: () => now });
  first.grant(grant('persistent-grant'));
  const held = first.reserve(request);
  assert(Object.isFrozen(held));
  first.begin(held);
  first.setPaused(true);
  firstStore.close();

  const secondStore = createSqliteStore({ filename: temporary.filename });
  context.after(() => secondStore.close());
  const second = createPersistentPolicy({ store: secondStore, clock: () => now });
  assert.equal(second.describe().paused, true);
  assert.equal(second.describe().grants[0]?.used['messaging.send'], 1);
  assert.throws(() => second.reserve(request), (error: unknown) => hasCode(error, 'POLICY_PAUSED'));
  second.setPaused(false);
  second.begin(second.reserve(request));
  assert.throws(() => second.reserve(request), (error: unknown) => hasCode(error, 'BUDGET_EXHAUSTED'));
  assert.equal(second.revoke('persistent-grant'), true);
  secondStore.close();

  const thirdStore = createSqliteStore({ filename: temporary.filename });
  context.after(() => thirdStore.close());
  const third = createPersistentPolicy({ store: thirdStore, clock: () => now });
  assert.equal(third.describe().grants[0]?.active, false);
  assert.equal(third.describe().grants[0]?.used['messaging.send'], 2);
  assert.throws(() => third.reserve(request), (error: unknown) => hasCode(error, 'POLICY_DENIED'));
  now = 600;
  assert.equal(third.describe().grants[0]?.active, false);
});

test('cross-store stale CAS cannot overuse a one-attempt budget', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const setupStore = createSqliteStore({ filename: temporary.filename });
  createPersistentPolicy({ store: setupStore, clock: () => 100 }).grant(grant('shared-grant', 1));
  setupStore.close();

  const firstStore = createSqliteStore({ filename: temporary.filename });
  const secondStore = createSqliteStore({ filename: temporary.filename });
  context.after(() => firstStore.close());
  context.after(() => secondStore.close());
  const second = createPersistentPolicy({ store: secondStore, clock: () => 100 });
  let injected = true;
  let winningReservation: ReturnType<typeof second.reserve> | null = null;
  const wrappedStore: DurableStore = {
    read(namespace: string, key: string) {
      return firstStore.read(namespace, key);
    },
    write(namespace: string, key: string, value: JsonValue, options?: WriteOptions) {
      if (injected && namespace === 'policy.grants' && typeof options?.expectedRevision === 'number') {
        injected = false;
        winningReservation = second.reserve(request);
      }
      return firstStore.write(namespace, key, value, options);
    },
    delete(namespace: string, key: string, expectedRevision?: number) {
      return firstStore.delete(namespace, key, expectedRevision);
    },
    list(namespace: string, options?: { limit?: number; after?: string }) {
      return firstStore.list(namespace, options);
    },
    purgeExpired(limit?: number) {
      return firstStore.purgeExpired(limit);
    },
    close() {
      firstStore.close();
    }
  };
  const first = createPersistentPolicy({ store: wrappedStore, clock: () => 100 });
  assert.throws(() => first.reserve(request), (error: unknown) => hasCode(error, 'BUDGET_EXHAUSTED'));
  assert(winningReservation);
  second.begin(winningReservation);
  assert.equal(first.describe().grants[0]?.used['messaging.send'], 1);
});

test('begin authenticates reservation identity and rereads pause, revocation and expiry', (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  let now = 100;
  const firstStore = createSqliteStore({ filename: temporary.filename });
  const secondStore = createSqliteStore({ filename: temporary.filename });
  context.after(() => firstStore.close());
  context.after(() => secondStore.close());
  const first = createPersistentPolicy({ store: firstStore, clock: () => now });
  const second = createPersistentPolicy({ store: secondStore, clock: () => now });

  first.grant(grant('paused-grant', 1));
  const paused = first.reserve(request);
  second.setPaused(true);
  assert.throws(() => first.begin(paused), (error: unknown) => hasCode(error, 'POLICY_PAUSED'));
  second.setPaused(false);

  first.grant(grant('revoked-grant', 1));
  const revoked = first.reserve(request);
  second.revoke('revoked-grant');
  assert.throws(() => first.begin(revoked), (error: unknown) => hasCode(error, 'GRANT_REVOKED'));

  first.grant(grant('expiring-grant', 1, 200));
  const expired = first.reserve(request);
  now = 200;
  assert.throws(() => first.begin(expired), (error: unknown) => hasCode(error, 'GRANT_EXPIRED'));
  now = 100;

  first.grant(grant('identity-grant', 1));
  const authentic = first.reserve(request);
  assert.throws(() => first.begin({ ...authentic }),
    (error: unknown) => hasCode(error, 'INVALID_RESERVATION'));
  first.begin(authentic);
  assert.throws(() => first.begin(authentic),
    (error: unknown) => hasCode(error, 'INVALID_RESERVATION'));

  const descriptions = first.describe().grants;
  assert.equal(descriptions.find((entry) => entry.id === 'paused-grant')?.used['messaging.send'], 1);
  assert.equal(descriptions.find((entry) => entry.id === 'revoked-grant')?.used['messaging.send'], 1);
  assert.equal(descriptions.find((entry) => entry.id === 'expiring-grant')?.used['messaging.send'], 1);
  assert.throws(() => first.reserve({ ...request, conversationId: 'room:other' }),
    (error: unknown) => hasCode(error, 'POLICY_DENIED'));
});

test('reserve lists only its persistent scope index despite many unrelated grants', (context) => {
  const base = createSqliteStore({ filename: ':memory:', maxRecords: 5_000 });
  const instrumented = instrumentStore(base);
  context.after(() => instrumented.store.close());
  const first = createPersistentPolicy({ store: instrumented.store, clock: () => 100 });
  for (let index = 0; index < 300; index += 1) {
    first.grant({
      id: `unrelated-${index}`,
      featureId: `feature-${index}`,
      conversationId: `room:${index}`,
      capabilities: ['messaging.send'],
      maxUses: { 'messaging.send': 1 },
      expiresAt: 500
    });
  }
  first.grant(grant('indexed-target', 1));
  instrumented.listedNamespaces.length = 0;
  const second = createPersistentPolicy({ store: instrumented.store, clock: () => 100 });
  assert.equal(instrumented.listedNamespaces.length, 0);
  const reservation = second.reserve(request);
  assert.equal(instrumented.listedNamespaces.includes('policy.grants'), false);
  assert.equal(instrumented.listedNamespaces.length, 1);
  assert.match(instrumented.listedNamespaces[0], /^policy\.grant-index\.[a-f0-9]{64}$/);
  second.begin(reservation);
});

test('construction migrates legacy grants once and later instances trust the version marker', (context) => {
  const base = createSqliteStore({ filename: ':memory:' });
  const instrumented = instrumentStore(base);
  context.after(() => instrumented.store.close());
  instrumented.store.write('policy.grants', 'legacy', {
    schema: 1,
    id: 'legacy',
    featureId: 'conversation',
    conversationId: 'room:one',
    capabilities: ['messaging.send'],
    maxUses: { 'messaging.send': 1 },
    expiresAt: 500,
    active: true,
    used: { 'messaging.send': 0 },
    order: 1
  }, { expectedRevision: null });
  const migrated = createPersistentPolicy({ store: instrumented.store, clock: () => 100 });
  assert(instrumented.listedNamespaces.includes('policy.grants'));
  migrated.begin(migrated.reserve(request));
  instrumented.listedNamespaces.length = 0;
  createPersistentPolicy({ store: instrumented.store, clock: () => 100 });
  assert.equal(instrumented.listedNamespaces.length, 0);
});

test('index-first grant failure leaves a denied orphan that a later grant can recover', (context) => {
  const base = createSqliteStore({ filename: ':memory:' });
  let rejectBody = true;
  const store: DurableStore = {
    read: (namespace, key) => base.read(namespace, key),
    write(namespace, key, value, options) {
      if (rejectBody && namespace === 'policy.grants' && key === 'recoverable') throw new Error('injected failure');
      return base.write(namespace, key, value, options);
    },
    delete: (namespace, key, expectedRevision) => base.delete(namespace, key, expectedRevision),
    list: (namespace, options) => base.list(namespace, options),
    purgeExpired: (limit) => base.purgeExpired(limit),
    close: () => base.close()
  };
  context.after(() => store.close());
  const policy = createPersistentPolicy({ store, clock: () => 100 });
  assert.throws(() => policy.grant(grant('recoverable', 1)), /injected failure/);
  assert.throws(() => policy.reserve(request), (error: unknown) => hasCode(error, 'POLICY_DENIED'));
  rejectBody = false;
  policy.grant(grant('recoverable', 1));
  policy.begin(policy.reserve(request));
});
