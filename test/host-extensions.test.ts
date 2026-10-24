import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { createContextStore } from '../src/core/context.ts';
import type { AuditRecord, EffectAdapter, EffectRequest, ModelRequest, SendRequest,
  TransportAdapter } from '../src/core/types.ts';
import { createBridgeHost, type BridgeHostOptions } from '../src/host/bridge.ts';
import type { AgentAdapter, AgentEvent } from '../src/host/types.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

type ExtensionOptions = Pick<BridgeHostOptions, 'effectAdapters' | 'eventValidators' | 'model' | 'observer'>;
type EventValidator = NonNullable<BridgeHostOptions['eventValidators']>[string];

const agent: AgentAdapter = {
  async createSession() { return { sessionId: 'extension-session' }; },
  async submit() { return { status: 'accepted' }; },
  async follow() { return () => {}; },
};

function application() {
  const context = createContextStore();
  const persona = context.registerPersona({
    id: 'host-extension-test',
    version: '1.0.0',
    name: 'Host Extension Test',
    identity: { role: 'test fixture' },
    style: { tone: 'plain' },
  });
  return { context, persona };
}

function fixture(options: ExtensionOptions = {}, agentAdapter: AgentAdapter = agent) {
  const store = createSqliteStore({ filename: ':memory:' });
  const sent: SendRequest[] = [];
  const transport: TransportAdapter = {
    send(request) {
      sent.push(request);
      return { status: 'confirmed', messageId: `extension-${sent.length}` };
    },
  };
  const host = createBridgeHost({
    store,
    agent: agentAdapter,
    transport,
    ...application(),
    authorizeIncoming: () => true,
    taskTickMs: 60_000,
    ...options,
  });
  return { host, sent, store };
}

async function drainTasks(host: ReturnType<typeof createBridgeHost>) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await host.tasks.runDue({ limit: 100 });
    await nextTurn();
  }
}

async function rejectsExtension(options: ExtensionOptions) {
  const store = createSqliteStore({ filename: ':memory:' });
  let host: ReturnType<typeof createBridgeHost> | undefined;
  try {
    assert.throws(() => {
      host = createBridgeHost({
        store,
        agent,
        transport: { send() { return { status: 'confirmed', messageId: 'unused' }; } },
        ...application(),
        authorizeIncoming: () => true,
        ...options,
      });
    }, { code: 'INVALID_EXTENSION' });
  } finally {
    if (host) await host.stop();
    store.close();
  }
}

test('bridge host installs trusted custom events and image effects with explicit authorization', async context => {
  const generated: EffectRequest[] = [];
  const inspected: EffectRequest[] = [];
  const modelRequests: ModelRequest[] = [];
  const audit: AuditRecord[] = [];
  const privateMessage = 'private-message-body';
  const { host, sent, store } = fixture({
    eventValidators: {
      'image.requested': data => typeof data.prompt === 'string' && data.prompt.length > 0,
    },
    effectAdapters: {
      'image.generate': { execute(request) {
        generated.push(request);
        return { assetId: 'candidate-image' };
      } },
      'image.inspect': { execute(request) {
        inspected.push(request);
        return { accepted: true };
      } },
    },
    model: { generate(request) {
      modelRequests.push(request);
      return { text: 'approved caption' };
    } },
    observer(entry) { audit.push(entry); },
  });
  context.after(async () => {
    await host.stop();
    store.close();
  });

  host.engine.install({
    id: 'image-expression',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['image.generate', 'image.inspect', 'model.respond', 'messaging.send'],
    subscriptions: ['image.requested'],
    setup(services) {
      services.on('image.requested', async (execution, event) => {
        const candidate = await execution.invoke('image.generate', { prompt: event.data.prompt });
        const review = await execution.invoke('image.inspect', candidate);
        assert(candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
          && typeof candidate.assetId === 'string');
        assert(review !== null && typeof review === 'object' && !Array.isArray(review) && review.accepted === true);
        await execution.generate({ message: event.data.prompt, assetId: candidate.assetId });
        await execution.send([{ type: 'image', assetId: candidate.assetId }]);
      });
    },
  });

  assert.throws(() => host.engine.emit({
    id: 'invalid-image-event',
    type: 'image.requested',
    conversationId: 'group:image',
    data: {},
  }), { code: 'INVALID_EVENT' });

  const denied = await host.engine.emit({
    id: 'denied-image-event',
    type: 'image.requested',
    conversationId: 'group:image',
    data: { prompt: privateMessage },
  });
  assert.equal(denied.outcomes[0]?.errorCode, 'POLICY_DENIED');
  assert.equal(generated.length, 0);
  assert.equal(inspected.length, 0);
  assert.equal(modelRequests.length, 0);
  assert.equal(sent.length, 0);

  host.policy.grant({
    id: 'image-extension-grant',
    featureId: 'image-expression',
    conversationId: 'group:image',
    capabilities: ['image.generate', 'image.inspect', 'model.respond', 'messaging.send'],
    maxUses: { 'image.generate': 1, 'image.inspect': 1, 'model.respond': 1, 'messaging.send': 1 },
  });
  const accepted = await host.engine.emit({
    id: 'accepted-image-event',
    type: 'image.requested',
    conversationId: 'group:image',
    data: { prompt: privateMessage },
  });

  assert.equal(accepted.outcomes[0]?.status, 'completed');
  assert.equal(generated.length, 1);
  assert.equal(inspected.length, 1);
  assert.equal(modelRequests.length, 1);
  assert(Object.isFrozen(generated[0]?.input));
  assert(Object.isFrozen(generated[0]?.scope));
  assert.equal(generated[0]?.scope.conversationId, 'group:image');
  assert.deepEqual(sent[0]?.content, [{ type: 'image', assetId: 'candidate-image' }]);
  assert.deepEqual(host.policy.describe().grants[0]?.used,
    { 'image.generate': 1, 'image.inspect': 1, 'model.respond': 1, 'messaging.send': 1 });
  assert(host.engine.describe().contracts.eventTypes.includes('image.requested'));
  assert(host.engine.describe().contracts.capabilities.includes('image.generate'));
  assert(audit.some(entry => entry.stage === 'model' && entry.status === 'completed'));
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(privateMessage));
});

test('extension injection leaves ordinary relay content unchanged without adding a reply block', async context => {
  let followEvent: ((event: AgentEvent) => void | Promise<void>) | undefined;
  const relayAgent: AgentAdapter = {
    async createSession() { return { sessionId: 'relay-session' }; },
    async submit() { return { status: 'accepted' }; },
    async follow(request) {
      followEvent = request.onEvent;
      return () => {};
    },
  };
  const { host, sent, store } = fixture({}, relayAgent);
  context.after(async () => {
    await host.stop();
    store.close();
  });
  host.policy.grant({
    id: 'relay-content-grant',
    featureId: 'agent-relay',
    conversationId: 'group:relay',
    capabilities: ['agent.submit', 'messaging.send'],
    maxUses: { 'agent.submit': 1, 'messaging.send': 1 },
  });

  assert.equal((await host.receive({
    id: 'incoming-relay',
    conversationId: 'group:relay',
    userId: 'user:one',
    receivedAt: 1_000,
    content: [{ type: 'text', text: 'question' }],
    directed: true,
    isSelf: false,
  })).status, 'accepted');
  assert(followEvent);
  await followEvent({
    id: 'agent-relay-message',
    sessionId: 'relay-session',
    type: 'message',
    content: [{ type: 'text', text: 'plain answer' }],
  });
  await drainTasks(host);

  assert.deepEqual(sent[0]?.content, [{ type: 'text', text: 'plain answer' }]);
  assert.equal(sent[0]?.content.some(block => block.type === 'reply'), false);
});

test('bridge host rejects collisions with agent and core registrations', async () => {
  const adapter: EffectAdapter = { execute() { return null; } };
  const collisions: ExtensionOptions[] = [
    { eventValidators: { 'message.received': () => true } },
    { eventValidators: { 'trigger.fired': () => true } },
    { eventValidators: { 'agent.message': () => true } },
    { eventValidators: { 'agent.custom': () => true } },
    { effectAdapters: { 'messaging.send': adapter } },
    { effectAdapters: { 'model.respond': adapter } },
    { effectAdapters: { 'agent.submit': adapter } },
    { effectAdapters: { 'agent.custom': adapter } },
  ];
  for (const options of collisions) await rejectsExtension(options);
});

test('bridge host delegates malformed extension callback rejection to core validation', async () => {
  await rejectsExtension({ eventValidators: { 'image.requested': (async () => true) as unknown as EventValidator } });
  await rejectsExtension({ effectAdapters: { 'image.generate': {} as EffectAdapter } });
  await rejectsExtension({ eventValidators: [] as unknown as NonNullable<BridgeHostOptions['eventValidators']> });
});
