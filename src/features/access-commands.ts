import { createHash } from 'node:crypto'
import type { DeliveryReceipt } from '../core/types.ts'
import type { NativeChatAccess } from '../host/native-chat-configuration.ts'
import type { InboundMessage } from '../contracts/ports.ts'

interface AccessCommand {
  readonly kind: 'group' | 'private'
  readonly operation: 'add' | 'remove'
  readonly targetId: string | null
}

interface AccessDocument {
  readonly revision: string
  readonly value: NativeChatAccess
}

interface AccessChangeRequest {
  readonly actorId: string
  readonly expectedRevision: string
  readonly kind: AccessCommand['kind']
  readonly targetId: string
  readonly operation: AccessCommand['operation']
  readonly sourceId: string
}

const replies = Object.freeze({
  ownerRequired: '只有配置的主人可以管理白名单。',
  groupUsage: '请在要管理的群内发送 /添加群白名单 或 /取消群白名单，不要填写其他群号。',
  privateUsage: '请在命令后提供一个真实@用户或QQ号，例如 /添加私聊白名单（123456）。',
  applied: '白名单已更新。',
  unchanged: '白名单无需更改。',
  invalid: '白名单请求无效，本次未修改。',
  conflict: '白名单状态已变化或正在更新，本次未修改，请稍后再试。',
  denied: '该会话在拒绝名单中，本次未修改。',
  limit: '白名单已达到上限，本次未修改。',
  unknown: '本次白名单操作结果未能确认，请先查看状态，勿重复提交。',
  reloadRequired: '白名单已保存，但运行同步未完成；可再次发送同一条命令同步。',
})

export const ACCESS_COMMAND_REPLIES: readonly string[] = Object.freeze(Object.values(replies))

function account(value: string): boolean {
  return /^[1-9][0-9]{0,19}$/.test(value)
}

export function parseAccessCommand(message: InboundMessage): AccessCommand | null {
  if (message.content.some(part => part.type === 'forward')) return null
  const parts = message.content.filter(part => part.type !== 'reply')
  const first = parts[0]
  if (!first || first.type !== 'text') return null
  const command = /^\s*\/(添加|取消)(群|私聊)白名单/u.exec(first.text)
  if (!command) return null
  const kind = command[2] === '群' ? 'group' : 'private'
  const operation = command[1] === '添加' ? 'add' : 'remove'
  const tail = [{ type: 'text' as const, text: first.text.slice(command[0].length) }, ...parts.slice(1)]
  const result = (targetId: string | null): AccessCommand => Object.freeze({ kind, operation, targetId })
  if (kind === 'group') {
    const group = /^group:([1-9][0-9]{0,19})$/.exec(message.conversationId)
    return result(group && tail.every(part => part.type === 'text' && part.text.trim() === '') ? group[1]! : null)
  }
  const tokens: string[] = []
  for (const part of tail) {
    if (part.type === 'mention') {
      if (!account(part.userId)) return result(null)
      tokens.push(part.userId)
    } else if (part.type === 'text') {
      for (const token of part.text.match(/[0-9]+|[()（）]|[^\s0-9()（）]+/gu) ?? []) tokens.push(token)
    } else {
      return result(null)
    }
  }
  if (tokens.length === 1 && account(tokens[0]!)) return result(tokens[0]!)
  if (tokens.length === 3 && account(tokens[1]!)
    && (tokens[0] === '(' && tokens[2] === ')' || tokens[0] === '（' && tokens[2] === '）')) return result(tokens[1]!)
  return result(null)
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function failureReply(code: string | undefined): string {
  if (code === 'APPLIED_RELOAD_REQUIRED') return replies.reloadRequired
  if (code === 'ACCESS_OWNER_REQUIRED') return replies.ownerRequired
  if (code === 'ACCESS_REVISION_CONFLICT' || code === 'ACCESS_SERVICE_BUSY') return replies.conflict
  if (code === 'ACCESS_DENIED' || code === 'ACCESS_TARGET_DENIED') return replies.denied
  if (code === 'ACCESS_LIMIT_EXCEEDED') return replies.limit
  if (code === 'ACCESS_INVALID_REQUEST' || code === 'ACCESS_INVALID_DOCUMENT') return replies.invalid
  return replies.unknown
}

export function createAccessCommandHandler(options: {
  readonly readAccess: (signal: AbortSignal) => Promise<AccessDocument>
  readonly change: (request: AccessChangeRequest, signal: AbortSignal) => Promise<{
    readonly state: 'applied' | 'unchanged'
    readonly document: AccessDocument
    readonly sourceId: string
  }>
}) {
  return async function handleAccessCommand(message: InboundMessage,
    reply: (text: string) => Promise<DeliveryReceipt>, signal: AbortSignal): Promise<void> {
    const command = parseAccessCommand(message)
    if (!command) return
    signal.throwIfAborted()
    let document: AccessDocument
    try { document = await options.readAccess(signal) }
    catch (error) {
      signal.throwIfAborted()
      await reply(failureReply(errorCode(error)))
      return
    }
    signal.throwIfAborted()
    if (message.isSelf || !document.value.owner || message.userId !== document.value.owner) {
      await reply(replies.ownerRequired)
      return
    }
    if (command.targetId === null) {
      await reply(command.kind === 'group' ? replies.groupUsage : replies.privateUsage)
      return
    }
    const sourceId = createHash('sha256').update(JSON.stringify([message.conversationId, message.id, 'access-command'])).digest('hex')
    let text: string
    try {
      const result = await options.change({ actorId: message.userId, expectedRevision: document.revision,
        kind: command.kind, targetId: command.targetId, operation: command.operation, sourceId }, signal)
      text = result.sourceId !== sourceId ? replies.unknown : result.state === 'applied' ? replies.applied
        : result.state === 'unchanged' ? replies.unchanged : replies.unknown
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'APPLIED_RELOAD_REQUIRED') signal.throwIfAborted()
      text = failureReply(code)
    }
    await reply(text)
  }
}
