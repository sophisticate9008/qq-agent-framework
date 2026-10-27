import { nativeToolCapabilityDefinition } from '../contracts/native-tool-capabilities.ts';
import type { DshFrameworkToolPort } from '../adapters/dsh-framework-tools.ts';
import type { FrameworkToolCall, FrameworkToolDefinition } from '../contracts/framework-tools.ts';
import type { EffectRequest, EffectScope, FeatureDefinition, FeatureExecution, FrameworkEvent, JsonObject, JsonValue } from '../core/types.ts';
import { assert, errorCode, FrameworkError, isRecord, reference } from '../core/values.ts';
import type { createBridgeHost } from './bridge.ts';
import { digest, json, object } from './data.ts';
import { createFrameworkToolRegistry } from './framework-tools.ts';
import { createFrameworkToolPump } from './framework-tool-pump.ts';
import { makeFrameworkMediaResultProjector } from './framework-media.ts';
import type { DurableStore, SessionBinding } from './types.ts';
import type { NativeEventInput } from '../contracts/native-events.ts';
import { mapNativeToolObservation } from './native-event-mapping.ts';

export const NATIVE_TOOL_EVENT = 'native.tool.request';
export const NATIVE_TOOL_FEATURE = 'framework-tools';
export interface NativeToolContribution {
  readonly definition: FrameworkToolDefinition;
  readonly validate: (input: JsonValue) => JsonValue;
  readonly deliveryCapabilities?: readonly ('messaging.send' | 'messaging.forward')[];
  /** Runs after the capability invocation, inside its admitted feature execution. */
  readonly afterInvoke?: (value: JsonValue, execution: FeatureExecution, event: FrameworkEvent,
    host: ReturnType<typeof createBridgeHost>) => Promise<JsonValue>;
}
export const NATIVE_MEDIA_TOOLS: readonly FrameworkToolDefinition[] = Object.freeze(
  (['native.media.inspect', 'native.media.read'] as const).map(capability => {
    const tool = nativeToolCapabilityDefinition(capability);
    return { registrationSource: { origin: 'framework-builtin' as const, ownerId: 'qq-agent-framework', ownerName: '框架内置工具', transport: 'native' as const }, name: tool.tool, capability, description: tool.description, featureId: NATIVE_TOOL_FEATURE,
      timeoutMs: capability === 'native.media.read' ? 30_000 : 10_000,
      parameters: { type: 'object', additionalProperties: false, required: ['assetId'],
        properties: { assetId: { type: 'string', pattern: '^media-[a-f0-9]{64}$', maxLength: 70 } } } };
  }));

export function validateNativeToolEvent(data: JsonObject): boolean {
  return Object.keys(data).length === 2 && reference(data.ticket) && Number.isSafeInteger(data.generation) && Number(data.generation) > 0;
}

/** Tool handlers enter the same feature engine and policy used by installed packages. */
export function createNativeFrameworkTools(options: {
  readonly host: ReturnType<typeof createBridgeHost>;
  readonly store: DurableStore;
  readonly port: DshFrameworkToolPort;
  readonly issuerEpoch: string;
  readonly signal: AbortSignal;
  readonly resolveScope: (call: FrameworkToolCall, signal: AbortSignal) => Promise<EffectScope | null>;
  readonly guard: (conversationId: string, signal: AbortSignal) => Promise<void>;
  readonly tools?: readonly NativeToolContribution[];
  readonly unavailableCapabilities?: (signal: AbortSignal) => Promise<readonly string[]>;
  readonly toolDescriptions?: (signal: AbortSignal) => Promise<Readonly<Record<string, string>>>;
  readonly onObservation?: (event: NativeEventInput) => void;
}) {
  const namespace = 'native-chat.tool-projections';
  const projections = new Map<string, { leaseId: string; generation: number; names: readonly string[]; definitionRevision: string }>();
  const invocations = new Map<string, { request: EffectRequest; capability: string; value?: JsonValue; error?: unknown; completed: boolean }>();
  let channelError: string | null = null;
  let closed = false;
  let pumpStarted = false;
  function observe(event: NativeEventInput | null): void {
    if (!event) return;
    const accountScope = options.host.accountScope;
    const observation = accountScope ? { ...event, correlation: { ...event.correlation, protocolId: accountScope.protocolId, accountId: accountScope.accountId } } : event;
    try { void Promise.resolve(options.onObservation?.(observation)).catch(() => {}); } catch {}
  }
  const additional = options.tools ?? [];
  assert(additional.every(tool => tool.definition.featureId === NATIVE_TOOL_FEATURE),
    'INVALID_FRAMEWORK_TOOL', 'Native tool permissions belong to the registered framework-tools feature.');
  const feature: FeatureDefinition = { id: NATIVE_TOOL_FEATURE, version: '1.0.0', apiVersion: 1,
    capabilities: [...new Set([...NATIVE_MEDIA_TOOLS.map(tool => tool.capability), ...additional.map(tool => tool.definition.capability), ...additional.flatMap(tool => tool.deliveryCapabilities ?? [])])], subscriptions: [NATIVE_TOOL_EVENT],
    setup(services) { services.on(NATIVE_TOOL_EVENT, async (execution, event) => {
      const entry = invocations.get(String(event.data.ticket));
      assert(entry && event.id === entry.request.scope.eventId && event.conversationId === entry.request.scope.conversationId
        && event.sessionId === entry.request.scope.sessionId && event.data.generation === entry.request.scope.generation,
      'TOOL_SOURCE_UNAVAILABLE', 'This event has no admitted framework tool invocation.');
      try {
        entry.request.signal.throwIfAborted();
        await options.guard(event.conversationId, execution.signal);
        const value = await execution.invoke(entry.capability, entry.request.input);
        const tool = additional.find(tool => tool.definition.capability === entry.capability);
        entry.value = tool?.afterInvoke ? await tool.afterInvoke(value, execution, event, options.host) : value;
        entry.completed = true;
      } catch (error) { entry.error = error; throw error; }
    }); } };
  const registry = createFrameworkToolRegistry({ async resolveScope(call, signal) {
    const scope = await options.resolveScope(call,signal);
    if (scope) {
      const event = mapNativeToolObservation(call,undefined,scope.conversationId);
      if (event?.kind === 'tool') observe({...event,status:'progress'});
    }
    return scope;
  }, projectResult: makeFrameworkMediaResultProjector(),
    async invoke(capability, request) {
      const ticket = request.scope.eventId;
      assert(!closed && !invocations.has(ticket), 'TOOL_CALL_CONFLICT', 'This tool event is already active.');
      const entry = { request, capability, completed: false } as {
        request: EffectRequest; capability: string; value?: JsonValue; error?: unknown; completed: boolean };
      invocations.set(ticket, entry);
      try {
        const report = await options.host.engine.emit({ ...(options.host.accountScope ? { accountScope: options.host.accountScope } : {}), id: ticket, type: NATIVE_TOOL_EVENT,
          conversationId: request.scope.conversationId, sessionId: request.scope.sessionId,
          data: { ticket, generation: request.scope.generation! } }, { signal: request.signal });
        if (entry.error) throw entry.error;
        assert(entry.completed && report.outcomes.some(outcome => outcome.featureId === NATIVE_TOOL_FEATURE && outcome.status === 'completed'),
          'TOOL_EXECUTION_UNKNOWN', 'The tool execution did not produce a confirmed result.');
        return entry.value ?? null;
      } finally { invocations.delete(ticket); }
    } });
  for (const definition of NATIVE_MEDIA_TOOLS) registry.register(definition, input => {
    assert(isRecord(input) && Object.keys(input).length === 1 && typeof input.assetId === 'string' && /^media-[a-f0-9]{64}$/.test(input.assetId),
      'INVALID_MEDIA_INPUT', 'A tool can only reference one registered media handle.');
    return { assetId: input.assetId };
  });
  for (const tool of additional) registry.register(tool.definition, tool.validate);
  const pump = createFrameworkToolPump({ port: options.port, issuerEpoch: options.issuerEpoch,
    accepts(pending) {
      const current = projections.get(pending.call.sessionId);
      return !closed && !options.signal.aborted && current?.leaseId === pending.leaseId && current.generation === pending.call.generation;
    }, async execute(call, signal) {
      observe(mapNativeToolObservation(call));
      try {
        const result = await registry.execute(call,signal);
        const binding = options.host.sessions.findBySessionId(call.sessionId,call.generation);
        observe(mapNativeToolObservation(call,result,binding?.conversationId));
        return result;
      } catch (error) {
        observe(mapNativeToolObservation(call,{status:'unknown',code:'TOOL_EXECUTION_UNKNOWN'}));
        throw error;
      }
    }, onFault(code) { channelError = code; } });

  async function permitted(conversationId: string, signal: AbortSignal, describe = false): Promise<readonly FrameworkToolDefinition[]> {
    const unavailable = await options.unavailableCapabilities?.(signal) ?? [];
    const policy = options.host.policy.describe();
    if (policy.paused) return [];
    const tools = registry.describe().filter(tool => !unavailable.includes(tool.capability) && policy.grants.some(grant => grant.active && grant.featureId === tool.featureId
      && grant.conversationId === conversationId && grant.capabilities.includes(tool.capability)
      && (grant.expiresAt === null || grant.expiresAt > Date.now())
      && (grant.maxUses[tool.capability] === null || (grant.maxUses[tool.capability] ?? 0) > (grant.used[tool.capability] ?? 0))));
    if (!describe || !options.toolDescriptions || tools.length === 0) return tools;
    const descriptions = await options.toolDescriptions(signal);
    return tools.map(tool => {
      const description = descriptions[tool.name];
      if (description === undefined) return tool;
      assert(typeof description === 'string' && description.length > 0 && description.length <= 4000,
        'INVALID_FRAMEWORK_TOOL', 'A tool description must be bounded.');
      return { ...tool, description };
    });
  }
  async function project(binding: SessionBinding, signal: AbortSignal) {
      signal.throwIfAborted(); options.signal.throwIfAborted();
      assert(!closed && channelError === null, 'TOOL_CHANNEL_UNKNOWN', 'The framework tool channel requires reconciliation.');
      await options.guard(binding.conversationId, signal);
      const tools = await permitted(binding.conversationId, signal, true);
      const names = tools.map(tool => tool.name);
      const definitionRevision = digest(tools);
      const current = projections.get(binding.sessionId);
      if (current && current.generation === binding.generation && current.definitionRevision === definitionRevision) return;
      const key = digest(binding.sessionId);
      const previous = options.store.read(namespace, key);
      const old = await options.port.inspect({ issuerEpoch: options.issuerEpoch, sessionId: binding.sessionId }, signal);
      if (old) {
        const recorded = previous ? object(previous.value) : null;
        const owned = recorded?.issuerEpoch === options.issuerEpoch && recorded.sessionId === binding.sessionId
          && recorded.generation === old.generation && recorded.leaseId === old.leaseId
          && Array.isArray(recorded.names) && digest(recorded.names) === digest(old.names);
        assert(owned || old.names.every(name => registry.describe().some(tool => tool.name === name)),
          'TOOL_PROJECTION_CONFLICT', 'The session contains an unrelated framework tool projection.');
        const withdrawn = await options.port.withdraw({ issuerEpoch: options.issuerEpoch, sessionId: binding.sessionId, leaseId: old.leaseId }, signal);
        assert(withdrawn, 'TOOL_PROJECTION_UNKNOWN', 'The previous projection could not be withdrawn.');
      }
      projections.delete(binding.sessionId);
      const pending = options.store.write(namespace, key, json({ schema: 1, issuerEpoch: options.issuerEpoch,
        sessionId: binding.sessionId, generation: binding.generation, names, leaseId: null, state: 'installing' }),
      { expectedRevision: previous?.revision ?? null });
      if (tools.length === 0) {
        options.store.write(namespace, key, { ...object(pending.value), state: 'withdrawn' }, { expectedRevision: pending.revision }); return;
      }
      let installed: Awaited<ReturnType<DshFrameworkToolPort['install']>>;
      try {
        installed = await options.port.install({ issuerEpoch: options.issuerEpoch,
          sessionId: binding.sessionId, generation: binding.generation, tools }, signal);
      } catch (error) {
        options.store.write(namespace, key, { ...object(pending.value), state: 'unknown',
          lastError: errorCode(error, 'TOOL_PROJECTION_UNKNOWN') }, { expectedRevision: pending.revision });
        throw error;
      }
      options.store.write(namespace, key, json({ ...object(pending.value), state: 'installed', leaseId: installed.leaseId }), { expectedRevision: pending.revision });
      projections.set(binding.sessionId, { ...installed, definitionRevision });
      if (!pumpStarted) { pumpStarted = true; pump.start(); }
    }
  const projectionOperations = new Map<string, Promise<void>>();
  const service = Object.freeze({
    feature,
    async context(conversationId: string, signal: AbortSignal) {
      if (closed || channelError !== null || options.signal.aborted) return { available: false, tools: [], reason: channelError ?? 'TOOL_CHANNEL_UNAVAILABLE' }
      await options.guard(conversationId, signal)
      const tools = await permitted(conversationId, signal)
      return { available: true, tools: tools.map(tool => ({ name: tool.name, description: tool.description })), reason: null }
    },
    project(binding: SessionBinding, signal: AbortSignal): Promise<void> {
      const previous = projectionOperations.get(binding.sessionId) ?? Promise.resolve();
      const operation = previous.catch(() => undefined).then(() => project(binding, signal));
      projectionOperations.set(binding.sessionId, operation);
      void operation.finally(() => { if (projectionOperations.get(binding.sessionId) === operation) projectionOperations.delete(binding.sessionId); }).catch(() => undefined);
      return operation;
    },
    inventory() { return registry.describe().map(tool => ({ name: tool.name, description: tool.description,
      registrationSource: tool.registrationSource ?? { origin: 'extension' as const, ownerId: tool.featureId, ownerName: tool.featureId, transport: 'native' as const },
      loadedInSession: [...projections.values()].some(projection => projection.names.includes(tool.name)) })); },
    describe() { return { schema: 1, available: !closed && channelError === null, reason: channelError, channel: pump.status(),
      tools: registry.describe().map(tool => ({ name: tool.name, capability: tool.capability })), projections: projections.size }; },
    async recoverPending(signal: AbortSignal) {
      const activeConversations = new Set(options.host.policy.describe().grants
        .filter(grant => grant.active && grant.featureId === NATIVE_TOOL_FEATURE).map(grant => grant.conversationId));
      for (const row of options.host.sessions.list({ limit: 1_000 })) {
        const binding = options.host.sessions.get(row.conversationId);
        if (!binding || !activeConversations.has(binding.conversationId)) continue;
        const previous = options.store.read(namespace, digest(binding.sessionId));
        const value = previous ? object(previous.value) : null;
        if (value?.generation === binding.generation && ['installing', 'unknown'].includes(String(value.state))) {
          // Reconcile the tool lease only; never resubmit the failed user prompt.
          await service.project(binding, signal);
        }
      }
    },
    async refresh(signal: AbortSignal) {
      for (const [sessionId, projection] of [...projections]) {
        const binding = options.host.sessions.findBySessionId(sessionId);
        if (binding?.generation === projection.generation) await service.project(binding, signal);
      }
    },
    async close(signal: AbortSignal) {
      closed = true; registry.close();
      await pump.close(signal);
      await Promise.allSettled([...projectionOperations.values()]);
      const failures = await Promise.allSettled([...projections].map(async ([sessionId, projection]) => {
        const confirmed = await options.port.withdraw({ issuerEpoch: options.issuerEpoch, sessionId, leaseId: projection.leaseId }, signal);
        if (!confirmed) throw new FrameworkError('TOOL_PROJECTION_WITHDRAW_UNKNOWN', 'Tool withdrawal was not confirmed.');
        const key = digest(sessionId); const prior = options.store.read(namespace, key);
        if (prior) options.store.write(namespace, key, { ...object(prior.value), state: 'withdrawn' }, { expectedRevision: prior.revision });
      }));
      projections.clear();
      const failed = failures.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw new FrameworkError(errorCode(failed.reason, 'TOOL_CHANNEL_STOP_UNKNOWN'), 'Tool cleanup is unverified.');
    },
  });
  return service;
}
