import type { StickerLibraryThumbnail } from '../contracts/sticker-library.ts'
import { assert, FrameworkError } from '../core/values.ts'
import { withDeadline } from './deadlines.ts'

interface Job {
  readonly id: string; readonly version: string; readonly controller: AbortController
  readonly load: (signal: AbortSignal) => Promise<StickerLibraryThumbnail>
  readonly result: Promise<StickerLibraryThumbnail>
  readonly resolve: (value: StickerLibraryThumbnail) => void; readonly reject: (error: unknown) => void
  consumers: number; timer?: ReturnType<typeof setTimeout>
}
/** One account's bounded LRU and single-flight queue; aborted work retains its raw concurrency slot until settled. */
export function createStickerThumbnailCache() {
  const cache = new Map<string, { readonly version: string; readonly value: StickerLibraryThumbnail; readonly bytes: number }>()
  const pending = new Map<string, Job>(), queue: Job[] = [], raw = new Set<Promise<void>>()
  let usedBytes = 0, running = 0, closed = false
  function evict(id: string) { const prior = cache.get(id); if (prior) { usedBytes -= prior.bytes; cache.delete(id) } }
  function cancel(job: Job) {
    clearTimeout(job.timer)
    job.controller.abort(new FrameworkError('STICKER_PREVIEW_CANCELLED', 'The preview is no longer active.'))
    job.reject(job.controller.signal.reason)
    if (pending.get(job.id) === job) pending.delete(job.id)
    const index = queue.indexOf(job); if (index !== -1) queue.splice(index, 1)
  }
  function pump() {
    while (!closed && running < 3 && queue.length) {
      const job = queue.shift()!
      if (job.controller.signal.aborted) continue
      running++
      const operation = Promise.resolve().then(() => {
        job.controller.signal.throwIfAborted()
        return job.load(job.controller.signal)
      }).then(value => {
        job.controller.signal.throwIfAborted()
        if (closed || pending.get(job.id) !== job) return
        const bytes = Buffer.byteLength(value.image)
        assert(bytes <= 200_000, 'STICKER_PREVIEW_TOO_LARGE', 'The preview exceeds its byte limit.')
        evict(job.id)
        while (cache.size >= 128 || usedBytes + bytes > 8 * 1024 * 1024) evict(cache.keys().next().value!)
        cache.set(job.id, { version: job.version, value, bytes }); usedBytes += bytes
        job.resolve(value)
      }).catch(error => { job.reject(error) }).finally(() => {
        clearTimeout(job.timer)
        running--; if (pending.get(job.id) === job) pending.delete(job.id)
        raw.delete(operation); pump()
      })
      raw.add(operation)
    }
  }
  return Object.freeze({
    async get(id: string, version: string, load: Job['load'], signal: AbortSignal): Promise<StickerLibraryThumbnail> {
      signal.throwIfAborted()
      assert(!closed, 'STICKER_PREVIEW_UNAVAILABLE', 'The preview service stopped.')
      const cached = cache.get(id)
      if (cached?.version === version) { cache.delete(id); cache.set(id, cached); return cached.value }
      if (cached) evict(id)
      let job = pending.get(id)
      if (job && job.version !== version) { cancel(job); job = undefined }
      if (!job) {
        assert(queue.length + running < 32, 'STICKER_PREVIEW_BUSY', 'The preview queue is full.')
        let resolve!: Job['resolve'], reject!: Job['reject']
        const result = new Promise<StickerLibraryThumbnail>((yes, no) => { resolve = yes; reject = no })
        job = { id, version, controller: new AbortController(), load, result, resolve, reject, consumers: 0 }
        const timed = job
        job.timer = setTimeout(() => cancel(timed), 20_000)
        pending.set(id, job); queue.push(job)
      }
      assert(job.consumers < 32, 'STICKER_PREVIEW_BUSY', 'Too many requests await this preview.')
      const current = job; current.consumers++; pump()
      try {
        return await withDeadline({ signal, timeoutMs: 20_000, code: 'STICKER_PREVIEW_TIMEOUT', run: () => current.result })
      } finally { if (--current.consumers === 0 && pending.get(id) === current) cancel(current) }
    },
    invalidate(id: string): void { evict(id); const job = pending.get(id); if (job) cancel(job) },
    pending: () => running + queue.length,
    async close(): Promise<void> {
      closed = true; for (const job of [...pending.values()]) cancel(job)
      cache.clear(); usedBytes = 0; await Promise.allSettled([...raw])
    },
  })
}
