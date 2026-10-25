import { parseAccountScope, type AccountScope } from './account-scope.ts'
export const NATIVE_ACCOUNTS_PATH = '/api/accounts'
export interface NativeAccountConfiguration {
  readonly id: string
  readonly label: string
  readonly accountScope: AccountScope
  readonly source: 'isolated-account' | 'legacy-adopted'
  readonly adoption: 'ready' | 'unknown'
}
export interface NativeAccountRegistry { readonly schema: 1; readonly accounts: readonly NativeAccountConfiguration[] }
export interface NativeAccountView extends NativeAccountConfiguration {
  readonly state: 'configured' | 'starting' | 'running' | 'stopping' | 'stopped' | 'unknown'
  readonly missingReasons: readonly string[]
}
export interface NativeAccountsSnapshot {
  readonly schema: 1
  readonly revision: string
  readonly protocols: readonly string[]
  readonly accounts: readonly NativeAccountView[]
  readonly legacy: { readonly source: 'legacy-single'; readonly isolated: true; readonly adoptedBy: string | null }
}
function record(input: unknown): input is Record<string, unknown> { return !!input && typeof input === 'object' && !Array.isArray(input) }
function exact(input: Record<string, unknown>, keys: readonly string[]) { return Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key)) }
function account(input: unknown): NativeAccountConfiguration | null {
  if (!record(input) || !exact(input, ['id', 'label', 'accountScope', 'source', 'adoption']) || typeof input.id !== 'string'
    || !/^[a-f0-9]{64}$/.test(input.id) || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80
    || /[\x00-\x1f\x7f]/.test(input.label) || !['isolated-account', 'legacy-adopted'].includes(String(input.source))
    || !['ready', 'unknown'].includes(String(input.adoption))) return null
  const scope = parseAccountScope(input.accountScope)
  return scope ? Object.freeze({ id: input.id, label: input.label, accountScope: scope,
    source: input.source as NativeAccountConfiguration['source'], adoption: input.adoption as NativeAccountConfiguration['adoption'] }) : null
}
export function parseNativeAccountRegistry(input: unknown): NativeAccountRegistry | null {
  if (!record(input) || !exact(input, ['schema', 'accounts']) || input.schema !== 1 || !Array.isArray(input.accounts) || input.accounts.length > 32) return null
  const accounts = input.accounts.map(account)
  if (accounts.some(item => item === null) || new Set(accounts.map(item => item?.id)).size !== accounts.length
    || accounts.filter(item => item?.source === 'legacy-adopted').length > 1) return null
  return Object.freeze({ schema: 1, accounts: Object.freeze(accounts as NativeAccountConfiguration[]) })
}
export function parseNativeAccountsSnapshot(input: unknown): NativeAccountsSnapshot | null {
  if (!record(input) || !exact(input, ['schema', 'revision', 'protocols', 'accounts', 'legacy']) || input.schema !== 1
    || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision) || !Array.isArray(input.protocols)
    || input.protocols.length > 32 || input.protocols.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id))
    || new Set(input.protocols).size !== input.protocols.length || !Array.isArray(input.accounts) || input.accounts.length > 32
    || !record(input.legacy) || !exact(input.legacy, ['source', 'isolated', 'adoptedBy']) || input.legacy.source !== 'legacy-single' || input.legacy.isolated !== true
    || !(input.legacy.adoptedBy === null || typeof input.legacy.adoptedBy === 'string' && /^[a-f0-9]{64}$/.test(input.legacy.adoptedBy))) return null
  const accounts: NativeAccountView[] = []
  for (const value of input.accounts) {
    if (!record(value) || !exact(value, ['id', 'label', 'accountScope', 'source', 'adoption', 'state', 'missingReasons'])
      || !['configured', 'starting', 'running', 'stopping', 'stopped', 'unknown'].includes(String(value.state))
      || !Array.isArray(value.missingReasons) || value.missingReasons.length > 16
      || value.missingReasons.some(reason => typeof reason !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(reason))) return null
    const parsed = account({ id: value.id, label: value.label, accountScope: value.accountScope, source: value.source, adoption: value.adoption })
    if (!parsed) return null
    accounts.push(Object.freeze({ ...parsed, state: value.state as NativeAccountView['state'], missingReasons: Object.freeze([...value.missingReasons]) as readonly string[] }))
  }
  if (new Set(accounts.map(item => item.id)).size !== accounts.length) return null
  return Object.freeze({ schema: 1, revision: input.revision, protocols: Object.freeze([...input.protocols]) as readonly string[],
    accounts: Object.freeze(accounts), legacy: Object.freeze({ source: 'legacy-single', isolated: true, adoptedBy: input.legacy.adoptedBy }) })
}

export interface NativeLegacyAdoptionPreview {
  readonly schema: 1
  readonly revision: string
  readonly accountScope: AccountScope
  readonly sourceFingerprint: string
  readonly databases: readonly string[]
}
export function parseNativeLegacyAdoptionPreview(input: unknown): NativeLegacyAdoptionPreview | null {
  if (!record(input) || !exact(input, ['schema', 'revision', 'accountScope', 'sourceFingerprint', 'databases']) || input.schema !== 1
    || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision) || typeof input.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceFingerprint)
    || !Array.isArray(input.databases) || input.databases.length > 4 || new Set(input.databases).size !== input.databases.length
    || !input.databases.every(name => typeof name === 'string' && ['native-chat.sqlite', 'native-control.sqlite', 'native-memory.sqlite', 'native-reminders.sqlite'].includes(name))) return null
  const accountScope = parseAccountScope(input.accountScope)
  return accountScope ? { schema: 1, revision: input.revision, accountScope, sourceFingerprint: input.sourceFingerprint, databases: [...input.databases] as string[] } : null
}
