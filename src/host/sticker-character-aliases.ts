import { assert, isRecord, snapshot } from '../core/values.ts'
import { digest, json } from './data.ts'
import { normalizeStickerCharacterName, validateStickerCharacterIdentity, type StickerCharacterIdentity } from './sticker-semantics.ts'
import type { DurableStore, StoredRecord } from './types.ts'

export interface StickerCharacterAliasClaim extends StickerCharacterIdentity { readonly updatedAt: number }
export interface StickerCharacterAliasRecord {
  readonly id: string
  readonly revision: number
  readonly character: string
  /** All source-labelled aliases aid recall; they are not all user-confirmed. */
  readonly aliases: readonly string[]
  /** The highest-precedence claim retains only its own aliases and provenance. */
  readonly identity: StickerCharacterIdentity
  readonly claims: readonly StickerCharacterAliasClaim[]
  readonly updatedAt: number
}
const SOURCE_PRECEDENCE = { user: 3, web: 2, model: 1 } as const
const MAX_CHARACTERS = 1024

/** A per-account character dictionary. It never turns model recognition into confirmed identity. */
export function createStickerCharacterAliases(store: DurableStore, accountId: string) {
  assert(typeof accountId === 'string' && accountId.length > 0 && accountId.length <= 256,
    'STICKER_CHARACTER_ACCOUNT_INVALID', 'Character aliases need an explicit account identity.')
  const namespace = `native-chat.sticker-characters.${digest(accountId)}`
  const key = (character: string) => digest(normalizeStickerCharacterName(character))

  function project(row: Pick<StoredRecord, 'key' | 'revision' | 'updatedAt'>, claims: readonly StickerCharacterAliasClaim[]): StickerCharacterAliasRecord {
    const ordered = [...claims].sort((left, right) => SOURCE_PRECEDENCE[right.source] - SOURCE_PRECEDENCE[left.source])
    const { updatedAt: _claimTime, ...identity } = ordered[0]!
    const aliases = new Map<string, string>()
    for (const claim of ordered) for (const alias of claim.aliases) {
      const normalized = normalizeStickerCharacterName(alias)
      if (normalized !== normalizeStickerCharacterName(identity.character) && !aliases.has(normalized)) aliases.set(normalized, alias)
    }
    return snapshot({ id: row.key, revision: row.revision, character: identity.character, aliases: [...aliases.values()],
      identity, claims: ordered, updatedAt: row.updatedAt })
  }
  function decode(row: StoredRecord): StickerCharacterAliasRecord {
    const value = row.value
    assert(isRecord(value) && value.schema === 1 && value.accountId === accountId && Array.isArray(value.claims)
      && value.claims.length > 0 && value.claims.length <= 3,
    'STICKER_CHARACTER_RECORD_INVALID', 'The stored character dictionary has invalid provenance.')
    const claims = value.claims.map(claim => {
      assert(isRecord(claim) && Number.isSafeInteger(claim.updatedAt) && Number(claim.updatedAt) >= 0,
        'STICKER_CHARACTER_RECORD_INVALID', 'Character claims need their source update time.')
      const { updatedAt, ...fields } = claim
      const identity = validateStickerCharacterIdentity(fields)
      assert(key(identity.character) === row.key, 'STICKER_CHARACTER_RECORD_INVALID', 'Character claims cannot change their canonical identity.')
      return { ...identity, updatedAt: Number(updatedAt) }
    })
    assert(new Set(claims.map(claim => claim.source)).size === claims.length,
      'STICKER_CHARACTER_RECORD_INVALID', 'Each source owns a separate character claim.')
    return project(row, claims)
  }
  function records(): readonly StickerCharacterAliasRecord[] {
    const result: StickerCharacterAliasRecord[] = []
    let after: string | undefined
    while (result.length <= MAX_CHARACTERS) {
      const page = store.list(namespace, { limit: 256, ...(after === undefined ? {} : { after }) })
      result.push(...page.map(decode))
      if (page.length < 256) break
      after = page.at(-1)!.key
    }
    assert(result.length <= MAX_CHARACTERS, 'STICKER_CHARACTER_CAPACITY', 'The account character dictionary is full.')
    return result
  }
  function read(character: string): StickerCharacterAliasRecord | null {
    const row = store.read(namespace, key(character))
    return row ? decode(row) : null
  }
  return Object.freeze({
    read,
    list({ limit = 256 }: { readonly limit?: number } = {}): readonly StickerCharacterAliasRecord[] {
      assert(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_CHARACTERS,
        'STICKER_CHARACTER_QUERY_INVALID', 'Use a bounded character dictionary page.')
      return records().slice(0, limit)
    },
    /** Ambiguous aliases retain every matching character; no guessed merge or correction. */
    resolve(alias: string, { includeTentative = true }: { readonly includeTentative?: boolean } = {}): readonly StickerCharacterAliasRecord[] {
      const normalized = normalizeStickerCharacterName(alias)
      if (!normalized || normalized.length > 64) return []
      return records().flatMap(record => {
        const claims = record.claims.filter(claim => includeTentative || claim.source !== 'model')
        if (!claims.some(claim => [claim.character, ...claim.aliases].some(name => normalizeStickerCharacterName(name) === normalized))) return []
        return [project({ key: record.id, revision: record.revision, updatedAt: record.updatedAt }, claims)]
      })
    },
    /** Only the supplied source's claim changes. replaceAliases never edits other sources. */
    remember(input: StickerCharacterIdentity, options: { readonly replaceAliases?: boolean; readonly expectedRevision?: number | null } = {}): StickerCharacterAliasRecord {
      const identity = validateStickerCharacterIdentity(input)
      const id = key(identity.character), previous = store.read(namespace, id), current = previous ? decode(previous) : null
      assert(options.expectedRevision === undefined || options.expectedRevision === (previous?.revision ?? null),
        'STORE_CONFLICT', 'The character dictionary changed before this update.')
      if (!current) assert(records().length < MAX_CHARACTERS, 'STICKER_CHARACTER_CAPACITY', 'The account character dictionary is full.')
      const priorClaim = current?.claims.find(claim => claim.source === identity.source)
      const aliases = new Map<string, string>()
      for (const alias of [...(options.replaceAliases ? [] : priorClaim?.aliases ?? []), ...identity.aliases]) {
        const normalized = normalizeStickerCharacterName(alias)
        if (normalized !== normalizeStickerCharacterName(identity.character) && !aliases.has(normalized)) aliases.set(normalized, alias)
      }
      assert(aliases.size <= 8, 'STICKER_CHARACTER_ALIAS_CAPACITY', 'Each provenance claim stores at most eight character aliases.')
      const nextIdentity = {
        ...(priorClaim?.evidence === undefined ? {} : { evidence: priorClaim.evidence }),
        ...(priorClaim?.references === undefined ? {} : { references: priorClaim.references }),
        ...identity, aliases: [...aliases.values()],
      }
      if (priorClaim) {
        const { updatedAt: _time, ...priorIdentity } = priorClaim
        if (digest(priorIdentity) === digest(nextIdentity)) return current!
      }
      const claims = [...(current?.claims.filter(claim => claim.source !== identity.source) ?? []), { ...nextIdentity, updatedAt: Date.now() }]
      return decode(store.write(namespace, id, json({ schema: 1, accountId, claims }), { expectedRevision: previous?.revision ?? null }))
    },
    /** Removal is explicit and source-specific; callers supply the version they reviewed. */
    remove(character: string, source: StickerCharacterIdentity['source'], expectedRevision: number): boolean {
      assert(['model', 'user', 'web'].includes(source), 'STICKER_CHARACTER_SOURCE_INVALID', 'Choose the character claim source to remove.')
      const id = key(character), previous = store.read(namespace, id)
      assert(previous && previous.revision === expectedRevision, 'STORE_CONFLICT', 'The character dictionary changed before this removal.')
      const current = decode(previous), claims = current.claims.filter(claim => claim.source !== source)
      if (claims.length === current.claims.length) return false
      if (!claims.length) return store.delete(namespace, id, previous.revision)
      store.write(namespace, id, json({ schema: 1, accountId, claims }), { expectedRevision: previous.revision })
      return true
    },
  })
}
