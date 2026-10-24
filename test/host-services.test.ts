import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createDurableTransport } from '../src/host/outbox.ts';
import { createTaskQueue } from '../src/host/tasks.ts';
import { createResourceRegistry } from '../src/host/resources.ts';
import { createConversationHistory } from '../src/host/history.ts';
import { object } from '../src/host/data.ts';
import { digest } from '../src/host/data.ts';
import { FrameworkError } from '../src/core/values.ts';
import type { SendRequest } from '../src/core/types.ts';
import type { DurableStore } from '../src/host/types.ts';

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'framework-services-'));
  const filename = join(directory, 'data.sqlite');
  const opened: DurableStore[] = [];
  const open = () => { const store = createSqliteStore({ filename }); opened.push(store); return store; };
  return { directory, open, close() { for (const store of opened) store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
function request(id = 'effect-1'): SendRequest {
  return { conversationId: 'room:1', idempotencyKey: id, content: [{ type: 'text', text: 'private message' }], signal: new AbortController().signal };
}

test('durable receipts survive reopen and never leak message bodies through listings', async () => {
  const fixture = database();
  let calls = 0;
  try {
    const first = createDurableTransport({ store: fixture.open(), transport: { send() { calls++; return { status: 'confirmed', messageId: 'confirmed-1' }; } } });
    assert.equal((await first.send(request())).status, 'confirmed');
    const second = createDurableTransport({ store: fixture.open(), transport: { send() { calls++; return { status: 'rejected' }; } } });
    assert.deepEqual(await second.send(request()), { status: 'confirmed', messageId: 'confirmed-1' });
    assert.equal(calls, 1);
    assert(!JSON.stringify(second.list()).includes('private message'));
    assert.throws(() => second.send({ ...request(), content: [{ type: 'text', text: 'changed' }] }), { code: 'EFFECT_CONFLICT' });
  } finally { fixture.close(); }
});

test('unknown delivery is retained without automatic replay and requires explicit reconciliation', async () => {
  const fixture = database();
  let calls = 0;
  try {
    const first = createDurableTransport({ store: fixture.open(), transport: { send() { calls++; throw new Error('network detail'); } } });
    assert.deepEqual(await first.send(request()), { status: 'unknown' });
    const recovered = createDurableTransport({ store: fixture.open(), transport: { send() { calls++; return { status: 'confirmed', messageId: 'unexpected' }; } } });
    recovered.recover();
    assert.deepEqual(await recovered.send(request()), { status: 'unknown' });
    assert.equal(calls, 1);
    recovered.reconcile('effect-1', { status: 'confirmed', messageId: 'verified-by-host' });
    assert.deepEqual(await recovered.send(request()), { status: 'confirmed', messageId: 'verified-by-host' });
    assert.equal(calls, 1);
  } finally { fixture.close(); }
});

test('separate outbox instances cannot dispatch the same effect twice', async () => {
  const fixture = database();
  const entered = deferred(); const release = deferred();
  let calls = 0;
  try {
    const first = createDurableTransport({ store: fixture.open(), transport: { async send() {
      calls++; entered.resolve(); await release.promise; return { status: 'confirmed', messageId: 'one' };
    } } });
    const pending = first.send(request());
    await entered.promise;
    const second = createDurableTransport({ store: fixture.open(), transport: { send() { calls++; return { status: 'rejected' }; } } });
    assert.deepEqual(await second.send(request()), { status: 'unknown' });
    assert.equal(second.recover(), 1);
    release.resolve();
    assert.deepEqual(await pending, { status: 'unknown' });
    assert.equal(calls, 1);
  } finally { release.resolve(); fixture.close(); }
});

test('prepared and sending intents recover conservatively without adapter calls', () => {
  const fixture = database();
  try {
    const store = fixture.open();
    store.write('outbox', digest('interrupted'), { id: 'interrupted', conversationId: 'room:1', fingerprint: 'fixture', status: 'sending' });
    const outbox = createDurableTransport({ store, transport: { send() { throw new Error('must not run'); } } });
    assert.equal(outbox.recover(), 1);
    assert.equal(outbox.list()[0].status, 'unknown');
    assert.equal(outbox.recover(), 0);
  } finally { fixture.close(); }
});

test('persistent tasks wait for registered handlers and due time', async () => {
  const fixture = database();
  let now = 100;
  let calls = 0;
  try {
    const queue = createTaskQueue({ store: fixture.open(), clock: () => now });
    queue.schedule({ id: 'later', kind: 'test.handler', scope: 'room:1', payload: { secret: 'private' }, dueAt: 200 });
    assert.equal((await queue.runDue()).executed, 0);
    now = 200;
    assert.equal((await queue.runDue()).executed, 0);
    queue.register('test.handler', async execution => { assert.equal(execution.scope, 'room:1'); calls++; });
    assert.equal((await queue.runDue()).executed, 1);
    assert.equal(calls, 1);
    assert.equal(queue.list()[0].status, 'completed');
    assert(!JSON.stringify(queue.list()).includes('private'));
    await queue.stop();
    assert.throws(() => queue.runDue(), { code: 'TASK_QUEUE_STOPPED' });
  } finally { fixture.close(); }
});

test('interrupted task recovery does not execute unknown work again', async () => {
  const fixture = database();
  try {
    const store = fixture.open();
    const queue = createTaskQueue({ store });
    queue.schedule({ id: 'interrupted', kind: 'test.handler', scope: 'room:1', payload: {}, dueAt: 0 });
    const record = store.read('tasks', 'interrupted')!;
    store.write('tasks', record.key, { ...object(record.value), status: 'running' }, { expectedRevision: record.revision });
    const restarted = createTaskQueue({ store: fixture.open() });
    restarted.register('test.handler', () => { assert.fail('Unknown work must not replay.'); });
    assert.equal(restarted.recover(), 1);
    assert.equal((await restarted.runDue()).executed, 0);
    assert.equal(restarted.list()[0].status, 'unknown');
    assert.throws(() => restarted.retry('interrupted'), { code: 'TASK_RETRY_DENIED' });
    await restarted.stop(); await queue.stop();
  } finally { fixture.close(); }
});

test('task cancellation does not falsely promise that an active effect was undone', async () => {
  const fixture = database();
  const entered = deferred(); const release = deferred();
  try {
    const queue = createTaskQueue({ store: fixture.open() });
    queue.register('test.handler', async execution => { entered.resolve(); await release.promise; assert.equal(execution.signal.aborted, true); });
    queue.schedule({ id: 'running', kind: 'test.handler', scope: 'room:1', payload: {}, dueAt: 0 });
    const pending = queue.runDue();
    await entered.promise;
    assert.equal(queue.cancel('running'), true);
    release.resolve();
    await pending;
    assert.equal(queue.list()[0].status, 'unknown');
    await queue.stop();
  } finally { release.resolve(); fixture.close(); }
});

test('task retry is explicit and bounded and scanning advances past future work', async () => {
  const fixture = database();
  let calls = 0;
  try {
    const queue = createTaskQueue({ store: fixture.open(), maxScan: 1 });
    queue.register('test.handler', () => { if (++calls === 1) throw new FrameworkError('EXPECTED_FAILURE', 'Test failure.'); });
    queue.schedule({ id: 'aaa', kind: 'test.handler', scope: 'room:1', payload: {}, dueAt: Date.now() + 100000 });
    queue.schedule({ id: 'bbb', kind: 'test.handler', scope: 'room:1', payload: {}, dueAt: 0, maxAttempts: 2 });
    assert.equal((await queue.runDue()).executed, 0);
    assert.equal((await queue.runDue()).executed, 1);
    queue.retry('bbb');
    await queue.runDue(); await queue.runDue();
    assert.equal(calls, 2);
    assert.equal(queue.list()[1].status, 'completed');
    assert.throws(() => queue.retry('bbb'), { code: 'TASK_RETRY_DENIED' });
    await queue.stop();
  } finally { fixture.close(); }
});

test('resource approval binds scope and persona and expires independently of preferences', () => {
  const fixture = database();
  let now = 100;
  try {
    const registry = createResourceRegistry({ store: fixture.open(), clock: () => now });
    registry.register({ id: 'portrait', type: 'image', scope: 'room:1', persona: 'persona@1', version: '1',
      source: { kind: 'gateway', id: 'opaque-image-id' }, expiresAt: 200 });
    const selection = { assetId: 'portrait', type: 'image' as const, conversationId: 'room:1', persona: 'persona@1' };
    assert.throws(() => registry.resolve(selection), { code: 'RESOURCE_UNAVAILABLE' });
    registry.approve('portrait');
    assert.equal(registry.resolve(selection), 'opaque-image-id');
    assert.throws(() => registry.resolve({ ...selection, conversationId: 'room:2' }), { code: 'RESOURCE_UNAVAILABLE' });
    assert.throws(() => registry.resolve({ ...selection, persona: 'persona@2' }), { code: 'RESOURCE_UNAVAILABLE' });
    assert(!JSON.stringify(registry.list()).includes('opaque-image-id'));
    now = 200;
    assert.throws(() => registry.resolve(selection), { code: 'RESOURCE_UNAVAILABLE' });
    registry.revoke('portrait');
    assert.throws(() => registry.approve('portrait'), { code: 'RESOURCE_NOT_PENDING' });
  } finally { fixture.close(); }
});

test('resource locations are constrained and symlinks are rechecked at resolution', () => {
  const fixture = database();
  try {
    const root = join(fixture.directory, 'assets'); mkdirSync(root);
    const filename = join(root, 'image.png'); writeFileSync(filename, 'image');
    const outside = join(fixture.directory, 'outside.png'); writeFileSync(outside, 'outside');
    const registry = createResourceRegistry({ store: fixture.open(), rootDirectory: root, allowedOrigins: ['https://assets.invalid'] });
    registry.register({ id: 'file', type: 'image', scope: 'global', version: '1', source: { kind: 'file', path: filename } });
    registry.approve('file');
    assert.equal(registry.resolve({ assetId: 'file', type: 'image', conversationId: 'room:1' }), filename);
    unlinkSync(filename); symlinkSync(outside, filename);
    assert.throws(() => registry.resolve({ assetId: 'file', type: 'image', conversationId: 'room:1' }), { code: 'RESOURCE_SOURCE_DENIED' });
    assert.throws(() => registry.register({ id: 'url', type: 'image', scope: 'global', version: '1',
      source: { kind: 'url', url: 'https://other.invalid/image.png' } }), { code: 'RESOURCE_SOURCE_DENIED' });
    assert.throws(() => registry.register({ id: 'gateway', type: 'image', scope: 'global', version: '1',
      source: { kind: 'gateway', id: 'file:///private' } }), { code: 'INVALID_RESOURCE' });
  } finally { fixture.close(); }
});

test('conversation history persists bounded unread state without allocating empty reads', () => {
  const fixture = database();
  try {
    const store = fixture.open();
    const history = createConversationHistory({ store, maxMessages: 2 });
    assert.equal(history.snapshot('room:empty').messages.length, 0);
    assert.equal(store.list('history').length, 0);
    const message = { actor: 'user:1', receivedAt: 1, content: [{ type: 'text' as const, text: 'hello' }] };
    assert.equal(history.append('room:1', { ...message, id: 'one' }), 1);
    assert.equal(history.append('room:1', { ...message, id: 'one', receivedAt: 2 }), 1);
    history.append('room:1', { ...message, id: 'two' });
    history.append('room:1', { ...message, id: 'three' });
    const snapshot = history.snapshot('room:1', { afterSequence: 0, limit: 2 });
    assert.deepEqual(snapshot.messages.map(entry => entry.sequence), [2, 3]);
    assert.equal(snapshot.partial, true);
    assert.equal(snapshot.droppedThrough, 1);
    history.markRead('room:1', 2);
    const restarted = createConversationHistory({ store: fixture.open(), maxMessages: 2 });
    assert.equal(restarted.snapshot('room:1').messages[0].sequence, 3);
    assert.throws(() => restarted.markRead('room:1', 1), { code: 'INVALID_READ_CURSOR' });
    assert.throws(() => restarted.markRead('room:1', 4), { code: 'INVALID_READ_CURSOR' });
  } finally { fixture.close(); }
});
