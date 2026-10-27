import { extensionMetadata, validExtensionMetadata } from '../contracts/extension-metadata.ts';
import { assertAccountScope, normalizeAccountScope } from './account-scope.ts';
import type { AccountScope } from '../contracts/account-scope.ts';
import { normalizeDeliveryReceipt } from './delivery.ts';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createContextStore, createFeatureState } from './context.ts';
import { createPolicy } from './policy.ts';
import { normalizeContent } from './content.ts';
import { normalizeOutboundScope } from './scope.ts';
import { FrameworkError, assert, errorCode, identifier, isRecord, reference, snapshot } from './values.ts';
import type { AuditEntry, AuditRecord, Clock, DeliveryReceipt, EffectAdapter, EventReport, FeatureDefinition,
  FeatureExecution, FeatureHandler, FeatureManifest, FeatureOutcome, FeatureSetup, FrameworkEvent, JsonObject,
  JsonValue, ModelAdapter, MessageContent, TransportAdapter } from './types.ts';
import type { FeatureStateScope } from './context.ts';

export interface EngineOptions {
  accountScope?: AccountScope;
  clock?: Clock;
  transport: TransportAdapter;
  model?: ModelAdapter;
  context?: ReturnType<typeof createContextStore>;
  state?: ReturnType<typeof createFeatureState>;
  policy?: ReturnType<typeof createPolicy>;
  persona: string;
  observer?: (entry: AuditRecord) => unknown;
  historyLimit?: number;
  maxPendingEvents?: number;
  maxPendingEffects?: number;
  yieldEvery?: number;
  yieldAfterMs?: number;
  maxConcurrentSends?: number;
  eventTimeoutMs?: number;
  eventValidators?: Record<string, (data: JsonObject) => boolean>;
  effectAdapters?: Record<string, EffectAdapter>;
}
export interface EmitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
interface FeatureRecord {
  definition: FeatureManifest;
  generation: number;
  status: 'installing' | 'active' | 'stopping' | 'stopped' | 'failed';
  handlers: Map<string, FeatureHandler>;
  cleanups: Array<() => void>;
  inflight: Set<Promise<FeatureOutcome>>;
  controller: AbortController;
  faultCodes: string[];
  stopPromise?: Promise<boolean>;
}
export interface OutboxEntry {
  id: string;
  eventId: string;
  conversationId: string;
  featureId: string;
  version: string;
  status: 'queued' | 'sending' | 'confirmed' | 'unknown' | 'rejected' | 'denied';
  contentTypes: string[];
  messageId?: string;
  kind?: 'file-upload';
  fileId?: string;
  name?: string;
  errorCode?: string;
}
interface EffectRecord { fingerprint: string; settled: boolean; view: OutboxEntry; promise: Promise<DeliveryReceipt> }
interface EventRecord { fingerprint: string; settled: boolean; promise: Promise<EventReport> }
interface EventDeadline {
  signal: AbortSignal;
  reached: Promise<void>;
  expired(): boolean;
  failureCode(uncertain?: boolean): string;
  dispose(): void;
}
interface Execution { view: FeatureExecution; finish(): Promise<void>; timeoutCode(): string }

const eventTypes = new Set(['message.received', 'trigger.fired']);
const capabilityTypes = new Set(['messaging.send', 'messaging.forward', 'model.respond']);

function digest(value: unknown): string {
  const normalized = JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
  return createHash('sha256').update(normalized).digest('hex');
}

function synchronous(callback: unknown): callback is (...argumentsValue: never[]) => unknown {
  return typeof callback === 'function' && !['AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction'].includes(callback.constructor?.name);
}

function noPromise(value: unknown) {
  if ((isRecord(value) || typeof value === 'function') && 'then' in value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {});
    throw new FrameworkError('ASYNC_SETUP', 'Setup and cleanup must be synchronous.');
  }
}

function createEventDeadline(timeoutMs: number, parentSignal?: AbortSignal): EventDeadline {
  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  let expired = false;
  let endedBy: 'EVENT_TIMEOUT' | 'EVENT_ABORTED' = 'EVENT_TIMEOUT';
  let reach!: () => void;
  const reached = new Promise<void>(resolve => { reach = resolve; });
  const expire = (code: 'EVENT_TIMEOUT' | 'EVENT_ABORTED') => {
    if (expired) return;
    expired = true;
    endedBy = code;
    controller.abort(new FrameworkError(code, 'The event execution ended.'));
    reach();
  };
  const abort = () => expire('EVENT_ABORTED');
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => expire('EVENT_TIMEOUT'), timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    reached,
    expired() {
      if (!expired && performance.now() >= expiresAt) expire('EVENT_TIMEOUT');
      return expired;
    },
    failureCode(uncertain = false) { return uncertain ? `${endedBy}_UNKNOWN` : endedBy; },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
    },
  });
}

async function beforeDeadline<Result>(operation: PromiseLike<Result> | Result, deadline: EventDeadline,
  uncertain = false): Promise<Result> {
  const observed = Promise.resolve(operation).then(value => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }));
  if (deadline.expired()) throw new FrameworkError(deadline.failureCode(uncertain), 'The event execution ended.');
  const outcome = await Promise.race([
    observed,
    deadline.reached.then(() => ({ status: 'timeout' as const })),
  ]);
  if (outcome.status === 'timeout' || deadline.expired()) {
    throw new FrameworkError(deadline.failureCode(uncertain), 'The event execution ended.');
  }
  if (outcome.status === 'rejected') throw outcome.reason;
  return outcome.value;
}

function featureDefinition(feature: FeatureDefinition, supportedEvents: Set<string>, supportedCapabilities: Set<string>): FeatureManifest {
  assert(feature && validExtensionMetadata(feature) && identifier(feature.id) && !feature.id.includes('.')
    && typeof feature.version === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(feature.version)
    && feature.apiVersion === 1 && synchronous(feature.setup), 'INVALID_FEATURE', 'A versioned synchronous feature setup is required.');
  for (const [field, allowed] of [['capabilities', supportedCapabilities], ['subscriptions', supportedEvents]] as const) {
    assert(Array.isArray(feature[field]) && feature[field].every(value => allowed.has(value))
      && new Set(feature[field]).size === feature[field].length, 'INVALID_FEATURE', 'Feature contracts must use supported unique entries.');
  }
  return snapshot({ id: feature.id, version: feature.version, apiVersion: 1, ...extensionMetadata(feature),
    capabilities: feature.capabilities, subscriptions: feature.subscriptions });
}

export function createEngine({ clock = Date.now, transport, model, context = createContextStore({ clock }), state = createFeatureState(),
  accountScope: accountInput, policy: policyInput, persona, observer = () => {}, historyLimit = 500,
  maxPendingEvents = 256, maxPendingEffects = 512, yieldEvery = 64, yieldAfterMs = 8, maxConcurrentSends = 1,
  eventTimeoutMs = 30000, eventValidators = {}, effectAdapters = {} }: EngineOptions) {
  const accountScope = accountInput === undefined ? undefined : normalizeAccountScope(accountInput);
  const policy = policyInput ?? createPolicy({ clock, accountScope });
  assert(transport && typeof transport.send === 'function', 'INVALID_ADAPTER', 'A transport adapter is required.');
  assert(reference(persona) && Number.isSafeInteger(historyLimit) && historyLimit > 0,
    'INVALID_ENGINE', 'A persona reference and a positive history limit are required.');
  assert([maxPendingEvents, maxPendingEffects, yieldEvery, maxConcurrentSends].every(value => Number.isSafeInteger(value) && value > 0),
    'INVALID_ENGINE', 'Pending operation limits must be positive integers.');
  assert(Number.isFinite(yieldAfterMs) && yieldAfterMs > 0, 'INVALID_ENGINE', 'The scheduling time budget must be positive.');
  assert(Number.isSafeInteger(eventTimeoutMs) && eventTimeoutMs >= 10 && eventTimeoutMs <= 300000,
    'INVALID_ENGINE', 'The event timeout must be an integer between 10 and 300000 milliseconds.');
  assert(eventValidators && typeof eventValidators === 'object' && !Array.isArray(eventValidators)
    && effectAdapters && typeof effectAdapters === 'object' && !Array.isArray(effectAdapters),
  'INVALID_EXTENSION', 'Host extension registries must be objects.');
  const validators = new Map(Object.entries(eventValidators));
  const adapters = new Map(Object.entries(effectAdapters).map(([capability, adapter]) => [capability, adapter?.execute]));
  assert([...validators].every(([type, validate]) => identifier(type) && !eventTypes.has(type) && synchronous(validate))
    && [...adapters].every(([capability, execute]) => identifier(capability) && !capabilityTypes.has(capability) && typeof execute === 'function'),
  'INVALID_EXTENSION', 'Host extensions require unique names and valid callbacks.');
  const supportedEvents = new Set([...eventTypes, ...validators.keys()]);
  const supportedCapabilities = new Set([...capabilityTypes, ...adapters.keys()]);
  const features = new Map<string, FeatureRecord>();
  const subscriptions = new Map<string, Set<FeatureRecord>>();
  const conversationTails = new Map<string, Promise<void>>();
  const events = new Map<string, EventRecord>();
  const effects = new Map<string, EffectRecord>();
  const audit: AuditRecord[] = [];
  let generation = 0;
  let sequence = 0;
  let stopped = false;
  let lifecycle = 'running';
  let stopPromise: Promise<void> | null = null;
  let lifecycleBusy = false;
  const outboundTails = new Map<string, Promise<DeliveryReceipt>>();
  const sendWaiters: Array<() => void> = [];
  let activeSends = 0;
  let pendingEventCount = 0;
  let pendingEffectCount = 0;
  let rawPendingEffectCount = 0;
  let dispatchesSinceYield = 0;
  let yieldGate: Promise<void> | null = null;
  let turnStartedAt = performance.now();

  async function cooperate() {
    if (yieldGate) await yieldGate;
    if (++dispatchesSinceYield < yieldEvery && performance.now() - turnStartedAt < yieldAfterMs) return;
    dispatchesSinceYield = 0;
    const gate = nextTurn();
    yieldGate = gate;
    await gate;
    if (yieldGate === gate) { yieldGate = null; turnStartedAt = performance.now(); }
  }

  async function acquireSendSlot(deadline: EventDeadline) {
    assert(!deadline.expired(), deadline.failureCode(), 'The event execution ended before sending.');
    if (activeSends < maxConcurrentSends) { activeSends++; return; }
    let acquired = false;
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    const waiter = () => { acquired = true; resume(); };
    sendWaiters.push(waiter);
    try {
      await beforeDeadline(waiting, deadline);
      assert(!deadline.expired(), deadline.failureCode(), 'The event execution ended before sending.');
    } catch (error) {
      if (acquired) releaseSendSlot();
      else {
        const index = sendWaiters.indexOf(waiter);
        if (index >= 0) sendWaiters.splice(index, 1);
      }
      throw error;
    }
  }

  function releaseSendSlot() {
    const waiting = sendWaiters.shift();
    if (waiting) waiting();
    else activeSends--;
  }

  function rawEffectSlot() {
    assert(rawPendingEffectCount < maxPendingEffects,
      'EFFECT_BACKPRESSURE', 'The raw effect limit is full.');
    rawPendingEffectCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      rawPendingEffectCount--;
    };
  }

  function observe(entry: AuditEntry) {
    const record = snapshot({ sequence: ++sequence, at: clock(), ...entry });
    audit.push(record);
    if (audit.length > historyLimit) audit.shift();
    try {
      const pending = observer(record);
      if (isRecord(pending) && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
    } catch {}
  }

  function trim<RecordType extends { settled: boolean }>(records: Map<string, RecordType>) {
    for (const [key, record] of records) {
      if (records.size <= historyLimit) break;
      if (record.settled) records.delete(key);
    }
  }

  function current(record: FeatureRecord) {
    assert(!stopped && record.status === 'active' && !record.controller.signal.aborted,
      'FEATURE_STOPPED', 'The feature is no longer active.');
  }

  function clean(record: FeatureRecord) {
    let failed = false;
    for (const dispose of record.cleanups.splice(0).reverse()) {
      try { noPromise(dispose()); } catch { failed = true; }
    }
    for (const type of record.handlers.keys()) {
      const subscribers = subscriptions.get(type);
      subscribers?.delete(record);
      if (subscribers?.size === 0) subscriptions.delete(type);
    }
    record.handlers.clear();
    if (failed) record.faultCodes.push('CLEANUP_FAILED');
    return failed;
  }

  function install(feature: FeatureDefinition) {
    assert(!stopped && !lifecycleBusy, 'LIFECYCLE_BUSY', 'The engine is stopped or changing lifecycle.');
    const definition = featureDefinition(feature, supportedEvents, supportedCapabilities);
    const previous = features.get(definition.id);
    assert(!previous || !['active', 'stopping'].includes(previous.status), 'FEATURE_EXISTS', 'Uninstall the feature before replacement.');
    assert(!previous || !previous.faultCodes.includes('CLEANUP_FAILED'), 'CLEANUP_REQUIRED', 'Resolve failed cleanup before reinstalling.');
    const record: FeatureRecord = { definition, generation: ++generation, status: 'installing', handlers: new Map(),
      cleanups: [], inflight: new Set(), controller: new AbortController(), faultCodes: [] };
    features.delete(definition.id);
    features.set(definition.id, record);
    const setupContext: FeatureSetup = Object.freeze({
      signal: record.controller.signal,
      on(type: string, handler: FeatureHandler) {
        assert(record.status === 'installing', 'CONTEXT_CLOSED', 'Registration is only available during setup.');
        assert(definition.subscriptions.includes(type) && !record.handlers.has(type) && typeof handler === 'function',
          'INVALID_SUBSCRIPTION', 'Register each declared event handler exactly once.');
        record.handlers.set(type, handler);
      },
      defer(dispose: () => void) {
        assert(record.status === 'installing', 'CONTEXT_CLOSED', 'Registration is only available during setup.');
        assert(synchronous(dispose), 'ASYNC_SETUP', 'Cleanup must be synchronous.');
        record.cleanups.push(dispose);
      },
    });
    lifecycleBusy = true;
    try {
      const dispose = feature.setup(setupContext);
      noPromise(dispose);
      if (dispose !== undefined) setupContext.defer(dispose);
      assert(record.handlers.size === definition.subscriptions.length, 'MISSING_HANDLER', 'All declared event handlers must be registered.');
      record.status = 'active';
      for (const type of record.handlers.keys()) {
        let subscribers = subscriptions.get(type);
        if (!subscribers) { subscribers = new Set(); subscriptions.set(type, subscribers); }
        subscribers.add(record);
      }
      observe({ stage: 'feature.install', featureId: definition.id, version: definition.version, status: 'active' });
      return definition;
    } catch (error) {
      record.status = 'failed';
      record.faultCodes.push(errorCode(error, 'SETUP_FAILED'));
      record.controller.abort();
      clean(record);
      observe({ stage: 'feature.install', featureId: definition.id, version: definition.version,
        status: 'failed', errorCode: errorCode(error, 'SETUP_FAILED') });
      throw new FrameworkError(errorCode(error, 'SETUP_FAILED'), 'Feature setup failed without publishing handlers.');
    } finally { lifecycleBusy = false; }
  }

  async function uninstall(id: string): Promise<boolean> {
    assert(!lifecycleBusy, 'LIFECYCLE_BUSY', 'Setup is in progress.');
    const record = features.get(id);
    if (record?.status === 'stopping') return record.stopPromise!;
    if (!record || record.status !== 'active') return false;
    record.status = 'stopping';
    record.controller.abort();
    record.stopPromise = (async () => {
      await Promise.allSettled([...record.inflight]);
      record.status = clean(record) ? 'failed' : 'stopped';
      observe({ stage: 'feature.uninstall', featureId: record.definition.id, version: record.definition.version, status: record.status });
      assert(record.status === 'stopped', 'CLEANUP_FAILED', 'Feature cleanup did not complete.');
      return true;
    })();
    return record.stopPromise;
  }

  function executionFor(record: FeatureRecord, event: FrameworkEvent, deadline: EventDeadline): Execution {
    const featureId = record.definition.id;
    const base = { ...(accountScope ? { accountScope } : {}), eventId: event.id, conversationId: event.conversationId, featureId, version: record.definition.version };
    const resolved = context.resolve({ persona, conversationId: event.conversationId, userId: event.userId,
      sessionId: event.sessionId, taskId: event.taskId });
    const outboundScope = normalizeOutboundScope({ ...(accountScope ? { accountScope } : {}), persona: { id: resolved.persona.id, version: resolved.persona.version },
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
      ...(event.sessionId !== undefined && Number.isSafeInteger(event.data.generation) && Number(event.data.generation) > 0
        ? { generation: event.data.generation } : {}) });
    let ordinal = 0;
    let open = true;
    const pendingEffects = new Set<Promise<unknown>>();
    let effectFailed = false;
    let activeExternalEffects = 0;
    let uncertain = false;
    const executionSignal = AbortSignal.any([record.controller.signal, deadline.signal]);
    deadline.signal.addEventListener('abort', () => {
      open = false;
      if (activeExternalEffects > 0) uncertain = true;
    }, { once: true });

    function accessible() {
      assert(!deadline.expired(), deadline.failureCode(), 'The event execution ended.');
      assert(open, 'EXECUTION_CLOSED', 'The event execution has finished.');
      current(record);
    }

    function track<Result>(task: Promise<Result>): Promise<Result> {
      pendingEffects.add(task);
      task.then(() => pendingEffects.delete(task), () => { effectFailed = true; pendingEffects.delete(task); });
      return task;
    }

    function effectSlot() {
      assert(pendingEffectCount < maxPendingEffects, 'EFFECT_BACKPRESSURE', 'The effect queue is full.');
      pendingEffectCount++;
      let released = false;
      return () => { if (!released) { released = true; pendingEffectCount--; } };
    }

    function authorize(capability: string) {
      accessible();
      assert(record.definition.capabilities.includes(capability), 'UNDECLARED_CAPABILITY', 'The feature did not declare this effect.');
      const reservation = policy.reserve({ featureId, conversationId: event.conversationId, capability, ...(accountScope ? { accountScope } : {}) });
      policy.begin(reservation);
    }

    async function generateEffect(prompt: JsonValue): Promise<{ text: string }> {
      const request = snapshot(prompt);
      assert(model && typeof model.generate === 'function', 'MODEL_UNAVAILABLE', 'No model adapter is installed.');
      const release = effectSlot();
      let releaseRaw: (() => void) | undefined;
      let rawTracked = false;
      try {
        releaseRaw = rawEffectSlot();
        authorize('model.respond');
        const operation = Promise.resolve(model.generate({ prompt: request, signal: executionSignal }));
        rawTracked = true;
        operation.then(releaseRaw, releaseRaw);
        activeExternalEffects++;
        observe({ ...base, stage: 'model', status: 'started' });
        let result: { text: string };
        try { result = await beforeDeadline(operation, deadline, true); }
        finally { activeExternalEffects--; }
        accessible();
        assert(result && typeof result.text === 'string' && result.text.length <= 64000,
          'INVALID_MODEL_RESULT', 'The model returned an invalid text result.');
        observe({ ...base, stage: 'model', status: 'completed' });
        return snapshot({ text: result.text });
      } catch (error) {
        const code = errorCode(error, 'MODEL_FAILED');
        observe({ ...base, stage: 'model', status: 'failed', errorCode: code });
        throw new FrameworkError(code, 'The model operation did not complete.');
      } finally {
        if (releaseRaw && !rawTracked) releaseRaw();
        release();
      }
    }

    async function invokeEffect(capability: string, input: JsonValue): Promise<JsonValue> {
      const execute = adapters.get(capability);
      assert(execute, 'CAPABILITY_UNAVAILABLE', 'No custom adapter is installed for this capability.');
      const request = snapshot(input);
      const release = effectSlot();
      let releaseRaw: (() => void) | undefined;
      let rawTracked = false;
      try {
        releaseRaw = rawEffectSlot();
        authorize(capability);
        const operation = Promise.resolve(execute(Object.freeze({ input: request, scope: snapshot({ ...base, ...outboundScope }), signal: executionSignal })));
        rawTracked = true;
        operation.then(releaseRaw, releaseRaw);
        activeExternalEffects++;
        observe({ ...base, stage: 'effect', capability, status: 'started' });
        let output: JsonValue;
        try { output = await beforeDeadline(operation, deadline, true); }
        finally { activeExternalEffects--; }
        const result = snapshot(output);
        accessible();
        observe({ ...base, stage: 'effect', capability, status: 'completed' });
        return result;
      } catch (error) {
        const code = errorCode(error, 'ADAPTER_FAILED');
        observe({ ...base, stage: 'effect', capability, status: 'failed', errorCode: code });
        throw new FrameworkError(code, 'The custom effect did not complete.');
      } finally {
        if (releaseRaw && !rawTracked) releaseRaw();
        release();
      }
    }

    function send(content: readonly MessageContent[]): Promise<DeliveryReceipt> {
      accessible();
      const message = normalizeContent(content);
      const effectId = digest([...(accountScope ? [accountScope] : []), event.conversationId, event.id, featureId, ordinal++]);
      const fingerprint = digest(message);
      const prior = effects.get(effectId);
      if (prior) {
        assert(prior.fingerprint === fingerprint, 'EFFECT_CONFLICT', 'An effect id cannot be reused for different content.');
        return track(prior.promise);
      }
      const release = effectSlot();
      const entry: EffectRecord = { fingerprint, settled: false, view: { id: effectId, ...base,
        status: 'queued', contentTypes: message.map(block => block.type) }, promise: Promise.resolve({ status: 'unknown' }) };
      const outboundKey = maxConcurrentSends === 1 ? 'global' : event.conversationId;
      const previous = outboundTails.get(outboundKey) ?? Promise.resolve<DeliveryReceipt>({ status: 'unknown' });
      const task = (async (): Promise<DeliveryReceipt> => {
        let acquired = false;
        let releaseRaw: (() => void) | undefined;
        let rawTracked = false;
        try {
          await beforeDeadline(previous.catch(() => ({ status: 'unknown' as const })), deadline);
          accessible();
          await acquireSendSlot(deadline);
          acquired = true;
          accessible();
          releaseRaw = rawEffectSlot();
          try {
            if (message.some(block => block.type === 'forward')) authorize('messaging.forward');
            authorize('messaging.send');
          }
          catch (error) {
            entry.view.status = 'denied';
            entry.view.errorCode = errorCode(error, 'EFFECT_DENIED');
            observe({ ...base, stage: 'send', status: 'denied', errorCode: entry.view.errorCode });
            throw new FrameworkError(entry.view.errorCode, 'The outbound effect was denied.');
          }
          entry.view.status = 'sending';
          let result: DeliveryReceipt;
          try {
            const operation = Promise.resolve(transport.send({ conversationId: event.conversationId, content: message,
              idempotencyKey: effectId, signal: executionSignal, scope: outboundScope }));
            rawTracked = true;
            operation.then(releaseRaw, releaseRaw);
            activeExternalEffects++;
            observe({ ...base, stage: 'send', status: 'started' });
            let receipt: DeliveryReceipt;
            try { receipt = await beforeDeadline(operation, deadline, true); }
            finally { activeExternalEffects--; }
            result = normalizeDeliveryReceipt(receipt);
          } catch (error) {
            result = { status: 'unknown' };
            const code = errorCode(error, 'SEND_UNKNOWN');
            if (code === 'EVENT_TIMEOUT_UNKNOWN' || code === 'EVENT_ABORTED_UNKNOWN') entry.view.errorCode = code;
          }
          Object.assign(entry.view, result);
          observe({ ...base, stage: 'send', status: result.status });
          return snapshot(result);
        } catch (error) {
          const code = errorCode(error, 'EFFECT_DENIED');
          if (entry.view.status === 'queued') {
            entry.view.status = 'denied';
            entry.view.errorCode = code;
            observe({ ...base, stage: 'send', status: 'denied', errorCode: code });
          }
          throw error;
        } finally {
          if (releaseRaw && !rawTracked) releaseRaw();
          if (acquired) releaseSendSlot();
        }
      })();
      entry.promise = task;
      effects.set(effectId, entry);
      const settled = () => {
        release(); entry.settled = true; trim(effects);
        if (outboundTails.get(outboundKey) === task) outboundTails.delete(outboundKey);
      };
      task.then(settled, settled);
      outboundTails.set(outboundKey, task);
      return track(task);
    }

    let storage: FeatureStateScope | undefined;
    const privateStorage = () => storage ??= state.scope(featureId, event.conversationId);
    return Object.freeze({
      view: Object.freeze({ context: resolved, state: Object.freeze({
        get(key: string, fallback?: JsonValue) { accessible(); return privateStorage().get(key, fallback); },
        set(key: string, value: JsonValue) { accessible(); return privateStorage().set(key, value); },
        delete(key: string) { accessible(); return privateStorage().delete(key); },
      }), signal: executionSignal,
      generate(prompt: JsonValue) { accessible(); return track(generateEffect(prompt)); },
      invoke(capability: string, input: JsonValue) { accessible(); return track(invokeEffect(capability, input)); }, send }),
      async finish() {
        open = false;
        const results = await beforeDeadline(Promise.allSettled([...pendingEffects]), deadline, uncertain);
        assert(!effectFailed && results.every(result => result.status === 'fulfilled'), 'EFFECT_FAILED', 'An initiated effect did not complete.');
      },
      timeoutCode() { return deadline.failureCode(uncertain); },
    });
  }

  function interruptedReport(event: FrameworkEvent, code: string): EventReport {
    const outcomes = [...(subscriptions.get(event.type) ?? [])]
      .filter(record => record.status === 'active' && record.handlers.has(event.type))
      .map(record => ({ featureId: record.definition.id, status: 'failed' as const, errorCode: code }));
    observe({ stage: 'event', eventId: event.id, conversationId: event.conversationId,
      status: 'failed', errorCode: code });
    return snapshot({ eventId: event.id, conversationId: event.conversationId, outcomes });
  }

  async function dispatch(event: FrameworkEvent, deadline: EventDeadline): Promise<EventReport> {
    await cooperate();
    assert(!stopped, 'ENGINE_STOPPED', 'The engine has stopped.');
    if (deadline.expired()) return interruptedReport(event, deadline.failureCode());
    const outcomes: FeatureOutcome[] = [];
    observe({ stage: 'event', eventId: event.id, conversationId: event.conversationId, status: 'accepted' });
    let handled = 0;
    for (const record of [...(subscriptions.get(event.type) ?? [])]) {
      if (handled++ > 0) await cooperate();
      const handler = record.handlers.get(event.type);
      if (record.status !== 'active' || !handler) continue;
      if (deadline.expired()) {
        outcomes.push({ featureId: record.definition.id, status: 'failed', errorCode: deadline.failureCode() });
        continue;
      }
      const run = Promise.resolve().then(async (): Promise<FeatureOutcome> => {
        let execution: Execution | undefined;
        let failure: string | null = null;
        try {
          execution = executionFor(record, event, deadline);
          current(record);
          await beforeDeadline(Promise.resolve().then(() => handler(execution!.view, event)), deadline);
        } catch (error) {
          failure = errorCode(error, 'FEATURE_FAILED');
        }
        if (execution) {
          try { await execution.finish(); }
          catch (error) { failure ??= errorCode(error, 'FEATURE_FAILED'); }
          if (deadline.expired()) failure = execution.timeoutCode();
        }
        return failure ? { featureId: record.definition.id, status: 'failed', errorCode: failure }
          : { featureId: record.definition.id, status: 'completed' };
      });
      record.inflight.add(run);
      const outcome = await run;
      record.inflight.delete(run);
      outcomes.push(outcome);
      observe({ stage: 'feature.execute', eventId: event.id, conversationId: event.conversationId,
        version: record.definition.version, ...outcome });
    }
    return snapshot({ eventId: event.id, conversationId: event.conversationId, outcomes });
  }

  function emit(input: unknown, options: EmitOptions = {}): Promise<EventReport> {
    assert(!stopped && !lifecycleBusy, 'ENGINE_STOPPED', 'The engine is stopped or changing lifecycle.');
    assert(options !== null && typeof options === 'object' && !Array.isArray(options)
      && (options.signal === undefined || options.signal instanceof AbortSignal)
      && (options.timeoutMs === undefined || (Number.isSafeInteger(options.timeoutMs)
        && options.timeoutMs >= 10 && options.timeoutMs <= eventTimeoutMs)),
    'INVALID_EVENT_OPTIONS', 'Event options require a valid signal and bounded timeout.');
    const value = snapshot(input);
    assert(isRecord(value) && reference(value.id) && reference(value.conversationId) && typeof value.type === 'string'
      && supportedEvents.has(value.type) && isRecord(value.data),
    'INVALID_EVENT', 'A supported, identified event with object data is required.');
    const event = value as unknown as FrameworkEvent;
    for (const field of ['userId', 'sessionId', 'taskId'] as const) {
      assert(event[field] === undefined || reference(event[field]), 'INVALID_EVENT', 'Event scope identifiers are invalid.');
    }
    if (validators.has(event.type)) {
      let valid = false;
      try { valid = validators.get(event.type)!(event.data) === true; } catch {}
      assert(valid, 'INVALID_EVENT', 'The custom event data did not satisfy its host contract.');
    }
    assertAccountScope(accountScope, event.accountScope);
    const key = JSON.stringify([...(accountScope ? [accountScope] : []), event.conversationId, event.id]);
    const fingerprint = digest(event);
    const prior = events.get(key);
    if (prior) {
      assert(prior.fingerprint === fingerprint, 'EVENT_CONFLICT', 'An event id cannot be reused for different data.');
      return prior.promise;
    }
    assert(pendingEventCount < maxPendingEvents, 'EVENT_BACKPRESSURE', 'The event queue is full.');
    pendingEventCount++;
    const deadline = createEventDeadline(options.timeoutMs ?? eventTimeoutMs, options.signal);
    const priorTail = conversationTails.get(event.conversationId) ?? Promise.resolve();
    let releaseTail!: () => void;
    const tail = new Promise<void>(resolve => { releaseTail = resolve; });
    let dispatchStarted = false;
    const task = (async () => {
      try {
        await beforeDeadline(priorTail, deadline);
      }
      catch (error) {
        const code = errorCode(error, deadline.failureCode());
        if (code === 'EVENT_TIMEOUT' || code === 'EVENT_ABORTED') return interruptedReport(event, code);
        throw error;
      }
      if (deadline.expired()) return interruptedReport(event, deadline.failureCode());
      dispatchStarted = true;
      return dispatch(event, deadline);
    })();
    const entry: EventRecord = { fingerprint, settled: false, promise: task };
    events.set(key, entry);
    conversationTails.set(event.conversationId, tail);
    const settled = () => {
      pendingEventCount--;
      deadline.dispose();
      entry.settled = true;
      const release = () => {
        releaseTail();
        if (conversationTails.get(event.conversationId) === tail) conversationTails.delete(event.conversationId);
      };
      if (dispatchStarted) release();
      else priorTail.then(release, release);
      trim(events);
    };
    task.then(settled, settled);
    return task;
  }

  return Object.freeze({
    install, uninstall, emit,
    metrics() {
      return snapshot({ status: lifecycle,
        queues: { pendingEvents: pendingEventCount, pendingEffects: pendingEffectCount,
          rawPendingEffects: rawPendingEffectCount, maxPendingEvents, maxPendingEffects },
        retention: { events: events.size, effects: effects.size, audit: audit.length },
        scheduling: { yieldEvery, yieldAfterMs, maxConcurrentSends, activeSends, waitingSends: sendWaiters.length },
      });
    },
    describe() {
      return snapshot({ status: lifecycle, apiVersion: 1,
        contracts: { eventTypes: [...supportedEvents], capabilities: [...supportedCapabilities] },
        queues: { pendingEvents: pendingEventCount, pendingEffects: pendingEffectCount,
          rawPendingEffects: rawPendingEffectCount, maxPendingEvents, maxPendingEffects },
        features: [...features.values()].map(record => ({ ...record.definition, generation: record.generation,
          status: record.status, faultCodes: record.faultCodes })),
        outbox: [...effects.values()].map(entry => entry.view), audit });
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      lifecycle = 'stopping';
      stopPromise = (async () => {
        const results = await Promise.allSettled([...features.keys()].map(id => uninstall(id)));
        await Promise.allSettled([...conversationTails.values(), ...outboundTails.values()]);
        const clean = results.every(result => result.status === 'fulfilled');
        lifecycle = clean ? 'stopped' : 'failed';
        assert(clean, 'CLEANUP_FAILED', 'Some features did not clean up.');
      })();
      return stopPromise;
    },
  });
}
