import { parseStickerLibraryThumbnail, type StickerLibraryThumbnail } from '../../src/contracts/sticker-library.ts'
import type { ApiClient } from './api.ts'

const MAX_CACHE_BYTES = 8 * 1024 * 1024
const MAX_CACHE_ITEMS = 128
const MAX_PENDING = 64
const MAX_CONCURRENT = 4
const MAX_WAITERS_PER_IMAGE = 32
const accounts = new WeakMap<ApiClient, number>()
let nextAccount = 0, cacheBytes = 0, running = 0
interface CachedPreview { readonly value: StickerLibraryThumbnail | null; readonly bytes: number; readonly expiresAt: number }
interface Waiter { readonly resolve: (value: StickerLibraryThumbnail | null) => void; readonly cleanup: () => void }
interface PreviewRequest {
  readonly key: string; readonly api: ApiClient; readonly id: string; readonly controller: AbortController
  readonly waiters: Set<Waiter>; started: boolean
}
// Cache keys use an opaque client scope, never an account identifier or protocol URL.
// One global byte budget and scheduler also bound memory/network across account switches.
const cache = new Map<string, CachedPreview>()
const requests = new Map<string, PreviewRequest>()
const queue: PreviewRequest[] = []
function remember(key: string, value: StickerLibraryThumbnail | null) {
  const existing = cache.get(key)
  if (existing) { cacheBytes -= existing.bytes; cache.delete(key) }
  const bytes = (value?.image.length ?? 0) * 2 + key.length * 2 + 128
  cache.set(key, { value, bytes, expiresAt: Date.now() + (value ? 5 * 60_000 : 15_000) }); cacheBytes += bytes
  while (cacheBytes > MAX_CACHE_BYTES || cache.size > MAX_CACHE_ITEMS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cacheBytes -= cache.get(oldest)!.bytes; cache.delete(oldest)
  }
}
function finish(request: PreviewRequest, value: StickerLibraryThumbnail | null) {
  for (const waiter of request.waiters) { waiter.cleanup(); waiter.resolve(value) }
  request.waiters.clear()
}
function pump() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const request = queue.shift()!
    if (request.controller.signal.aborted || request.waiters.size === 0) continue
    request.started = true; running++
    void Promise.resolve().then(() => { request.controller.signal.throwIfAborted()
      return request.api.get(`/api/chat/stickers/preview?id=${request.id}`, request.controller.signal) })
      .then(value => {
        if (request.controller.signal.aborted) return
        const preview = parseStickerLibraryThumbnail(value)
        remember(request.key, preview); finish(request, preview)
      }).catch(() => {
        if (!request.controller.signal.aborted) { remember(request.key, null); finish(request, null) }
      }).finally(() => {
        if (requests.get(request.key) === request) requests.delete(request.key)
        running--; pump()
      })
  }
}

/** A synchronous hit reserves image dimensions without starting a request. */
export function peekStickerPreview(api: ApiClient, id: string, revision: number): StickerLibraryThumbnail | null {
  const account = accounts.get(api)
  if (account === undefined) return null
  const entry = cache.get(`${account}:${id}:${revision}`)
  return entry && entry.expiresAt > Date.now() ? entry.value : null
}

/** Explicit refresh retries failed previews while keeping successful cached images. */
export function clearFailedStickerPreviews(api: ApiClient): void {
  const account = accounts.get(api)
  if (account === undefined) return
  const prefix = `${account}:`
  for (const [key, entry] of cache) if (key.startsWith(prefix) && entry.value === null) {
    cache.delete(key); cacheBytes -= entry.bytes
  }
}

/** Shared, cancellable thumbnail reads; cancelling one consumer does not abort another. */
export function readStickerPreview(api: ApiClient, id: string, revision: number, signal: AbortSignal): Promise<StickerLibraryThumbnail | null> {
  if (signal.aborted || !/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(revision) || revision < 1) return Promise.resolve(null)
  let account = accounts.get(api)
  if (account === undefined) { account = ++nextAccount; accounts.set(api, account) }
  const key = `${account}:${id}:${revision}`, cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    if (cached.expiresAt > Date.now()) { cache.set(key, cached); return Promise.resolve(cached.value) }
    cacheBytes -= cached.bytes
  }
  let request = requests.get(key)
  if (!request) {
    if (requests.size >= MAX_PENDING) return Promise.resolve(null)
    request = { key, api, id, controller: new AbortController(), waiters: new Set(), started: false }
    requests.set(key, request); queue.push(request)
  }
  const current = request
  if (current.waiters.size >= MAX_WAITERS_PER_IMAGE) return Promise.resolve(null)
  const result = new Promise<StickerLibraryThumbnail | null>(resolve => {
    const abort = () => {
      if (!current.waiters.delete(waiter)) return
      waiter.cleanup(); resolve(null)
      if (current.waiters.size === 0) {
        current.controller.abort()
        if (requests.get(key) === current) requests.delete(key)
        if (!current.started) { const index = queue.indexOf(current); if (index !== -1) queue.splice(index, 1) }
      }
    }
    const waiter: Waiter = { resolve, cleanup: () => signal.removeEventListener('abort', abort) }
    current.waiters.add(waiter); signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  pump(); return result
}
