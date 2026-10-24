import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_DAILY_CHAT_PLAN,
  BUILTIN_WHALE_PERSONA,
  createBuiltinDailyChatPlanDraft,
  createBuiltinWhalePersonaDraft
} from '../src/host/chat-templates.ts'
import { isChatPlan, validateChatPersona, validateChatPlan, validateChatPlanCatalog } from '../src/host/chat-plans.ts'

test('built-in persona is a shareable identity/style template, not permissions or preferences', () => {
  assert.deepEqual(Object.keys(BUILTIN_WHALE_PERSONA).sort(), ['id', 'identity', 'name', 'style'])
  assert.equal(BUILTIN_WHALE_PERSONA.name, '小鲸鱼')
  assert.match(BUILTIN_WHALE_PERSONA.identity, /鲸鲸/)
  assert.deepEqual(validateChatPersona(BUILTIN_WHALE_PERSONA), BUILTIN_WHALE_PERSONA)
  assert(Object.isFrozen(BUILTIN_WHALE_PERSONA))
  assert.doesNotMatch(BUILTIN_WHALE_PERSONA.identity + BUILTIN_WHALE_PERSONA.style, /授权|权限|工具|主人|偏好|定时|生图|https?:\/\//)
})

test('daily template separates instructions from identity and requires explicit model/persona selection', () => {
  assert.deepEqual(Object.keys(BUILTIN_DAILY_CHAT_PLAN).sort(), [
    'contextLimits', 'description', 'id', 'instructions', 'name', 'reasoningEffort'
  ])
  assert.equal(BUILTIN_DAILY_CHAT_PLAN.name, '日常聊天方案')
  assert.match(BUILTIN_DAILY_CHAT_PLAN.instructions, /当前消息与相关上下文/)
  assert.doesNotMatch(BUILTIN_DAILY_CHAT_PLAN.instructions, /鲸鲸|小鲸鱼|授权|主动(?:联系|发送|聊天)|定时(?:发送|触发|任务)|生图|genimage|https?:\/\//i)
  assert(Object.isFrozen(BUILTIN_DAILY_CHAT_PLAN))
  assert(Object.isFrozen(BUILTIN_DAILY_CHAT_PLAN.contextLimits))
  assert.equal(isChatPlan(BUILTIN_DAILY_CHAT_PLAN), false)
  const draft = createBuiltinDailyChatPlanDraft([], [])
  assert.equal(draft.provider, '')
  assert.equal(draft.model, '')
  assert.equal(draft.personaId, '')
  assert.equal(isChatPlan(draft), false)
  assert.deepEqual(draft.contextLimits, { group: 128_000, private: 128_000 })
})

test('static templates round-trip through JSON without credentials or deployment bindings', () => {
  const templates = { persona: BUILTIN_WHALE_PERSONA, plan: BUILTIN_DAILY_CHAT_PLAN }
  const serialized = JSON.stringify(templates)
  assert.deepEqual(JSON.parse(serialized), templates)
  assert.doesNotMatch(serialized, /provider|model|auth|token|secret|endpoint|activePlanId|enabled|capabilities|preferences/i)
})

test('persona draft is independent and editable without changing the static template', () => {
  const first = createBuiltinWhalePersonaDraft([])
  const second = createBuiltinWhalePersonaDraft([])
  assert.notEqual(first, second)
  assert(!Object.isFrozen(first))
  Object.assign(first, { identity: 'An independently edited identity.', style: 'A new style.' })
  assert.notEqual(first.identity, BUILTIN_WHALE_PERSONA.identity)
  assert.deepEqual(second, BUILTIN_WHALE_PERSONA)
})

test('templates allocate unused copy IDs and never overwrite existing catalogs', () => {
  const personas = Object.freeze([
    Object.freeze({ ...BUILTIN_WHALE_PERSONA, identity: 'An existing edited identity.' }),
    Object.freeze({ ...BUILTIN_WHALE_PERSONA, id: 'whale-copy' }),
    Object.freeze({ ...BUILTIN_WHALE_PERSONA, id: 'whale-copy-2' })
  ])
  const plans = Object.freeze([
    Object.freeze({ id: 'daily-chat' }), Object.freeze({ id: 'daily-chat-copy' }),
    Object.freeze({ id: 'daily-chat-copy-2' })
  ])
  const snapshot = JSON.stringify({ personas, plans })
  assert.equal(createBuiltinWhalePersonaDraft(personas).id, 'whale-copy-3')
  assert.equal(createBuiltinDailyChatPlanDraft(plans, personas).id, 'daily-chat-copy-3')
  assert.equal(createBuiltinWhalePersonaDraft([personas[0]]).id, 'whale-copy')
  assert.equal(createBuiltinDailyChatPlanDraft([plans[0]], []).id, 'daily-chat-copy')
  assert.equal(JSON.stringify({ personas, plans }), snapshot)
})

test('copy allocation handles many existing IDs and still yields valid identifiers', () => {
  const personas = [{ id: 'whale' }, { id: 'whale-copy' }]
  const plans = [{ id: 'daily-chat' }, { id: 'daily-chat-copy' }]
  for (let suffix = 2; suffix <= 128; suffix++) {
    personas.push({ id: `whale-copy-${suffix}` })
    plans.push({ id: `daily-chat-copy-${suffix}` })
  }
  const persona = createBuiltinWhalePersonaDraft(personas)
  const plan = createBuiltinDailyChatPlanDraft(plans, [])
  assert.equal(persona.id, 'whale-copy-129')
  assert.equal(plan.id, 'daily-chat-copy-129')
  assert.match(persona.id, /^[a-z0-9][a-z0-9._-]{0,127}$/i)
  assert.match(plan.id, /^[a-z0-9][a-z0-9._-]{0,127}$/i)
})

test('plan only links an already registered whale by display name, not guessed IDs', () => {
  assert.equal(createBuiltinDailyChatPlanDraft([], [{ id: 'custom-whale', name: '小鲸鱼' }]).personaId, 'custom-whale')
  assert.equal(createBuiltinDailyChatPlanDraft([], [{ id: 'renamed-whale', name: ' 鲸鲸 ' }]).personaId, 'renamed-whale')
  assert.equal(createBuiltinDailyChatPlanDraft([], [{ id: 'whale', name: 'Unrelated persona' }]).personaId, '')
  assert.equal(createBuiltinDailyChatPlanDraft([], [{ id: 'other', name: 'Other' }]).personaId, '')
})

test('plan drafts have independent context limits and no automatic activation', () => {
  const catalog = Object.freeze({ activePlanId: null, plans: Object.freeze([]) })
  const first = createBuiltinDailyChatPlanDraft(catalog.plans, [])
  const second = createBuiltinDailyChatPlanDraft(catalog.plans, [])
  assert.notEqual(first, second)
  assert.notEqual(first.contextLimits, second.contextLimits)
  assert.notEqual(first.contextLimits, BUILTIN_DAILY_CHAT_PLAN.contextLimits)
  assert(!Object.isFrozen(first.contextLimits))
  Object.assign(first.contextLimits, { group: 64_000 })
  assert.deepEqual(second.contextLimits, { group: 128_000, private: 128_000 })
  assert.deepEqual(BUILTIN_DAILY_CHAT_PLAN.contextLimits, second.contextLimits)
  assert.equal(Object.hasOwn(first, 'activePlanId'), false)
  assert.equal(Object.hasOwn(first, 'enabled'), false)
  assert.deepEqual(catalog, { activePlanId: null, plans: [] })
  const configured = validateChatPlan({ ...first, personaId: 'chosen-persona', provider: 'chosen-provider', model: 'chosen-model' })
  assert.equal(validateChatPlanCatalog({ activePlanId: null, plans: [configured] }).activePlanId, null)
  assert.equal(validateChatPlanCatalog({ activePlanId: configured.id, plans: [configured] }).activePlanId, configured.id)
})
