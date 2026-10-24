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
  assert.deepEqual(validated, plan)
  assert(Object.isFrozen(validated))
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
