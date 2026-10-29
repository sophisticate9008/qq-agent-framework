import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionRegistry } from '../src/host/sessions.ts';
import type { AgentAdapter } from '../src/host/types.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

type CreateRequest = Parameters<AgentAdapter['createSession']>[0];

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: Error): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function temporaryDatabase(): { directory: string; filename: string } {
  const directory = mkdtempSync(join(tmpdir(), 'qq-bridge-framework-sessions-'));
  return { directory, filename: join(directory, 'sessions.sqlite') };
}

function adapter(createSession: AgentAdapter['createSession']): AgentAdapter {
  return {
    createSession,
    async submit() { return { status: 'accepted' }; },
    async follow() { return () => {}; }
  };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

test('concurrent resolves share one durable creation intent and reuse the binding after reopen', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  const createResult = deferred<{ sessionId: string }>();
  const requests: CreateRequest[] = [];
  const registry = createSessionRegistry({
    store,
    agent: adapter(async (request) => {
      requests.push(request);
      return createResult.promise;
    }),
    clock: () => 100
  });
  const signal = new AbortController().signal;
  const first = registry.resolve('conversation-one', signal);
  const second = registry.resolve('conversation-one', signal);
  assert.strictEqual(first, second);
  assert.equal(requests.length, 1);
  const creating = registry.list();
  assert.equal(creating.length, 1);
  assert.equal(creating[0]?.state, 'creating');
  assert.equal(creating[0]?.requestId, requests[0]?.requestId);
  assert.equal(creating[0]?.generation, 1);

  createResult.resolve({ sessionId: 'agent-session-one' });
  const [firstBinding, secondBinding] = await Promise.all([first, second]);
  assert.deepEqual(firstBinding, {
    conversationId: 'conversation-one',
    sessionId: 'agent-session-one',
    generation: 1
  });
  assert.deepEqual(secondBinding, firstBinding);
  assert.deepEqual(registry.get('conversation-one'), firstBinding);
  assert.equal(registry.list()[0]?.state, 'ready');
  store.close();

  const reopenedStore = createSqliteStore({ filename: temporary.filename });
  context.after(() => reopenedStore.close());
  let reopenedCreates = 0;
  const reopened = createSessionRegistry({
    store: reopenedStore,
    agent: adapter(async () => {
      reopenedCreates += 1;
      return { sessionId: 'unexpected' };
    })
  });
  assert.deepEqual(await reopened.resolve('conversation-one', signal), firstBinding);
  assert.equal(reopenedCreates, 0);
});

test('restart converts an unresolved creation to unknown until an explicit bind', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const firstStore = createSqliteStore({ filename: temporary.filename });
  const createResult = deferred<{ sessionId: string }>();
  const firstRegistry = createSessionRegistry({
    store: firstStore,
    agent: adapter(() => createResult.promise),
    clock: () => 200
  });
  const pending = firstRegistry.resolve('restart-conversation', new AbortController().signal);
  assert.equal(firstRegistry.list()[0]?.state, 'creating');
  firstStore.close();

  const reopenedStore = createSqliteStore({ filename: temporary.filename });
  context.after(() => reopenedStore.close());
  let createCalls = 0;
  const reopened = createSessionRegistry({
    store: reopenedStore,
    agent: adapter(async () => {
      createCalls += 1;
      return { sessionId: 'must-not-create' };
    }),
    clock: () => 300
  });
  assert.equal(reopened.list()[0]?.state, 'unknown');
  await assert.rejects(reopened.resolve('restart-conversation', new AbortController().signal),
    (error: unknown) => hasCode(error, 'SESSION_RECONCILIATION_REQUIRED'));
  assert.equal(createCalls, 0);
  const reconciled = reopened.bind('restart-conversation', 'reconciled-session', 1);
  assert.deepEqual(await reopened.resolve('restart-conversation', new AbortController().signal), reconciled);

  createResult.reject(new Error('late transport failure with sensitive details'));
  await assert.rejects(pending, (error: unknown) => hasCode(error, 'SESSION_CREATE_UNKNOWN'));
});

test('retirement advances generation so a late create cannot replace the rebuilt session', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  context.after(() => store.close());
  const firstResult = deferred<{ sessionId: string }>();
  const secondResult = deferred<{ sessionId: string }>();
  const requests: CreateRequest[] = [];
  const registry = createSessionRegistry({
    store,
    agent: adapter((request) => {
      requests.push(request);
      return requests.length === 1 ? firstResult.promise : secondResult.promise;
    }),
    clock: () => 400
  });
  const first = registry.resolve('retire-conversation', new AbortController().signal);
  const retired = registry.retire('retire-conversation');
  assert.equal(retired.state, 'retired');
  assert.equal(retired.generation, 2);
  const replacement = registry.resolve('retire-conversation', new AbortController().signal);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]?.requestId, requests[1]?.requestId);

  firstResult.resolve({ sessionId: 'late-old-session' });
  await assert.rejects(first, (error: unknown) => hasCode(error, 'SESSION_BINDING_CHANGED'));
  assert.equal(registry.list()[0]?.state, 'creating');
  assert.equal(registry.list()[0]?.generation, 2);
  secondResult.resolve({ sessionId: 'replacement-session' });
  const replacementBinding = await replacement;
  assert.deepEqual(replacementBinding, {
    conversationId: 'retire-conversation',
    sessionId: 'replacement-session',
    generation: 2
  });
  assert.deepEqual(registry.get('retire-conversation'), replacementBinding);
});

test('uncertain creation is not retried and metadata can be reconciled or retired explicitly', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  context.after(() => store.close());
  let createCalls = 0;
  const registry = createSessionRegistry({
    store,
    agent: adapter(async () => {
      createCalls += 1;
      throw new Error('adapter details must not escape');
    }),
    clock: () => 500
  });
  await assert.rejects(registry.resolve('unknown-conversation', new AbortController().signal),
    (error: unknown) => hasCode(error, 'SESSION_CREATE_UNKNOWN')
      && !String(error).includes('adapter details'));
  await assert.rejects(registry.resolve('unknown-conversation', new AbortController().signal),
    (error: unknown) => hasCode(error, 'SESSION_RECONCILIATION_REQUIRED'));
  assert.equal(createCalls, 1);
  assert.deepEqual(registry.list().map((entry) => ({ state: entry.state, generation: entry.generation })), [
    { state: 'unknown', generation: 1 }
  ]);
  assert.throws(() => registry.bind('unknown-conversation', 'manual-session', 2),
    (error: unknown) => hasCode(error, 'SESSION_GENERATION_CONFLICT'));
  const retired = registry.retire('unknown-conversation');
  assert.equal(retired.generation, 2);
  assert.equal(registry.get('unknown-conversation'), null);
});

test('aborted creation becomes unknown even when the adapter ignores its signal', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  context.after(() => store.close());
  const createResult = deferred<{ sessionId: string }>();
  let createCalls = 0;
  const registry = createSessionRegistry({
    store,
    agent: adapter(() => {
      createCalls += 1;
      return createResult.promise;
    })
  });
  const controller = new AbortController();
  const pending = registry.resolve('timeout-conversation', controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => hasCode(error, 'SESSION_CREATE_UNKNOWN'));
  assert.equal(createCalls, 1);
  assert.equal(registry.list()[0]?.state, 'unknown');
  await assert.rejects(registry.resolve('timeout-conversation', new AbortController().signal),
    (error: unknown) => hasCode(error, 'SESSION_RECONCILIATION_REQUIRED'));
  assert.equal(createCalls, 1);
  createResult.resolve({ sessionId: 'late-ignored-session' });
});
