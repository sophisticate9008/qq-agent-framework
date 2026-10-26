import type { ChatContextLimits } from './chat-plans.ts'

export interface ChatCapacityRecommendation {
  readonly source: 'model-metadata'
  readonly contextWindow: number
  readonly maxTokens: number
  readonly recommended: ChatContextLimits
  readonly compaction: { readonly groupHeadroomTokens: number; readonly privateHeadroomTokens: number }
}
/** Reserve additional space before the model's output budget is reached; small windows retain a positive input budget. */
export function chatCompactionHeadroom(contextWindow: number, maxTokens: number): number {
  if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || contextWindow <= maxTokens || contextWindow > 16_777_216) throw new TypeError('Invalid model capacity')
  return Math.min(8192, Math.floor((contextWindow - maxTokens) * 0.05))
}
export function recommendChatCapacity(metadata: unknown): ChatCapacityRecommendation | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = metadata as Record<string, unknown>
  const contextWindow = value.contextWindow
  const maxTokens = value.maxTokens
  if (typeof contextWindow !== 'number' || typeof maxTokens !== 'number' || !Number.isSafeInteger(contextWindow)
    || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || contextWindow <= maxTokens || contextWindow > 16_777_216) return null
  const group = Math.max(maxTokens + 1, Math.floor(contextWindow * 0.4))
  const privateContext = Math.max(maxTokens + 1, Math.floor(contextWindow * 0.7))
  return Object.freeze({ source: 'model-metadata', contextWindow, maxTokens, recommended: Object.freeze({ group, private: privateContext }),
    compaction: Object.freeze({ groupHeadroomTokens: chatCompactionHeadroom(group, maxTokens), privateHeadroomTokens: chatCompactionHeadroom(privateContext, maxTokens) }) })
}
export function parseChatCapacityRecommendation(input: unknown): ChatCapacityRecommendation | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const expected = recommendChatCapacity(value)
  if (!expected || value.source !== 'model-metadata' || Object.keys(value).length !== 5
    || value.recommended === null || typeof value.recommended !== 'object' || Array.isArray(value.recommended)
    || value.compaction === null || typeof value.compaction !== 'object' || Array.isArray(value.compaction)) return null
  const recommended = value.recommended as Record<string, unknown>
  const compaction = value.compaction as Record<string, unknown>
  return Object.keys(recommended).length === 2 && recommended.group === expected.recommended.group && recommended.private === expected.recommended.private
    && Object.keys(compaction).length === 2 && compaction.groupHeadroomTokens === expected.compaction.groupHeadroomTokens
    && compaction.privateHeadroomTokens === expected.compaction.privateHeadroomTokens ? expected : null
}
