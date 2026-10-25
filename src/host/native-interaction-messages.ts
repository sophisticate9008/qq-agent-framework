import { isConfirmedMessageReceipt } from '../core/delivery.ts'
import type { DeliveryReceipt } from '../core/types.ts'
import type { NativeInteractionEntry, NativeInteractions } from './native-interactions.ts'
import type { InboundMessage } from './types.ts'

export function createNativeInteractionMessages(options: {
  readonly interactions: NativeInteractions
  readonly owner: () => string | null
  readonly send: (conversationId: string, text: string, key: string, signal: AbortSignal) => Promise<DeliveryReceipt>
}) {
  const notifications = new Map<string, string>()
  async function send(conversationId: string, text: string, key: string, signal: AbortSignal) {
    try { return await options.send(conversationId, text, key, signal) } catch { return undefined }
  }

  return Object.freeze({
    async notify(entry: NativeInteractionEntry, signal: AbortSignal): Promise<void> {
      if (entry.status !== 'pending') return
      const question = entry.questions.map((item, index) => `${index + 1}. ${item.text}${item.options.length ? `\n选项：${item.options.join(' / ')}` : ''}`).join('\n')
      const address = entry.conversationId.startsWith('group:') ? '群聊请 @我或引用这条消息回复。' : '直接回复即可。'
      const deadline = `请在${Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000))}秒内回复，过期后需重新提出请求。`
      const text = entry.kind === 'question'
        ? `${question.slice(0, 7_000)}\n${address}${deadline}`
        : `工具${entry.toolName ? ` ${entry.toolName}` : ''}需要确认。\n${entry.summary}\n主人回复“同意”或“拒绝”即可。${address}${deadline}`
      const receipt = await send(entry.conversationId, text, `interaction:${entry.id}:notice`, signal)
      if (isConfirmedMessageReceipt(receipt)) {
        if (notifications.size >= 100) notifications.delete(notifications.keys().next().value!)
        notifications.set(entry.id, receipt.messageId)
      }
    },
    async receive(message: InboundMessage, signal: AbortSignal): Promise<boolean> {
      if (message.isSelf || message.content.some(part => !['text', 'reply', 'mention'].includes(part.type))) return false
      const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim()
      const match = /^\/?(回答|批准|拒绝)\s+([a-f0-9-]{8,36})(?:\s+([\s\S]+))?$/.exec(text)
      const allPending = options.interactions.snapshot().items.filter(entry => entry.conversationId === message.conversationId && entry.status === 'pending')
      const quoted = allPending.filter(entry => message.content.some(part => part.type === 'reply' && part.messageId === notifications.get(entry.id)))
      const pending = quoted.length > 0 ? quoted : allPending
      const addressed = message.conversationId.startsWith('private:') || message.directed
        || quoted.length > 0
      const approval = /^(?:同意|批准|允许|拒绝|不同意|不允许)[。.!！]?$/u.exec(text)
      const reply = /^\/?(?:回答|回复)\s+([\s\S]+)$/u.exec(text)
      let command: string
      let answer: string | undefined
      let matches: readonly NativeInteractionEntry[]
      if (match) {
        command = match[1]!
        answer = match[3]
        matches = pending.filter(entry => entry.id.startsWith(match[2]!))
      } else if (approval && addressed && pending.some(entry => entry.kind === 'approval')) {
        command = /^(?:同意|批准|允许)/u.test(text) ? '批准' : '拒绝'
        matches = pending.filter(entry => entry.kind === 'approval')
      } else if (pending.some(entry => entry.kind === 'question') && (addressed || reply)) {
        command = '回答'
        answer = reply?.[1] ?? text
        matches = pending.filter(entry => entry.kind === 'question')
      } else return false
      const key = `interaction-reply:${message.conversationId}:${message.id}`
      if (matches.length !== 1) {
        await send(message.conversationId, '有多个请求或请求已失效，请引用对应的提问回复。', key, signal)
        return true
      }
      const entry = matches[0]!
      if (command !== '回答' && (!options.owner() || message.userId !== options.owner())) {
        await send(message.conversationId, '工具操作需要主人确认。', key, signal)
        return true
      }
      if (command === '回答' ? entry.kind !== 'question' || !answer?.trim() : entry.kind !== 'approval' || answer !== undefined) {
        await send(message.conversationId, '请直接回答问题，或回复“同意”“拒绝”。', key, signal)
        return true
      }
      try {
        const result = await options.interactions.respond({ id: entry.id, revision: entry.revision,
          action: command === '回答' ? 'reply' : command === '批准' ? 'approve' : 'deny',
          ...(command === '回答' ? { reply: answer!.trim() } : {}) }, signal)
        const text = result.status === 'answered' ? '已提交回答。' : result.status === 'approved' ? '已允许这一次操作。'
          : result.status === 'denied' ? '已拒绝这一次操作。' : result.status === 'unknown'
            ? '暂时无法确认结果，不会自动重复提交。' : '请求可能已到期，未能提交。'
        await send(message.conversationId, text, key, signal)
      } catch {
        await send(message.conversationId, '请求已变化或到期，不会自动重复提交。', key, signal)
      }
      return true
    }
  })
}
