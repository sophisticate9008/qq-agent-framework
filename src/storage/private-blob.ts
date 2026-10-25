import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { ensurePrivateDirectory, PrivateJsonStorageError } from './private-json.ts';

function fail(): never { throw new PrivateJsonStorageError(503, 'private_blob_unavailable'); }
/** Bounded immutable private files: paths remain inside the caller's trusted directory. */
export async function readPrivateBlob(filename: string, expected: { readonly bytes: number; readonly sha256: string; readonly maximumBytes: number }, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(expected.maximumBytes) || expected.maximumBytes < 1 || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1 || expected.bytes > expected.maximumBytes || !/^[a-f0-9]{64}$/.test(expected.sha256)) fail();
  const directory = dirname(filename); const beforeDirectory = await lstat(directory);
  if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink() || (beforeDirectory.mode & 0o777) !== 0o700) fail();
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size !== expected.bytes) fail();
    const buffer = Buffer.alloc(expected.bytes + 1); let size = 0;
    while (size < buffer.length) { signal.throwIfAborted(); const result = await handle.read(buffer, size, buffer.length - size, size); if (result.bytesRead === 0) break; size += result.bytesRead; }
    const after = await handle.stat(); const path = await lstat(filename); const afterDirectory = await lstat(directory);
    if (size !== expected.bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1 || (after.mode & 0o777) !== 0o600
      || path.dev !== before.dev || path.ino !== before.ino || path.isSymbolicLink() || afterDirectory.ino !== beforeDirectory.ino || afterDirectory.dev !== beforeDirectory.dev || afterDirectory.isSymbolicLink() || (afterDirectory.mode & 0o777) !== 0o700
      || createHash('sha256').update(buffer.subarray(0, size)).digest('hex') !== expected.sha256) fail();
    signal.throwIfAborted(); return buffer.subarray(0, size);
  } finally { await handle.close(); }
}
export async function writePrivateBlob(directory: string, name: string, bytes: Buffer, signal: AbortSignal): Promise<void> {
  if (name !== basename(name) || !/^[a-zA-Z0-9_.-]+$/.test(name) || name.startsWith('.')) fail();
  signal.throwIfAborted(); await ensurePrivateDirectory(directory); signal.throwIfAborted();
  const filename = join(directory, name); const sha256 = createHash('sha256').update(bytes).digest('hex');
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') { await readPrivateBlob(filename, { bytes: bytes.length, maximumBytes: bytes.length, sha256 }, signal); return; }
    throw error;
  }
  try { await handle.writeFile(bytes); await handle.sync(); const stat = await handle.stat(); if (stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size !== bytes.length) fail(); }
  finally { await handle.close(); }
  const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  signal.throwIfAborted();
}
