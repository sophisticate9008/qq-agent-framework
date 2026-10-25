import type { JsonObject } from '../core/types.ts'
import { assert, FrameworkError, identifier, isRecord, snapshot } from '../core/values.ts'
import { withDeadline } from './deadlines.ts'

export type LifecycleCheckpoint = 'runtime.starting' | 'runtime.ready' | 'runtime.stopping' | 'runtime.stopped'
  | 'message.normalized' | 'message.admitted' | 'message.rejected' | 'agent.submitting' | 'agent.submitted'
  | 'send.before' | 'send.after' | 'access.changed'

export interface LifecycleHookDefinition {
  readonly id: string
  readonly checkpoint: LifecycleCheckpoint
  readonly kind: 'guard' | 'observe'
  readonly order?: number
  readonly timeoutMs?: number
  readonly run: (request: { readonly checkpoint: LifecycleCheckpoint; readonly data: Readonly<JsonObject>;
    readonly signal: AbortSignal }) => void | Promise<void>
}

export interface LifecycleHookFault {
  readonly id: string
  readonly checkpoint: LifecycleCheckpoint
  readonly kind: 'guard' | 'observe'
  readonly code: string
}

const checkpoints: readonly LifecycleCheckpoint[] = ['runtime.starting', 'runtime.ready', 'runtime.stopping', 'runtime.stopped',
  'message.normalized', 'message.admitted', 'message.rejected', 'agent.submitting', 'agent.submitted',
  'send.before', 'send.after', 'access.changed']
const guarded: readonly LifecycleCheckpoint[] = ['runtime.starting', 'message.admitted', 'agent.submitting', 'send.before']

function plain(value: unknown, keys?: readonly string[]): asserts value is Record<string, unknown> {
  assert(isRecord(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && (!keys || keys.includes(key))
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')),
  'INVALID_LIFECYCLE_HOOKS', 'Hook declarations must be plain data properties without unexpected fields.')
}

export function createLifecycleHooks(definitions: readonly LifecycleHookDefinition[], options: {
  readonly onFault?: (fault: Readonly<LifecycleHookFault>) => void
} = {}) {
  plain(options, ['onFault'])
  assert(options.onFault === undefined || typeof options.onFault === 'function',
    'INVALID_LIFECYCLE_HOOKS', 'A hook fault observer must be a function.')
  assert(Array.isArray(definitions) && definitions.length <= 64
    && Reflect.ownKeys(definitions).length === definitions.length + 1,
  'INVALID_LIFECYCLE_HOOKS', 'At most 64 densely declared hooks are supported.')
  const ids = new Set<string>()
  const hooks: Readonly<Required<LifecycleHookDefinition>>[] = []
  for (let index = 0; index < definitions.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(definitions, String(index))
    assert(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'),
      'INVALID_LIFECYCLE_HOOKS', 'Hooks must be own data entries.')
    const entry: unknown = descriptor.value
    plain(entry, ['id', 'checkpoint', 'kind', 'order', 'timeoutMs', 'run'])
    assert(Object.hasOwn(entry, 'id') && Object.hasOwn(entry, 'checkpoint') && Object.hasOwn(entry, 'kind') && Object.hasOwn(entry, 'run')
      && identifier(entry.id) && !ids.has(entry.id)
      && checkpoints.includes(entry.checkpoint as LifecycleCheckpoint)
      && (entry.kind === 'guard' || entry.kind === 'observe')
      && (entry.kind !== 'guard' || guarded.includes(entry.checkpoint as LifecycleCheckpoint))
      && (entry.order === undefined || typeof entry.order === 'number' && Number.isSafeInteger(entry.order))
      && (entry.timeoutMs === undefined || typeof entry.timeoutMs === 'number'
        && Number.isSafeInteger(entry.timeoutMs) && entry.timeoutMs >= 1 && entry.timeoutMs <= 30_000)
      && typeof entry.run === 'function',
    'INVALID_LIFECYCLE_HOOKS', 'Hook identity, checkpoint, kind, order, timeout and callback must be valid.')
    ids.add(entry.id)
    hooks.push(Object.freeze({ id: entry.id, checkpoint: entry.checkpoint as LifecycleCheckpoint, kind: entry.kind,
      order: entry.order === undefined ? 0 : entry.order as number,
      timeoutMs: entry.timeoutMs === undefined ? 1_000 : entry.timeoutMs as number,
      run: entry.run as LifecycleHookDefinition['run'] }))
  }
  hooks.sort((left, right) => left.order < right.order ? -1 : left.order > right.order ? 1
    : left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  const lifetime = new AbortController()
  const onFault = options.onFault
  let pendingRaw = 0
  let faults = 0
  let lastFault: Readonly<LifecycleHookFault> | null = null

  function usable(signal: AbortSignal) {
    assert(!lifetime.signal.aborted, 'LIFECYCLE_HOOK_CLOSED', 'The lifecycle hook runner is closed.')
    assert(!signal.aborted, 'LIFECYCLE_HOOK_ABORTED', 'Lifecycle execution was cancelled.')
  }

  function fault(hook: Readonly<Required<LifecycleHookDefinition>>, code: string) {
    lastFault = snapshot({ id: hook.id, checkpoint: hook.checkpoint, kind: hook.kind, code })
    faults = Math.min(Number.MAX_SAFE_INTEGER, faults + 1)
    try { void Promise.resolve(onFault?.(lastFault)).catch(() => {}) } catch {}
  }

  return Object.freeze({
    async run(checkpoint: LifecycleCheckpoint, data: Readonly<JsonObject>, signal: AbortSignal): Promise<void> {
      assert(checkpoints.includes(checkpoint) && signal instanceof AbortSignal,
        'INVALID_LIFECYCLE_HOOKS', 'A known checkpoint and cancellation signal are required.')
      usable(signal)
      plain(data)
      const immutable = snapshot(data)
      const combined = AbortSignal.any([signal, lifetime.signal])
      for (const hook of hooks) {
        if (hook.checkpoint !== checkpoint) continue
        usable(signal)
        try {
          assert(pendingRaw < 16, 'LIFECYCLE_HOOK_BACKPRESSURE', 'Unsettled hooks have reached their bounded capacity.')
          await withDeadline({ signal: combined, timeoutMs: hook.timeoutMs, code: 'LIFECYCLE_HOOK_TIMEOUT',
            run(hookSignal) {
              pendingRaw++
              const raw = Promise.resolve().then(() => {
                hookSignal.throwIfAborted()
                return hook.run(Object.freeze({ checkpoint, data: immutable, signal: hookSignal }))
              })
              raw.then(() => { pendingRaw-- }, () => { pendingRaw-- })
              return raw
            } })
        } catch (error) {
          usable(signal)
          const code = error instanceof FrameworkError
            && (error.code === 'LIFECYCLE_HOOK_TIMEOUT' || error.code === 'LIFECYCLE_HOOK_BACKPRESSURE')
            ? error.code : hook.kind === 'guard' ? 'LIFECYCLE_HOOK_GUARD_FAILED' : 'LIFECYCLE_HOOK_OBSERVE_FAILED'
          fault(hook, code)
          usable(signal)
          if (hook.kind === 'guard') throw new FrameworkError(code, 'A lifecycle guard did not complete safely.')
        }
        usable(signal)
      }
      usable(signal)
    },
    close() { lifetime.abort() },
    describe() {
      return snapshot({ closed: lifetime.signal.aborted, pendingRaw, maxPendingRaw: 16,
        definitions: hooks.map(({ id, checkpoint, kind, order, timeoutMs }) => ({ id, checkpoint, kind, order, timeoutMs })),
        faults, lastFault })
    }
  })
}

export type LifecycleHooks = ReturnType<typeof createLifecycleHooks>
