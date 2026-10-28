import { normalizeContent } from '../core/content.ts';
import { FrameworkError, assert, identifier, isRecord, reference, snapshot } from '../core/values.ts';
import type { FeatureDefinition, FeatureHandler, FeatureSetup, FrameworkEvent, MessageContent } from '../core/types.ts';
import type { InboundMessage } from './types.ts';
import { normalizeSenderDisplayName } from '../contracts/sender-display-name.ts';

export type FrozenInboundMessage = Readonly<Omit<InboundMessage, 'content'> & {
  content: readonly Readonly<MessageContent>[];
}>;

export type MessageRouteReasonCode = 'ROUTING_RULE_MATCHED' | 'ROUTING_DEFAULT';

export interface MessageRouteDecision {
  readonly route: string;
  readonly ruleId: string | null;
  readonly relayToAgent: boolean;
  readonly reasonCode: MessageRouteReasonCode;
}

export interface MessageRouteRule {
  readonly id: string;
  readonly priority: number;
  readonly route: string;
  readonly relayToAgent: boolean;
  readonly selector: (message: FrozenInboundMessage) => boolean;
}

export interface DefaultMessageRoute {
  readonly route: string;
  readonly relayToAgent: boolean;
}

export interface MessageRouterOptions {
  readonly rules: readonly MessageRouteRule[];
  readonly defaultRoute: DefaultMessageRoute;
}

export type MessageRouter = (message: InboundMessage) => MessageRouteDecision;

interface CompiledRule {
  readonly id: string;
  readonly priority: number;
  readonly route: string;
  readonly relayToAgent: boolean;
  readonly selector: (message: FrozenInboundMessage) => boolean;
}

const decisionKeys = ['route', 'ruleId', 'relayToAgent', 'reasonCode'] as const;

function dataObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  assert(isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
    code, 'Routing configuration must use plain data objects.');
  const ownKeys = Reflect.ownKeys(value);
  assert(ownKeys.length === keys.length && ownKeys.every(key => typeof key === 'string' && keys.includes(key)),
    code, 'Routing configuration has unexpected or missing fields.');
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'),
      code, 'Routing configuration fields must be enumerable data properties.');
  }
  return value;
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function routeTarget(input: unknown, code: string): DefaultMessageRoute {
  const value = dataObject(input, ['route', 'relayToAgent'], code);
  const route = ownValue(value, 'route');
  const relayToAgent = ownValue(value, 'relayToAgent');
  assert(identifier(route) && typeof relayToAgent === 'boolean', code,
    'A route target requires a valid route and an explicit relay decision.');
  return Object.freeze({ route, relayToAgent });
}

function compileRules(input: unknown): readonly CompiledRule[] {
  assert(Array.isArray(input) && Object.getPrototypeOf(input) === Array.prototype && input.length <= 256,
    'INVALID_ROUTER', 'Routing rules must be a bounded ordinary array.');
  const ownKeys = Reflect.ownKeys(input);
  assert(ownKeys.every(key => key === 'length' || typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key))
    && Object.keys(input).length === input.length, 'INVALID_ROUTER', 'Routing rules must be a dense array without extra fields.');
  const ids = new Set<string>();
  const rules = input.map((entry): CompiledRule => {
    const value = dataObject(entry, ['id', 'priority', 'route', 'relayToAgent', 'selector'], 'INVALID_ROUTER');
    const id = ownValue(value, 'id');
    const priority = ownValue(value, 'priority');
    const route = ownValue(value, 'route');
    const relayToAgent = ownValue(value, 'relayToAgent');
    const selector = ownValue(value, 'selector');
    assert(identifier(id) && identifier(route) && Number.isSafeInteger(priority)
      && typeof relayToAgent === 'boolean' && typeof selector === 'function',
    'INVALID_ROUTER', 'Each routing rule requires a unique id, integer priority, route, relay decision, and selector.');
    assert(!ids.has(id), 'INVALID_ROUTER', 'Routing rule ids must be unique.');
    ids.add(id);
    return Object.freeze({ id, priority: priority as number, route, relayToAgent,
      selector: selector as MessageRouteRule['selector'] });
  });
  rules.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  return Object.freeze(rules);
}

function normalizedMessage(input: InboundMessage): FrozenInboundMessage {
  const value = snapshot(input);
  assert(isRecord(value) && reference(value.id) && reference(value.conversationId) && reference(value.userId)
    && Number.isFinite(value.receivedAt) && typeof value.directed === 'boolean' && typeof value.isSelf === 'boolean',
  'INVALID_INBOUND', 'A normalized authenticated message is required for routing.');
  const content = normalizeContent(value.content);
  const displayName = normalizeSenderDisplayName(value.displayName);
  return snapshot({ id: value.id, conversationId: value.conversationId, userId: value.userId,
    ...(displayName === undefined ? {} : { displayName }),
    receivedAt: value.receivedAt, content, directed: value.directed, isSelf: value.isSelf });
}

function asynchronous(value: unknown): boolean {
  if ((value === null || typeof value !== 'object') && typeof value !== 'function') return false;
  let then: unknown;
  try { then = Reflect.get(value as object, 'then'); }
  catch { throw new FrameworkError('ASYNC_ROUTING_SELECTOR', 'Routing selectors must return synchronously.'); }
  if (typeof then !== 'function') return false;
  try { Promise.resolve(value).catch(() => {}); } catch {}
  return true;
}

function selected(rule: CompiledRule, message: FrozenInboundMessage): boolean {
  let result: unknown;
  try { result = rule.selector(message); }
  catch { throw new FrameworkError('ROUTING_SELECTOR_FAILED', 'A routing selector failed.'); }
  if (asynchronous(result)) {
    throw new FrameworkError('ASYNC_ROUTING_SELECTOR', 'Routing selectors must return synchronously.');
  }
  assert(typeof result === 'boolean', 'ROUTING_SELECTOR_FAILED', 'Routing selectors must return a boolean.');
  return result;
}

function decision(input: unknown): MessageRouteDecision {
  const value = dataObject(snapshot(input), decisionKeys, 'INVALID_ROUTING_DECISION');
  const route = ownValue(value, 'route');
  const ruleId = ownValue(value, 'ruleId');
  const relayToAgent = ownValue(value, 'relayToAgent');
  const reasonCode = ownValue(value, 'reasonCode');
  assert(identifier(route) && (ruleId === null || identifier(ruleId)) && typeof relayToAgent === 'boolean'
    && (reasonCode === 'ROUTING_RULE_MATCHED' || reasonCode === 'ROUTING_DEFAULT'),
  'INVALID_ROUTING_DECISION', 'A routing decision must contain only public routing facts.');
  assert((reasonCode === 'ROUTING_DEFAULT') === (ruleId === null), 'INVALID_ROUTING_DECISION',
    'Default routing decisions cannot claim a rule match.');
  return snapshot({ route, ruleId, relayToAgent, reasonCode });
}

function eventDecision(event: FrameworkEvent): MessageRouteDecision | null {
  try {
    const data = dataObject(event.data, Object.keys(event.data), 'INVALID_ROUTING_DECISION');
    const descriptor = Object.getOwnPropertyDescriptor(data, 'routing');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    return decision(descriptor.value);
  } catch {
    return null;
  }
}

export function createMessageRouter(input: MessageRouterOptions): MessageRouter {
  const options = dataObject(input, ['rules', 'defaultRoute'], 'INVALID_ROUTER');
  const rules = compileRules(ownValue(options, 'rules'));
  const fallback = routeTarget(ownValue(options, 'defaultRoute'), 'INVALID_ROUTER');
  return Object.freeze((inputMessage: InboundMessage): MessageRouteDecision => {
    const message = normalizedMessage(inputMessage);
    let winner: CompiledRule | null = null;
    for (const rule of rules) {
      if (winner && rule.priority < winner.priority) break;
      if (!selected(rule, message)) continue;
      assert(!winner, 'ROUTING_CONFLICT', 'More than one routing rule matched at the highest priority.');
      winner = rule;
    }
    return winner
      ? decision({ route: winner.route, ruleId: winner.id, relayToAgent: winner.relayToAgent,
        reasonCode: 'ROUTING_RULE_MATCHED' })
      : decision({ route: fallback.route, ruleId: null, relayToAgent: fallback.relayToAgent,
        reasonCode: 'ROUTING_DEFAULT' });
  });
}

export function createRoutedMessageEvent(input: InboundMessage, routing: MessageRouteDecision): FrameworkEvent {
  const message = normalizedMessage(input);
  const trustedRouting = decision(routing);
  return snapshot({ id: message.id, type: 'message.received', conversationId: message.conversationId,
    userId: message.userId, data: { content: message.content,
      text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      directed: message.directed, isSelf: message.isSelf, routing: trustedRouting,
      ...(message.displayName === undefined ? {} : { senderDisplayName: message.displayName }) } }) as unknown as FrameworkEvent;
}

export function routedMessageRelaysToAgent(event: FrameworkEvent): boolean {
  return event.type === 'message.received' && eventDecision(event)?.relayToAgent === true;
}

export function withMessageRoute(feature: FeatureDefinition, route: string): FeatureDefinition {
  assert(identifier(route) && feature !== null && typeof feature === 'object' && typeof feature.setup === 'function'
    && Array.isArray(feature.capabilities) && Array.isArray(feature.subscriptions),
  'INVALID_ROUTED_FEATURE', 'A valid feature and route are required.');
  const setup = feature.setup;
  const capabilities = Object.freeze([...feature.capabilities]);
  const subscriptions = Object.freeze([...feature.subscriptions]);
  return Object.freeze({ id: feature.id, version: feature.version, apiVersion: feature.apiVersion,
    capabilities, subscriptions,
    setup(context: FeatureSetup) {
      const routedContext: FeatureSetup = Object.freeze({ signal: context.signal,
        on(type: string, handler: FeatureHandler) {
          context.on(type, (execution, event) => {
            if (event.type === 'message.received' && eventDecision(event)?.route !== route) return undefined;
            return handler(execution, event);
          });
        },
        defer(dispose: () => void) { context.defer(dispose); },
      });
      return setup(routedContext);
    } });
}
