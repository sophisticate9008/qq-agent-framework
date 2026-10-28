import { createElement } from 'react';
import { describeConversationKey } from '../lib/activity.ts';

export function usageSessionSuffix(sessionId: string | null | undefined): string {
  return sessionId ? `-${sessionId.replace(/^session-/, '').slice(0, 4)}` : '';
}

/** Preserve the conversation identity and append the model-session suffix only for display. */
export function UsageConversation({ conversationKey, sessionId, showRun = false }: {
  readonly conversationKey: string | null | undefined;
  readonly sessionId?: string | null;
  readonly showRun?: boolean;
}) {
  if (!conversationKey) return createElement('span', null, '未归属');
  const identity = describeConversationKey(conversationKey);
  const title = (identity.simulationRunId ? `模拟运行：${identity.simulationRunId}\n会话键：${identity.key}` : identity.key)
    + (sessionId ? `\n模型会话：${sessionId}` : '');
  return createElement('span', { title, 'data-usage-origin': identity.simulationRunId ? 'simulation'
    : identity.kind === 'plugin' ? 'plugin' : identity.kind === 'group' || identity.kind === 'private' ? 'qq' : 'ledger',
    className: 'inline-flex flex-wrap items-center gap-x-1.5' },
  createElement('span', { className: identity.simulationRunId ? 'text-sky-700 dark:text-sky-300' : undefined }, identity.label),
  createElement('span', { className: 'font-medium tabular-nums' }, `${identity.identifier}${usageSessionSuffix(sessionId)}`),
  showRun && identity.simulationRunId ? createElement('span', { className: 'text-xs text-muted-foreground' }, `运行：${identity.simulationRunId}`) : null);
}
