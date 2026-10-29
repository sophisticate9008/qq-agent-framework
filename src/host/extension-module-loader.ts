import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FrameworkError } from '../core/values.ts';

export interface ExtensionModuleLoaderOptions {
  readonly entry: string;
  readonly root?: string;
  readonly maxVersions?: number;
  /** UTF-8 bytes of distinct retained module source; compiled modules consume additional memory. */
  readonly maxRetainedSourceBytes?: number;
}

export interface ExtensionModuleVersion {
  readonly revision: string;
  readonly namespace: unknown;
}

export interface ExtensionModuleLoader {
  load(signal?: AbortSignal): Promise<ExtensionModuleVersion>;
}

const generationParameter = '__qbf_extension_generation';
const maximumFiles = 256;
const maximumFileBytes = 1024 * 1024;
const maximumTotalBytes = 8 * 1024 * 1024;
const maximumEntries = 4096;
const maximumDepth = 8;
const excludedDirectories = new Set(['node_modules', 'dsh-plugin', 'test', 'tests', '__tests__',
  'runtime', 'resources', 'assets', 'config', 'configs', 'credentials', 'secrets', 'dist', 'build', 'coverage']);
const sourceExtensions = new Set(['.ts', '.mts', '.js', '.mjs']);

class ModuleLoaderError extends FrameworkError {}

function failure(code: string, message: string): ModuleLoaderError {
  return new ModuleLoaderError(code, message);
}

function within(root: string, filename: string): boolean {
  const local = relative(root, filename);
  return local === '' || (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`));
}

function isSource(filename: string): boolean {
  return sourceExtensions.has(extname(filename)) && !/\.d\.(?:ts|mts)$/.test(filename)
    && !/\.(?:test|spec)\.(?:ts|mts|js|mjs)$/.test(filename);
}

function excludedName(name: string): boolean {
  return name.startsWith('.') || /(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?|private[-_]?key)(?:[._-]|$)/i.test(name);
}

interface SourceFile {
  readonly source: string;
  readonly identity: string;
}

interface Generation {
  readonly token: string;
  readonly root: string;
  readonly sources: ReadonlyMap<string, string>;
  result: Promise<ExtensionModuleVersion>;
}

interface LoaderState {
  readonly root: string;
  readonly entry: string;
  readonly versions: Map<string, Generation>;
  readonly sourcePool: Map<string, string>;
  retainedSourceBytes: number;
  maximumRetainedSourceBytes: number;
  maximumVersions: number;
  busy: boolean;
}

// These registries deliberately survive repeated factory calls for the same plugin.
// Node cannot evict ESM generations; failed and still-evaluating imports also consume a slot.
const loaders = new Map<string, LoaderState>();
const generations = new Map<string, Generation>();
let hooksInstalled = false;

function taggedURL(filename: string, generation: Generation): string {
  const url = pathToFileURL(filename);
  url.searchParams.set(generationParameter, generation.token);
  return url.href;
}

function generationOf(value: string | undefined): Generation | undefined {
  if (!value?.startsWith('file:')) return undefined;
  const url = new URL(value);
  const token = url.searchParams.get(generationParameter);
  if (!token) return undefined;
  const generation = generations.get(token);
  if (!generation) throw failure('EXTENSION_SOURCE_INVALID', 'The extension module generation is unavailable.');
  return generation;
}

function sourceURL(value: string, generation: Generation): string | undefined {
  const url = new URL(value);
  if (url.protocol !== 'file:') return undefined;
  const filename = fileURLToPath(url);
  if (!within(generation.root, filename)) return undefined;
  // Installed packages and host SDK modules retain their ordinary shared identity.
  if (relative(generation.root, filename).split(sep).includes('node_modules')) return undefined;
  if (!generation.sources.has(filename)) {
    throw failure('EXTENSION_SOURCE_UNAVAILABLE', 'A local module is absent from the extension source snapshot.');
  }
  // Canonicalize all user-supplied query/fragment variants to one module per source/generation.
  return taggedURL(filename, generation);
}

function installHooks(): void {
  if (hooksInstalled) return;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const explicit = generationOf(specifier);
      const generation = explicit ?? generationOf(context.parentURL);
      if (!generation) return nextResolve(specifier, context);
      if (explicit) {
        const url = sourceURL(specifier, generation);
        if (!url) throw failure('EXTENSION_SOURCE_INVALID', 'The extension module URL is invalid.');
        return { url, format: 'module', shortCircuit: true };
      }
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {
        const url = sourceURL(new URL(specifier, context.parentURL).href, generation);
        if (url) return { url, format: 'module', shortCircuit: true };
      }
      const result = nextResolve(specifier, context);
      const url = sourceURL(result.url, generation);
      return url ? { ...result, url, format: 'module' } : result;
    },
    load(url, context, nextLoad) {
      const generation = generationOf(url);
      if (!generation) return nextLoad(url, context);
      const source = generation.sources.get(fileURLToPath(url));
      if (source === undefined) throw failure('EXTENSION_SOURCE_UNAVAILABLE', 'The extension module source is unavailable.');
      return { format: 'module', source, shortCircuit: true };
    },
  });
  hooksInstalled = true;
}

function interrupted(signal: AbortSignal): ModuleLoaderError {
  const reason: unknown = signal.reason;
  const code = reason instanceof Error && 'code' in reason ? reason.code : undefined;
  const timeout = reason instanceof Error && (reason.name === 'TimeoutError'
    || (typeof code === 'string' && /TIMEOUT|DEADLINE/.test(code)));
  return timeout
    ? failure('EXTENSION_RELOAD_TIMEOUT', 'Loading the extension exceeded its deadline; module evaluation may still be running.')
    : failure('EXTENSION_RELOAD_ABORTED', 'Waiting for the extension load was cancelled; module evaluation may still be running.');
}

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw interrupted(signal);
}

function waitFor<Value>(operation: Promise<Value>, signal: AbortSignal | undefined): Promise<Value> {
  if (!signal) return operation;
  return new Promise((accept, reject) => {
    const aborted = () => reject(interrupted(signal));
    if (signal.aborted) { void operation.catch(() => {}); aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(value => {
      signal.removeEventListener('abort', aborted);
      if (signal.aborted) aborted();
      else accept(value);
    }, error => {
      signal.removeEventListener('abort', aborted);
      reject(error);
    });
  });
}

function identity(stat: Awaited<ReturnType<typeof lstat>>): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

async function collectSources(root: string, signal: AbortSignal | undefined,
  existing?: ReadonlyMap<string, SourceFile>): Promise<Map<string, SourceFile>> {
  const files = new Map<string, SourceFile>();
  let totalBytes = 0;
  let entries = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    checkSignal(signal);
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await realpath(directory) !== directory) {
      throw failure('EXTENSION_SOURCE_INVALID', 'Extension source directories must be ordinary directories without symbolic links.');
    }
    const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const child of children) {
      checkSignal(signal);
      entries++;
      if (entries > maximumEntries) throw failure('EXTENSION_SOURCE_LIMIT', 'The extension source tree has too many directory entries.');
      if (excludedName(child.name) || excludedDirectories.has(child.name)) continue;
      const filename = join(directory, child.name);
      if (child.isDirectory()) {
        if (depth >= maximumDepth) throw failure('EXTENSION_SOURCE_LIMIT', 'The extension source tree exceeds the directory depth limit.');
        await visit(filename, depth + 1);
        continue;
      }
      if (child.isSymbolicLink()) throw failure('EXTENSION_SOURCE_INVALID', 'Symbolic links are not supported in the extension source tree.');
      if (!isSource(filename)) continue;
      if (files.size >= maximumFiles) throw failure('EXTENSION_SOURCE_LIMIT', 'The extension source tree has too many source files.');
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumFileBytes) {
        throw failure('EXTENSION_SOURCE_INVALID', 'Extension source must be ordinary files within the file size limit.');
      }
      totalBytes += stat.size;
      if (totalBytes > maximumTotalBytes) throw failure('EXTENSION_SOURCE_LIMIT', 'The extension source tree exceeds the total byte limit.');
      const stamp = identity(stat);
      if (existing) {
        const previous = existing.get(filename);
        if (!previous || previous.identity !== stamp) throw failure('EXTENSION_SOURCE_CHANGED', 'Extension source changed while preparing a snapshot; retry after saving the source.');
        files.set(filename, previous);
        continue;
      }
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || identity(opened) !== stamp) throw failure('EXTENSION_SOURCE_CHANGED', 'Extension source changed while opening a source file.');
        const buffer = Buffer.alloc(Math.min(stat.size + 1, maximumFileBytes + 1));
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, null);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
          checkSignal(signal);
        }
        if (length !== stat.size || identity(await handle.stat()) !== stamp) throw failure('EXTENSION_SOURCE_CHANGED', 'Extension source changed while reading a source file.');
        const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
        files.set(filename, { source, identity: stamp });
      } finally {
        await handle.close();
      }
    }
  }
  await visit(root, 0);
  if (existing && files.size !== existing.size) throw failure('EXTENSION_SOURCE_CHANGED', 'Extension source files changed while preparing the snapshot.');
  return files;
}

async function loadVersion(state: LoaderState, signal: AbortSignal | undefined): Promise<ExtensionModuleVersion> {
  try {
    checkSignal(signal);
    const files = await collectSources(state.root, signal);
    if (!files.has(state.entry)) throw failure('EXTENSION_SOURCE_INVALID', 'The extension entry must be an included ordinary ESM source file.');
    await collectSources(state.root, signal, files);
    const hash = createHash('sha256').update('qbf-extension-esm-v1\0').update(relative(state.root, state.entry)).update('\0');
    for (const [filename, file] of files) {
      hash.update(JSON.stringify([relative(state.root, filename), Buffer.byteLength(file.source)])).update('\0').update(file.source).update('\0');
    }
    const revision = hash.digest('hex');
    const previous = state.versions.get(revision);
    if (previous) return await previous.result;
    if (state.versions.size >= state.maximumVersions) {
      throw failure('EXTENSION_RELOAD_LIMIT', 'The extension reached its module generation limit; the running version remains available. Restart the host to load further code versions.');
    }
    const sources = new Map<string, string>();
    const additions = new Map<string, string>();
    let additionalBytes = 0;
    for (const [filename, file] of files) {
      checkSignal(signal);
      // Parse the whole snapshot before reserving a cache generation. No TypeScript runtime dependency.
      const javascript = stripTypeScriptTypes(file.source, { mode: 'strip' });
      // Node's internal referrer retains the generation URL, while resource/config reads see the original file.
      const body = javascript.replace(/^#![^\r\n]*/, '');
      const source = `import.meta.url = ${JSON.stringify(pathToFileURL(filename).href)};\n${body}`;
      const sourceKey = createHash('sha256').update(source).digest('hex');
      const retained = state.sourcePool.get(sourceKey) ?? additions.get(sourceKey);
      if (retained === undefined) {
        additionalBytes += Buffer.byteLength(source);
        if (state.retainedSourceBytes + additionalBytes > state.maximumRetainedSourceBytes) {
          throw failure('EXTENSION_RELOAD_LIMIT', 'The extension reached its retained source byte limit; the running version remains available. Restart the host to load further code versions.');
        }
        additions.set(sourceKey, source);
      }
      sources.set(filename, retained ?? source);
    }
    checkSignal(signal);
    installHooks();
    // Keep unchanged source text shared across generations. Modules and lazy local imports
    // retain their original generation identity; do not evict source needed by old tasks.
    for (const [key, source] of additions) state.sourcePool.set(key, source);
    state.retainedSourceBytes += additionalBytes;
    const generation: Generation = { token: randomUUID(), root: state.root, sources,
      result: Promise.resolve({ revision, namespace: undefined }) };
    generations.set(generation.token, generation);
    state.versions.set(revision, generation);
    generation.result = import(taggedURL(state.entry, generation)).then((namespace: unknown) =>
      Object.freeze({ revision, namespace }), (error: unknown) => {
      if (error instanceof ModuleLoaderError) throw error;
      throw failure('EXTENSION_MODULE_LOAD_FAILED', 'The extension module could not be loaded; its running version remains available.');
    });
    return await generation.result;
  } catch (error) {
    // Parser/import diagnostics may contain source excerpts or private data: never expose their message/cause.
    if (error instanceof ModuleLoaderError) throw error;
    throw failure('EXTENSION_MODULE_LOAD_FAILED', 'The extension source could not be read or parsed; its running version remains available.');
  }
}

/**
 * Versioned ESM loading for operator-selected, trusted local source. This is not a security sandbox:
 * module evaluation has host-process privileges and cannot be forcibly stopped by AbortSignal.
 * Snapshots cover ESM .ts/.mts/.js/.mjs source, not JSON, resources, tests or installed dependencies.
 * Resources/configuration should be read through the original import.meta.url or host services.
 */
export function createExtensionModuleLoader(options: ExtensionModuleLoaderOptions): ExtensionModuleLoader {
  if (!options || typeof options.entry !== 'string' || !isAbsolute(options.entry) || options.entry.includes('\0')
    || (options.root !== undefined && (typeof options.root !== 'string' || !isAbsolute(options.root) || options.root.includes('\0')))) {
    throw failure('EXTENSION_SOURCE_INVALID', 'An absolute operator-selected extension entry and root are required.');
  }
  const entry = resolve(options.entry);
  const root = resolve(options.root ?? dirname(entry));
  const maximumVersions = options.maxVersions ?? 64;
  const maximumRetainedSourceBytes = options.maxRetainedSourceBytes ?? 64 * 1024 * 1024;
  if (!within(root, entry) || !isSource(entry) || !Number.isSafeInteger(maximumVersions) || maximumVersions < 1 || maximumVersions > 64
    || !Number.isSafeInteger(maximumRetainedSourceBytes) || maximumRetainedSourceBytes < 1 || maximumRetainedSourceBytes > 512 * 1024 * 1024) {
    throw failure('EXTENSION_SOURCE_INVALID', 'The extension entry, source root or generation limit is invalid.');
  }
  const key = JSON.stringify([root, entry]);
  let state = loaders.get(key);
  if (!state) {
    state = { root, entry, versions: new Map(), sourcePool: new Map(), retainedSourceBytes: 0,
      maximumRetainedSourceBytes, maximumVersions, busy: false };
    loaders.set(key, state);
  } else {
    state.maximumVersions = Math.min(state.maximumVersions, maximumVersions);
    state.maximumRetainedSourceBytes = Math.min(state.maximumRetainedSourceBytes, maximumRetainedSourceBytes);
  }
  const shared = state;
  return Object.freeze({
    load(signal?: AbortSignal): Promise<ExtensionModuleVersion> {
      if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(failure('EXTENSION_SOURCE_INVALID', 'The extension load signal is invalid.'));
      if (signal?.aborted) return Promise.reject(interrupted(signal));
      if (shared.busy) return Promise.reject(failure('EXTENSION_RELOAD_BUSY', 'An extension load is already in progress.'));
      shared.busy = true;
      const operation = loadVersion(shared, signal).finally(() => { shared.busy = false; });
      // Keep busy until actual evaluation settles, even after a caller stops waiting.
      return waitFor(operation, signal);
    },
  });
}
