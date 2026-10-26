import assert from 'node:assert/strict'
import test from 'node:test'
import { chatCompactionHeadroom, parseChatCapacityRecommendation, recommendChatCapacity } from '../src/contracts/chat-capacity.ts'

test('known capacity produces group/private recommendations and compaction space without a fixed 128k assumption', () => {
  for (const [contextWindow, maxTokens] of [[8192, 2048], [200000, 32000], [1048576, 32768], [4096, 4095]]) {
    const result = recommendChatCapacity({ contextWindow, maxTokens })!
    assert(result)
    assert(result.recommended.group > maxTokens && result.recommended.group <= contextWindow)
    assert.equal(result.recommended.group, Math.max(maxTokens + 1, Math.floor(contextWindow * 0.4)))
    assert.equal(result.recommended.private, Math.max(maxTokens + 1, Math.floor(contextWindow * 0.7)))
    for (const limit of Object.values(result.recommended)) assert(limit - maxTokens - chatCompactionHeadroom(limit, maxTokens) > 0)
    assert.deepEqual(parseChatCapacityRecommendation(result), result)
  }
  assert.equal(recommendChatCapacity({ contextWindow: 8192, maxTokens: 8192 }), null)
  assert.equal(recommendChatCapacity({}), null)
  assert.equal(parseChatCapacityRecommendation({ ...recommendChatCapacity({ contextWindow: 8192, maxTokens: 2048 }), recommended: { group: 128000, private: 128000 } }), null)
})
