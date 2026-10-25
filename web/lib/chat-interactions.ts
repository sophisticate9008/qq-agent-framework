import { asRecord } from './api.ts';

export type ChatInteractionStatus = 'pending' | 'submitting' | 'answered' | 'approved' | 'denied' | 'rejected' | 'unknown' | 'expired' | 'disconnected';

export interface ChatInteractionQuestion {
  readonly id: string;
  readonly text: string;
  readonly options: readonly string[];
}

export interface ChatInteraction {
  readonly id: string;
  readonly revision: number;
  readonly kind: 'question' | 'approval';
  readonly status: ChatInteractionStatus;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly generation: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly summary: string;
  readonly questions: readonly ChatInteractionQuestion[];
  readonly toolName: string | null;
}

export interface ChatInteractionSnapshot {
  readonly source: 'native-chat';
  readonly retention: 'process';
  readonly capacity: 100;
  readonly state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  readonly available: boolean;
  readonly unavailableReason: 'runtime-not-running' | 'interaction-port-unavailable' | null;
  readonly items: readonly ChatInteraction[];
}

const statuses: readonly string[] = ['pending', 'submitting', 'answered', 'approved', 'denied', 'rejected', 'unknown', 'expired', 'disconnected'];
const states: readonly string[] = ['stopped', 'starting', 'running', 'stopping', 'error'];

function text(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim().length > 0);
}

function parseChatInteraction(value: unknown): ChatInteraction | null {
  const entry = asRecord(value);
  if (typeof entry.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.id)
    || typeof entry.revision !== 'number' || !Number.isSafeInteger(entry.revision) || entry.revision < 1
    || entry.kind !== 'question' && entry.kind !== 'approval'
    || typeof entry.status !== 'string' || !statuses.includes(entry.status)
    || !text(entry.sessionId, 256) || !text(entry.conversationId, 256) || !/^(group|private):[1-9]\d*$/.test(entry.conversationId)
    || typeof entry.generation !== 'number' || !Number.isSafeInteger(entry.generation) || entry.generation < 1
    || typeof entry.createdAt !== 'number' || !Number.isSafeInteger(entry.createdAt) || entry.createdAt <= 0 || entry.createdAt > 8_640_000_000_000_000
    || typeof entry.expiresAt !== 'number' || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < entry.createdAt || entry.expiresAt > 8_640_000_000_000_000
    || !text(entry.summary, 240, true) || !Array.isArray(entry.questions) || entry.questions.length > 8
    || entry.toolName !== null && !text(entry.toolName, 1024)) return null;
  const questions: ChatInteractionQuestion[] = [];
  const ids = new Set<string>();
  for (const value of entry.questions) {
    const question = asRecord(value);
    if (!text(question.id, 1024) || ids.has(question.id) || !text(question.text, 2000, true)
      || !Array.isArray(question.options) || question.options.length > 16
      || !question.options.every(option => text(option, 200, true))) return null;
    ids.add(question.id);
    questions.push({ id: question.id, text: question.text, options: question.options as string[] });
  }
  return { id: entry.id, revision: entry.revision, kind: entry.kind, status: entry.status as ChatInteractionStatus,
    sessionId: entry.sessionId, conversationId: entry.conversationId, generation: entry.generation,
    createdAt: entry.createdAt, expiresAt: entry.expiresAt, summary: entry.summary,
    questions, toolName: entry.toolName as string | null };
}

export function parseChatInteractions(value: unknown): ChatInteractionSnapshot | null {
  const root = asRecord(value);
  if (root.source !== 'native-chat' || root.retention !== 'process' || root.capacity !== 100
    || typeof root.state !== 'string' || !states.includes(root.state) || typeof root.available !== 'boolean'
    || root.unavailableReason !== null && root.unavailableReason !== 'runtime-not-running' && root.unavailableReason !== 'interaction-port-unavailable'
    || root.available && root.unavailableReason !== null
    || !Array.isArray(root.items) || root.items.length > 100) return null;
  const items: ChatInteraction[] = [];
  const ids = new Set<string>();
  for (const value of root.items) {
    const entry = parseChatInteraction(value);
    if (!entry || ids.has(entry.id)) return null;
    ids.add(entry.id); items.push(entry);
  }
  return { source: 'native-chat', retention: 'process', capacity: 100, state: root.state as ChatInteractionSnapshot['state'],
    available: root.available, unavailableReason: root.unavailableReason as ChatInteractionSnapshot['unavailableReason'], items };
}

export function chatInteractionStatusLabel(status: ChatInteractionStatus): string {
  return { pending: '等待回复或确认', submitting: '正在提交', answered: '回复已提交', approved: '本次工具请求已批准',
    denied: '本次工具请求已拒绝', rejected: '请求未被接受', unknown: '结果未确认',
    expired: '已过期', disconnected: '会话已断开' }[status];
}

export function chatInteractionConversationLabel(conversationId: string): string {
  const match = /^(group|private):([1-9]\d*)$/.exec(conversationId);
  return match ? `${match[1] === 'group' ? '群聊' : '私聊'} ${match[2]}` : '未确认归属的会话';
}
