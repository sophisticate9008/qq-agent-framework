import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRegistry } from '../src/host/sessions.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import type { AgentAdapter, DurableStore } from '../src/host/types.ts';
import { FrameworkError } from '../src/core/values.ts';

const agent: AgentAdapter = {
  async createSession() { throw new Error('Must not create an external session in the index test'); },
  async submit() { return { status: 'rejected' }; }, async follow() { return () => {}; },
};
function row(sessionId: string, generation = 1) {
  return { schema: 1, state: 'ready', sessionId, generation, requestId: null, updatedAt: 1000 };
}

test('indexed lookup never scans large history after bounded startup and rechecks authoritative generation', context => {
  const store = createSqliteStore({ filename: ':memory:' });
  context.after(() => store.close());
  for (let index = 0; index < 3000; index++) store.write('host.sessions', `group:${index + 1}`, row(`session-${index + 1}`));
  let listCalls = 0;
  const measured: DurableStore = { ...store, list(namespace, options) { listCalls++; return store.list(namespace, options); } };
  const registry = createSessionRegistry({ store: measured, agent });
  const startupLists = listCalls;
  for (let index = 0; index < 300; index++) {
    assert.deepEqual(registry.findBySessionId('session-2500'), { conversationId: 'group:2500', sessionId: 'session-2500', generation: 1 });
  }
  assert.equal(listCalls, startupLists);
  const current = store.read('host.sessions', 'group:2500')!;
  store.write('host.sessions', 'group:2500', row('migrated-child', 2), { expectedRevision: current.revision });
  assert.equal(registry.findBySessionId('session-2500'), null);
  assert.equal(registry.findBySessionId('migrated-child', 1), null);
  assert.deepEqual(registry.findBySessionId('migrated-child', 2), { conversationId: 'group:2500', sessionId: 'migrated-child', generation: 2 });
  assert.equal(listCalls, startupLists);
});

test('retired IDs stay permanently owned and cannot move to a different conversation or generation', context => {
  const store = createSqliteStore({ filename: ':memory:' });
  context.after(() => store.close());
  const registry = createSessionRegistry({ store, agent });
  registry.bind('group:1', 'old-external-id');
  registry.retire('group:1');
  assert.equal(registry.findBySessionId('old-external-id'), null);
  assert.throws(() => registry.bind('group:2', 'old-external-id'), { code: 'SESSION_ID_REUSED' });
  assert.throws(() => registry.bind('group:1', 'old-external-id', 2), { code: 'SESSION_ID_REUSED' });
  registry.bind('group:1', 'new-external-id', 2);
  assert.equal(registry.findBySessionId('new-external-id', 1), null);
  assert.equal(registry.findBySessionId('new-external-id', 2)?.conversationId, 'group:1');
  // Even a direct external write cannot make a known old ID valid in a new generation.
  store.write('host.sessions', 'group:1', row('old-external-id', 3));
  assert.throws(() => registry.findBySessionId('old-external-id'), { code: 'SESSION_ID_REUSED' });
});

test('legacy duplicate IDs reject installation and unsupported stores use one bounded recovery pass', context => {
  const duplicate = createSqliteStore({ filename: ':memory:' });
  context.after(() => duplicate.close());
  duplicate.write('host.sessions', 'group:1', row('duplicated'));
  duplicate.write('host.sessions', 'group:2', row('duplicated'));
  assert.throws(() => createSessionRegistry({ store: duplicate, agent }), { code: 'SESSION_ID_CONFLICT' });

  const base = createSqliteStore({ filename: ':memory:' });
  context.after(() => base.close());
  base.write('host.sessions', 'group:1', row('legacy'));
  const { createIndex: _createIndex, lookup: _lookup, ...withoutIndex } = base;
  let lists = 0;
  const store: DurableStore = { ...withoutIndex, list(namespace, options) { lists++; return base.list(namespace, options); } };
  const registry = createSessionRegistry({ store, agent });
  const recoveryLists = lists;
  assert.equal(registry.findBySessionId('legacy')?.conversationId, 'group:1');
  registry.retire('group:1');
  registry.bind('group:1', 'replacement', 2);
  assert.equal(registry.findBySessionId('legacy'), null);
  assert.equal(registry.findBySessionId('replacement')?.generation, 2);
  assert.equal(lists, recoveryLists);
});

test('recovery bounds fail before a partial index can publish a guessed lookup', context => {
  const store = createSqliteStore({ filename: ':memory:' });
  context.after(() => store.close());
  store.write('host.sessions', 'group:1', row('one'));
  store.write('host.sessions', 'group:2', row('two'));
  assert.throws(() => createSessionRegistry({ store, agent, maxRecoveryRecords: 1 }), { code: 'SESSION_RECOVERY_LIMIT' });
});

test('an interrupted binding write retains ownership evidence but publishes no reverse association or automatic retry', async context => {
  const base = createSqliteStore({ filename: ':memory:' });
  context.after(() => base.close());
  let calls = 0;
  let failBinding = true;
  const store: DurableStore = { ...base, write(namespace, key, value, options) {
    if (failBinding && namespace === 'host.sessions' && value !== null && typeof value === 'object'
      && !Array.isArray(value) && value.state === 'ready') throw new FrameworkError('STORE_IO_ERROR', 'Controlled interruption');
    return base.write(namespace, key, value, options);
  } };
  const registry = createSessionRegistry({ store, agent: { ...agent, async createSession() { calls++; return { sessionId: 'uncertain-external' }; } } });
  await assert.rejects(registry.resolve('group:1', new AbortController().signal), { code: 'SESSION_CREATE_UNKNOWN' });
  assert.equal(registry.findBySessionId('uncertain-external'), null);
  await assert.rejects(registry.resolve('group:1', new AbortController().signal), { code: 'SESSION_RECONCILIATION_REQUIRED' });
  assert.equal(calls, 1);
  assert.throws(() => registry.bind('group:2', 'uncertain-external'), { code: 'SESSION_ID_REUSED' });
  failBinding = false;
  registry.bind('group:1', 'uncertain-external', 1);
  assert.equal(registry.findBySessionId('uncertain-external')?.conversationId, 'group:1');
});
