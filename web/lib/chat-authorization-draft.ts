import { newChatConfigurationId, parseChatAuthorization, type ChatGrant } from './chat-runtime.ts';

export interface GrantDraft {
  readonly key: string;
  readonly kind: 'group' | 'private';
  readonly account: string;
  readonly submitUses: string;
  readonly sendUses: string;
  readonly forwardUses?: string;
  readonly expires: string;
  readonly cancelUses?: string;
  readonly toolDelegationUses?: string;
}

export function authorizationDrafts(grants: readonly ChatGrant[]): GrantDraft[] {
  return grants.map(grant => {
    const [kind, account] = grant.conversationId.split(':');
    const date = grant.expiresAt === null ? null : new Date(grant.expiresAt);
    const local = date === null ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    return { key: newChatConfigurationId(), kind: kind === 'group' ? 'group' : 'private', account,
      submitUses: String(grant.submitUses), sendUses: String(grant.sendUses), expires: local,
      ...(grant.forwardUses === undefined ? {} : { forwardUses: String(grant.forwardUses) }),
      ...(grant.cancelUses === undefined ? {} : { cancelUses: String(grant.cancelUses) }),
      ...(grant.toolDelegationUses === undefined ? {} : { toolDelegationUses: String(grant.toolDelegationUses) }) };
  });
}

export function authorizationValues(entries: readonly GrantDraft[]): ChatGrant[] | null {
  const grants = entries.map(entry => ({ conversationId: `${entry.kind}:${entry.account.trim()}`,
    submitUses: /^\d+$/.test(entry.submitUses) ? Number(entry.submitUses) : -1,
    sendUses: /^\d+$/.test(entry.sendUses) ? Number(entry.sendUses) : -1,
    expiresAt: entry.expires === '' ? null : new Date(entry.expires).getTime(),
    ...(entry.forwardUses === undefined ? {} : { forwardUses: /^\d+$/.test(entry.forwardUses) ? Number(entry.forwardUses) : -1 }),
    ...(entry.cancelUses !== undefined ? {
      cancelUses: /^\d+$/.test(entry.cancelUses) ? Number(entry.cancelUses) : -1,
    } : {}),
    ...(entry.toolDelegationUses === undefined ? {} : {
      toolDelegationUses: /^\d+$/.test(entry.toolDelegationUses) ? Number(entry.toolDelegationUses) : -1,
    }) }));
  return parseChatAuthorization({ revision: '0'.repeat(64), version: 'draft', grants })?.grants.slice() ?? null;
}
