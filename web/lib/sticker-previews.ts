import { parseStickerLibraryThumbnail, type StickerLibraryThumbnail } from '../../src/contracts/sticker-library.ts'
import type { ApiClient } from './api.ts'

const MAX_PENDING = 64
const MAX_CONCURRENT = 1
const MAX_WAITERS_PER_IMAGE = 32
const accounts = new WeakMap<ApiClient, number>()
let nextAccount = 0, running = 0
interface Waiter { readonly resolve: (value: StickerLibraryThumbnail | null) => void; readonly cleanup: () => void }
interface PreviewRequest {
  readonly key: string; readonly api: ApiClient; readonly id: string; readonly controller: AbortController
  readonly waiters: Set<Waiter>; started: boolean
}
// Only active work is shared. Completed Base64 data belongs to visible cards;
// persistent image reuse is provided by the server's disk cache.
const requests = new Map<string, PreviewRequest>()
const queue: PreviewRequest[] = []
async function load(request: PreviewRequest): Promise<StickerLibraryThumbnail | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    request.controller.signal.throwIfAborted()
    try {
      const value = await request.api.get(`/api/chat/stickers/preview?id=${request.id}`, request.controller.signal)
      const preview = parseStickerLibraryThumbnail(value)
      if (preview) return preview
    } catch { request.controller.signal.throwIfAborted() }
    if (attempt < 2) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(request.controller.signal.reason) }
      const timer = setTimeout(() => { request.controller.signal.removeEventListener('abort', abort); resolve() }, 750 * (attempt + 1))
      request.controller.signal.addEventListener('abort', abort, { once: true })
      if (request.controller.signal.aborted) abort()
    })
  }
  return null
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
    void load(request).then(preview => {
        if (!request.controller.signal.aborted) finish(request, preview)
      }).catch(() => {
        if (!request.controller.signal.aborted) finish(request, null)
      }).finally(() => {
        if (requests.get(request.key) === request) requests.delete(request.key)
        running--; pump()
      })
  }
}

/** Shared, cancellable thumbnail reads; cancelling one consumer does not abort another. */
export function readStickerPreview(api: ApiClient, id: string, revision: number, signal: AbortSignal): Promise<StickerLibraryThumbnail | null> {
  if (signal.aborted || !/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(revision) || revision < 1) return Promise.resolve(null)
  let account = accounts.get(api)
  if (account === undefined) { account = ++nextAccount; accounts.set(api, account) }
  const key = `${account}:${id}:${revision}`
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
