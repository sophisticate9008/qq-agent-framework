import type { createBridgeHost } from '../host/bridge.ts';
import { reference } from '../core/values.ts';
import { AdminRequestError, type AdminRoute } from './server.ts';

function page(query: URLSearchParams) {
  if ([...query.keys()].some(key => !['limit', 'after'].includes(key))
    || query.getAll('limit').length > 1 || query.getAll('after').length > 1) {
    throw new AdminRequestError(400, 'invalid_query');
  }
  const raw = query.get('limit');
  if (raw !== null && !/^[1-9]\d{0,3}$/.test(raw)) throw new AdminRequestError(400, 'invalid_query');
  const limit = raw === null ? 100 : Number(raw);
  const after = query.get('after');
  if (limit > 1000 || after !== null && !reference(after)) throw new AdminRequestError(400, 'invalid_query');
  return after === null ? { limit } : { limit, after };
}

export function createHostAdminRoutes(host: ReturnType<typeof createBridgeHost>): readonly AdminRoute[] {
  const collections = [
    { name: 'sessions', list: host.sessions.list },
    { name: 'tasks', list: host.tasks.list },
    { name: 'outbox', list: host.outbox.list },
    { name: 'replies', list: host.replies.list },
  ];
  return Object.freeze([
    { method: 'GET', pathname: '/api/host/metrics', handle: () => host.metrics() },
    { method: 'GET', pathname: '/api/host/storage', handle: ({ query }) => host.storageStats(page(query)) },
    ...collections.map(collection => ({
      method: 'GET' as const, pathname: `/api/host/${collection.name}`,
      handle({ query }: { query: URLSearchParams }) {
        const options = page(query);
        const items = collection.list(options);
        const last = items.at(-1);
        const after = last && ('cursor' in last ? last.cursor : last.conversationId);
        return { items, next: items.length === options.limit ? after ?? null : null };
      },
    })),
  ]);
}
