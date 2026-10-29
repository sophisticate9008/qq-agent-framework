import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

import type { createPolicy } from '../src/core/policy.ts';
import type { JsonObject, JsonValue } from '../src/core/types.ts';
import type { DurableStore, WriteOptions } from '../src/host/types.ts';
import { createPersistentPolicy } from '../src/storage/policy.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

type Policy = ReturnType<typeof createPolicy>;

function temporaryDatabase(): { directory: string; filename: string } {
  const directory = mkdtempSync(join(tmpdir(), 'qq-bridge-framework-policy-'));
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

function grant(id: string, maxUses: number | null = 2, expiresAt: number | null = 500) {
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

function changeStoredGrant(store: DurableStore, id: string, changes: JsonObject) {
  const record = store.read('policy.grants', id);
  assert(record && record.value && typeof record.value === 'object' && !Array.isArray(record.value));
  return store.write('policy.grants', id, { ...record.value, ...changes }, { expectedRevision: record.revision });
}

test('unmetered and finite limits coexist and survive actual SQLite reopen without replenishment', context => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  context.after(() => store.close());
  const first = createPersistentPolicy({ store, clock: () => 100 });
  first.grant({ ...grant('mixed', null), capabilities: ['messaging.send', 'model.respond', 'agent.tools.delegate'],
    maxUses: { 'messaging.send': null, 'model.respond': 1, 'agent.tools.delegate': 0 } });
  for (let attempt = 0; attempt < 32; attempt++) first.begin(first.reserve(request));
  first.begin(first.reserve({ ...request, capability: 'model.respond' }));
  const before = first.describe();
  store.close();
  const reopened = createSqliteStore({ filename: temporary.filename });
  context.after(() => reopened.close());
  const second: Policy = createPersistentPolicy({ store: reopened, clock: () => 100 });
  assert.deepEqual(second.describe(), before);
  assert.throws(() => second.reserve({ ...request, capability: 'model.respond' }), { code: 'BUDGET_EXHAUSTED' });
  assert.throws(() => second.reserve({ ...request, capability: 'agent.tools.delegate' }), { code: 'BUDGET_EXHAUSTED' });
  second.begin(second.reserve(request));
  assert.equal(second.describe().grants[0].maxUses['messaging.send'], null);
  assert.equal(second.describe().grants[0].used['messaging.send'], 33);
});

test('unmetered audit saturation never becomes a quota and still requires durable CAS writes', context => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  context.after(() => store.close());
  const policy = createPersistentPolicy({ store, clock: () => 100 });
  policy.grant(grant('saturated', null));
  const seeded = changeStoredGrant(store, 'saturated', { used: { 'messaging.send': Number.MAX_SAFE_INTEGER - 1 } });
  for (let attempt = 0; attempt < 3; attempt++) policy.begin(policy.reserve(request));
  assert.equal(policy.describe().grants[0].used['messaging.send'], Number.MAX_SAFE_INTEGER);
  assert.equal(policy.describe().grants[0].maxUses['messaging.send'], null);
  assert(store.read('policy.grants', 'saturated')!.revision > seeded.revision);
  store.close();
  const reopened = createSqliteStore({ filename: temporary.filename });
  context.after(() => reopened.close());
  const next = createPersistentPolicy({ store: reopened, clock: () => 100 });
  next.begin(next.reserve(request));
  assert.equal(next.describe().grants[0].used['messaging.send'], Number.MAX_SAFE_INTEGER);
});

test('unmetered stale cross-store CAS preserves both audit attempts without lost increments', context => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const base = createSqliteStore({ filename: temporary.filename });
  const peerStore = createSqliteStore({ filename: temporary.filename });
  context.after(() => base.close());
  context.after(() => peerStore.close());
  const peer = createPersistentPolicy({ store: peerStore, clock: () => 100 });
  peer.grant(grant('concurrent', null));
  let injected = false;
  let peerReservation: ReturnType<typeof peer.reserve> | undefined;
  const store: DurableStore = { ...base, write(namespace, key, value, options) {
    if (!injected && namespace === 'policy.grants') {
      injected = true;
      peerReservation = peer.reserve(request);
    }
    return base.write(namespace, key, value, options);
  } };
  const first = createPersistentPolicy({ store, clock: () => 100 });
  const held = first.reserve(request);
  assert(peerReservation);
  peer.begin(peerReservation);
  first.begin(held);
  assert.equal(first.describe().grants[0].used['messaging.send'], 2);
});

test('unmetered begin rechecks cross-instance pause, revocation, expiry and exact stored scope', context => {
  for (const change of ['pause', 'revoke', 'expire', 'feature', 'conversation', 'capability'] as const) {
    const store = createSqliteStore({ filename: ':memory:' });
    context.after(() => store.close());
    let now = 100;
    const first = createPersistentPolicy({ store, clock: () => now });
    const peer = createPersistentPolicy({ store, clock: () => now });
    first.grant(grant('unmetered', null));
    const held = first.reserve(request);
    assert.throws(() => first.begin({ ...held }), { code: 'INVALID_RESERVATION' });
    assert.throws(() => peer.begin(held), { code: 'INVALID_RESERVATION' });
    if (change === 'pause') peer.setPaused(true);
    if (change === 'revoke') peer.revoke('unmetered');
    if (change === 'expire') now = 500;
    if (change === 'feature') changeStoredGrant(store, 'unmetered', { featureId: 'other' });
    if (change === 'conversation') changeStoredGrant(store, 'unmetered', { conversationId: 'room:other' });
    if (change === 'capability') changeStoredGrant(store, 'unmetered', {
      capabilities: ['model.respond'], maxUses: { 'model.respond': null }, used: { 'model.respond': 1 },
    });
    assert.throws(() => first.begin(held), { code: change === 'pause' ? 'POLICY_PAUSED' : change === 'revoke' ? 'GRANT_REVOKED'
      : change === 'expire' ? 'GRANT_EXPIRED' : 'POLICY_DENIED' });
    assert.throws(() => first.begin(held), { code: 'INVALID_RESERVATION' });
  }
});

test('unmetered reserve and begin fail closed on real SQLite write failure or unavailable reads', context => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const base = createSqliteStore({ filename: temporary.filename });
  context.after(() => base.close());
  let failReads = false;
  const store: DurableStore = { ...base, read(namespace, key) {
    if (failReads) throw new Error('synthetic-read-unavailable');
    return base.read(namespace, key);
  } };
  const policy = createPersistentPolicy({ store, clock: () => 100 });
  policy.grant(grant('io-guard', null));
  const database = new DatabaseSync(temporary.filename);
  context.after(() => database.close());
  const before = store.read('policy.grants', 'io-guard');
  const revision = database.prepare("SELECT value FROM durable_meta WHERE name='revision'").get();
  database.exec("CREATE TRIGGER deny_policy_audit BEFORE UPDATE ON durable_records WHEN NEW.namespace='policy.grants' BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
  assert.throws(() => policy.reserve(request), { code: 'STORE_IO_ERROR' });
  assert.deepEqual(store.read('policy.grants', 'io-guard'), before);
  assert.deepEqual(database.prepare("SELECT value FROM durable_meta WHERE name='revision'").get(), revision);
  database.exec('DROP TRIGGER deny_policy_audit');
  const held = policy.reserve(request);
  failReads = true;
  assert.throws(() => policy.begin(held), /synthetic-read-unavailable/);
  assert.throws(() => policy.reserve(request), /synthetic-read-unavailable/);
  failReads = false;
  assert.throws(() => policy.begin(held), { code: 'INVALID_RESERVATION' });
  policy.begin(policy.reserve(request));
});

test('legacy numeric grant bytes and hashes remain unchanged until the original counted attempt is consumed', context => {
  const store = createSqliteStore({ filename: ':memory:' });
  context.after(() => store.close());
  const legacy = { schema: 1, id: 'legacy-byte-proof', featureId: request.featureId, conversationId: request.conversationId,
    capabilities: [request.capability], maxUses: { 'messaging.send': 1 }, expiresAt: 500,
    active: true, used: { 'messaging.send': 0 }, order: 1 };
  store.write('policy.grants', legacy.id, legacy, { expectedRevision: null });
  const serialized = JSON.stringify(legacy);
  const hash = createHash('sha256').update(serialized).digest('hex');
  const policy = createPersistentPolicy({ store, clock: () => 100 });
  assert.equal(JSON.stringify(store.read('policy.grants', legacy.id)!.value), serialized);
  assert.equal(createHash('sha256').update(JSON.stringify(store.read('policy.grants', legacy.id)!.value)).digest('hex'), hash);
  policy.begin(policy.reserve(request));
  assert.equal(JSON.stringify(store.read('policy.grants', legacy.id)!.value), JSON.stringify({ ...legacy, used: { 'messaging.send': 1 } }));
  const restarted = createPersistentPolicy({ store, clock: () => 100 });
  assert.throws(() => restarted.reserve(request), { code: 'BUDGET_EXHAUSTED' });
});

test('unmetered parsing rejects invalid limits or audit values rather than guessing defaults', context => {
  for (const maximum of ['null', false, -1, 1.5]) {
    const store = createSqliteStore({ filename: ':memory:' });
    context.after(() => store.close());
    const policy = createPersistentPolicy({ store, clock: () => 100 });
    assert.throws(() => policy.grant({ ...grant('invalid'), maxUses: { 'messaging.send': maximum } }));
  }
  for (const consumed of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const store = createSqliteStore({ filename: ':memory:' });
    context.after(() => store.close());
    const policy = createPersistentPolicy({ store, clock: () => 100 });
    policy.grant(grant('invalid-audit', null));
    changeStoredGrant(store, 'invalid-audit', { used: { 'messaging.send': consumed } });
    assert.throws(() => policy.reserve(request), { code: 'INVALID_STORED_DATA' });
  }
});

test('persistent grant rejects inherited null or numeric limits under explicit same-process prototype modification', context => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'agent.submit');
  try {
    for (const inherited of [null, 1]) {
      const store = createSqliteStore({ filename: ':memory:' });
      context.after(() => store.close());
      const policy = createPersistentPolicy({ store, clock: () => 100 });
      const malformed = { ...grant('missing-own-limit'), capabilities: ['agent.submit'], maxUses: { unrelated: null } };
      assert.throws(() => policy.grant(malformed), { code: 'INVALID_GRANT' });
      Object.defineProperty(Object.prototype, 'agent.submit', { value: inherited, configurable: true, writable: true });
      assert.throws(() => policy.grant(malformed), { code: 'INVALID_GRANT' });
      assert.equal(store.read('policy.grants', malformed.id), null);
      assert.throws(() => policy.reserve({ ...request, capability: 'agent.submit' }), { code: 'POLICY_DENIED' });
      policy.grant({ ...malformed, id: 'own-limit', maxUses: { 'agent.submit': null } });
      policy.begin(policy.reserve({ ...request, capability: 'agent.submit' }));
      const stored = store.read('policy.grants', 'own-limit')!;
      assert(stored.value && typeof stored.value === 'object' && !Array.isArray(stored.value));
      assert(Object.hasOwn(stored.value.maxUses as JsonObject, 'agent.submit'));
      Reflect.deleteProperty(Object.prototype, 'agent.submit');
    }
  } finally {
    if (descriptor) Object.defineProperty(Object.prototype, 'agent.submit', descriptor);
    else Reflect.deleteProperty(Object.prototype, 'agent.submit');
  }
});

test('persistent parsing rejects missing own maxUses or used keys despite inherited values', context => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'agent.submit');
  try {
    for (const field of ['maxUses', 'used'] as const) {
      const store = createSqliteStore({ filename: ':memory:' });
      context.after(() => store.close());
      const policy = createPersistentPolicy({ store, clock: () => 100 });
      const authorization = { ...request, capability: 'agent.submit' };
      policy.grant({ ...grant('stored-own-keys'), capabilities: ['agent.submit'], maxUses: { 'agent.submit': null } });
      const held = policy.reserve(authorization);
      changeStoredGrant(store, 'stored-own-keys', { [field]: { unrelated: field === 'maxUses' ? null : 0 } });
      assert.throws(() => policy.describe(), { code: 'INVALID_STORED_DATA' });
      Object.defineProperty(Object.prototype, 'agent.submit', {
        value: field === 'maxUses' ? null : 0, configurable: true, writable: true,
      });
      assert.throws(() => policy.describe(), { code: 'INVALID_STORED_DATA' });
      assert.throws(() => policy.reserve(authorization), { code: 'INVALID_STORED_DATA' });
      assert.throws(() => policy.begin(held), { code: 'INVALID_STORED_DATA' });
      assert.throws(() => policy.begin(held), { code: 'INVALID_RESERVATION' });
      Reflect.deleteProperty(Object.prototype, 'agent.submit');
    }
  } finally {
    if (descriptor) Object.defineProperty(Object.prototype, 'agent.submit', descriptor);
    else Reflect.deleteProperty(Object.prototype, 'agent.submit');
  }
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
