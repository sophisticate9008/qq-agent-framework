import type { NativeExecutionRecord } from '../../src/host/native-execution.ts';

export function executionRecord(index: number, overrides: Partial<NativeExecutionRecord> = {}): NativeExecutionRecord & { readonly revision: number; readonly cursor: string } {
  const id = index.toString(16).padStart(64, '0');
  const admittedAt = 1_790_000_000_000 + index * 1000;
  return {
    schema: 1, id, cursor: id, revision: 1,
    binding: { conversationId: `group:${100_000 + index}`, sessionId: `isolated-session-${index}`, generation: 1 },
    requestId: `isolated-request-${index}`, policyRevision: 'a'.repeat(64),
    policy: { schema: 1, turnTimeoutMs: 60_000, cancelTimeoutMs: 5000, noticeTimeoutMs: 5000, noticeEnabled: true,
      noticeText: '合成提醒正文：不应出现在执行日志', cancelOnTimeout: true, unknownHandling: 'isolate-session', lateFinal: 'record-only', maxActive: 256 },
    admittedAt, deadlineAt: admittedAt + 60_000, status: 'running', externalStatus: 'accepted',
    isolated: true, deadlineReached: false, cancelStatus: 'not-requested', noticeStatus: 'not-requested',
    userMessage: null, turn: null, progressEvents: index % 3, lastEventId: null, lateOutcome: null, lastError: null,
    ...overrides,
  };
}
