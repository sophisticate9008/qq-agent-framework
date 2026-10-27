import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { FrameworkError } from '../core/values.ts'
import type { DurableStore } from '../contracts/ports.ts'
import type { NativeMemoryReadOptions } from '../contracts/native-memory.ts'
import { createNativeDurableStore as createSqliteStore } from './native-retention.ts'
type SqliteStore = ReturnType<typeof createSqliteStore>
import { openReadonlySqliteStore } from '../storage/sqlite-readonly.ts'
import { createNativeMemoryService, readNativeMemoryEntries, readNativeMemoryEntry, type NativeMemoryOptions,
  type NativeMemoryService } from './native-memory.ts'

/** Management reads never create a database; owner writes and explicit startup can open the private store. */
export function createNativeMemoryRuntime(options: Omit<NativeMemoryOptions, 'store'> & { readonly directory: string }) {
  const filename = join(options.directory, 'native-memory.sqlite')
  let store: SqliteStore | undefined
  let service: NativeMemoryService | undefined
  let closed = false
  let started = false
  const lifetime = new AbortController()
  const empty: Pick<DurableStore, 'read' | 'list'> = { read: () => null, list: () => [] }
  function active(): void { if (closed) throw new FrameworkError('NATIVE_CHAT_CLOSED', 'The memory runtime is closed.') }
  function unsafe(): never { throw new FrameworkError('MEMORY_STORAGE_UNSAFE', 'The private memory storage is unavailable.') }
  function prepareDirectory(): void {
    const directory = options.directory
    if (!isAbsolute(directory) || resolve(directory) !== directory || /[\u0000-\u001f\u007f]/.test(directory)) unsafe()
    try {
      try { lstatSync(directory) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        const parent = lstatSync(dirname(directory))
        if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(dirname(directory)) !== dirname(directory)
          || (parent.mode & 0o022) !== 0 || typeof process.getuid === 'function' && parent.uid !== process.getuid()) unsafe()
        try { mkdirSync(directory, { mode: 0o700 }) }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
      }
      const metadata = lstatSync(directory)
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(directory) !== directory || (metadata.mode & 0o777) !== 0o700
        || typeof process.getuid === 'function' && metadata.uid !== process.getuid()) unsafe()
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try {
          const file = lstatSync(filename + suffix)
          if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600
            || typeof process.getuid === 'function' && file.uid !== process.getuid()) unsafe()
        } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      }
    } catch { unsafe() }
  }
  function read<Value>(projection: (store: Pick<DurableStore, 'read' | 'list'>) => Value): Value {
    active()
    if (store) return projection(store)
    let existing: ReturnType<typeof openReadonlySqliteStore>
    try { existing = openReadonlySqliteStore(filename) }
    catch (error) { if (error instanceof FrameworkError && error.code === 'STORE_NOT_FOUND') return projection(empty); throw error }
    try { return existing.withSnapshot(() => projection(existing)) } finally { existing.close() }
  }
  function getService(): NativeMemoryService {
    active()
    if (service) return service
    prepareDirectory()
    store ??= createSqliteStore({ filename, ...(options.clock === undefined ? {} : { clock: options.clock }) })
    service = createNativeMemoryService({ ...options, store,
      async authorizeSource(source, scope, signal) {
        active(); const combined = AbortSignal.any([signal, lifetime.signal]); combined.throwIfAborted()
        await options.authorizeSource(source, scope, combined); combined.throwIfAborted(); active()
      },
      async authorizeOwner(authority, signal) {
        active(); const combined = AbortSignal.any([signal, lifetime.signal]); combined.throwIfAborted()
        await options.authorizeOwner(authority, combined); combined.throwIfAborted(); active()
      },
      async authorizeRead(conversationId, userId, signal) {
        active(); const combined = AbortSignal.any([signal, lifetime.signal]); combined.throwIfAborted()
        await options.authorizeRead(conversationId, userId, combined); combined.throwIfAborted(); active()
      } })
    return service
  }
  return Object.freeze({
    service: getService,
    read(readOptions: NativeMemoryReadOptions = {}) { return read(store => readNativeMemoryEntries(store, { ...readOptions, clock: options.clock })) },
    entry(id: string) { return read(store => readNativeMemoryEntry(store, id, options.clock)) },
    start() { const value = getService(); value.prepare(); started = true; return value },
    stop() { started = false },
    close() { if (closed) return; closed = true; started = false; lifetime.abort(); store?.close(); store = undefined },
    status() { return Object.freeze({ schema: 1 as const, owner: 'memory' as const, started, opened: store !== undefined, closed }) }
  })
}
export type NativeMemoryRuntime = ReturnType<typeof createNativeMemoryRuntime>
