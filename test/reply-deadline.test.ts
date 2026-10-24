import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createContextStore } from '../src/core/context.ts';
import type { DeliveryReceipt, SendRequest, TransportAdapter } from '../src/core/types.ts';
import { createBridgeHost } from '../src/host/bridge.ts';
import type { AgentAdapter, AgentEvent, InboundMessage } from '../src/host/types.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

type FollowRequest = Parameters<AgentAdapter['follow']>[0];

class ReplyAgent implements AgentAdapter {
  readonly followRequests: FollowRequest[] = [];
  readonly submitRequests: Array<Parameters<AgentAdapter['submit']>[0]> = [];
  private readonly listeners = new Map<string, (event: AgentEvent) => void | Promise<void>>();
  private sessions = 0;

  async createSession(): Promise<{ sessionId: string }> {
    this.sessions += 1;
    return { sessionId: `reply-session-${this.sessions}` };
  }

  async submit(request: Parameters<AgentAdapter['submit']>[0]): Promise<{ status: 'accepted' }> {
    this.submitRequests.push(request);
    return { status: 'accepted' };
  }

  async follow(request: FollowRequest): Promise<() => void> {
    this.followRequests.push(request);
    this.listeners.set(request.sessionId, request.onEvent);
    return () => { this.listeners.delete(request.sessionId); };
  }

  async emit(sessionId: string, event: Omit<AgentEvent, 'sessionId'>): Promise<void> {
    const listener = this.listeners.get(sessionId);
    assert(listener, `Missing reply listener for ${sessionId}.`);
    await listener({ ...event, sessionId });
  }
}

class ReplyTransport implements TransportAdapter {
  readonly requests: SendRequest[] = [];

  async send(request: SendRequest): Promise<DeliveryReceipt> {
    this.requests.push(request);
    return { status: 'confirmed', messageId: `reply-send-${this.requests.length}` };
  }
}

function applicationContext() {
  const context = createContextStore();
  const persona = context.registerPersona({
    id: 'reply-deadline-test',
    version: '1.0.0',
    name: 'Reply Deadline Test',
    identity: {},
    style: {}
  });
  return { context, persona };
}

function inbound(id: string, conversationId = 'group:reply'): InboundMessage {
  return {
    id,
    conversationId,
    userId: 'reply-user',
    receivedAt: Date.now(),
    content: [{ type: 'text', text: id }],
    directed: true,
    isSelf: false
  };
}

function grant(host: ReturnType<typeof createBridgeHost>, conversationId = 'group:reply', maxUses = 10): void {
  host.policy.grant({
    id: `reply-grant-${conversationId}`,
    featureId: 'agent-relay',
    conversationId,
    capabilities: ['agent.submit', 'messaging.send'],
    maxUses: { 'agent.submit': maxUses, 'messaging.send': maxUses }
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(label);
}

function fixture(testContext: TestContext, options: {
  replyTimeoutMs: number;
  replyTimeoutNotice?: string | null;
  onFault?(code: string): void;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-reply-deadline-'));
  const store = createSqliteStore({ filename: join(directory, 'host.sqlite') });
  const agent = new ReplyAgent();
  const transport = new ReplyTransport();
  const host = createBridgeHost({
    store,
    agent,
    transport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    replyTimeoutMs: options.replyTimeoutMs,
    replyTimeoutNotice: options.replyTimeoutNotice,
    onFault: options.onFault,
    eventTimeoutMs: 500,
    taskTickMs: 60_000
  });
  testContext.after(async () => {
    await host.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { host, agent, transport, store };
}

test('accepted prompt without an agent message sends one neutral timeout notice', async testContext => {
  const faults: string[] = [];
  const notice = 'Request accepted; no reply has been confirmed yet.';
  const { host, agent, transport } = fixture(testContext, {
    replyTimeoutMs: 50,
    replyTimeoutNotice: notice,
    onFault: code => faults.push(code)
  });
  grant(host);
  await host.start();

  assert.deepEqual(await host.receive(inbound('no-agent-message')), {
    status: 'accepted',
    eventId: 'no-agent-message'
  });
  assert.equal(agent.submitRequests.length, 1);
  assert.equal(transport.requests.length, 0);
  await waitFor(() => transport.requests.length === 1, 'Reply timeout notice was not sent.');
  assert.deepEqual(transport.requests[0]?.content, [{ type: 'text', text: notice }]);
  assert.equal(host.metrics().replies.expired, 1);
  assert(faults.includes('AGENT_REPLY_TIMEOUT'));
  await delay(80);
  assert.equal(transport.requests.length, 1);

  await agent.emit('reply-session-1', {
    id: 'late-agent-message',
    type: 'message',
    content: [{ type: 'text', text: 'late but still delivered' }]
  });
  await waitFor(() => transport.requests.length === 2, 'Late confirmed reply was not delivered normally.');
  assert.equal(host.replies.list()[0]?.status, 'responded-late');
});

test('first confirmed assistant message clears the reply watchdog', async testContext => {
  const notice = 'Must not be sent after a confirmed reply.';
  const { host, agent, transport } = fixture(testContext, {
    replyTimeoutMs: 1000,
    replyTimeoutNotice: notice
  });
  grant(host);
  await host.start();
  assert.equal((await host.receive(inbound('normal-reply'))).status, 'accepted');

  await agent.emit('reply-session-1', {
    id: 'normal-agent-message',
    type: 'message',
    content: [{ type: 'text', text: 'confirmed assistant reply' }]
  });
  await waitFor(() => transport.requests.length === 1, 'Confirmed assistant reply was not sent.');
  assert.deepEqual(transport.requests[0]?.content, [{ type: 'text', text: 'confirmed assistant reply' }]);
  await waitFor(() => host.replies.list()[0]?.status === 'responded', 'Confirmed reply was not recorded by the watchdog.');
  await delay(90);
  assert.equal(transport.requests.length, 1);
  assert.equal(host.metrics().replies.expired, 0);
  assert.equal(host.metrics().replies.pending, 0);
});

test('additional accepted prompts do not extend the original reply deadline', async testContext => {
  const notice = 'Original reply deadline reached.';
  const { host, agent, transport, store } = fixture(testContext, {
    replyTimeoutMs: 200,
    replyTimeoutNotice: notice
  });
  grant(host);
  await host.start();
  assert.equal((await host.receive(inbound('first-prompt'))).status, 'accepted');
  const before = store.list('host.replies', { limit: 1 })[0];
  assert(before);
  await delay(40);
  assert.equal((await host.receive(inbound('second-prompt'))).status, 'accepted');
  assert.equal(agent.submitRequests.length, 2);
  const after = store.list('host.replies', { limit: 1 })[0];
  assert(after);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.value, before.value);

  await waitFor(() => transport.requests.length === 1, 'Original reply deadline was not retained.');
  assert.deepEqual(transport.requests[0]?.content, [{ type: 'text', text: notice }]);
  await delay(80);
  assert.equal(transport.requests.length, 1);
});

test('restart restores a waiting watchdog and does not repeat a persisted timeout', async testContext => {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-reply-restart-'));
  const filename = join(directory, 'host.sqlite');
  const notice = 'Restored reply deadline reached.';
  const firstStore = createSqliteStore({ filename });
  const firstHost = createBridgeHost({
    store: firstStore,
    agent: new ReplyAgent(),
    transport: new ReplyTransport(),
    ...applicationContext(),
    authorizeIncoming: () => true,
    replyTimeoutMs: 150,
    replyTimeoutNotice: notice,
    eventTimeoutMs: 500,
    taskTickMs: 60_000
  });
  grant(firstHost);
  await firstHost.start();
  assert.equal((await firstHost.receive(inbound('before-restart'))).status, 'accepted');
  await delay(25);
  await firstHost.stop();
  firstStore.close();

  const secondStore = createSqliteStore({ filename });
  const secondTransport = new ReplyTransport();
  const secondHost = createBridgeHost({
    store: secondStore,
    agent: new ReplyAgent(),
    transport: secondTransport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    replyTimeoutMs: 150,
    replyTimeoutNotice: notice,
    eventTimeoutMs: 500,
    taskTickMs: 60_000
  });
  await secondHost.start();
  await waitFor(() => secondTransport.requests.length === 1, 'Restored watchdog did not send its notice.');
  assert.deepEqual(secondTransport.requests[0]?.content, [{ type: 'text', text: notice }]);
  await secondHost.stop();
  secondStore.close();

  const thirdStore = createSqliteStore({ filename });
  const thirdTransport = new ReplyTransport();
  const thirdHost = createBridgeHost({
    store: thirdStore,
    agent: new ReplyAgent(),
    transport: thirdTransport,
    ...applicationContext(),
    authorizeIncoming: () => true,
    replyTimeoutMs: 50,
    replyTimeoutNotice: notice,
    eventTimeoutMs: 500,
    taskTickMs: 60_000
  });
  testContext.after(async () => {
    await thirdHost.stop();
    thirdStore.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await thirdHost.start();
  await delay(90);
  assert.equal(thirdTransport.requests.length, 0);
  assert.equal(thirdHost.metrics().replies.expired, 0);
});
