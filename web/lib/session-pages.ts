import { hasSessionResetTarget, type SessionSnapshot } from './session-management.ts';

export const sessionPageLimit = 100;
export const sessionCollectionLimit = 100_000;

export function sessionPagePath(after?: string): string {
  const query = new URLSearchParams({ limit: String(sessionPageLimit) });
  if (after !== undefined) query.set('after', after);
  return `/api/chat/sessions?${query}`;
}

export function mergeSessionPages(previous: SessionSnapshot | null, page: SessionSnapshot): { readonly snapshot: SessionSnapshot; readonly changed: number } {
  const sessions = new Map(previous?.sessions.map(session => [session.key, session]) ?? []);
  let changed = 0;
  for (const session of page.sessions) {
    const prior = sessions.get(session.key);
    if (prior && (prior.sessionId !== session.sessionId || prior.owner !== session.owner
      || prior.generation !== session.generation || prior.bindingRevision !== session.bindingRevision)) changed++;
    sessions.set(session.key, { ...session });
  }
  return { snapshot: { revision: previous?.revision ?? page.revision, sessions: [...sessions.values()], next: page.next ?? null,
    ...(page.source === undefined ? {} : { source: page.source }),
    ...(page.historyReadOnly === undefined ? {} : { historyReadOnly: page.historyReadOnly }),
    ...(page.resetUnavailableReason === undefined ? {} : { resetUnavailableReason: page.resetUnavailableReason }),
    resetAvailable: page.resetAvailable === true && page.sessions.every(hasSessionResetTarget)
      && (previous === null || previous.resetAvailable === true) }, changed };
}
