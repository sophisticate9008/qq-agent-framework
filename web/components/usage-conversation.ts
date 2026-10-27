import { createElement } from 'react';
import { describeConversationKey } from '../lib/activity.ts';

/** Keep the complete ledger key for selection; shorten only its visible identity. */
export function UsageConversation({ conversationKey, showRun = false }: {
  readonly conversationKey: string | null | undefined;
  readonly showRun?: boolean;
}) {
  if (!conversationKey) return createElement('span', null, '未归属');
  const identity = describeConversationKey(conversationKey);
  const title = identity.simulationRunId ? `模拟运行：${identity.simulationRunId}\n会话键：${identity.key}` : identity.key;
  return createElement('span', { title, 'data-usage-origin': identity.simulationRunId ? 'simulation'
    : identity.kind === 'group' || identity.kind === 'private' ? 'qq' : 'ledger',
    className: 'inline-flex flex-wrap items-center gap-x-1.5' },
  createElement('span', { className: identity.simulationRunId ? 'text-sky-700 dark:text-sky-300' : undefined }, identity.label),
  createElement('span', { className: 'font-medium tabular-nums' }, identity.identifier),
  showRun && identity.simulationRunId ? createElement('span', { className: 'text-xs text-muted-foreground' }, `运行：${identity.simulationRunId}`) : null);
}
