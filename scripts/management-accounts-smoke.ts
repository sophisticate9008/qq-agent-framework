import assert from 'node:assert/strict';
import { createNativeAccounts } from '../src/host/native-accounts.ts';
import { createNativeAccountRoutes } from '../src/admin/native-accounts.ts';
import { createNativeAccountRuntimeBundle, createNativeAccountDispatchRoutes, type NativeAccountRuntimeBundle } from '../src/admin/native-account-runtime.ts';
export function accountsFixture(directory: string) {
  const bundles = new Map<string, NativeAccountRuntimeBundle>();
  const accounts = createNativeAccounts({ directory, protocols: [{ id: 'onebot', create(options) { const bundle = createNativeAccountRuntimeBundle(options); bundles.set(options.directory, bundle); return bundle; } }], legacy: { isStopped: () => true, async verifyIdentity(accountScope) { return { verified: true, accountScope, evidence: 'browser-explicit-legacy-identity-proof' }; } } });
  const routes = [...createNativeAccountRoutes(accounts), ...createNativeAccountDispatchRoutes({ accounts, async bundle(id) { const directory = await accounts.accountDirectory(id); await accounts.runtime(id); const bundle = bundles.get(directory); assert(bundle); return bundle; } })];
  return { accounts, routes };
}
