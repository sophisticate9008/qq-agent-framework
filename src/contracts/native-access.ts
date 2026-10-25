export interface NativeChatAccess {
  readonly allow: readonly string[]
  readonly deny: readonly string[]
  readonly owner: string | null
}

export function isNativeAccessAccount(value: unknown, maximumDigits = 32): value is string {
  return typeof value === 'string' && value.length <= maximumDigits && /^[1-9][0-9]*$/.test(value)
}

export function isNativeAccessScope(value: unknown, maximumDigits = 32): value is string {
  if (typeof value !== 'string') return false
  const match = /^(?:group|private):([1-9][0-9]*)$/.exec(value)
  return match !== null && match[1]!.length <= maximumDigits
}

export function validateNativeChatAccess(input: unknown, options: {
  readonly maximumDigits?: number
  readonly allowOverlap?: boolean
  readonly storedSchema?: boolean
} = {}): NativeChatAccess {
  const maximumDigits = options.maximumDigits ?? 32
  const invalid = (): never => { throw new TypeError('Invalid native access rules') }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const value = input as Record<string, unknown>
  const required = options.storedSchema === true ? ['schema', 'allow', 'deny', 'owner'] : ['allow', 'deny', 'owner']
  if (!required.every(key => Object.hasOwn(value, key)) || !Object.keys(value).every(key => required.includes(key))
    || options.storedSchema === true && value.schema !== 1
    || value.owner !== null && !isNativeAccessAccount(value.owner, maximumDigits)) return invalid()
  const entries = (list: unknown): list is readonly string[] => Array.isArray(list) && list.length <= 1_024
    && new Set(list).size === list.length && list.every(scope => isNativeAccessScope(scope, maximumDigits))
  if (!entries(value.allow) || !entries(value.deny)) return invalid()
  if (options.allowOverlap === false && value.allow.some(scope => (value.deny as readonly string[]).includes(scope))) return invalid()
  return Object.freeze({ allow: Object.freeze([...value.allow]), deny: Object.freeze([...value.deny]), owner: value.owner as string | null })
}
