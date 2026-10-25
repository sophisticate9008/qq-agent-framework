import { BUILTIN_WHALE_PERSONA } from './chat-personas.ts'
import { DAILY_CHAT_OPERATING_INSTRUCTIONS } from './chat-operating-instructions.ts'
export { BUILTIN_WHALE_PERSONA } from './chat-personas.ts'
import type { ChatPersona, ChatPlan, NormalizedChatPlan } from './chat-plans.ts'

export type ChatPlanTemplate = Omit<NormalizedChatPlan, 'personaId' | 'provider' | 'model'>


export const BUILTIN_DAILY_CHAT_PLAN: ChatPlanTemplate = Object.freeze({
  id: 'daily-chat',
  name: '日常聊天方案',
  description: '默认混合模式：自然闲聊与明确任务共用连续上下文，不是每轮工作；身份和表达风格由关联人设定义，实际执行仍取决于挂载能力与独立授权。',
  instructions: DAILY_CHAT_OPERATING_INSTRUCTIONS,
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
