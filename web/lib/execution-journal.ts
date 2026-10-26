import type { NativeExecutionRecord } from '../../src/host/native-execution.ts';
import { asRecord } from './api.ts';

export type ExecutionJournalEntry = Pick<NativeExecutionRecord,
  'schema' | 'id' | 'binding' | 'requestId' | 'policyRevision' | 'admittedAt' | 'deadlineAt'
  | 'status' | 'externalStatus' | 'isolated' | 'deadlineReached' | 'cancelStatus' | 'noticeStatus'
  | 'userMessage' | 'turn' | 'progressEvents' | 'lastEventId' | 'lateOutcome' | 'lastError'> & {
    readonly revision: number;
    readonly cursor: string;
  };

const statuses = ['prepared', 'submitting', 'running', 'completed', 'failed', 'rejected', 'timed-out', 'unknown'] as const;
const externalStatuses = ['not-started', 'submitting', 'accepted', 'completed', 'failed', 'rejected', 'cancelled', 'unknown'] as const;
const cancelStatuses = ['not-requested', 'unavailable', 'requesting', 'accepted', 'rejected', 'unknown', 'confirmed'] as const;
const noticeStatuses = ['not-requested', 'unavailable', 'sending', 'confirmed', 'rejected', 'unknown'] as const;
const outcomes = ['completed', 'failed', 'cancelled'] as const;
const cursorPattern = /^[a-f0-9]{64}$/;

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
  if (after !== undefined && !cursorPattern.test(after)) throw new Error('invalid_execution_cursor');
  const query = new URLSearchParams({ limit: String(executionJournalPageLimit) });
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

export function parseExecutionJournalEntry(input: unknown): ExecutionJournalEntry | null {
  const record = asRecord(input);
  const binding = asRecord(record.binding);
  const message = asRecord(record.userMessage);
  const turn = asRecord(record.turn);
  const late = asRecord(record.lateOutcome);
  if (record.schema !== 1 || typeof record.id !== 'string' || !cursorPattern.test(record.id) || record.cursor !== record.id
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
    schema: 1, id: record.id, cursor: record.id, revision: record.revision,
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
    || page.next !== null && (typeof page.next !== 'string' || !cursorPattern.test(page.next))
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
    if (prior && prior.revision >= item.revision) continue;
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
  if (record.deadlineReached || record.status === 'timed-out') return { label: '已超时', tone: 'warning', explanation: '已超过本次处理期限。超时不代表外部工作已停止；迟到结果只留档，不补发为下一条回复。' };
  if (record.status === 'unknown' || record.externalStatus === 'unknown') return { label: '结果未知', tone: 'warning', explanation: '尚无法确认外部执行结果，不会自动重放、重置会话或补发请求。' };
  if (record.status === 'completed' && record.externalStatus === 'completed' && !record.isolated && record.lateOutcome === null
    && record.userMessage !== null && record.turn !== null && record.lastEventId !== null
    && !['requesting', 'accepted', 'unknown'].includes(record.cancelStatus)) return { label: '已完成', tone: 'success', explanation: '已观察到本次执行的处理完成；不代表所有出站消息都已送达。' };
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
  if (!record.isolated) return '未因本次记录暂停';
  return ['prepared', 'submitting', 'running'].includes(record.status) && !record.deadlineReached && record.externalStatus !== 'unknown'
    ? '等待本次任务结束' : '暂停后续任务';
}
