import test from 'node:test'
import assert from 'node:assert/strict'

import { createContextStore, createFeatureState } from '../src/core/context.ts'
import type { JsonObject, JsonValue } from '../src/core/types.ts'

type ContextStore = ReturnType<typeof createContextStore>

test('final provenance remains deeply frozen and detached when intermediate copies are removed', () => {
  const store = createContextStore()
  const persona = registerPersona(store)
  const scope = { kind: 'conversation', id: 'target' } as const
  store.setConfiguration({ scope, values: { mode: 'configured' }, source: 'operator' })
  store.setPreferences({ id: 'first', scope, values: { mode: 'preferred' }, source: 'operator' })
  const before = store.resolve({ persona, conversationId: 'target' })
  assert(Object.isFrozen(before.provenance.configuration.mode))
  assert(Object.isFrozen(before.provenance.configuration.mode.scope))
  assert(Object.isFrozen(before.provenance.preferences.mode.scope))
  assert.throws(() => { before.provenance.preferences.mode.scope.kind = 'global' }, TypeError)
  store.setPreferences({ id: 'second', scope, values: { mode: 'new' }, source: 'confirmed-user' })
  store.removePreferences('first')
  assert.equal(before.preferences.mode, 'preferred')
  assert.equal(before.provenance.preferences.mode.id, 'first')
  assert.equal(store.resolve({ persona, conversationId: 'target' }).provenance.preferences.mode.id, 'second')
})

function registerPersona(store: ContextStore, version = '1.0.0'): string {
  return store.registerPersona({
    id: 'snow',
    version,
    name: 'Snow',
    identity: { role: 'assistant' },
    style: { tone: 'warm' }
  })
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function objectValue(value: JsonValue): JsonObject {
  assert.notEqual(value, null)
  assert.equal(typeof value, 'object')
  assert.equal(Array.isArray(value), false)
  return value as JsonObject
}

test('preference updates preserve layer priority and latest successful update order', () => {
  let now = 100
  const store = createContextStore({ clock: () => now })
  const persona = registerPersona(store)
  const scope = { kind: 'conversation', id: 'target' } as const
  const input = { persona, conversationId: 'target' }
  const write = (id: string, marker: string, expiresAt: number | null = null): void => {
    store.setPreferences({ id, scope, values: { marker }, source: 'operator', expiresAt })
  }
  const check = (marker: string, id: string): void => {
    const result = store.resolve(input)
    assert.equal(result.preferences.marker, marker)
    assert.equal(result.provenance.preferences.marker.id, id)
  }

  write('first', 'first-default')
  write('second', 'second-default')
  check('second-default', 'second')
  write('first', 'updated-default')
  check('updated-default', 'first')
  write('temporary-one', 'temporary-one', 200)
  write('temporary-two', 'temporary-two', 300)
  write('second', 'newest-default')
  check('temporary-two', 'temporary-two')
  write('temporary-one', 'updated-temporary', 200)
  check('updated-temporary', 'temporary-one')
  now = 200
  check('temporary-two', 'temporary-two')
  now = 300
  check('newest-default', 'second')
  now = 100
  check('updated-temporary', 'temporary-one')
  write('temporary-one', 'converted-default')
  check('temporary-two', 'temporary-two')
  write('second', 'converted-temporary', 400)
  check('converted-temporary', 'second')
  assert.equal(store.removePreferences('second'), true)
  check('temporary-two', 'temporary-two')
  write('second', 'reinserted', 500)
  check('reinserted', 'second')
  now = 500
  check('converted-default', 'temporary-one')
})

test('failed preference writes leave resolution and management order unchanged', () => {
  const store = createContextStore()
  const persona = registerPersona(store)
  const scope = { kind: 'conversation', id: 'target' } as const
  for (const id of ['first', 'second']) {
    store.setPreferences({ id, scope, values: { marker: id }, source: 'operator' })
  }
  const before = store.resolve({ persona, conversationId: 'target' })
  const description = store.describe()
  const invalid: unknown = { marker: () => 'not-json' }
  for (const id of ['first', 'unregistered']) {
    assert.throws(() => store.setPreferences({
      id, scope, values: invalid as JsonObject, source: 'operator'
    }), (error: unknown) => hasErrorCode(error, 'CONTEXT_INVALID_VALUES'))
  }
  assert.deepEqual(store.resolve({ persona, conversationId: 'target' }), before)
  assert.deepEqual(store.describe(), description)
  store.setPreferences({ id: 'first', scope, values: { marker: 'updated' }, source: 'operator' })
  assert.deepEqual(store.describe().preferences.map((record) => record.id), ['first', 'second'])
  assert.equal(store.resolve({ persona, conversationId: 'target' }).preferences.marker, 'updated')
  assert.equal(store.removePreferences('unregistered'), false)
})

test('scope indexing excludes unrelated scopes and treats prototype names as namespace data', () => {
  const store = createContextStore({ clock: () => 100 })
  const persona = registerPersona(store)
  for (let index = 0; index < 1_000; index += 1) {
    store.setPreferences({
      id: `unrelated-${index}`,
      scope: { kind: 'conversation', id: `unrelated-${index}` },
      values: { marker: 'unrelated' },
      source: 'operator'
    })
  }
  store.setPreferences({
    id: 'prototype-conversation',
    scope: { kind: 'conversation', id: '__proto__' },
    values: { conversation: 'selected' }, source: 'operator'
  })
  store.setPreferences({
    id: 'prototype-user',
    scope: { kind: 'user', id: '__proto__' },
    values: { user: 'selected' }, source: 'operator'
  })
  store.setPreferences({
    id: 'constructor-task',
    scope: { kind: 'task', id: 'constructor' },
    values: { task: 'selected' }, source: 'operator'
  })
  assert.deepEqual(store.resolve({
    persona, conversationId: '__proto__', userId: '__proto__', taskId: 'constructor'
  }).preferences, { conversation: 'selected', user: 'selected', task: 'selected' })
  assert.deepEqual(store.resolve({ persona, conversationId: 'constructor' }).preferences, {})
  assert.equal(store.removePreferences('prototype-conversation'), true)
  assert.equal(store.removePreferences('prototype-user'), true)
  assert.equal(store.removePreferences('constructor-task'), true)
  assert.deepEqual(store.resolve({
    persona, conversationId: '__proto__', userId: '__proto__', taskId: 'constructor'
  }).preferences, {})
  assert.equal((Object.prototype as { marker?: unknown }).marker, undefined)
})

test('indexed resolution agrees with a flat reference across updates, removal and clock changes', () => {
  let now = 100
  const store = createContextStore({ clock: () => now })
  const persona = registerPersona(store)
  const otherPersona = registerPersona(store, '2.0.0')
  type PreferenceInput = Parameters<ContextStore['setPreferences']>[0]
  type Scope = PreferenceInput['scope']
  type ReferenceRecord = PreferenceInput & { expiresAt: number | null; sequence: number }
  const scopes: Scope[] = [
    { kind: 'global' },
    { kind: 'persona', id: persona },
    { kind: 'persona', id: otherPersona },
    { kind: 'conversation', id: '__proto__' },
    { kind: 'conversation', id: 'other' },
    { kind: 'user', id: 'constructor' },
    { kind: 'session', id: 'session' },
    { kind: 'task', id: 'task' }
  ]
  const key = (scope: Scope): string =>
    scope.kind === 'global' ? 'global' : `${scope.kind}:${scope.id}`
  const reference = new Map<string, ReferenceRecord>()
  const queries = [
    {
      persona, conversationId: '__proto__', userId: 'constructor',
      sessionId: 'session', taskId: 'task'
    },
    { persona: otherPersona, conversationId: 'other' },
    { persona, conversationId: 'absent' }
  ]

  for (let sequence = 0; sequence < 120; sequence += 1) {
    now = [100, 300, 50, 200][sequence % 4] ?? 100
    const selected = sequence % 24
    const id = `reference-${selected}`
    if (sequence % 7 === 0) {
      assert.equal(store.removePreferences(id), reference.delete(id))
    } else {
      const scope = scopes[selected % scopes.length]
      assert(scope)
      const record: ReferenceRecord = {
        id, scope,
        values: { marker: sequence, [`key-${selected % 3}`]: selected },
        source: sequence % 2 === 0 ? 'operator' : 'confirmed-user',
        expiresAt: sequence % 3 === 0 ? null : sequence % 3 === 1 ? 200 : 400,
        sequence
      }
      store.setPreferences(record)
      reference.set(id, record)
    }
    for (const input of queries) {
      const activeScopes: Scope[] = [
        { kind: 'global' },
        { kind: 'persona', id: input.persona },
        { kind: 'conversation', id: input.conversationId }
      ]
      if (input.userId) activeScopes.push({ kind: 'user', id: input.userId })
      if (input.sessionId) activeScopes.push({ kind: 'session', id: input.sessionId })
      if (input.taskId) activeScopes.push({ kind: 'task', id: input.taskId })
      const values = new Map<string, JsonValue>()
      const provenance = new Map<string, JsonValue>()
      for (const scope of activeScopes) {
        const records = [...reference.values()]
          .filter((record) => key(record.scope) === key(scope))
          .filter((record) => record.expiresAt === null || record.expiresAt > now)
          .sort((left, right) =>
            Number(left.expiresAt !== null) - Number(right.expiresAt !== null)
            || left.sequence - right.sequence)
        for (const record of records) {
          for (const [name, value] of Object.entries(record.values)) {
            values.set(name, value)
            provenance.set(name, {
              id: record.id, scope: record.scope,
              source: record.source, expiresAt: record.expiresAt
            })
          }
        }
      }
      const actual = store.resolve(input)
      assert.deepEqual(actual.preferences, Object.fromEntries(values))
      assert.deepEqual(actual.provenance.preferences, Object.fromEntries(provenance))
    }
  }
})

test('personas are immutable, versioned definitions', () => {
  const store = createContextStore()
  const first = registerPersona(store)
  const second = registerPersona(store, '2.0.0')

  assert.equal(first, 'snow@1.0.0')
  assert.equal(second, 'snow@2.0.0')
  assert.throws(
    () => registerPersona(store),
    (error: unknown) => hasErrorCode(error, 'CONTEXT_PERSONA_EXISTS')
  )

  const resolved = store.resolve({ persona: first })
  assert.deepEqual(resolved.persona, {
    id: 'snow',
    version: '1.0.0',
    name: 'Snow',
    identity: { role: 'assistant' },
    style: { tone: 'warm' }
  })
  assert.equal(Object.isFrozen(resolved), true)
  assert.equal(Object.isFrozen(resolved.persona.identity), true)
})

test('configuration follows scope priority and records provenance', () => {
  const store = createContextStore()
  const persona = registerPersona(store)

  store.setConfiguration({
    scope: { kind: 'global' },
    values: { language: 'zh', tone: 'neutral', globalOnly: true },
    source: 'migration'
  })
  store.setConfiguration({
    scope: { kind: 'persona', id: persona },
    values: { tone: 'persona' },
    source: 'migration'
  })
  store.setConfiguration({
    scope: { kind: 'conversation', id: 'conversation-a' },
    values: { tone: 'conversation' },
    source: 'operator'
  })
  store.setConfiguration({
    scope: { kind: 'user', id: 'user-a' },
    values: { tone: 'user' },
    source: 'operator'
  })
  store.setConfiguration({
    scope: { kind: 'session', id: 'session-a' },
    values: { tone: 'session' },
    source: 'operator'
  })
  store.setConfiguration({
    scope: { kind: 'task', id: 'task-a' },
    values: { tone: 'task' },
    source: 'operator'
  })

  const resolved = store.resolve({
    persona,
    conversationId: 'conversation-a',
    userId: 'user-a',
    sessionId: 'session-a',
    taskId: 'task-a'
  })
  assert.deepEqual(resolved.configuration, {
    language: 'zh',
    tone: 'task',
    globalOnly: true
  })
  assert.deepEqual(resolved.provenance.configuration.tone, {
    scope: { kind: 'task', id: 'task-a' },
    source: 'operator'
  })
  assert.deepEqual(resolved.provenance.configuration.language, {
    scope: { kind: 'global' },
    source: 'migration'
  })

  const isolated = store.resolve({
    persona,
    conversationId: 'conversation-b',
    userId: 'user-b'
  })
  assert.equal(isolated.configuration.tone, 'persona')

  assert.throws(
    () =>
      store.setConfiguration({
        scope: { kind: 'global' },
        values: {},
        source: 'model-inference' as 'operator'
      }),
    (error: unknown) => hasErrorCode(error, 'CONTEXT_INVALID_SOURCE')
  )
})

test('preferences require explicit sources and temporary overrides expire', () => {
  let now = 1_000
  const store = createContextStore({ clock: () => now })
  const persona = registerPersona(store)

  store.setPreferences({
    id: 'persistent',
    scope: { kind: 'user', id: 'user-a' },
    values: { verbosity: 'brief', emoji: false },
    source: 'confirmed-user'
  })
  store.setPreferences({
    id: 'temporary',
    scope: { kind: 'user', id: 'user-a' },
    values: { verbosity: 'detailed' },
    source: 'operator',
    expiresAt: 2_000
  })

  let resolved = store.resolve({ persona, userId: 'user-a' })
  assert.deepEqual(resolved.preferences, { verbosity: 'detailed', emoji: false })
  assert.deepEqual(resolved.provenance.preferences.verbosity, {
    id: 'temporary',
    scope: { kind: 'user', id: 'user-a' },
    source: 'operator',
    expiresAt: 2_000
  })

  now = 2_000
  resolved = store.resolve({ persona, userId: 'user-a' })
  assert.deepEqual(resolved.preferences, { verbosity: 'brief', emoji: false })
  assert.equal(resolved.provenance.preferences.verbosity.id, 'persistent')

  assert.throws(
    () =>
      store.setPreferences({
        id: 'inferred',
        scope: { kind: 'user', id: 'user-a' },
        values: { emoji: true },
        source: 'model-inference' as 'operator'
      }),
    (error: unknown) => hasErrorCode(error, 'CONTEXT_INVALID_PREFERENCE_SOURCE')
  )
  assert.equal(store.removePreferences('persistent'), true)
  assert.deepEqual(store.resolve({ persona, userId: 'user-a' }).preferences, {})
})

test('higher scopes override lower temporary preferences', () => {
  const store = createContextStore({ clock: () => 100 })
  const persona = registerPersona(store)

  store.setPreferences({
    id: 'global-temporary',
    scope: { kind: 'global' },
    values: { cadence: 'fast' },
    source: 'operator',
    expiresAt: 1_000
  })
  store.setPreferences({
    id: 'conversation-default',
    scope: { kind: 'conversation', id: 'conversation-a' },
    values: { cadence: 'calm' },
    source: 'confirmed-user'
  })

  const resolved = store.resolve({ persona, conversationId: 'conversation-a' })
  assert.equal(resolved.preferences.cadence, 'calm')
  assert.equal(resolved.provenance.preferences.cadence.id, 'conversation-default')
})

test('a preference id can update within its scope but cannot migrate across scopes', () => {
  const store = createContextStore()
  const persona = registerPersona(store)

  store.setPreferences({
    id: 'stable-preference',
    scope: { kind: 'user', id: 'user-a' },
    values: { tone: 'warm' },
    source: 'confirmed-user'
  })
  store.setPreferences({
    id: 'stable-preference',
    scope: { kind: 'user', id: 'user-a' },
    values: { tone: 'calm' },
    source: 'operator'
  })

  assert.equal(store.resolve({ persona, userId: 'user-a' }).preferences.tone, 'calm')
  assert.throws(
    () =>
      store.setPreferences({
        id: 'stable-preference',
        scope: { kind: 'conversation', id: 'conversation-a' },
        values: { tone: 'migrated' },
        source: 'operator'
      }),
    (error: unknown) => hasErrorCode(error, 'CONTEXT_PREFERENCE_SCOPE_MISMATCH')
  )
  assert.equal(store.resolve({ persona, userId: 'user-a' }).preferences.tone, 'calm')
  assert.deepEqual(
    store.resolve({ persona, conversationId: 'conversation-a' }).preferences,
    {}
  )
})

test('persona versions, conversations, users and tasks remain isolated', () => {
  const store = createContextStore()
  const snowOne = registerPersona(store)
  const snowTwo = registerPersona(store, '2.0.0')
  const luna = store.registerPersona({
    id: 'luna',
    version: '1.0.0',
    name: 'Luna',
    identity: { role: 'moderator' },
    style: { tone: 'direct' }
  })

  const isolatedScopes = [
    [{ kind: 'persona', id: snowOne }, 'snow-one'],
    [{ kind: 'persona', id: snowTwo }, 'snow-two'],
    [{ kind: 'persona', id: luna }, 'luna-one'],
    [{ kind: 'conversation', id: 'group-a' }, 'group-a'],
    [{ kind: 'conversation', id: 'group-b' }, 'group-b'],
    [{ kind: 'user', id: 'user-a' }, 'user-a'],
    [{ kind: 'user', id: 'user-b' }, 'user-b'],
    [{ kind: 'task', id: 'task-a' }, 'task-a'],
    [{ kind: 'task', id: 'task-b' }, 'task-b']
  ] as const

  for (const [scope, marker] of isolatedScopes) {
    store.setConfiguration({ scope, values: { [marker]: true }, source: 'operator' })
    store.setPreferences({
      id: `${marker}-preference`,
      scope,
      values: { [`${marker}-preference`]: true },
      source: 'operator'
    })
  }

  const selected = store.resolve({
    persona: snowOne,
    conversationId: 'group-a',
    userId: 'user-a',
    taskId: 'task-a'
  })
  assert.deepEqual(selected.configuration, {
    'snow-one': true,
    'group-a': true,
    'user-a': true,
    'task-a': true
  })
  assert.deepEqual(selected.preferences, {
    'snow-one-preference': true,
    'group-a-preference': true,
    'user-a-preference': true,
    'task-a-preference': true
  })

  const alternate = store.resolve({
    persona: snowTwo,
    conversationId: 'group-b',
    userId: 'user-b',
    taskId: 'task-b'
  })
  assert.deepEqual(alternate.configuration, {
    'snow-two': true,
    'group-b': true,
    'user-b': true,
    'task-b': true
  })
  assert.deepEqual(alternate.preferences, {
    'snow-two-preference': true,
    'group-b-preference': true,
    'user-b-preference': true,
    'task-b-preference': true
  })
  const lunaContext = store.resolve({ persona: luna })
  assert.deepEqual(lunaContext.configuration, { 'luna-one': true })
  assert.deepEqual(lunaContext.preferences, { 'luna-one-preference': true })
})

test('prototype-shaped data keys remain own data without prototype pollution', () => {
  const store = createContextStore()
  const persona = registerPersona(store)
  const parsed: unknown = JSON.parse(
    '{"__proto__":{"polluted":"configuration"},"constructor":{"prototype":{"polluted":"constructor"}}}'
  )
  const shaped = objectValue(parsed as JsonValue)

  store.setConfiguration({
    scope: { kind: 'global' },
    values: shaped,
    source: 'migration'
  })
  store.setPreferences({
    id: 'prototype-keys',
    scope: { kind: 'user', id: 'user-a' },
    values: shaped,
    source: 'operator'
  })

  const resolved = store.resolve({ persona, userId: 'user-a' })
  assert.equal(Object.hasOwn(resolved.configuration, '__proto__'), true)
  assert.equal(Object.hasOwn(resolved.configuration, 'constructor'), true)
  assert.equal(objectValue(resolved.configuration['__proto__']).polluted, 'configuration')
  assert.equal(
    objectValue(objectValue(resolved.preferences['constructor']).prototype).polluted,
    'constructor'
  )
  assert.equal(
    objectValue(resolved.provenance.configuration['__proto__']).source,
    'migration'
  )
  assert.equal(
    objectValue(resolved.provenance.preferences['constructor']).id,
    'prototype-keys'
  )
  assert.equal((Object.prototype as { polluted?: unknown }).polluted, undefined)
  assert.equal(({} as { polluted?: unknown }).polluted, undefined)
})

test('management descriptions expose metadata without stored values', () => {
  const store = createContextStore({ clock: () => 10 })
  const persona = registerPersona(store)
  store.setConfiguration({
    scope: { kind: 'persona', id: persona },
    values: { privateValue: 'configuration-secret' },
    source: 'migration'
  })
  store.setPreferences({
    id: 'preference-a',
    scope: { kind: 'conversation', id: 'conversation-a' },
    values: { privateValue: 'preference-secret' },
    source: 'operator',
    expiresAt: 20
  })

  const description = store.describe()
  assert.equal(Object.isFrozen(description), true)
  assert.deepEqual(description.personas, [
    { key: persona, id: 'snow', version: '1.0.0', name: 'Snow' }
  ])
  assert.deepEqual(description.configurations[0]?.keys, ['privateValue'])
  assert.equal(description.preferences[0]?.active, true)
  assert.equal(JSON.stringify(description).includes('configuration-secret'), false)
  assert.equal(JSON.stringify(description).includes('preference-secret'), false)
})

test('feature state is private to each feature and conversation namespace', () => {
  const state = createFeatureState()
  const first = state.scope('conversation', 'conversation-a')
  const otherFeature = state.scope('reminder', 'conversation-a')
  const otherConversation = state.scope('conversation', 'conversation-b')
  const mutable = { count: 1, nested: { status: 'stored' } }

  assert.equal(first.get('missing'), null)
  assert.equal(first.get('missing', 'fallback'), 'fallback')
  first.set('progress', mutable)
  mutable.count = 2
  mutable.nested.status = 'mutated'

  const stored = objectValue(first.get('progress'))
  assert.deepEqual(stored, { count: 1, nested: { status: 'stored' } })
  assert.equal(Object.isFrozen(stored), true)
  const storedNested = objectValue(stored.nested)
  assert.equal(Object.isFrozen(storedNested), true)
  assert.throws(() => {
    storedNested.status = 'exposed'
  }, TypeError)
  assert.equal(otherFeature.get('progress'), null)
  assert.equal(otherConversation.get('progress'), null)
  otherFeature.set('private', 'do-not-describe')

  const description = state.describe()
  assert.deepEqual(description, {
    namespaces: [
      { featureId: 'conversation', conversationId: 'conversation-a', entries: 1 },
      { featureId: 'conversation', conversationId: 'conversation-b', entries: 0 },
      { featureId: 'reminder', conversationId: 'conversation-a', entries: 1 }
    ]
  })
  assert.equal(Object.isFrozen(description), true)
  assert.equal(Object.isFrozen(description.namespaces[0]), true)
  assert.throws(() => {
    const firstNamespace = description.namespaces[0]
    assert(firstNamespace)
    firstNamespace.entries = 100
  }, TypeError)
  assert.equal(JSON.stringify(description).includes('do-not-describe'), false)
  assert.equal(first.delete('progress'), true)
  assert.equal(first.get('progress'), null)
})

test('feature state safely stores prototype-shaped keys and values', () => {
  const state = createFeatureState()
  const scoped = state.scope('conversation', 'conversation-a')
  const parsed: unknown = JSON.parse(
    '{"__proto__":{"polluted":"state"},"constructor":{"prototype":{"polluted":"state"}}}'
  )
  const shaped = objectValue(parsed as JsonValue)

  scoped.set('__proto__', shaped)
  scoped.set('constructor', { safe: true })
  objectValue(shaped['__proto__']).polluted = 'mutated'

  assert.equal(objectValue(objectValue(scoped.get('__proto__'))['__proto__']).polluted, 'state')
  assert.deepEqual(scoped.get('constructor'), { safe: true })
  assert.equal((Object.prototype as { polluted?: unknown }).polluted, undefined)
  assert.deepEqual(state.describe(), {
    namespaces: [{ featureId: 'conversation', conversationId: 'conversation-a', entries: 2 }]
  })
  assert.equal(JSON.stringify(state.describe()).includes('polluted'), false)
})
