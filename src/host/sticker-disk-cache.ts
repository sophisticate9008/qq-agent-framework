import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord } from '../core/values.ts'
import { readPrivateBlob, writePrivateBlob } from '../storage/private-blob.ts'
import { digest } from './data.ts'
import type { DurableStore } from './types.ts'

type Kind = 'original' | 'thumbnail'
interface Cached {
  readonly file: string; readonly bytes: number; readonly sha256: string
  readonly imageId: string; readonly touchedAt: number; readonly createdAt: number
}
const limits = { original: { count: 512, bytes: 512 * 1024 * 1024, item: 8 * 1024 * 1024 },
  thumbnail: { count: 1024, bytes: 64 * 1024 * 1024, item: 256 * 1024 } } as const
const MAX_AGE = 30 * 86400_000
function cached(value: unknown, kind: Kind): Cached | null {
  if (!isRecord(value) || typeof value.file !== 'string' || !/^[a-f0-9]{64}\.blob$/.test(value.file)
    || typeof value.imageId !== 'string' || !/^[a-f0-9]{64}$/.test(value.imageId)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > limits[kind].item
    || typeof value.touchedAt !== 'number' || !Number.isFinite(value.touchedAt)
    || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return null
  return { file: value.file, bytes: Number(value.bytes), sha256: value.sha256, imageId: value.imageId,
    touchedAt: value.touchedAt, createdAt: value.createdAt }
}

/** Rebuildable account-scoped files. Cache failures never replace the authoritative collection state. */
export function createStickerDiskCache(options: { readonly directory: string; readonly accountId: string; readonly store: DurableStore }) {
  const directory = join(options.directory, 'sticker-cache', digest(options.accountId))
  const namespace = (kind: Kind) => `native-chat.sticker-disk-cache.${digest([options.accountId, kind])}`
  const key = (kind: Kind, id: string, identity: string) => digest([kind, id, identity, kind === 'thumbnail' ? 'jpeg-384-q70-v1' : 'original-v1'])
  let tail: Promise<unknown> = Promise.resolve()
  function serial<Value>(operation: () => Promise<Value>) {
    const pending = tail.catch(() => undefined).then(operation); tail = pending; return pending
  }
  function rows(kind: Kind) {
    const result: ReturnType<DurableStore['list']>[number][] = []
    let after: string | undefined
    for (;;) {
      const page = options.store.list(namespace(kind), { limit: 1000, ...(after ? { after } : {}) })
      result.push(...page)
      if (page.length < 1000) return result
      after = page.at(-1)!.key
    }
  }
  async function discard(kind: Kind, record: ReturnType<DurableStore['list']>[number]) {
    const entry = cached(record.value, kind)
    if (!options.store.delete(namespace(kind), record.key, record.revision)) return
    if (entry) await rm(join(directory, entry.file), { force: true }).catch(() => undefined)
  }
  return Object.freeze({
    async read(kind: Kind, imageId: string, identity: string, signal: AbortSignal): Promise<Buffer | null> {
      signal.throwIfAborted()
      const record = options.store.read(namespace(kind), key(kind, imageId, identity)), entry = record && cached(record.value, kind)
      if (!record || !entry) return null
      if (Date.now() - entry.createdAt >= MAX_AGE) return null
      try {
        const bytes = await readPrivateBlob(join(directory, entry.file), { ...entry, maximumBytes: limits[kind].item }, signal)
        signal.throwIfAborted()
        // Persist recency at most once an hour, independently of library/delete revisions.
        if (Date.now() - entry.touchedAt > 3600_000) {
          try { options.store.write(namespace(kind), record.key, { ...entry, touchedAt: Date.now() }, { expectedRevision: record.revision }) }
          catch { /* Cache recency is optional and never changes the image result. */ }
        }
        return bytes
      } catch {
        signal.throwIfAborted()
        await serial(async () => {
          const current = options.store.read(namespace(kind), record.key)
          if (current?.revision === record.revision) await discard(kind, current)
        }).catch(() => undefined)
        return null
      }
    },
    async write(kind: Kind, imageId: string, identity: string, bytes: Buffer, signal: AbortSignal): Promise<void> {
      if (bytes.length < 1 || bytes.length > limits[kind].item) return
      await serial(async () => {
        signal.throwIfAborted()
        const id = key(kind, imageId, identity), before = options.store.read(namespace(kind), id)
        const sha256 = createHash('sha256').update(bytes).digest('hex'), file = `${digest([id, sha256])}.blob`
        const now = Date.now(), value = { file, bytes: bytes.length, sha256, imageId, touchedAt: now, createdAt: now }
        const others = rows(kind).filter(row => row.key !== id).sort((a, b) =>
          (cached(a.value, kind)?.touchedAt ?? 0) - (cached(b.value, kind)?.touchedAt ?? 0))
        let count = others.length + 1, total = others.reduce((sum, row) => sum + (cached(row.value, kind)?.bytes ?? 0), bytes.length)
        for (const row of others) {
          const entry = cached(row.value, kind)
          if (entry && now - entry.createdAt < MAX_AGE && count <= limits[kind].count && total <= limits[kind].bytes) continue
          await discard(kind, row); count--; total -= entry?.bytes ?? 0
        }
        // Register before I/O: an interrupted write remains discoverable for bounded eviction.
        const saved = options.store.write(namespace(kind), id, value, { expectedRevision: before?.revision ?? null })
        try { await writePrivateBlob(directory, file, bytes, signal) }
        catch (error) {
          options.store.delete(namespace(kind), id, saved.revision)
          await rm(join(directory, file), { force: true }).catch(() => undefined)
          throw error
        }
        const prior = before && cached(before.value, kind)
        if (prior && prior.file !== file) await rm(join(directory, prior.file), { force: true }).catch(() => undefined)
      })
    },
    async forget(imageId: string) {
      await serial(async () => {
        for (const kind of ['original', 'thumbnail'] as const) for (const row of rows(kind))
          if (cached(row.value, kind)?.imageId === imageId) await discard(kind, row)
      })
    },
    async close() { await tail.catch(() => undefined) },
  })
}
