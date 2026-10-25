export const NATIVE_MEMORY_PATH = '/api/chat/memory'

export type NativeMemoryScope = { readonly kind: 'global' }
  | { readonly kind: 'group'; readonly conversationId: string }
  | { readonly kind: 'user'; readonly userId: string; readonly conversationId: string }

export type NativeMemorySource = { readonly kind: 'operator' }
  | { readonly kind: 'owner-message' | 'user-message' | 'model-inference'; readonly conversationId: string;
    readonly messageId: string; readonly userId: string }
export type NativeMemoryAuthority = Extract<NativeMemorySource, { readonly kind: 'operator' }>
  | { readonly kind: 'owner-message'; readonly conversationId: string; readonly messageId: string; readonly userId: string }

export interface NativeMemoryInput {
  readonly scope: NativeMemoryScope
  readonly kind: 'memory' | 'preference'
  readonly content: string
  readonly tags: readonly string[]
  readonly expiresAt: number | null
}
export interface NativeMemoryChange {
  readonly action: 'propose' | 'create' | 'confirm' | 'correct' | 'revoke'
  readonly at: number
  readonly source: NativeMemorySource
  readonly previousDigest: string | null
}
export interface NativeMemoryEntry extends NativeMemoryInput {
  readonly schema: 1
  readonly id: string
  readonly revision: number
  readonly owner: 'memory'
  readonly status: 'proposed' | 'confirmed' | 'revoked' | 'expired'
  readonly source: NativeMemorySource
  readonly confirmedBy: NativeMemoryAuthority | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly history: readonly NativeMemoryChange[]
  readonly historyTruncated: boolean
}
export interface NativeMemoryContextItem {
  readonly id: string
  readonly revision: number
  readonly kind: 'memory' | 'preference'
  readonly content: string
  readonly scope: NativeMemoryScope
  readonly source: NativeMemorySource
  readonly confirmedBy: NativeMemoryAuthority
  readonly expiresAt: number | null
  readonly truncated: boolean
}
export interface NativeMemoryContext {
  readonly schema: 1
  readonly conversationId: string
  readonly userId: string
  readonly source: 'confirmed-memory'
  readonly authorization: false
  readonly items: readonly NativeMemoryContextItem[]
  readonly total: number
  readonly omitted: number
  readonly truncated: boolean
  readonly usedCharacters: number
  readonly usedBytes: number
}
export interface NativeMemoryReadOptions {
  readonly scope?: NativeMemoryScope
  readonly limit?: number
  readonly after?: string
}
export interface NativeMemorySnapshot {
  readonly schema: 1
  readonly entries: readonly NativeMemoryEntry[]
  readonly nextCursor: string | null
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function account(value: unknown): value is string { return typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value) }
function conversation(value: unknown): value is string { return typeof value === 'string' && /^(?:group|private):[1-9][0-9]{0,31}$/.test(value) }
function invalid(): never { throw new TypeError('INVALID_NATIVE_MEMORY') }

export function validateNativeMemoryScope(value: unknown): NativeMemoryScope {
  if (!record(value)) invalid()
  if (value.kind === 'global' && exact(value, ['kind'])) return Object.freeze({ kind: 'global' })
  if (value.kind === 'group' && exact(value, ['kind', 'conversationId']) && conversation(value.conversationId)
    && value.conversationId.startsWith('group:')) return Object.freeze({ kind: 'group', conversationId: value.conversationId })
  if (value.kind === 'user' && exact(value, ['kind', 'userId', 'conversationId']) && account(value.userId) && conversation(value.conversationId))
    return Object.freeze({ kind: 'user', userId: value.userId, conversationId: value.conversationId })
  return invalid()
}
export function validateNativeMemorySource(value: unknown): NativeMemorySource {
  if (!record(value)) invalid()
  if (value.kind === 'operator' && exact(value, ['kind'])) return Object.freeze({ kind: 'operator' })
  if (['owner-message', 'user-message', 'model-inference'].includes(String(value.kind)) && exact(value, ['kind', 'conversationId', 'messageId', 'userId'])
    && conversation(value.conversationId) && account(value.userId) && typeof value.messageId === 'string'
    && value.messageId.length > 0 && value.messageId.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value.messageId))
    return Object.freeze({ kind: value.kind, conversationId: value.conversationId, messageId: value.messageId, userId: value.userId }) as NativeMemorySource
  return invalid()
}
export function validateNativeMemoryInput(value: unknown): NativeMemoryInput {
  if (!record(value) || !exact(value, ['scope', 'kind', 'content', 'tags', 'expiresAt'])
    || value.kind !== 'memory' && value.kind !== 'preference' || typeof value.content !== 'string'
    || value.content.trim().length === 0 || value.content.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.content)
    || !Array.isArray(value.tags) || value.tags.length > 16 || value.tags.some(tag => typeof tag !== 'string' || tag.length === 0
      || tag.length > 64 || /[\u0000-\u001f\u007f]/.test(tag)) || new Set(value.tags).size !== value.tags.length
    || value.expiresAt !== null && (typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt)
      || value.expiresAt < 0 || value.expiresAt > 8_639_999_000_000_000)) invalid()
  return Object.freeze({ scope: validateNativeMemoryScope(value.scope), kind: value.kind, content: value.content,
    tags: Object.freeze([...value.tags] as string[]), expiresAt: value.expiresAt as number | null })
}

export function parseNativeMemoryEntry(input: unknown): NativeMemoryEntry | null {
  if (!record(input) || !exact(input, ['schema', 'id', 'revision', 'owner', 'status', 'scope', 'kind', 'content', 'tags', 'expiresAt',
    'source', 'confirmedBy', 'createdAt', 'updatedAt', 'history', 'historyTruncated']) || input.schema !== 1 || input.owner !== 'memory'
    || typeof input.id !== 'string' || !/^memory-[a-f0-9-]{36}$/.test(input.id) || typeof input.revision !== 'number'
    || !Number.isSafeInteger(input.revision) || input.revision < 1 || !['proposed', 'confirmed', 'revoked', 'expired'].includes(String(input.status))
    || typeof input.createdAt !== 'number' || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || typeof input.updatedAt !== 'number' || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < input.createdAt
    || !Array.isArray(input.history) || input.history.length < 1 || input.history.length > 32 || typeof input.historyTruncated !== 'boolean') return null
  try {
    const value = validateNativeMemoryInput({ scope: input.scope, kind: input.kind, content: input.content, tags: input.tags, expiresAt: input.expiresAt })
    const source = validateNativeMemorySource(input.source)
    const confirmedBy = input.confirmedBy === null ? null : validateNativeMemorySource(input.confirmedBy)
    if (confirmedBy !== null && confirmedBy.kind !== 'operator' && confirmedBy.kind !== 'owner-message'
      || input.status === 'confirmed' && confirmedBy === null) return null
    const history: NativeMemoryChange[] = []
    for (const change of input.history) {
      if (!record(change) || !exact(change, ['action', 'at', 'source', 'previousDigest'])
        || !['propose', 'create', 'confirm', 'correct', 'revoke'].includes(String(change.action))
        || typeof change.at !== 'number' || !Number.isSafeInteger(change.at) || change.at < 0
        || change.previousDigest !== null && (typeof change.previousDigest !== 'string' || !/^[a-f0-9]{64}$/.test(change.previousDigest))) return null
      history.push(Object.freeze({ action: change.action, at: change.at, source: validateNativeMemorySource(change.source),
        previousDigest: change.previousDigest }) as NativeMemoryChange)
    }
    return Object.freeze({ ...input, ...value, source, confirmedBy, history: Object.freeze(history) }) as unknown as NativeMemoryEntry
  } catch { return null }
}

export function parseNativeMemorySnapshot(input: unknown): NativeMemorySnapshot | null {
  if (!record(input) || !exact(input, ['schema', 'entries', 'nextCursor']) || input.schema !== 1
    || !Array.isArray(input.entries) || input.entries.length > 256
    || input.nextCursor !== null && (typeof input.nextCursor !== 'string' || !/^memory-[a-f0-9-]{36}$/.test(input.nextCursor))) return null
  const entries = input.entries.map(parseNativeMemoryEntry)
  if (entries.some(entry => entry === null) || new Set(entries.map(entry => entry?.id)).size !== entries.length) return null
  return Object.freeze({ schema: 1, entries: Object.freeze(entries as NativeMemoryEntry[]), nextCursor: input.nextCursor as string | null })
}
