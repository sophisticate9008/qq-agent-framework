import { constants } from 'node:fs'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { AdminRequestError } from './server.ts'

const writeTails = new Map<string, Promise<void>>()

export async function withConfigurationWriteLock<Value>(filename: string, operation: () => Promise<Value>): Promise<Value> {
  const absolute = resolve(filename)
  const key = join(await realpath(dirname(absolute)), basename(absolute))
  const previous = writeTails.get(key) ?? Promise.resolve()
  let releaseQueue: (() => void) | undefined
  const pending = new Promise<void>(resolvePromise => { releaseQueue = resolvePromise })
  const tail = previous.catch(() => undefined).then(() => pending)
  writeTails.set(key, tail)
  await previous.catch(() => undefined)
  const lockfile = join(dirname(key), `.${basename(key)}.admin-write.lock`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let identity: { dev: number; ino: number } | undefined
  try {
    try {
      handle = await open(lockfile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      const busy = error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
      throw new AdminRequestError(busy ? 409 : 500, busy ? 'configuration_write_busy' : 'configuration_lock_failed')
    }
    const opened = await handle.stat()
    identity = opened
    const current = await lstat(lockfile)
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600
      || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new AdminRequestError(500, 'configuration_lock_failed')
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid }))
    await handle.sync()
    return await operation()
  } finally {
    await handle?.close().catch(() => undefined)
    if (identity) {
      try {
        const current = await lstat(lockfile)
        if (current.dev === identity.dev && current.ino === identity.ino) await unlink(lockfile)
      } catch {}
    }
    releaseQueue?.()
    if (writeTails.get(key) === tail) writeTails.delete(key)
  }
}
