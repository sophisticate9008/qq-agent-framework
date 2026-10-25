import type { NativeDiagnosticCheck, NativeConversationDiagnostics } from '../contracts/native-diagnostics.ts'
import type { EffectiveChatInputConfiguration } from '../contracts/chat-input-configuration.ts'
import { assert, snapshot } from '../core/values.ts'
import { isNativeAccessScope } from '../contracts/native-access.ts'
import { digest, object } from './data.ts'
import type { DurableStore } from './types.ts'

export interface NativeDiagnosticHistory {
  readonly checks: readonly NativeDiagnosticCheck[]
  readonly partial: boolean
}
const check = (code: string, state: NativeDiagnosticCheck['state'], summary: string, nextAction: string | null = null,
  href: string | null = null): NativeDiagnosticCheck => ({ code, state, summary, nextAction, href })

/** Snapshot reads only. Bounded scans explicitly report incomplete coverage; no controller is started. */
export function readNativeDiagnosticHistory(store: Pick<DurableStore, 'read' | 'list'>, conversationId: string): NativeDiagnosticHistory {
  assert(isNativeAccessScope(conversationId), 'INVALID_CONVERSATION', 'A canonical conversation is required.')
  const checks: NativeDiagnosticCheck[] = []
  const session = store.read('host.sessions', conversationId)
  if (session) {
    const value = object(session.value)
    assert(value.schema === 1 && ['ready', 'creating', 'unknown', 'retired'].includes(String(value.state)), 'DIAGNOSTIC_HISTORY_INVALID', 'Invalid session metadata.')
    if (value.state === 'unknown' || value.state === 'creating') checks.push(check('session_unconfirmed', 'blocked', '会话创建结果尚未确认。', '核对会话记录；不要重复创建或清空历史。', '#sessions'))
  }
  const claim = store.read('host.execution-conversations', digest(conversationId))
  if (claim) {
    const id = object(claim.value).executionId
    assert(typeof id === 'string', 'DIAGNOSTIC_HISTORY_INVALID', 'Invalid execution claim.')
    const record = store.read('host.executions', id)
    assert(record !== null, 'DIAGNOSTIC_HISTORY_INVALID', 'Missing execution evidence.')
    const value = object(record.value)
    assert(value.schema === 1 && typeof value.isolated === 'boolean'
      && ['prepared', 'submitting', 'running', 'completed', 'failed', 'rejected', 'timed-out', 'unknown'].includes(String(value.status)),
    'DIAGNOSTIC_HISTORY_INVALID', 'Invalid execution evidence.')
    checks.push(['unknown', 'timed-out'].includes(String(value.status)) || ['unknown', 'requesting'].includes(String(value.cancelStatus))
      ? check('execution_isolated', 'blocked', '本会话有结果未确认的执行，已隔离后续提交。', '到执行记录核对持久证据；取消未知时使用新会话地址恢复。', '#sessions')
      : check('execution_busy', 'waiting', '本会话正在处理请求。', '等待本轮完成；连续补充会进入有界队列。', '#sessions'))
  }
  const reply = store.read('host.replies', digest(conversationId))
  if (reply) {
    const value = object(reply.value)
    assert(['waiting', 'responded', 'responded-late', 'timed-out', 'suppressed'].includes(String(value.status)), 'DIAGNOSTIC_HISTORY_INVALID', 'Invalid reply evidence.')
    if (value.status === 'timed-out') checks.push(check('reply_timed_out', 'blocked', '回复等待已超时，尚未确认完成。', '核对执行记录及发送回执。', '#sessions'))
    else if (value.status === 'waiting') checks.push(check('reply_waiting', 'waiting', '正在等待当前轮回复。'))
  }
  const queued = store.read('native-chat.inbox', digest(conversationId))
  if (queued) {
    const value = object(queued.value)
    assert(value.schema === 1 && Array.isArray(value.entries) && ['pending', 'dispatching', 'blocked'].includes(String(value.phase)), 'DIAGNOSTIC_HISTORY_INVALID', 'Invalid inbox evidence.')
    if (value.entries.length) checks.push(check('input_queue', value.phase === 'blocked' ? 'blocked' : 'waiting',
      `本会话有 ${value.entries.length} 条待处理消息${value.phase === 'blocked' ? '，队列需要核对' : ''}。`, '查看待处理消息和对应执行记录。', '#sessions'))
  }
  let partial = false
  for (const namespace of ['outbox', 'native-work.executions']) {
    const rows = store.list(namespace, { limit: 257 })
    partial ||= rows.length > 256
    let pending = 0
    let uncertain = 0
    for (const record of rows.slice(0, 256)) {
      const value = object(record.value)
      assert(typeof value.conversationId === 'string', 'DIAGNOSTIC_HISTORY_INVALID', 'Unattributable effect evidence.')
      if (value.conversationId !== conversationId) continue
      if (namespace === 'outbox') {
        assert(['prepared', 'sending', 'confirmed', 'rejected', 'unknown'].includes(String(value.status)),
          'DIAGNOSTIC_HISTORY_INVALID', 'Invalid delivery evidence.')
        if (['prepared', 'sending'].includes(String(value.status))) pending++
        if (value.status === 'unknown') uncertain++
      } else {
        assert(['starting', 'running', 'completed', 'failed', 'unknown'].includes(String(value.status))
          && ['not-requested', 'delivering', 'confirmed', 'rejected', 'unknown', 'unavailable'].includes(String(value.delivery)),
        'DIAGNOSTIC_HISTORY_INVALID', 'Invalid work evidence.')
        if (value.status === 'unknown' || value.delivery === 'unknown') uncertain++
        else if (['starting', 'running'].includes(String(value.status)) || value.delivery === 'delivering') pending++
      }
    }
    if (uncertain) checks.push(check(namespace === 'outbox' ? 'delivery_unconfirmed' : 'work_unsettled', 'blocked',
      namespace === 'outbox' ? `${uncertain} 条发送结果未知。` : `${uncertain} 项委托工作或结果交付状态未知。`,
      '核对原记录；未知结果不会自动重试。', namespace === 'outbox' ? '#sessions' : '#model'))
    if (pending) checks.push(check(namespace === 'outbox' ? 'delivery_pending' : 'work_pending', 'waiting',
      namespace === 'outbox' ? `${pending} 条消息正在发送。` : `${pending} 项委托工作正在执行或交付结果。`,
      '等待当前处理结束；可查看原记录的进度。', namespace === 'outbox' ? '#sessions' : '#model'))
  }
  if (partial) checks.push(check('history_scan_limited', 'unknown', '历史记录超过本次诊断扫描范围，不能据此确认没有其他阻碍。', '在执行记录和委托工作中按页核对。', '#sessions'))
  return snapshot({ checks, partial })
}

export function projectNativeDiagnostics(options: {
  readonly conversationId: string; readonly running: boolean; readonly globalReasons: readonly string[]
  readonly accessAllowed: boolean; readonly authorized: boolean | null; readonly input: EffectiveChatInputConfiguration | null
  readonly history: NativeDiagnosticHistory | null; readonly historyState: 'present' | 'absent' | 'unavailable'
  readonly pendingInteractions: number; readonly now?: number
}): NativeConversationDiagnostics {
  assert(isNativeAccessScope(options.conversationId), 'INVALID_CONVERSATION', 'A canonical conversation is required.')
  const checks: NativeDiagnosticCheck[] = []
  if (!options.running) checks.push(check('runtime_stopped', 'blocked', '聊天运行实例尚未启动。', '检查配置后显式启动聊天。', '#adapters'))
  for (const reason of options.globalReasons.slice(0, 32)) checks.push(check(reason, 'blocked', `运行条件未满足：${reason}`, '查看聊天运行状态及下一步操作。', '#adapters'))
  if (!options.accessAllowed) checks.push(check('conversation_not_allowed', 'blocked', '当前访问策略未允许此会话。', '由主人确认后修改会话访问范围。', '#security'))
  if (options.authorized === false) checks.push(check('conversation_budget_unavailable', 'blocked', '此会话的提交或发送授权不可用、已过期或次数已用尽。', '核对当前授权范围、到期时间和剩余次数。', '#security'))
  if (options.authorized === null && options.running) checks.push(check('conversation_budget_unknown', 'unknown', '无法读取此会话的实际授权。'))
  if (!options.input) checks.push(check('input_configuration_unknown', 'unknown', '无法读取消息参与配置。', '检查消息参与配置。', '#features'))
  else if (!options.input.enabled) checks.push(check('input_' + options.input.reason, 'blocked', '消息参与配置排除了此会话。', '修改参与开关或适用范围。', '#features'))
  if (options.pendingInteractions) checks.push(check('qq_interaction_pending', 'waiting', '模型正在等待所属 QQ 会话内的主人答复或工具确认。', '请实际配置主人在原 QQ 会话回复对应提示。'))
  checks.push(...(options.history?.checks ?? []))
  if (options.historyState === 'unavailable') checks.push(check('history_unavailable', 'unknown', '无法核实持久执行和发送记录。', '检查本机存储和诊断日志。'))
  if (checks.length === 0) checks.push(check('ready', 'ready', '已核对的运行、访问、参与和执行条件均满足。'))
  const state = checks.some(item => item.state === 'blocked') ? 'blocked' : checks.some(item => item.state === 'unknown') ? 'unknown'
    : checks.some(item => item.state === 'waiting') ? 'waiting' : 'ready'
  return snapshot({ schema: 1, source: 'native-chat', conversationId: options.conversationId, observedAt: options.now ?? Date.now(), state, checks,
    input: options.input ? { mention: options.input.wakeOnMention, reply: options.input.wakeOnReply, nicknames: options.input.names, continuationMs: options.input.continuationMs } : null,
    coverage: { history: options.historyState === 'present' ? options.history?.partial ? 'partial' : 'complete' : options.historyState,
      scannedPerNamespace: 256, live: options.running }, automaticReplayAvailable: false })
}
