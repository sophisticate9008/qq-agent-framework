import { FrameworkError, assert, identifier, reference, snapshot } from './values.ts'
import type { Clock, JsonObject, JsonValue } from './types.ts'

type ScopeKind = 'global' | 'persona' | 'conversation' | 'user' | 'session' | 'task'
type IdentifiedScopeKind = Exclude<ScopeKind, 'global'>
type ConfigurationSource = 'operator' | 'migration'
type PreferenceSource = 'operator' | 'confirmed-user'

interface GlobalScope extends JsonObject {
  kind: 'global'
}

interface IdentifiedScope extends JsonObject {
  kind: IdentifiedScopeKind
  id: string
}

type ContextScope = GlobalScope | IdentifiedScope

interface PersonaReference {
  id: string
  version: string
}

interface PersonaInput extends PersonaReference {
  name: string
  identity: JsonValue
  style: JsonValue
}

interface PersonaDefinition extends JsonObject, PersonaInput {}

interface ConfigurationInput {
  scope: ContextScope
  values: JsonObject
  source: ConfigurationSource
}

interface PreferenceInput {
  id: string
  scope: ContextScope
  values: JsonObject
  source: PreferenceSource
  expiresAt?: number | null
}

interface ResolutionInput {
  persona: string | PersonaReference
  conversationId?: string
  userId?: string
  sessionId?: string
  taskId?: string
}

interface ConfigurationRecord {
  scope: ContextScope
  values: JsonObject
  source: ConfigurationSource
}

interface PreferenceRecord {
  id: string
  scope: ContextScope
  values: JsonObject
  source: PreferenceSource
  expiresAt: number | null
  order: number
}

interface PersonaProvenance extends JsonObject {
  key: string
  id: string
  version: string
}

interface ConfigurationOrigin extends JsonObject {
  scope: ContextScope
  source: ConfigurationSource
}

interface PreferenceOrigin extends JsonObject {
  id: string
  scope: ContextScope
  source: PreferenceSource
  expiresAt: number | null
}

interface ConfigurationProvenance extends JsonObject {
  [key: string]: ConfigurationOrigin
}

interface PreferenceProvenance extends JsonObject {
  [key: string]: PreferenceOrigin
}

interface ContextProvenance extends JsonObject {
  persona: PersonaProvenance
  configuration: ConfigurationProvenance
  preferences: PreferenceProvenance
}

export interface ResolvedContext extends JsonObject {
  persona: PersonaDefinition
  configuration: JsonObject
  preferences: JsonObject
  provenance: ContextProvenance
}

interface PersonaDescription extends JsonObject {
  key: string
  id: string
  version: string
  name: string
}

interface ConfigurationDescription extends JsonObject {
  scope: ContextScope
  source: ConfigurationSource
  keys: JsonValue[]
}

interface PreferenceDescription extends JsonObject {
  id: string
  scope: ContextScope
  source: PreferenceSource
  expiresAt: number | null
  active: boolean
  keys: JsonValue[]
}

interface ContextDescription extends JsonObject {
  personas: PersonaDescription[]
  configurations: ConfigurationDescription[]
  preferences: PreferenceDescription[]
}

interface ContextStore {
  registerPersona(input: PersonaInput): string
  setConfiguration(input: ConfigurationInput): void
  setPreferences(input: PreferenceInput): void
  removePreferences(id: string): boolean
  resolve(input: ResolutionInput): ResolvedContext
  describe(): ContextDescription
}

export interface FeatureStateScope {
  get(key: string, fallback?: JsonValue): JsonValue
  set(key: string, value: JsonValue): JsonValue
  delete(key: string): boolean
}

interface FeatureStateNamespaceDescription extends JsonObject {
  featureId: string
  conversationId: string
  entries: number
}

interface FeatureStateDescription extends JsonObject {
  namespaces: FeatureStateNamespaceDescription[]
}

interface FeatureStateStore {
  scope(featureId: string, conversationId: string): FeatureStateScope
  describe(): FeatureStateDescription
}

const SCOPE_ORDER: readonly ScopeKind[] = [
  'global',
  'persona',
  'conversation',
  'user',
  'session',
  'task'
]
const CONFIGURATION_SOURCES = new Set<ConfigurationSource>(['operator', 'migration'])
const PREFERENCE_SOURCES = new Set<PreferenceSource>(['operator', 'confirmed-user'])

function assertIdentifier(value: unknown, code: string, message: string): asserts value is string {
  assert(identifier(value), code, message)
}

function assertReference(value: unknown, code: string, message: string): asserts value is string {
  assert(reference(value), code, message)
}

function safeSnapshot<T extends JsonValue>(value: T, code: string, message: string): T {
  try {
    return snapshot(value) as T
  } catch {
    throw new FrameworkError(code, message)
  }
}

function copyValues(values: JsonObject): JsonObject {
  assert(
    values !== null && typeof values === 'object' && !Array.isArray(values),
    'CONTEXT_INVALID_VALUES',
    'Values must be an object'
  )
  return safeSnapshot(values, 'CONTEXT_INVALID_VALUES', 'Values must contain JSON data')
}

function normalizeScope(scope: ContextScope): ContextScope {
  assert(
    scope !== null && typeof scope === 'object' && !Array.isArray(scope),
    'CONTEXT_INVALID_SCOPE',
    'Scope must be an object'
  )
  assert(
    SCOPE_ORDER.includes(scope.kind),
    'CONTEXT_INVALID_SCOPE',
    'Scope kind is not supported'
  )
  if (scope.kind === 'global') {
    assert(
      !('id' in scope) || scope.id === undefined,
      'CONTEXT_INVALID_SCOPE',
      'Global scope cannot have an id'
    )
    return safeSnapshot({ kind: 'global' }, 'CONTEXT_INVALID_SCOPE', 'Scope is invalid')
  }
  assertReference(scope.id, 'CONTEXT_INVALID_SCOPE', 'Scope id is invalid')
  return safeSnapshot(
    { kind: scope.kind, id: scope.id },
    'CONTEXT_INVALID_SCOPE',
    'Scope is invalid'
  )
}

function scopeKey(scope: ContextScope): string {
  return scope.kind === 'global' ? 'global' : `${scope.kind}:${scope.id}`
}

function normalizePersonaReference(persona: string | PersonaReference): string {
  if (typeof persona === 'string') {
    assertReference(persona, 'CONTEXT_INVALID_PERSONA', 'Persona is invalid')
    return persona
  }
  assert(
    persona !== null && typeof persona === 'object' && !Array.isArray(persona),
    'CONTEXT_INVALID_PERSONA',
    'Persona must be a registered key'
  )
  assertIdentifier(persona.id, 'CONTEXT_INVALID_PERSONA', 'Persona id is invalid')
  assertReference(persona.version, 'CONTEXT_INVALID_PERSONA', 'Persona version is invalid')
  return `${persona.id}@${persona.version}`
}

function resolutionScopes(persona: string, input: ResolutionInput): ContextScope[] {
  const scopes: ContextScope[] = [{ kind: 'global' }, { kind: 'persona', id: persona }]
  const candidates: readonly [IdentifiedScopeKind, string | undefined][] = [
    ['conversation', input.conversationId],
    ['user', input.userId],
    ['session', input.sessionId],
    ['task', input.taskId]
  ]
  for (const [kind, id] of candidates) {
    if (id === undefined) continue
    assertReference(id, 'CONTEXT_INVALID_SCOPE', 'Resolution scope id is invalid')
    scopes.push({ kind, id })
  }
  return scopes
}

function assignValues<T extends JsonValue>(
  target: Map<string, JsonValue>,
  provenance: Map<string, T>,
  values: JsonObject,
  origin: T
): void {
  for (const [key, value] of Object.entries(values)) {
    target.set(key, value)
    provenance.set(key, origin)
  }
}

function objectFromMap<T extends JsonValue>(map: ReadonlyMap<string, T>): Record<string, T> {
  return Object.fromEntries(map.entries()) as Record<string, T>
}

export function createContextStore(
  { clock = Date.now }: { clock?: Clock } = {}
): Readonly<ContextStore> {
  assert(typeof clock === 'function', 'CONTEXT_INVALID_CLOCK', 'Clock must be a function')

  const personas = new Map<string, PersonaDefinition>()
  const configurations = new Map<string, ConfigurationRecord>()
  const preferences = new Map<string, PreferenceRecord>()
  let preferenceOrder = 0

  function registerPersona({ id, version, name, identity, style }: PersonaInput): string {
    assertIdentifier(id, 'CONTEXT_INVALID_PERSONA', 'Persona id is invalid')
    assertReference(version, 'CONTEXT_INVALID_PERSONA', 'Persona version is invalid')
    assertReference(name, 'CONTEXT_INVALID_PERSONA', 'Persona name is invalid')
    assert(!version.includes('@'), 'CONTEXT_INVALID_PERSONA', 'Persona version cannot contain @')
    const key = `${id}@${version}`
    assert(!personas.has(key), 'CONTEXT_PERSONA_EXISTS', 'Persona version already exists')
    const persona = safeSnapshot<PersonaDefinition>(
      { id, version, name, identity, style },
      'CONTEXT_INVALID_PERSONA',
      'Persona must contain JSON data'
    )
    personas.set(key, persona)
    return key
  }

  function setConfiguration({ scope, values, source }: ConfigurationInput): void {
    const normalizedScope = normalizeScope(scope)
    assert(
      CONFIGURATION_SOURCES.has(source),
      'CONTEXT_INVALID_SOURCE',
      'Configuration source is not allowed'
    )
    configurations.set(scopeKey(normalizedScope), {
      scope: normalizedScope,
      values: copyValues(values),
      source
    })
  }

  function setPreferences({
    id,
    scope,
    values,
    source,
    expiresAt = null
  }: PreferenceInput): void {
    assertIdentifier(id, 'CONTEXT_INVALID_PREFERENCE', 'Preference id is invalid')
    assert(
      PREFERENCE_SOURCES.has(source),
      'CONTEXT_INVALID_PREFERENCE_SOURCE',
      'Preference source is not allowed'
    )
    assert(
      expiresAt === null || (typeof expiresAt === 'number' && Number.isFinite(expiresAt)),
      'CONTEXT_INVALID_EXPIRY',
      'Preference expiry must be a finite timestamp or null'
    )
    const normalizedScope = normalizeScope(scope)
    const existing = preferences.get(id)
    assert(
      !existing || scopeKey(existing.scope) === scopeKey(normalizedScope),
      'CONTEXT_PREFERENCE_SCOPE_MISMATCH',
      'Preference id is already assigned to another scope'
    )
    preferenceOrder += 1
    preferences.set(id, {
      id,
      scope: normalizedScope,
      values: copyValues(values),
      source,
      expiresAt,
      order: preferenceOrder
    })
  }

  function removePreferences(id: string): boolean {
    assertIdentifier(id, 'CONTEXT_INVALID_PREFERENCE', 'Preference id is invalid')
    return preferences.delete(id)
  }

  function resolve(input: ResolutionInput): ResolvedContext {
    assert(
      input !== null && typeof input === 'object' && !Array.isArray(input),
      'CONTEXT_INVALID_RESOLUTION',
      'Resolution input must be an object'
    )
    const personaKey = normalizePersonaReference(input.persona)
    const persona = personas.get(personaKey)
    assert(persona, 'CONTEXT_PERSONA_NOT_FOUND', 'Persona version is not registered')
    const now = clock()
    assert(
      typeof now === 'number' && Number.isFinite(now),
      'CONTEXT_INVALID_CLOCK',
      'Clock must return a finite timestamp'
    )

    const configurationValues = new Map<string, JsonValue>()
    const configurationProvenance = new Map<string, ConfigurationOrigin>()
    const preferenceValues = new Map<string, JsonValue>()
    const preferenceProvenance = new Map<string, PreferenceOrigin>()
    const records = [...preferences.values()].sort((left, right) => left.order - right.order)

    for (const scope of resolutionScopes(personaKey, input)) {
      const key = scopeKey(scope)
      const configuration = configurations.get(key)
      if (configuration) {
        assignValues(
          configurationValues,
          configurationProvenance,
          configuration.values,
          safeSnapshot<ConfigurationOrigin>(
            { scope: configuration.scope, source: configuration.source },
            'CONTEXT_INVALID_VALUES',
            'Configuration provenance is invalid'
          )
        )
      }

      const matching = records.filter((record) => scopeKey(record.scope) === key)
      const persistent = matching.filter((record) => record.expiresAt === null)
      const temporary = matching.filter(
        (record) => record.expiresAt !== null && record.expiresAt > now
      )
      for (const record of [...persistent, ...temporary]) {
        assignValues(
          preferenceValues,
          preferenceProvenance,
          record.values,
          safeSnapshot<PreferenceOrigin>(
            {
              id: record.id,
              scope: record.scope,
              source: record.source,
              expiresAt: record.expiresAt
            },
            'CONTEXT_INVALID_VALUES',
            'Preference provenance is invalid'
          )
        )
      }
    }

    const resolved: ResolvedContext = {
      persona,
      configuration: objectFromMap(configurationValues),
      preferences: objectFromMap(preferenceValues),
      provenance: {
        persona: { key: personaKey, id: persona.id, version: persona.version },
        configuration: objectFromMap(configurationProvenance),
        preferences: objectFromMap(preferenceProvenance)
      }
    }
    return safeSnapshot(resolved, 'CONTEXT_INVALID_VALUES', 'Resolved context is invalid')
  }

  function describe(): ContextDescription {
    const now = clock()
    assert(
      typeof now === 'number' && Number.isFinite(now),
      'CONTEXT_INVALID_CLOCK',
      'Clock must return a finite timestamp'
    )
    const description: ContextDescription = {
      personas: [...personas.entries()].map(([key, persona]) => ({
        key,
        id: persona.id,
        version: persona.version,
        name: persona.name
      })),
      configurations: [...configurations.values()].map((configuration) => ({
        scope: configuration.scope,
        source: configuration.source,
        keys: Object.keys(configuration.values)
      })),
      preferences: [...preferences.values()].map((preference) => ({
        id: preference.id,
        scope: preference.scope,
        source: preference.source,
        expiresAt: preference.expiresAt,
        active: preference.expiresAt === null || preference.expiresAt > now,
        keys: Object.keys(preference.values)
      }))
    }
    return safeSnapshot(description, 'CONTEXT_INVALID_VALUES', 'Context description is invalid')
  }

  return Object.freeze({
    registerPersona,
    setConfiguration,
    setPreferences,
    removePreferences,
    resolve,
    describe
  })
}

export function createFeatureState(): Readonly<FeatureStateStore> {
  const features = new Map<string, Map<string, Map<string, JsonValue>>>()

  function scope(featureId: string, conversationId: string): FeatureStateScope {
    assertIdentifier(featureId, 'FEATURE_STATE_INVALID_SCOPE', 'Feature id is invalid')
    assertReference(conversationId, 'FEATURE_STATE_INVALID_SCOPE', 'Conversation id is invalid')
    let conversations = features.get(featureId)
    if (!conversations) {
      conversations = new Map<string, Map<string, JsonValue>>()
      features.set(featureId, conversations)
    }
    let entries = conversations.get(conversationId)
    if (!entries) {
      entries = new Map<string, JsonValue>()
      conversations.set(conversationId, entries)
    }

    return Object.freeze({
      get(key: string, fallback: JsonValue = null): JsonValue {
        assertReference(key, 'FEATURE_STATE_INVALID_KEY', 'State key is invalid')
        const value = entries.get(key)
        return value === undefined ? fallback : value
      },
      set(key: string, value: JsonValue): JsonValue {
        assertReference(key, 'FEATURE_STATE_INVALID_KEY', 'State key is invalid')
        const stored = safeSnapshot(
          value,
          'FEATURE_STATE_INVALID_VALUE',
          'State value must contain JSON data'
        )
        entries.set(key, stored)
        return stored
      },
      delete(key: string): boolean {
        assertReference(key, 'FEATURE_STATE_INVALID_KEY', 'State key is invalid')
        return entries.delete(key)
      }
    })
  }

  function describe(): FeatureStateDescription {
    const namespaces: FeatureStateNamespaceDescription[] = []
    for (const [featureId, conversations] of features) {
      for (const [conversationId, entries] of conversations) {
        namespaces.push({ featureId, conversationId, entries: entries.size })
      }
    }
    return safeSnapshot(
      { namespaces },
      'FEATURE_STATE_INVALID_VALUE',
      'State description is invalid'
    )
  }

  return Object.freeze({ scope, describe })
}
