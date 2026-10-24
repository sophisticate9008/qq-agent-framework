import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { createContextStore } from '../src/core/context.ts';
import type { DeliveryReceipt, SendRequest, TransportAdapter } from '../src/core/types.ts';
import { createBridgeHost } from '../src/host/bridge.ts';
import type { AgentAdapter, AgentEvent, InboundMessage } from '../src/host/types.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

type CreateSessionRequest = Parameters<AgentAdapter['createSession']>[0];
type SubmitRequest = Parameters<AgentAdapter['submit']>[0];
type FollowRequest = Parameters<AgentAdapter['follow']>[0];
type SubmitResult = Awaited<ReturnType<AgentAdapter['submit']>>;

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: Error): void;
}

interface FakeAgentOptions {
  submit?(request: SubmitRequest): Promise<SubmitResult> | SubmitResult;
  followSetup?(request: FollowRequest, attempt: number): Promise<void> | void;
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

class FakeAgent implements AgentAdapter {
  readonly createRequests: CreateSessionRequest[] = [];
  readonly submitRequests: SubmitRequest[] = [];
  readonly followRequests: FollowRequest[] = [];
  readonly cancelRequests: Array<Parameters<NonNullable<AgentAdapter['cancel']>>[0]> = [];
  private readonly availableSessions: string[];
  private readonly listeners = new Map<string, Array<(event: AgentEvent) => void | Promise<void>>>();
  private readonly options: FakeAgentOptions;

  constructor(sessionIds: readonly string[], options: FakeAgentOptions = {}) {
    this.availableSessions = [...sessionIds];
    this.options = options;
  }

  async createSession(request: CreateSessionRequest): Promise<{ sessionId: string }> {
    this.createRequests.push(request);
    const sessionId = this.availableSessions.shift();
    if (!sessionId) throw new Error('unexpected session creation');
    return { sessionId };
  }

  async submit(request: SubmitRequest): Promise<SubmitResult> {
    this.submitRequests.push(request);
    return this.options.submit ? this.options.submit(request) : { status: 'accepted' };
  }

  async follow(request: FollowRequest): Promise<() => void> {
    this.followRequests.push(request);
    await this.options.followSetup?.(request, this.followRequests.length);
    const listeners = this.listeners.get(request.sessionId) ?? [];
    listeners.push(request.onEvent);
    this.listeners.set(request.sessionId, listeners);
    return () => {};
  }

  async cancel(request: Parameters<NonNullable<AgentAdapter['cancel']>>[0]): Promise<void> {
    this.cancelRequests.push(request);
  }

  async emit(sessionId: string, event: Omit<AgentEvent, 'sessionId'>, listenerIndex = -1): Promise<void> {
    const listeners = this.listeners.get(sessionId) ?? [];
    const index = listenerIndex < 0 ? listeners.length + listenerIndex : listenerIndex;
    const listener = listeners[index];
    assert(listener, `No follow listener for ${sessionId}.`);
    await listener({ ...event, sessionId });
  }
}

class FakeTransport implements TransportAdapter {
  readonly requests: SendRequest[] = [];
  private readonly receipt: 'confirmed' | 'unknown' | 'rejected';

  constructor(receipt: 'confirmed' | 'unknown' | 'rejected' = 'confirmed') {
    this.receipt = receipt;
  }

  async send(request: SendRequest): Promise<DeliveryReceipt> {
    this.requests.push(request);
    if (this.receipt === 'confirmed') {
      return { status: 'confirmed', messageId: `sent-${this.requests.length}` };
    }
    return { status: this.receipt };
  }
}

function temporaryDatabase(): { directory: string; filename: string } {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-host-'));
  return { directory, filename: join(directory, 'host.sqlite') };
}

function applicationContext() {
  const context = createContextStore();
  const persona = context.registerPersona({
    id: 'host-test',
    version: '1.0.0',
    name: 'Host Test',
    identity: { role: 'test fixture' },
    style: { tone: 'plain' }
  });
  return { context, persona };
}

function inbound(id: string, conversationId = 'group:100'): InboundMessage {
  return {
    id,
    conversationId,
    userId: '200',
    receivedAt: 1_000,
    content: [{ type: 'text', text: `message ${id}` }],
    directed: true,
    isSelf: false
  };
}

function grantRelay(host: ReturnType<typeof createBridgeHost>, conversationId = 'group:100', maxUses = 10): void {
  host.policy.grant({
    id: `relay-${conversationId}`,
    featureId: 'agent-relay',
    conversationId,
    capabilities: ['agent.submit', 'messaging.send'],
    maxUses: { 'agent.submit': maxUses, 'messaging.send': maxUses }
  });
}

async function drainTasks(host: ReturnType<typeof createBridgeHost>): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await host.tasks.runDue({ limit: 100 });
    await nextTurn();
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(message);
}

test('trusted ingress still requires host authorization and explicit relay grants', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  const agent = new FakeAgent(['session-one']);
  const transport = new FakeTransport();
  const application = applicationContext();
  let allowed = false;
  const host = createBridgeHost({
    store,
    agent,
    transport,
    ...application,
    authorizeIncoming: () => allowed,
    taskTickMs: 60_000
  });
  context.after(async () => {
    await host.stop();
    store.close();
  });
  await host.start();

  assert.deepEqual(await host.receive(inbound('denied-by-ingress')), {
    status: 'rejected',
    eventId: 'denied-by-ingress',
    errorCode: 'INBOUND_DENIED'
  });
  assert.equal(agent.createRequests.length, 0);
  assert.equal(agent.followRequests.length, 0);
  assert.equal(agent.submitRequests.length, 0);
  assert.equal(host.history.snapshot('group:100').messages.length, 0);

  allowed = true;
  assert.deepEqual(await host.receive(inbound('denied-by-policy')), {
    status: 'rejected',
    eventId: 'denied-by-policy',
    errorCode: 'POLICY_DENIED'
  });
  assert.equal(agent.createRequests.length, 0);
  assert.equal(agent.submitRequests.length, 0);

  grantRelay(host);
  assert.deepEqual(await host.receive(inbound('accepted-inbound')), {
    status: 'accepted',
    eventId: 'accepted-inbound'
  });
  assert.equal(agent.createRequests.length, 1);
  assert.equal(agent.followRequests.length, 1);
  assert.equal(agent.submitRequests.length, 1);
  assert.equal(agent.submitRequests[0]?.sessionId, 'session-one');

  assert.equal((await host.receive(inbound('accepted-inbound'))).status, 'accepted');
  assert.equal(agent.submitRequests.length, 1);

  const messageEvent = {
    id: 'assistant-one',
    type: 'message' as const,
    content: [{ type: 'text' as const, text: 'agent response' }]
  };
  await agent.emit('session-one', messageEvent);
  await drainTasks(host);
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(transport.requests[0]?.content, messageEvent.content);

  await agent.emit('session-one', messageEvent);
  await drainTasks(host);
  assert.equal(transport.requests.length, 1);
});

test('burst agent messages preserve durable outbound order while the first delivery is blocked', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  const agent = new FakeAgent(['burst-session']);
  const firstDelivery = deferred<DeliveryReceipt>();
  const requests: SendRequest[] = [];
  const transport: TransportAdapter = {
    async send(request) {
      requests.push(request);
      if (requests.length === 1) return firstDelivery.promise;
      return { status: 'confirmed', messageId: `burst-sent-${requests.length}` };
    }
  };
  const host = createBridgeHost({
    store,
    agent,
    transport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    taskTickMs: 60_000
  });
  context.after(async () => {
    firstDelivery.resolve({ status: 'confirmed', messageId: 'burst-sent-1' });
    await host.stop();
    store.close();
  });
  grantRelay(host, 'group:100', 25);
  await host.start();
  assert.equal((await host.receive(inbound('burst-inbound'))).status, 'accepted');

  const events = Array.from({ length: 20 }, (_, index) => ({
    id: `burst-event-${index}`,
    type: 'message' as const,
    content: [{ type: 'text' as const, text: `burst response ${index}` }]
  }));
  await agent.emit('burst-session', events[0]!);
  await waitFor(() => requests.length === 1, 'The first burst delivery did not enter transport.');
  await Promise.all(events.slice(1).map(event => agent.emit('burst-session', event)));

  const queued = host.tasks.list({ limit: 100 }).filter(task => task.kind === 'bridge.agent-event');
  assert.equal(queued.length, 20);
  assert.equal(queued.filter(task => task.status === 'running').length, 1);
  assert.equal(queued.filter(task => task.status === 'waiting').length, 19);

  firstDelivery.resolve({ status: 'confirmed', messageId: 'burst-sent-1' });
  for (let attempt = 0; attempt < 8 && requests.length < events.length; attempt += 1) {
    await host.tasks.runDue({ limit: 100 });
    await nextTurn();
  }
  assert.equal(requests.length, events.length);
  assert.equal(host.outbox.list({ limit: 100 }).filter(entry => entry.status === 'confirmed').length, events.length);
  assert.equal(host.tasks.list({ limit: 100 })
    .filter(task => task.kind === 'bridge.agent-event' && task.status === 'completed').length, events.length);
  assert.deepEqual(requests.map(request => {
    const block = request.content[0];
    assert.equal(block?.type, 'text');
    return block.text;
  }), events.map(event => event.content[0].text));
});

test('reopen restores session follow and budgets while retired generations cannot emit', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const firstStore = createSqliteStore({ filename: temporary.filename });
  const firstAgent = new FakeAgent(['session-one']);
  const firstTransport = new FakeTransport();
  const firstHost = createBridgeHost({
    store: firstStore,
    agent: firstAgent,
    transport: firstTransport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    taskTickMs: 60_000
  });
  grantRelay(firstHost, 'group:100', 4);
  await firstHost.start();
  assert.equal((await firstHost.receive(inbound('before-restart'))).status, 'accepted');
  await firstAgent.emit('session-one', {
    id: 'before-restart-response',
    type: 'message',
    content: [{ type: 'text', text: 'persisted response' }]
  });
  await drainTasks(firstHost);
  assert.equal(firstTransport.requests.length, 1);
  await firstHost.stop();
  firstStore.close();

  const reopenedStore = createSqliteStore({ filename: temporary.filename });
  const reopenedAgent = new FakeAgent(['session-two']);
  const reopenedTransport = new FakeTransport();
  const reopenedHost = createBridgeHost({
    store: reopenedStore,
    agent: reopenedAgent,
    transport: reopenedTransport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    taskTickMs: 60_000
  });
  context.after(async () => {
    await reopenedHost.stop();
    reopenedStore.close();
  });
  await reopenedHost.start();

  assert.equal(reopenedAgent.createRequests.length, 0);
  assert.deepEqual(reopenedAgent.followRequests.map(request => request.sessionId), ['session-one']);
  const persistedGrant = reopenedHost.policy.describe().grants[0];
  assert(persistedGrant);
  assert.deepEqual(persistedGrant.used, { 'agent.submit': 1, 'messaging.send': 1 });

  assert.equal((await reopenedHost.receive(inbound('after-restart'))).status, 'accepted');
  assert.equal(reopenedAgent.createRequests.length, 0);
  assert.equal(reopenedAgent.submitRequests[0]?.sessionId, 'session-one');

  const retired = reopenedHost.sessions.retire('group:100');
  assert.equal(retired.state, 'retired');
  assert.equal(retired.generation, 2);
  assert.equal((await reopenedHost.receive(inbound('after-retire'))).status, 'accepted');
  assert.equal(reopenedAgent.createRequests.length, 1);
  assert.deepEqual(reopenedHost.sessions.get('group:100'), {
    conversationId: 'group:100',
    sessionId: 'session-two',
    generation: 2
  });

  await reopenedAgent.emit('session-one', {
    id: 'late-old-generation',
    type: 'message',
    content: [{ type: 'text', text: 'must not send' }]
  });
  await drainTasks(reopenedHost);
  assert.equal(reopenedTransport.requests.length, 0);
});

test('unknown delivery remains unresolved across task scans and restart', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const firstStore = createSqliteStore({ filename: temporary.filename });
  const firstAgent = new FakeAgent(['unknown-session']);
  const firstTransport = new FakeTransport('unknown');
  const firstHost = createBridgeHost({
    store: firstStore,
    agent: firstAgent,
    transport: firstTransport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    taskTickMs: 60_000
  });
  grantRelay(firstHost);
  await firstHost.start();
  assert.equal((await firstHost.receive(inbound('unknown-inbound'))).status, 'accepted');
  await firstAgent.emit('unknown-session', {
    id: 'unknown-response',
    type: 'message',
    content: [{ type: 'text', text: 'uncertain delivery' }]
  });
  await drainTasks(firstHost);

  assert.equal(firstTransport.requests.length, 1);
  assert.equal(firstHost.outbox.list()[0]?.status, 'unknown');
  assert.equal(firstHost.tasks.list().find(task => task.kind === 'bridge.agent-event')?.status, 'unknown');
  await drainTasks(firstHost);
  assert.equal(firstTransport.requests.length, 1);
  await firstHost.stop();
  firstStore.close();

  const reopenedStore = createSqliteStore({ filename: temporary.filename });
  const reopenedAgent = new FakeAgent([]);
  const reopenedTransport = new FakeTransport();
  const reopenedHost = createBridgeHost({
    store: reopenedStore,
    agent: reopenedAgent,
    transport: reopenedTransport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    taskTickMs: 60_000
  });
  context.after(async () => {
    await reopenedHost.stop();
    reopenedStore.close();
  });
  await reopenedHost.start();
  await drainTasks(reopenedHost);
  assert.equal(reopenedTransport.requests.length, 0);
  assert.equal(reopenedHost.outbox.list()[0]?.status, 'unknown');
});

test('question and approval events are recorded without implicit approval side effects', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  const agent = new FakeAgent(['interactive-session']);
  const transport = new FakeTransport();
  const host = createBridgeHost({
    store,
    agent,
    transport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    taskTickMs: 60_000
  });
  context.after(async () => {
    await host.stop();
    store.close();
  });
  grantRelay(host);
  await host.start();
  assert.equal((await host.receive(inbound('interactive-inbound'))).status, 'accepted');

  await agent.emit('interactive-session', {
    id: 'question-one',
    type: 'question',
    data: { questions: ['continue?'] }
  });
  await agent.emit('interactive-session', {
    id: 'approval-one',
    type: 'approval',
    data: { toolName: 'dangerous-tool', callId: 'call-one' }
  });
  await drainTasks(host);

  assert.equal(agent.createRequests.length, 1);
  assert.equal(agent.submitRequests.length, 1);
  assert.equal(agent.followRequests.length, 1);
  assert.equal(agent.cancelRequests.length, 0);
  assert.equal(transport.requests.length, 0);
  assert.deepEqual(host.tasks.list()
    .filter(task => task.kind === 'bridge.agent-event')
    .map(task => task.status), ['completed', 'completed']);
});

test('concurrent duplicate ingress shares one relay execution', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  const acceptance = deferred<SubmitResult>();
  const agent = new FakeAgent(['concurrent-session'], { submit: () => acceptance.promise });
  const transport = new FakeTransport();
  const host = createBridgeHost({
    store,
    agent,
    transport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    taskTickMs: 60_000
  });
  context.after(async () => {
    acceptance.resolve({ status: 'accepted' });
    await host.stop();
    store.close();
  });
  grantRelay(host);
  await host.start();

  const message = inbound('concurrent-duplicate');
  const first = host.receive(message);
  const second = host.receive(message);
  await waitFor(() => agent.submitRequests.length === 1, 'Concurrent ingress did not reach one submit.');
  assert.equal(agent.createRequests.length, 1);
  assert.equal(agent.followRequests.length, 1);
  assert.equal(agent.submitRequests.length, 1);

  acceptance.resolve({ status: 'accepted' });
  assert.deepEqual(await Promise.all([first, second]), [
    { status: 'accepted', eventId: 'concurrent-duplicate' },
    { status: 'accepted', eventId: 'concurrent-duplicate' }
  ]);
  assert.equal(agent.createRequests.length, 1);
  assert.equal(agent.followRequests.length, 1);
  assert.equal(agent.submitRequests.length, 1);
});

test('failed follow setup retries against the existing durable session', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  const agent = new FakeAgent(['follow-session'], {
    followSetup(_request, attempt) {
      if (attempt === 1) throw new Error('temporary follow setup failure');
    }
  });
  const host = createBridgeHost({
    store,
    agent,
    transport: new FakeTransport(),
    ...applicationContext(),
    authorizeIncoming: () => true,
    taskTickMs: 60_000
  });
  context.after(async () => {
    await host.stop();
    store.close();
  });
  grantRelay(host);
  await host.start();

  const first = await host.receive(inbound('follow-fails-once'));
  assert.equal(first.status, 'unknown');
  assert.equal(agent.createRequests.length, 1);
  assert.equal(agent.followRequests.length, 1);
  assert.equal(agent.submitRequests.length, 0);
  assert.equal(host.sessions.get('group:100')?.sessionId, 'follow-session');

  assert.equal((await host.receive(inbound('follow-retries'))).status, 'accepted');
  assert.equal(agent.createRequests.length, 1);
  assert.equal(agent.followRequests.length, 2);
  assert.equal(agent.submitRequests.length, 1);
  assert.deepEqual(agent.followRequests.map(request => request.sessionId), ['follow-session', 'follow-session']);
});

test('stop racing start and submit completion cannot create later outbound work', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const store = createSqliteStore({ filename: temporary.filename });
  const acceptance = deferred<SubmitResult>();
  const agent = new FakeAgent(['stopping-session'], { submit: () => acceptance.promise });
  const transport = new FakeTransport();
  const host = createBridgeHost({
    store,
    agent,
    transport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    taskTickMs: 60_000
  });
  context.after(async () => {
    acceptance.resolve({ status: 'accepted' });
    await host.stop();
    store.close();
  });
  grantRelay(host);

  const starting = host.start();
  const receiving = host.receive(inbound('stop-submit-race'));
  await waitFor(() => agent.submitRequests.length === 1, 'Submit did not enter the controlled race.');
  const stopping = host.stop();
  await agent.emit('stopping-session', {
    id: 'during-stop',
    type: 'message',
    content: [{ type: 'text', text: 'must not leave after stop' }]
  });
  acceptance.resolve({ status: 'accepted' });
  await Promise.allSettled([starting, receiving, stopping]);

  await agent.emit('stopping-session', {
    id: 'after-stop',
    type: 'message',
    content: [{ type: 'text', text: 'must remain ignored' }]
  });
  await nextTurn();
  assert.equal(transport.requests.length, 0);
  assert.equal(host.tasks.list().filter(task => task.kind === 'bridge.agent-event').length, 0);
  assert.equal(host.metrics().stopped, true);
});

test('restart marks an interrupted agent event unknown without replaying it', async (context) => {
  const temporary = temporaryDatabase();
  context.after(() => rmSync(temporary.directory, { recursive: true, force: true }));
  const pendingDelivery = deferred<DeliveryReceipt>();
  const firstStore = createSqliteStore({ filename: temporary.filename });
  const firstAgent = new FakeAgent(['interrupted-session']);
  const firstRequests: SendRequest[] = [];
  const firstTransport: TransportAdapter = {
    async send(request) {
      firstRequests.push(request);
      return pendingDelivery.promise;
    }
  };
  const firstHost = createBridgeHost({
    store: firstStore,
    agent: firstAgent,
    transport: firstTransport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    taskTickMs: 60_000
  });
  let reopenedHost: ReturnType<typeof createBridgeHost> | null = null;
  let reopenedStore: ReturnType<typeof createSqliteStore> | null = null;
  context.after(async () => {
    pendingDelivery.resolve({ status: 'unknown' });
    await Promise.allSettled([firstHost.stop(), ...(reopenedHost ? [reopenedHost.stop()] : [])]);
    firstStore.close();
    reopenedStore?.close();
  });
  grantRelay(firstHost);
  await firstHost.start();
  assert.equal((await firstHost.receive(inbound('interrupted-inbound'))).status, 'accepted');
  await firstAgent.emit('interrupted-session', {
    id: 'interrupted-event',
    type: 'message',
    content: [{ type: 'text', text: 'in flight at restart' }]
  });
  await waitFor(() => firstRequests.length === 1, 'Interrupted delivery did not enter transport.');
  assert.equal(firstHost.tasks.list().find(task => task.kind === 'bridge.agent-event')?.status, 'running');

  reopenedStore = createSqliteStore({ filename: temporary.filename });
  const reopenedTransport = new FakeTransport();
  reopenedHost = createBridgeHost({
    store: reopenedStore,
    agent: new FakeAgent([]),
    transport: reopenedTransport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    taskTickMs: 60_000
  });
  await reopenedHost.start();
  await drainTasks(reopenedHost);

  assert.equal(reopenedHost.tasks.list().find(task => task.kind === 'bridge.agent-event')?.status, 'unknown');
  assert.equal(reopenedHost.outbox.list()[0]?.status, 'unknown');
  assert.equal(reopenedTransport.requests.length, 0);
  pendingDelivery.resolve({ status: 'confirmed', messageId: 'late-confirmation' });
  await firstHost.stop();
  await drainTasks(reopenedHost);
  assert.equal(reopenedTransport.requests.length, 0);
  assert.equal(reopenedHost.tasks.list().find(task => task.kind === 'bridge.agent-event')?.status, 'unknown');
});
