import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { normalizeOneBotMessage } from '../src/adapters/onebot.ts';
import type { DeliveryReceipt } from '../src/core/types.ts';
import { CONTROL_COMMAND_NAMESPACE, createControlCommands, type ControlCommandContext,
  type ControlCommandDefinition, type ControlCommandSendRequest } from '../src/host/control-commands.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import type { DurableStore, InboundMessage } from '../src/host/types.ts';

function message(id = 'event-1', conversationId = 'group:101'): InboundMessage {
  return { id, conversationId, userId: '202', receivedAt: 1000,
    content: [{ type: 'text', text: '/manage' }], directed: true, isSelf: false };
}

const signal = () => new AbortController().signal;

function deferred<Value>() {
  let resolve: (value: Value) => void = () => { throw new Error('deferred was not initialized'); };
  const promise = new Promise<Value>(complete => { resolve = complete; });
  return { promise, resolve: (value: Value) => resolve(value) };
}

async function settled(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 80 && !predicate(); turn++) await Promise.resolve();
  assert.ok(predicate());
}

function fixture(context: TestContext, options: {
  handle?: ControlCommandDefinition['handle']; send?: (request: ControlCommandSendRequest) => Promise<DeliveryReceipt>;
  replyTexts?: readonly string[]; timeoutMs?: number; maxRaw?: number; maxRecords?: number;
  signal?: AbortSignal;
} = {}) {
  const store = createSqliteStore({ filename: ':memory:' });
  const sends: ControlCommandSendRequest[] = [];
  let executions = 0;
  const definition: ControlCommandDefinition = { id: 'manage',
    matches: input => input.content.some(part => part.type === 'text' && part.text === '/manage'),
    replyTexts: options.replyTexts ?? ['Saved.'],
    async handle(input) {
      executions++;
      assert.equal(store.list(CONTROL_COMMAND_NAMESPACE).some(row => row.value !== null && typeof row.value === 'object'
        && !Array.isArray(row.value) && row.value.state === 'running'), true);
      if (options.handle) await options.handle(input);
      else await input.reply('Saved.');
    } };
  const registry = createControlCommands({ store, commands: [definition],
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxRaw === undefined ? {} : { maxRaw: options.maxRaw }),
    ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    async send(request) {
      sends.push(request);
      assert.equal(store.list(CONTROL_COMMAND_NAMESPACE).some(row => row.value !== null && typeof row.value === 'object'
        && !Array.isArray(row.value) && row.value.replyState === 'intent'), true);
      return options.send ? options.send(request) : { status: 'confirmed', messageId: 'fixture-reply' };
    } });
  context.after(async () => { await registry.stop(); store.close(); });
  return { store, registry, sends, definition, executions: () => executions };
}

test('a real normalized non-self source can reach a fixed host receipt without a chat whitelist', async context => {
  const setup = fixture(context);
  const source = await normalizeOneBotMessage({ post_type: 'message', message_type: 'group', self_id: 999,
    group_id: 101, user_id: 202, message_id: 1, time: 1, message: [{ type: 'text', data: { text: '/manage' } }] }, { selfId: '999' });
  assert.ok(source);
  const outcome = await setup.registry.dispatchNormalized(source, signal());
  assert.equal(outcome.handled, true);
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.replyReceipt, { status: 'confirmed', messageId: 'fixture-reply' });
  assert.equal(setup.sends[0]?.conversationId, 'group:101');
  assert.deepEqual(setup.sends[0]?.content, [{ type: 'text', text: 'Saved.' }]);
  assert.match(setup.sends[0]!.idempotencyKey, /^host-control-reply:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(setup.sends[0]), true);
  const ledger = JSON.stringify(setup.store.list(CONTROL_COMMAND_NAMESPACE));
  assert.equal(ledger.includes('/manage'), false);
  assert.equal(ledger.includes('Saved.'), false);
});

test('self messages and unmatched ordinary conversation do not create command records or replies', async context => {
  const setup = fixture(context);
  assert.equal((await setup.registry.dispatchNormalized({ ...message(), isSelf: true }, signal())).status, 'ignored-self');
  assert.equal((await setup.registry.dispatchNormalized({ ...message(), content: [{ type: 'text', text: 'hello' }] }, signal())).handled, false);
  assert.equal(setup.store.list(CONTROL_COMMAND_NAMESPACE).length, 0);
  assert.equal(setup.executions(), 0);
  assert.equal(setup.sends.length, 0);
});

test('same event and conversation deduplicate concurrently and across registry recreation', async context => {
  const gate = deferred<void>();
  const setup = fixture(context, { handle: async command => { await gate.promise; await command.reply('Saved.'); } });
  const first = setup.registry.dispatchNormalized(message(), signal());
  const duplicate = setup.registry.dispatchNormalized(message(), signal());
  await settled(() => setup.executions() === 1);
  gate.resolve();
  assert.deepEqual(await first, await duplicate);
  const second = createControlCommands({ store: setup.store, commands: [{ ...setup.definition,
    async handle() { assert.fail('A completed event must not execute again.'); } }], async send() { assert.fail('No duplicate send.'); } });
  context.after(() => second.stop());
  const replay = await second.dispatchNormalized({ ...message(), receivedAt: 2000 }, signal());
  assert.equal(replay.duplicate, true);
  assert.equal(replay.status, 'completed');
  assert.equal(setup.executions(), 1);
  assert.equal(setup.sends.length, 1);
});

test('reused event IDs with changed content conflict; different source conversations remain separate', async context => {
  const setup = fixture(context);
  await setup.registry.dispatchNormalized(message(), signal());
  await assert.rejects(setup.registry.dispatchNormalized({ ...message(), userId: '303' }, signal()), { code: 'CONTROL_COMMAND_EVENT_CONFLICT' });
  await assert.rejects(setup.registry.dispatchNormalized({ ...message(), content: [{ type: 'text', text: '/other' }] }, signal()), { code: 'CONTROL_COMMAND_EVENT_CONFLICT' });
  await setup.registry.dispatchNormalized(message('event-1', 'private:202'), signal());
  assert.equal(setup.executions(), 2);
  assert.deepEqual(setup.sends.map(request => request.conversationId), ['group:101', 'private:202']);
});

test('context and message are frozen copies; changing input cannot redirect the receipt', async context => {
  const gate = deferred<void>();
  const setup = fixture(context, { async handle(command) {
    await gate.promise;
    assert.equal(Object.isFrozen(command), true);
    assert.equal(Object.isFrozen(command.message), true);
    assert.equal(Object.isFrozen(command.message.content[0]), true);
    assert.throws(() => Object.assign(command.message, { conversationId: 'private:303' }));
    await command.reply('Saved.');
  } });
  const input = message();
  const pending = setup.registry.dispatchNormalized(input, signal());
  input.conversationId = 'private:303';
  input.userId = '303';
  gate.resolve();
  assert.equal((await pending).status, 'completed');
  assert.equal(setup.sends[0]?.conversationId, 'group:101');
});

test('only exact registered templates are allowed and a second reply never sends', async context => {
  const denied = fixture(context, { handle: async command => { await command.reply('arbitrary content'); } });
  assert.equal((await denied.registry.dispatchNormalized(message(), signal())).status, 'unknown');
  assert.equal(denied.sends.length, 0);
  const twice = fixture(context, { async handle(command) {
    await command.reply('Saved.');
    await command.reply('Saved.');
  } });
  const outcome = await twice.registry.dispatchNormalized(message(), signal());
  assert.equal(outcome.status, 'unknown');
  assert.deepEqual(outcome.replyReceipt, { status: 'confirmed', messageId: 'fixture-reply' });
  assert.equal(twice.sends.length, 1);
  await twice.registry.dispatchNormalized(message(), signal());
  assert.equal(twice.sends.length, 1);
});

test('rejected and unknown send outcomes are recorded exactly and never automatically retried', async context => {
  for (const status of ['rejected', 'unknown'] as const) {
    const setup = fixture(context, { send: async () => ({ status }) });
    const first = await setup.registry.dispatchNormalized(message(), signal());
    assert.deepEqual(first.replyReceipt, { status });
    const duplicate = await setup.registry.dispatchNormalized(message(), signal());
    assert.deepEqual(duplicate.replyReceipt, { status });
    assert.equal(setup.sends.length, 1);
    const row = setup.store.list(CONTROL_COMMAND_NAMESPACE)[0]!.value;
    assert.ok(row && typeof row === 'object' && !Array.isArray(row));
    assert.equal(row.replyState, status);
  }
});

test('a handler throw cannot be retried even when no reply was requested', async context => {
  const setup = fixture(context, { async handle() { throw new Error('private error must not be returned'); } });
  const first = await setup.registry.dispatchNormalized(message(), signal());
  assert.equal(first.status, 'unknown');
  assert.equal(JSON.stringify(first).includes('private error'), false);
  await setup.registry.dispatchNormalized(message(), signal());
  assert.equal(setup.executions(), 1);
});

test('deadline retains raw send and handler slots and late confirmation cannot rewrite unknown', async context => {
  const delivery = deferred<DeliveryReceipt>();
  const setup = fixture(context, { timeoutMs: 15, send: async () => delivery.promise });
  const outcome = await setup.registry.dispatchNormalized(message(), signal());
  assert.equal(outcome.status, 'unknown');
  assert.deepEqual(outcome.replyReceipt, { status: 'unknown' });
  assert.equal(setup.registry.metrics().pendingRaw, 2);
  await setup.registry.dispatchNormalized(message(), signal());
  assert.equal(setup.sends.length, 1);
  delivery.resolve({ status: 'confirmed', messageId: 'late-receipt' });
  await settled(() => setup.registry.metrics().pendingRaw === 0);
  const replay = await setup.registry.dispatchNormalized(message(), signal());
  assert.equal(replay.status, 'unknown');
  assert.deepEqual(replay.replyReceipt, { status: 'unknown' });
});

test('stop cancels logical execution, closes retained reply context, and reports rather than erases raw work', async context => {
  const gate = deferred<void>();
  let captured: Readonly<ControlCommandContext> | undefined;
  const setup = fixture(context, { async handle(command) { captured = command; await gate.promise; } });
  const pending = setup.registry.dispatchNormalized(message(), signal());
  await settled(() => captured !== undefined);
  const stopped = await setup.registry.stop();
  assert.equal((await pending).status, 'unknown');
  assert.equal(stopped.pendingRaw, 1);
  assert.ok(captured);
  await assert.rejects(captured.reply('Saved.'), { code: 'CONTROL_COMMAND_CONTEXT_CLOSED' });
  assert.equal((await setup.registry.dispatchNormalized(message('later'), signal())).status, 'stopped');
  gate.resolve();
  await settled(() => setup.registry.metrics().pendingRaw === 0);
  assert.equal(setup.sends.length, 0);
});

test('interrupted running/send-intent records recover to unknown without invoking a handler or send', async context => {
  const delivery = deferred<DeliveryReceipt>();
  const setup = fixture(context, { send: async () => delivery.promise });
  const pending = setup.registry.dispatchNormalized(message(), signal());
  await settled(() => setup.sends.length === 1);
  const interrupted = setup.store.list(CONTROL_COMMAND_NAMESPACE)[0]!;
  await setup.registry.stop();
  await pending;
  delivery.resolve({ status: 'confirmed', messageId: 'late-receipt' });
  await settled(() => setup.registry.metrics().pendingRaw === 0);
  setup.store.write(CONTROL_COMMAND_NAMESPACE, interrupted.key, interrupted.value);
  const restored = createControlCommands({ store: setup.store, commands: [{ ...setup.definition,
    async handle() { assert.fail('No handler replay after recovery.'); } }], async send() { assert.fail('No send replay.'); } });
  context.after(() => restored.stop());
  const replay = await restored.dispatchNormalized(message(), signal());
  assert.equal(replay.status, 'unknown');
  assert.deepEqual(replay.replyReceipt, { status: 'unknown' });
  const value = setup.store.read(CONTROL_COMMAND_NAMESPACE, interrupted.key)!.value;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.equal(value.state, 'unknown');
  assert.equal(value.replyState, 'unknown');
  assert.equal(setup.executions(), 1);
});

test('raw32 and persistent record bounds reject new commands without evicting unsettled entries', async context => {
  const gate = deferred<void>();
  const setup = fixture(context, { async handle() { await gate.promise; }, timeoutMs: 1000 });
  const pending = Array.from({ length: 32 }, (_, index) => setup.registry.dispatchNormalized(message(`event-${index}`), signal()));
  assert.equal(setup.registry.metrics().pendingRaw, 32);
  assert.equal((await setup.registry.dispatchNormalized(message('overflow'), signal())).status, 'capacity');
  assert.equal(setup.store.list(CONTROL_COMMAND_NAMESPACE).length, 32);
  await setup.registry.stop();
  await Promise.all(pending);
  gate.resolve();
  await settled(() => setup.registry.metrics().pendingRaw === 0);
  const bounded = fixture(context, { maxRecords: 2, async handle() {} });
  await bounded.registry.dispatchNormalized(message('one'), signal());
  await bounded.registry.dispatchNormalized(message('two'), signal());
  assert.equal((await bounded.registry.dispatchNormalized(message('three'), signal())).status, 'capacity');
  assert.equal(bounded.store.list(CONTROL_COMMAND_NAMESPACE).length, 2);
});

test('static definitions enforce unique ids, command64, template1000 and hard upper bounds', async context => {
  const setup = fixture(context);
  const options = { store: setup.store, commands: [setup.definition], send: async (): Promise<DeliveryReceipt> => ({ status: 'rejected' }) };
  for (const invalid of [
    { commands: [setup.definition, setup.definition] },
    { commands: Array.from({ length: 65 }, (_, index) => ({ ...setup.definition, id: `command-${index}` })) },
    { commands: [{ ...setup.definition, replyTexts: ['x'.repeat(1001)] }] },
    { maxRaw: 33 }, { maxRecords: 4097 }
  ]) assert.throws(() => createControlCommands({ ...options, ...invalid }), { code: 'CONTROL_COMMAND_CONFIGURATION_INVALID' });
  const ambiguous = createControlCommands({ ...options, commands: [setup.definition, { ...setup.definition, id: 'second' }] });
  context.after(() => ambiguous.stop());
  await assert.rejects(ambiguous.dispatchNormalized(message(), signal()), { code: 'CONTROL_COMMAND_AMBIGUOUS' });
  assert.equal(setup.sends.length, 0);
});

test('failed durable send-intent write prevents sender invocation and does not claim command success', async context => {
  const actual = createSqliteStore({ filename: ':memory:' });
  context.after(() => actual.close());
  const store: DurableStore = { ...actual, write(namespace, key, value, options) {
    if (namespace === CONTROL_COMMAND_NAMESPACE && value && typeof value === 'object' && !Array.isArray(value)
      && value.replyState === 'intent') throw new Error('test-only persistence failure');
    return actual.write(namespace, key, value, options);
  } };
  let sends = 0;
  const registry = createControlCommands({ store, commands: [{ id: 'manage', matches: () => true,
    replyTexts: ['Saved.'], async handle(command) { await command.reply('Saved.'); } }], async send() {
    sends++;
    return { status: 'confirmed', messageId: 'must-not-send' };
  } });
  context.after(() => registry.stop());
  assert.equal((await registry.dispatchNormalized(message(), signal())).status, 'unknown');
  await registry.dispatchNormalized(message(), signal());
  assert.equal(sends, 0);
});
