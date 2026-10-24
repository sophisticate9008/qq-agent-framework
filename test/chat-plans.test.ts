import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildChatSessionDefinition,
  isChatPlan,
  selectChatPersona,
  selectChatPlan,
  validateChatPlan,
  validateChatPlanCatalog,
  validateChatPersonas
} from '../src/host/chat-plans.ts'

const persona = {
  id: 'harbor',
  name: 'Harbor',
  identity: 'A precise QQ conversation partner.',
  style: 'Direct, concise, and calm.'
} as const

const plan = {
  id: 'daily',
  name: 'Daily chat',
  description: 'General conversation',
  instructions: 'Answer the current conversation without inventing permissions.',
  personaId: 'harbor',
  provider: 'deepseek-official',
  model: 'deepseek-chat',
  reasoningEffort: 'low'
} as const

test('chat plan validation accepts only bounded whitelist fields', () => {
  assert.equal(isChatPlan(plan), true)
  assert.equal(isChatPlan({ ...plan, tools: ['shell'] }), false)
  assert.equal(isChatPlan({ ...plan, reasoningEffort: 'unbounded' }), false)
  assert.equal(isChatPlan({ ...plan, id: '../legacy' }), false)
  assert.equal(isChatPlan({ ...plan, model: 'models/../../private' }), false)
  assert.throws(() => validateChatPlan({ ...plan, instructions: '' }), /Invalid chat plan/)
  const validated = validateChatPlan(plan)
  assert.deepEqual(validated, { ...plan, contextLimits: { group: 128_000, private: 128_000 } })
  assert(Object.isFrozen(validated))
  assert(Object.isFrozen(validated.contextLimits))
})

test('catalog and persona selectors preserve empty and explicit selection semantics', () => {
  const empty = validateChatPlanCatalog({ activePlanId: null, plans: [] })
  assert.equal(selectChatPlan(empty), null)
  const catalog = validateChatPlanCatalog({ activePlanId: 'daily', plans: [plan] })
  const personas = validateChatPersonas([persona])
  assert.equal(selectChatPlan(catalog)?.id, 'daily')
  assert.equal(selectChatPlan(catalog, 'missing'), null)
  assert.equal(selectChatPersona(personas, 'harbor')?.name, 'Harbor')
  assert.equal(selectChatPersona(personas, 'missing'), null)
  assert.throws(() => validateChatPlanCatalog({ activePlanId: 'missing', plans: [plan] }))
  assert.throws(() => validateChatPersonas([persona, persona]))
})

test('chat session definition remains framework neutral and rejects privilege passthrough', () => {
  const definition = buildChatSessionDefinition(plan, persona)
  assert.deepEqual(definition, {
    planId: 'daily',
    personaId: 'harbor',
    instructions: 'Answer the current conversation without inventing permissions.',
    persona: {
      identity: 'A precise QQ conversation partner.',
      style: 'Direct, concise, and calm.'
    },
    model: {
      provider: 'deepseek-official',
      name: 'deepseek-chat',
      reasoningEffort: 'low'
    }
  })
  assert.equal(Object.hasOwn(definition, 'systemPrompt'), false)
  assert.equal(Object.hasOwn(definition, 'metadata'), false)
  assert.equal(Object.hasOwn(definition, 'tools'), false)
  assert.equal(Object.hasOwn(definition, 'privileges'), false)
  assert(Object.isFrozen(definition.persona))
  assert(Object.isFrozen(definition.model))
  assert.throws(() => buildChatSessionDefinition(plan, { ...persona, id: 'other' }))
})

test('chat plans normalize legacy context limits and validate independent explicit budgets', () => {
  for (const contextLimits of [
    null, undefined, {}, { group: 1 }, { group: 1, private: 2, extra: 3 },
    { group: 0, private: 2 }, { group: 1, private: -1 },
    { group: 1.5, private: 2 }, { group: 1, private: 16_777_217 },
    { group: NaN, private: 2 }, { group: 1, private: Infinity }, { group: '128000', private: 2 }
  ]) {
    assert.equal(isChatPlan({ ...plan, contextLimits }), false)
    assert.throws(() => validateChatPlan({ ...plan, contextLimits }), /Invalid chat plan/)
  }
  const contextLimits = { group: 1, private: 16_777_216 }
  const normalized = validateChatPlan({ ...plan, contextLimits })
  contextLimits.group = 512
  assert.deepEqual(normalized.contextLimits, { group: 1, private: 16_777_216 })
  const definition = buildChatSessionDefinition(normalized, persona)
  assert.deepEqual(definition.contextLimits, normalized.contextLimits)
  assert(Object.isFrozen(definition.contextLimits))
  assert.equal(Object.hasOwn(buildChatSessionDefinition(plan, persona), 'contextLimits'), false)
  const legacyCatalog = validateChatPlanCatalog({ activePlanId: plan.id, plans: [plan] })
  assert.deepEqual(selectChatPlan(legacyCatalog)?.contextLimits, { group: 128_000, private: 128_000 })
})
