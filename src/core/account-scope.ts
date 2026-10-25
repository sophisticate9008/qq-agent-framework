import { parseAccountScope, type AccountScope } from '../contracts/account-scope.ts'
import { assert } from './values.ts'
export function normalizeAccountScope(input: unknown): AccountScope {
  const scope = parseAccountScope(input)
  assert(scope, 'ACCOUNT_SCOPE_INVALID', 'A verified protocol and account identity is required.')
  return scope
}
export function assertAccountScope(expected: AccountScope | undefined, actual: unknown): void {
  if (expected === undefined && actual === undefined) return
  const scope = parseAccountScope(actual)
  assert(scope, 'ACCOUNT_SCOPE_REQUIRED', 'This runtime requires an explicit account identity.')
  assert(expected && scope.protocolId === expected.protocolId && scope.accountId === expected.accountId,
    'ACCOUNT_SCOPE_MISMATCH', 'The operation belongs to another account runtime.')
}
