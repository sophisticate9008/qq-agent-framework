import type { NativeExecutionSummary } from '../../src/host/native-execution-summary.ts';
import type { NativeExecutionRecord } from '../../src/host/native-execution.ts';
import { asRecord } from './api.ts';

export type ExecutionJournalEntry = Pick<NativeExecutionRecord,
  'schema' | 'id' | 'binding' | 'requestId' | 'policyRevision' | 'admittedAt' | 'deadlineAt'
  | 'status' | 'externalStatus' | 'isolated' | 'deadlineReached' | 'cancelStatus' | 'noticeStatus'
  | 'userMessage' | 'turn' | 'progressEvents' | 'lastEventId' | 'lateOutcome' | 'lastError'> & {
    readonly revision: number;
    readonly cursor: string;
    readonly summary?: NativeExecutionSummary | null;
  };

const statuses = ['prepared', 'submitting', 'running', 'completed', 'failed', 'rejected', 'timed-out', 'unknown'] as const;
const externalStatuses = ['not-started', 'submitting', 'accepted', 'completed', 'failed', 'rejected', 'cancelled', 'unknown'] as const;
const cancelStatuses = ['not-requested', 'unavailable', 'requesting', 'accepted', 'rejected', 'unknown', 'confirmed'] as const;
const noticeStatuses = ['not-requested', 'unavailable', 'sending', 'confirmed', 'rejected', 'unknown'] as const;
const outcomes = ['completed', 'failed', 'cancelled'] as const;
const cursorPattern = /^[a-f0-9]{64}$/;
const pageCursorPattern = /^(?:\d{1,16}:)?[a-f0-9]{64}$/;

export interface ExecutionJournalPage {
  readonly native: true;
  readonly items: readonly ExecutionJournalEntry[];
  readonly next: string | null;
  readonly manualCancelAvailable: false;
  readonly partial: boolean;
}

export const executionJournalPageLimit = 100;
export const executionJournalCollectionLimit = 100_000;

export function executionJournalPath(after?: string): string {
  if (after !== undefined && !pageCursorPattern.test(after)) throw new Error('invalid_execution_cursor');
  const query = new URLSearchParams({ limit: String(executionJournalPageLimit), order: 'recent' });
  if (after !== undefined) query.set('after', after);
  return `/api/chat/executions?${query}`;
}

function member<Value extends string>(values: readonly Value[], input: unknown): input is Value {
  return typeof input === 'string' && values.some(value => value === input);
}

function reference(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= 160 && !/[\x00-\x1f\x7f]/.test(input);
}

function integer(input: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= minimum && input <= maximum;
}

function parseSummary(input: unknown): NativeExecutionSummary | null {
  const summary = asRecord(input);
  const source = asRecord(summary.input);
  const reply = asRecord(summary.reply);
  const delivery = asRecord(summary.delivery);
  const tools = summary.tools === null ? null : asRecord(summary.tools);
  const text = (value: unknown, limit: number) => value === null || typeof value === 'string' && value.length <= limit;
  const count = (value: unknown) => value === null || integer(value);
  if (summary.schema !== 1 || typeof summary.partial !== 'boolean'
    || !text(source.messageId, 160) || !text(source.senderId, 160) || !text(source.displayName, 160) || !text(source.text, 400)
    || !text(reply.text, 400) || !text(reply.reason, 160)
    || reply.outcome != null && !member(['sent', 'rejected', 'unknown'] as const, reply.outcome)
    || !['confirmed', 'rejected', 'unknown', 'pending'].every(key => count(delivery[key]))
    || !count(summary.mergedMessages) || !count(summary.durationMs)
    || tools !== null && (!integer(tools.count) || !Array.isArray(tools.names) || tools.names.length > 64
      || !tools.names.every(name => typeof name === 'string' && name.length <= 160))) return null;
  return {
    schema: 1, partial: summary.partial,
    input: { messageId: source.messageId as string | null, senderId: source.senderId as string | null,
      displayName: source.displayName as string | null, text: source.text as string | null },
    reply: { text: reply.text as string | null, reason: reply.reason as string | null, outcome: reply.outcome == null ? null : reply.outcome as 'sent' | 'rejected' | 'unknown' },
    delivery: { confirmed: delivery.confirmed as number | null, rejected: delivery.rejected as number | null,
      unknown: delivery.unknown as number | null, pending: delivery.pending as number | null },
    mergedMessages: summary.mergedMessages as number | null, durationMs: summary.durationMs as number | null,
    tools: tools === null ? null : { count: tools.count as number, names: tools.names as string[] },
  };
}

export function parseExecutionJournalEntry(input: unknown): ExecutionJournalEntry | null {
  const record = asRecord(input);
  const binding = asRecord(record.binding);
  const message = asRecord(record.userMessage);
  const turn = asRecord(record.turn);
  const late = asRecord(record.lateOutcome);
  if (record.schema !== 1 || typeof record.id !== 'string' || !cursorPattern.test(record.id)
    || record.cursor !== record.id && record.cursor !== `${record.admittedAt}:${record.id}`
    || !integer(record.revision, 1) || !reference(record.requestId)
    || typeof record.policyRevision !== 'string' || !/^[a-f0-9]{64}$/.test(record.policyRevision)
    || !reference(binding.conversationId) || !reference(binding.sessionId) || !integer(binding.generation, 1)
    || !integer(record.admittedAt, 0, 8_640_000_000_000_000) || !integer(record.deadlineAt, record.admittedAt, 8_640_000_000_000_000)
    || !member(statuses, record.status) || !member(externalStatuses, record.externalStatus)
    || !member(cancelStatuses, record.cancelStatus) || !member(noticeStatuses, record.noticeStatus)
    || typeof record.isolated !== 'boolean' || typeof record.deadlineReached !== 'boolean'
    || !integer(record.progressEvents)
    || record.lastEventId !== null && !reference(record.lastEventId)
    || record.lastError !== null && !reference(record.lastError)
    || record.userMessage !== null && (!reference(message.eventId) || !reference(message.messageId))
    || record.turn !== null && (!reference(turn.id) || !reference(turn.evidenceId))
    || record.lateOutcome !== null && (!reference(late.eventId) || !member(outcomes, late.outcome))) return null;
  return {
    schema: 1, id: record.id, cursor: record.cursor as string, revision: record.revision,
    ...(record.summary === undefined ? {} : { summary: parseSummary(record.summary) }),
    binding: { conversationId: binding.conversationId, sessionId: binding.sessionId, generation: binding.generation },
    requestId: record.requestId, policyRevision: record.policyRevision,
    admittedAt: record.admittedAt, deadlineAt: record.deadlineAt,
    status: record.status, externalStatus: record.externalStatus, isolated: record.isolated,
    deadlineReached: record.deadlineReached, cancelStatus: record.cancelStatus, noticeStatus: record.noticeStatus,
    progressEvents: record.progressEvents, lastEventId: record.lastEventId as string | null,
    lastError: record.lastError as string | null,
    userMessage: record.userMessage === null ? null : { eventId: message.eventId as string, messageId: message.messageId as string },
    turn: record.turn === null ? null : { id: turn.id as string, evidenceId: turn.evidenceId as string },
    lateOutcome: record.lateOutcome === null ? null : { eventId: late.eventId as string, outcome: late.outcome as NonNullable<ExecutionJournalEntry['lateOutcome']>['outcome'] },
  };
}

export function parseExecutionJournalPage(input: unknown): ExecutionJournalPage | null {
  const page = asRecord(input);
  if (page.native !== true || page.manualCancelAvailable !== false || !Array.isArray(page.items) || page.items.length > 1000
    || page.next !== null && (typeof page.next !== 'string' || !pageCursorPattern.test(page.next))
    || page.partial !== undefined && typeof page.partial !== 'boolean') return null;
  const items: ExecutionJournalEntry[] = [];
  const seen = new Set<string>();
  for (const item of page.items) {
    const parsed = parseExecutionJournalEntry(item);
    if (!parsed || seen.has(parsed.id)) return null;
    seen.add(parsed.id);
    items.push(parsed);
  }
  return { native: true, items, next: page.next as string | null, manualCancelAvailable: false, partial: page.partial === true };
}

export function mergeExecutionJournalPages(previous: ExecutionJournalPage | null, page: ExecutionJournalPage): {
  readonly page: ExecutionJournalPage;
  readonly changed: number;
} {
  const items = new Map(previous?.items.map(item => [item.id, item]) ?? []);
  let changed = 0;
  for (const item of page.items) {
    const prior = items.get(item.id);
    if (prior && prior.revision > item.revision) continue;
    if (prior && prior.revision === item.revision) {
      // Delivery can settle after the model execution revision stops changing.
      if (item.summary) items.set(item.id, { ...prior, summary: item.summary });
      continue;
    }
    if (prior && prior.revision !== item.revision) changed++;
    items.set(item.id, item);
  }
  return { page: { ...page, items: [...items.values()], partial: page.partial || previous?.partial === true }, changed };
}

export interface ExecutionPresentation {
  readonly label: string;
  readonly tone: 'neutral' | 'warning' | 'success';
  readonly explanation: string;
}

export function executionPresentation(record: ExecutionJournalEntry): ExecutionPresentation {
  if (record.deadlineReached || record.status === 'timed-out') return { label: '已超时', tone: 'warning', explanation: '本轮处理超时，迟到结果只留档。外部任务是否停止见下方状态。' };
  if (record.status === 'unknown' || record.externalStatus === 'unknown') return { label: '结果未知', tone: 'warning', explanation: '尚未收到明确结果，本轮请求不会自动重发。' };
  if (record.status === 'completed' && record.externalStatus === 'completed' && !record.isolated && record.lateOutcome === null
    && record.userMessage !== null && record.turn !== null && record.lastEventId !== null
    && !['requesting', 'accepted', 'unknown'].includes(record.cancelStatus)) return { label: '处理完成', tone: 'success', explanation: '本轮模型处理已完成。消息送达情况请查看会话记录。' };
  if (record.externalStatus === 'cancelled') return { label: '已确认停止', tone: 'neutral', explanation: '已收到本次外部执行的停止确认，已发生的外部副作用不会撤回。' };
  if (record.status === 'failed' && record.externalStatus === 'failed') return { label: '执行失败', tone: 'warning', explanation: '已观察到处理失败；不会从此日志自动重放。' };
  if (record.status === 'rejected' && ['not-started', 'rejected'].includes(record.externalStatus)) return { label: '未受理', tone: 'neutral', explanation: '本次执行未被受理；不会通过日志按钮重新提交。' };
  if (record.status === 'prepared' && record.externalStatus === 'not-started') return { label: '准备中', tone: 'neutral', explanation: '已登记本次任务，尚未确认外部受理。' };
  if (record.status === 'submitting' && ['submitting', 'accepted'].includes(record.externalStatus)) return { label: '正在提交', tone: 'neutral', explanation: '正在等待本次任务的受理或完整结果。' };
  if (record.status === 'running' && record.externalStatus === 'accepted') return { label: '处理中', tone: 'neutral', explanation: '外部任务已受理，进度事件不会延长总期限。' };
  return { label: '结果待核对', tone: 'warning', explanation: '当前状态尚不足以确认成功；请重新读取记录，不会自动重新执行。' };
}

export function executionCancelLabel(status: ExecutionJournalEntry['cancelStatus']): string {
  return {
    'not-requested': '未发起停止任务', unavailable: '停止任务不可用', requesting: '正在请求停止任务',
    accepted: '停止任务仅已受理，尚未确认停止', rejected: '停止任务请求被拒绝', unknown: '停止任务结果未知', confirmed: '已收到停止确认',
  }[status];
}

export function executionNoticeLabel(status: ExecutionJournalEntry['noticeStatus']): string {
  return {
    'not-requested': '未发起超时提醒', unavailable: '超时提醒不可用', sending: '正在发送超时提醒',
    confirmed: '超时提醒已确认发送', rejected: '超时提醒被拒绝', unknown: '超时提醒结果未知，不自动重发',
  }[status];
}

export function executionLateLabel(record: ExecutionJournalEntry): string | null {
  if (!record.lateOutcome) return null;
  const outcome = { completed: '完成', failed: '失败', cancelled: '停止' }[record.lateOutcome.outcome];
  return `迟到${outcome}仅留档，不补发回复，不归属下一次请求。`;
}

export function executionConversationLabel(conversationId: string): string {
  const match = /^(group|private):([1-9]\d{0,15})$/.exec(conversationId);
  return match ? `${match[1] === 'group' ? '群聊' : '私聊'} ${match[2]}` : '其他会话（标识见技术详情）';
}

export function executionContinuationLabel(record: ExecutionJournalEntry): string {
  if (!record.isolated) return '本轮未暂停后续处理';
  return ['prepared', 'submitting', 'running'].includes(record.status) && !record.deadlineReached && record.externalStatus !== 'unknown'
    ? '等待本次任务结束' : '暂停后续任务';
}

/** Model completion and confirmed QQ sends have separate evidence. */
export function executionJournalPresentation(record: ExecutionJournalEntry): ExecutionPresentation {
  const base = executionPresentation(record);
  const summary = record.summary;
  if (base.tone !== 'success' || !summary) return base;
  const { confirmed, rejected, unknown, pending } = summary.delivery;
  if (summary.reply.outcome === 'unknown') return { label: '发送待确认', tone: 'warning', explanation: '本轮有发送尝试结果未确认；已确认的部分单独计数。' };
  if (unknown) return { label: '发送待确认', tone: 'warning', explanation: `有 ${unknown} 条发送结果尚未确认。` };
  if (rejected) return { label: confirmed ? '部分发送' : '发送失败', tone: 'warning', explanation: `已确认发送 ${confirmed ?? 0} 条，未能发送 ${rejected} 条。` };
  if (pending) return { label: '正在发送', tone: 'neutral', explanation: `有 ${pending} 条回复正在等待发送结果。` };
  if (summary.reply.outcome === 'rejected' && summary.reply.reason !== 'AGENT_MESSAGE_SUPPRESSED') return { label: confirmed ? '部分发送' : '未能发送', tone: 'warning', explanation: '本轮有回复未能发送；已确认的部分单独计数。' };
  if (confirmed) return { label: `已发送 ${confirmed} 条`, tone: 'success', explanation: '协议端已确认这些发送请求。' };
  if (summary.reply.reason === 'superseded' || summary.reply.reason === 'AGENT_MESSAGE_SUPPRESSED') return { label: '让出回复', tone: 'neutral', explanation: executionReplyReason(summary.reply.reason) };
  if (summary.reply.reason && /^[A-Z][A-Z0-9_]+$/.test(summary.reply.reason)) return { label: '未能发送', tone: 'warning', explanation: executionReplyReason(summary.reply.reason) };
  if (summary.reply.reason) return { label: summary.reply.reason === 'no-explicit-send' ? '未发送' : '未发言', tone: 'neutral', explanation: executionReplyReason(summary.reply.reason) };
  return base;
}

export function executionReplyReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'DELIVERY_UNKNOWN': return '发送结果尚未确认，未自动重复发送。';
    case 'DELIVERY_REJECTED': return '协议端未接受本次发送。';
    case 'AGENT_MESSAGE_PREPARATION_FAILED': return '回复内容准备失败，尚未发送。';
    case 'no-explicit-send': return '本轮未调用发送工具。';
    case 'AGENT_MESSAGE_SUPPRESSED':
    case 'superseded': return '收到新消息，旧回复已让出，交由后续轮次结合新内容处理。';
    case 'not-addressed': return '本轮未被询问，没有插话。';
    case 'already-answered': return '问题已有答复，本轮未重复回复。';
    case 'user-requested': return '按用户要求，本轮不回复。';
    case 'invalid_reply_decision': return '未参与决定格式无效，未发送内部控制内容。';
    case 'no-useful-addition': return '本轮没有需要补充的内容。';
    case 'conversation-ended': return '话题已结束，没有继续回复。';
    case 'silent': return '本轮选择不发言。';
    default: return reason ? /^[A-Z][A-Z0-9_]+$/.test(reason) ? '回复未能发送，具体原因标记见技术详情。' : '本轮已记录不发言决定，具体标记见技术详情。' : '未记录本轮发送结果。';
  }
}

export function executionInputLabel(record: ExecutionJournalEntry): string {
  const source = record.summary?.input;
  if (!source?.text) return '输入摘要未留存';
  const sender = source.displayName || source.senderId;
  return `${sender ? `${sender}：` : ''}${source.text}`;
}

export function executionResultLabel(record: ExecutionJournalEntry): string {
  if (record.summary?.reply.text) return record.summary.reply.text;
  if (record.summary?.reply.reason) return executionReplyReason(record.summary.reply.reason);
  const delivery = record.summary?.delivery;
  if (delivery?.rejected) return '回复未能发送，查看详情核对。';
  if (delivery?.unknown) return '发送结果尚未确认。';
  const failure = executionErrorLabel(record);
  if (failure) return failure;
  if (record.status === 'running' || record.status === 'submitting' || record.status === 'prepared') return '等待本轮结果…';
  if (record.summary?.tools?.count) return `已完成 ${record.summary.tools.count} 次工具调用 · 未记录发送结果`;
  if (executionPresentation(record).tone === 'warning') return executionPresentation(record).explanation;
  return '本轮发送明细未留存';
}

export function executionErrorLabel(record: ExecutionJournalEntry): string | null {
  switch (record.lastError) {
    case 'EXECUTION_DEADLINE_BEFORE_SUBMIT': return '等待超时，本轮尚未提交给模型。';
    case 'EXECUTION_DEADLINE_REACHED': return '本轮超过处理时限。';
    case 'EXECUTION_ADMISSION_CONFLICT': return '同一会话已有执行任务，本次未被受理。';
    case 'EXECUTION_INTERRUPTED': return '服务运行中断，本轮结果尚未确认。';
    case 'EXECUTION_STREAM_LOST': return '模型事件连接中断，未收到最终结果。';
    case 'EXECUTION_STOPPED_BEFORE_SUBMIT': return '聊天停止时，本轮尚未提交给模型。';
    case 'EXECUTION_STOPPED_UNKNOWN': return '聊天已停止，本轮外部执行结果尚未确认。';
    default: return record.lastError ? '本轮有异常记录，原因码可在技术详情查看。' : record.status === 'failed' ? '执行失败，未记录具体原因。' : null;
  }
}
