export interface NativeInboxSummary {
  readonly schema: 1;
  readonly items: readonly {
    readonly conversationId: string;
    readonly state: 'idle' | 'pending' | 'dispatching' | 'blocked';
    readonly pending: number;
    readonly oldestReceivedAt: number | null;
    readonly deadlineAt: number | null;
    readonly lastError: string | null;
    readonly expired: number;
    readonly automaticReplayAvailable: false;
  }[];
  readonly pending: number;
  readonly blockedConversations: number;
  readonly limitPerConversation: 16;
  readonly limitTotal: 256;
}
export function parseNativeInboxSummary(input: unknown): NativeInboxSummary | null {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const count = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
  if (!record(input) || input.schema !== 1 || input.limitPerConversation !== 16 || input.limitTotal !== 256
    || !Array.isArray(input.items) || input.items.length > 256 || !count(input.pending, 256) || !count(input.blockedConversations, 256)) return null;
  const items: NativeInboxSummary['items'][number][] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    if (!record(item) || typeof item.conversationId !== 'string' || !/^(?:private|group):[1-9]\d{0,31}$/.test(item.conversationId)
      || seen.has(item.conversationId) || !['idle', 'pending', 'dispatching', 'blocked'].includes(String(item.state))
      || !count(item.pending, 16) || !count(item.expired, 64) || item.automaticReplayAvailable !== false
      || ![item.oldestReceivedAt, item.deadlineAt].every(value => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000)
      || item.lastError !== null && (typeof item.lastError !== 'string' || item.lastError.length > 128)
      || item.pending === 0 && (item.state !== 'idle' || item.oldestReceivedAt !== null || item.deadlineAt !== null)
      || item.pending > 0 && (item.state === 'idle' || typeof item.oldestReceivedAt !== 'number' || typeof item.deadlineAt !== 'number'
        || item.deadlineAt <= item.oldestReceivedAt)) return null;
    seen.add(item.conversationId);
    items.push({ conversationId: item.conversationId, state: item.state as NativeInboxSummary['items'][number]['state'],
      pending: item.pending, oldestReceivedAt: item.oldestReceivedAt as number | null, deadlineAt: item.deadlineAt as number | null,
      lastError: item.lastError as string | null, expired: item.expired, automaticReplayAvailable: false });
  }
  if (items.reduce((sum, item) => sum + item.pending, 0) !== input.pending
    || items.filter(item => item.state === 'blocked').length !== input.blockedConversations) return null;
  return { schema: 1, items, pending: input.pending, blockedConversations: input.blockedConversations,
    limitPerConversation: 16, limitTotal: 256 };
}
