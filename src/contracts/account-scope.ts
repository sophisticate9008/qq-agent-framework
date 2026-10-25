/** Verified transport identity; account selection never supplies authorization. */
export interface AccountScope {
  readonly protocolId: string
  readonly accountId: string
}
export function parseAccountScope(input: unknown): AccountScope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== 2 || typeof value.protocolId !== 'string'
    || !/^[a-z][a-z0-9-]{0,63}$/.test(value.protocolId) || typeof value.accountId !== 'string'
    || value.accountId.length < 1 || value.accountId.length > 128 || /[\s\x00-\x1f\x7f]/.test(value.accountId)) return null
  return Object.freeze({ protocolId: value.protocolId, accountId: value.accountId })
}
