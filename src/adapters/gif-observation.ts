import sharp from 'sharp'

export type GifObservation = {
  readonly status: 'animated'
  readonly durationSeconds: number
  readonly frameCount: number
  /** Zero means infinite looping; otherwise this is the decoder's actual loop count. */
  readonly loopCount: number
  readonly frames: readonly { readonly timeSeconds: number; readonly mediaType: 'image/jpeg'; readonly data: Uint8Array }[]
} | { readonly status: 'static' } | { readonly status: 'rejected'; readonly code: string }

const maxInputBytes = 8 * 1024 * 1024
const maxFrameBytes = 60 * 1024
const maxSourceFramePixels = 16_000_000
const maxSourcePixels = 64_000_000
const rejected = (code: string): GifObservation => ({ status: 'rejected', code })

/** Observe existing GIF bytes locally. libvips owns frame disposal and canvas compositing. */
export async function observeGif(input: { readonly data: Uint8Array; readonly signal: AbortSignal }): Promise<GifObservation> {
  if (input.signal.aborted) return rejected('gif_aborted')
  if (!(input.data instanceof Uint8Array) || input.data.buffer instanceof SharedArrayBuffer
    || input.data.byteLength < 13 || input.data.byteLength > maxInputBytes) return rejected('gif_input_limit')
  const source = Buffer.from(input.data)
  if (!['GIF87a', 'GIF89a'].includes(source.toString('ascii', 0, 6))) return rejected('gif_unsupported_format')
  // This wall deadline includes time waiting for a libuv/libvips worker, not only native processing.
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(9000)])
  async function run<Value>(pipeline: ReturnType<typeof sharp>, operation: Promise<Value>): Promise<Value> {
    let abort: (() => void) | undefined
    try {
      return await new Promise<Value>((accept, reject) => {
        abort = () => { pipeline.destroy(); reject(new Error('gif_cancelled')) }
        signal.addEventListener('abort', abort, { once: true })
        operation.then(value => { if (signal.aborted) abort?.(); else accept(value) }, reject)
        if (signal.aborted) abort()
      })
    } finally { if (abort) signal.removeEventListener('abort', abort); pipeline.destroy() }
  }
  try {
    const probe = sharp(source, { pages: 1, limitInputPixels: maxSourceFramePixels, failOn: 'error' }).timeout({ seconds: 3 })
    const metadata = await run(probe, probe.metadata())
    if (metadata.format !== 'gif') return rejected('gif_unsupported_format')
    const count = metadata.pages
    const width = metadata.width
    const height = metadata.pageHeight ?? metadata.height
    if (!Number.isSafeInteger(count) || !count || count < 1 || count > 256
      || !width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width * height > maxSourceFramePixels || width * height * count > maxSourcePixels) return rejected('gif_source_limit')
    if (count === 1) return { status: 'static' }
    const delays = metadata.delay
    if (!Array.isArray(delays) || delays.length !== count
      || !delays.every(value => Number.isSafeInteger(value) && value > 0 && value <= 655350)) return rejected('gif_timing_unavailable')
    const loop = metadata.loop
    if (!Number.isSafeInteger(loop) || loop === undefined || loop < 0 || loop > 65535) return rejected('gif_loop_unavailable')
    const starts: number[] = []
    let milliseconds = 0
    for (const delay of delays) { starts.push(milliseconds); milliseconds += delay }
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 600000) return rejected('gif_duration_limit')
    // Sample the actual time axis. Repeated targets on a long-held frame become one observation.
    const selections: number[] = []
    const sampleCount = Math.min(6, count)
    for (let sample = 0; sample < sampleCount; sample++) {
      const target = Math.min(milliseconds - 1, milliseconds * sample / (sampleCount - 1))
      let page = 0
      while (page + 1 < count && starts[page + 1] <= target) page++
      if (!selections.includes(page)) selections.push(page)
    }
    const frames: { timeSeconds: number; mediaType: 'image/jpeg'; data: Uint8Array }[] = []
    let outputBytes = 0
    for (const page of selections) {
      if (signal.aborted) throw new Error('gif_cancelled')
      let compact: Buffer | undefined
      for (const [edge, quality] of [[960, 72], [768, 52], [640, 35]] as const) {
        if (signal.aborted) throw new Error('gif_cancelled')
        // Selecting a source page lets the GIF loader apply all preceding disposal/composite operations.
        const pipeline = sharp(source, { page, pages: 1, limitInputPixels: maxSourceFramePixels, failOn: 'error' })
          .timeout({ seconds: 3 }).resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' }).jpeg({ quality })
        const encoded = await run(pipeline, pipeline.toBuffer())
        if (encoded.byteLength <= maxFrameBytes) { compact = encoded; break }
      }
      if (!compact || compact.byteLength === 0) return rejected('gif_frame_budget_exceeded')
      outputBytes += compact.byteLength
      if (outputBytes > 360 * 1024) return rejected('gif_frame_budget_exceeded')
      frames.push({ timeSeconds: starts[page] / 1000, mediaType: 'image/jpeg', data: compact })
    }
    if (signal.aborted) throw new Error('gif_cancelled')
    return { status: 'animated', durationSeconds: milliseconds / 1000, frameCount: count, loopCount: loop, frames }
  } catch (error) {
    if (input.signal.aborted) return rejected('gif_aborted')
    if (signal.aborted) return rejected('gif_processing_timeout')
    const message = error instanceof Error ? error.message : ''
    return rejected(/pixel limit/i.test(message) ? 'gif_source_limit' : /timeout/i.test(message) ? 'gif_processing_timeout' : 'gif_decode_failed')
  }
}
