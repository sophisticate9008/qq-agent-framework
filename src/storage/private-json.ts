import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord } from '../core/values.ts'
export class PrivateJsonStorageError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string) {
    super(code)
    this.statusCode = statusCode
    this.code = code
  }
}

const MAX_DOCUMENT_BYTES = 64 * 1024
const LOCK_FILENAME = '.chat-runtime.lock'
const writeTails = new Map<string, Promise<void>>()

function requestError(statusCode: number, code: string): never {
  throw new PrivateJsonStorageError(statusCode, code)
}

export interface Document<Value> {
  readonly revision: string
  readonly value: Value
  readonly content: Buffer
  readonly exists: boolean
}

export function revision(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function sameFile(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function serialize(value: unknown, maxBytes = MAX_DOCUMENT_BYTES, tooLargeCode = 'chat_document_too_large'): Buffer {
  const content = Buffer.from(`${JSON.stringify(value)}\n`)
  if (content.byteLength > maxBytes) requestError(413, tooLargeCode)
  return content
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    const before = await lstat(directory).catch((error: unknown) => {
      if (isRecord(error) && error.code === 'ENOENT') return null
      throw error
    })
    if (before !== null && !before.isDirectory()) requestError(500, 'chat_storage_invalid')
    if (before === null) await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const after = await lstat(directory)
    if (!after.isDirectory() || after.isSymbolicLink() || (after.mode & 0o777) !== 0o700) {
      requestError(500, 'chat_storage_invalid')
    }
  } catch (error: unknown) {
    if (error instanceof PrivateJsonStorageError) throw error
    requestError(500, 'chat_storage_invalid')
  }
}

export interface PrivateJsonReadOptions<Value> {
  readonly maxBytes: number
  readonly validate: (value: unknown) => Value
  readonly fallback?: { readonly value: Value }
  readonly exactMode?: number
  readonly tooLargeCode?: string
  readonly requireSingleLink?: boolean
  readonly invalidCode: string
  readonly conflictCode: string
}

/** Read one bounded JSON file and verify that neither its inode nor its bytes changed. */
export async function readPrivateJson<Value>(filename: string, options: PrivateJsonReadOptions<Value>): Promise<Document<Value>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'ENOENT' && options.fallback !== undefined) {
      const value = options.fallback.value
      const content = serialize(value, options.maxBytes, options.tooLargeCode ?? options.invalidCode)
      return { revision: revision(content), value, content, exists: false }
    }
    requestError(500, options.invalidCode)
  }
  try {
    const before = await handle.stat()
    // Atomic replacement may unlink the opened old inode before this stat. It is a read conflict,
    // while multiple links remain an invalid storage layout.
    if (options.requireSingleLink === true && before.nlink === 0) requestError(409, options.conflictCode)
    const unsafeMode = options.exactMode === undefined ? (before.mode & 0o077) !== 0
      : (before.mode & 0o777) !== options.exactMode
    if (!before.isFile() || unsafeMode || options.requireSingleLink === true && before.nlink !== 1
      || before.size > options.maxBytes) requestError(500, options.invalidCode)
    const content = await handle.readFile()
    const after = await handle.stat()
    const pathname = await lstat(filename)
    if (content.byteLength > options.maxBytes || !sameFile(before, after) || !sameFile(after, pathname)
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      requestError(409, options.conflictCode)
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
    return { revision: revision(content), value: options.validate(parsed), content, exists: true }
  } catch (error: unknown) {
    if (error instanceof PrivateJsonStorageError) throw error
    requestError(500, options.invalidCode)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export function readDocument<Value>(filename: string, fallback: Value,
  validate: (value: unknown) => Value): Promise<Document<Value>> {
  return readPrivateJson(filename, { maxBytes: MAX_DOCUMENT_BYTES, validate, fallback: { value: fallback },
    exactMode: 0o600, requireSingleLink: true, invalidCode: 'chat_storage_invalid', conflictCode: 'chat_revision_conflict' })
}

async function serializeWrite<Value>(directory: string, operation: () => Promise<Value>): Promise<Value> {
  const previous = writeTails.get(directory) ?? Promise.resolve()
  let release: (() => void) | undefined
  const current = new Promise<void>(resolvePromise => { release = resolvePromise })
  const tail = previous.catch(() => undefined).then(() => current)
  writeTails.set(directory, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release?.()
    if (writeTails.get(directory) === tail) writeTails.delete(directory)
  }
}

export async function acquireDirectoryLock(directory: string, lockFilename = LOCK_FILENAME): Promise<() => Promise<void>> {
  const filename = join(directory, lockFilename)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filename,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'EEXIST') requestError(409, 'chat_storage_busy')
    requestError(500, 'chat_storage_invalid')
  }
  try {
    await handle.chmod(0o600)
    await handle.sync()
    const opened = await handle.stat()
    const current = await lstat(filename)
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600
      || !sameFile(opened, current)) requestError(500, 'chat_storage_invalid')
    return async () => {
      await handle?.close().catch(() => undefined)
      try {
        const latest = await lstat(filename)
        if (sameFile(opened, latest)) await unlink(filename)
      } catch {
        return
      }
    }
  } catch (error: unknown) {
    await handle.close().catch(() => undefined)
    await unlink(filename).catch(() => undefined)
    if (error instanceof PrivateJsonStorageError) throw error
    requestError(500, 'chat_storage_invalid')
  }
}

export async function withDirectoryWriteLock<Value>(
  directory: string,
  operation: () => Promise<Value>
): Promise<Value> {
  return serializeWrite(directory, async () => {
    const release = await acquireDirectoryLock(directory)
    try {
      return await operation()
    } finally {
      await release()
    }
  })
}

export interface PrivateJsonReplaceOptions<Saved extends { readonly revision: string }> {
  readonly directory: string
  readonly filename: string
  readonly temporary: string
  readonly content: Buffer
  readonly expectedRevision: string
  readonly read: () => Promise<Saved>
  readonly beforeRevisionCheck?: (temporary: string) => void | Promise<void>
  readonly verifyTemporaryMetadata?: boolean
  readonly directoryOpenFlags?: number
  readonly ignoreDirectoryCloseErrors?: boolean
  readonly conflictCode: string
  readonly writeFailedCode: string
  readonly writeUnknownCode: string
}

/** Replace under the caller's lock. A failure after rename always has an unknown outcome. */
export async function replacePrivateJson<Saved extends { readonly revision: string }>(
  options: PrivateJsonReplaceOptions<Saved>
): Promise<Saved> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let renamed = false
  try {
    handle = await open(options.temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(options.content)
    await handle.sync()
    if (options.verifyTemporaryMetadata === true) {
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
        || metadata.size !== options.content.byteLength) requestError(500, options.writeFailedCode)
    }
    await handle.close()
    handle = undefined
    await options.beforeRevisionCheck?.(options.temporary)
    const latest = await options.read()
    if (latest.revision !== options.expectedRevision) requestError(409, options.conflictCode)
    await rename(options.temporary, options.filename)
    renamed = true
    const directoryHandle = await open(options.directory, options.directoryOpenFlags ?? constants.O_RDONLY)
    try { await directoryHandle.sync() } finally {
      if (options.ignoreDirectoryCloseErrors === true) await directoryHandle.close().catch(() => undefined)
      else await directoryHandle.close()
    }
    const saved = await options.read()
    if (saved.revision !== revision(options.content)) requestError(500, options.writeUnknownCode)
    return saved
  } catch (error: unknown) {
    if (renamed) requestError(500, options.writeUnknownCode)
    if (error instanceof PrivateJsonStorageError) throw error
    requestError(500, options.writeFailedCode)
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(options.temporary).catch(() => undefined)
  }
  throw new PrivateJsonStorageError(500, options.writeFailedCode)
}

export function writeDocumentLocked<Value>(directory: string, filename: string, expectedRevision: string,
  fallback: Value, validate: (value: unknown) => Value, value: Value, encoded?: Buffer): Promise<Document<Value>> {
  return replacePrivateJson({ directory, filename, expectedRevision, content: encoded ?? serialize(value),
    temporary: join(directory, `.${randomUUID()}.tmp`), read: () => readDocument(filename, fallback, validate),
    verifyTemporaryMetadata: true, directoryOpenFlags: constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    conflictCode: 'chat_revision_conflict', writeFailedCode: 'chat_storage_write_failed', writeUnknownCode: 'chat_write_unknown' })
}

export async function updateDocument<Value>(
  directory: string,
  filename: string,
  expectedRevision: string,
  fallback: Value,
  validate: (value: unknown) => Value,
  update: (current: Value) => Value | Promise<Value>,
  precommit: (next: Value, current: Value) => void | Promise<void> = () => undefined
): Promise<Document<Value>> {
  return withDirectoryWriteLock(directory, async () => {
    const current = await readDocument(filename, fallback, validate)
    if (current.revision !== expectedRevision) requestError(409, 'chat_revision_conflict')
    const next = await update(current.value)
    await precommit(next, current.value)
    return writeDocumentLocked(directory, filename, expectedRevision, fallback, validate, next)
  })
}
