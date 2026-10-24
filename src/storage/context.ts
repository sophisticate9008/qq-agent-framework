import { createContextStore } from '../core/context.ts';
import type { Clock, JsonObject, JsonValue } from '../core/types.ts';
import { FrameworkError, assert, isRecord, snapshot } from '../core/values.ts';
import type { DurableStore, StoredRecord } from '../host/types.ts';

const PERSONA_NAMESPACE = 'context.personas';
const CONFIGURATION_NAMESPACE = 'context.configurations';
const PREFERENCE_NAMESPACE = 'context.preferences';
const PAGE_SIZE = 1_000;

type CoreContext = ReturnType<typeof createContextStore>;
type PersonaInput = Parameters<CoreContext['registerPersona']>[0];
type ConfigurationInput = Parameters<CoreContext['setConfiguration']>[0];
type PreferenceInput = Parameters<CoreContext['setPreferences']>[0];
type ResolutionInput = Parameters<CoreContext['resolve']>[0];
type ContextScope = ConfigurationInput['scope'];

interface PersonaData {
  input: PersonaInput;
  order: number;
}

interface ConfigurationData {
  input: ConfigurationInput;
  order: number;
}

interface PreferenceData {
  input: Required<PreferenceInput>;
  descriptionOrder: number;
  precedenceOrder: number;
}

interface ContextMemory {
  context: CoreContext;
  personas: Map<string, PersonaData>;
  configurations: Map<string, ConfigurationData>;
  preferences: Map<string, PreferenceData>;
  personaRevisions: Map<string, number>;
  configurationRevisions: Map<string, number>;
  preferenceRevisions: Map<string, number>;
  nextOrder: number;
}

export interface PersistentContextOptions {
  store: DurableStore;
  clock?: Clock;
}

export interface PersistentContextStore {
  registerPersona: CoreContext['registerPersona'];
  setConfiguration: CoreContext['setConfiguration'];
  setPreferences: CoreContext['setPreferences'];
  removePreferences: CoreContext['removePreferences'];
  resolve: CoreContext['resolve'];
  describe: CoreContext['describe'];
  reload(): void;
}

function invalidStoredData(): never {
  throw new FrameworkError('INVALID_STORED_DATA', 'Stored context data is invalid.');
}

function stored(condition: unknown): asserts condition {
  if (!condition) invalidStoredData();
}

function order(value: unknown): number {
  stored(typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  return value;
}

function normalizedScope(scope: ContextScope): ContextScope {
  return snapshot(scope.kind === 'global'
    ? { kind: 'global' }
    : { kind: scope.kind, id: scope.id }) as ContextScope;
}

function scopeKey(scope: ContextScope): string {
  return scope.kind === 'global' ? 'global' : `${scope.kind}:${scope.id}`;
}

function records(store: DurableStore, namespace: string): StoredRecord[] {
  const output: StoredRecord[] = [];
  let after: string | undefined;
  do {
    const page = store.list(namespace, {
      limit: PAGE_SIZE,
      ...(after === undefined ? {} : { after })
    });
    output.push(...page);
    after = page.at(-1)?.key;
    if (page.length < PAGE_SIZE) break;
  } while (after !== undefined);
  return output;
}

function personaValue(data: PersonaData): JsonObject {
  return {
    schema: 1,
    kind: 'persona',
    order: data.order,
    id: data.input.id,
    version: data.input.version,
    name: data.input.name,
    identity: data.input.identity,
    style: data.input.style
  };
}

function configurationValue(data: ConfigurationData): JsonObject {
  return {
    schema: 1,
    kind: 'configuration',
    order: data.order,
    scope: data.input.scope,
    values: data.input.values,
    source: data.input.source
  };
}

function preferenceValue(data: PreferenceData): JsonObject {
  return {
    schema: 1,
    kind: 'preference',
    descriptionOrder: data.descriptionOrder,
    precedenceOrder: data.precedenceOrder,
    id: data.input.id,
    scope: data.input.scope,
    values: data.input.values,
    source: data.input.source,
    expiresAt: data.input.expiresAt
  };
}

function validateStored(operation: () => void): void {
  try {
    operation();
  } catch {
    invalidStoredData();
  }
}

function parsePersona(record: StoredRecord, clock: Clock): PersonaData {
  const value = record.value;
  stored(isRecord(value)
    && value.schema === 1
    && value.kind === 'persona'
    && typeof value.id === 'string'
    && typeof value.version === 'string'
    && typeof value.name === 'string');
  const input = snapshot({
    id: value.id,
    version: value.version,
    name: value.name,
    identity: value.identity as JsonValue,
    style: value.style as JsonValue
  }) as PersonaInput;
  let key = '';
  validateStored(() => { key = createContextStore({ clock }).registerPersona(input); });
  stored(key === record.key);
  return { input, order: order(value.order) };
}

function parseConfiguration(record: StoredRecord, clock: Clock): ConfigurationData {
  const value = record.value;
  stored(isRecord(value)
    && value.schema === 1
    && value.kind === 'configuration'
    && isRecord(value.scope)
    && isRecord(value.values)
    && typeof value.source === 'string');
  const input = snapshot({
    scope: value.scope,
    values: value.values,
    source: value.source
  }) as ConfigurationInput;
  validateStored(() => { createContextStore({ clock }).setConfiguration(input); });
  const normalized = snapshot({ ...input, scope: normalizedScope(input.scope) }) as ConfigurationInput;
  stored(scopeKey(normalized.scope) === record.key);
  return { input: normalized, order: order(value.order) };
}

function parsePreference(record: StoredRecord, clock: Clock): PreferenceData {
  const value = record.value;
  stored(isRecord(value)
    && value.schema === 1
    && value.kind === 'preference'
    && typeof value.id === 'string'
    && isRecord(value.scope)
    && isRecord(value.values)
    && typeof value.source === 'string'
    && (value.expiresAt === null || typeof value.expiresAt === 'number'));
  const input = snapshot({
    id: value.id,
    scope: value.scope,
    values: value.values,
    source: value.source,
    expiresAt: value.expiresAt
  }) as Required<PreferenceInput>;
  validateStored(() => { createContextStore({ clock }).setPreferences(input); });
  const normalized = snapshot({ ...input, scope: normalizedScope(input.scope) }) as Required<PreferenceInput>;
  stored(normalized.id === record.key);
  return {
    input: normalized,
    descriptionOrder: order(value.descriptionOrder),
    precedenceOrder: order(value.precedenceOrder)
  };
}

function hydrate(clock: Clock, personas: ReadonlyMap<string, PersonaData>,
  configurations: ReadonlyMap<string, ConfigurationData>,
  preferences: ReadonlyMap<string, PreferenceData>): CoreContext {
  const context = createContextStore({ clock });
  for (const [, data] of [...personas].sort((left, right) => left[1].order - right[1].order)) {
    context.registerPersona(data.input);
  }
  for (const [, data] of [...configurations].sort((left, right) => left[1].order - right[1].order)) {
    context.setConfiguration(data.input);
  }
  const descriptionOrder = [...preferences].sort((left, right) =>
    left[1].descriptionOrder - right[1].descriptionOrder || left[0].localeCompare(right[0]));
  for (const [, data] of descriptionOrder) context.setPreferences(data.input);
  const precedenceOrder = [...preferences].sort((left, right) =>
    left[1].precedenceOrder - right[1].precedenceOrder || left[0].localeCompare(right[0]));
  for (const [, data] of precedenceOrder) context.setPreferences(data.input);
  return context;
}

function load(store: DurableStore, clock: Clock): ContextMemory {
  const personas = new Map<string, PersonaData>();
  const configurations = new Map<string, ConfigurationData>();
  const preferences = new Map<string, PreferenceData>();
  const personaRevisions = new Map<string, number>();
  const configurationRevisions = new Map<string, number>();
  const preferenceRevisions = new Map<string, number>();
  let nextOrder = 0;

  for (const record of records(store, PERSONA_NAMESPACE)) {
    const data = parsePersona(record, clock);
    personas.set(record.key, data);
    personaRevisions.set(record.key, record.revision);
    nextOrder = Math.max(nextOrder, data.order);
  }
  for (const record of records(store, CONFIGURATION_NAMESPACE)) {
    const data = parseConfiguration(record, clock);
    configurations.set(record.key, data);
    configurationRevisions.set(record.key, record.revision);
    nextOrder = Math.max(nextOrder, data.order);
  }
  for (const record of records(store, PREFERENCE_NAMESPACE)) {
    const data = parsePreference(record, clock);
    preferences.set(record.key, data);
    preferenceRevisions.set(record.key, record.revision);
    nextOrder = Math.max(nextOrder, data.descriptionOrder, data.precedenceOrder);
  }
  let context: CoreContext;
  try {
    context = hydrate(clock, personas, configurations, preferences);
  } catch {
    invalidStoredData();
  }
  return {
    context,
    personas,
    configurations,
    preferences,
    personaRevisions,
    configurationRevisions,
    preferenceRevisions,
    nextOrder
  };
}

function contextConflict(): never {
  throw new FrameworkError('CONTEXT_CONFLICT', 'Persistent context changed; reload is required.');
}

function isStoreConflict(error: unknown): boolean {
  return error instanceof FrameworkError && error.code === 'STORE_CONFLICT';
}

export function createPersistentContextStore({ store, clock = Date.now }:
  PersistentContextOptions): Readonly<PersistentContextStore> {
  assert(store && typeof store.read === 'function' && typeof store.write === 'function',
    'CONTEXT_INVALID_STORE', 'A durable store is required.');
  assert(typeof clock === 'function', 'CONTEXT_INVALID_CLOCK', 'Clock must be a function.');
  let memory = load(store, clock);

  function assertFresh(namespace: string, key: string,
    revisions: ReadonlyMap<string, number>): StoredRecord | null {
    const current = store.read(namespace, key);
    const expected = revisions.get(key);
    if ((expected === undefined && current !== null)
      || (expected !== undefined && current?.revision !== expected)) contextConflict();
    return current;
  }

  function write(namespace: string, key: string, value: JsonValue,
    current: StoredRecord | null): StoredRecord {
    try {
      return store.write(namespace, key, value, { expectedRevision: current?.revision ?? null });
    } catch (error: unknown) {
      if (isStoreConflict(error)) contextConflict();
      throw error;
    }
  }

  function registerPersona(input: PersonaInput): string {
    const submitted: PersonaInput = {
      id: input.id,
      version: input.version,
      name: input.name,
      identity: input.identity,
      style: input.style
    };
    const validator = createContextStore({ clock });
    const key = validator.registerPersona(submitted);
    const detached = snapshot(submitted) as PersonaInput;
    const current = assertFresh(PERSONA_NAMESPACE, key, memory.personaRevisions);
    const candidate = hydrate(clock, memory.personas, memory.configurations, memory.preferences);
    candidate.registerPersona(detached);
    const personas = new Map(memory.personas);
    const data: PersonaData = {
      input: detached,
      order: memory.nextOrder + 1
    };
    personas.set(key, data);
    const storedRecord = write(PERSONA_NAMESPACE, key, personaValue(data), current);
    const personaRevisions = new Map(memory.personaRevisions).set(key, storedRecord.revision);
    memory = { ...memory, context: candidate, personas, personaRevisions, nextOrder: data.order };
    return key;
  }

  function setConfiguration(input: ConfigurationInput): void {
    const submitted: ConfigurationInput = {
      scope: input.scope,
      values: input.values,
      source: input.source
    };
    const validator = createContextStore({ clock });
    validator.setConfiguration(submitted);
    const detached = snapshot(submitted) as ConfigurationInput;
    const normalized = snapshot({
      scope: normalizedScope(detached.scope),
      values: detached.values,
      source: detached.source
    }) as ConfigurationInput;
    const key = scopeKey(normalized.scope);
    const current = assertFresh(CONFIGURATION_NAMESPACE, key, memory.configurationRevisions);
    const candidate = hydrate(clock, memory.personas, memory.configurations, memory.preferences);
    candidate.setConfiguration(normalized);
    const configurations = new Map(memory.configurations);
    const existing = configurations.get(key);
    const data: ConfigurationData = {
      input: normalized,
      order: existing?.order ?? memory.nextOrder + 1
    };
    configurations.set(key, data);
    const storedRecord = write(CONFIGURATION_NAMESPACE, key, configurationValue(data), current);
    const configurationRevisions = new Map(memory.configurationRevisions).set(key, storedRecord.revision);
    memory = {
      ...memory,
      context: candidate,
      configurations,
      configurationRevisions,
      nextOrder: Math.max(memory.nextOrder, data.order)
    };
  }

  function setPreferences(input: PreferenceInput): void {
    const expiresAt = input.expiresAt;
    const submitted: PreferenceInput = expiresAt === undefined ? {
      id: input.id,
      scope: input.scope,
      values: input.values,
      source: input.source
    } : {
      id: input.id,
      scope: input.scope,
      values: input.values,
      source: input.source,
      expiresAt
    };
    const validator = createContextStore({ clock });
    validator.setPreferences(submitted);
    const detached = snapshot(submitted) as PreferenceInput;
    const normalized = snapshot({
      id: detached.id,
      scope: normalizedScope(detached.scope),
      values: detached.values,
      source: detached.source,
      expiresAt: detached.expiresAt ?? null
    }) as Required<PreferenceInput>;
    const current = assertFresh(PREFERENCE_NAMESPACE, normalized.id, memory.preferenceRevisions);
    const candidate = hydrate(clock, memory.personas, memory.configurations, memory.preferences);
    candidate.setPreferences(normalized);
    const preferences = new Map(memory.preferences);
    const existing = preferences.get(normalized.id);
    const nextOrder = memory.nextOrder + 1;
    const data: PreferenceData = {
      input: normalized,
      descriptionOrder: existing?.descriptionOrder ?? nextOrder,
      precedenceOrder: nextOrder
    };
    preferences.set(normalized.id, data);
    const storedRecord = write(PREFERENCE_NAMESPACE, normalized.id, preferenceValue(data), current);
    const preferenceRevisions = new Map(memory.preferenceRevisions).set(normalized.id, storedRecord.revision);
    memory = {
      ...memory,
      context: candidate,
      preferences,
      preferenceRevisions,
      nextOrder
    };
  }

  function removePreferences(id: string): boolean {
    const validator = createContextStore({ clock });
    validator.removePreferences(id);
    const current = assertFresh(PREFERENCE_NAMESPACE, id, memory.preferenceRevisions);
    if (!current) return false;
    const preferences = new Map(memory.preferences);
    const candidateContext = hydrate(clock, memory.personas, memory.configurations, preferences);
    const removed = candidateContext.removePreferences(id);
    assert(removed, 'INVALID_STORED_DATA', 'Stored context data is invalid.');
    if (!store.delete(PREFERENCE_NAMESPACE, id, current.revision)) contextConflict();
    preferences.delete(id);
    const finalContext = hydrate(clock, memory.personas, memory.configurations, preferences);
    const preferenceRevisions = new Map(memory.preferenceRevisions);
    preferenceRevisions.delete(id);
    memory = { ...memory, context: finalContext, preferences, preferenceRevisions };
    return true;
  }

  function resolve(input: ResolutionInput): ReturnType<CoreContext['resolve']> {
    return memory.context.resolve(input);
  }

  function describe(): ReturnType<CoreContext['describe']> {
    return memory.context.describe();
  }

  function reload(): void {
    const loaded = load(store, clock);
    memory = loaded;
  }

  return Object.freeze({
    registerPersona,
    setConfiguration,
    setPreferences,
    removePreferences,
    resolve,
    describe,
    reload
  });
}

export const createPersistentContext = createPersistentContextStore;
