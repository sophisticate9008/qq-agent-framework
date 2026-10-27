import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert } from '../core/values.ts'

/** Invoked only under an exclusive OS session.lock, after the serving listener has stopped. */
async function removeSessionFiles(directory: string, device: number, inode: number) {
  assert(resolve(directory) === directory && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(basename(directory)) && await realpath(directory) === directory,
    'SESSION_DELETE_STORAGE_UNSAFE', 'Expected an isolated session directory.')
  const identity = await lstat(directory)
  assert(identity.isDirectory() && !identity.isSymbolicLink() && identity.dev === device && identity.ino === inode
    && identity.uid === process.getuid?.() && (identity.mode & 0o022) === 0,
    'SESSION_DELETE_STORAGE_CHANGED', 'The session directory changed.')
  const files = await readdir(directory)
  assert(files.length > 0 && files.length <= 64 && files.every(name => /^(session(?:\.v[0-9]+)?\.jsonl(?:\.zstd)?|session\.lock)$/.test(name)),
    'SESSION_DELETE_STORAGE_UNSUPPORTED', 'The session directory contains unsupported artifacts.')
  for (const name of files) {
    const info = await lstat(join(directory, name))
    assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid?.(),
      'SESSION_DELETE_STORAGE_UNSAFE', 'Session artifacts must be regular owned files.')
  }
  // Remove the lock name last while the inherited flock descriptor still holds the lease.
  for (const name of files.filter(name => name !== 'session.lock')) await unlink(join(directory, name))
  if (files.includes('session.lock')) await unlink(join(directory, 'session.lock'))
  await rmdir(directory)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, device, inode] = process.argv.slice(2)
  assert(directory && Number.isSafeInteger(Number(device)) && Number.isSafeInteger(Number(inode)), 'SESSION_DELETE_INVALID_TARGET', 'Invalid removal target.')
  await removeSessionFiles(directory, Number(device), Number(inode))
}
