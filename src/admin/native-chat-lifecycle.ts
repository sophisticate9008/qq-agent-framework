import { FrameworkError, isRecord } from '../core/values.ts'
import { NATIVE_CONFIGURATION_REVISION_KEYS as revisionKeys, isNativeConfigurationRevisions } from '../contracts/native-revisions.ts'

export const NATIVE_CHAT_LIFECYCLE_FILE = 'native-chat-lifecycle.json'

export type { NativeChatRunningIntent, NativeChatLifecycleDocument, NativeChatLifecycleStatus,
  NativeChatRestoreResult } from '../contracts/native-lifecycle.ts'
import type { NativeChatRunningIntent, NativeChatLifecycleDocument, NativeChatLifecycleStatus,
  NativeChatRestoreResult } from '../contracts/native-lifecycle.ts'

export const DEFAULT_NATIVE_CHAT_RUNNING_INTENT: NativeChatRunningIntent = Object.freeze({
  schema: 1, desiredRunning: false, revisions: null, updatedAt: 0
})

function fail(code: string): never {
  throw new FrameworkError(code, 'Native chat running intent could not be verified or persisted.')
}

function revisions(value: unknown): Readonly<Record<string, string>> {
  if (!isNativeConfigurationRevisions(value)) {
    fail('NATIVE_CHAT_LIFECYCLE_INVALID')
  }
  return Object.freeze(Object.fromEntries(revisionKeys.map(key => [key, String(value[key])])))
}

function sameRevisions(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return revisionKeys.every(key => left[key] === right[key])
}

export function validateNativeChatRunningIntent(value: unknown): NativeChatRunningIntent {
  if (!isRecord(value) || value.schema !== 1 || typeof value.desiredRunning !== 'boolean'
    || Object.keys(value).length !== 4 || !Object.keys(value).every(key => ['schema', 'desiredRunning', 'revisions', 'updatedAt'].includes(key))
    || typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
    || value.desiredRunning && value.revisions === null) fail('NATIVE_CHAT_LIFECYCLE_INVALID')
  return Object.freeze({ schema: 1, desiredRunning: value.desiredRunning,
    revisions: value.revisions === null ? null : revisions(value.revisions), updatedAt: value.updatedAt })
}

export function createNativeChatLifecycle<Status extends NativeChatLifecycleStatus>(options: {
  readonly runtime: {
    status(): Promise<Status>
    start(revisions: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void>
    stop(): Promise<void>
  }
  readonly read: () => Promise<NativeChatLifecycleDocument>
  readonly write: (previous: NativeChatLifecycleDocument, value: NativeChatRunningIntent) => Promise<NativeChatLifecycleDocument>
  readonly runExclusive: <Result>(operation: () => Promise<Result>, purpose?: 'start' | 'stop' | 'restore') => Promise<Result>
}) {
  let restoration: NativeChatRestoreResult = Object.freeze({ state: 'not-attempted', reason: null })
  let restoreTask: Promise<NativeChatRestoreResult> | undefined

  function verifiedStarted(status: Status, expected: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    const actual = revisions(status.activeRevisions)
    if (status.state !== 'running' || !sameRevisions(actual, expected) || !sameRevisions(revisions(status.revisions), actual)) {
      fail('NATIVE_CHAT_LIFECYCLE_START_UNVERIFIED')
    }
    return actual
  }

  async function start(expected: Readonly<Record<string, string>>, signal: AbortSignal): Promise<Status> {
    const requested = revisions(expected)
    return options.runExclusive(async () => {
      const previous = await options.read()
      signal.throwIfAborted()
      await options.runtime.start(requested, signal)
      const status = await options.runtime.status()
      const actual = verifiedStarted(status, requested)
      signal.throwIfAborted()
      try {
        await options.write(previous, { schema: 1, desiredRunning: true, revisions: actual, updatedAt: Date.now() })
      } catch { fail('NATIVE_CHAT_LIFECYCLE_WRITE_FAILED') }
      return status
    }, 'start')
  }

  async function stop(maintenance: boolean): Promise<Status> {
    return options.runExclusive(async () => {
      if (!maintenance) {
        const previous = await options.read()
        try {
          await options.write(previous, { schema: 1, desiredRunning: false, revisions: previous.value.revisions, updatedAt: Date.now() })
        } catch { fail('NATIVE_CHAT_LIFECYCLE_WRITE_FAILED') }
      }
      await options.runtime.stop()
      return options.runtime.status()
    }, 'stop')
  }

  function restore(signal: AbortSignal): Promise<NativeChatRestoreResult> {
    if (restoreTask) return restoreTask
    restoration = Object.freeze({ state: 'checking', reason: null })
    const skipped = (reason: string): NativeChatRestoreResult => ({ state: 'skipped', reason })
    let abort: (() => void) | undefined
    const cancelled = new Promise<NativeChatRestoreResult>(resolve => {
      abort = () => resolve({ state: 'failed', reason: 'startup_restore_aborted_or_unknown' })
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    const operation = (async (): Promise<NativeChatRestoreResult> => {
      signal.throwIfAborted()
      const initial = await options.read()
      if (!initial.exists) return skipped('no_previous_running_intent')
      if (!initial.value.desiredRunning) return skipped('explicitly_stopped')
      return options.runExclusive(async (): Promise<NativeChatRestoreResult> => {
      signal.throwIfAborted()
      const intent = await options.read()
      if (intent.revision !== initial.revision) return skipped('running_intent_changed')
      if (!intent.exists) return skipped('no_previous_running_intent')
      if (!intent.value.desiredRunning) return skipped('explicitly_stopped')
      const expected = revisions(intent.value.revisions)
      const status = await options.runtime.status()
      signal.throwIfAborted()
      if (status.state !== 'stopped' && status.state !== 'error') return skipped('runtime_not_stopped')
      if (!sameRevisions(expected, revisions(status.revisions))) return skipped('configuration_changed')
      if (status.canStart !== true) return skipped('runtime_not_ready')
      const latest = await options.read()
      if (latest.revision !== intent.revision || !latest.value.desiredRunning) return skipped('running_intent_changed')
      signal.throwIfAborted()
      await options.runtime.start(expected, signal)
      signal.throwIfAborted()
      verifiedStarted(await options.runtime.status(), expected)
      return { state: 'restored', reason: null }
      }, 'restore')
    })().catch((): NativeChatRestoreResult => ({ state: 'failed', reason: 'startup_restore_failed' }))
    const task = Promise.race([operation, cancelled]).then(result => {
      restoration = Object.freeze(result)
      return restoration
    }).finally(() => { if (abort) signal.removeEventListener('abort', abort) })
    restoreTask = task
    // Deduplicate in-flight work, not its historical outcome. Wait for the actual
    // operation even when cancellation wins the race before permitting another try.
    void operation.finally(() => {
      void task.finally(() => { if (restoreTask === task) restoreTask = undefined })
    })
    return task
  }

  async function describe() {
    try {
      const document = await options.read()
      return { persistence: document.exists ? 'available' : 'missing', desiredRunning: document.exists ? document.value.desiredRunning : null,
        revisions: document.value.revisions, restoration }
    } catch {
      return { persistence: 'unavailable', desiredRunning: null, revisions: null, restoration }
    }
  }

  return Object.freeze({ start, stop, restore, describe })
}
