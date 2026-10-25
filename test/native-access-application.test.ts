import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { FrameworkError } from '../src/core/values.ts';
import { digest } from '../src/host/data.ts';
import { applyNativeAccessGrants, rememberNativeAccessGrants, restoredNativeAccessGrants } from '../src/host/native-access-application.ts';
import { nativeChatGrantId, nativeWhitelistCapabilities } from '../src/host/native-access.ts';
import { DEFAULT_NATIVE_CHAT_AUTHORIZATION, DEFAULT_NATIVE_CHAT_DEPLOYMENT } from '../src/host/native-chat-configuration.ts';
import type { NativeChatAccess, NativeChatConfiguration } from '../src/host/native-chat-configuration.ts';
import type { NativeBootstrapHost } from '../src/host/native-bootstrap.ts';
import { DEFAULT_NATIVE_EXECUTION_POLICY } from '../src/host/native-execution.ts';
import type { DurableStore } from '../src/host/types.ts';
import { createPersistentPolicy } from '../src/storage/policy.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

const identity = digest('native-access-application-offline-fixture');
const mapNamespace = 'native-chat.access-grants';

function configuration(): NativeChatConfiguration {
  const access: NativeChatAccess = { owner: '901', allow: ['group:101', 'private:201'], deny: [] };
  return {
    revisions: { access: digest(access), authorization: digest(DEFAULT_NATIVE_CHAT_AUTHORIZATION), execution: digest(DEFAULT_NATIVE_EXECUTION_POLICY),
      plans: digest('plans'), personas: digest('personas'), adapters: digest('adapters'), providers: digest('providers'), deployment: digest('deployment') },
    access, authorization: DEFAULT_NATIVE_CHAT_AUTHORIZATION, execution: DEFAULT_NATIVE_EXECUTION_POLICY,
    catalog: { activePlanId: null, plans: [] }, personas: [], providers: [], deployment: DEFAULT_NATIVE_CHAT_DEPLOYMENT,
    adapters: {
      onebotHttp: { enabled: false, endpoint: 'http://127.0.0.1:1/', secret: '' },
      onebotWs: { enabled: false, endpoint: 'ws://127.0.0.1:1/', secret: '' },
      dshAgent: { enabled: false, endpoint: 'http://127.0.0.1:1/', auth: '' },
      onebotWebhook: { enabled: false, host: '127.0.0.1', port: 1, selfId: '999', hmac: '' }
    }
  };
}

function withAccess(previous: NativeChatConfiguration, allow: readonly string[]): NativeChatConfiguration {
  const access = { ...previous.access, allow };
  return { ...previous, access, revisions: { ...previous.revisions, access: digest(access) } };
}

function grantBytes(filename: string, id: string): Buffer {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const row = database.prepare('SELECT value FROM durable_records WHERE namespace = ? AND key = ?').get('policy.grants', id);
    assert(row && typeof row.value === 'string');
    return Buffer.from(row.value, 'utf8');
  } finally { database.close(); }
}

function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'native-access-application-'));
  const filename = join(directory, 'policy.sqlite');
  let store = createSqliteStore({ filename });
  let policy = createPersistentPolicy({ store });
  const previous = configuration();
  const mapping: Record<string, string> = {};
  const capabilities = nativeWhitelistCapabilities(previous);
  for (const scope of previous.access.allow) {
    const id = nativeChatGrantId(previous, identity, scope, 1);
    mapping[scope] = id;
    policy.grant({ id, featureId: 'agent-relay', conversationId: scope,
      capabilities: [...capabilities], maxUses: Object.fromEntries(capabilities.map(capability => [capability, null])), expiresAt: null });
  }
  policy.grant({ id: 'unrelated-private-feature', featureId: 'private-feature', conversationId: 'group:101',
    capabilities: ['messaging.send'], maxUses: { 'messaging.send': 3 }, expiresAt: null });
  rememberNativeAccessGrants(store, previous, identity, mapping);
  context.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    filename, previous, mapping,
    get store() { return store; },
    get policy() { return policy; },
    get host() { return { policy } as NativeBootstrapHost; },
    consume(scope: string, capability: string = 'agent.submit') {
      policy.begin(policy.reserve({ featureId: 'agent-relay', conversationId: scope, capability }));
    },
    capture() {
      return store.list('policy.grants').map(record => ({ record, bytes: grantBytes(filename, record.key) }));
    },
    reopen() {
      store.close();
      store = createSqliteStore({ filename });
      policy = createPersistentPolicy({ store });
    }
  };
}

test('hot add preserves every existing grant byte, revision and used counter while authorizing only the new scope', context => {
  const setup = fixture(context);
  setup.consume('group:101');
  setup.consume('group:101');
  setup.consume('private:201', 'messaging.send');
  const before = setup.capture();
  const next = withAccess(setup.previous, [...setup.previous.access.allow, 'private:202']);
  applyNativeAccessGrants({ store: setup.store, host: setup.host, previous: setup.previous, next, identity });
  const restored = restoredNativeAccessGrants(setup.store, next, identity);
  assert(restored);
  for (const old of before) {
    assert.deepEqual(setup.store.read('policy.grants', old.record.key), old.record);
    assert.deepEqual(grantBytes(setup.filename, old.record.key), old.bytes);
  }
  for (const scope of setup.previous.access.allow) assert.equal(restored[scope], setup.mapping[scope]);
  assert.equal(setup.store.list('policy.grants').length, before.length + 1);
  const added = setup.policy.describe().grants.find(grant => grant.id === restored['private:202']);
  assert(added);
  assert.equal(added.conversationId, 'private:202');
  assert.equal(added.featureId, 'agent-relay');
  assert.deepEqual(added.capabilities, nativeWhitelistCapabilities(next));
  assert.deepEqual(added.used, { 'agent.submit': 0, 'messaging.send': 0, 'agent.cancel': 0 });
  assert.deepEqual(added.maxUses, { 'agent.submit': null, 'messaging.send': null, 'agent.cancel': null });
  setup.consume('private:202');
});

test('removal immediately revokes the old ID and any held reservation without rewriting unchanged grants', context => {
  const setup = fixture(context);
  const held = setup.policy.reserve({ featureId: 'agent-relay', conversationId: 'group:101', capability: 'agent.submit' });
  const unchanged = setup.store.read('policy.grants', setup.mapping['private:201']);
  const next = withAccess(setup.previous, ['private:201']);
  applyNativeAccessGrants({ store: setup.store, host: setup.host, previous: setup.previous, next, identity });
  assert.equal(setup.policy.describe().grants.find(grant => grant.id === setup.mapping['group:101'])?.active, false);
  assert.throws(() => setup.policy.begin(held), { code: 'GRANT_REVOKED' });
  assert.throws(() => setup.consume('group:101'), { code: 'POLICY_DENIED' });
  assert.deepEqual(setup.store.read('policy.grants', setup.mapping['private:201']), unchanged);
  assert.deepEqual(restoredNativeAccessGrants(setup.store, next, identity), { 'private:201': setup.mapping['private:201'] });
});

test('manual revocation of an unchanged scope is never revived by another scope change or a no-op remember', context => {
  const setup = fixture(context);
  setup.consume('group:101');
  setup.policy.revoke(setup.mapping['group:101']);
  const revoked = setup.store.read('policy.grants', setup.mapping['group:101']);
  const bytes = grantBytes(setup.filename, setup.mapping['group:101']);
  const next = withAccess(setup.previous, [...setup.previous.access.allow, 'group:102']);
  applyNativeAccessGrants({ store: setup.store, host: setup.host, previous: setup.previous, next, identity });
  const restored = restoredNativeAccessGrants(setup.store, next, identity);
  assert(restored);
  assert.equal(restored['group:101'], setup.mapping['group:101']);
  rememberNativeAccessGrants(setup.store, next, identity, restored);
  assert.deepEqual(setup.store.read('policy.grants', setup.mapping['group:101']), revoked);
  assert.deepEqual(grantBytes(setup.filename, setup.mapping['group:101']), bytes);
  assert.throws(() => setup.consume('group:101'), { code: 'POLICY_DENIED' });
});

test('SQLite reopen restores the exact durable mapping and used/revoked grants, not regenerated IDs', context => {
  const setup = fixture(context);
  const next = withAccess(setup.previous, [...setup.previous.access.allow, 'private:202']);
  applyNativeAccessGrants({ store: setup.store, host: setup.host, previous: setup.previous, next, identity });
  setup.consume('private:202');
  setup.consume('group:101', 'messaging.send');
  setup.policy.revoke(setup.mapping['private:201']);
  const mapping = restoredNativeAccessGrants(setup.store, next, identity);
  assert(mapping);
  const records = setup.capture();
  const mapRecord = setup.store.read(mapNamespace, 'current');
  setup.reopen();
  const restored = restoredNativeAccessGrants(setup.store, next, identity);
  assert.deepEqual(restored, mapping);
  assert(restored);
  rememberNativeAccessGrants(setup.store, next, identity, restored);
  assert.deepEqual(setup.store.read(mapNamespace, 'current'), mapRecord);
  assert.deepEqual(setup.capture(), records);
  assert.throws(() => setup.consume('private:201'), { code: 'POLICY_DENIED' });
  assert.equal(setup.policy.describe().grants.find(grant => grant.id === mapping['private:202'])?.used['agent.submit'], 1);
});

test('owner, authorization or execution changes reject without mutating policy or the durable map', context => {
  const setup = fixture(context);
  const base = withAccess(setup.previous, [...setup.previous.access.allow, 'group:102']);
  const authorization = { ...base.authorization, version: 'explicit-new-version' };
  const execution = { ...base.execution, cancelOnTimeout: false };
  const access = { ...base.access, owner: '902' };
  const changes: NativeChatConfiguration[] = [
    { ...base, access, revisions: { ...base.revisions, access: digest(access) } },
    { ...base, authorization, revisions: { ...base.revisions, authorization: digest(authorization) } },
    { ...base, authorization: { version: 'counted', mode: 'counted', grants: [] } },
    { ...base, execution, revisions: { ...base.revisions, execution: digest(execution) } }
  ];
  const before = setup.capture();
  const map = setup.store.read(mapNamespace, 'current');
  for (const next of changes) {
    assert.throws(() => applyNativeAccessGrants({ store: setup.store, host: setup.host, previous: setup.previous, next, identity }),
      { code: 'NATIVE_CHAT_ACCESS_RELOAD_REQUIRED' });
    assert.deepEqual(setup.capture(), before);
    assert.deepEqual(setup.store.read(mapNamespace, 'current'), map);
  }
  assert.equal(restoredNativeAccessGrants(setup.store, changes[1], identity), null);
  assert.equal(restoredNativeAccessGrants(setup.store, changes[3], identity), null);
  assert.throws(() => applyNativeAccessGrants({ store: setup.store, host: setup.host, previous: setup.previous, next: base, identity: digest('other-owner-identity') }),
    { code: 'NATIVE_CHAT_ACCESS_POLICY_INVALID' });
  assert.deepEqual(setup.capture(), before);
});

test('remove then re-add the same saved access revision creates a new grant and never resurrects or reuses the revoked ID', context => {
  const setup = fixture(context);
  const added = withAccess(setup.previous, [...setup.previous.access.allow, 'private:202']);
  applyNativeAccessGrants({ store: setup.store, host: setup.host, previous: setup.previous, next: added, identity });
  const first = restoredNativeAccessGrants(setup.store, added, identity);
  assert(first);
  const firstId = first['private:202'];
  setup.consume('private:202');
  const removed = withAccess(added, setup.previous.access.allow);
  applyNativeAccessGrants({ store: setup.store, host: setup.host, previous: added, next: removed, identity });
  const revoked = setup.store.read('policy.grants', firstId);
  const bytes = grantBytes(setup.filename, firstId);
  assert.throws(() => setup.consume('private:202'), { code: 'POLICY_DENIED' });
  const readded = withAccess(removed, added.access.allow);
  assert.equal(readded.revisions.access, added.revisions.access);
  applyNativeAccessGrants({ store: setup.store, host: setup.host, previous: removed, next: readded, identity });
  const second = restoredNativeAccessGrants(setup.store, readded, identity);
  assert(second);
  assert.notEqual(second['private:202'], firstId);
  assert.deepEqual(setup.store.read('policy.grants', firstId), revoked);
  assert.deepEqual(grantBytes(setup.filename, firstId), bytes);
  setup.consume('private:202');
  assert.equal(setup.policy.describe().grants.find(grant => grant.id === firstId)?.active, false);
  assert.equal(setup.policy.describe().grants.find(grant => grant.id === second['private:202'])?.used['agent.submit'], 1);
});

test('a failed durable map write leaves no false restoration; retry after SQLite reopen reuses the pending grant without resetting it', context => {
  const setup = fixture(context);
  const next = withAccess(setup.previous, [...setup.previous.access.allow, 'private:202']);
  const originalMap = setup.store.read(mapNamespace, 'current');
  const oldGrant = setup.store.read('policy.grants', setup.mapping['group:101']);
  let fail = true;
  const store: DurableStore = {
    read: (namespace, key) => setup.store.read(namespace, key),
    write(namespace, key, value, options) {
      if (namespace === mapNamespace && fail) { fail = false; throw new FrameworkError('STORE_IO_ERROR', 'Synthetic map write failure'); }
      return setup.store.write(namespace, key, value, options);
    },
    list: (namespace, options) => setup.store.list(namespace, options),
    delete: (namespace, key, revision) => setup.store.delete(namespace, key, revision),
    purgeExpired: limit => setup.store.purgeExpired(limit), close() {}
  };
  assert.throws(() => applyNativeAccessGrants({ store, host: setup.host, previous: setup.previous, next, identity }), { code: 'STORE_IO_ERROR' });
  assert.throws(() => restoredNativeAccessGrants(setup.store, next, identity), { code: 'NATIVE_CHAT_ACCESS_RELOAD_REQUIRED' });
  assert.deepEqual(setup.store.read(mapNamespace, 'current'), originalMap);
  setup.consume('private:202');
  const pending = setup.policy.describe().grants.find(grant => grant.conversationId === 'private:202');
  assert(pending);
  const record = setup.store.read('policy.grants', pending.id);
  const grantCount = setup.store.list('policy.grants').length;
  setup.reopen();
  const restored = restoredNativeAccessGrants(setup.store, next, identity, setup.host);
  assert.equal(setup.store.list('policy.grants').length, grantCount);
  assert.deepEqual(setup.store.read('policy.grants', pending.id), record);
  assert.deepEqual(setup.store.read('policy.grants', setup.mapping['group:101']), oldGrant);
  assert.equal(restored?.['private:202'], pending.id);
});
