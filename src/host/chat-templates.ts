import type { ChatPersona, ChatPlan, NormalizedChatPlan } from './chat-plans.ts'

export type ChatPlanTemplate = Omit<NormalizedChatPlan, 'personaId' | 'provider' | 'model'>

export const BUILTIN_WHALE_PERSONA: ChatPersona = Object.freeze({
  id: 'whale',
  name: '小鲸鱼',
  identity: '你叫小鲸鱼，也可以称作鲸鲸，是一个虚构的海洋主题聊天伙伴。形象是一条圆润的小鲸鱼，性格温和、好奇，有一点俏皮。不编造现实经历或与对话者之间未说明的关系。',
  style: '使用自然流畅的中文，语气亲切、轻松，不刻意卖萌。措辞简洁，需要认真说明时清楚表达；玩笑点到为止，不堆叠口头禅、表情或夸张比喻。'
})

export const BUILTIN_DAILY_CHAT_PLAN: ChatPlanTemplate = Object.freeze({
  id: 'daily-chat',
  name: '日常聊天方案',
  description: '适合群聊与私聊的日常交流；身份和表达风格由关联人设独立定义。',
  instructions: '围绕当前消息与相关上下文自然接话，不机械复述前文或套用固定开场。先回应对方真正关心的内容，简单问题简短回答，复杂问题按需展开；只有缺少关键信息时才追问。不确定时坦诚说明，不把普通闲聊写成工作汇报。',
  reasoningEffort: 'low',
  contextLimits: Object.freeze({ group: 128_000, private: 128_000 })
})

function unusedId(base: string, entries: readonly { readonly id: string }[]): string {
  const ids = new Set(entries.map(entry => entry.id))
  if (!ids.has(base)) return base
  const copy = `${base}-copy`
  if (!ids.has(copy)) return copy
  let suffix = 2
  while (ids.has(`${copy}-${suffix}`)) suffix++
  return `${copy}-${suffix}`
}

export function createBuiltinWhalePersonaDraft(personas: readonly Pick<ChatPersona, 'id'>[]): ChatPersona {
  return { ...BUILTIN_WHALE_PERSONA, id: unusedId(BUILTIN_WHALE_PERSONA.id, personas) }
}

export function createBuiltinDailyChatPlanDraft(
  plans: readonly Pick<ChatPlan, 'id'>[],
  personas: readonly Pick<ChatPersona, 'id' | 'name'>[]
): NormalizedChatPlan {
  const whale = personas.find(persona => persona.name.trim() === '小鲸鱼' || persona.name.trim() === '鲸鲸')
  return {
    ...BUILTIN_DAILY_CHAT_PLAN,
    id: unusedId(BUILTIN_DAILY_CHAT_PLAN.id, plans),
    personaId: whale?.id ?? '',
    provider: '',
    model: '',
    contextLimits: { ...BUILTIN_DAILY_CHAT_PLAN.contextLimits }
  }
}
