import type { AccountScope } from '../contracts/account-scope.ts';
import { assertAccountScope, normalizeAccountScope } from '../core/account-scope.ts';
import { bindAccountStore } from '../storage/account-scope.ts';
import { isConfirmedMessageReceipt } from '../core/delivery.ts';
import { setInterval, clearInterval } from 'node:timers';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { normalizeContent } from '../core/content.ts';
import { createContextStore } from '../core/context.ts';
import { createEngine } from '../core/engine.ts';
import type { EngineOptions } from '../core/engine.ts';
import { FrameworkError, assert, errorCode, reference, snapshot, identifier } from '../core/values.ts';
import type { Clock, FeatureExecution, FrameworkEvent, JsonObject, MessageContent, TransportAdapter } from '../core/types.ts';
import { createPersistentPolicy } from '../storage/policy.ts';
import { createPersistentFeatureState } from '../storage/state.ts';
import { createSessionRegistry } from './sessions.ts';
import { createDurableTransport } from './outbox.ts';
import { createTaskQueue } from './tasks.ts';
import { createConversationHistory } from './history.ts';
import { digest, json, object, records } from './data.ts';
import type { AgentAdapter, AgentEvent, DurableStore, DurableStoreStatsOptions, InboundMessage, SessionBinding, StoredRecord } from './types.ts';
import { bridgeTimeouts, createBoundedAgent, createBoundedTransport, withDeadline, type BridgeTimeouts } from './deadlines.ts';
import { createReplyWatchdog } from './replies.ts';
import { createRoutedMessageEvent, routedMessageRelaysToAgent, type MessageRouter } from './routing.ts';

type HostEventValidators = NonNullable<EngineOptions['eventValidators']>;
type HostEffectAdapters = NonNullable<EngineOptions['effectAdapters']>;

export interface AgentMessagePreparation {
  capabilities: readonly string[];
  prepare(execution: Pick<FeatureExecution, 'context' | 'signal' | 'invoke' | 'generate'>, event: FrameworkEvent):
    readonly MessageContent[] | null | Promise<readonly MessageContent[] | null>;
}

export interface AgentInputPreparation {
  capabilities: readonly string[];
  prepare(execution: Pick<FeatureExecution, 'context' | 'signal' | 'invoke' | 'generate'>, event: FrameworkEvent):
    readonly MessageContent[] | null | Promise<readonly MessageContent[] | null>;
}

export interface BridgeHostOptions {
  accountScope?: AccountScope;
  store: DurableStore;
  agent: AgentAdapter;
  transport: TransportAdapter;
  context: ReturnType<typeof createContextStore>;
  persona: string;
  authorizeIncoming(message: InboundMessage, signal: AbortSignal): boolean | Promise<boolean>;
  followPool?: { readonly maxSessions: number; isIdle(binding: SessionBinding): boolean };
  routeIncoming?: MessageRouter;
  agentInputPreparation?: AgentInputPreparation;
  agentMessagePreparation?: AgentMessagePreparation;
  model?: EngineOptions['model'];
  observer?: EngineOptions['observer'];
  eventValidators?: HostEventValidators;
  effectAdapters?: HostEffectAdapters;
  clock?: Clock;
  taskTickMs?: number;
  maxConcurrentSends?: number;
  eventTimeoutMs?: number;
  timeouts?: Partial<BridgeTimeouts>;
  replyTimeoutMs?: number;
  replyTimeoutNotice?: string | null;
  replyRecovery?: 'notify' | 'record-only';
  selectAgentMessage?(event: AgentEvent, binding: SessionBinding): readonly MessageContent[] | null;
  splitAgentMessage?(content: readonly MessageContent[], event: FrameworkEvent): readonly (readonly MessageContent[])[];
  onFault?(code: string): void;
}
export interface InboundReceipt { status: 'accepted' | 'rejected' | 'unknown'; eventId: string; errorCode?: string }
const inboxNamespace = 'host.inbox';
const agentEventNamespace = 'host.agent-events';
const coreEventTypes = new Set(['message.received', 'trigger.fired']);
const coreCapabilityTypes = new Set(['messaging.send', 'messaging.forward', 'model.respond']);

function assertExtensionNames(eventValidators: HostEventValidators, effectAdapters: HostEffectAdapters) {
  assert(eventValidators && typeof eventValidators === 'object' && !Array.isArray(eventValidators)
    && effectAdapters && typeof effectAdapters === 'object' && !Array.isArray(effectAdapters),
  'INVALID_EXTENSION', 'Host extension registries must be objects.');
  assert(Object.keys(eventValidators).every(type => !type.startsWith('agent.') && !coreEventTypes.has(type))
    && Object.keys(effectAdapters).every(capability => !capability.startsWith('agent.') && !coreCapabilityTypes.has(capability)),
  'INVALID_EXTENSION', 'Host extensions cannot replace framework or agent bridge registrations.');
}

function storedReceipt(record: StoredRecord): InboundReceipt {
  const value = object(record.value);
  assert(reference(value.eventId), 'INVALID_STORED_DATA', 'Stored ingress data is invalid.');
  return snapshot({ status: value.status === 'accepted' ? 'accepted' : value.status === 'rejected' ? 'rejected' : 'unknown',
    eventId: String(value.eventId), ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}) });
}

export function createBridgeHost({ store, agent: sourceAgent, transport: sourceTransport, context, persona, authorizeIncoming, clock = Date.now,
  taskTickMs = 250, maxConcurrentSends = 1, eventTimeoutMs = 30000, timeouts: timeoutInput,
  replyTimeoutMs = 30000, replyTimeoutNotice = '请求已提交，但尚未收到回复。结果尚未确认，未自动重复提交。',
  selectAgentMessage, splitAgentMessage, onFault = () => {}, model, observer, eventValidators = {}, effectAdapters = {}, routeIncoming,
  agentInputPreparation, agentMessagePreparation, followPool, accountScope: accountInput, replyRecovery = 'notify' }: BridgeHostOptions) {
  const accountScope = accountInput === undefined ? undefined : normalizeAccountScope(accountInput);
  bindAccountStore(store, accountScope);
  assert(typeof authorizeIncoming === 'function' && Number.isSafeInteger(taskTickMs) && taskTickMs >= 10 && taskTickMs <= 60000,
    'INVALID_HOST', 'Explicit ingress authorization and a bounded task tick are required.');
  context.resolve({ persona });
  assert(replyTimeoutNotice === null || typeof replyTimeoutNotice === 'string'
    && replyTimeoutNotice.length > 0 && replyTimeoutNotice.length <= 8000, 'INVALID_HOST', 'A bounded timeout notice or null is required.');
  assert(selectAgentMessage === undefined || typeof selectAgentMessage === 'function'
    && !['AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction'].includes(selectAgentMessage.constructor.name),
  'INVALID_HOST', 'Agent output selection must be synchronous.');
  assert(splitAgentMessage === undefined || typeof splitAgentMessage === 'function'
    && !['AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction'].includes(splitAgentMessage.constructor.name),
  'INVALID_HOST', 'Agent message splitting must be a trusted synchronous decision.');
  assertExtensionNames(eventValidators, effectAdapters);
  assert(routeIncoming === undefined || typeof routeIncoming === 'function'
    && !['AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction'].includes(routeIncoming.constructor.name),
  'INVALID_ROUTER', 'Incoming routing must be a trusted synchronous decision.');
  assert(agentMessagePreparation === undefined || agentMessagePreparation && typeof agentMessagePreparation.prepare === 'function'
    && Array.isArray(agentMessagePreparation.capabilities)
    && agentMessagePreparation.capabilities.length <= 32
    && agentMessagePreparation.capabilities.every(capability => typeof capability === 'string')
    && new Set(agentMessagePreparation.capabilities).size === agentMessagePreparation.capabilities.length,
  'INVALID_HOST', 'Agent message preparation requires bounded declared capabilities.');
  const prepareAgentMessage = agentMessagePreparation?.prepare;
  assert(agentInputPreparation === undefined || agentInputPreparation && typeof agentInputPreparation.prepare === 'function'
    && Array.isArray(agentInputPreparation.capabilities) && agentInputPreparation.capabilities.length <= 32
    && agentInputPreparation.capabilities.every(capability => typeof capability === 'string')
    && new Set(agentInputPreparation.capabilities).size === agentInputPreparation.capabilities.length,
  'INVALID_HOST', 'Agent input preparation requires bounded declared capabilities.');
  const prepareAgentInput = agentInputPreparation?.prepare;
  assert(followPool === undefined || Number.isSafeInteger(followPool.maxSessions) && followPool.maxSessions >= 1
    && followPool.maxSessions <= 256 && typeof followPool.isIdle === 'function',
  'INVALID_HOST', 'A follow pool requires bounded capacity and an explicit idle predicate.');
  const timeouts = bridgeTimeouts(timeoutInput);
  const boundaryFault = (code: string) => fault(new FrameworkError(code, 'An external operation is unresolved.'));
  const agent = createBoundedAgent({ agent: sourceAgent, timeouts, onFault: boundaryFault });
  const transport = createBoundedTransport({ transport: sourceTransport, timeoutMs: timeouts.sendMs, onFault: boundaryFault });
  const policy = createPersistentPolicy({ store, clock, accountScope });
  const state = createPersistentFeatureState({ store });
  const sessions = createSessionRegistry({ store, agent, clock, accountScope });
  const outbox = createDurableTransport({ store, transport, clock, accountScope });
  const tasks = createTaskQueue({ store, clock });
  const history = createConversationHistory({ store });
  const replies = createReplyWatchdog({ store, clock, timeoutMs: replyTimeoutMs, recovery: replyRecovery, onFault: boundaryFault,
    async onTimeout(notice, signal) {
      const current = sessions.get(notice.conversationId);
      if (!current || current.generation !== notice.generation || current.sessionId !== notice.sessionId) return;
      const result = await processEvent({ id: `reply-timeout:${notice.id}`, type: 'agent.reply-timeout',
        conversationId: notice.conversationId, sessionId: notice.sessionId,
        data: { requestId: notice.requestId, generation: notice.generation, deadlineAt: notice.deadlineAt } }, signal);
      assert(result.status === 'accepted', result.errorCode ?? 'REPLY_NOTICE_UNKNOWN', 'The timeout notice was not confirmed.');
    } });
  const controller = new AbortController();
  const follows = new Map<string, { binding: SessionBinding; controller: AbortController; dispose?: () => void | Promise<void> }>();
  const retiringFollows = new Map<string, { binding: SessionBinding; controller: AbortController; dispose?: () => void | Promise<void> }>();
  const unhealthyFollows = new Set<string>();
  const following = new Map<string, Promise<void>>();
  const followUsers = new Map<string, number>();
  let followAdmission = Promise.resolve();
  const pending = new Map<string, { fingerprint: string; promise: Promise<InboundReceipt> }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let started: Promise<void> | null = null;
  let stopped: Promise<void> | null = null;
  let faultCount = 0;
  let timeoutCount = 0;
  let lastFaultCode: string | null = null;
  let startupState: 'idle' | 'recovering' | 'ready' | 'degraded' | 'stopped' = 'idle';
  let unsettledAuthorizations = 0;

  function fault(error: unknown) {
    const code = errorCode(error, 'HOST_FAILED');
    faultCount++;
    lastFaultCode = code;
    if (code.includes('TIMEOUT')) timeoutCount++;
    try { onFault(code); } catch {}
  }

  const engine = createEngine({ accountScope, persona, context, policy, state, transport: outbox, model, observer, clock, maxConcurrentSends, eventTimeoutMs,
    eventValidators: { ...eventValidators, 'agent.message': data => {
      try { normalizeContent(data.content); return true; } catch { return false; }
    }, 'agent.completed': () => true, 'agent.failed': () => true, 'agent.question': () => true, 'agent.approval': () => true,
    'agent.reply-timeout': data => reference(data.requestId) && Number.isSafeInteger(data.generation) && Number.isFinite(data.deadlineAt) },
    effectAdapters: { ...effectAdapters, 'agent.submit': { async execute(request) {
      const content = normalizeContent(object(request.input).content);
      const conversationId = request.scope.conversationId;
      const binding = await admitFollow(conversationId, request.signal, async () => {
        request.signal.throwIfAborted();
        const binding = await sessions.resolve(conversationId, request.signal);
        request.signal.throwIfAborted();
        await ensureFollow(binding, request.signal);
        return binding;
      });
      try {
        assert(!request.signal.aborted && sessions.get(binding.conversationId)?.generation === binding.generation,
          'SESSION_STALE', 'The agent session is no longer current.');
        assert(follows.get(binding.conversationId)?.binding.sessionId === binding.sessionId
          && !follows.get(binding.conversationId)?.controller.signal.aborted,
        'AGENT_FOLLOW_UNAVAILABLE', 'A live agent follow is required before submitting new work.');
        return json(await agent.submit({ sessionId: binding.sessionId,
          requestId: digest([request.scope.conversationId, request.scope.eventId, 'prompt']), content, signal: request.signal }));
      } finally { releaseFollowUser(conversationId); }
    } } } });

  engine.install({ id: 'agent-relay', version: '1.0.0', apiVersion: 1,
    capabilities: [...new Set(['agent.submit', 'messaging.send', 'messaging.forward',
      ...(agentInputPreparation?.capabilities ?? []), ...(agentMessagePreparation?.capabilities ?? [])])],
    subscriptions: ['message.received', 'agent.message', 'agent.reply-timeout'],
    setup(services) {
      services.on('message.received', async (execution, event) => {
        if (event.data.directed !== true || event.data.isSelf === true) return;
        if (event.data.routing !== undefined && !routedMessageRelaysToAgent(event)) return;
        const prepared = prepareAgentInput ? await prepareAgentInput(Object.freeze({ context: execution.context,
          signal: execution.signal, invoke: execution.invoke, generate: execution.generate }), snapshot(event)) : event.data.content;
        if (prepared === null) return;
        execution.signal.throwIfAborted();
        const result = object(await execution.invoke('agent.submit', { content: json(normalizeContent(prepared)) }));
        assert(result.status === 'accepted', result.status === 'rejected' ? 'AGENT_REJECTED' : 'AGENT_UNKNOWN',
          'The agent did not confirm prompt acceptance.');
        const binding = sessions.get(event.conversationId);
        assert(binding, 'SESSION_STALE', 'The agent session is no longer current.');
        try { replies.watch(binding, event.id); }
        catch (error) {
          fault(error);
          throw new FrameworkError('AGENT_REPLY_TRACKING_UNKNOWN', 'Accepted agent work could not be tracked.');
        }
      });
      services.on('agent.message', async (execution, event) => {
        const prepared = prepareAgentMessage ? await prepareAgentMessage(Object.freeze({ context: execution.context,
          signal: execution.signal, invoke: execution.invoke, generate: execution.generate }), event) : event.data.content;
        if (prepared === null) return;
        const content = normalizeContent(prepared);
        const selected = splitAgentMessage ? splitAgentMessage(content, snapshot(event)) : [content];
        assert(Array.isArray(selected) && selected.length > 0 && selected.length <= 4,
          'INVALID_AGENT_MESSAGE_SPLIT', 'Agent message splitting requires one to four bounded messages.');
        const messages = selected.map(message => normalizeContent(message));
        for (const [index, message] of messages.entries()) {
          const result = await execution.send(message);
          assert(result.status === 'confirmed', result.status === 'rejected' ? 'DELIVERY_REJECTED' : 'DELIVERY_UNKNOWN',
            'The transport did not confirm delivery.');
          if (isConfirmedMessageReceipt(result)) history.append(event.conversationId, { id: result.messageId, actor: 'assistant', content: message, receivedAt: clock() });
          if (index === 0) {
            const binding = sessions.get(event.conversationId);
            if (binding && binding.sessionId === event.sessionId && binding.generation === event.data.generation) replies.responded(binding);
          }
        }
      });
      services.on('agent.reply-timeout', async (execution, event) => {
        if (replyTimeoutNotice === null) return;
        const waiting = replies.get(event.conversationId);
        if (!waiting || waiting.status !== 'timed-out' || waiting.requestId !== event.data.requestId) return;
        const binding = sessions.get(event.conversationId);
        if (!binding || binding.sessionId !== event.sessionId || binding.generation !== event.data.generation) return;
        const result = await execution.send([{ type: 'text', text: replyTimeoutNotice }]);
        assert(isConfirmedMessageReceipt(result), result.status === 'rejected' ? 'DELIVERY_REJECTED' : 'DELIVERY_UNKNOWN',
          'The timeout notice was not confirmed.');
        history.append(event.conversationId, { id: result.messageId, actor: 'system', receivedAt: clock(),
          content: [{ type: 'text', text: replyTimeoutNotice }] });
      });
    } });

  async function processEvent(event: FrameworkEvent, signal = controller.signal): Promise<InboundReceipt> {
    const key = digest([event.conversationId, event.id, event.type]);
    const fingerprint = digest(event);
    const inProgress = pending.get(key);
    if (inProgress) {
      assert(inProgress.fingerprint === fingerprint, 'EVENT_CONFLICT', 'An event identity has different data.');
      return inProgress.promise;
    }
    const previous = store.read(inboxNamespace, key);
    if (previous) {
      assert(object(previous.value).fingerprint === fingerprint, 'EVENT_CONFLICT', 'A stored event has different data.');
      return storedReceipt(previous);
    }
    let held: StoredRecord;
    try {
      held = store.write(inboxNamespace, key, json({ eventId: event.id, scope: event.conversationId, event,
        fingerprint, status: 'processing' }), { expectedRevision: null });
    } catch (error) {
      if (errorCode(error) !== 'STORE_CONFLICT') throw error;
      const winner = store.read(inboxNamespace, key);
      assert(winner && object(winner.value).fingerprint === fingerprint, 'EVENT_CONFLICT', 'A stored event has different data.');
      return storedReceipt(winner);
    }
    const work = (async (): Promise<InboundReceipt> => {
      let result: InboundReceipt;
      try {
        const report = await engine.emit({ ...event, ...(accountScope ? { accountScope } : {}) }, { signal });
        const failed = report.outcomes.find(outcome => outcome.status === 'failed');
        result = failed ? { status: failed.errorCode?.includes('UNKNOWN') ? 'unknown' : 'rejected',
          eventId: event.id, errorCode: failed.errorCode ?? 'FEATURE_FAILED' } : { status: 'accepted', eventId: event.id };
      } catch (error) {
        const code = errorCode(error);
        if (code === 'EVENT_BACKPRESSURE') {
          store.delete(inboxNamespace, key, held.revision);
          return { status: 'rejected', eventId: event.id, errorCode: code };
        }
        result = { status: 'unknown', eventId: event.id, errorCode: code };
      }
      store.write(inboxNamespace, key, json({ ...object(held.value), ...result }), { expectedRevision: held.revision });
      return snapshot(result);
    })();
    pending.set(key, { fingerprint, promise: work });
    const settled = () => pending.delete(key);
    work.then(settled, settled);
    return work;
  }

  tasks.register('bridge.agent-event', async task => {
    const binding = object(task.payload.binding);
    const event = object(task.payload.event);
    const current = sessions.get(String(binding.conversationId));
    if (!current || current.generation !== binding.generation || current.sessionId !== event.sessionId) return;
    if (task.signal.aborted || controller.signal.aborted) throw new FrameworkError('HOST_STOPPED', 'The host is stopped.');
    const type = `agent.${event.type}`;
    const selected = event.type === 'message' ? selectAgentMessage
      ? selectAgentMessage(snapshot(event) as unknown as AgentEvent, snapshot(current)) : normalizeContent(event.content) : null;
    if (event.type === 'message' && selected === null) return;
    const data: JsonObject = event.type === 'message' ? { content: json(normalizeContent(selected)), generation: current.generation,
      ...(prepareAgentMessage ? { agentData: event.data ?? {} } : {}) }
      : { data: event.data ?? {} };
    const receipt = await processEvent({ id: digest([current.generation, event.id, event.type]),
      conversationId: current.conversationId, sessionId: current.sessionId, type, data }, task.signal);
    assert(receipt.status === 'accepted', receipt.errorCode ?? 'AGENT_EVENT_FAILED', 'The agent event did not complete.');
  });

  function nextAgentSequence(): number {
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = store.read('host.meta', 'agent-sequence');
      const sequence = previous ? object(previous.value).sequence : 0;
      assert(typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0
        && sequence < Number.MAX_SAFE_INTEGER, 'INVALID_STORED_DATA', 'Agent event sequence is invalid.');
      try {
        store.write('host.meta', 'agent-sequence', { sequence: sequence + 1 }, { expectedRevision: previous?.revision ?? null });
        return sequence + 1;
      } catch (error) { if (errorCode(error) !== 'STORE_CONFLICT') throw error; }
    }
    throw new FrameworkError('AGENT_SEQUENCE_BUSY', 'Agent event admission is busy.');
  }

  function scheduleAgentRecord(record: StoredRecord) {
    const value = object(record.value);
    assert(Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0,
      'INVALID_STORED_DATA', 'Agent event sequence is invalid.');
    assert(typeof value.deadlineAt === 'number' && Number.isFinite(value.deadlineAt),
      'INVALID_STORED_DATA', 'Agent event deadline is invalid.');
    if (value.status === 'expired') return;
    if (value.deadlineAt <= clock()) {
      store.write(agentEventNamespace, record.key, json({ ...value, status: 'expired' }), { expectedRevision: record.revision });
      return;
    }
    const payload = object(value.payload);
    const binding = object(payload.binding);
    const id = `agent:${String(value.sequence).padStart(16, '0')}:${record.key}`;
    const previous = store.read('tasks', id);
    if (previous) {
      assert(digest(object(previous.value).payload) === digest(payload), 'EVENT_CONFLICT', 'A repeated agent event has different data.');
      return;
    }
    try { tasks.schedule({ id, kind: 'bridge.agent-event', scope: String(binding.conversationId), payload,
      dueAt: clock(), expiresAt: value.deadlineAt }); }
    catch (error) {
      const winner = store.read('tasks', id);
      if (errorCode(error) !== 'STORE_CONFLICT' || !winner || digest(object(winner.value).payload) !== digest(payload)) throw error;
    }
  }

  function enqueueAgentEvent(binding: SessionBinding, input: AgentEvent) {
    if (controller.signal.aborted) return;
    try {
      const event = snapshot(input);
      assert(reference(event.id) && event.sessionId === binding.sessionId
        && ['message', 'completed', 'failed', 'question', 'approval'].includes(event.type), 'INVALID_AGENT_EVENT', 'The agent event is invalid.');
      const payload = { binding: json(binding), event: json(event) };
      const id = digest([binding.conversationId, binding.generation, event.id, event.type]);
      let record = store.read(agentEventNamespace, id);
      if (!record) {
        const match = /^(.*):seq:(\d+)$/.exec(event.id);
        if (match) {
          const floor = store.read('host.agent-event-floors', digest([binding.sessionId, binding.generation, match[1]]));
          if (floor && Number(object(floor.value).sequence) >= Number(match[2])) return;
        }
      }
      if (!record) {
        try { record = store.write(agentEventNamespace, id, json({ sequence: nextAgentSequence(), payload,
          deadlineAt: clock() + eventTimeoutMs }), { expectedRevision: null }); }
        catch (error) {
          record = store.read(agentEventNamespace, id);
          if (errorCode(error) !== 'STORE_CONFLICT' || !record) throw error;
        }
      }
      assert(digest(object(record.value).payload) === digest(payload), 'EVENT_CONFLICT', 'A repeated agent event has different data.');
      scheduleAgentRecord(record);
      void tasks.runDue().catch(fault);
    } catch (error) { fault(error); }
  }

  function ensureFollow(binding: SessionBinding, signal = controller.signal): Promise<void> {
    assert(!controller.signal.aborted, 'HOST_STOPPED', 'The host is stopped.');
    const key = digest(binding);
    const opening = following.get(key);
    if (opening) return opening;
    const previous = follows.get(binding.conversationId) ?? retiringFollows.get(binding.conversationId);
    if (previous?.binding.generation === binding.generation && !previous.controller.signal.aborted) {
      return following.get(key) ?? Promise.resolve();
    }
    const followController = new AbortController();
    const parent = AbortSignal.any([controller.signal, signal]);
    const abort = () => followController.abort();
    parent.addEventListener('abort', abort, { once: true });
    if (parent.aborted) abort();
    const entry = { binding, controller: followController } as { binding: SessionBinding; controller: AbortController; dispose?: () => void | Promise<void> };
    follows.set(binding.conversationId, entry);
    const work = (async () => {
      previous?.controller.abort();
      if (previous?.dispose) await previous.dispose();
      try {
        const dispose = await agent.follow({ sessionId: binding.sessionId, signal: followController.signal,
          onEvent: event => {
            if (follows.get(binding.conversationId) !== entry || followController.signal.aborted) return;
            enqueueAgentEvent(binding, event);
            if (event.type === 'failed' && event.sessionId === binding.sessionId && reference(event.id)
              && event.data?.terminal === true) {
              follows.delete(binding.conversationId);
              retiringFollows.set(binding.conversationId, entry);
              unhealthyFollows.add(binding.conversationId);
              followController.abort();
              fault(new FrameworkError('AGENT_FOLLOW_TERMINATED', 'The agent event stream ended.'));
              if (entry.dispose) void Promise.resolve(entry.dispose()).then(() => {
                if (retiringFollows.get(binding.conversationId) === entry) retiringFollows.delete(binding.conversationId);
              }).catch(fault);
            }
          } });
        let disposing: Promise<void> | undefined;
        entry.dispose = () => disposing ??= Promise.resolve().then(dispose);
        if (followController.signal.aborted) {
          await entry.dispose();
          assert(false, 'AGENT_FOLLOW_UNAVAILABLE', 'The agent follow ended before it was ready.');
        }
        unhealthyFollows.delete(binding.conversationId);
        if (retiringFollows.get(binding.conversationId) === previous) retiringFollows.delete(binding.conversationId);
      } catch (error) {
        if (follows.get(binding.conversationId) === entry) follows.delete(binding.conversationId);
        throw error;
      } finally { parent.removeEventListener('abort', abort); }
    })();
    following.set(key, work);
    const settled = () => { if (following.get(key) === work) following.delete(key); };
    work.then(settled, settled);
    return work;
  }

  function releaseFollowUser(conversationId: string) {
    const users = followUsers.get(conversationId) ?? 0;
    if (users <= 1) followUsers.delete(conversationId);
    else followUsers.set(conversationId, users - 1);
  }

  function admitFollow<Value>(conversationId: string, signal: AbortSignal, operation: () => Promise<Value>): Promise<Value> {
    if (!followPool) return operation();
    const work = followAdmission.then(async () => {
      signal.throwIfAborted();
      const previous = follows.get(conversationId);
      if (!previous || previous.controller.signal.aborted) {
        if (follows.size + retiringFollows.size >= followPool.maxSessions) {
          const idle = [...follows.values()].find(entry => !followUsers.has(entry.binding.conversationId)
            && entry.dispose && !entry.controller.signal.aborted && followPool.isIdle(entry.binding) === true);
          assert(idle, 'AGENT_FOLLOW_BACKPRESSURE', 'All agent follow slots are busy.');
          const idleId = idle.binding.conversationId;
          follows.delete(idleId);
          retiringFollows.set(idleId, idle);
          idle.controller.abort();
          const faultsBeforeDispose = faultCount;
          await idle.dispose!();
          assert(faultCount === faultsBeforeDispose, 'AGENT_FOLLOW_BACKPRESSURE', 'An idle follow has not drained.');
          if (retiringFollows.get(idleId) === idle) retiringFollows.delete(idleId);
        }
        signal.throwIfAborted();
        assert(follows.size + retiringFollows.size < followPool.maxSessions,
          'AGENT_FOLLOW_BACKPRESSURE', 'All agent follow slots are busy.');
      }
      followUsers.set(conversationId, (followUsers.get(conversationId) ?? 0) + 1);
      try {
        const result = await operation();
        const current = follows.get(conversationId);
        if (current) { follows.delete(conversationId); follows.set(conversationId, current); }
        return result;
      } catch (error) { releaseFollowUser(conversationId); throw error; }
    });
    followAdmission = work.then(() => undefined, () => undefined);
    return work;
  }

  return Object.freeze({
    accountScope, engine, policy, sessions, outbox, tasks, history, replies,
    storageStats(options?: DurableStoreStatsOptions) { return store.stats?.(options) ?? null; },
    async dispatchEvent(input: FrameworkEvent, options: { signal?: AbortSignal } = {}): Promise<InboundReceipt> {
      assert(!controller.signal.aborted, 'HOST_STOPPED', 'The host is stopped.');
      const event = snapshot(input);
      assertAccountScope(accountScope, event.accountScope);
      assert(reference(event.id) && reference(event.conversationId) && identifier(event.type)
        && !event.type.startsWith('agent.') && !coreEventTypes.has(event.type)
        && Object.hasOwn(eventValidators, event.type),
      'INVALID_EXTERNAL_EVENT', 'External events require a registered non-core event type.');
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      signal.throwIfAborted();
      return processEvent(event, signal);
    },
    async receive(input: InboundMessage, options: { signal?: AbortSignal } = {}): Promise<InboundReceipt> {
      assert(!controller.signal.aborted, 'HOST_STOPPED', 'The host is stopped.');
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      signal.throwIfAborted();
      const message = snapshot({ ...snapshot(input), content: normalizeContent(input.content) });
      assertAccountScope(accountScope, message.accountScope);
      assert(reference(message.id) && reference(message.conversationId) && reference(message.userId)
        && Number.isFinite(message.receivedAt) && typeof message.directed === 'boolean' && typeof message.isSelf === 'boolean',
      'INVALID_INBOUND', 'A normalized authenticated message is required.');
      const retentionFloor = store.read('host.retention', 'inbound-floor');
      if (retentionFloor && message.receivedAt <= Number(object(retentionFloor.value).at)) {
        return { status: 'rejected', eventId: message.id, errorCode: 'EVENT_RETENTION_EXPIRED' };
      }
      let allowed: boolean;
      if (unsettledAuthorizations >= 256) {
        return snapshot({ status: 'rejected', eventId: message.id, errorCode: 'INBOUND_BACKPRESSURE' });
      }
      try {
        allowed = await withDeadline({ signal, timeoutMs: timeouts.authorizeMs, code: 'INBOUND_AUTH_TIMEOUT',
          run: authorizationSignal => {
            unsettledAuthorizations++;
            let result: boolean | Promise<boolean>;
            try { result = authorizeIncoming(message, authorizationSignal); }
            catch (error) { unsettledAuthorizations--; throw error; }
            return Promise.resolve(result).then(value => { unsettledAuthorizations--; return value; }, error => {
              unsettledAuthorizations--;
              throw error;
            });
          } });
      } catch (error) {
        fault(error);
        return snapshot({ status: 'rejected', eventId: message.id, errorCode: errorCode(error, 'INBOUND_DENIED') });
      }
      if (allowed !== true) return snapshot({ status: 'rejected', eventId: message.id, errorCode: 'INBOUND_DENIED' });
      assert(!controller.signal.aborted, 'HOST_STOPPED', 'The host is stopped.');
      signal.throwIfAborted();
      let routed: FrameworkEvent | undefined;
      if (routeIncoming) {
        try { routed = createRoutedMessageEvent(message, routeIncoming(message)); }
        catch (error) { return snapshot({ status: 'rejected', eventId: message.id, errorCode: errorCode(error, 'INBOUND_ROUTING_FAILED') }); }
      }
      history.append(message.conversationId, { id: message.id, actor: message.userId, content: message.content, receivedAt: message.receivedAt });
      return processEvent(routed ?? { id: message.id, type: 'message.received', conversationId: message.conversationId, userId: message.userId,
        data: { content: json(message.content), text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
          directed: message.directed, isSelf: message.isSelf } }, signal);
    },
    start() {
      assert(!controller.signal.aborted, 'HOST_STOPPED', 'The host is stopped.');
      if (started) return started;
      startupState = 'recovering';
      started = (async () => {
        try {
          await withDeadline({ signal: controller.signal, timeoutMs: timeouts.startMs, code: 'HOST_START_TIMEOUT', run: async signal => {
            for (const service of [outbox, tasks]) {
              let after: string | null = null;
              do {
                if (signal.aborted) return;
                const page: { recovered: number; next: string | null } = service.recoverPage(after === null ? { limit: 16 } : { limit: 16, after });
                after = page.next;
                await nextTurn();
              } while (after !== null);
            }
            let replyAfter: string | null = null;
            do {
              if (signal.aborted) return;
              replyAfter = replies.restorePage(replyAfter === null ? { limit: 16 } : { limit: 16, after: replyAfter }).next;
              await nextTurn();
            } while (replyAfter !== null);
            let scanned = 0;
            for (const record of records(store, agentEventNamespace)) {
              if (++scanned % 16 === 0) await nextTurn();
              if (signal.aborted) return;
              scheduleAgentRecord(record);
            }
            for (const record of records(store, inboxNamespace)) {
              if (++scanned % 16 === 0) await nextTurn();
              if (signal.aborted) return;
              if (object(record.value).status === 'processing' && !pending.has(record.key)) {
                store.write(inboxNamespace, record.key, json({ ...object(record.value), status: 'unknown', errorCode: 'INGRESS_INTERRUPTED' }),
                  { expectedRevision: record.revision });
              }
            }
            let after: string | undefined;
            while (!signal.aborted) {
              const batch = sessions.list(after === undefined ? { limit: 4 } : { limit: 4, after });
              await Promise.all(batch.map(async session => {
                if (session.state !== 'ready') return;
                const binding = sessions.get(session.conversationId);
                if (!binding || followPool?.isIdle(binding) === true) return;
                if (followPool && follows.size + retiringFollows.size >= followPool.maxSessions) return;
                try {
                  await admitFollow(binding.conversationId, signal, async () => { await ensureFollow(binding, signal); });
                  releaseFollowUser(binding.conversationId);
                } catch (error) { if (errorCode(error) !== 'AGENT_FOLLOW_BACKPRESSURE') fault(error); }
              }));
              if (batch.length < 4) break;
              after = batch[batch.length - 1].conversationId;
            }
          } });
          if (!controller.signal.aborted) startupState = 'ready';
        } catch (error) {
          if (!controller.signal.aborted) startupState = 'degraded';
          fault(error);
        }
        if (!controller.signal.aborted) {
          timer = setInterval(() => { void tasks.runDue().catch(fault); }, taskTickMs);
          timer.unref();
          void tasks.runDue().catch(fault);
        }
      })();
      return started;
    },
    metrics() { return snapshot({ engine: engine.metrics(), replies: replies.metrics(), followedSessions: follows.size,
      unhealthyFollows: unhealthyFollows.size,
      pendingIngress: pending.size, unsettledAuthorizations, faults: faultCount, timeouts: timeoutCount, lastFaultCode,
      startupState, started: started !== null, stopped: controller.signal.aborted }); },
    stop() {
      if (stopped) return stopped;
      controller.abort();
      startupState = 'stopped';
      if (timer) clearInterval(timer);
      for (const entry of follows.values()) entry.controller.abort();
      for (const entry of retiringFollows.values()) entry.controller.abort();
      stopped = (async () => {
        const draining = tasks.stop();
        const replyDraining = replies.stop();
        await engine.stop();
        await draining;
        await replyDraining;
        await Promise.allSettled([...following.values()]);
        for (const entry of follows.values()) if (entry.dispose) {
          try { await entry.dispose(); } catch (error) { fault(error); }
        }
        for (const entry of retiringFollows.values()) if (entry.dispose) {
          try { await entry.dispose(); } catch (error) { fault(error); }
        }
        follows.clear();
        retiringFollows.clear();
      })();
      return stopped;
    },
  });
}
