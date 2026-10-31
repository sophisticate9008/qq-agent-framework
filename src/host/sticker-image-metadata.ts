import sharp from 'sharp'
import { parseStickerImageDimensions, type StickerImageDimensions } from '../contracts/sticker-library.ts'
import { assert, isRecord } from '../core/values.ts'
import { digest, json } from './data.ts'
import type { DurableStore } from './types.ts'

/** Signed URL rotation does not change an image whose content hash is already known. */
export function stickerImageIdentity(item: { readonly md5: string | null; readonly url: string | null; readonly account?: { readonly url: string } | null }): string {
  return digest(item.md5?.toLowerCase() ?? item.account?.url ?? item.url)
}
export async function readStickerImageDimensions(bytes: Uint8Array, signal: AbortSignal): Promise<StickerImageDimensions> {
  signal.throwIfAborted()
  assert(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, 'STICKER_IMAGE_TOO_LARGE', 'The image exceeds the byte limit.')
  const metadata = await sharp(bytes, { pages: 1, limitInputPixels: 40_000_000 }).timeout({ seconds: 2 }).metadata()
  signal.throwIfAborted()
  const dimensions = parseStickerImageDimensions({ width: metadata.autoOrient.width, height: metadata.autoOrient.height })
  assert(dimensions, 'STICKER_IMAGE_INVALID', 'The image dimensions exceed the supported bounds.')
  return dimensions
}
/** Layout metadata has its own revision, so a preview does not invalidate a reviewed delete request. */
export function createStickerImageMetadata(store: DurableStore, accountId: string) {
  const namespace = 'native-chat.sticker-image-metadata'
  const key = (id: string) => digest([accountId, id])
  return Object.freeze({
    read(id: string, imageIdentity: string): StickerImageDimensions | null {
      const value = store.read(namespace, key(id))?.value
      return isRecord(value) && value.schema === 1 && value.accountId === accountId && value.imageId === id && value.imageIdentity === imageIdentity
        ? parseStickerImageDimensions(value.dimensions) : null
    },
    remember(id: string, imageIdentity: string, dimensions: StickerImageDimensions): void {
      const normalized = parseStickerImageDimensions(dimensions)
      assert(normalized && /^[a-f0-9]{64}$/.test(id) && /^[a-f0-9]{64}$/.test(imageIdentity), 'STICKER_IMAGE_INVALID', 'Use verified image dimensions and identity.')
      const previous = store.read(namespace, key(id))
      const value = { schema: 1, accountId, imageId: id, imageIdentity, dimensions: normalized }
      if (previous && digest(previous.value) === digest(value)) return
      store.write(namespace, key(id), json(value), { expectedRevision: previous?.revision ?? null })
    },
    forget(id: string): void {
      const previous = store.read(namespace, key(id))
      if (previous) store.delete(namespace, previous.key, previous.revision)
    },
  })
}
