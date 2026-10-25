import type { AccountScope } from '../contracts/account-scope.ts'
import type { DurableStore } from '../contracts/ports.ts'
import { assertAccountScope, normalizeAccountScope } from '../core/account-scope.ts'
import { assert, isRecord } from '../core/values.ts'
export const ACCOUNT_STORE_NAMESPACE = 'host.account'
export const ACCOUNT_STORE_KEY = 'identity'
/** Read-only identity validation for stopped history; this never claims an unbound database. */
export function assertAccountStore(store: Pick<DurableStore, 'read'>, input?: AccountScope): { readonly legacyAdopted: boolean } {
  const expected = input === undefined ? undefined : normalizeAccountScope(input)
  const current = store.read(ACCOUNT_STORE_NAMESPACE, ACCOUNT_STORE_KEY)
  if (!current) {
    assert(expected === undefined, 'ACCOUNT_STORE_ADOPTION_REQUIRED', 'Account history requires an existing verified identity.')
    return { legacyAdopted: false }
  }
  assert(isRecord(current.value) && current.value.schema === 1 && typeof current.value.legacyAdopted === 'boolean',
    'ACCOUNT_STORE_INVALID', 'Stored account identity is invalid.')
  assertAccountScope(expected, current.value.accountScope)
  return { legacyAdopted: current.value.legacyAdopted }
}
/** A physical database belongs to one verified identity; legacy data requires explicit adoption. */
export function bindAccountStore(store: DurableStore, input?: AccountScope): { readonly legacyAdopted: boolean } {
  const expected = input === undefined ? undefined : normalizeAccountScope(input)
  const current = store.read(ACCOUNT_STORE_NAMESPACE, ACCOUNT_STORE_KEY)
  if (current) return assertAccountStore(store, expected)
  if (!expected) return { legacyAdopted: false }
  const stats = store.stats?.({ limit: 1 })
  assert(stats && stats.totalRecords === 0, 'ACCOUNT_STORE_ADOPTION_REQUIRED', 'Existing legacy data must be explicitly adopted before account use.')
  store.write(ACCOUNT_STORE_NAMESPACE, ACCOUNT_STORE_KEY, { schema: 1, accountScope: { ...expected }, legacyAdopted: false }, { expectedRevision: null })
  return { legacyAdopted: false }
}
