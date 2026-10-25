import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameworkError } from '../src/core/values.ts';
import { AccessServiceError, createAccessService } from '../src/host/access-service.ts';
import type { AccessChangeRequest, AccessDocument, AccessServiceOptions } from '../src/host/access-service.ts';

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>(complete => { resolve = complete; });
  return { promise, resolve };
}

function fixture(overrides: Partial<AccessServiceOptions> = {}) {
  let current: AccessDocument = { revision: 'revision-1', value: { owner: '123', allow: ['group:456'], deny: ['private:789'] } };
  let reads = 0;
  let writes = 0;
  const publications: { saved: AccessDocument; previous: AccessDocument; signal: AbortSignal }[] = [];
  const options: AccessServiceOptions = {
    async read() { reads++; return structuredClone(current); },
    async compareAndSet(expectedRevision, next, signal) {
      assert.equal(signal.aborted, false);
      assert.equal(expectedRevision, current.revision);
      assert(Object.isFrozen(next));
      assert(Object.isFrozen(next.allow));
      writes++;
      current = { revision: `revision-${writes + 1}`, value: structuredClone(next) };
      return structuredClone(current);
    },
    async publish(saved, previous, signal) { publications.push({ saved, previous, signal }); },
    ...overrides
  };
  const service = createAccessService(options);
  return { service, options, publications, reads: () => reads, writes: () => writes,
    current: () => current, set(document: AccessDocument) { current = document; } };
}

const change = (overrides: Partial<AccessChangeRequest> = {}): AccessChangeRequest => ({
  actorId: '123', expectedRevision: 'revision-1', kind: 'private', targetId: '456', operation: 'add', sourceId: 'source-1', ...overrides
});
const signal = () => new AbortController().signal;
const code = (expected: string) => (failure: unknown) => failure instanceof AccessServiceError && failure.code === expected;
const drain = () => new Promise<void>(resolve => setImmediate(resolve));

test('owner changes only the requested canonical allow scope; publish receives confirmed immutable documents', async () => {
  const setup = fixture();
  const initial = await setup.service.read();
  assert(Object.isFrozen(initial));
  assert(Object.isFrozen(initial.value.allow));
  const result = await setup.service.change(change({ targetId: '12345678901234567890' }), signal());
  assert.equal(result.state, 'applied');
  assert.equal(result.sourceId, 'source-1');
  assert.deepEqual(result.document, { revision: 'revision-2', value: {
    owner: '123', deny: ['private:789'], allow: ['group:456', 'private:12345678901234567890']
  } });
  assert.equal(setup.writes(), 1);
  assert.equal(setup.publications.length, 1);
  assert.deepEqual(setup.publications[0].previous, initial);
  assert.deepEqual(setup.publications[0].saved, result.document);
  assert(Object.isFrozen(setup.publications[0].saved.value));
  assert.equal(setup.publications[0].signal.aborted, false);
  const reusedSource = await setup.service.change(change({ expectedRevision: 'revision-2', targetId: '999' }), signal());
  assert.equal(reusedSource.state, 'applied');
  assert.equal(reusedSource.sourceId, 'source-1');
  assert.equal(setup.writes(), 2);
});

test('no-op add/remove never CAS or publish, but owner and revision are still checked', async () => {
  const setup = fixture();
  assert.equal((await setup.service.change(change({ kind: 'group' }), signal())).state, 'unchanged');
  assert.equal((await setup.service.change(change({ operation: 'remove' }), signal())).state, 'unchanged');
  await assert.rejects(setup.service.change(change({ kind: 'group', actorId: '999' }), signal()), code('ACCESS_OWNER_REQUIRED'));
  await assert.rejects(setup.service.change(change({ kind: 'group', expectedRevision: 'stale' }), signal()), code('ACCESS_REVISION_CONFLICT'));
  setup.set({ ...setup.current(), value: { ...setup.current().value, owner: null } });
  await assert.rejects(setup.service.change(change(), signal()), code('ACCESS_OWNER_REQUIRED'));
  assert.equal(setup.writes(), 0);
  assert.equal(setup.publications.length, 0);
});

test('deny wins over allow additions and removal does not modify deny, owner or the other conversation kind', async () => {
  const setup = fixture();
  await assert.rejects(setup.service.change(change({ targetId: '789' }), signal()), code('ACCESS_DENIED'));
  assert.equal(setup.writes(), 0);
  const result = await setup.service.change(change({ kind: 'group', operation: 'remove' }), signal());
  assert.deepEqual(result.document.value, { allow: [], deny: ['private:789'], owner: '123' });
  assert.equal(setup.writes(), 1);
  assert.equal(setup.publications.length, 1);
});

test('invalid actors, targets, source IDs and extra mutation fields are rejected before reading', async () => {
  const setup = fixture();
  const invalid: unknown[] = [
    ...['0', '0123', '-1', '1.2', '1e3', 'group:456', '456,789', '123456789012345678901', ' 456', 456]
      .flatMap(value => [{ ...change(), targetId: value }, { ...change(), actorId: value }]),
    { ...change(), sourceId: '' }, { ...change(), sourceId: ' ' }, { ...change(), sourceId: 'a\n' },
    { ...change(), expectedRevision: '' }, { ...change(), kind: 'all' }, { ...change(), operation: 'replace' },
    { ...change(), owner: '999' }, { ...change(), deny: [] }
  ];
  for (const value of invalid)
    await assert.rejects(setup.service.change(value as AccessChangeRequest, signal()), code('ACCESS_INVALID_REQUEST'));
  assert.equal(setup.reads(), 0);
  assert.equal(setup.writes(), 0);
});

test('malformed stored rules fail closed without normalizing unrelated owner/deny data', async () => {
  const invalid: unknown[] = [
    { revision: '', value: { allow: [], deny: [], owner: null } },
    ...[
      { allow: ['group:01'], deny: [], owner: '123' },
      { allow: ['group:456', 'group:456'], deny: [], owner: '123' },
      { allow: [], deny: ['private:789', 'private:789'], owner: '123' },
      { allow: ['group:456'], deny: ['group:456'], owner: '123' },
      { allow: [], deny: [], owner: 'group:123' },
      { allow: [], deny: Array.from({ length: 1025 }, (_, index) => `group:${index + 1}`), owner: '123' },
      { allow: [], deny: [], owner: '123', injected: true }
    ].map(value => ({ revision: 'revision-1', value }))
  ];
  for (const value of invalid) {
    const setup = fixture({ async read() { return value as AccessDocument; } });
    await assert.rejects(setup.service.read(), code('ACCESS_INVALID_DOCUMENT'));
    await assert.rejects(setup.service.change(change(), signal()), code('ACCESS_INVALID_DOCUMENT'));
    assert.equal(setup.writes(), 0);
    assert.equal(setup.publications.length, 0);
  }
});

test('the shared 1024-entry bound permits a duplicate no-op and removal but refuses an additional entry', async () => {
  const setup = fixture();
  setup.set({ revision: 'revision-1', value: { owner: '123', allow: Array.from({ length: 1024 }, (_, index) => `group:${index + 1}`), deny: [] } });
  assert.equal((await setup.service.change(change({ kind: 'group', targetId: '1' }), signal())).state, 'unchanged');
  await assert.rejects(setup.service.change(change(), signal()), code('ACCESS_LIMIT_EXCEEDED'));
  assert.equal(setup.writes(), 0);
  const removed = await setup.service.change(change({ kind: 'group', targetId: '1', operation: 'remove' }), signal());
  assert.equal(removed.document.value.allow.length, 1023);
  const added = await setup.service.change(change({ expectedRevision: removed.document.revision }), signal());
  assert.equal(added.document.value.allow.length, 1024);
  assert.equal(setup.writes(), 2);
});

test('CAS conflicts are not retried; unconfirmed or mismatched callbacks never publish', async () => {
  for (const failureCode of ['ACCESS_REVISION_CONFLICT', 'STORE_CONFLICT', 'chat_revision_conflict']) {
    let calls = 0;
    const setup = fixture({ async compareAndSet() { calls++; throw new FrameworkError(failureCode, 'fixture conflict'); } });
    await assert.rejects(setup.service.change(change(), signal()), code('ACCESS_REVISION_CONFLICT'));
    assert.equal(calls, 1);
    assert.equal(setup.publications.length, 0);
  }
  const responses: unknown[] = [
    { revision: 'revision-1', value: { owner: '123', allow: ['group:456', 'private:456'], deny: ['private:789'] } },
    { revision: 'revision-2', value: { owner: '999', allow: ['group:456', 'private:456'], deny: ['private:789'] } },
    { revision: 'revision-2', value: { owner: '123', allow: ['private:456'], deny: ['private:789'] } }, null
  ];
  for (const response of responses) {
    let calls = 0;
    const setup = fixture({ async compareAndSet() { calls++; return response as AccessDocument; } });
    await assert.rejects(setup.service.change(change(), signal()), code('ACCESS_CHANGE_UNKNOWN'));
    assert.equal(calls, 1);
    assert.equal(setup.publications.length, 0);
  }
  const setup = fixture({ async compareAndSet() { throw new Error('sensitive callback failure'); } });
  await assert.rejects(setup.service.change(change(), signal()), failure => code('ACCESS_CHANGE_UNKNOWN')(failure)
    && failure instanceof Error && !failure.message.includes('sensitive'));
});

test('publish failure is explicitly already applied; no publication callback is also supported', async () => {
  const setup = fixture({ async publish() { throw new Error('reload failed'); } });
  await assert.rejects(setup.service.change(change(), signal()), failure => {
    assert(failure instanceof AccessServiceError);
    assert.equal(failure.code, 'APPLIED_RELOAD_REQUIRED');
    assert.deepEqual(failure.saved, setup.current());
    assert.equal(failure.sourceId, 'source-1');
    return true;
  });
  assert.equal(setup.writes(), 1);
  const result = await setup.service.change(change({ expectedRevision: 'revision-2' }), signal());
  assert.equal(result.state, 'unchanged');
  assert.equal(setup.writes(), 1);
  const optional = fixture({ publish: undefined });
  assert.equal((await optional.service.change(change(), signal())).state, 'applied');
});

test('aborted and unresolved reads cannot write, and retain the sole operation slot until raw settlement', async () => {
  const pending = deferred<AccessDocument>();
  const started = deferred<void>();
  let calls = 0;
  const setup = fixture({ async read() { calls++; started.resolve(); return pending.promise; } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(setup.service.change(change(), controller.signal), code('ACCESS_READ_UNKNOWN'));
  assert.equal(calls, 0);
  const active = new AbortController();
  const operation = setup.service.change(change(), active.signal);
  await started.promise;
  active.abort();
  await assert.rejects(operation, code('ACCESS_READ_UNKNOWN'));
  await assert.rejects(setup.service.read(), code('ACCESS_SERVICE_BUSY'));
  await assert.rejects(setup.service.change(change(), signal()), code('ACCESS_SERVICE_BUSY'));
  assert.equal(calls, 1);
  pending.resolve(setup.current());
  await drain();
  assert.equal(setup.writes(), 0);
  assert.equal(setup.publications.length, 0);
  await setup.service.read();
});

test('a timed-out raw CAS remains busy; late completion is not published or automatically replayed', async () => {
  const pending = deferred<AccessDocument>();
  let calls = 0;
  let callbackSignal: AbortSignal | undefined;
  const setup = fixture({ timeoutMs: 20, async compareAndSet(_revision, _next, received) {
    calls++; callbackSignal = received; return pending.promise;
  } });
  await assert.rejects(setup.service.change(change(), signal()), code('ACCESS_CHANGE_UNKNOWN'));
  assert.equal(callbackSignal?.aborted, true);
  await assert.rejects(setup.service.change(change(), signal()), code('ACCESS_SERVICE_BUSY'));
  pending.resolve({ revision: 'revision-2', value: { owner: '123', deny: ['private:789'], allow: ['group:456', 'private:456'] } });
  await drain();
  assert.equal(calls, 1);
  assert.equal(setup.publications.length, 0);
  await setup.service.read();
});

test('abort during publish reports saved data and holds the raw slot; abort inside CAS prevents publish', async () => {
  const started = deferred<void>();
  const pending = deferred<void>();
  const controller = new AbortController();
  const setup = fixture({ async publish() { started.resolve(); await pending.promise; } });
  const operation = setup.service.change(change(), controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(operation, failure => code('APPLIED_RELOAD_REQUIRED')(failure)
    && failure instanceof AccessServiceError && failure.saved?.revision === 'revision-2');
  await assert.rejects(setup.service.read(), code('ACCESS_SERVICE_BUSY'));
  pending.resolve();
  await drain();
  assert.equal((await setup.service.read()).revision, 'revision-2');
  assert.equal(setup.writes(), 1);
  const canceled = new AbortController();
  const afterCas = fixture({ async compareAndSet(_revision, next) {
    canceled.abort();
    return { revision: 'revision-2', value: next };
  } });
  await assert.rejects(afterCas.service.change(change(), canceled.signal), code('ACCESS_CHANGE_UNKNOWN'));
  await drain();
  assert.equal(afterCas.publications.length, 0);
});
