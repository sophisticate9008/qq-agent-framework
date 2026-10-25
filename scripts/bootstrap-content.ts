import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { NativePackageContentIdentity, NativePackageContentManifest } from '../src/contracts/native-package-content.ts'
import { assert, isRecord, snapshot } from '../src/core/values.ts'
import { digest } from '../src/host/data.ts'

const loadedRoots = new Map<string, string>()
const excludedDirectories = new Set(['runtime', 'node_modules', '.git', '.cache', '.codex'])
function excludedFile(name: string) { return /^\.env(?:\.|$)/i.test(name) || /(?:^|[._-])(?:credentials?|secrets?|tokens?)(?:\.|$)/i.test(name)
  || /\.(?:pem|key|p12|pfx|sqlite|db)(?:$|-(?:wal|shm|journal)$)/i.test(name) || /(?:id_rsa|id_ed25519|hosts\.yml)$/i.test(name) }
function localPath(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512
  && !isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..') }
async function bytes(filename: string, limit: number): Promise<Buffer> {
  assert(await realpath(dirname(filename)) === dirname(filename), 'NATIVE_PACKAGE_CONTENT_UNSAFE', 'Package directories must not contain links.')
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    assert(before.isFile() && before.nlink === 1 && (before.mode & 0o022) === 0 && before.size <= limit
      && (typeof process.getuid !== 'function' || [0, process.getuid()].includes(before.uid)), 'NATIVE_PACKAGE_CONTENT_UNSAFE', 'Package files must be bounded, trusted regular files.')
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead }
    const after = await handle.stat(); const path = await lstat(filename)
    assert(length === before.size && before.dev === after.dev && before.ino === after.ino && after.dev === path.dev && after.ino === path.ino
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && !path.isSymbolicLink(), 'NATIVE_PACKAGE_CONTENT_CHANGED', 'Package files changed while being fingerprinted.')
    return buffer.subarray(0, length)
  } finally { await handle.close() }
}
function manifest(input: unknown, entry: string): NativePackageContentManifest {
  assert(isRecord(input) && Object.keys(input).length === 3 && input.schema === 1 && input.entry === entry
    && Array.isArray(input.dependencies) && input.dependencies.length <= 64, 'NATIVE_PACKAGE_MANIFEST_INVALID', 'An explicit bounded package content manifest is required.')
  const dependencies: NativePackageContentManifest['dependencies'][number][] = []
  for (const item of input.dependencies) {
    assert(isRecord(item) && Object.keys(item).length === 2 && typeof item.specifier === 'string' && item.specifier.length <= 160
      && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-zA-Z0-9._-]+)*$/.test(item.specifier)
      && localPath(item.lockFile) && ['package-lock.json', 'npm-shrinkwrap.json'].includes(basename(item.lockFile))
      && !dependencies.some(prior => prior.specifier === item.specifier), 'NATIVE_PACKAGE_MANIFEST_INVALID', 'External imports require exact specifiers and explicit npm dependency locks.')
    dependencies.push({ specifier: item.specifier, lockFile: item.lockFile })
  }
  return snapshot({ schema: 1, entry, dependencies })
}

/** Fingerprint a declared package before importing any of its code. Runtime data and credentials are never included. */
export async function readNativeBootstrapContent(filename: string, signal: AbortSignal): Promise<{
  readonly identity: NativePackageContentIdentity
  readonly verify: (signal: AbortSignal) => Promise<void>
} | null> {
  const root = dirname(filename)
  const sidecar = `${filename}.manifest.json`
  const present = await lstat(sidecar).catch((error: unknown) => { if (isRecord(error) && error.code === 'ENOENT') return null; throw error })
  if (!present) return null
  const definition = manifest(JSON.parse((await bytes(sidecar, 65536)).toString('utf8')) as unknown, basename(filename))
  async function fingerprint(currentSignal: AbortSignal): Promise<NativePackageContentIdentity> {
    const files = new Map<string, Buffer>()
    let total = 0
    async function walk(directory: string, depth: number): Promise<void> {
      currentSignal.throwIfAborted()
      const before = await lstat(directory)
      assert(depth <= 8 && before.isDirectory() && !before.isSymbolicLink() && (before.mode & 0o022) === 0
        && (typeof process.getuid !== 'function' || [0, process.getuid()].includes(before.uid)), 'NATIVE_PACKAGE_CONTENT_UNSAFE', 'Package directories must be bounded and trusted.')
      for (const item of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
        if (excludedDirectories.has(item.name) || excludedFile(item.name)) continue
        const path = resolve(directory, item.name)
        if (item.isDirectory()) { await walk(path, depth + 1); continue }
        assert(item.isFile() && !item.isSymbolicLink() && files.size < 256, 'NATIVE_PACKAGE_CONTENT_UNSAFE', 'Package trees must contain bounded regular files.')
        const content = await bytes(path, 1048576)
        total += content.length
        assert(total <= 8 * 1024 * 1024, 'NATIVE_PACKAGE_CONTENT_UNSAFE', 'Package content exceeds the bounded tree size.')
        files.set(relative(root, path).split(sep).join('/'), content)
      }
      const after = await lstat(directory)
      assert(before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
        'NATIVE_PACKAGE_CONTENT_CHANGED', 'The package tree changed during fingerprinting.')
    }
    await walk(root, 0)
    assert(files.has(definition.entry), 'NATIVE_PACKAGE_CONTENT_UNSAFE', 'The package entry must be inside its declared content root.')
    const currentManifest = files.get(relative(root, sidecar).split(sep).join('/'))
    assert(currentManifest && digest(manifest(JSON.parse(currentManifest.toString('utf8')) as unknown, definition.entry)) === digest(definition),
      'NATIVE_PACKAGE_CONTENT_CHANGED', 'The package content declaration changed.')
    const locks = new Map<string, string>()
    for (const dependency of definition.dependencies) {
      const content = files.get(dependency.lockFile)
      assert(content, 'NATIVE_PACKAGE_DEPENDENCY_UNVERIFIED', 'Every external dependency needs an included dependency lock.')
      const lock: unknown = JSON.parse(content.toString('utf8'))
      const packageName = dependency.specifier.startsWith('@') ? dependency.specifier.split('/').slice(0, 2).join('/') : dependency.specifier.split('/')[0]!
      assert(isRecord(lock) && [2, 3].includes(Number(lock.lockfileVersion)) && isRecord(lock.packages), 'NATIVE_PACKAGE_DEPENDENCY_UNVERIFIED', 'Dependency lock metadata is unavailable.')
      const target = lock.packages[`node_modules/${packageName}`]
      assert(isRecord(target) && typeof target.version === 'string' && target.version.length <= 100 && typeof target.integrity === 'string'
        && /^sha(?:256|512)-[A-Za-z0-9+/]+=*$/.test(target.integrity), 'NATIVE_PACKAGE_DEPENDENCY_UNVERIFIED', 'A locked external dependency must include version and integrity evidence.')
      locks.set(dependency.specifier, createHash('sha256').update(content).digest('hex'))
    }
    const ts = await import('typescript')
    for (const [path, content] of files) {
      if (!/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(path)) continue
      const source = ts.createSourceFile(path, content.toString('utf8'), ts.ScriptTarget.Latest, true)
      const check = (specifier: string) => {
        if (isBuiltin(specifier)) return
        if (specifier.startsWith('.')) {
          const target = resolve(root, dirname(path), specifier)
          const key = relative(root, target).split(sep).join('/')
          assert(!key.startsWith('../') && key !== '..' && !isAbsolute(key) && files.has(key), 'NATIVE_PACKAGE_IMPORT_UNDECLARED', 'Relative imports must remain inside the fingerprinted package tree.')
        } else assert(locks.has(specifier), 'NATIVE_PACKAGE_IMPORT_UNDECLARED', 'External imports must exactly match a declared dependency lock.')
      }
      function visit(node: import('typescript').Node): void {
        if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true || ts.isExportDeclaration(node) && !node.isTypeOnly) {
          const specifier = (node as import('typescript').ImportDeclaration | import('typescript').ExportDeclaration).moduleSpecifier
          if (specifier) { assert(ts.isStringLiteral(specifier), 'NATIVE_PACKAGE_IMPORT_UNDECLARED', 'Imports must use literal module names.'); check(specifier.text) }
        }
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
          assert(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!), 'NATIVE_PACKAGE_IMPORT_UNDECLARED', 'Dynamic module expressions cannot be fingerprinted safely.')
          check((node.arguments[0] as import('typescript').StringLiteral).text)
        }
        if (ts.isIdentifier(node) && node.text === 'createRequire') assert(false, 'NATIVE_PACKAGE_IMPORT_UNDECLARED', 'Custom module loaders require a separately verified installation boundary.')
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    currentSignal.throwIfAborted()
    return snapshot({ fingerprint: digest({ files: [...files].map(([path, content]) => ({ path, sha256: createHash('sha256').update(content).digest('hex') })),
      dependencyLocks: [...locks] }), coverage: 'package-tree-and-dependency-locks-v1', files: files.size })
  }
  const identity = await fingerprint(signal)
  const prior = loadedRoots.get(root)
  assert(prior === undefined || prior === identity.fingerprint, 'NATIVE_PACKAGE_PROCESS_RESTART_REQUIRED', 'Changed package content requires a fresh process before loading.')
  loadedRoots.set(root, identity.fingerprint)
  return Object.freeze({ identity, async verify(currentSignal: AbortSignal) {
    assert((await fingerprint(currentSignal)).fingerprint === identity.fingerprint, 'NATIVE_PACKAGE_CONTENT_CHANGED', 'Package content changed after loading.')
  } })
}
