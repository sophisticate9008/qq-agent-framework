import { FrameworkError, assert, identifier, snapshot } from '../core/values.ts'
import { NATIVE_REVISION_PATTERN } from '../contracts/native-revisions.ts'
import { reloadableExtensionErrorCode } from '../contracts/reloadable-extensions.ts'
import type { ReloadableExtensionRegistration, ReloadableExtensionRegistry,
  ReloadableExtensionResult, ReloadableExtensionStatus } from '../contracts/reloadable-extensions.ts'

export type { ReloadableExtensionRegistration, ReloadableExtensionRegistry,
  ReloadableExtensionResult, ReloadableExtensionStatus } from '../contracts/reloadable-extensions.ts'

export interface ReloadableExtensionCandidate<Value> {
  readonly revision: string
  readonly value: Value
  readonly dispose?: () => void | Promise<void>
}

export interface ReloadableExtension<Value> extends ReloadableExtensionRegistration {
  /** Borrow only for synchronous inspection. Use withCurrent for work with a lifetime. */
  current(): Value
  withCurrent<Result>(run: (value: Value) => Result | Promise<Result>): Promise<Result>
  close(): Promise<void>
}

function fail(code: string): never {
  throw new FrameworkError(code, 'The extension operation could not be completed.')
}

function revision(value: unknown): value is string {
  return typeof value === 'string' && NATIVE_REVISION_PATTERN.test(value)
}

function metadata(id: unknown, displayName: unknown): void {
  assert(identifier(id) && typeof displayName === 'string' && displayName.trim().length > 0
    && displayName.length <= 80 && !/[\x00-\x1f\x7f]/.test(displayName),
  'EXTENSION_METADATA_INVALID', 'Expected bounded extension metadata.')
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Project an allowlist of bounded fields instead of serializing plugin-owned objects. */
function observation(extension: ReloadableExtensionRegistration): ReloadableExtensionStatus {
  const state = extension.describe()
  assert(state.id === extension.id && state.displayName === extension.displayName && revision(state.currentRevision)
    && count(state.activeCalls) && typeof state.reloading === 'boolean' && typeof state.closed === 'boolean'
    && (state.error === null || typeof state.error === 'string' && /^[A-Z][A-Z_]{1,63}$/.test(state.error))
    && (state.retiring === null || revision(state.retiring.revision) && count(state.retiring.activeCalls)),
  'EXTENSION_STATUS_INVALID', 'Expected bounded extension status.')
  return snapshot({ id: extension.id, displayName: extension.displayName, currentRevision: state.currentRevision,
    activeCalls: state.activeCalls, retiring: state.retiring === null ? null
      : { revision: state.retiring.revision, activeCalls: state.retiring.activeCalls },
    reloading: state.reloading, closed: state.closed, error: state.error })
}

/** Only explicitly registered extensions can be addressed; no caller-provided source path is accepted. */
export function createReloadableExtensionRegistry(): ReloadableExtensionRegistry {
  const entries = new Map<string, ReloadableExtensionRegistration>()
  const busy = new Set<string>()
  return Object.freeze({
    register(extension: ReloadableExtensionRegistration) {
      metadata(extension.id, extension.displayName)
      assert(typeof extension.reload === 'function' && typeof extension.describe === 'function',
        'EXTENSION_REGISTRATION_INVALID', 'Expected reload and status callbacks.')
      if (entries.has(extension.id)) fail('EXTENSION_ALREADY_REGISTERED')
      if (entries.size >= 128) fail('EXTENSION_REGISTRY_FULL')
      observation(extension)
      entries.set(extension.id, extension)
      return () => { if (entries.get(extension.id) === extension) entries.delete(extension.id) }
    },
    list() { return Object.freeze([...entries.values()].map(observation)) },
    async reload(id: string, expectedRevision: string, signal?: AbortSignal) {
      if (!identifier(id) || !revision(expectedRevision)) fail('EXTENSION_RELOAD_INVALID')
      signal?.throwIfAborted()
      const extension = entries.get(id)
      if (!extension) fail('EXTENSION_NOT_FOUND')
      if (busy.has(id)) fail('EXTENSION_RELOAD_BUSY')
      if (observation(extension).currentRevision !== expectedRevision) fail('EXTENSION_REVISION_CONFLICT')
      busy.add(id)
      try {
        const result = await extension.reload(signal)
        assert(result.id === id && result.previousRevision === expectedRevision && revision(result.currentRevision)
          && result.changed === (result.currentRevision !== expectedRevision) && typeof result.draining === 'boolean',
        'EXTENSION_RESULT_INVALID', 'Expected bounded extension reload result.')
        return snapshot({ id, previousRevision: expectedRevision, currentRevision: result.currentRevision,
          changed: result.changed, draining: result.draining })
      } catch (error) {
        fail(reloadableExtensionErrorCode(error))
      } finally { busy.delete(id) }
    },
  })
}

interface Generation<Value> {
  readonly candidate: ReloadableExtensionCandidate<Value>
  activeCalls: number
  disposing: boolean
  error: string | null
  readonly disposed: Promise<string | null>
  readonly finish: (error: string | null) => void
}

function generation<Value>(candidate: ReloadableExtensionCandidate<Value>): Generation<Value> {
  let finish: (error: string | null) => void = () => {}
  const disposed = new Promise<string | null>(resolve => { finish = resolve })
  return { candidate, activeCalls: 0, disposing: false, error: null, disposed, finish }
}

/**
 * load prepares an isolated candidate. It must not publish registrations or start recurring work
 * during validation. Callers own activation details and route all asynchronous work through leases.
 * A rejected prepare keeps the current generation. At most one old/candidate generation may drain.
 */
export async function createReloadableExtension<Value>(options: {
  readonly id: string
  readonly displayName: string
  readonly load: (signal: AbortSignal) => Promise<ReloadableExtensionCandidate<Value>>
  /** Runs before activation; a rejected candidate follows the ordinary tracked disposal path. */
  readonly validate?: (value: Value) => void | Promise<void>
  readonly signal?: AbortSignal
}): Promise<ReloadableExtension<Value>> {
  metadata(options.id, options.displayName)
  assert(typeof options.load === 'function' && (options.validate === undefined || typeof options.validate === 'function'),
    'EXTENSION_LOADER_INVALID', 'Expected an extension loader and optional candidate validator.')
  const controller = new AbortController()
  const lifetime = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  lifetime.throwIfAborted()
  let current: Generation<Value> | undefined
  let retiring: Generation<Value> | undefined
  let closed = false
  let lastError: string | null = null
  let pending: Promise<ReloadableExtensionResult> | undefined
  let closing: Promise<void> | undefined

  function dispose(item: Generation<Value>): void {
    if (item.activeCalls > 0 || item.disposing) return
    item.disposing = true
    if (!item.candidate.dispose) {
      if (retiring === item) retiring = undefined
      item.finish(null)
      return
    }
    void Promise.resolve().then(() => item.candidate.dispose?.()).then(() => {
      if (retiring === item) retiring = undefined
      item.finish(null)
    }, error => {
      item.error = reloadableExtensionErrorCode(error, 'EXTENSION_DISPOSE_FAILED')
      lastError = item.error
      item.finish(item.error)
    })
  }

  async function discard(item: Generation<Value>): Promise<void> {
    retiring = item
    dispose(item)
    const error = await item.disposed
    if (error) fail(error)
  }

  async function prepare(signal: AbortSignal): Promise<Generation<Value>> {
    const loaded = await options.load(signal)
    assert(loaded !== null && typeof loaded === 'object', 'EXTENSION_CANDIDATE_INVALID', 'Expected a prepared extension candidate.')
    // Capture metadata/callbacks once: a caller mutating its descriptor cannot change a live revision.
    const candidate = Object.freeze({ revision: loaded.revision, value: loaded.value, dispose: loaded.dispose })
    const item = generation(candidate)
    if (!revision(candidate.revision) || candidate.dispose !== undefined && typeof candidate.dispose !== 'function') {
      // Preserve a valid cleanup callback even when the revision is malformed.
      if (typeof candidate.dispose === 'function') await discard(item)
      fail('EXTENSION_CANDIDATE_INVALID')
    }
    try {
      await options.validate?.(candidate.value)
    } catch (error) {
      await discard(item)
      throw error
    }
    return item
  }

  try {
    const initial = await prepare(lifetime)
    if (lifetime.aborted) {
      await discard(initial)
      lifetime.throwIfAborted()
    }
    current = initial
  } catch (error) {
    controller.abort()
    throw error
  }

  function requireCurrent(): Generation<Value> {
    if (closed || lifetime.aborted || !current) fail('EXTENSION_CLOSED')
    return current
  }

  async function replace(signal?: AbortSignal): Promise<ReloadableExtensionResult> {
    const previous = requireCurrent()
    if (retiring) fail('EXTENSION_DRAINING')
    const combined = signal ? AbortSignal.any([lifetime, signal]) : lifetime
    combined.throwIfAborted()
    const candidate = await prepare(combined)
    try {
      combined.throwIfAborted()
      if (closed) fail('EXTENSION_CLOSED')
    } catch (error) {
      await discard(candidate)
      throw error
    }
    lastError = null
    const changed = candidate.candidate.revision !== previous.candidate.revision
    if (!changed) await discard(candidate)
    else {
      current = candidate
      retiring = previous
      dispose(previous)
    }
    return snapshot({ id: options.id, previousRevision: previous.candidate.revision,
      currentRevision: current!.candidate.revision, changed, draining: retiring !== undefined })
  }

  const extension: ReloadableExtension<Value> = Object.freeze({
    id: options.id,
    displayName: options.displayName,
    current() { return requireCurrent().candidate.value },
    async withCurrent<Result>(run: (value: Value) => Result | Promise<Result>): Promise<Result> {
      const item = requireCurrent()
      item.activeCalls++
      try { return await run(item.candidate.value) }
      finally {
        item.activeCalls--
        if (closed || retiring === item) dispose(item)
      }
    },
    reload(signal?: AbortSignal) {
      requireCurrent()
      if (pending) fail('EXTENSION_RELOAD_BUSY')
      // Defer the loader until pending is visible, including to reentrant loaders.
      const task = Promise.resolve().then(() => replace(signal)).catch(error => {
        lastError = retiring?.error ?? reloadableExtensionErrorCode(error)
        throw error
      }).finally(() => { if (pending === task) pending = undefined })
      pending = task
      return task
    },
    describe() {
      return snapshot({ id: options.id, displayName: options.displayName, currentRevision: current!.candidate.revision,
        activeCalls: current!.activeCalls, retiring: retiring ? { revision: revision(retiring.candidate.revision)
          ? retiring.candidate.revision : '0'.repeat(64),
          activeCalls: retiring.activeCalls } : null, reloading: pending !== undefined,
        closed: closed || lifetime.aborted, error: retiring?.error ?? lastError })
    },
    close() {
      if (closing) return closing
      closed = true
      lifetime.removeEventListener('abort', stopped)
      controller.abort()
      closing = Promise.resolve().then(async () => {
        if (pending) await pending.catch(() => {})
        const items = [...new Set([current, retiring].filter((item): item is Generation<Value> => item !== undefined))]
        for (const item of items) dispose(item)
        const errors = await Promise.all(items.map(item => item.disposed))
        const error = errors.find((value): value is string => value !== null)
        if (error) fail(error)
      })
      return closing
    },
  })

  function stopped(): void {
    // The close promise remains observable by explicit close(); status records cleanup failures.
    void extension.close().catch(error => { lastError = reloadableExtensionErrorCode(error, 'EXTENSION_DISPOSE_FAILED') })
  }
  lifetime.addEventListener('abort', stopped, { once: true })
  if (lifetime.aborted) stopped()
  return extension
}
