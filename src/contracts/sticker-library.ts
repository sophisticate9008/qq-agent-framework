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
export interface StickerLibraryItem {
  readonly id: string
  readonly revision: number
  readonly name: string
  readonly description: string
  readonly tags: readonly string[]
  readonly avoid: string
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
    if (!isRecord(item) || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id) || !Number.isSafeInteger(item.revision)
      || Number(item.revision) < 1 || typeof item.name !== 'string' || item.name.length > 255
      || typeof item.description !== 'string' || item.description.length > 240 || typeof item.avoid !== 'string' || item.avoid.length > 128
      || !Array.isArray(item.tags) || item.tags.length > 12 || !item.tags.every(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 24)
      || new Set(item.tags).size !== item.tags.length
      || item.storage !== 'account' && item.storage !== 'extra' || item.state !== 'ready' && item.state !== 'unknown'
      || typeof item.canDelete !== 'boolean' || item.state === 'unknown' && item.canDelete
      || typeof item.createdAt !== 'number' || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0) return null
    items.push({ id: item.id, revision: Number(item.revision), name: item.name, description: item.description, tags: item.tags as string[],
      avoid: item.avoid, storage: item.storage, state: item.state, canDelete: item.canDelete, createdAt: item.createdAt })
  }
  if (new Set(items.map(item => item.id)).size !== items.length) return null
  return { schema: 1, accountCollection: value.accountCollection as StickerLibrarySnapshot['accountCollection'],
    capacity: { count: Number(value.capacity.count), nearFullAt: Number(value.capacity.nearFullAt), capacityKnown: false },
    items, limited: value.limited, pending: Number(value.pending) }
}

export interface StickerLibraryThumbnail { readonly image: string }
export function parseStickerLibraryThumbnail(value: unknown): StickerLibraryThumbnail | null {
  if (!isRecord(value) || typeof value.image !== 'string' || value.image.length > 200_000
    || !/^data:image\/jpeg;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.image)
    || value.image.length <= 'data:image/jpeg;base64,'.length) return null
  return { image: value.image }
}

export interface StickerLibraryDeleteResult {
  readonly status: 'confirmed' | 'rejected' | 'unknown'
  readonly retry: false
}
export function parseStickerLibraryDeleteResult(value: unknown): StickerLibraryDeleteResult | null {
  if (!isRecord(value) || value.status !== 'confirmed' && value.status !== 'rejected' && value.status !== 'unknown'
    || value.retry !== undefined && value.retry !== false) return null
  return { status: value.status, retry: false }
}
