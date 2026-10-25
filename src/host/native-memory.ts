import { randomUUID } from 'node:crypto'
import { FrameworkError, errorCode, snapshot } from '../core/values.ts'
import type { DurableStore, StoredRecord } from '../contracts/ports.ts'
import { parseNativeMemoryEntry, validateNativeMemoryInput, validateNativeMemoryScope, validateNativeMemorySource,
  type NativeMemoryAuthority, type NativeMemoryChange, type NativeMemoryContext, type NativeMemoryContextItem,
  type NativeMemoryEntry, type NativeMemoryInput, type NativeMemoryScope, type NativeMemorySource } from '../contracts/native-memory.ts'
import { digest, json, object } from './data.ts'

const namespace = 'package.memory.entries'
const hardLimit = 4096
type StoredStatus = 'proposed' | 'confirmed' | 'revoked'
function fail(code: string): never { throw new FrameworkError(code, 'The memory operation could not be completed.') }
function now(clock: () => number): number {
  const value = clock()
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_639_999_000_000_000) fail('MEMORY_CLOCK_INVALID')
  return value
}
function account(input: unknown): input is string { return typeof input === 'string' && /^[1-9][0-9]{0,31}$/.test(input) }
function conversation(input: unknown): input is string { return typeof input === 'string' && /^(?:group|private):[1-9][0-9]{0,31}$/.test(input) }
function scopeKey(scope: NativeMemoryScope): string {
  return scope.kind === 'global' ? 'global' : scope.kind === 'group' ? scope.conversationId : `user:${scope.userId}@${scope.conversationId}`
}
function read(record: StoredRecord, time: number): NativeMemoryEntry {
  const { scopeKey: storedScopeKey, ...input } = object(record.value)
  const entry = parseNativeMemoryEntry({ ...input, revision: record.revision })
  if (!entry || entry.id !== record.key || entry.status === 'expired' || storedScopeKey !== scopeKey(entry.scope)) fail('MEMORY_STORED_INVALID')
  return entry.status !== 'revoked' && entry.expiresAt !== null && entry.expiresAt <= time
    ? snapshot({ ...entry, status: 'expired' as const }) : entry
}
function records(store: Pick<DurableStore, 'list'>): readonly StoredRecord[] {
  const result: StoredRecord[] = []
  let after: string | undefined
  do {
    const page = store.list(namespace, { limit: 256, ...(after === undefined ? {} : { after }) })
    result.push(...page)
    if (result.length > hardLimit) fail('MEMORY_CAPACITY_EXCEEDED')
    after = page.length === 256 ? page.at(-1)!.key : undefined
  } while (after !== undefined)
  return result
}
export function readNativeMemoryEntry(store: Pick<DurableStore, 'read'>, id: string, clock: () => number = Date.now): NativeMemoryEntry {
  if (!/^memory-[a-f0-9-]{36}$/.test(id)) fail('MEMORY_INVALID')
  const record = store.read(namespace, id)
  if (!record) fail('MEMORY_NOT_FOUND')
  return read(record, now(clock))
}
export function readNativeMemoryEntries(store: Pick<DurableStore, 'list'>, options: {
  readonly clock?: () => number
  readonly scope?: NativeMemoryScope
  readonly limit?: number
  readonly after?: string
} = {}) {
  const limit = options.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 || options.after !== undefined && !/^memory-[a-f0-9-]{36}$/.test(options.after)) fail('MEMORY_INVALID_QUERY')
  const target = options.scope === undefined ? null : scopeKey(validateNativeMemoryScope(options.scope))
  const page = store.list(namespace, { limit: limit + 1, ...(options.after === undefined ? {} : { after: options.after }) })
  const time = now(options.clock ?? Date.now)
  const entries: NativeMemoryEntry[] = []
  let bytes = 0
  let scanned = 0
  for (const record of page.slice(0, limit)) {
    const entry = read(record, time)
    if (target === null || scopeKey(entry.scope) === target) {
      const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
      if (bytes + size > 3 * 1024 * 1024 && entries.length > 0) break
      entries.push(entry); bytes += size
    }
    scanned++
  }
  return snapshot({ schema: 1 as const, entries, nextCursor: page.length > scanned && scanned > 0 ? page[scanned - 1]!.key : null })
}

export interface NativeMemoryQuery {
  readonly conversationId: string
  readonly userId: string
  readonly query?: string
  readonly limit?: number
}
export interface NativeMemoryOptions {
  readonly store: DurableStore
  readonly clock?: () => number
  readonly maxPerScope?: number
  readonly maxEntries?: number
  readonly authorizeSource: (source: NativeMemorySource, scope: NativeMemoryScope, signal: AbortSignal) => void | Promise<void>
  readonly authorizeOwner: (authority: NativeMemoryAuthority, signal: AbortSignal) => void | Promise<void>
  readonly authorizeRead: (conversationId: string, userId: string, signal: AbortSignal) => void | Promise<void>
}

/** Memory is scoped, sourced data. Neither confirmed text nor proposed preferences change policy/configuration. */
export function createNativeMemoryService(options: NativeMemoryOptions) {
  const { store, clock = Date.now } = options
  const maxPerScope = options.maxPerScope ?? 128
  const maxEntries = options.maxEntries ?? hardLimit
  if (!Number.isSafeInteger(maxPerScope) || maxPerScope < 1 || maxPerScope > 128
    || !Number.isSafeInteger(maxEntries) || maxEntries < maxPerScope || maxEntries > hardLimit) fail('MEMORY_INVALID_OPTIONS')
  let indexed = false
  function prepare(): void {
    if (indexed || !store.createIndex || !store.lookup) return
    store.createIndex({ namespace, field: 'scopeKey' })
    indexed = true
  }
  function get(id: string, revision?: number): { readonly record: StoredRecord; readonly entry: NativeMemoryEntry } {
    if (!/^memory-[a-f0-9-]{36}$/.test(id) || revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) fail('MEMORY_INVALID')
    const record = store.read(namespace, id)
    if (!record) fail('MEMORY_NOT_FOUND')
    if (revision !== undefined && record.revision !== revision) fail('MEMORY_CONFLICT')
    return { record, entry: read(record, now(clock)) }
  }
  function save(entry: Omit<NativeMemoryEntry, 'revision' | 'status'> & { readonly status: StoredStatus }, expectedRevision: number | null): NativeMemoryEntry {
    const value = { ...entry, scopeKey: scopeKey(entry.scope) }
    try {
      const saved = store.write(namespace, entry.id, json(value), { expectedRevision })
      const current = store.read(namespace, entry.id)
      if (!current || current.revision !== saved.revision || digest(current.value) !== digest(value)) fail('MEMORY_WRITE_UNKNOWN')
      return read(current, now(clock))
    } catch (error) {
      if (errorCode(error) === 'STORE_CONFLICT') fail('MEMORY_CONFLICT')
      return fail('MEMORY_WRITE_UNKNOWN')
    }
  }
  function capacity(scope: NativeMemoryScope): void {
    const all = records(store)
    if (all.length >= maxEntries) fail('MEMORY_CAPACITY_EXCEEDED')
    if (all.filter(record => scopeKey(read(record, now(clock)).scope) === scopeKey(scope)).length >= maxPerScope) fail('MEMORY_SCOPE_CAPACITY_EXCEEDED')
  }
  function input(value: unknown): NativeMemoryInput {
    let normalized: NativeMemoryInput
    try { normalized = validateNativeMemoryInput(value) } catch { return fail('MEMORY_INVALID') }
    if (normalized.expiresAt !== null && normalized.expiresAt <= now(clock)) fail('MEMORY_EXPIRY_IN_PAST')
    return normalized
  }
  async function owner(value: NativeMemoryAuthority, signal: AbortSignal): Promise<NativeMemoryAuthority> {
    let authority: NativeMemorySource
    try { authority = validateNativeMemorySource(value) } catch { return fail('MEMORY_AUTHORITY_INVALID') }
    if (authority.kind !== 'operator' && authority.kind !== 'owner-message') fail('MEMORY_OWNER_REQUIRED')
    signal.throwIfAborted()
    await options.authorizeOwner(authority as NativeMemoryAuthority, signal)
    signal.throwIfAborted()
    return authority as NativeMemoryAuthority
  }
  function history(entry: NativeMemoryEntry, action: NativeMemoryChange['action'], source: NativeMemorySource) {
    const change: NativeMemoryChange = { action, source, at: now(clock), previousDigest: digest({ content: entry.content, tags: entry.tags, status: entry.status }) }
    return { history: [...entry.history, change].slice(-32), historyTruncated: entry.historyTruncated || entry.history.length >= 32 }
  }
  function candidate(entry: NativeMemoryEntry) {
    const { revision: _revision, status, ...value } = entry
    if (status === 'expired') fail('MEMORY_EXPIRED')
    return { ...value, status }
  }
  async function create(value: unknown, source: NativeMemorySource, confirmed: boolean, confirmedBy: NativeMemoryAuthority | null, signal: AbortSignal): Promise<NativeMemoryEntry> {
    const normalized = input(value)
    signal.throwIfAborted()
    capacity(normalized.scope)
    const time = now(clock)
    const entry = { ...normalized, schema: 1 as const, id: `memory-${randomUUID()}`, owner: 'memory' as const,
      status: confirmed ? 'confirmed' as const : 'proposed' as const, source, confirmedBy, createdAt: time, updatedAt: time,
      history: [{ action: confirmed ? 'create' as const : 'propose' as const, source, at: time, previousDigest: null }], historyTruncated: false }
    prepare()
    return save(entry, null)
  }
  function queryOptions(query: NativeMemoryQuery): void {
    if (!conversation(query.conversationId) || !account(query.userId) || query.query !== undefined
      && (typeof query.query !== 'string' || query.query.length > 256)
      || query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 128)) fail('MEMORY_INVALID_QUERY')
  }
  function matching(query: NativeMemoryQuery): NativeMemoryEntry[] {
    queryOptions(query)
    const keys = ['global', `user:${query.userId}@${query.conversationId}`,
      ...(query.conversationId.startsWith('group:') ? [query.conversationId] : [])]
    const selected = indexed && store.lookup
      ? keys.flatMap(key => {
        const page = store.lookup!({ namespace, field: 'scopeKey', equals: key, limit: 129 })
        if (page.length > maxPerScope) fail('MEMORY_SCOPE_CAPACITY_EXCEEDED')
        return [...page]
      })
      : records(store)
    const time = now(clock)
    const terms = (query.query ?? '').normalize('NFKC').toLocaleLowerCase().split(/\s+/u).filter(Boolean).slice(0, 16)
    return selected.map(record => read(record, time)).filter(entry => entry.status === 'confirmed' && keys.includes(scopeKey(entry.scope)))
      .map(entry => ({ entry, score: terms.reduce((score, term) => score + (`${entry.content}\n${entry.tags.join(' ')}`.normalize('NFKC').toLocaleLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter(item => terms.length === 0 || item.score > 0)
      .sort((left, right) => right.score - left.score || right.entry.updatedAt - left.entry.updatedAt || left.entry.id.localeCompare(right.entry.id))
      .map(item => item.entry)
  }
  async function authorizeQuery(query: NativeMemoryQuery, signal: AbortSignal): Promise<void> {
    queryOptions(query); signal.throwIfAborted()
    await options.authorizeRead(query.conversationId, query.userId, signal)
    signal.throwIfAborted()
  }
  return Object.freeze({
    prepare,
    read(id: string) { return get(id).entry },
    list(readOptions: Parameters<typeof readNativeMemoryEntries>[1] = {}) { return readNativeMemoryEntries(store, { ...readOptions, clock }) },
    async propose(value: unknown, sourceInput: NativeMemorySource, signal: AbortSignal): Promise<NativeMemoryEntry> {
      const normalized = input(value)
      let source: NativeMemorySource
      try { source = validateNativeMemorySource(sourceInput) } catch { return fail('MEMORY_SOURCE_INVALID') }
      if (source.kind === 'operator' || normalized.scope.kind === 'global' || source.conversationId !== normalized.scope.conversationId
        || normalized.scope.kind === 'user' && normalized.scope.userId !== source.userId) fail('MEMORY_SOURCE_SCOPE_MISMATCH')
      signal.throwIfAborted()
      await options.authorizeSource(source, normalized.scope, signal)
      signal.throwIfAborted()
      return create(normalized, source, false, null, signal)
    },
    async createConfirmed(value: unknown, authorityInput: NativeMemoryAuthority, signal: AbortSignal): Promise<NativeMemoryEntry> {
      const authority = await owner(authorityInput, signal)
      return create(value, authority, true, authority, signal)
    },
    async confirm(id: string, revision: number, authorityInput: NativeMemoryAuthority, signal: AbortSignal): Promise<NativeMemoryEntry> {
      const authority = await owner(authorityInput, signal)
      if (authority.kind !== 'owner-message') fail('MEMORY_CONFIRMATION_REQUIRES_QQ_OWNER')
      const { entry } = get(id, revision)
      if (entry.status !== 'proposed') fail('MEMORY_NOT_PROPOSED')
      if (entry.scope.kind !== 'global' && authority.conversationId !== entry.scope.conversationId) fail('MEMORY_CONFIRMATION_SCOPE_MISMATCH')
      return save({ ...candidate(entry), status: 'confirmed', confirmedBy: authority, updatedAt: now(clock), ...history(entry, 'confirm', authority) }, revision)
    },
    async correct(id: string, revision: number, value: unknown, authorityInput: NativeMemoryAuthority, signal: AbortSignal): Promise<NativeMemoryEntry> {
      const authority = await owner(authorityInput, signal)
      const normalized = input(value)
      const { entry } = get(id, revision)
      if (entry.status === 'revoked') fail('MEMORY_REVOKED')
      if (scopeKey(normalized.scope) !== scopeKey(entry.scope)) fail('MEMORY_SCOPE_IMMUTABLE')
      const previous = { ...entry, status: entry.status === 'expired' ? 'confirmed' as const : entry.status }
      if (entry.status === 'expired' && entry.confirmedBy === null) previous.status = 'proposed'
      return save({ ...candidate(previous), ...normalized, updatedAt: now(clock),
        confirmedBy: previous.status === 'confirmed' ? authority : null, ...history(entry, 'correct', authority) }, revision)
    },
    async revoke(id: string, revision: number, authorityInput: NativeMemoryAuthority, signal: AbortSignal): Promise<NativeMemoryEntry> {
      const authority = await owner(authorityInput, signal)
      const { entry } = get(id, revision)
      if (entry.status === 'revoked') return entry
      const { revision: _revision, ...value } = entry
      return save({ ...value, status: 'revoked', updatedAt: now(clock), ...history(entry, 'revoke', authority) }, revision)
    },
    async remove(id: string, revision: number, authorityInput: NativeMemoryAuthority, signal: AbortSignal): Promise<boolean> {
      await owner(authorityInput, signal)
      get(id, revision)
      try {
        const deleted = store.delete(namespace, id, revision)
        if (!deleted || store.read(namespace, id)) fail('MEMORY_DELETE_UNKNOWN')
        return true
      } catch (error) {
        if (errorCode(error) === 'STORE_CONFLICT') fail('MEMORY_CONFLICT')
        return fail('MEMORY_DELETE_UNKNOWN')
      }
    },
    async purgeExpired(authorityInput: NativeMemoryAuthority, signal: AbortSignal, limit = 100): Promise<{ readonly removed: number; readonly remaining: boolean }> {
      await owner(authorityInput, signal)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) fail('MEMORY_INVALID_QUERY')
      const expired = records(store).filter(record => read(record, now(clock)).status === 'expired')
      let removed = 0
      for (const record of expired.slice(0, limit)) { signal.throwIfAborted(); if (store.delete(namespace, record.key, record.revision)) removed++ }
      return snapshot({ removed, remaining: expired.length > limit })
    },
    async query(query: NativeMemoryQuery, signal: AbortSignal): Promise<readonly NativeMemoryEntry[]> {
      await authorizeQuery(query, signal)
      return snapshot(matching(query).slice(0, query.limit ?? 32))
    },
    async context(query: NativeMemoryQuery & { readonly maxCharacters?: number; readonly maxBytes?: number }, signal: AbortSignal): Promise<NativeMemoryContext> {
      await authorizeQuery(query, signal)
      const maxCharacters = query.maxCharacters ?? 1_500
      const maxBytes = query.maxBytes ?? 8_000
      if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0 || maxCharacters > 6_000
        || !Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > 24_000) fail('MEMORY_INVALID_BUDGET')
      const matches = matching(query)
      const items: NativeMemoryContextItem[] = []
      let characters = 0
      for (const entry of matches.slice(0, query.limit ?? 16)) {
        const length = Math.min(entry.content.length, maxCharacters - characters)
        if (length <= 0) break
        items.push({ id: entry.id, revision: entry.revision, kind: entry.kind, content: entry.content.slice(0, length), scope: entry.scope,
          source: entry.source, confirmedBy: entry.confirmedBy!, expiresAt: entry.expiresAt, truncated: length < entry.content.length })
        characters += length
      }
      function build(): NativeMemoryContext {
        const value = { schema: 1 as const, conversationId: query.conversationId, userId: query.userId, source: 'confirmed-memory' as const,
          authorization: false as const, items, total: matches.length, omitted: matches.length - items.length,
          truncated: matches.length > items.length || items.some(item => item.truncated), usedCharacters: items.reduce((sum, item) => sum + item.content.length, 0), usedBytes: 0 }
        for (let pass = 0; pass < 4; pass++) {
          const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
          if (bytes === value.usedBytes) break
          value.usedBytes = bytes
        }
        return value
      }
      let value = build()
      while (value.usedBytes > maxBytes && items.length > 0) {
        const last = items.pop()!
        const excess = value.usedBytes - maxBytes
        if (last.content.length > excess + 32) items.push({ ...last, content: last.content.slice(0, last.content.length - excess - 32), truncated: true })
        value = build()
      }
      if (value.usedBytes > maxBytes) fail('MEMORY_INVALID_BUDGET')
      return snapshot(value)
    }
  })
}

export type NativeMemoryService = ReturnType<typeof createNativeMemoryService>
