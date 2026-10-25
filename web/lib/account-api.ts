import type { ApiClient } from './api.ts';
export function accountDispatchPath(path: string, accountId: string): string {
  if (!/^[a-f0-9]{64}$/.test(accountId)) throw new Error('invalid_account_identity');
  if (!path.startsWith('/api/chat/')) return path;
  const url = new URL(path, 'http://account.invalid');
  if (url.hash || url.searchParams.has('account') || url.searchParams.has('path')) throw new Error('invalid_account_route');
  const query = new URLSearchParams({ account: accountId, path: url.pathname });
  for (const [key, value] of url.searchParams) query.append(key, value);
  return `/api/accounts/dispatch?${query}`;
}
/** Each account owns its reads, drafts and unresolved operation evidence for this login. */
export function createAccountApiRegistry(globalApi: ApiClient) {
  const clients = new Map<string, ApiClient>();
  return Object.freeze({
    client(id: string | null): ApiClient {
      if (id === null) return globalApi;
      let client = clients.get(id);
      if (!client) { accountDispatchPath('/api/chat/runtime', id); client = { get: (path, signal) => globalApi.get(accountDispatchPath(path, id), signal), post: (path, body, signal) => globalApi.post(accountDispatchPath(path, id), body, signal) }; clients.set(id, client); }
      return client;
    },
    clients(): readonly ApiClient[] { return [globalApi, ...clients.values()]; }
  });
}
