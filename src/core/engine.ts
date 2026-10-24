import { createHash } from 'node:crypto';
import { createContextStore, createFeatureState } from './context.ts';
import { createPolicy } from './policy.ts';
import { FrameworkError, assert, errorCode, identifier, isRecord, reference, snapshot } from './values.ts';
import type { AuditEntry, AuditRecord, Clock, DeliveryReceipt, EffectAdapter, EventReport, FeatureDefinition,
  FeatureExecution, FeatureHandler, FeatureManifest, FeatureOutcome, FeatureSetup, FrameworkEvent, JsonObject,
  JsonValue, ModelAdapter, TextContent, TransportAdapter } from './types.ts';

export interface EngineOptions {
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
  eventValidators?: Record<string, (data: JsonObject) => boolean>;
  effectAdapters?: Record<string, EffectAdapter>;
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
interface OutboxEntry {
  id: string;
  eventId: string;
  conversationId: string;
  featureId: string;
  version: string;
  status: 'queued' | 'sending' | 'confirmed' | 'unknown' | 'rejected' | 'denied';
  contentTypes: string[];
  messageId?: string;
  errorCode?: string;
}
interface EffectRecord { fingerprint: string; settled: boolean; view: OutboxEntry; promise: Promise<DeliveryReceipt> }
interface EventRecord { fingerprint: string; settled: boolean; promise: Promise<EventReport> }
interface Execution { view: FeatureExecution; finish(): Promise<void> }

const eventTypes = new Set(['message.received', 'trigger.fired']);
const capabilityTypes = new Set(['messaging.send', 'model.respond']);

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

function featureDefinition(feature: FeatureDefinition, supportedEvents: Set<string>, supportedCapabilities: Set<string>): FeatureManifest {
  assert(feature && identifier(feature.id) && !feature.id.includes('.')
    && typeof feature.version === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(feature.version)
    && feature.apiVersion === 1 && synchronous(feature.setup), 'INVALID_FEATURE', 'A versioned synchronous feature setup is required.');
  for (const [field, allowed] of [['capabilities', supportedCapabilities], ['subscriptions', supportedEvents]] as const) {
    assert(Array.isArray(feature[field]) && feature[field].every(value => allowed.has(value))
      && new Set(feature[field]).size === feature[field].length, 'INVALID_FEATURE', 'Feature contracts must use supported unique entries.');
  }
  return snapshot({ id: feature.id, version: feature.version, apiVersion: 1,
    capabilities: feature.capabilities, subscriptions: feature.subscriptions });
}

export function createEngine({ clock = Date.now, transport, model, context = createContextStore({ clock }), state = createFeatureState(),
  policy = createPolicy({ clock }), persona, observer = () => {}, historyLimit = 500,
  maxPendingEvents = 256, maxPendingEffects = 512, eventValidators = {}, effectAdapters = {} }: EngineOptions) {
  assert(transport && typeof transport.send === 'function', 'INVALID_ADAPTER', 'A transport adapter is required.');
  assert(reference(persona) && Number.isSafeInteger(historyLimit) && historyLimit > 0,
    'INVALID_ENGINE', 'A persona reference and a positive history limit are required.');
  assert([maxPendingEvents, maxPendingEffects].every(value => Number.isSafeInteger(value) && value > 0),
    'INVALID_ENGINE', 'Pending operation limits must be positive integers.');
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
  const conversationTails = new Map<string, Promise<EventReport>>();
  const events = new Map<string, EventRecord>();
  const effects = new Map<string, EffectRecord>();
  const audit: AuditRecord[] = [];
  let generation = 0;
  let sequence = 0;
  let stopped = false;
  let lifecycle = 'running';
  let stopPromise: Promise<void> | null = null;
  let lifecycleBusy = false;
  let outbound: Promise<unknown> = Promise.resolve();
  let pendingEventCount = 0;
  let pendingEffectCount = 0;

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

  function executionFor(record: FeatureRecord, event: FrameworkEvent): Execution {
    const featureId = record.definition.id;
    const base = { eventId: event.id, conversationId: event.conversationId, featureId, version: record.definition.version };
    let ordinal = 0;
    let open = true;
    const pendingEffects = new Set<Promise<unknown>>();

    function accessible() {
      assert(open, 'EXECUTION_CLOSED', 'The event execution has finished.');
      current(record);
    }

    function track<Result>(task: Promise<Result>): Promise<Result> {
      pendingEffects.add(task);
      task.catch(() => {});
      return task;
    }

    function effectSlot() {
      assert(pendingEffectCount < maxPendingEffects, 'EFFECT_BACKPRESSURE', 'The effect queue is full.');
      pendingEffectCount++;
      let released = false;
      return () => { if (!released) { released = true; pendingEffectCount--; } };
    }

    function authorize(capability: string) {
      current(record);
      assert(record.definition.capabilities.includes(capability), 'UNDECLARED_CAPABILITY', 'The feature did not declare this effect.');
      const reservation = policy.reserve({ featureId, conversationId: event.conversationId, capability });
      policy.begin(reservation);
    }

    async function generateEffect(prompt: JsonValue): Promise<{ text: string }> {
      const request = snapshot(prompt);
      assert(model && typeof model.generate === 'function', 'MODEL_UNAVAILABLE', 'No model adapter is installed.');
      const release = effectSlot();
      try {
        authorize('model.respond');
        const operation = model.generate({ prompt: request, signal: record.controller.signal });
        observe({ ...base, stage: 'model', status: 'started' });
        const result = await operation;
        current(record);
        assert(result && typeof result.text === 'string' && result.text.length <= 64000,
          'INVALID_MODEL_RESULT', 'The model returned an invalid text result.');
        observe({ ...base, stage: 'model', status: 'completed' });
        return snapshot({ text: result.text });
      } catch (error) {
        const code = errorCode(error, 'MODEL_FAILED');
        observe({ ...base, stage: 'model', status: 'failed', errorCode: code });
        throw new FrameworkError(code, 'The model operation did not complete.');
      } finally { release(); }
    }

    async function invokeEffect(capability: string, input: JsonValue): Promise<JsonValue> {
      const execute = adapters.get(capability);
      assert(execute, 'CAPABILITY_UNAVAILABLE', 'No custom adapter is installed for this capability.');
      const request = snapshot(input);
      const release = effectSlot();
      try {
        authorize(capability);
        const operation = execute(Object.freeze({ input: request, scope: snapshot(base), signal: record.controller.signal }));
        observe({ ...base, stage: 'effect', capability, status: 'started' });
        const result = snapshot(await operation);
        current(record);
        observe({ ...base, stage: 'effect', capability, status: 'completed' });
        return result;
      } catch (error) {
        const code = errorCode(error, 'ADAPTER_FAILED');
        observe({ ...base, stage: 'effect', capability, status: 'failed', errorCode: code });
        throw new FrameworkError(code, 'The custom effect did not complete.');
      } finally { release(); }
    }

    function send(content: readonly TextContent[]): Promise<DeliveryReceipt> {
      accessible();
      const message = snapshot(content);
      assert(Array.isArray(message) && message.length > 0 && message.length <= 8
        && message.every(block => block.type === 'text' && typeof block.text === 'string'
          && block.text.length > 0 && block.text.length <= 8000), 'INVALID_CONTENT', 'Only bounded text messages are supported.');
      const effectId = digest([event.conversationId, event.id, featureId, ordinal++]);
      const fingerprint = digest(message);
      const prior = effects.get(effectId);
      if (prior) {
        assert(prior.fingerprint === fingerprint, 'EFFECT_CONFLICT', 'An effect id cannot be reused for different content.');
        return track(prior.promise);
      }
      const release = effectSlot();
      const entry: EffectRecord = { fingerprint, settled: false, view: { id: effectId, ...base,
        status: 'queued', contentTypes: message.map(block => block.type) }, promise: Promise.resolve({ status: 'unknown' }) };
      const task = outbound.catch(() => {}).then(async () => {
        try { authorize('messaging.send'); }
        catch (error) {
          entry.view.status = 'denied';
          entry.view.errorCode = errorCode(error, 'EFFECT_DENIED');
          observe({ ...base, stage: 'send', status: 'denied', errorCode: entry.view.errorCode });
          throw new FrameworkError(entry.view.errorCode, 'The outbound effect was denied.');
        }
        entry.view.status = 'sending';
        let result: DeliveryReceipt;
        try {
          const operation = transport.send({ conversationId: event.conversationId, content: message,
            idempotencyKey: effectId, signal: record.controller.signal });
          observe({ ...base, stage: 'send', status: 'started' });
          const receipt = await operation;
          result = receipt?.status === 'confirmed' && reference(receipt.messageId)
            ? { status: 'confirmed', messageId: receipt.messageId }
            : receipt?.status === 'rejected' ? { status: 'rejected' } : { status: 'unknown' };
        } catch { result = { status: 'unknown' }; }
        Object.assign(entry.view, result);
        observe({ ...base, stage: 'send', status: result.status });
        return snapshot(result);
      });
      entry.promise = task;
      effects.set(effectId, entry);
      const settled = () => { release(); entry.settled = true; trim(effects); };
      task.then(settled, settled);
      outbound = task;
      return track(task);
    }

    const selection: { persona: string; conversationId: string; userId?: string; sessionId?: string; taskId?: string }
      = { persona, conversationId: event.conversationId };
    for (const key of ['userId', 'sessionId', 'taskId'] as const) if (event[key] !== undefined) selection[key] = event[key];
    const storage = state.scope(featureId, event.conversationId);
    return Object.freeze({
      view: Object.freeze({ context: context.resolve(selection), state: Object.freeze({
        get(key: string, fallback?: JsonValue) { accessible(); return storage.get(key, fallback); },
        set(key: string, value: JsonValue) { accessible(); return storage.set(key, value); },
        delete(key: string) { accessible(); return storage.delete(key); },
      }), signal: record.controller.signal,
      generate(prompt: JsonValue) { accessible(); return track(generateEffect(prompt)); },
      invoke(capability: string, input: JsonValue) { accessible(); return track(invokeEffect(capability, input)); }, send }),
      async finish() {
        open = false;
        const results = await Promise.allSettled([...pendingEffects]);
        assert(results.every(result => result.status === 'fulfilled'), 'EFFECT_FAILED', 'An initiated effect did not complete.');
      },
    });
  }

  async function dispatch(event: FrameworkEvent): Promise<EventReport> {
    assert(!stopped, 'ENGINE_STOPPED', 'The engine has stopped.');
    const outcomes: FeatureOutcome[] = [];
    observe({ stage: 'event', eventId: event.id, conversationId: event.conversationId, status: 'accepted' });
    for (const record of [...features.values()]) {
      const handler = record.handlers.get(event.type);
      if (record.status !== 'active' || !handler) continue;
      const run = Promise.resolve().then(async (): Promise<FeatureOutcome> => {
        let execution: Execution | undefined;
        let failure: string | null = null;
        try {
          execution = executionFor(record, event);
          current(record);
          await handler(execution.view, event);
        } catch (error) {
          failure = errorCode(error, 'FEATURE_FAILED');
        }
        if (execution) {
          try { await execution.finish(); }
          catch (error) { failure ??= errorCode(error, 'FEATURE_FAILED'); }
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

  function emit(input: unknown): Promise<EventReport> {
    assert(!stopped && !lifecycleBusy, 'ENGINE_STOPPED', 'The engine is stopped or changing lifecycle.');
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
    const key = JSON.stringify([event.conversationId, event.id]);
    const fingerprint = digest(event);
    const prior = events.get(key);
    if (prior) {
      assert(prior.fingerprint === fingerprint, 'EVENT_CONFLICT', 'An event id cannot be reused for different data.');
      return prior.promise;
    }
    assert(pendingEventCount < maxPendingEvents, 'EVENT_BACKPRESSURE', 'The event queue is full.');
    pendingEventCount++;
    const task = (conversationTails.get(event.conversationId) ?? Promise.resolve()).catch(() => {}).then(() => dispatch(event));
    const entry: EventRecord = { fingerprint, settled: false, promise: task };
    events.set(key, entry);
    conversationTails.set(event.conversationId, task);
    const settled = () => {
      pendingEventCount--;
      entry.settled = true;
      if (conversationTails.get(event.conversationId) === task) conversationTails.delete(event.conversationId);
      trim(events);
    };
    task.then(settled, settled);
    return task;
  }

  return Object.freeze({
    install, uninstall, emit,
    describe() {
      return snapshot({ status: lifecycle, apiVersion: 1,
        contracts: { eventTypes: [...supportedEvents], capabilities: [...supportedCapabilities] },
        queues: { pendingEvents: pendingEventCount, pendingEffects: pendingEffectCount, maxPendingEvents, maxPendingEffects },
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
        await Promise.allSettled([...conversationTails.values(), outbound]);
        const clean = results.every(result => result.status === 'fulfilled');
        lifecycle = clean ? 'stopped' : 'failed';
        assert(clean, 'CLEANUP_FAILED', 'Some features did not clean up.');
      })();
      return stopPromise;
    },
  });
}
