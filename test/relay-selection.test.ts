import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { createContextStore } from '../src/core/context.ts';
import type { DeliveryReceipt, MessageContent, SendRequest, TransportAdapter } from '../src/core/types.ts';
import { createBridgeHost, type BridgeHostOptions } from '../src/host/bridge.ts';
import type { AgentAdapter, AgentEvent, InboundMessage, SessionBinding } from '../src/host/types.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

type FollowRequest = Parameters<AgentAdapter['follow']>[0];

class RelayAgent implements AgentAdapter {
  readonly submitRequests: Array<Parameters<AgentAdapter['submit']>[0]> = [];
  private listener: FollowRequest['onEvent'] | undefined;

  async createSession(): Promise<{ sessionId: string }> {
    return { sessionId: 'relay-selection-session' };
  }

  async submit(request: Parameters<AgentAdapter['submit']>[0]): Promise<{ status: 'accepted' }> {
    this.submitRequests.push(request);
    return { status: 'accepted' };
  }

  async follow(request: FollowRequest): Promise<() => void> {
    this.listener = request.onEvent;
    return () => { this.listener = undefined; };
  }

  async emit(event: Omit<AgentEvent, 'sessionId'>): Promise<void> {
    assert(this.listener, 'Missing relay selection listener.');
    await this.listener({ ...event, sessionId: 'relay-selection-session' });
  }
}

class RelayTransport implements TransportAdapter {
  readonly requests: SendRequest[] = [];

  async send(request: SendRequest): Promise<DeliveryReceipt> {
    this.requests.push(request);
    return { status: 'confirmed', messageId: `relay-selection-${this.requests.length}` };
  }
}

function inbound(): InboundMessage {
  return {
    id: 'relay-selection-inbound',
    conversationId: 'group:relay-selection',
    userId: 'relay-selection-user',
    receivedAt: 1_000,
    content: [{ type: 'text', text: 'select relay output' }],
    directed: true,
    isSelf: false
  };
}

async function drainTasks(host: ReturnType<typeof createBridgeHost>): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await host.tasks.runDue({ limit: 100 });
    await nextTurn();
  }
}

test('relay selection drops internal output and rewrites public output without consuming unrelated send budget', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'qq-bridge-framework-relay-selection-'));
  const store = createSqliteStore({ filename: join(directory, 'host.sqlite') });
  const agent = new RelayAgent();
  const transport = new RelayTransport();
  const applicationContext = createContextStore();
  const persona = applicationContext.registerPersona({
    id: 'relay-selection-test',
    version: '1.0.0',
    name: 'Relay Selection Test',
    identity: {},
    style: {}
  });
  const selectedEvents: AgentEvent[] = [];
  const selectedBindings: SessionBinding[] = [];
  const selector: NonNullable<BridgeHostOptions['selectAgentMessage']> = (event, binding) => {
    assert(Object.isFrozen(event));
    assert(Object.isFrozen(event.data));
    assert(Object.isFrozen(binding));
    selectedEvents.push(event);
    selectedBindings.push(binding);
    if (event.data?.visibility === 'internal') return null;
    if (event.data?.visibility === 'public') return [{ type: 'text', text: 'selected public output' }];
    return event.content ?? null;
  };
  const host = createBridgeHost({
    store,
    agent,
    transport,
    context: applicationContext,
    persona,
    authorizeIncoming: () => true,
    selectAgentMessage: selector,
    replyTimeoutNotice: null,
    taskTickMs: 60_000
  });
  context.after(async () => {
    await host.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  host.policy.grant({
    id: 'relay-selection-grant',
    featureId: 'agent-relay',
    conversationId: 'group:relay-selection',
    capabilities: ['agent.submit', 'messaging.send'],
    maxUses: { 'agent.submit': 1, 'messaging.send': 1 }
  });
  await host.start();
  assert.equal((await host.receive(inbound())).status, 'accepted');

  const internalContent: readonly MessageContent[] = [{ type: 'text', text: 'internal model output' }];
  await agent.emit({
    id: 'relay-internal',
    type: 'message',
    content: internalContent,
    data: { visibility: 'internal', tool: { name: 'internal-work' } }
  });
  await drainTasks(host);
  assert.equal(transport.requests.length, 0);
  assert.deepEqual(host.policy.describe().grants[0]?.used, { 'agent.submit': 1, 'messaging.send': 0 });

  await agent.emit({
    id: 'relay-public',
    type: 'message',
    content: [{ type: 'text', text: 'unselected public output' }],
    data: { visibility: 'public', tool: { name: 'public-result' } }
  });
  await drainTasks(host);
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(transport.requests[0]?.content, [{ type: 'text', text: 'selected public output' }]);
  assert.deepEqual(host.policy.describe().grants[0]?.used, { 'agent.submit': 1, 'messaging.send': 1 });

  await agent.emit({ id: 'relay-question', type: 'question', data: { questions: ['continue?'] } });
  await agent.emit({ id: 'relay-approval', type: 'approval', data: { toolName: 'restricted-tool' } });
  await drainTasks(host);

  assert.equal(transport.requests.length, 1);
  assert.deepEqual(host.policy.describe().grants[0]?.used, { 'agent.submit': 1, 'messaging.send': 1 });
  assert.deepEqual(selectedEvents.map(event => event.id), ['relay-internal', 'relay-public']);
  assert.deepEqual(selectedEvents.map(event => event.data?.visibility), ['internal', 'public']);
  assert(selectedEvents.every(event => Object.isFrozen(event.content) && Object.isFrozen(event.data)));
  assert(selectedBindings.every(binding => Object.isFrozen(binding)));
  assert.deepEqual(host.tasks.list()
    .filter(task => task.kind === 'bridge.agent-event')
    .map(task => task.status), ['completed', 'completed', 'completed', 'completed']);
});
