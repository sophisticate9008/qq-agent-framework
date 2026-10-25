import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assert, snapshot } from '../core/values.ts'
import { digest } from './data.ts'
import type { NativePackageContentIdentity } from '../contracts/native-package-content.ts'

export interface NativePackageContent {
  readonly identity: NativePackageContentIdentity
  verify(signal: AbortSignal): void | Promise<void>
}
/** Built-in package files are part of the trusted host installation; runtime data never enters this hash. */
export function createBuiltinPackageContent(moduleUrl: string, dependencies: readonly string[] = []): NativePackageContent {
  const extension = moduleUrl.endsWith('.ts') ? '.ts' : '.js'
  const files = [moduleUrl, ...dependencies.map(path => new URL(`${path}${extension}`, moduleUrl).href)]
  function fingerprint() {
    const content = files.map((url, index) => {
      const filename = fileURLToPath(url)
      const handle = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const before = fstatSync(handle)
        assert(before.isFile() && before.nlink === 1 && (before.mode & 0o022) === 0 && before.size <= 1048576
          && (typeof process.getuid !== 'function' || [0, process.getuid()].includes(before.uid)), 'NATIVE_PACKAGE_CONTENT_UNSAFE', 'Built-in package source files must be trusted and bounded.')
        const bytes = readFileSync(handle); const after = fstatSync(handle); const current = lstatSync(filename)
        assert(bytes.length === before.size && before.ino === after.ino && before.dev === after.dev && before.mtimeMs === after.mtimeMs
          && before.ctimeMs === after.ctimeMs && after.ino === current.ino && after.dev === current.dev && !current.isSymbolicLink(),
        'NATIVE_PACKAGE_CONTENT_CHANGED', 'Built-in package content changed while being read.')
        return { index, fingerprint: createHash('sha256').update(bytes).digest('hex') }
      } finally { closeSync(handle) }
    })
    return digest(content)
  }
  const identity: NativePackageContentIdentity = snapshot({ fingerprint: fingerprint(), coverage: 'builtin-host-files', files: files.length })
  return Object.freeze({ identity, verify(signal: AbortSignal) {
    signal.throwIfAborted()
    assert(fingerprint() === identity.fingerprint, 'NATIVE_PACKAGE_CONTENT_CHANGED', 'Built-in package content changed after loading.')
  } })
}
