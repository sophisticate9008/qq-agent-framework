import { randomUUID } from 'node:crypto'
import type { DurableStore } from '../contracts/ports.ts'
import type { NativePackageStateIdentity } from '../contracts/native-package-state.ts'
import { assert, errorCode, isRecord, reference, snapshot } from '../core/values.ts'
import { json } from './data.ts'

const namespace = 'native-packages.lifecycle'
/** A process boundary must never turn an unfinished package hook into a fresh invocation. */
export function createNativePackageLifecycleState(options: { readonly store: DurableStore; readonly owner: string; readonly identity: NativePackageStateIdentity }) {
  let pending = 0
  function read() {
    const stored = options.store.read(namespace, options.owner)
    if (!stored) return null
    const value = stored.value
    assert(isRecord(value) && value.schema === 1 && value.owner === options.owner && typeof value.phase === 'string'
      && typeof value.operationId === 'string' && ['applying', 'completed', 'failed', 'unknown'].includes(String(value.state))
      && isRecord(value.identity), 'NATIVE_PACKAGE_LIFECYCLE_INVALID', 'Stored package lifecycle evidence is invalid.')
    return { stored, value }
  }
  function assertSettled() {
    const current = read()
    assert(!current || !['applying', 'unknown'].includes(String(current.value.state)),
      'NATIVE_PACKAGE_LIFECYCLE_RECONCILIATION_REQUIRED', 'An earlier package lifecycle hook remains unresolved.')
  }
  return Object.freeze({ assertSettled,
    evidence() {
      const current = read()
      return current ? snapshot({ revision: current.stored.revision, owner: options.owner, phase: String(current.value.phase),
        operationId: String(current.value.operationId), state: String(current.value.state), identity: current.value.identity }) : null
    },
    async reconcile(revision: number, verify: (evidence: Readonly<{ owner: string; phase: string; operationId: string }>, signal: AbortSignal) =>
      Promise<{ readonly verified: boolean; readonly evidence: string }>, signal: AbortSignal) {
      assert(pending === 0, 'NATIVE_PACKAGE_LIFECYCLE_PENDING', 'A package callback is still running in this process.')
      const current = read()
      assert(current && current.stored.revision === revision && ['applying', 'unknown'].includes(String(current.value.state)),
        'NATIVE_PACKAGE_LIFECYCLE_CONFLICT', 'The lifecycle reconciliation target changed.')
      signal.throwIfAborted()
      const evidence = await verify(snapshot({ owner: options.owner, phase: String(current.value.phase), operationId: String(current.value.operationId) }), signal)
      signal.throwIfAborted()
      assert(pending === 0 && evidence.verified === true && reference(evidence.evidence), 'NATIVE_PACKAGE_LIFECYCLE_RECONCILIATION_UNVERIFIED', 'Actual package evidence is required to release the lifecycle gate.')
      options.store.write(namespace, options.owner, json({ ...current.value, state: 'completed', reconciliationEvidence: evidence.evidence }), { expectedRevision: revision })
    },
    async run<Value>(phase: string, signal: AbortSignal, operation: () => Value | Promise<Value>, cleanup = false): Promise<Value> {
      const current = read()
      // Known owned cleanup still runs after an unknown hook, while the earlier evidence remains authoritative.
      if (cleanup && current && ['applying', 'unknown'].includes(String(current.value.state))) return operation()
      assertSettled()
      signal.throwIfAborted()
      const value = { schema: 1, owner: options.owner, phase, operationId: randomUUID(), identity: options.identity, state: 'applying', lastError: null }
      const claim = options.store.write(namespace, options.owner, json(value), { expectedRevision: current?.stored.revision ?? null })
      pending++
      try {
        const result = await operation()
        signal.throwIfAborted()
        options.store.write(namespace, options.owner, json({ ...value, state: 'completed' }), { expectedRevision: claim.revision })
        return result
      } catch (error) {
        const code = errorCode(error, 'NATIVE_PACKAGE_PHASE_FAILED')
        try { options.store.write(namespace, options.owner, json({ ...value, state: signal.aborted || code.endsWith('_UNKNOWN') ? 'unknown' : 'failed', lastError: code }), { expectedRevision: claim.revision }) } catch {}
        throw error
      } finally { pending-- }
    }
  })
}
