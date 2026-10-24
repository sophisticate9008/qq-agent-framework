import type { SessionSnapshot } from './activity.ts';

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
    if (prior && (prior.sessionId !== session.sessionId || prior.owner !== session.owner)) changed++;
    sessions.set(session.key, { ...session, bindingRevision: page.revision });
  }
  return { snapshot: { revision: previous?.revision ?? page.revision, sessions: [...sessions.values()], next: page.next ?? null,
    resetAvailable: page.resetAvailable === true && (previous === null || previous.resetAvailable === true) }, changed };
}
