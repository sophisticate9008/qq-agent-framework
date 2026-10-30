import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdtemp, open, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { compactContactSheet } from './media-contact-sheets.ts'
import type { NativeVideoObservation, NativeVideoObserver } from '../contracts/native-media.ts'
import { assert, FrameworkError, isRecord } from '../core/values.ts'
import { ensurePrivateDirectory } from '../storage/private-json.ts'

export type { NativeVideoObservation, NativeVideoObserver } from '../contracts/native-media.ts'
const inputBytes = 64 * 1024 * 1024
const frameBytes = 60 * 1024
const demuxers = 'mov,matroska,webm'
function failure(code: string): never { throw new FrameworkError(code, 'The video could not be observed within the configured limits.') }
function numeric(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const number = Number(value)
  return String(value).trim() !== '' && Number.isFinite(number) ? number : null
}
function container(data: Uint8Array): 'mov' | 'matroska' {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.length >= 12 && bytes.readUInt32BE(0) === 0x1a45dfa3) return 'matroska'
  if (bytes.length >= 12 && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(bytes.toString('ascii', 4, 8))) return 'mov'
  return failure('VIDEO_UNSUPPORTED_CONTAINER')
}
async function binary(name: 'ffmpeg' | 'ffprobe', configured?: string): Promise<string> {
  const candidates = configured === undefined ? [join('/usr/bin', name), join('/usr/local/bin', name),
    ...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(directory => join(directory, name))] : [configured]
  for (const candidate of [...new Set(candidates)]) {
    if (!isAbsolute(candidate)) continue
    try {
      const actual = await realpath(candidate)
      if (['/tmp', '/var/tmp', '/dev/shm'].some(directory => actual === directory || actual.startsWith(`${directory}${sep}`))) continue
      const info = await lstat(actual)
      if (!info.isFile() || (info.mode & 0o022) !== 0) continue
      await access(actual, constants.X_OK)
      return actual
    } catch { /* Another stable installation may be available. */ }
  }
  return failure('VIDEO_DEPENDENCY_UNAVAILABLE')
}
function command(executable: string, args: readonly string[], signal: AbortSignal, maxBuffer: number) {
  signal.throwIfAborted()
  return new Promise<{ stdout: Buffer; stderr: Buffer }>((accept, reject) => {
    execFile(executable, [...args], { encoding: 'buffer', signal, killSignal: 'SIGKILL', timeout: 30_000, maxBuffer,
      windowsHide: true, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', AV_LOG_FORCE_NOCOLOR: '1' } },
    (error, stdout, stderr) => {
      if (error) { reject(new FrameworkError('VIDEO_DECODE_FAILED', 'The local decoder did not return a complete result.')); return }
      accept({ stdout, stderr })
    })
  })
}
async function compactFrame(bytes: Buffer, signal: AbortSignal): Promise<Uint8Array> {
  assert(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024, 'VIDEO_FRAME_INVALID', 'A bounded decoded frame is required.')
  for (const [edge, quality] of [[960, 72], [768, 52], [640, 35]] as const) {
    signal.throwIfAborted()
    const pipeline = sharp(bytes, { limitInputPixels: 960 * 960, failOn: 'error' }).timeout({ seconds: 2 })
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality })
    let abort: (() => void) | undefined
    try {
      const data = await new Promise<Buffer>((accept, reject) => {
        abort = () => { pipeline.destroy(); reject(signal.reason) }
        signal.addEventListener('abort', abort, { once: true })
        pipeline.toBuffer().then(accept, reject)
        if (signal.aborted) abort()
      })
      if (data.length <= frameBytes) return data
    } finally { if (abort) signal.removeEventListener('abort', abort); pipeline.destroy() }
  }
  return failure('VIDEO_FRAME_BUDGET_EXCEEDED')
}

/** Observe registered bytes locally. No URL, arbitrary path, shell or model-supplied option is accepted. */
export function createFfmpegVideoObserver(options: {
  readonly directory: string; readonly ffmpegPath?: string; readonly ffprobePath?: string
}): NativeVideoObserver {
  assert(isAbsolute(options.directory), 'VIDEO_DIRECTORY_INVALID', 'A stable runtime directory is required.')
  const directory = join(resolve(options.directory), 'video-observation')
  let pending = false
  return Object.freeze<NativeVideoObserver>({ async observe(request): Promise<NativeVideoObservation> {
    request.signal.throwIfAborted()
    assert(!pending, 'VIDEO_OBSERVATION_BACKPRESSURE', 'Another video is being observed.')
    assert(request.data instanceof Uint8Array && !(request.data.buffer instanceof SharedArrayBuffer)
      && request.data.byteLength > 0 && request.data.byteLength <= inputBytes,
    'VIDEO_INPUT_LIMIT', 'A video of at most 64 MiB is required.')
    const format = container(request.data)
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.version === 'v2' ? 30_000 : 20_000)])
    pending = true
    let temporary: string | undefined
    try {
      const [ffmpeg, ffprobe] = await Promise.all([binary('ffmpeg', options.ffmpegPath), binary('ffprobe', options.ffprobePath)])
      await ensurePrivateDirectory(directory)
      assert(await realpath(directory) === directory, 'VIDEO_DIRECTORY_INVALID', 'A canonical private runtime directory is required.')
      const entries = await readdir(directory)
      assert(entries.length <= 64, 'VIDEO_OBSERVATION_BACKPRESSURE', 'The private video workspace is full.')
      for (const name of entries) if (/^clip-[A-Za-z0-9]{6}$/.test(name)) {
        const path = join(directory, name); const info = await lstat(path)
        if (info.isDirectory() && !info.isSymbolicLink() && info.mtimeMs < Date.now() - 10 * 60_000)
          await rm(path, { recursive: true, force: true })
      }
      signal.throwIfAborted()
      temporary = await mkdtemp(join(directory, 'clip-'))
      const filename = join(temporary, 'input.video')
      const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(request.data) } finally { await file.close() }
      // Explicit demuxers exclude playlists. MOV data references and absolute external references remain disabled.
      const input = ['-protocol_whitelist', 'file', '-format_whitelist', demuxers, '-f', format,
        ...(format === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []), '-i', filename]
      const probe = await command(ffprobe, ['-v', 'error', '-max_alloc', '33554432', '-probesize', '8388608',
        '-analyzeduration', '5000000', ...input, '-show_entries',
        'format=duration,start_time:stream=index,codec_type,width,height,duration,start_time:stream_disposition=attached_pic', '-of', 'json'], signal, 64 * 1024)
      const metadata: unknown = JSON.parse(probe.stdout.toString('utf8'))
      assert(isRecord(metadata) && Array.isArray(metadata.streams) && metadata.streams.length <= 64 && isRecord(metadata.format),
        'VIDEO_PROBE_INVALID', 'The video metadata is unavailable.')
      const stream = metadata.streams.find((item: unknown) => isRecord(item) && item.codec_type === 'video'
        && (!isRecord(item.disposition) || item.disposition.attached_pic !== 1)) as unknown
      assert(isRecord(stream) && typeof stream.index === 'number' && Number.isSafeInteger(stream.index) && stream.index >= 0,
        'VIDEO_STREAM_UNAVAILABLE', 'The input has no decodable video stream.')
      assert(typeof stream.width === 'number' && typeof stream.height === 'number' && Number.isSafeInteger(stream.width)
        && Number.isSafeInteger(stream.height) && stream.width > 0 && stream.height > 0 && stream.width <= 8192
        && stream.height <= 8192 && stream.width * stream.height <= 16_777_216,
      'VIDEO_DIMENSION_LIMIT', 'The video dimensions exceed the observation limit.')
      const duration = numeric(stream.duration) ?? numeric(metadata.format.duration)
      const start = numeric(stream.start_time) ?? numeric(metadata.format.start_time) ?? 0
      assert(duration !== null && duration > 0 && duration <= 600 && Math.abs(start) <= 86_400,
        'VIDEO_DURATION_LIMIT', 'A video duration of at most ten minutes must be verifiable.')
      if (request.version === 'v2') {
        // One decoder and one bounded 2x2 tile buffer; never retain 24 full-resolution frames in Node.
        const end = Math.max(0, duration - Math.min(0.1, duration / 20))
        const step = end / 23
        const output = join(temporary, 'sheet-%02d.jpg')
        const result = await command(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'info', '-max_alloc', '33554432',
          '-threads', '1', '-filter_threads', '1', '-copyts', ...input, '-map', `0:${stream.index}`, '-an', '-sn', '-dn',
          '-vf', `select=gte(t-(${start})\\,selected_n*${step.toFixed(9)}),trim=end_frame=24,` +
            // Account for non-square pixels, cap the displayed frame before halving both dimensions.
            "scale=w='max(2,trunc(iw*sar*min(0.5,min(960/(iw*sar),960/ih))/2)*2)':h='max(2,trunc(ih*min(0.5,min(960/(iw*sar),960/ih))/2)*2)'," +
            'setsar=1,showinfo=checksum=0,tile=layout=2x2:nb_frames=4:color=0x181818',
          '-frames:v', '6', '-fps_mode', 'passthrough', '-threads', '1', '-c:v', 'mjpeg', '-q:v', '4', '-start_number', '0', output], signal, 128 * 1024)
        const times: number[] = []
        for (const match of result.stderr.toString('utf8').matchAll(/\bn:\s*(\d+)\b[^\r\n]*?\bpts_time:([+\-.\deE]+)/g)) {
          const pts = numeric(match[2])
          assert(Number(match[1]) === times.length && pts !== null && pts - start >= -0.001 && pts - start <= duration + 0.1,
            'VIDEO_FRAME_TIMESTAMP_UNAVAILABLE', 'The sampled frame needs a genuine presentation timestamp.')
          const time = Math.max(0, pts - start)
          assert(times.length < 24 && (times.length === 0 || time > times[times.length - 1]!),
            'VIDEO_FRAME_TIMESTAMP_UNAVAILABLE', 'The sampled frames must advance in time.')
          times.push(time)
        }
        assert(times.length > 0, 'VIDEO_FRAME_TIMESTAMP_UNAVAILABLE', 'No sampled frame was decoded.')
        const frames: NativeVideoObservation['frames'][number][] = []
        const files = (await readdir(temporary)).filter(name => /^sheet-\d{2}\.jpg$/.test(name)).sort()
        assert(files.length === Math.ceil(times.length / 4), 'VIDEO_FRAME_INVALID', 'Sheet count must match the actual sampled frames.')
        for (const [index, name] of files.entries()) {
          signal.throwIfAborted()
          const path = join(temporary, name); const info = await lstat(path)
          assert(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024,
            'VIDEO_FRAME_INVALID', 'A bounded local sheet is required.')
          frames.push(await compactContactSheet(await readFile(path), times.slice(index * 4, index * 4 + 4), signal))
        }
        return { durationSeconds: duration, frames, audioObserved: false,
          hasAudio: metadata.streams.some((item: unknown) => isRecord(item) && item.codec_type === 'audio') }
      }
      const frames: { timeSeconds: number; data: Uint8Array; mediaType: 'image/jpeg' }[] = []
      const end = Math.max(0, duration - Math.min(0.1, duration / 20))
      for (let index = 0; index < 6; index++) {
        signal.throwIfAborted()
        const seek = end * index / 5
        const result = await command(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'info', '-max_alloc', '33554432',
          '-threads', '1', '-filter_threads', '1', '-copyts', '-ss', seek.toFixed(6), ...input,
          '-map', `0:${stream.index}`, '-an', '-sn', '-dn', '-vf',
          'scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,showinfo',
          '-frames:v', '1', '-fps_mode', 'passthrough', '-threads', '1', '-c:v', 'mjpeg', '-q:v', '10', '-f', 'image2pipe', 'pipe:1'], signal, 2 * 1024 * 1024)
        const actual = /\bn:\s*0\b[^\r\n]*?\bpts_time:([+\-.\deE]+)/.exec(result.stderr.toString('utf8'))
        // A sparse/VFR tail can end normally before this sample point. Retain earlier genuine frames.
        if (result.stdout.length === 0 && actual === null) continue
        const pts = actual ? numeric(actual[1]) : null
        assert(pts !== null && pts - start >= -0.001 && pts - start <= duration + 0.1,
          'VIDEO_FRAME_TIMESTAMP_UNAVAILABLE', 'The decoded frame needs a genuine presentation timestamp.')
        const timeSeconds = Math.max(0, pts - start)
        if (frames.some(frame => Math.abs(frame.timeSeconds - timeSeconds) < 0.000001)) continue
        const data = await compactFrame(result.stdout, signal)
        frames.push({ timeSeconds, data, mediaType: 'image/jpeg' })
      }
      signal.throwIfAborted()
      assert(frames.length > 0 && frames.length <= 6 && frames.reduce((sum, frame) => sum + frame.data.byteLength, 0) <= 360 * 1024,
        'VIDEO_FRAME_BUDGET_EXCEEDED', 'The sampled frames exceed their aggregate byte limit.')
      return { durationSeconds: duration, frames, audioObserved: false,
        hasAudio: metadata.streams.some((item: unknown) => isRecord(item) && item.codec_type === 'audio') }
    } catch (error) {
      if (signal.aborted) return failure(request.signal.aborted ? 'VIDEO_OBSERVATION_CANCELLED' : 'VIDEO_OBSERVATION_TIMEOUT')
      if (error instanceof FrameworkError) throw error
      return failure('VIDEO_OBSERVATION_FAILED')
    } finally {
      try { if (temporary) await rm(temporary, { recursive: true, force: true }) } finally { pending = false }
    }
  } })
}
