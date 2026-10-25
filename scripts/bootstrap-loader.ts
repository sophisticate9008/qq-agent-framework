import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineNativeBootstrap, type LoadedNativeBootstrap, type NativeBootstrapDefinition } from '../src/host/native-bootstrap.ts';
import { FrameworkError, assert, errorCode, snapshot } from '../src/core/values.ts';
import { readNativeBootstrapContent } from './bootstrap-content.ts';
import { withDeadline } from '../src/host/deadlines.ts';

const pendingImports = new Set<string>();
const maxPendingImports = 4;

function trustedOwner(information: Stats) {
  return typeof process.getuid === 'function' && [0, process.getuid()].includes(information.uid);
}

function trustedFile(information: Stats, maxBytes: number) {
  assert(information.isFile() && !information.isSymbolicLink() && information.nlink === 1
    && (information.mode & 0o022) === 0 && trustedOwner(information)
    && information.size > 0 && information.size <= maxBytes,
  'NATIVE_BOOTSTRAP_FILE_DENIED', 'Bootstrap must be a bounded trusted local regular file.');
}

async function trustedParents(filename: string) {
  let directory = dirname(filename);
  for (let count = 0; count < 128; count++) {
    const information = await lstat(directory);
    assert(information.isDirectory() && !information.isSymbolicLink() && trustedOwner(information)
      && (information.mode & 0o022) === 0, 'NATIVE_BOOTSTRAP_DIRECTORY_DENIED', 'Bootstrap parent directories must be trusted and not shared writable.');
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
  throw new FrameworkError('NATIVE_BOOTSTRAP_DIRECTORY_DENIED', 'Bootstrap parent directory depth exceeds the bound.');
}

async function fingerprint(filename: string, maxBytes: number) {
  await trustedParents(filename);
  const information = await lstat(filename);
  trustedFile(information, maxBytes);
  const descriptor = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await descriptor.stat();
    trustedFile(before, maxBytes);
    assert(before.dev === information.dev && before.ino === information.ino,
      'NATIVE_BOOTSTRAP_CHANGED', 'Bootstrap changed during verification.');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await descriptor.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await descriptor.stat();
    const current = await lstat(filename);
    trustedFile(after, maxBytes);
    assert(length === before.size && length === after.size && after.mtimeMs === before.mtimeMs
      && after.ctimeMs === before.ctimeMs && current.dev === before.dev && current.ino === before.ino
      && !current.isSymbolicLink(), 'NATIVE_BOOTSTRAP_CHANGED', 'Bootstrap changed during verification.');
    return createHash('sha256').update(bytes.subarray(0, length)).digest('hex');
  } finally { await descriptor.close(); }
}

export async function loadNativeBootstrap(filename: string, { signal = new AbortController().signal, maxBytes = 262144, timeoutMs = 10000, expectedFingerprint }:
  { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number; expectedFingerprint?: string } = {}): Promise<LoadedNativeBootstrap> {
  assert(typeof filename === 'string' && filename.length <= 4096 && isAbsolute(filename) && filename === resolve(filename)
    && filename.endsWith('.ts') && !/[\x00-\x1f\x7f?#]/.test(filename),
  'NATIVE_BOOTSTRAP_PATH_DENIED', 'An explicit absolute local TypeScript bootstrap path is required.');
  assert(signal instanceof AbortSignal && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 1048576
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 300000
    && (expectedFingerprint === undefined || /^[a-f0-9]{64}$/.test(expectedFingerprint)),
  'INVALID_NATIVE_BOOTSTRAP_OPTIONS', 'Finite bootstrap load bounds are required.');
  assert(!pendingImports.has(filename) && pendingImports.size < maxPendingImports,
    'NATIVE_BOOTSTRAP_LOAD_BUSY', 'Earlier bootstrap imports remain unresolved.');
  pendingImports.add(filename);
  let entered = false;
  try {
    return await withDeadline({ signal, timeoutMs, code: 'NATIVE_BOOTSTRAP_LOAD_TIMEOUT_UNKNOWN', run(combined) {
      entered = true;
      const raw = (async () => {
        const codeFingerprint = await fingerprint(filename, maxBytes);
        const content = await readNativeBootstrapContent(filename, combined);
        assert(expectedFingerprint === undefined || codeFingerprint === expectedFingerprint,
          'NATIVE_BOOTSTRAP_CHANGED', 'The selected bootstrap bytes have changed; explicit installation is required.');
        combined.throwIfAborted();
        const url = pathToFileURL(filename);
        url.searchParams.set('bootstrap', content?.identity.fingerprint ?? codeFingerprint);
        const namespace: unknown = await import(url.href);
        combined.throwIfAborted();
        assert(namespace !== null && typeof namespace === 'object' && 'default' in namespace,
          'INVALID_NATIVE_BOOTSTRAP', 'Bootstrap must default-export its definition.');
        const definition = defineNativeBootstrap(namespace.default as NativeBootstrapDefinition);
        assert(await fingerprint(filename, maxBytes) === codeFingerprint,
          'NATIVE_BOOTSTRAP_CHANGED', 'Bootstrap changed while loading.');
        await content?.verify(combined);
        const metadata = snapshot({ manifest: definition.manifest, codeFingerprint,
          contentIdentity: content?.identity ?? { fingerprint: codeFingerprint, coverage: 'entry-only' as const, files: 1 }, trust: 'trusted-operator-code' as const,
          sandboxed: false as const, requiresSeparateAuthorization: true as const });
        return Object.freeze({ metadata, verifyContent: content?.verify, packageConfigurations: definition.packageConfigurations, controlCommands: definition.controlCommands, lifecycleHooks: definition.lifecycleHooks,
          async create(context) {
          context.signal.throwIfAborted();
          assert(await fingerprint(filename, maxBytes) === codeFingerprint,
            'NATIVE_BOOTSTRAP_CHANGED', 'Bootstrap changed after loading; explicit reload is required.');
          context.signal.throwIfAborted();
          await content?.verify(context.signal);
          return definition.create(context);
        } } satisfies LoadedNativeBootstrap);
      })();
      raw.then(() => pendingImports.delete(filename), () => pendingImports.delete(filename));
      return raw;
    } });
  } catch (error) {
    if (!entered) pendingImports.delete(filename);
    throw new FrameworkError(errorCode(error, 'NATIVE_BOOTSTRAP_LOAD_FAILED'), 'Trusted bootstrap did not load safely.');
  }
}

export async function loadSelectedNativeBootstrap(configurationFilename: string, explicitFilename?: string): Promise<LoadedNativeBootstrap | undefined> {
  if (explicitFilename !== undefined) return loadNativeBootstrap(explicitFilename);
  const configuration = resolve(configurationFilename);
  const filename = join(dirname(configuration), `${basename(configuration)}.bootstrap.json`);
  const information = await lstat(filename).catch((error: unknown) => {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (information === null) return undefined;
  await trustedParents(filename);
  trustedFile(information, 8192);
  assert((information.mode & 0o077) === 0, 'NATIVE_BOOTSTRAP_SELECTION_DENIED', 'Operator bootstrap selection must be private.');
  const descriptor = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await descriptor.stat();
    assert(before.dev === information.dev && before.ino === information.ino, 'NATIVE_BOOTSTRAP_CHANGED', 'Operator selection changed.');
    const bytes = Buffer.alloc(8193);
    let length = 0;
    while (length < bytes.length) {
      const read = await descriptor.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await descriptor.stat();
    const current = await lstat(filename);
    assert(length === before.size && length === after.size && length <= 8192
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && !current.isSymbolicLink()
      && current.dev === before.dev && current.ino === before.ino && (current.mode & 0o077) === 0,
    'NATIVE_BOOTSTRAP_CHANGED', 'Operator selection changed while reading.');
    let selection: unknown;
    try { selection = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { throw new FrameworkError('NATIVE_BOOTSTRAP_SELECTION_DENIED', 'Operator selection is not valid JSON.'); }
    assert(selection !== null && typeof selection === 'object' && !Array.isArray(selection),
      'NATIVE_BOOTSTRAP_SELECTION_DENIED', 'Operator selection must be an object.');
    const value = selection as Record<string, unknown>;
    assert(Object.keys(value).length === 3 && value.schema === 1 && typeof value.filename === 'string'
      && typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint),
    'NATIVE_BOOTSTRAP_SELECTION_DENIED', 'Operator selection needs a fixed local file and fingerprint.');
    return await loadNativeBootstrap(value.filename, { expectedFingerprint: value.fingerprint });
  } finally { await descriptor.close(); }
}
