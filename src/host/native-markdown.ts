import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import type { OneBotAssetResolutionRequest } from '../adapters/onebot.ts'
import type { FrameworkEvent, MessageContent } from '../core/types.ts'
import { assert, errorCode, reference } from '../core/values.ts'
import type { MarkdownPngPage, MarkdownRenderer } from '../rendering/markdown.ts'
import { ensurePrivateDirectory } from '../storage/private-json.ts'
import { digest, json, object } from './data.ts'
import type { NativeMarkdownOutputRequest } from './native-output.ts'
import type { DurableStore } from './types.ts'

const namespace = 'native-chat.markdown-assets'
const ttlMs = 24 * 60 * 60 * 1000
const maxBytes = 8 * 1024 * 1024
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function validatePage(page: MarkdownPngPage): Buffer {
  assert(Number.isSafeInteger(page.width) && page.width > 0 && page.width <= 8192
    && Number.isSafeInteger(page.height) && page.height > 0 && page.height <= 8192 && page.width * page.height <= 16777216
    && page.png instanceof Uint8Array && !(page.png.buffer instanceof SharedArrayBuffer)
    && page.png.byteLength >= 57 && page.png.byteLength <= maxBytes, 'NATIVE_MARKDOWN_INVALID_PNG', 'A bounded PNG page is required.')
  const png = Buffer.from(page.png)
  assert(png.subarray(0, 8).equals(signature), 'NATIVE_MARKDOWN_INVALID_PNG', 'The renderer must return PNG bytes.')
  let offset = 8; let data = false
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset); const end = offset + length + 12
    assert(end <= png.length && crc32(png.subarray(offset + 4, end - 4)) === png.readUInt32BE(end - 4),
      'NATIVE_MARKDOWN_INVALID_PNG', 'The PNG chunks are invalid.')
    const type = png.toString('ascii', offset + 4, offset + 8)
    assert(/^[A-Za-z]{4}$/.test(type), 'NATIVE_MARKDOWN_INVALID_PNG', 'The PNG chunk type is invalid.')
    if (offset === 8) assert(type === 'IHDR' && length === 13 && png.readUInt32BE(16) === page.width && png.readUInt32BE(20) === page.height,
      'NATIVE_MARKDOWN_INVALID_PNG', 'The PNG dimensions changed.')
    else assert(type !== 'IHDR', 'NATIVE_MARKDOWN_INVALID_PNG', 'The PNG header cannot repeat.')
    if (type === 'IDAT' && length > 0) data = true
    if (type === 'IEND') { assert(length === 0 && end === png.length && data, 'NATIVE_MARKDOWN_INVALID_PNG', 'The PNG is incomplete.'); return png }
    offset = end
  }
  assert(false, 'NATIVE_MARKDOWN_INVALID_PNG', 'The PNG is incomplete.')
}

/** The local renderer only publishes PNG bytes for this exact chat session and generation. */
export function createNativeMarkdownService(options: {
  readonly directory: string; readonly store: DurableStore; readonly accountId: string; readonly renderer: MarkdownRenderer
  readonly binding: (conversationId: string) => { readonly sessionId: string; readonly generation: number } | null
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>
  readonly clock?: () => number; readonly signal?: AbortSignal
  readonly onMaintenanceFault?: (code: string) => void
}) {
  const directory = join(options.directory, 'markdown-assets')
  const clock = options.clock ?? Date.now
  let tail: Promise<unknown> = Promise.resolve()
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  function current(conversationId: string, sessionId: unknown, generation: unknown) {
    assert(!closed, 'NATIVE_MARKDOWN_STOPPED', 'The renderer has stopped.')
    const binding = options.binding(conversationId)
    assert(reference(conversationId) && typeof sessionId === 'string' && reference(sessionId) && typeof generation === 'number'
      && Number.isSafeInteger(generation) && generation > 0 && binding?.sessionId === sessionId && binding.generation === generation,
    'NATIVE_MARKDOWN_SESSION_STALE', 'The rendered image requires its current original chat session.')
    return { sessionId, generation }
  }
  async function read(assetId: string, size: number, hash: string): Promise<Buffer> {
    assert(await realpath(directory) === directory, 'NATIVE_MARKDOWN_DIRECTORY_INVALID', 'A canonical image directory is required.')
    const filename = join(directory, assetId)
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await file.stat()
      assert(before.isFile() && before.nlink === 1 && (before.mode & 0o777) === 0o600 && before.size === size && size <= maxBytes,
        'NATIVE_MARKDOWN_ASSET_INVALID', 'The rendered PNG file is unavailable.')
      const bytes = await file.readFile(); const after = await file.stat(); const path = await lstat(filename)
      assert(before.ino === path.ino && before.dev === path.dev && path.nlink === 1 && before.size === after.size
        && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && createHash('sha256').update(bytes).digest('hex') === hash,
      'NATIVE_MARKDOWN_ASSET_CHANGED', 'The rendered PNG bytes changed.')
      return bytes
    } finally { await file.close() }
  }
  async function capacity(additionalBytes: number) {
    await ensurePrivateDirectory(directory)
    assert(await realpath(directory) === directory, 'NATIVE_MARKDOWN_DIRECTORY_INVALID', 'A canonical image directory is required.')
    const files = await readdir(directory)
    assert(files.length <= 256, 'NATIVE_MARKDOWN_BACKPRESSURE', 'The rendered image directory is full.')
    let count = 0; let bytes = 0
    for (const assetId of files) {
      assert(/^markdown-asset-[a-f0-9]{64}$/.test(assetId), 'NATIVE_MARKDOWN_DIRECTORY_INVALID', 'The image directory contains an unknown entry.')
      const metadata = await lstat(join(directory, assetId))
      assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && (metadata.mode & 0o777) === 0o600,
        'NATIVE_MARKDOWN_DIRECTORY_INVALID', 'The image directory contains an invalid file.')
      const record = options.store.read(namespace, assetId)
      const expired = record ? Number(object(record.value).expiresAt) <= clock() : metadata.mtimeMs + ttlMs <= clock()
      if (expired) { await unlink(join(directory, assetId)); continue }
      count++; bytes += metadata.size
    }
    assert(count + (additionalBytes > 0 ? 1 : 0) <= 256 && bytes + additionalBytes <= 128 * 1024 * 1024, 'NATIVE_MARKDOWN_BACKPRESSURE', 'The rendered image capacity was reached.')
  }
  function maintenance(): Promise<void> {
    const operation = tail.catch(() => undefined).then(async () => {
      if (!closed && !options.signal?.aborted) await capacity(0)
    })
    tail = operation
    return operation
  }
  const stopTimer = () => clearTimeout(timer)
  function schedule(ms: number) {
    if (closed || options.signal?.aborted) return
    timer = setTimeout(() => {
      void maintenance().catch(error => { try { options.onMaintenanceFault?.(errorCode(error, 'NATIVE_MARKDOWN_MAINTENANCE_FAILED')) } catch {} })
        .finally(() => schedule(60 * 60 * 1000))
    }, ms)
    timer.unref()
  }
  options.signal?.addEventListener('abort', stopTimer, { once: true })
  schedule(5000)
  return Object.freeze({
    maintenance,
    async close() { closed = true; stopTimer(); options.signal?.removeEventListener('abort', stopTimer); await Promise.allSettled([tail]) },
    async render(request: NativeMarkdownOutputRequest & { readonly event: FrameworkEvent; readonly signal: AbortSignal }): Promise<readonly MessageContent[]> {
      const { event } = request
      const signal = options.signal ? AbortSignal.any([request.signal, options.signal]) : request.signal
      const scope = current(event.conversationId, event.sessionId, event.data.generation)
      assert(reference(event.id) && request.body.trim().length > 0 && request.body.length <= 32000 && Buffer.byteLength(request.body) <= 65536,
        'NATIVE_MARKDOWN_INPUT_LIMIT', 'Markdown requires bounded text.')
      await options.authorize(event.conversationId, signal); signal.throwIfAborted()
      const pages = await options.renderer.render({ markdown: request.body, ...(request.title === undefined ? {} : { title: request.title }), signal })
      signal.throwIfAborted(); current(event.conversationId, scope.sessionId, scope.generation)
      assert(Array.isArray(pages) && pages.length > 0 && pages.length <= 6, 'NATIVE_MARKDOWN_PAGE_LIMIT', 'Markdown must fit within six PNG pages.')
      const bytes = pages.map(validatePage)
      assert(bytes.reduce((sum, value) => sum + value.length, 0) <= 20 * 1024 * 1024, 'NATIVE_MARKDOWN_OUTPUT_LIMIT', 'The rendered document exceeds its byte limit.')
      const operation = tail.catch(() => undefined).then(async () => {
        const created: { id: string; revision: number | null }[] = []
        try {
          const result: MessageContent[] = []
          for (const [index, png] of bytes.entries()) {
            await options.authorize(event.conversationId, signal); signal.throwIfAborted(); current(event.conversationId, scope.sessionId, scope.generation)
            const hash = createHash('sha256').update(png).digest('hex')
            const assetId = `markdown-asset-${digest([options.accountId, event.conversationId, scope.sessionId, scope.generation, event.id, index, hash])}`
            const prior = options.store.read(namespace, assetId)
            if (prior) {
              const value = object(prior.value)
              assert(value.hash === hash && value.accountId === options.accountId && value.sessionId === scope.sessionId
                && value.conversationId === event.conversationId && value.generation === scope.generation && Number(value.expiresAt) > clock(),
              'NATIVE_MARKDOWN_ASSET_CONFLICT', 'The rendered image identity is already reserved or expired.')
              await read(assetId, png.length, hash)
            } else {
              await capacity(png.length)
              const handle = await open(join(directory, assetId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
              const createdFile = { id: assetId, revision: null as number | null }; created.push(createdFile)
              try { await handle.writeFile(png, { signal }); await handle.sync() } finally { await handle.close() }
              await options.authorize(event.conversationId, signal); signal.throwIfAborted(); current(event.conversationId, scope.sessionId, scope.generation)
              const now = clock()
              const saved = options.store.write(namespace, assetId, json({ schema: 1, assetId, accountId: options.accountId,
                conversationId: event.conversationId, ...scope, hash, bytes: png.length, width: pages[index]!.width,
                height: pages[index]!.height, createdAt: now, expiresAt: now + ttlMs }), { expectedRevision: null, expiresAt: now + 7 * ttlMs })
              createdFile.revision = saved.revision
            }
            result.push({ type: 'image', assetId })
          }
          await options.authorize(event.conversationId, signal); signal.throwIfAborted(); current(event.conversationId, scope.sessionId, scope.generation)
          return result
        } catch (error) {
          for (const file of created) {
            const removed = file.revision === null || options.store.delete(namespace, file.id, file.revision)
            if (removed) await unlink(join(directory, file.id)).catch(() => {})
          }
          throw error
        }
      })
      tail = operation
      return operation
    },
    async resolve(request: OneBotAssetResolutionRequest) {
      const signal = options.signal ? AbortSignal.any([request.signal, options.signal]) : request.signal
      signal.throwIfAborted()
      assert(/^markdown-asset-[a-f0-9]{64}$/.test(request.assetId) && request.type === 'image', 'NATIVE_MARKDOWN_ASSET_UNAVAILABLE', 'A registered rendered image is required.')
      await options.authorize(request.conversationId, signal)
      current(request.conversationId, request.sessionId, request.generation)
      const record = options.store.read(namespace, request.assetId)
      assert(record, 'NATIVE_MARKDOWN_ASSET_UNAVAILABLE', 'The rendered image is unavailable.')
      const value = object(record.value)
      assert(value.schema === 1 && value.accountId === options.accountId && value.conversationId === request.conversationId
        && value.sessionId === request.sessionId && value.generation === request.generation && Number(value.expiresAt) > clock(),
      'NATIVE_MARKDOWN_ASSET_SCOPE', 'The image belongs to a different or expired chat scope.')
      const bytes = await read(request.assetId, Number(value.bytes), String(value.hash))
      await options.authorize(request.conversationId, signal); signal.throwIfAborted()
      current(request.conversationId, request.sessionId, request.generation)
      assert(Number(value.expiresAt) > clock(), 'NATIVE_MARKDOWN_ASSET_UNAVAILABLE', 'The rendered image expired while reading.')
      return { file: `base64://${bytes.toString('base64')}` }
    }
  })
}
