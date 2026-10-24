import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';

import { createContextStore } from '../src/core/context.ts';
import type { DeliveryReceipt, SendRequest, TransportAdapter } from '../src/core/types.ts';
import { FrameworkError } from '../src/core/values.ts';
import { createBridgeHost, type BridgeHostOptions } from '../src/host/bridge.ts';
import type { AgentAdapter, AgentEvent, InboundMessage } from '../src/host/types.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

type CreateRequest = Parameters<AgentAdapter['createSession']>[0];
type FollowRequest = Parameters<AgentAdapter['follow']>[0];
type SubmitRequest = Parameters<AgentAdapter['submit']>[0];
type SubmitResult = Awaited<ReturnType<AgentAdapter['submit']>>;

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

interface AgentBehavior {
  createSession?(request: CreateRequest, call: number): Promise<{ sessionId: string }> | { sessionId: string };
  follow?(request: FollowRequest, call: number): Promise<() => void | Promise<void>> | (() => void | Promise<void>);
  submit?(request: SubmitRequest, call: number): Promise<SubmitResult> | SubmitResult;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise!: (value: Value) => void;
  const promise = new Promise<Value>(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

class ControlledAgent implements AgentAdapter {
  readonly createRequests: CreateRequest[] = [];
  readonly followRequests: FollowRequest[] = [];
  readonly submitRequests: SubmitRequest[] = [];
  private readonly listeners = new Map<string, (event: AgentEvent) => void | Promise<void>>();
  private readonly behavior: AgentBehavior;

  constructor(behavior: AgentBehavior = {}) {
    this.behavior = behavior;
  }

  async createSession(request: CreateRequest): Promise<{ sessionId: string }> {
    this.createRequests.push(request);
    return this.behavior.createSession?.(request, this.createRequests.length)
      ?? { sessionId: `session-${request.conversationId}` };
  }

  async follow(request: FollowRequest): Promise<() => void | Promise<void>> {
    this.followRequests.push(request);
    if (this.behavior.follow) return this.behavior.follow(request, this.followRequests.length);
    this.listeners.set(request.sessionId, request.onEvent);
    return () => { this.listeners.delete(request.sessionId); };
  }

  async submit(request: SubmitRequest): Promise<SubmitResult> {
    this.submitRequests.push(request);
    return this.behavior.submit?.(request, this.submitRequests.length) ?? { status: 'accepted' };
  }

  async emit(sessionId: string, event: Omit<AgentEvent, 'sessionId'>): Promise<void> {
    const listener = this.listeners.get(sessionId);
    assert(listener, `Missing follow listener for ${sessionId}.`);
    await listener({ ...event, sessionId });
  }
}

class ConfirmingTransport implements TransportAdapter {
  readonly requests: SendRequest[] = [];

  async send(request: SendRequest): Promise<DeliveryReceipt> {
    this.requests.push(request);
    return { status: 'confirmed', messageId: `confirmed-${this.requests.length}` };
  }
}

function applicationContext() {
  const context = createContextStore();
  const persona = context.registerPersona({
    id: 'host-deadline-test',
    version: '1.0.0',
    name: 'Host Deadline Test',
    identity: {},
    style: {}
  });
  return { context, persona };
}

function inbound(id: string, conversationId = 'group:deadline'): InboundMessage {
  return {
    id,
    conversationId,
    userId: 'deadline-user',
    receivedAt: Date.now(),
    content: [{ type: 'text', text: id }],
    directed: true,
    isSelf: false
  };
}

function grant(host: ReturnType<typeof createBridgeHost>, conversationId: string, maxUses = 5): void {
  host.policy.grant({
    id: `deadline-grant-${conversationId}`,
    featureId: 'agent-relay',
    conversationId,
    capabilities: ['agent.submit', 'messaging.send'],
    maxUses: { 'agent.submit': maxUses, 'messaging.send': maxUses }
  });
}

async function within<Value>(promise: Promise<Value>, label: string, timeoutMs = 1_000): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle.`)), timeoutMs);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(label);
}

function fixture(testContext: TestContext, options: {
  agent: AgentAdapter;
  transport?: TransportAdapter;
  authorizeIncoming?: BridgeHostOptions['authorizeIncoming'];
  timeouts?: BridgeHostOptions['timeouts'];
  eventTimeoutMs?: number;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-host-deadline-'));
  const store = createSqliteStore({ filename: join(directory, 'host.sqlite') });
  const host = createBridgeHost({
    store,
    agent: options.agent,
    transport: options.transport ?? new ConfirmingTransport(),
    ...applicationContext(),
    authorizeIncoming: options.authorizeIncoming ?? (() => true),
    timeouts: options.timeouts,
    eventTimeoutMs: options.eventTimeoutMs ?? 200,
    taskTickMs: 60_000
  });
  testContext.after(async () => {
    await within(host.stop(), 'host cleanup');
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { host, store };
}

test('validates host operation and event deadlines', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-host-deadline-options-'));
  const store = createSqliteStore({ filename: join(directory, 'host.sqlite') });
  const base = {
    store,
    agent: new ControlledAgent(),
    transport: new ConfirmingTransport(),
    ...applicationContext(),
    authorizeIncoming: () => true
  };
  try {
    for (const timeouts of [{ sendMs: 9 }, { authorizeMs: 300_001 }, { unknownMs: 10 }]) {
      assert.throws(() => createBridgeHost({ ...base, timeouts }), (error: unknown) =>
        error instanceof FrameworkError && error.code === 'INVALID_TIMEOUT');
    }
    assert.throws(() => createBridgeHost({ ...base, eventTimeoutMs: 9 }), (error: unknown) =>
      error instanceof FrameworkError && error.code === 'INVALID_ENGINE');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('authorization and session creation timeouts return without side effects or duplicate creation', async testContext => {
  const createGate = deferred<{ sessionId: string }>();
  let authorizationCalls = 0;
  const agent = new ControlledAgent({
    createSession: (_request, call) => call === 1 ? createGate.promise : { sessionId: `unexpected-${call}` }
  });
  const { host } = fixture(testContext, {
    agent,
    authorizeIncoming: () => ++authorizationCalls === 1 ? new Promise<boolean>(() => {}) : true,
    timeouts: { authorizeMs: 20, createSessionMs: 20 }
  });
  grant(host, 'group:create');
  await host.start();

  assert.deepEqual(await within(host.receive(inbound('auth-timeout', 'group:auth')), 'authorization receipt'), {
    status: 'rejected',
    eventId: 'auth-timeout',
    errorCode: 'INBOUND_AUTH_TIMEOUT'
  });
  assert.equal(host.history.snapshot('group:auth').messages.length, 0);
  assert.equal(agent.createRequests.length, 0);

  const createReceipt = await within(host.receive(inbound('create-timeout', 'group:create')), 'create receipt');
  assert.equal(createReceipt.status, 'unknown');
  assert.equal(agent.createRequests.length, 1);
  assert.equal(host.sessions.get('group:create'), null);
  createGate.resolve({ sessionId: 'late-created-session' });
  await nextTurn();
  assert.equal(host.sessions.get('group:create'), null);

  const repeated = await within(host.receive(inbound('after-create-timeout', 'group:create')), 'repeated create receipt');
  assert.notEqual(repeated.status, 'accepted');
  assert.equal(agent.createRequests.length, 1);
  await within(host.stop(), 'stop after authorization and create timeouts');
});

test('late follow setup is disposed and late frames cannot produce outbound work', async testContext => {
  const followGate = deferred<() => void>();
  let disposed = 0;
  const agent = new ControlledAgent({ follow: () => followGate.promise });
  const transport = new ConfirmingTransport();
  const { host } = fixture(testContext, {
    agent,
    transport,
    timeouts: { followMs: 20 }
  });
  grant(host, 'group:follow');
  await host.start();

  const receipt = await within(host.receive(inbound('follow-timeout', 'group:follow')), 'follow receipt');
  assert.equal(receipt.status, 'unknown');
  assert.equal(agent.followRequests.length, 1);
  const lateRequest = agent.followRequests[0];
  assert(lateRequest?.signal.aborted);

  followGate.resolve(() => { disposed += 1; });
  await waitFor(() => disposed === 1, 'Late follow disposer was not called.');
  await lateRequest.onEvent({
    id: 'late-follow-frame',
    sessionId: 'session-group:follow',
    type: 'message',
    content: [{ type: 'text', text: 'must remain ignored' }]
  });
  await nextTurn();
  assert.equal(transport.requests.length, 0);
  assert.equal(host.tasks.list().filter(task => task.kind === 'bridge.agent-event').length, 0);
  await within(host.stop(), 'stop after follow timeout');
});

test('late submit is not retried and another conversation continues', async testContext => {
  const firstSubmit = deferred<SubmitResult>();
  const agent = new ControlledAgent({
    submit: (_request, call) => call === 1 ? firstSubmit.promise : { status: 'accepted' }
  });
  const { host } = fixture(testContext, {
    agent,
    timeouts: { submitMs: 20 }
  });
  for (const conversationId of ['group:slow-submit', 'group:fast-submit']) grant(host, conversationId);
  await host.start();

  const slow = await within(host.receive(inbound('slow-submit', 'group:slow-submit')), 'submit timeout receipt');
  assert.equal(slow.status, 'unknown');
  assert.equal(agent.submitRequests.length, 1);
  const fast = await within(host.receive(inbound('fast-submit', 'group:fast-submit')), 'later conversation receipt');
  assert.equal(fast.status, 'accepted');
  assert.equal(agent.submitRequests.length, 2);

  firstSubmit.resolve({ status: 'accepted' });
  await delay(30);
  assert.equal(agent.submitRequests.length, 2);
  assert.deepEqual(await host.receive(inbound('slow-submit', 'group:slow-submit')), slow);
  assert.equal(agent.submitRequests.length, 2);
  await within(host.stop(), 'stop after submit timeout');
});

test('unknown timed out send is not replayed and another conversation can send', async testContext => {
  const firstSend = deferred<DeliveryReceipt>();
  const requests: SendRequest[] = [];
  const transport: TransportAdapter = {
    async send(request) {
      requests.push(request);
      if (requests.length === 1) return firstSend.promise;
      return { status: 'confirmed', messageId: `confirmed-${requests.length}` };
    }
  };
  const agent = new ControlledAgent();
  const { host } = fixture(testContext, {
    agent,
    transport,
    timeouts: { sendMs: 20 }
  });
  for (const conversationId of ['group:slow-send', 'group:fast-send']) grant(host, conversationId);
  await host.start();
  assert.equal((await host.receive(inbound('prepare-slow-send', 'group:slow-send'))).status, 'accepted');
  assert.equal((await host.receive(inbound('prepare-fast-send', 'group:fast-send'))).status, 'accepted');

  await agent.emit('session-group:slow-send', {
    id: 'slow-agent-message',
    type: 'message',
    content: [{ type: 'text', text: 'slow outbound' }]
  });
  await waitFor(() => host.outbox.list().some(entry => entry.conversationId === 'group:slow-send' && entry.status === 'unknown'),
    'Timed out send did not become unknown.');
  assert.equal(requests.length, 1);
  assert(requests[0]?.signal.aborted);

  await agent.emit('session-group:fast-send', {
    id: 'fast-agent-message',
    type: 'message',
    content: [{ type: 'text', text: 'fast outbound' }]
  });
  await waitFor(() => host.outbox.list().some(entry => entry.conversationId === 'group:fast-send' && entry.status === 'confirmed'),
    'Later conversation did not confirm its send.');
  assert.equal(requests.length, 2);

  firstSend.resolve({ status: 'confirmed', messageId: 'late-confirmation' });
  await delay(30);
  assert.equal(requests.length, 2);
  assert.equal(host.outbox.list().find(entry => entry.conversationId === 'group:slow-send')?.status, 'unknown');
  await within(host.stop(), 'stop after send timeout');
});

test('start deadline bounds a restoring follow and disposes its late setup', async testContext => {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-host-start-deadline-'));
  const filename = join(directory, 'host.sqlite');
  const firstStore = createSqliteStore({ filename });
  const firstHost = createBridgeHost({
    store: firstStore,
    agent: new ControlledAgent(),
    transport: new ConfirmingTransport(),
    ...applicationContext(),
    authorizeIncoming: () => true
  });
  firstHost.sessions.bind('group:restore', 'restore-session');
  await firstHost.stop();
  firstStore.close();

  const followGate = deferred<() => void>();
  let disposed = 0;
  const agent = new ControlledAgent({ follow: () => followGate.promise });
  const reopenedStore = createSqliteStore({ filename });
  const transport = new ConfirmingTransport();
  const host = createBridgeHost({
    store: reopenedStore,
    agent,
    transport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    timeouts: { startMs: 30, followMs: 300_000 },
    eventTimeoutMs: 200,
    taskTickMs: 60_000
  });
  testContext.after(async () => {
    await within(host.stop(), 'restored host cleanup');
    reopenedStore.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await within(host.start(), 'host start deadline');
  assert.equal(agent.followRequests.length, 1);
  assert(agent.followRequests[0]?.signal.aborted);
  assert.equal(host.metrics().startupState, 'degraded');
  assert(host.metrics().timeouts >= 1);

  followGate.resolve(() => { disposed += 1; });
  await waitFor(() => disposed === 1, 'Late restoring follow disposer was not called.');
  await agent.followRequests[0]!.onEvent({
    id: 'late-restored-frame',
    sessionId: 'restore-session',
    type: 'message',
    content: [{ type: 'text', text: 'must remain ignored' }]
  });
  await nextTurn();
  assert.equal(transport.requests.length, 0);
  await within(host.stop(), 'stop after bounded start');
});
