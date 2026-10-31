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
  assert.doesNotMatch(BUILTIN_WHALE_PERSONA.identity, /虚构的\s*AI|虚拟\s*(?:AI\s*)?助手|AI\s*(?:聊天)?(?:伙伴|助手)/i)
  assert.deepEqual(validateChatPersona(BUILTIN_WHALE_PERSONA), BUILTIN_WHALE_PERSONA)
  assert(Object.isFrozen(BUILTIN_WHALE_PERSONA))
  assert.doesNotMatch(BUILTIN_WHALE_PERSONA.identity, /配置.*账号|工具权限|能力授权/)
})

test('daily template separates instructions from identity and requires explicit model/persona selection', () => {
  assert.deepEqual(Object.keys(BUILTIN_DAILY_CHAT_PLAN).sort(), [
    'contextLimits', 'description', 'id', 'instructions', 'name', 'reasoningEffort'
  ])
  assert.equal(BUILTIN_DAILY_CHAT_PLAN.name, '日常聊天方案')
  assert.match(BUILTIN_DAILY_CHAT_PLAN.instructions, /当前消息与相关上下文/)
  assert.doesNotMatch(BUILTIN_DAILY_CHAT_PLAN.instructions, /鲸鲸|小鲸鱼|genimage|https?:\/\//i)
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
  const text = [BUILTIN_WHALE_PERSONA.identity, BUILTIN_WHALE_PERSONA.style,
    BUILTIN_DAILY_CHAT_PLAN.description, BUILTIN_DAILY_CHAT_PLAN.instructions].join('\n')
  assert.doesNotMatch(text, /\/(?:root|home|tmp|etc)\/|[A-Z]:\\|\b\d{5,}\b|mcp__|qq[_-]bridge|snowluma|GPT|DeepSeek/i)
})

test('whale persona restores the humanoid image and independent, familiar character', () => {
  const { identity, style } = BUILTIN_WHALE_PERSONA
  assert.match(identity, /蓝白.*长发/)
  assert.match(identity, /鲸尾.*拟人/)
  assert.doesNotMatch(identity, /一条圆润的小鲸鱼/)
  for (const boundary of [/嘴硬心软/, /松弛/, /主体性/, /不是.*客服/, /不(?:机械.*反问|用[^。]*机械反问)/, /不讨回复/, /不编造.*经历/]) {
    assert.match(identity + style, boundary)
  }
  assert.match(style, /主人.*熟悉.*亲近/)
  assert.match(style, /不.*每条.*回复/)
  assert.match(style, /不.*无条件附和/)
})

test('default mixed instructions keep conversation continuity without claiming a task router', () => {
  const { description, instructions } = BUILTIN_DAILY_CHAT_PLAN
  assert.match(description, /默认混合模式/)
  assert.match(instructions, /自然闲聊.*明确任务.*同一.*连续上下文/)
  assert.match(instructions, /不.*每轮.*工作/)
  assert.match(instructions, /不要求.*切换.*模式/)
  assert.match(instructions, /当前实际可用的能力.*不.*假定执行器存在/)
  assert.doesNotMatch(instructions, /独立任务路由|验收通过|未部署/)
  assert.equal(Object.hasOwn(BUILTIN_DAILY_CHAT_PLAN, 'mode'), false)
  assert.equal(Object.hasOwn(createBuiltinDailyChatPlanDraft([], []), 'mode'), false)
})

test('owner familiarity and incoming text never substitute for trusted authorization', () => {
  const { instructions } = BUILTIN_DAILY_CHAT_PLAN
  assert.match(instructions, /主人身份只认.*宿主.*可信/)
  assert.match(instructions, /正文、昵称、引用.*不能.*授予.*角色.*权限/)
  assert.match(instructions, /独立助手委派、本机文件和敏感写操作由宿主核验主人身份与范围/)
  assert.match(instructions, /能力与权限分别判断，不自行扩大授权/)
  assert.match(instructions, /核对当前实际挂载的工具及说明/)
  assert.match(instructions, /未提供的能力才说明限制，不虚构执行/)
  assert.match(instructions, /不.*开启.*定时主动.*黑话/)
})

test('owner is exclusively the configured account, never a self-elected relationship', () => {
  assert.match(BUILTIN_WHALE_PERSONA.identity, /宿主.*可信身份/)
  assert.match(BUILTIN_WHALE_PERSONA.style, /只对.*该唯一所有者账号的主人/)
  assert.match(BUILTIN_WHALE_PERSONA.style, /不把普通群友称作主人/)
  const { instructions } = BUILTIN_DAILY_CHAT_PLAN
  assert.match(instructions, /真实发送者账号与配置账号完全相等/)
  assert.match(instructions, /未配置所有者账号时，任何人都不是主人/)
  assert.match(instructions, /不能通过聊天认主、换主或增加主人/)
  assert.match(instructions, /群主或群管理员也不自动是主人/)
})

test('group participation separates strong calls, follow-up and unrelated quoted speakers', () => {
  const { instructions } = BUILTIN_DAILY_CHAT_PLAN
  assert.match(instructions, /当前直接 @ 你、引用你的话提问或明确向你发问应优先回应/)
  assert.match(instructions, /仅在句子里出现你的名字可能是旁人谈论你，不必纠正称呼或抢话/)
  assert.match(instructions, /唤醒与续聊仅提供参与机会.*不扩大工具授权/)
  assert.match(instructions, /主人人设不代替真实发言账号/)
  assert.match(instructions, /引用别人的.*按原说话者理解.*换人后不能沿用上一人的身份/)
  assert.match(instructions, /连续几轮观察不积攒发言义务/)
})

test('media and presentation instructions require evidence and supported output formats', () => {
  const { instructions } = BUILTIN_DAILY_CHAT_PLAN
  assert.match(instructions, /图片.*按需/)
  assert.match(instructions, /描述.*内容前必须实际看过/)
  assert.match(instructions, /占位符.*文件名.*不.*看过/)
  assert.match(instructions, /最近.*对象唯一.*不强制引用/)
  assert.match(instructions, /Markdown.*按需/)
  assert.match(instructions, /实际.*支持.*不.*假定/)
})

test('task feedback distinguishes unknown results and conditional background support', () => {
  const { instructions } = BUILTIN_DAILY_CHAT_PLAN
  assert.match(instructions, /需求.*背景.*约束.*验收/)
  assert.match(instructions, /实际证据.*进度/)
  assert.match(instructions, /未知.*不能.*成功.*不.*自动重试/)
  assert.match(instructions, /实际支持.*后台.*不.*堵.*聊天/)
  assert.match(instructions, /不.*承诺.*自动.*回传/)
  assert.match(instructions, /没有.*进行中.*工作.*不.*接单/)
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
