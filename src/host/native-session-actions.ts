import { assert, isRecord } from '../core/values.ts'
import type { DurableCasMutation, DurableStore } from './types.ts'
import { digest, json } from './data.ts'
import { nativeSessionBindingRevision, validNativeSessionResetTarget, type NativeSessionResetTarget } from './native-session-management.ts'

export function assertNativeSessionIdle(store: Pick<DurableStore, 'read' | 'list'>, target: NativeSessionResetTarget): void {
  assert(validNativeSessionResetTarget(target), 'SESSION_MANAGEMENT_INVALID_TARGET', 'Invalid session target.')
  const binding = store.read('host.sessions', target.key)
  assert(binding && isRecord(binding.value) && binding.value.state === 'ready'
    && binding.value.sessionId === target.sessionId && binding.value.generation === target.generation
    && nativeSessionBindingRevision({ ...binding.value, conversationId: target.key }) === target.bindingRevision,
  'SESSION_MANAGEMENT_CONFLICT', 'The session binding changed.')
  const unsettled = () => assert(false, 'SESSION_MANAGEMENT_EXECUTION_UNSETTLED', 'The conversation still has unfinished work.')
  if (store.read('host.execution-conversations', digest(target.key))) unsettled()
  const inbox = store.read('native-chat.inbox', digest(target.key))
  if (inbox && isRecord(inbox.value) && Array.isArray(inbox.value.entries) && inbox.value.entries.length) unsettled()
  const reply = store.read('host.replies', digest(target.key))
  if (reply && isRecord(reply.value) && reply.value.status === 'waiting') unsettled()
  for (const namespace of ['host.executions', 'native-work.executions', 'outbox', 'tasks']) {
    for (const row of sessionRecords(store, namespace)) {
      if (!isRecord(row.value)) continue
      const value = row.value
      const conversation = isRecord(value.binding) ? value.binding.conversationId : value.conversationId ?? value.scope
      if (conversation !== target.key) continue
      if (namespace === 'host.executions') {
        if (isRecord(value.binding) && (value.binding.sessionId !== target.sessionId
          || value.binding.generation !== target.generation)) continue
        // A late terminal event clears isolation while retaining the original unknown outcome.
        const settledStatus = ['completed', 'failed', 'rejected', 'timed-out'].includes(String(value.status))
          || value.status === 'unknown' && ['completed', 'failed', 'rejected', 'cancelled'].includes(String(value.externalStatus))
        if (value.isolated !== false || !settledStatus
          || !['completed', 'failed', 'rejected', 'cancelled', 'not-started'].includes(String(value.externalStatus))
          || ['requesting', 'accepted', 'unknown'].includes(String(value.cancelStatus))
          || ['sending', 'unknown'].includes(String(value.noticeStatus))) unsettled()
      } else if (namespace === 'native-work.executions') {
        if (!['completed', 'failed'].includes(String(value.status)) || ['delivering', 'unknown'].includes(String(value.delivery))) unsettled()
      } else if (namespace === 'outbox') {
        if (!['confirmed', 'rejected'].includes(String(value.status))) unsettled()
      } else if (!['completed', 'failed', 'cancelled', 'expired'].includes(String(value.status))) unsettled()
    }
  }
}

/** Synchronous CAS: a new ingress cannot interleave between validation and retirement. */
export function unbindNativeSession(store: DurableStore, target: NativeSessionResetTarget) {
  assertNativeSessionIdle(store, target)
  assert(store.compareAndSetBatch, 'SESSION_MANAGEMENT_STORAGE_UNAVAILABLE', 'Atomic storage is required.')
  const previous = store.read('host.sessions', target.key)!
  const generation = target.generation + 1
  assert(Number.isSafeInteger(generation), 'SESSION_MANAGEMENT_GENERATION_EXHAUSTED', 'Session generation is exhausted.')
  const at = Date.now()
  const archiveId = digest([target.key, target.sessionId, target.generation, previous.revision])
  const owner = store.read('host.session-ids', target.sessionId)
  assert(!owner || isRecord(owner.value) && owner.value.conversationId === target.key && owner.value.generation === target.generation,
    'SESSION_MANAGEMENT_CONFLICT', 'Session ownership changed.')
  const mutations: DurableCasMutation[] = [
    { kind: 'write', namespace: 'host.session-archives', key: archiveId, expectedRevision: null,
      value: json({ schema: 1, conversationId: target.key, sessionId: target.sessionId, generation: target.generation, resetAt: at, previousRevision: previous.revision, previous: previous.value }) },
    { kind: 'write', namespace: 'host.sessions', key: target.key, expectedRevision: previous.revision,
      value: { schema: 1, state: 'retired', generation, requestId: null, sessionId: null, updatedAt: at } },
  ]
  if (!owner) mutations.push({ kind: 'write', namespace: 'host.session-ids', key: target.sessionId, expectedRevision: null,
    value: { schema: 1, conversationId: target.key, generation: target.generation } })
  const history = store.read('history', digest(target.key))
  if (history && isRecord(history.value) && typeof history.value.sequence === 'number') mutations.push({ kind: 'write',
    namespace: 'history', key: history.key, expectedRevision: history.revision, value: json({ ...history.value, readThrough: history.value.sequence }) })
  store.compareAndSetBatch(mutations)
  return { ok: true as const, key: target.key, previousSessionId: target.sessionId, previousGeneration: target.generation,
    nextGeneration: generation, bridgeBindingRemoved: true as const, externalWorkStopped: 'unverified' as const,
    historyPreserved: true as const, contextReset: true as const }
}

function* sessionRecords(store: Pick<DurableStore, 'read' | 'list'>, namespace: string) {
  let after: string | undefined
  while (true) {
    const page = store.list(namespace, { limit: 1000, ...(after ? { after } : {}) })
    yield* page
    if (page.length < 1000) return
    after = page.at(-1)!.key
  }
}
