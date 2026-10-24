import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { createOneBotTransport, type OneBotAssetResolutionRequest } from '../src/adapters/onebot.ts';
import { normalizeContent } from '../src/core/content.ts';
import { createContextStore } from '../src/core/context.ts';
import type { FrameworkEvent, JsonValue } from '../src/core/types.ts';
import { FrameworkError, isRecord } from '../src/core/values.ts';
import { createBridgeHost, type BridgeHostOptions } from '../src/host/bridge.ts';
import {
  createPresentationEffect,
  createPresentationService,
  type RenderedImageRequest
} from '../src/host/presentation.ts';
import type { AgentAdapter, AgentEvent, InboundMessage } from '../src/host/types.ts';
import type { MarkdownRenderRequest, MarkdownRenderer } from '../src/rendering/index.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

const conversationId = 'group:9001';
const featureId = 'presentation-test';
const personaId = 'presentation-persona';
const personaVersion = '2.3.4';
const personaKey = `${personaId}@${personaVersion}`;

interface HttpCall {
  url: string;
  body: Record<string, unknown>;
}

interface FixtureOptions {
  staticPersona?: string;
  agent?: AgentAdapter;
  agentMessagePreparation?: BridgeHostOptions['agentMessagePreparation'];
}

const agent: AgentAdapter = {
  async createSession() { return { sessionId: 'presentation-unused-session' }; },
  async submit() { return { status: 'accepted' }; },
  async follow() { return () => undefined; }
};

type FollowRequest = Parameters<AgentAdapter['follow']>[0];

class RelayAgent implements AgentAdapter {
  readonly submitRequests: Array<Parameters<AgentAdapter['submit']>[0]> = [];
  private readonly sessionId: string;
  private listener: FollowRequest['onEvent'] | undefined;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async createSession(): Promise<{ sessionId: string }> {
    return { sessionId: this.sessionId };
  }

  async submit(request: Parameters<AgentAdapter['submit']>[0]): Promise<{ status: 'accepted' }> {
    this.submitRequests.push(request);
    return { status: 'accepted' };
  }

  async follow(request: FollowRequest): Promise<() => void> {
    const listener = request.onEvent;
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  async emit(event: Omit<AgentEvent, 'sessionId'>): Promise<void> {
    const listener = this.listener;
    assert(listener, 'Missing presentation relay listener.');
    await listener({ ...event, sessionId: this.sessionId });
  }
}

function response(messageId: string): Response {
  return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: messageId } }), {
    headers: { 'content-type': 'application/json' }
  });
}

function fixture(options: FixtureOptions = {}) {
  const store = createSqliteStore({ filename: ':memory:' });
  const context = createContextStore();
  const persona = context.registerPersona({
    id: personaId,
    version: personaVersion,
    name: 'Presentation Integration Persona',
    identity: { role: 'integration fixture' },
    style: { tone: 'plain' }
  });
  const renderRequests: MarkdownRenderRequest[] = [];
  const publishRequests: RenderedImageRequest[] = [];
  const resolutions: OneBotAssetResolutionRequest[] = [];
  const httpCalls: HttpCall[] = [];
  const renderer: MarkdownRenderer = Object.freeze({
    async render(request: MarkdownRenderRequest) {
      renderRequests.push(request);
      return Object.freeze([
        Object.freeze({ png: new Uint8Array([137, 80, 78, 71, 1]), width: 640, height: 480 })
      ]);
    }
  });
  const transport = createOneBotTransport({
    endpoint: 'http://onebot.invalid/api',
    ...(options.staticPersona === undefined ? {} : { persona: options.staticPersona }),
    forward: { senderId: '10001', senderName: '鲸鲸', group: true },
    resolveAsset(request) {
      resolutions.push(request);
      return { file: `base64://${request.assetId}` };
    },
    async fetch(input, init = {}) {
      httpCalls.push({
        url: String(input),
        body: JSON.parse(String(init.body)) as Record<string, unknown>
      });
      return response(String(7_000 + httpCalls.length));
    }
  });
  const service = createPresentationService({
    capabilities: transport.capabilities!(),
    renderer,
    async publishImage(request) {
      publishRequests.push(request);
      return `rendered-image-${publishRequests.length}`;
    }
  });
  const host = createBridgeHost({
    store,
    agent: options.agent ?? agent,
    transport,
    context,
    persona,
    authorizeIncoming: () => true,
    replyTimeoutNotice: null,
    taskTickMs: 60_000,
    eventValidators: {
      'presentation.requested': data => typeof data.body === 'string' && data.body.length > 0
        && ['markdown-image', 'forward'].includes(String(data.format))
    },
    effectAdapters: {
      'presentation.prepare': createPresentationEffect(service)
    },
    ...(options.agentMessagePreparation === undefined ? {} : {
      agentMessagePreparation: options.agentMessagePreparation
    })
  });
  host.engine.install({
    id: featureId,
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['presentation.prepare', 'messaging.send', 'messaging.forward'],
    subscriptions: ['presentation.requested'],
    setup(services) {
      services.on('presentation.requested', async (execution, event) => {
        const prepared = await execution.invoke('presentation.prepare', event.data);
        const value = prepared as { content?: JsonValue };
        const receipt = await execution.send(normalizeContent(value.content));
        if (receipt.status !== 'confirmed') {
          throw new FrameworkError(receipt.status === 'rejected' ? 'DELIVERY_REJECTED' : 'DELIVERY_UNKNOWN',
            'Presentation delivery was not confirmed.');
        }
      });
    }
  });
  return {
    host,
    store,
    renderRequests,
    publishRequests,
    resolutions,
    httpCalls,
    async close() {
      await host.stop();
      store.close();
    }
  };
}

function event(id: string, format: 'markdown-image' | 'forward' = 'markdown-image'): FrameworkEvent {
  return {
    id,
    type: 'presentation.requested',
    conversationId,
    data: {
      body: '# 中文报告\n\n| 项目 | 状态 |\n| --- | --- |\n| 集成 | 通过 |',
      title: '演示文档',
      format,
      purpose: 'document',
      fallback: 'none',
      reply: 'auto'
    }
  };
}

function grant(target: ReturnType<typeof fixture>, id: string, capabilities: readonly string[]): void {
  target.host.policy.grant({
    id,
    featureId,
    conversationId,
    capabilities,
    maxUses: Object.fromEntries(capabilities.map(capability => [capability, 1]))
  });
}

function relayGrant(target: ReturnType<typeof fixture>, id: string, capabilities: readonly string[]): void {
  target.host.policy.grant({
    id,
    featureId: 'agent-relay',
    conversationId,
    capabilities,
    maxUses: Object.fromEntries(capabilities.map(capability => [capability, 1]))
  });
}

function inbound(id: string): InboundMessage {
  return {
    id,
    conversationId,
    userId: 'user:presentation',
    receivedAt: 1_000,
    content: [{ type: 'text', text: '请生成文档' }],
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

test('presentation permission is checked before renderer or publisher work starts', async context => {
  const target = fixture();
  context.after(() => target.close());

  const report = await target.host.engine.emit(event('presentation-denied'));

  assert.deepEqual(report.outcomes, [{ featureId, status: 'failed', errorCode: 'POLICY_DENIED' }]);
  assert.equal(target.renderRequests.length, 0);
  assert.equal(target.publishRequests.length, 0);
  assert.equal(target.resolutions.length, 0);
  assert.equal(target.httpCalls.length, 0);
  assert.equal(target.host.outbox.list().length, 0);
});

test('markdown image traverses presentation, policy, outbox and OneBot with versioned scope', async context => {
  const target = fixture();
  context.after(() => target.close());
  grant(target, 'presentation-image-grant', ['presentation.prepare', 'messaging.send']);

  const report = await target.host.engine.emit(event('presentation-image'));

  assert.deepEqual(report.outcomes, [{ featureId, status: 'completed' }]);
  assert.equal(target.renderRequests.length, 1);
  assert.equal(target.renderRequests[0]?.markdown.startsWith('# 中文报告'), true);
  assert.equal(target.renderRequests[0]?.title, '演示文档');
  assert.equal(target.publishRequests.length, 1);
  assert.deepEqual(target.publishRequests[0]?.scope, {
    persona: { id: personaId, version: personaVersion }
  });
  assert.equal(target.publishRequests[0]?.conversationId, conversationId);
  assert.equal(target.publishRequests[0]?.png[0], 137);
  assert.equal(target.resolutions.length, 1);
  assert.equal(target.resolutions[0]?.assetId, 'rendered-image-1');
  assert.equal(target.resolutions[0]?.conversationId, conversationId);
  assert.equal(target.resolutions[0]?.persona, personaKey);
  assert.equal(target.httpCalls.length, 1);
  assert.equal(target.httpCalls[0]?.url, 'http://onebot.invalid/api/send_group_msg');
  assert.deepEqual(target.httpCalls[0]?.body, {
    group_id: 9001,
    message: [{ type: 'image', data: { file: 'base64://rendered-image-1' } }]
  });
  assert.doesNotMatch(JSON.stringify(target.httpCalls[0]?.body), /reply/);
  assert.deepEqual(target.host.outbox.list().map(item => ({ conversationId: item.conversationId, status: item.status })), [
    { conversationId, status: 'confirmed' }
  ]);
  assert.deepEqual(target.host.policy.describe().grants[0]?.used, {
    'presentation.prepare': 1,
    'messaging.send': 1
  });
});

test('forward presentation needs messaging.forward in addition to messaging.send', async context => {
  const target = fixture();
  context.after(() => target.close());
  grant(target, 'presentation-forward-grant', ['presentation.prepare', 'messaging.send']);

  const report = await target.host.engine.emit(event('presentation-forward', 'forward'));

  assert.deepEqual(report.outcomes, [{ featureId, status: 'failed', errorCode: 'POLICY_DENIED' }]);
  assert.equal(target.renderRequests.length, 0);
  assert.equal(target.publishRequests.length, 0);
  assert.equal(target.httpCalls.length, 0);
  assert.equal(target.host.outbox.list().length, 0);
  assert.deepEqual(target.host.policy.describe().grants[0]?.used, {
    'presentation.prepare': 1,
    'messaging.send': 0
  });
});

test('OneBot rejects an incorrect static persona before asset resolution or HTTP', async context => {
  const target = fixture({ staticPersona: 'different-persona@1.0.0' });
  context.after(() => target.close());
  grant(target, 'presentation-persona-grant', ['presentation.prepare', 'messaging.send']);

  const report = await target.host.engine.emit(event('presentation-persona-mismatch'));

  assert.deepEqual(report.outcomes, [{ featureId, status: 'failed', errorCode: 'DELIVERY_REJECTED' }]);
  assert.equal(target.renderRequests.length, 1);
  assert.equal(target.publishRequests.length, 1);
  assert.equal(target.resolutions.length, 0);
  assert.equal(target.httpCalls.length, 0);
  assert.equal(target.host.outbox.list()[0]?.status, 'rejected');
});

test('agent metadata preparation needs relay permission and sends its rendered image through OneBot', async context => {
  const preparedEvents: FrameworkEvent[] = [];
  const presentation = {
    body: '# 智能输出\n\n| 项目 | 状态 |\n| --- | --- |\n| Hook | 已接入 |\n\n```ts\nconst safe = true;\n```',
    title: 'Agent 输出文档',
    format: 'markdown-image',
    purpose: 'document',
    fallback: 'none',
    reply: 'auto'
  } as const;
  const agentMessagePreparation: NonNullable<BridgeHostOptions['agentMessagePreparation']> = {
    capabilities: ['presentation.prepare'],
    async prepare(execution, relayEvent) {
      preparedEvents.push(relayEvent);
      const agentData = relayEvent.data.agentData;
      assert(isRecord(agentData) && isRecord(agentData.presentation), 'Missing agent presentation metadata.');
      const prepared = await execution.invoke('presentation.prepare', agentData.presentation as JsonValue);
      assert(isRecord(prepared), 'Presentation preparation returned invalid data.');
      return normalizeContent(prepared.content);
    }
  };

  const deniedAgent = new RelayAgent('presentation-denied-session');
  const denied = fixture({ agent: deniedAgent, agentMessagePreparation });
  context.after(() => denied.close());
  relayGrant(denied, 'relay-presentation-denied', ['agent.submit', 'messaging.send']);
  assert.equal((await denied.host.receive(inbound('relay-presentation-denied-inbound'))).status, 'accepted');
  await deniedAgent.emit({
    id: 'relay-presentation-denied-output',
    type: 'message',
    content: [{ type: 'text', text: '不得作为回退发送' }],
    data: { presentation }
  });
  await drainTasks(denied.host);

  assert.equal(denied.renderRequests.length, 0);
  assert.equal(denied.publishRequests.length, 0);
  assert.equal(denied.httpCalls.length, 0);
  assert.equal(denied.host.outbox.list().length, 0);
  assert.equal(denied.host.tasks.list()[0]?.errorCode, 'POLICY_DENIED');

  const relayAgent = new RelayAgent('presentation-relay-session');
  const target = fixture({ agent: relayAgent, agentMessagePreparation });
  context.after(() => target.close());
  relayGrant(target, 'relay-presentation-authorized', ['agent.submit', 'presentation.prepare', 'messaging.send']);
  assert.equal((await target.host.receive(inbound('relay-presentation-authorized-inbound'))).status, 'accepted');
  await relayAgent.emit({
    id: 'relay-presentation-authorized-output',
    type: 'message',
    content: [{ type: 'text', text: '原始模型文本不得发送' }],
    data: { presentation, internal: 'hook-only' }
  });
  await drainTasks(target.host);

  assert.equal(preparedEvents.length, 2);
  assert.deepEqual(preparedEvents[1]?.data.agentData, { presentation, internal: 'hook-only' });
  assert.deepEqual(preparedEvents[1]?.data.content, [{ type: 'text', text: '原始模型文本不得发送' }]);
  assert.equal(target.renderRequests.length, 1);
  assert.equal(target.renderRequests[0]?.markdown, presentation.body);
  assert.equal(target.renderRequests[0]?.title, presentation.title);
  assert.equal(target.publishRequests.length, 1);
  assert.deepEqual(target.publishRequests[0]?.scope, {
    persona: { id: personaId, version: personaVersion },
    sessionId: 'presentation-relay-session',
    generation: 1
  });
  assert.equal(target.resolutions.length, 1);
  assert.equal(target.resolutions[0]?.assetId, 'rendered-image-1');
  assert.equal(target.httpCalls.length, 1);
  assert.deepEqual(target.httpCalls[0]?.body, {
    group_id: 9001,
    message: [{ type: 'image', data: { file: 'base64://rendered-image-1' } }]
  });
  assert.doesNotMatch(JSON.stringify(target.httpCalls[0]?.body), /reply|原始模型文本/);
  assert.deepEqual(target.host.outbox.list().map(item => item.status), ['confirmed']);
  assert.deepEqual(target.host.policy.describe().grants[0]?.used, {
    'agent.submit': 1,
    'presentation.prepare': 1,
    'messaging.send': 1
  });
});
