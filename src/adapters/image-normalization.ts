import sharp from 'sharp'
import type { FrameworkImageMediaType } from '../contracts/framework-media.ts'

export type NormalizedImage = { readonly status: 'confirmed'; readonly data: Uint8Array; readonly mediaType: FrameworkImageMediaType }
  | { readonly status: 'rejected'; readonly code: string }

/** Prepare bounded model input; original registered media remains unchanged. */
export async function normalizeModelImage(input: {
  readonly data: Uint8Array; readonly mediaType: FrameworkImageMediaType; readonly maxBytes: number; readonly signal: AbortSignal
}): Promise<NormalizedImage> {
  input.signal.throwIfAborted()
  if (input.data.byteLength > 8 * 1024 * 1024) return { status: 'rejected', code: 'image_download_too_large' }
  const source = Buffer.from(input.data)
  const settings = { limitInputPixels: 40_000_000, failOn: 'error' as const, pages: 1 }
  async function run<Value>(pipeline: ReturnType<typeof sharp>, operation: Promise<Value>): Promise<Value> {
    let abort: (() => void) | undefined
    try {
      const result = await new Promise<Value>((resolve, reject) => {
        abort = () => { reject(input.signal.reason); pipeline.destroy() }
        input.signal.addEventListener('abort', abort, { once: true })
        operation.then(resolve, reject)
        if (input.signal.aborted) abort()
      })
      input.signal.throwIfAborted()
      return result
    } finally { if (abort) input.signal.removeEventListener('abort', abort); pipeline.destroy() }
  }
  try {
    const probe = sharp(source, settings).timeout({ seconds: 3 })
    const metadata = await run(probe, probe.metadata())
    if (!metadata.width || !metadata.height) return { status: 'rejected', code: 'image_decode_failed' }
    if (input.data.byteLength <= input.maxBytes && Math.max(metadata.width, metadata.height) <= 4096 && (metadata.pages ?? 1) === 1)
      return { status: 'confirmed', data: input.data, mediaType: input.mediaType }
    // Keep the first attempt sharp enough for screenshots; reduce only when the wire cap requires it.
    for (const [edge, quality] of [[2048, 88], [1600, 78], [1280, 68]] as const) {
      input.signal.throwIfAborted()
      const pipeline = sharp(source, settings).timeout({ seconds: 3 }).rotate()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).jpeg({ quality, chromaSubsampling: '4:4:4' })
      const data = await run(pipeline, pipeline.toBuffer())
      if (data.byteLength <= input.maxBytes) return { status: 'confirmed', data, mediaType: 'image/jpeg' }
    }
    return { status: 'rejected', code: 'image_too_large_after_compression' }
  } catch (error) {
    input.signal.throwIfAborted()
    const message = error instanceof Error ? error.message : ''
    return { status: 'rejected', code: /pixel limit/i.test(message) ? 'image_pixel_limit' : /timeout/i.test(message) ? 'image_processing_timeout' : 'image_decode_failed' }
  }
}
