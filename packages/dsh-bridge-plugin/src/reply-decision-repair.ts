import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'qaf-reply-decision-repair': { readonly kind: 'qaf-reply-decision-repair'; readonly requestId: string;
      readonly turn: number; readonly form: 'notice'; readonly summary: string }
  }
}

export interface ReplyDecisionAgent {
  readonly id: string
  readonly session: { readonly id: string }
  readonly status: string
  steer(message: UserMessage): void
}
interface Decision {
  readonly turn: number
  readonly requestId: string
  readonly userMessageId: string
  attempted: boolean
  repaired: boolean
  final: string
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const repairText = '本轮正文还没有发送到QQ。现在只做一次明确决定：需要答复就调用 qaf_reply 发送；无需发言就输出 {"schema":"qaf.reply/1","action":"silent","reason":"no-useful-addition"}。沿用本轮原始用户来源和权限，不重复已执行的工具，不新增工作或调用其他工具。'

function addressed(content: UserMessage['content']): boolean {
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('')
  const prefix = '会话事实：\n'
  const ends = ['当前消息：\n', '本批最新消息（结合未读消息选择回应对象）：\n']
    .map(label => text.indexOf(label)).filter(index => index >= 0)
  const end = ends.length ? Math.min(...ends) : -1
  if (!text.startsWith(prefix) || end < prefix.length || end > 64 * 1024) return false
  try {
    const facts: unknown = JSON.parse(text.slice(prefix.length, end).trim())
    return object(facts) && typeof facts.senderId === 'string' && typeof facts.conversationId === 'string'
      && /^(group|private):/.test(facts.conversationId) && (facts.participation === 'direct' || facts.participation === 'reply'
        || Array.isArray(facts.groupWake) && facts.groupWake.some(wake => object(wake) && (wake.reason === 'direct' || wake.reason === 'reply')))
  } catch { return false }
}
function silent(text: string): boolean {
  if (text.length > 2048) return false
  try {
    const value: unknown = JSON.parse(text)
    return object(value) && Object.keys(value).length === 3 && value.schema === 'qaf.reply/1' && value.action === 'silent'
      && ['not-addressed', 'already-answered', 'no-useful-addition', 'user-requested'].includes(String(value.reason))
  } catch { return false }
}

/** A bounded same-turn reminder. It never manufactures a QQ send or a user claim. */
export function createReplyDecisionRepair(options: {
  readonly current: (agent: ReplyDecisionAgent) => boolean
  readonly hasReplyLease: (agent: ReplyDecisionAgent) => boolean
}) {
  const decisions = new WeakMap<ReplyDecisionAgent, Decision>()
  return Object.freeze({
    claimed(agent: ReplyDecisionAgent, message: UserMessage, turn: number): void {
      // Synthetic steering and context do not replace the authentic user RPC claim.
      if (message.source.kind !== 'user' || !('rpcId' in message.source) || typeof message.source.rpcId !== 'string') return
      decisions.delete(agent)
      if (!options.current(agent) || !options.hasReplyLease(agent) || !addressed(message.content)) return
      decisions.set(agent, { turn, requestId: message.source.rpcId, userMessageId: message.id,
        attempted: false, repaired: false, final: '' })
    },
    assistant(agent: ReplyDecisionAgent, turn: number, content: unknown): void {
      const decision = decisions.get(agent)
      if (!decision || decision.turn !== turn || !Array.isArray(content)) return
      if (content.some(block => object(block) && block.type === 'tool-call' && block.name === 'qaf_reply')) decision.attempted = true
      decision.final = content.filter(block => object(block) && block.type === 'text' && typeof block.text === 'string')
        .map(block => object(block) ? String(block.text) : '').join('').trim()
    },
    attempted(agent: ReplyDecisionAgent, claim: { readonly requestId: string; readonly userMessageId: string; readonly turn: number }): void {
      const decision = decisions.get(agent)
      if (decision?.turn === claim.turn && decision.requestId === claim.requestId && decision.userMessageId === claim.userMessageId)
        decision.attempted = true
    },
    stopping(agent: ReplyDecisionAgent, turn: number, signal: AbortSignal): void {
      const decision = decisions.get(agent)
      if (signal.aborted || !decision || decision.turn !== turn || decision.repaired || decision.attempted || !decision.final
        || silent(decision.final) || agent.status !== 'running' || !options.current(agent) || !options.hasReplyLease(agent)) return
      // Set before steering: the SDK re-enters this boundary only after the next step.
      decision.repaired = true
      agent.steer(createUserMessage({ content: [{ type: 'text', text: repairText }], source: {
        kind: 'qaf-reply-decision-repair', requestId: decision.requestId, turn, form: 'notice', summary: '确认本轮QQ发送或静默决定'
      } }))
    },
    clear(agent: ReplyDecisionAgent): void { decisions.delete(agent) }
  })
}
