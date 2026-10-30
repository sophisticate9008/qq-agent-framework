import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { observeGif } from '../src/adapters/gif-observation.ts'
import { composeContactSheet } from '../src/adapters/media-contact-sheets.ts'
import { createFfmpegVideoObserver } from '../src/adapters/ffmpeg-video.ts'
import { FRAMEWORK_MEDIA_PROTOCOL, parseNativeMediaReadEnvelope } from '../src/contracts/framework-media.ts'

const signal = new AbortController().signal

test('four-frame sheets retain chronological cell positions and leave unused cells blank', async () => {
  const colors = [[240, 10, 10], [10, 240, 10], [10, 10, 240]]
  const tiles = colors.map((color, index) => ({ timeSeconds: index, data: Buffer.from(Array.from({ length: 32 * 24 }, () => color).flat()) }))
  const result = await composeContactSheet(tiles, 32, 24, signal)
  assert.deepEqual(result.grid, { columns: 2, rows: 2, width: 64, height: 48, times: [0, 1, 2] })
  const { data, info } = await sharp(result.data).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  for (const [index, color] of [...colors, [24, 24, 24]].entries()) {
    const offset = ((Math.floor(index / 2) * 24 + 12) * info.width + index % 2 * 32 + 16) * info.channels
    color.forEach((value, channel) => assert(Math.abs(data[offset + channel]! - value) < 20))
  }
  await assert.rejects(composeContactSheet(tiles, 32, 24, AbortSignal.abort(new Error('cancelled'))), /cancelled/)
})

test('GIF V1 stays at six independent frames while V2 covers 24 frames with real timing and half-size tiles', async () => {
  const pages = 28, width = 64, height = 48
  const pixels = Buffer.concat(Array.from({ length: pages }, (_, page) => Buffer.from(Array.from({ length: width * height },
    () => [page * 8, 255 - page * 8, page % 2 * 255]).flat())))
  const input = await sharp(pixels, { raw: { width, height: height * pages, channels: 3, pageHeight: height } })
    .gif({ delay: Array.from({ length: pages }, () => 100), loop: 0 }).toBuffer()
  const old = await observeGif({ data: input, signal })
  assert.equal(old.status, 'animated'); if (old.status !== 'animated') return
  assert.equal(old.frames.length, 6); assert(old.frames.every(frame => !frame.grid))
  const value = await observeGif({ data: input, signal, version: 'v2' })
  assert.equal(value.status, 'animated'); if (value.status !== 'animated') return
  assert.equal(value.frames.length, 6)
  const times = value.frames.flatMap(frame => frame.grid?.times ?? [])
  assert.equal(times.length, 24); assert.equal(times[0], 0); assert.equal(times.at(-1), 2.7)
  assert(value.frames.every(frame => frame.grid?.width === width && frame.grid.height === height))
  const envelope = { schema: FRAMEWORK_MEDIA_PROTOCOL, kind: 'animation', contentRead: true, coverage: 'sampled-frames-only',
    durationSeconds: value.durationSeconds, frameCount: value.frameCount, loopCount: value.loopCount,
    frames: value.frames.map(frame => ({ ...frame, data: Buffer.from(frame.data).toString('base64') })) }
  assert(parseNativeMediaReadEnvelope(envelope))
})

test('FFmpeg V2 extracts chronological four-frame sheets in one pass and cleans its workspace', async context => {
  try { execFileSync('/usr/bin/ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('/usr/bin/ffprobe', ['-version'], { stdio: 'ignore' }) }
  catch { context.skip('Local FFmpeg/FFprobe are not installed'); return }
  const directory = await mkdtemp(join(tmpdir(), 'video-sheets-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'fixture.mkv')
  execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=12:duration=4',
    '-threads', '1', '-c:v', 'ffv1', file], { timeout: 10000, stdio: 'pipe' })
  const observer = createFfmpegVideoObserver({ directory })
  const value = await observer.observe({ data: await readFile(file), signal, version: 'v2' })
  assert.equal(value.frames.length, 6)
  const times = value.frames.flatMap(frame => frame.grid?.times ?? [])
  assert.equal(times.length, 24); assert(times.every((time, index) => !index || time > times[index - 1]!))
  assert(value.frames.every(frame => frame.grid?.width === 128 && frame.grid.height === 72))
  assert(parseNativeMediaReadEnvelope({ schema: FRAMEWORK_MEDIA_PROTOCOL, kind: 'video', contentRead: true,
    coverage: 'sampled-frames-only', ...value, frames: value.frames.map(frame => ({ ...frame, data: Buffer.from(frame.data).toString('base64') })) }))
  assert.deepEqual(await readdir(join(directory, 'video-observation')), [])
})
