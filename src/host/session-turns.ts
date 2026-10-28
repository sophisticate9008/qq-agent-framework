import { assert, isRecord, FrameworkError } from '../core/values.ts'
import type { AgentAdapter, DurableStore } from '../contracts/ports.ts'
import { digest } from './data.ts'
import { pluginModelIdentifier } from '../contracts/plugin-model.ts'

interface SessionWaiter {
  readonly signal: AbortSignal
  readonly resolve: (release: () => void) => void
  readonly reject: (error: unknown) => void
  readonly abort: () => void
}
interface SessionLane {
  readonly waiters: SessionWaiter[]
  release: (() => void) | null
}
interface ChatLease { readonly requestId: string; readonly release: () => void }
const MAX_OPERATIONS = 256
const pluginTerminal = new Set(['completed', 'failed', 'rejected'])
const qqTerminal = new Set(['completed', 'failed', 'cancelled', 'rejected'])
const unsettledCancel = new Set(['requesting', 'accepted', 'unknown'])

/** One bounded process-local lane per actual session, plus durable execution barriers. */
export function createSessionTurnQueue(options: { readonly signal: AbortSignal; readonly store: DurableStore }) {
  const lanes = new Map<string, SessionLane>()
  const chatLeases = new Map<string, ChatLease>()
  let pending = 0
  function pluginSettled(sessionId: string): boolean {
    const row = options.store.read('plugin-model.executions', sessionId)
    if (!row) return true
    const value = row.value
    return isRecord(value) && value.schema === 1 && pluginModelIdentifier(value.owner)
      && pluginModelIdentifier(value.requestId) && pluginTerminal.has(String(value.state))
      && (value.sessionId === undefined || value.sessionId === sessionId)
  }
  function qqOccupied(sessionId: string): boolean {
    // The execution controller retains this claim through unknown outcomes and unsettled cancellation.
    // Absence is its durable release signal; malformed/stale claims remain barriers.
    return options.store.read('host.execution-sessions', digest(sessionId)) !== null
  }
  function assertPluginSettled(sessionId: string): void {
    assert(pluginSettled(sessionId), 'PLUGIN_MODEL_EXECUTION_UNSETTLED', 'The model session has unresolved or invalid plugin work.')
  }
  function removeEmpty(sessionId: string, lane: SessionLane): void {
    if (lane.release === null && lane.waiters.length === 0 && lanes.get(sessionId) === lane) lanes.delete(sessionId)
  }
  function drain(sessionId: string, lane: SessionLane): void {
    while (lane.release === null && lane.waiters.length > 0) {
      const waiter = lane.waiters.shift()!
      waiter.signal.removeEventListener('abort', waiter.abort)
      try {
        options.signal.throwIfAborted()
        waiter.signal.throwIfAborted()
        assertPluginSettled(sessionId)
      } catch (error) {
        pending--
        waiter.reject(error)
        continue
      }
      let released = false
      const release = () => {
        if (released) return
        released = true
        pending--
        lane.release = null
        drain(sessionId, lane)
      }
      lane.release = release
      waiter.resolve(release)
    }
    removeEmpty(sessionId, lane)
  }
  async function acquire(sessionId: string, signal: AbortSignal): Promise<() => void> {
    const combined = AbortSignal.any([signal, options.signal])
    combined.throwIfAborted()
    assert(typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 1024,
      'SESSION_QUEUE_INVALID_SESSION', 'A concrete session ID is required.')
    assert(pending < MAX_OPERATIONS, 'SESSION_QUEUE_FULL', 'Too many active or waiting session operations.')
    let lane = lanes.get(sessionId)
    if (!lane) { lane = { waiters: [], release: null }; lanes.set(sessionId, lane) }
    const selected = lane
    pending++
    const release = await new Promise<() => void>((resolve, reject) => {
      const waiter: SessionWaiter = { signal: combined, resolve, reject, abort() {
        const index = selected.waiters.indexOf(waiter)
        if (index < 0) return
        selected.waiters.splice(index, 1)
        combined.removeEventListener('abort', waiter.abort)
        pending--
        reject(new FrameworkError('SESSION_QUEUE_CANCELLED', 'Session wait was cancelled.'))
        removeEmpty(sessionId, selected)
      } }
      selected.waiters.push(waiter)
      combined.addEventListener('abort', waiter.abort, { once: true })
      if (combined.aborted) waiter.abort()
      drain(sessionId, selected)
    })
    if (combined.aborted) { release(); combined.throwIfAborted() }
    return release
  }
  function releaseChat(sessionId: string, lease: ChatLease): boolean {
    if (chatLeases.get(sessionId) !== lease) return false
    chatLeases.delete(sessionId)
    lease.release()
    return true
  }
  /** Coordinator marks submitting durably before calling the underlying agent transport. */
  function mayHaveDispatched(sessionId: string, requestId: string): boolean {
    try {
      const claim = options.store.read('host.execution-sessions', digest(sessionId))
      if (!claim) return false
      if (!isRecord(claim.value) || typeof claim.value.executionId !== 'string') return true
      const row = options.store.read('host.executions', claim.value.executionId)
      if (!row || !isRecord(row.value) || row.value.schema !== 1 || !isRecord(row.value.binding)
        || row.value.binding.sessionId !== sessionId || typeof row.value.requestId !== 'string') return true
      // A different request's durable barrier belongs to that request, not this failed preparation.
      if (row.value.requestId !== requestId) return false
      if (row.value.externalStatus === 'not-started') return false
      return !(qqTerminal.has(String(row.value.externalStatus)) && row.value.isolated === false
        && !unsettledCancel.has(String(row.value.cancelStatus)))
    } catch { return true }
  }
  options.signal.addEventListener('abort', () => {
    // Wake every pending caller and remove every waiter/listener; no abandoned promise chains remain.
    chatLeases.clear()
    for (const [sessionId, lane] of lanes) {
      for (const waiter of lane.waiters.splice(0)) {
        waiter.signal.removeEventListener('abort', waiter.abort)
        pending--
        waiter.reject(new FrameworkError('SESSION_QUEUE_CANCELLED', 'Session runtime has stopped.'))
      }
      lane.release?.()
      removeEmpty(sessionId, lane)
    }
  }, { once: true })
  return Object.freeze({
    acquire,
    /** Includes queued work and durable unknown/corrupt barriers; storage failure is conservatively busy. */
    isBusy(sessionId: string): boolean {
      const lane = lanes.get(sessionId)
      if (lane && (lane.release !== null || lane.waiters.length > 0)) return true
      try { return !pluginSettled(sessionId) || qqOccupied(sessionId) } catch { return true }
    },
    /** Call only after verified reconciliation; an old request can never release a newer lease. */
    releaseReconciled(sessionId: string, requestId: string): boolean {
      const lease = chatLeases.get(sessionId)
      if (!lease || lease.requestId !== requestId) return false
      try { if (qqOccupied(sessionId)) return false } catch { return false }
      return releaseChat(sessionId, lease)
    },
    async withSession<Value>(sessionId: string, signal: AbortSignal, operation: () => Promise<Value>): Promise<Value> {
      const combined = AbortSignal.any([signal, options.signal])
      const release = await acquire(sessionId, combined)
      try {
        combined.throwIfAborted()
        // This check is intentionally outside acquire: QQ's own prepared claim must not block wrapChat.
        assert(!qqOccupied(sessionId), 'QQ_SESSION_EXECUTION_UNSETTLED', 'The model session has unresolved QQ work.')
        return await operation()
      } finally { release() }
    },
    /** Wrap NativeAgentCoordinator, whose durable submitting marker precedes external dispatch. */
    wrapChat(agent: AgentAdapter): AgentAdapter {
      return {
        createSession: request => agent.createSession(request),
        async submit(request) {
          let release: () => void
          try { release = await acquire(request.sessionId, request.signal) }
          catch (error) {
            return { status: 'rejected' as const, reason: error instanceof FrameworkError ? error.code : 'SESSION_QUEUE_UNAVAILABLE' }
          }
          const lease: ChatLease = { requestId: request.requestId, release }
          chatLeases.set(request.sessionId, lease)
          try {
            const result = await agent.submit(request)
            if (result.status === 'rejected' || !mayHaveDispatched(request.sessionId, request.requestId)) releaseChat(request.sessionId, lease)
            return result
          } catch (error) {
            // Preparation errors without a possible dispatch do not strand the shared session lane.
            if (!mayHaveDispatched(request.sessionId, request.requestId)) releaseChat(request.sessionId, lease)
            throw error
          }
        },
        follow: request => agent.follow({ ...request, async onEvent(event) {
          try { await request.onEvent(event) }
          finally {
            const lease = chatLeases.get(event.sessionId)
            if (lease && event.data?.terminal !== true && ['completed', 'failed'].includes(event.type)
              && event.data?.nativeRequestId === lease.requestId) {
              // A pending cancel can still reach the backend; terminal output alone does not clear that barrier.
              try { if (!qqOccupied(event.sessionId)) releaseChat(event.sessionId, lease) } catch { /* retain unknown ownership */ }
            }
          }
        } }),
        ...(agent.cancel ? { cancel: request => agent.cancel!(request) } : {}),
      }
    },
  })
}
