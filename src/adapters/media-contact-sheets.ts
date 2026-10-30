import sharp, { type Sharp } from 'sharp'
import { assert, FrameworkError } from '../core/values.ts'
import { FRAMEWORK_MEDIA_SHEET_BYTES, type FrameworkFrameGrid } from '../contracts/framework-media.ts'

export interface ObservedSheet { readonly timeSeconds: number; readonly mediaType: 'image/jpeg'; readonly data: Uint8Array; readonly grid: FrameworkFrameGrid }
/** Work on at most one four-frame canvas. The decoder retains responsibility for source limits. */
async function encode(make: () => Sharp, width: number, height: number, times: readonly number[], signal: AbortSignal): Promise<ObservedSheet> {
  assert(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width >= 4 && height >= 4
    && width <= 1920 && height <= 1920 && width % 2 === 0 && height % 2 === 0
    && times.length > 0 && times.length <= 4 && times.every((time, index) => Number.isFinite(time) && time >= 0
      && (index === 0 || time > times[index - 1]!)), 'MEDIA_SHEET_INVALID', 'A bounded chronological four-frame sheet is required.')
  for (const quality of [82, 72, 62, 52]) {
    signal.throwIfAborted()
    const pipeline = make().jpeg({ quality }).timeout({ seconds: 5 })
    let abort: (() => void) | undefined
    try {
      signal.throwIfAborted()
      const data = await new Promise<Buffer>((accept, reject) => {
        abort = () => { pipeline.destroy(); reject(signal.reason) }
        signal.addEventListener('abort', abort, { once: true })
        pipeline.toBuffer().then(accept, reject)
        if (signal.aborted) abort()
      })
      signal.throwIfAborted()
      if (data.length <= FRAMEWORK_MEDIA_SHEET_BYTES) return { timeSeconds: times[0]!, mediaType: 'image/jpeg', data,
        grid: { columns: 2, rows: 2, width, height, times: [...times] } }
    } finally { if (abort) signal.removeEventListener('abort', abort); pipeline.destroy() }
  }
  throw new FrameworkError('MEDIA_SHEET_BUDGET_EXCEEDED', 'The four-frame sheet exceeds its encoded byte budget.')
}

/** Finish an FFmpeg-composed sheet. Spatial positions are described alongside its true timestamps. */
export async function compactContactSheet(bytes: Buffer, times: readonly number[], signal: AbortSignal): Promise<ObservedSheet> {
  signal.throwIfAborted()
  assert(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, 'MEDIA_SHEET_INVALID', 'The encoded sheet exceeds its input limit.')
  const reader = sharp(bytes, { limitInputPixels: 1920 * 1920, failOn: 'error' }).timeout({ seconds: 3 })
  try {
    const metadata = await reader.metadata()
    signal.throwIfAborted()
    return await encode(() => sharp(bytes, { limitInputPixels: 1920 * 1920, failOn: 'error' }), metadata.width ?? 0, metadata.height ?? 0, times, signal)
  } finally { reader.destroy() }
}

/** GIF tiles are already downscaled RGB pixels; do not retain a full animation or all 24 source frames. */
export function composeContactSheet(tiles: readonly { readonly data: Buffer; readonly timeSeconds: number }[], tileWidth: number, tileHeight: number,
  signal: AbortSignal): Promise<ObservedSheet> {
  assert(Number.isSafeInteger(tileWidth) && Number.isSafeInteger(tileHeight) && tileWidth >= 2 && tileWidth <= 960 && tileHeight >= 2 && tileHeight <= 960
    && tiles.length > 0 && tiles.length <= 4 && tiles.every(tile => tile.data.length === tileWidth * tileHeight * 3),
  'MEDIA_SHEET_INVALID', 'Four bounded RGB tiles are required.')
  return encode(() => sharp({ create: { width: tileWidth * 2, height: tileHeight * 2, channels: 3, background: '#181818' } })
    .composite(tiles.map((tile, index) => ({ input: tile.data, raw: { width: tileWidth, height: tileHeight, channels: 3 as const },
      left: index % 2 * tileWidth, top: Math.floor(index / 2) * tileHeight }))), tileWidth * 2, tileHeight * 2, tiles.map(tile => tile.timeSeconds), signal)
}

export function halfFrameSize(width: number, height: number): { width: number; height: number } {
  const ratio = Math.min(0.5, 960 / width, 960 / height)
  return { width: Math.max(2, Math.floor(width * ratio)), height: Math.max(2, Math.floor(height * ratio)) }
}
