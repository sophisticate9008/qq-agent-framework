import { redactNativeText } from './native-redacted-text.ts'
import { snapshot } from '../core/values.ts'
import { isNativeEventInput, type NativeEventCorrelation, type NativeEventInput } from '../contracts/native-events.ts'
import { createNativeEventObserver } from './native-events.ts'
import type { MessageContent } from '../contracts/messages.ts'
import { normalizeSenderDisplayName } from '../contracts/sender-display-name.ts'

export function nativeActivityContent(content: readonly MessageContent[], context: {
  readonly selfId?: string; readonly selfName?: string;
  readonly members?: readonly { readonly actor: string; readonly displayName?: string }[];
} = {}): string {
  const names = new Map<string, string>()
  if (content.some(part => part.type === 'mention')) {
    for (const member of context.members ?? []) {
      const name = normalizeSenderDisplayName(member.displayName)
      if (name) names.set(member.actor, name)
    }
    const selfName = normalizeSenderDisplayName(context.selfName)
    if (context.selfId && selfName) names.set(context.selfId, selfName)
  }
  return content.map(part => {
    switch (part.type) {
      case 'text': return part.text
      case 'image': return '[图片]'
      case 'audio': return '[语音]'
      case 'file': return `[${/\.(?:mp4|m4v|mov|mkv|webm|avi|mpeg|mpg)$/i.test(part.name) ? '视频' : '文件'}：${part.name}]`
      case 'face': return '[QQ表情]'
      case 'reply': return '[引用消息]'
      case 'mention': return `@${names.get(part.userId) ?? part.userId}`
      case 'forward': return `[合并转发：${part.nodes.length}条]`
      case 'forward-reference': return '[合并转发]'
    }
  }).join('\n')
}

export type NativeActivityState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
export interface NativeActivityEntry {
  readonly id: string
  readonly at: number
  readonly level: 'info' | 'warning' | 'error'
  readonly type: 'received' | 'processed' | 'sent' | 'timeout' | 'error' | 'runtime'
  readonly conversationId: string | null
  readonly summary: string
  readonly count?: number
  readonly errorCode?: string | null
  readonly content: string | null
}

const descriptions = {
  received: ['info', 'received', '收到一条消息。'],
  queued: ['info', 'processed', '消息已排队，当前轮完成后合并处理连续补充。'],
  reply_suppressed: ['info', 'processed', '本轮处理结束，未发送聊天回复。'],
  reply_deferred: ['info', 'processed', '会话有新消息，旧回复暂未发送，将结合最新内容判断是否接话。'],
  reply_decision_invalid: ['warning', 'processed', '模型的不参与决定格式无效，未发送内部控制内容。'],
  unsupported: ['warning', 'processed', '未处理此消息：未发现可处理的消息内容。'],
  inactive: ['warning', 'processed', '未处理入站事件：原生聊天尚未运行。'],
  backpressure: ['warning', 'processed', '未接收此消息：当前处理容量已满。'],
  submit_timeout: ['warning', 'timeout', '模型提交阶段未在期限内完成，请查看会话诊断；未自动重复提交。'],
  deadline: ['warning', 'timeout', '本轮处理期限已到，未自动重复提交。'],
  accepted: ['info', 'processed', '模型已接收本轮请求，正在等待回复。'],
  tool_projection_failed: ['error', 'error', '框架工具挂载失败，本轮尚未提交给模型。'],
  rejected: ['warning', 'processed', '消息未获准处理，请核对接入策略及会话状态。'],
  unknown: ['warning', 'processed', '消息处理结果未确认，未自动重复提交。'],
  send_confirmed: ['info', 'sent', '协议已确认发送回复。'],
  send_unknown: ['warning', 'sent', '回复发送结果未确认，未自动重复发送。'],
  send_rejected: ['warning', 'sent', '回复未能发送。'],
  send_failed: ['error', 'error', '回复发送失败，请核对原生聊天状态。'],
  error: ['error', 'error', '原生聊天操作异常，请核对运行状态。'],
  usage_error: ['warning', 'error', '本次用量记录不可用。'],
  follow_lost: ['warning', 'error', '会话跟随已中断，未自动重放消息。'],
  agent_failed: ['error', 'error', 'Agent 报告本轮处理失败。'],
  agent_cancelled: ['info', 'processed', '本轮执行已确认停止。'],
  execution_timeout: ['warning', 'timeout', '本轮执行已超时；未确认的结果仍按原会话策略隔离。'],
  execution_recovered: ['info', 'processed', '已保留上下文迁移到新会话地址；重启聊天后恢复接收，原取消风险仍保留。'],
  execution_reconciled: ['info', 'processed', '已核对持久执行证据并解除隔离，未重放原请求或回复。'],
  starting: ['info', 'runtime', '正在启动原生聊天。'],
  running: ['info', 'runtime', '原生聊天已启动。'],
  stopping: ['info', 'runtime', '正在停止原生聊天。'],
  stopped: ['info', 'runtime', '原生聊天已停止；活动仅保留于当前管理进程。'],
  start_failed: ['error', 'error', '原生聊天启动失败，请核对运行状态。'],
  stop_failed: ['error', 'error', '原生聊天停止结果异常，请核对运行状态。']
} as const satisfies Record<string, readonly [NativeActivityEntry['level'], NativeActivityEntry['type'], string]>


export function createNativeActivity({ now = Date.now }: { readonly now?: () => number } = {}) {
  const items: NativeActivityEntry[] = []
  const requestFailures = new Set<string>()
  const observer = createNativeEventObserver({now})
  let sequence = 0n
  return Object.freeze({
    record(event: keyof typeof descriptions, conversationId: string | null = null, content?: string,
      correlation: NativeEventCorrelation = {}, errorCode?: string): void {
      try {
        if (!Object.hasOwn(descriptions, event)) return
        const at = now()
        if (!Number.isSafeInteger(at) || at < 0) return
        const [level, type, summary] = descriptions[event]
        if (level !== 'info' && correlation.requestId) {
          if (requestFailures.size >= 256) requestFailures.delete(requestFailures.values().next().value!)
          requestFailures.add(correlation.requestId)
        }
        const address = {...correlation,...(typeof conversationId === 'string' && /^(?:group|private):[1-9][0-9]{0,31}$/.test(conversationId) ? {conversationId}:{})}
        const observation = activityObservation(event,address)
        if (observation) observer.record(observation)
        const code = typeof errorCode === 'string' && /^[A-Z][A-Z_]{1,63}$/.test(errorCode) ? errorCode : null
        const previous = items[0]
        if (level !== 'info' && previous?.type === type && previous.summary === summary
          && previous.conversationId === conversationId && previous.errorCode === code && at - previous.at <= 60_000) {
          items[0] = Object.freeze({ ...previous, at, count: (previous.count ?? 1) + 1 })
          return
        }
        sequence++
        items.unshift(Object.freeze({ id: `native-${sequence}`, at, level, type,
          conversationId: typeof conversationId === 'string' && conversationId.length <= 40
            && /^(?:group|private):[1-9][0-9]{0,31}$/.test(conversationId) ? conversationId : null,
          summary, count: 1, errorCode: code,
          content: event === 'received' || event === 'send_confirmed' ? redactNativeText(content) : null }))
        if (items.length > 100) items.pop()
      } catch {}
    },
    observe(input: NativeEventInput) { return observer.record(input) },
    requestFailureReported(requestId: string) { return requestFailures.has(requestId) },
    finishRequest(requestId: string) { requestFailures.delete(requestId) },
    events: observer.read,
    subscribeEvents: observer.subscribe,
    closeEvents: observer.close,
    read(state: NativeActivityState) {
      return snapshot({ source: 'native-chat' as const, retention: 'process' as const,
        capacity: 100 as const, state, items: [...items] as readonly NativeActivityEntry[] })
    }
  })
}

const activityMapping: Record<keyof typeof descriptions, readonly [string,string]> = {
    tool_projection_failed:['execution','failed'],
    reply_deferred:['message','suppressed'],
    submit_timeout:['execution','unknown'],
    received:['message','received'],queued:['message','queued'],reply_suppressed:['message','suppressed'],reply_decision_invalid:['message','rejected'],
    unsupported:['message','rejected'],inactive:['message','rejected'],backpressure:['message','rejected'],deadline:['execution','timed-out'],
    accepted:['message','accepted'],rejected:['message','rejected'],unknown:['message','unknown'],send_confirmed:['message','sent'],
    send_unknown:['message','unknown'],send_rejected:['message','rejected'],send_failed:['message','unknown'],error:['runtime','error'],
    usage_error:['runtime','error'],follow_lost:['connection','unknown'],agent_failed:['execution','failed'],agent_cancelled:['execution','cancelled'],
    execution_timeout:['execution','timed-out'],execution_recovered:['execution','recovered'],execution_reconciled:['execution','reconciled'],
    starting:['runtime','starting'],running:['runtime','running'],stopping:['runtime','stopping'],stopped:['runtime','stopped'],
    start_failed:['runtime','error'],stop_failed:['runtime','error'] }
function activityObservation(event: keyof typeof descriptions, correlation: NativeEventCorrelation): NativeEventInput | null {
  const [kind,status] = activityMapping[event]
  const input = {source:'native',kind,status,correlation}
  return isNativeEventInput(input) ? input : null
}
