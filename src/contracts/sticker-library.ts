import { isRecord } from './values.ts'

export type StickerLibraryConfiguration = {
  readonly enabled: boolean
  readonly triggerProbabilityPercent: number
  readonly collectProbabilityPercent: number
  readonly accountNearFullAt: number
}
export const DEFAULT_STICKER_LIBRARY_CONFIGURATION: StickerLibraryConfiguration = Object.freeze({
  enabled: true, triggerProbabilityPercent: 15, collectProbabilityPercent: 15, accountNearFullAt: 240,
})
export function validateStickerLibraryConfiguration(value: unknown): StickerLibraryConfiguration {
  if (!isRecord(value) || Object.keys(value).length !== 4
    || !Object.keys(DEFAULT_STICKER_LIBRARY_CONFIGURATION).every(key => Object.hasOwn(value, key))
    || typeof value.enabled !== 'boolean'
    || ![value.triggerProbabilityPercent, value.collectProbabilityPercent].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100)
    || !Number.isSafeInteger(value.accountNearFullAt) || Number(value.accountNearFullAt) < 1 || Number(value.accountNearFullAt) > 10000) {
    throw new TypeError('Invalid sticker library configuration')
  }
  return { enabled: value.enabled, triggerProbabilityPercent: Number(value.triggerProbabilityPercent),
    collectProbabilityPercent: Number(value.collectProbabilityPercent), accountNearFullAt: Number(value.accountNearFullAt) }
}
export interface StickerLibraryFacets {
  readonly emotions: readonly string[]
  readonly actions: readonly string[]
  readonly intents: readonly string[]
  readonly scenes: readonly string[]
  readonly visibleText: string
}
export interface StickerLibraryIdentity {
  readonly character: string
  readonly aliases: readonly string[]
  readonly source: 'model' | 'user' | 'web'
  readonly evidence?: string
  readonly references?: readonly { readonly url: string; readonly title: string }[]
}
export interface StickerLibraryVisualFeatures {
  readonly colors: readonly string[]
  readonly styles: readonly string[]
  readonly entities: readonly string[]
}
export interface StickerImageDimensions { readonly width: number; readonly height: number }
export function parseStickerImageDimensions(value: unknown): StickerImageDimensions | null {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || Number(value.width) < 1 || Number(value.height) < 1 || Number(value.width) > 100_000 || Number(value.height) > 100_000
    || Number(value.width) * Number(value.height) > 40_000_000) return null
  return { width: Number(value.width), height: Number(value.height) }
}
const facetText = (value: unknown, maximum: number, empty = false): value is string => typeof value === 'string'
  && value.trim() === value && (empty || value.length > 0) && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value)
const facetLabels = (value: unknown, maximum: number, length = 24): value is readonly string[] => Array.isArray(value)
  && value.length <= maximum && value.every(label => facetText(label, length))
  && new Set(value.map(label => String(label).normalize('NFKC').toLocaleLowerCase())).size === value.length
const characterKey = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s_]+/g, ' ').trim()
function referenceUrl(value: unknown): value is string {
  if (!facetText(value, 512)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && ![...url.searchParams.keys()].some(key => /token|auth|key|signature|cookie|credential|password|secret|session/i.test(key))
  } catch { return false }
}
export function parseStickerLibraryIdentity(value: unknown): StickerLibraryIdentity | null {
  if (!isRecord(value) || !facetText(value.character, 64) || /[\u202a-\u202e\u2066-\u2069]/.test(value.character)
    || characterKey(value.character).length === 0
    || !facetLabels(value.aliases, 8, 64) || value.aliases.some(alias => /[\u202a-\u202e\u2066-\u2069]/.test(alias))
    || value.aliases.some(alias => characterKey(alias).length === 0)
    || new Set(value.aliases.map(characterKey)).size !== value.aliases.length
    || value.source !== 'model' && value.source !== 'user' && value.source !== 'web'
    || value.evidence !== undefined && !facetText(value.evidence, 160)
    || value.references !== undefined && (!Array.isArray(value.references) || value.references.length > 3)
    || value.source === 'web' && (!Array.isArray(value.references) || value.references.length === 0)) return null
  const references: { readonly url: string; readonly title: string }[] = []
  for (const reference of Array.isArray(value.references) ? value.references : []) {
    if (!isRecord(reference) || !referenceUrl(reference.url) || !facetText(reference.title, 120)) return null
    if (!references.some(entry => entry.url === reference.url)) references.push({ url: reference.url, title: reference.title })
  }
  return { character: value.character, aliases: [...value.aliases], source: value.source,
    ...(value.evidence === undefined ? {} : { evidence: value.evidence }), ...(value.references === undefined ? {} : { references }) }
}
export function parseStickerLibraryFacets(value: unknown): StickerLibraryFacets | null {
  if (!isRecord(value) || !facetLabels(value.emotions, 4) || !facetLabels(value.actions, 4) || !facetLabels(value.intents, 4)
    || !facetLabels(value.scenes, 3) || !facetText(value.visibleText, 160, true)) return null
  return { emotions: [...value.emotions], actions: [...value.actions], intents: [...value.intents], scenes: [...value.scenes], visibleText: value.visibleText }
}
export function parseStickerLibraryVisualFeatures(value: unknown): StickerLibraryVisualFeatures | null {
  if (!isRecord(value) || !facetLabels(value.colors, 8) || !facetLabels(value.styles, 4) || !facetLabels(value.entities, 8)) return null
  return { colors: [...value.colors], styles: [...value.styles], entities: [...value.entities] }
}
export interface StickerLibraryItem {
  readonly id: string
  readonly revision: number
  readonly name: string
  readonly description: string
  readonly tags: readonly string[]
  readonly avoid: string
  readonly facets?: StickerLibraryFacets
  readonly identity?: StickerLibraryIdentity
  readonly visual?: StickerLibraryVisualFeatures
  readonly dimensions?: StickerImageDimensions
  readonly storage: 'account' | 'extra'
  readonly state: 'ready' | 'unknown'
  readonly canDelete: boolean
  readonly createdAt: number
}
export interface StickerLibrarySnapshot {
  readonly schema: 1
  readonly accountCollection: 'confirmed' | 'unavailable'
  readonly capacity: { readonly count: number; readonly nearFullAt: number; readonly capacityKnown: false }
  readonly items: readonly StickerLibraryItem[]
  readonly limited: boolean
  readonly pending: number
}
export function parseStickerLibrarySnapshot(value: unknown): StickerLibrarySnapshot | null {
  if (!isRecord(value) || value.schema !== 1 || !['confirmed', 'unavailable'].includes(String(value.accountCollection))
    || !isRecord(value.capacity) || !Number.isSafeInteger(value.capacity.count) || Number(value.capacity.count) < 0
    || !Number.isSafeInteger(value.capacity.nearFullAt) || Number(value.capacity.nearFullAt) < 1 || Number(value.capacity.nearFullAt) > 10000 || value.capacity.capacityKnown !== false
    || typeof value.limited !== 'boolean' || !Number.isSafeInteger(value.pending) || Number(value.pending) < 0
    || !Array.isArray(value.items) || value.items.length > 7000) return null
  const items: StickerLibraryItem[] = []
  for (const item of value.items) {
    const facets = isRecord(item) && item.facets !== undefined ? parseStickerLibraryFacets(item.facets) : undefined
    const identity = isRecord(item) && item.identity !== undefined ? parseStickerLibraryIdentity(item.identity) : undefined
    const visual = isRecord(item) && item.visual !== undefined ? parseStickerLibraryVisualFeatures(item.visual) : undefined
    const dimensions = isRecord(item) && item.dimensions !== undefined ? parseStickerImageDimensions(item.dimensions) : undefined
    if (!isRecord(item) || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id) || !Number.isSafeInteger(item.revision)
      || Number(item.revision) < 1 || typeof item.name !== 'string' || item.name.length > 255
      || typeof item.description !== 'string' || item.description.length > 240 || typeof item.avoid !== 'string' || item.avoid.length > 128
      || !Array.isArray(item.tags) || item.tags.length > 12 || !item.tags.every(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 24)
      || new Set(item.tags).size !== item.tags.length
      || item.storage !== 'account' && item.storage !== 'extra' || item.state !== 'ready' && item.state !== 'unknown'
      || typeof item.canDelete !== 'boolean' || item.state === 'unknown' && item.canDelete
      || typeof item.createdAt !== 'number' || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0
      || facets === null || identity === null || visual === null || dimensions === null) return null
    items.push({ id: item.id, revision: Number(item.revision), name: item.name, description: item.description, tags: item.tags as string[],
      avoid: item.avoid, ...(facets ? { facets } : {}), ...(identity ? { identity } : {}), ...(visual ? { visual } : {}),
      ...(dimensions ? { dimensions } : {}),
      storage: item.storage, state: item.state, canDelete: item.canDelete, createdAt: item.createdAt })
  }
  if (new Set(items.map(item => item.id)).size !== items.length) return null
  return { schema: 1, accountCollection: value.accountCollection as StickerLibrarySnapshot['accountCollection'],
    capacity: { count: Number(value.capacity.count), nearFullAt: Number(value.capacity.nearFullAt), capacityKnown: false },
    items, limited: value.limited, pending: Number(value.pending) }
}

export interface StickerLibraryThumbnail { readonly image: string; readonly width?: number; readonly height?: number }
export function parseStickerLibraryThumbnail(value: unknown): StickerLibraryThumbnail | null {
  if (!isRecord(value) || typeof value.image !== 'string' || value.image.length > 200_000
    || !/^data:image\/jpeg;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.image)
    || value.image.length <= 'data:image/jpeg;base64,'.length) return null
  const dimensions = value.width === undefined && value.height === undefined ? undefined : parseStickerImageDimensions({ width: value.width, height: value.height })
  if (dimensions === null) return null
  return { image: value.image, ...(dimensions ?? {}) }
}

export interface StickerLibraryDeleteResult {
  readonly status: 'confirmed' | 'rejected' | 'unknown'
  readonly retry: false
}
export interface StickerLibraryIdentityUpdate {
  readonly id: string
  readonly revision: number
  readonly identity: { readonly character: string; readonly aliases: readonly string[] }
}
export function parseStickerLibraryIdentityUpdate(value: unknown): StickerLibraryIdentityUpdate | null {
  if (!isRecord(value) || Object.keys(value).length !== 3 || !Object.keys(value).every(key => ['id', 'revision', 'identity'].includes(key))
    || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || !isRecord(value.identity) || Object.keys(value.identity).length !== 2
    || !Object.keys(value.identity).every(key => ['character', 'aliases'].includes(key))
    || typeof value.identity.character !== 'string' || !facetText(value.identity.character.trim(), 64)
    || /[\u202a-\u202e\u2066-\u2069]/.test(value.identity.character) || !characterKey(value.identity.character)
    || !Array.isArray(value.identity.aliases) || value.identity.aliases.length > 8) return null
  const character = value.identity.character.trim(), aliases = new Map<string, string>()
  for (const alias of value.identity.aliases) {
    if (typeof alias !== 'string' || !facetText(alias.trim(), 64) || /[\u202a-\u202e\u2066-\u2069]/.test(alias) || !characterKey(alias)) return null
    const key = characterKey(alias)
    if (key !== characterKey(character) && !aliases.has(key)) aliases.set(key, alias.trim())
  }
  return { id: value.id, revision: Number(value.revision), identity: { character, aliases: [...aliases.values()] } }
}
export interface StickerLibraryIdentityUpdateResult {
  readonly status: 'confirmed'
  readonly id: string
  readonly revision: number
  readonly identity: StickerLibraryIdentity
}
export function parseStickerLibraryIdentityUpdateResult(value: unknown): StickerLibraryIdentityUpdateResult | null {
  if (!isRecord(value) || value.status !== 'confirmed' || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return null
  const identity = parseStickerLibraryIdentity(value.identity)
  if (!identity || identity.source !== 'user') return null
  return { status: 'confirmed', id: value.id, revision: Number(value.revision), identity }
}
export function parseStickerLibraryDeleteResult(value: unknown): StickerLibraryDeleteResult | null {
  if (!isRecord(value) || value.status !== 'confirmed' && value.status !== 'rejected' && value.status !== 'unknown'
    || value.retry !== undefined && value.retry !== false) return null
  return { status: value.status, retry: false }
}
