import { createHash } from 'node:crypto'
import { mkdir, readdir, lstat, unlink, writeFile, realpath, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import type { DiaryMedia } from './types.ts'

/** Use only when the protocol process can read the same operator-owned local directory. */
export function createLocalDiaryMedia(directory: string): DiaryMedia {
  const root = resolve(directory)
  async function prepare() {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await inspectDirectory()
  }
  async function inspectDirectory() {
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || await realpath(root) !== root) throw new Error('DIARY_MEDIA_DIRECTORY_INVALID')
  }
  async function readImage(name: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    await inspectDirectory()
    const match = name.match(/^[A-Za-z0-9-]+-([a-f0-9]{64})\.(png|jpg|webp)$/)
    if (!match) throw new Error('DIARY_MEDIA_INVALID')
    const handle = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024 || info.mode & 0o077) throw new Error('DIARY_MEDIA_INVALID')
      const bytes = Buffer.alloc(info.size + 1)
      let offset = 0
      while (offset < bytes.byteLength) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      const after = await handle.stat()
      signal?.throwIfAborted()
      if (offset !== info.size || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new Error('DIARY_MEDIA_CHANGED')
      const content = bytes.subarray(0, offset)
      if (createHash('sha256').update(content).digest('hex') !== match[1]) throw new Error('DIARY_MEDIA_CHANGED')
      return content
    } finally { await handle.close() }
  }
  async function verify(name: string) {
    await readImage(name)
    return { protocolImage: pathToFileURL(join(root, name)).href }
  }
  return {
    async save(id, image) {
      await prepare()
      if (!/^[A-Za-z0-9-]{1,100}$/.test(id) || image.data.byteLength > 8 * 1024 * 1024
        || createHash('sha256').update(image.data).digest('hex') !== image.sha256) throw new Error('DIARY_MEDIA_INVALID')
      const name = `${id}-${image.sha256}.${image.mediaType === 'image/png' ? 'png' : image.mediaType === 'image/jpeg' ? 'jpg' : 'webp'}`
      await writeFile(join(root, name), image.data, { mode: 0o600, flag: 'wx' }).catch((error: unknown) => {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
      })
      return { id: name, ...await verify(name) }
    },
    resolve: verify,
    async preview(id, signal) {
      const bytes = await readImage(id, signal)
      signal?.throwIfAborted()
      const pipeline = sharp(bytes, { limitInputPixels: 40_000_000, animated: false }).timeout({ seconds: 3 })
        .rotate().resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 })
      const cancel = () => { pipeline.destroy() }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        const thumbnail = await pipeline.toBuffer()
        signal?.throwIfAborted()
        if (thumbnail.byteLength > 192 * 1024) throw new Error('DIARY_PREVIEW_TOO_LARGE')
        return { mediaType: 'image/webp', data: thumbnail.toString('base64') }
      } finally { signal?.removeEventListener('abort', cancel); pipeline.destroy() }
    },
    async prune(retainedIds) {
      await prepare()
      const retained = new Set(retainedIds), files = await readdir(root)
      if (files.length > 10000) throw new Error('DIARY_MEDIA_MAINTENANCE_LIMIT')
      for (const name of files) {
        if (retained.has(name) || !/^[A-Za-z0-9-]+-[a-f0-9]{64}\.(png|jpg|webp)$/.test(name)) continue
        const info = await lstat(join(root, name))
        if (info.isFile() && !info.isSymbolicLink() && info.mtimeMs < Date.now() - 7 * 86400000) await unlink(join(root, name))
      }
    },
  }
}
