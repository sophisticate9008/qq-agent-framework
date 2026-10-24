import test from 'node:test';
import assert from 'node:assert/strict';

import { createContextStore } from '../src/core/context.ts';
import { createEngine } from '../src/core/engine.ts';
import { createPolicy } from '../src/core/policy.ts';
import type { FeatureDefinition, SendRequest, TransportAdapter } from '../src/core/types.ts';
import { createMessageRouter, createRoutedMessageEvent, routedMessageRelaysToAgent, withMessageRoute,
  type MessageRouteRule } from '../src/host/routing.ts';
import type { InboundMessage } from '../src/host/types.ts';

function inbound(id: string, text: string): InboundMessage {
  return { id, conversationId: 'group:100', userId: 'user:200', receivedAt: 1_000,
    content: [{ type: 'text', text }], directed: true, isSelf: false };
}

function responder(id: string): FeatureDefinition {
  return { id, version: '1.0.0', apiVersion: 1, capabilities: ['messaging.send'], subscriptions: ['message.received'],
    setup(context) {
      context.on('message.received', async execution => execution.send([{ type: 'text', text: id }]));
    } };
}

function engineFixture() {
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'routing-test', version: '1.0.0', name: 'Routing Test',
    identity: { role: 'test' }, style: { tone: 'plain' } });
  const policy = createPolicy();
  const sent: SendRequest[] = [];
  const transport: TransportAdapter = { async send(request) {
    sent.push(request);
    return { status: 'confirmed', messageId: `sent-${sent.length}` };
  } };
  return { engine: createEngine({ context, persona, policy, transport }), policy, sent };
}

test('router uses priority rather than installation order and returns frozen public facts', () => {
  let sawFrozenMessage = false;
  const high: MessageRouteRule = { id: 'work-command', priority: 100, route: 'work', relayToAgent: true,
    selector(message) {
      sawFrozenMessage = Object.isFrozen(message) && Object.isFrozen(message.content)
        && Object.isFrozen(message.content[0]);
      assert.equal(Reflect.set(message.content[0]!, 'text', 'mutated'), false);
      assert.equal('authorization' in message, false);
      return message.content[0]?.type === 'text' && message.content[0].text.startsWith('/work');
    } };
  const low: MessageRouteRule = { id: 'all-directed', priority: 10, route: 'chat', relayToAgent: false,
    selector: message => message.directed };
  const first = createMessageRouter({ rules: [low, high], defaultRoute: { route: 'observe', relayToAgent: false } });
  const second = createMessageRouter({ rules: [high, low], defaultRoute: { route: 'observe', relayToAgent: false } });
  const message = { ...inbound('one', '/work build'), authorization: { capabilities: ['messaging.send'] } } as InboundMessage;

  const routed = first(message);
  assert.deepEqual(routed, { route: 'work', ruleId: 'work-command', relayToAgent: true,
    reasonCode: 'ROUTING_RULE_MATCHED' });
  assert.deepEqual(second(message), routed);
  assert.equal(sawFrozenMessage, true);
  assert.equal(Object.isFrozen(routed), true);
  assert.equal(Object.getPrototypeOf(routed), Object.prototype);
  assert.equal(Reflect.set(routed, 'route', 'chat'), false);
  assert.deepEqual(Object.keys(routed).sort(), ['reasonCode', 'relayToAgent', 'route', 'ruleId']);
  assert.equal('authorization' in routed, false);
});

test('router falls back explicitly and rejects ambiguous or failed selectors', () => {
  const fallback = createMessageRouter({ rules: [{ id: 'never', priority: 1, route: 'work', relayToAgent: true,
    selector: () => false }], defaultRoute: { route: 'chat', relayToAgent: false } });
  assert.deepEqual(fallback(inbound('fallback', 'hello')), {
    route: 'chat', ruleId: null, relayToAgent: false, reasonCode: 'ROUTING_DEFAULT',
  });

  const conflict = createMessageRouter({ rules: [
    { id: 'first', priority: 10, route: 'chat', relayToAgent: false, selector: () => true },
    { id: 'second', priority: 10, route: 'work', relayToAgent: true, selector: () => true },
  ], defaultRoute: { route: 'observe', relayToAgent: false } });
  assert.throws(() => conflict(inbound('conflict', 'hello')), { code: 'ROUTING_CONFLICT' });

  const failed = createMessageRouter({ rules: [{ id: 'throws', priority: 1, route: 'work', relayToAgent: true,
    selector() { throw new Error('message-body-secret'); } }], defaultRoute: { route: 'chat', relayToAgent: false } });
  assert.throws(() => failed(inbound('failed', 'private body')), error => {
    assert.equal((error as { code?: string }).code, 'ROUTING_SELECTOR_FAILED');
    assert.doesNotMatch(String(error), /secret|private body/);
    return true;
  });

  const promised = createMessageRouter({ rules: [{ id: 'async', priority: 1, route: 'work', relayToAgent: true,
    selector: (() => Promise.resolve(true)) as unknown as MessageRouteRule['selector'] }],
  defaultRoute: { route: 'chat', relayToAgent: false } });
  assert.throws(() => promised(inbound('promised', 'hello')), { code: 'ASYNC_ROUTING_SELECTOR' });

  const nonBoolean = createMessageRouter({ rules: [{ id: 'truthy', priority: 1, route: 'work', relayToAgent: true,
    selector: (() => 1) as unknown as MessageRouteRule['selector'] }],
  defaultRoute: { route: 'chat', relayToAgent: false } });
  assert.throws(() => nonBoolean(inbound('truthy', 'hello')), { code: 'ROUTING_SELECTOR_FAILED' });
});

test('router rejects malicious identifiers, duplicate ids, accessors, and inherited rule fields', () => {
  assert.throws(() => createMessageRouter({ rules: [], defaultRoute: { route: '__proto__', relayToAgent: false } }),
    { code: 'INVALID_ROUTER' });
  assert.throws(() => createMessageRouter({ rules: [
    { id: 'same', priority: 2, route: 'chat', relayToAgent: false, selector: () => false },
    { id: 'same', priority: 1, route: 'work', relayToAgent: true, selector: () => false },
  ], defaultRoute: { route: 'chat', relayToAgent: false } }), { code: 'INVALID_ROUTER' });

  const inherited = Object.assign(Object.create({ relayToAgent: true }), {
    id: 'inherited', priority: 1, route: 'work', selector: () => true,
  }) as MessageRouteRule;
  assert.throws(() => createMessageRouter({ rules: [inherited], defaultRoute: { route: 'chat', relayToAgent: false } }),
    { code: 'INVALID_ROUTER' });

  let getterRead = false;
  const malicious = inbound('malicious', 'hello') as InboundMessage & { credential?: string };
  Object.defineProperty(malicious, 'credential', { enumerable: true, get() { getterRead = true; return 'secret'; } });
  const router = createMessageRouter({ rules: [], defaultRoute: { route: 'chat', relayToAgent: false } });
  assert.throws(() => router(malicious), { code: 'INVALID_DATA' });
  assert.equal(getterRead, false);
});

test('routed chat and work features share broadcast while only the owner replies', async () => {
  const { engine, policy, sent } = engineFixture();
  const observed: string[] = [];
  engine.install(withMessageRoute(responder('chat-handler'), 'chat'));
  engine.install(withMessageRoute(responder('work-handler'), 'work'));
  engine.install({ id: 'observer', version: '1.0.0', apiVersion: 1, capabilities: [], subscriptions: ['message.received'],
    setup(context) { context.on('message.received', (_execution, event) => { observed.push(event.id); }); } });
  for (const featureId of ['chat-handler', 'work-handler']) {
    policy.grant({ id: `grant-${featureId}`, featureId, conversationId: 'group:100', capabilities: ['messaging.send'],
      maxUses: { 'messaging.send': 2 } });
  }
  const router = createMessageRouter({ rules: [{ id: 'work-prefix', priority: 10, route: 'work', relayToAgent: true,
    selector: message => message.content.some(block => block.type === 'text' && block.text.startsWith('/work')) }],
  defaultRoute: { route: 'chat', relayToAgent: false } });

  const chatMessage = inbound('chat-one', 'hello');
  const workMessage = inbound('work-one', '/work inspect');
  const chatReport = await engine.emit(createRoutedMessageEvent(chatMessage, router(chatMessage)));
  const workEvent = createRoutedMessageEvent(workMessage, router(workMessage));
  const workReport = await engine.emit(workEvent);

  assert.deepEqual(sent.map(request => request.content), [
    [{ type: 'text', text: 'chat-handler' }],
    [{ type: 'text', text: 'work-handler' }],
  ]);
  assert.deepEqual(observed, ['chat-one', 'work-one']);
  assert.deepEqual(chatReport.outcomes.map(outcome => outcome.featureId), ['chat-handler', 'work-handler', 'observer']);
  assert.deepEqual(workReport.outcomes.map(outcome => outcome.featureId), ['chat-handler', 'work-handler', 'observer']);
  assert.equal(routedMessageRelaysToAgent(workEvent), true);
  assert.equal(routedMessageRelaysToAgent(createRoutedMessageEvent(chatMessage, router(chatMessage))), false);
  await engine.stop();
});

test('routing cannot create authorization and malformed routing fails closed', async () => {
  const { engine, sent } = engineFixture();
  let observed = 0;
  engine.install(withMessageRoute(responder('work-handler'), 'work'));
  engine.install({ id: 'observer', version: '1.0.0', apiVersion: 1, capabilities: [], subscriptions: ['message.received'],
    setup(context) { context.on('message.received', () => { observed++; }); } });
  const router = createMessageRouter({ rules: [{ id: 'work', priority: 1, route: 'work', relayToAgent: true,
    selector: () => true }], defaultRoute: { route: 'chat', relayToAgent: false } });
  const message = inbound('no-grant', '/work private');
  const decision = router(message);

  const report = await engine.emit(createRoutedMessageEvent(message, decision));
  assert.equal(report.outcomes.find(outcome => outcome.featureId === 'work-handler')?.errorCode, 'POLICY_DENIED');
  assert.equal(report.outcomes.find(outcome => outcome.featureId === 'observer')?.status, 'completed');
  assert.equal(observed, 1);
  assert.equal(sent.length, 0);
  assert.equal('capabilities' in decision, false);
  assert.equal('authorized' in decision, false);

  assert.throws(() => createRoutedMessageEvent(message, { ...decision, authorization: true } as typeof decision),
    { code: 'INVALID_ROUTING_DECISION' });
  const malformed = { id: 'malformed', type: 'message.received', conversationId: 'group:100',
    data: { routing: { route: 'work', relayToAgent: true, authorization: true } } };
  assert.equal(routedMessageRelaysToAgent(malformed as never), false);
  await engine.stop();
});
