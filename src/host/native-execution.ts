import type { Clock, DeliveryReceipt } from '../core/types.ts'
import { FrameworkError, assert, errorCode, isRecord, reference, snapshot } from '../core/values.ts'
import { digest, json, object } from './data.ts'
import { withDeadline } from './deadlines.ts'
import type { DurableStore, SessionBinding, StoredRecord } from './types.ts'
import { readNativeExecutionSummaries } from './native-execution-summary.ts'

export interface NativeExecutionPolicy {
  readonly schema: 1
  readonly turnTimeoutMs: number
  readonly cancelTimeoutMs: number
  readonly noticeTimeoutMs: number
  readonly noticeEnabled: boolean
  readonly noticeText: string | null
  readonly cancelOnTimeout: boolean
  readonly unknownHandling: 'isolate-session'
  readonly lateFinal: 'record-only'
  readonly maxActive: number
}

export const DEFAULT_NATIVE_EXECUTION_POLICY: NativeExecutionPolicy = Object.freeze({
  schema: 1, turnTimeoutMs: 120_000, cancelTimeoutMs: 5_000, noticeTimeoutMs: 5_000,
  noticeEnabled: false, noticeText: '请求已超时，结果尚未确认，未自动重复提交。', cancelOnTimeout: true,
  unknownHandling: 'isolate-session', lateFinal: 'record-only', maxActive: 256
})

export type NativeExecutionStatus = 'prepared' | 'submitting' | 'running' | 'completed' | 'failed' | 'rejected' | 'timed-out' | 'unknown'
type ExternalStatus = 'not-started' | 'submitting' | 'accepted' | 'completed' | 'failed' | 'rejected' | 'cancelled' | 'unknown'
type CancelStatus = 'not-requested' | 'unavailable' | 'requesting' | 'accepted' | 'rejected' | 'unknown' | 'confirmed'
type NoticeStatus = 'not-requested' | 'unavailable' | 'sending' | 'confirmed' | 'rejected' | 'unknown'

export interface NativeExecutionRecord {
  readonly schema: 1
  readonly id: string
  readonly binding: SessionBinding
  readonly requestId: string
  readonly policyRevision: string
  readonly policy: NativeExecutionPolicy
  readonly admittedAt: number
  readonly deadlineAt: number
  readonly status: NativeExecutionStatus
  readonly externalStatus: ExternalStatus
  readonly isolated: boolean
  readonly deadlineReached: boolean
  readonly cancelStatus: CancelStatus
  readonly noticeStatus: NoticeStatus
  readonly userMessage: { readonly eventId: string; readonly messageId: string } | null
  readonly turn: { readonly id: string; readonly evidenceId: string } | null
  readonly progressEvents: number
  readonly lastEventId: string | null
  readonly lateOutcome: { readonly eventId: string; readonly outcome: 'completed' | 'failed' | 'cancelled' } | null
  readonly lastError: string | null
}

export interface NativeExecutionAdmission {
  readonly binding: SessionBinding
  readonly requestId: string
  readonly policyRevision: string
  readonly admittedAt?: number
}

export interface NativeExecutionAction {
  readonly execution: NativeExecutionRecord
  readonly idempotencyKey: string
  readonly signal: AbortSignal
}

export interface NativeTurnClaimReceipt {
  readonly kind: 'dsh.agent-inbox-claimed'
  readonly sessionId: string
  readonly requestId: string
  readonly userMessageId: string
  readonly turn: number
  readonly evidenceId: string
  readonly issuerEpoch: string
  readonly receiptSeq: number
}

export interface NativeExecutionCheckpointProof {
  readonly binding: SessionBinding
  readonly requestId: string
  readonly userMessageId: string
  readonly turnId: string
  readonly outcome: 'completed' | 'failed' | 'cancelled'
  readonly evidenceId: string
  readonly checkpointHash: string
  readonly checkpointSequence: number
  readonly quiescent: true
}

export interface NativeExecutionOptions {
  readonly store: DurableStore
  readonly policy?: NativeExecutionPolicy
  readonly clock?: Clock
  readonly maxPendingOperations?: number
  readonly onFault?: (code: string) => void
  readonly cancel?: (request: NativeExecutionAction) => Promise<{ readonly status: 'accepted' | 'rejected' | 'unknown' }>
  readonly notify?: (request: NativeExecutionAction) => Promise<DeliveryReceipt>
}

const executions = 'host.executions'
const conversations = 'host.execution-conversations'
const sessions = 'host.execution-sessions'
const receipts = 'host.execution-receipts'
const turns = 'host.execution-turns'
const retirements = 'host.execution-retirements'
const activeStatuses = new Set<NativeExecutionStatus>(['prepared', 'submitting', 'running', 'timed-out', 'unknown'])
const terminalExternal = new Set<ExternalStatus>(['completed', 'failed', 'cancelled', 'rejected'])
const unsettledCancel = new Set<CancelStatus>(['requesting', 'accepted', 'unknown'])

export function validateNativeExecutionPolicy(input: unknown): NativeExecutionPolicy {
  const keys = Object.keys(DEFAULT_NATIVE_EXECUTION_POLICY)
  assert(isRecord(input) && Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key))
    && input.schema === 1 && Number.isSafeInteger(input.turnTimeoutMs) && Number(input.turnTimeoutMs) >= 10 && Number(input.turnTimeoutMs) <= 300_000
    && [input.cancelTimeoutMs, input.noticeTimeoutMs].every(value => typeof value === 'number'
      && Number.isSafeInteger(value) && value >= 10 && value <= 30_000)
    && typeof input.noticeEnabled === 'boolean' && typeof input.cancelOnTimeout === 'boolean'
    && (input.noticeText === null || typeof input.noticeText === 'string' && input.noticeText.length <= 8_000)
    && (!input.noticeEnabled || typeof input.noticeText === 'string' && input.noticeText.trim().length > 0)
    && input.unknownHandling === 'isolate-session' && input.lateFinal === 'record-only'
    && Number.isSafeInteger(input.maxActive) && Number(input.maxActive) >= 1 && Number(input.maxActive) <= 256,
  'EXECUTION_INVALID_POLICY', 'An explicit bounded execution policy is required.')
  return snapshot(input) as unknown as NativeExecutionPolicy
}

function readExecution(record: StoredRecord): NativeExecutionRecord {
  const value = object(record.value)
  assert(value.schema === 1 && value.id === record.key && reference(value.requestId) && reference(value.policyRevision)
    && isRecord(value.binding) && reference(value.binding.conversationId) && reference(value.binding.sessionId)
    && Number.isSafeInteger(value.binding.generation) && Number(value.binding.generation) > 0
    && Number.isSafeInteger(value.admittedAt) && Number.isSafeInteger(value.deadlineAt)
    && Number(value.admittedAt) >= 0 && /^[a-f0-9]{64}$/.test(String(value.policyRevision))
    && Number.isSafeInteger(value.progressEvents) && Number(value.progressEvents) >= 0
    && (value.lastEventId === null || reference(value.lastEventId))
    && (value.lastError === null || reference(value.lastError))
    && (value.userMessage === null || isRecord(value.userMessage)
      && reference(value.userMessage.eventId) && reference(value.userMessage.messageId))
    && (value.turn === null || isRecord(value.turn) && reference(value.turn.id) && reference(value.turn.evidenceId))
    && (value.lateOutcome === null || isRecord(value.lateOutcome) && reference(value.lateOutcome.eventId)
      && ['completed', 'failed', 'cancelled'].includes(String(value.lateOutcome.outcome)))
    && typeof value.isolated === 'boolean' && typeof value.deadlineReached === 'boolean'
    && ['prepared', 'submitting', 'running', 'completed', 'failed', 'rejected', 'timed-out', 'unknown'].includes(String(value.status))
    && ['not-started', 'submitting', 'accepted', 'completed', 'failed', 'rejected', 'cancelled', 'unknown'].includes(String(value.externalStatus))
    && ['not-requested', 'unavailable', 'requesting', 'accepted', 'rejected', 'unknown', 'confirmed'].includes(String(value.cancelStatus))
    && ['not-requested', 'unavailable', 'sending', 'confirmed', 'rejected', 'unknown'].includes(String(value.noticeStatus)),
  'EXECUTION_DATA_CORRUPT', 'Stored execution metadata is invalid.')
  const policy = validateNativeExecutionPolicy(value.policy)
  assert(Number(value.deadlineAt) === Number(value.admittedAt) + policy.turnTimeoutMs,
    'EXECUTION_DATA_CORRUPT', 'The immutable execution deadline is invalid.')
  return snapshot({ ...value, policy }) as unknown as NativeExecutionRecord
}

export function createNativeExecutionController(options: NativeExecutionOptions) {
  const { store, clock = Date.now } = options
  const policy = validateNativeExecutionPolicy(options.policy ?? DEFAULT_NATIVE_EXECUTION_POLICY)
  const maxPendingOperations = options.maxPendingOperations ?? 16
  assert(Number.isSafeInteger(maxPendingOperations) && maxPendingOperations >= 1 && maxPendingOperations <= 256,
    'EXECUTION_INVALID_OPTIONS', 'Pending external operations must be bounded.')
  const lifetime = new AbortController()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const signals = new Map<string, AbortController>()
  const pending = new Set<Promise<unknown>>()
  let started = false
  let stopped = false
  let rawPending = 0
  let stopping: Promise<void> | null = null
  let faulted = false

  function fault(error: unknown) {
    faulted = true
    for (const controller of signals.values()) controller.abort()
    try { options.onFault?.(errorCode(error, 'EXECUTION_STORAGE_UNKNOWN')) } catch {}
  }

  function now() {
    const value = clock()
    assert(Number.isSafeInteger(value) && value >= 0, 'EXECUTION_INVALID_CLOCK', 'A nonnegative integer admission clock is required.')
    return value
  }

  function get(id: string): NativeExecutionRecord | null {
    const record = store.read(executions, id)
    return record ? readExecution(record) : null
  }

  function list({ limit = 100, after, order }: { readonly limit?: number; readonly after?: string; readonly order?: 'recent' } = {}) {
    const recentCursor = after === undefined ? undefined : /^(\d{1,16}):([a-f0-9]{64})$/.exec(after)
    assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1_000
      && (order === undefined || order === 'recent')
      && (after === undefined || (order === 'recent' ? recentCursor && Number.isSafeInteger(Number(recentCursor[1])) : /^[a-f0-9]{64}$/.test(after))),
    'EXECUTION_INVALID_QUERY', 'Execution queries must be bounded.')
    if (order === 'recent') assert(store.listByNumber, 'EXECUTION_ORDER_UNAVAILABLE', 'This store cannot read chronological execution pages.')
    const rows = order === 'recent'
      ? store.listByNumber!({ namespace: executions, field: 'admittedAt', limit,
        ...(recentCursor ? { before: { value: Number(recentCursor[1]), key: recentCursor[2] } } : {}) })
      : store.list(executions, { limit, ...(after === undefined ? {} : { after }) })
    return snapshot(rows.map(record => {
      const execution = readExecution(record)
      return { ...execution, revision: record.revision, cursor: order === 'recent' ? `${execution.admittedAt}:${record.key}` : record.key }
    }))
  }

  function update(id: string, operation: (current: NativeExecutionRecord) => NativeExecutionRecord) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = store.read(executions, id)
      assert(current, 'EXECUTION_NOT_FOUND', 'The execution does not exist.')
      const previous = readExecution(current)
      const value = operation(previous)
      if (digest(value) === digest(previous)) return previous
      try { return readExecution(store.write(executions, id, json(value), { expectedRevision: current.revision })) }
      catch (error) { if (errorCode(error) !== 'STORE_CONFLICT') throw error }
    }
    throw new FrameworkError('EXECUTION_CONFLICT', 'Execution metadata changed concurrently.')
  }

  function removeClaim(namespace: string, key: string, id: string) {
    const record = store.read(namespace, key)
    if (record && object(record.value).executionId === id) store.delete(namespace, key, record.revision)
  }

  function release(record: NativeExecutionRecord) {
    if (record.isolated || !terminalExternal.has(record.externalStatus)
      || unsettledCancel.has(record.cancelStatus)) return
    clearTimeout(timers.get(record.id))
    timers.delete(record.id)
    signals.get(record.id)?.abort()
    signals.delete(record.id)
    removeClaim(sessions, digest(record.binding.sessionId), record.id)
    removeClaim(conversations, digest(record.binding.conversationId), record.id)
  }

  function releaseRetired(record: NativeExecutionRecord): boolean {
    const retired = store.read(retirements, record.id)
    if (!retired) return false
    const value = object(retired.value)
    const target = object(value.target)
    const authoritative = object(store.read('host.sessions', record.binding.conversationId)?.value)
    assert(value.schema === 1 && value.executionId === record.id && digest(value.binding) === digest(record.binding)
      && target.conversationId === record.binding.conversationId && reference(target.sessionId)
      && target.sessionId !== record.binding.sessionId && target.generation === record.binding.generation + 1
      && reference(value.evidenceId) && /^[a-f0-9]{64}$/.test(String(value.checkpointHash))
      && (authoritative.state === 'ready' && authoritative.sessionId === target.sessionId && authoritative.generation === target.generation
        || Number(authoritative.generation) > Number(target.generation)),
    'EXECUTION_RETIREMENT_INVALID', 'A retired address requires the verified successor binding.')
    clearTimeout(timers.get(record.id)); timers.delete(record.id)
    signals.get(record.id)?.abort(); signals.delete(record.id)
    // Keep the old session claim: a late address-scoped cancellation must never reach a successor turn.
    removeClaim(conversations, digest(record.binding.conversationId), record.id)
    return true
  }

  function settleIsolation(record: NativeExecutionRecord): NativeExecutionRecord {
    const isolated = !terminalExternal.has(record.externalStatus)
      || unsettledCancel.has(record.cancelStatus)
    return { ...record, isolated }
  }

  async function limited<Value>(run: () => Promise<Value>): Promise<Value> {
    assert(rawPending < maxPendingOperations, 'EXECUTION_BACKPRESSURE', 'Unsettled external operations have reached their limit.')
    rawPending++
    try { return await run() } finally { rawPending-- }
  }

  function launch<Value>(operation: Promise<Value>): Promise<Value> {
    pending.add(operation)
    void operation.catch(() => undefined).finally(() => pending.delete(operation))
    return operation
  }

  function activeRecords() {
    const claims = store.list(conversations, { limit: 257 })
    assert(claims.length <= 256, 'EXECUTION_DATA_CORRUPT', 'The durable active execution index exceeds its limit.')
    return claims.map(claim => {
      const id = object(claim.value).executionId
      assert(reference(id), 'EXECUTION_DATA_CORRUPT', 'An execution index is invalid.')
      const record = get(String(id))
      const externalClaim = record ? store.read(sessions, digest(record.binding.sessionId)) : null
      assert(record && claim.key === digest(record.binding.conversationId)
        && (record.externalStatus === 'not-started' || terminalExternal.has(record.externalStatus) && !unsettledCancel.has(record.cancelStatus)
          || externalClaim && object(externalClaim.value).executionId === id),
      'EXECUTION_DATA_CORRUPT', 'The durable execution scope indices disagree.')
      return record
    })
  }

  async function timeoutActions(id: string) {
    const initial = get(id)
    if (!initial || stopped) return
    const cancel = async () => {
      const current = get(id)!
      if (!current.deadlineReached || terminalExternal.has(current.externalStatus) || current.externalStatus === 'not-started' || current.cancelStatus !== 'not-requested'
        || !current.policy.cancelOnTimeout) return
      if (!options.cancel) { update(id, value => ({ ...value, cancelStatus: 'unavailable' })); return }
      let claimed = false
      update(id, value => {
        claimed = value.cancelStatus === 'not-requested' && !terminalExternal.has(value.externalStatus)
        return claimed ? { ...value, cancelStatus: 'requesting', isolated: true } : value
      })
      if (!claimed) return
      const accept = (status: 'accepted' | 'rejected' | 'unknown') => {
        if (stopped) return
        if (!['accepted', 'rejected', 'unknown'].includes(status)) status = 'unknown'
        const record = update(id, value => value.cancelStatus === 'confirmed' ? value : settleIsolation({ ...value,
          cancelStatus: status === 'accepted' && value.externalStatus === 'cancelled' ? 'confirmed' : status }))
        release(record)
      }
      try {
        const result = await withDeadline({ signal: lifetime.signal, timeoutMs: current.policy.cancelTimeoutMs,
          code: 'EXECUTION_CANCEL_UNKNOWN', run: signal => limited(() => options.cancel!({ execution: current,
            idempotencyKey: `execution:${id}:cancel`, signal })), onLate: result => accept(result.status) })
        accept(result.status)
      } catch { accept('unknown') }
    }
    const notify = async () => {
      const current = get(id)!
      if (!current.deadlineReached || current.status === 'rejected' || current.noticeStatus !== 'not-requested' || !current.policy.noticeEnabled) return
      if (!options.notify) { update(id, value => ({ ...value, noticeStatus: 'unavailable' })); return }
      let claimed = false
      update(id, value => {
        claimed = value.noticeStatus === 'not-requested'
        return claimed ? { ...value, noticeStatus: 'sending' } : value
      })
      if (!claimed) return
      const accept = (result: DeliveryReceipt) => {
        if (!stopped) update(id, value => ({ ...value, noticeStatus: result.status }))
      }
      try {
        const result = await withDeadline({ signal: lifetime.signal, timeoutMs: current.policy.noticeTimeoutMs,
          code: 'EXECUTION_NOTICE_UNKNOWN', run: signal => limited(() => options.notify!({ execution: current,
            idempotencyKey: `execution:${id}:timeout-notice`, signal })), onLate: accept })
        accept(result)
      } catch { accept({ status: 'unknown' }) }
    }
    await Promise.allSettled([cancel(), notify()])
  }

  function expire(id: string, timerFired = false) {
    const previous = get(id)
    if (!previous || previous.deadlineReached || !activeStatuses.has(previous.status)
      || !timerFired && now() < previous.deadlineAt) return previous
    signals.get(id)?.abort()
    clearTimeout(timers.get(id))
    timers.delete(id)
    const record = update(id, current => {
      if (current.deadlineReached || !activeStatuses.has(current.status)) return current
      const notStarted = current.externalStatus === 'not-started'
      return { ...current, deadlineReached: true, status: notStarted ? 'rejected' : current.status === 'unknown' ? 'unknown' : 'timed-out',
        externalStatus: notStarted ? 'rejected' : current.externalStatus, isolated: !notStarted,
        lastError: notStarted ? 'EXECUTION_DEADLINE_BEFORE_SUBMIT' : 'EXECUTION_DEADLINE_REACHED' }
    })
    release(record)
    launch(timeoutActions(id).catch(fault))
    return record
  }

  function arm(record: NativeExecutionRecord) {
    if (stopped || record.deadlineReached || timers.has(record.id) || !activeStatuses.has(record.status)) return
    signals.set(record.id, signals.get(record.id) ?? new AbortController())
    timers.set(record.id, setTimeout(() => {
      if (!stopped) { try { expire(record.id, true) } catch (error) { fault(error) } }
    },
      Math.max(1, Math.min(record.policy.turnTimeoutMs, record.deadlineAt - now()))))
  }

  function assertRunning() { assert(started && !stopped && !faulted, 'EXECUTION_NOT_STARTED', 'Start a healthy execution controller explicitly.') }

  function admit(input: NativeExecutionAdmission) {
    assertRunning()
    assert(isRecord(input.binding) && reference(input.binding.conversationId) && reference(input.binding.sessionId)
      && Number.isSafeInteger(input.binding.generation) && input.binding.generation > 0 && reference(input.requestId)
      && /^[a-f0-9]{64}$/.test(input.policyRevision), 'EXECUTION_INVALID_ADMISSION', 'A trusted binding, request and policy revision are required.')
    const id = digest([input.binding, input.requestId])
    const prior = get(id)
    if (prior) {
      assert(prior.policyRevision === input.policyRevision && digest(prior.binding) === digest(input.binding),
        'EXECUTION_REQUEST_CONFLICT', 'A request identity cannot change policy or binding.')
      return prior
    }
    assert(store.list(conversations, { limit: policy.maxActive + 1 }).length < policy.maxActive,
      'EXECUTION_BACKPRESSURE', 'Active execution capacity is exhausted.')
    for (const [namespace, key] of [[conversations, digest(input.binding.conversationId)], [sessions, digest(input.binding.sessionId)]]) {
      assert(store.read(namespace, key) === null, 'EXECUTION_SESSION_ISOLATED', 'A prior execution still owns this scope.')
    }
    const admittedAt = input.admittedAt ?? now()
    assert(Number.isSafeInteger(admittedAt) && admittedAt >= 0 && admittedAt <= now()
      && Number.isSafeInteger(admittedAt + policy.turnTimeoutMs), 'EXECUTION_INVALID_ADMISSION', 'Admission time must come from the trusted host clock.')
    const record: NativeExecutionRecord = { schema: 1, id, binding: snapshot(input.binding), requestId: input.requestId,
      policyRevision: input.policyRevision, policy, admittedAt, deadlineAt: admittedAt + policy.turnTimeoutMs,
      status: 'prepared', externalStatus: 'not-started', isolated: true, deadlineReached: false,
      cancelStatus: 'not-requested', noticeStatus: 'not-requested', userMessage: null, turn: null,
      progressEvents: 0, lastEventId: null, lateOutcome: null, lastError: null }
    store.write(executions, id, json(record), { expectedRevision: null })
    try {
      store.write(conversations, digest(input.binding.conversationId), { executionId: id }, { expectedRevision: null })
      store.write(sessions, digest(input.binding.sessionId), { executionId: id }, { expectedRevision: null })
    } catch (error) {
      const rejected = update(id, value => ({ ...value, status: 'rejected', externalStatus: 'rejected', isolated: false, lastError: 'EXECUTION_ADMISSION_CONFLICT' }))
      release(rejected)
      throw error
    }
    arm(record)
    return expire(id) ?? record
  }

  function receipt(id: string, eventId: string, value: unknown): boolean {
    assert(reference(eventId), 'EXECUTION_INVALID_EVIDENCE', 'An external event identity is required.')
    const key = digest([id, eventId])
    const signature = digest(value)
    const prior = store.read(receipts, key)
    if (prior) {
      assert(object(prior.value).signature === signature, 'EXECUTION_EVENT_CONFLICT', 'An external event identity has different evidence.')
      return false
    }
    store.write(receipts, key, { executionId: id, signature }, { expectedRevision: null })
    return true
  }

  return Object.freeze({
    start() {
      assert(!stopped, 'EXECUTION_STOPPED', 'A stopped execution controller cannot restart.')
      if (started) return
      const records = activeRecords()
      for (const initial of records) {
        if (releaseRetired(initial)) continue
        const recovered = update(initial.id, current => {
          if (terminalExternal.has(current.externalStatus) && !unsettledCancel.has(current.cancelStatus)) return current
          const notStarted = current.externalStatus === 'not-started'
          return { ...current, status: notStarted ? 'rejected' : 'unknown', externalStatus: notStarted ? 'rejected' : 'unknown',
            isolated: !notStarted, cancelStatus: unsettledCancel.has(current.cancelStatus) ? 'unknown'
              : current.cancelStatus === 'not-requested' ? 'unavailable' : current.cancelStatus,
            noticeStatus: current.noticeStatus === 'sending' ? 'unknown'
              : current.noticeStatus === 'not-requested' ? 'unavailable' : current.noticeStatus, lastError: 'EXECUTION_INTERRUPTED' }
        })
        release(recovered)
        arm(recovered)
        expire(recovered.id)
      }
      started = true
    },
    admit, get,
    inspect(id: string) {
      const execution = get(id)
      return execution ? snapshot({ ...execution, summary: readNativeExecutionSummaries(store, [execution]).get(id)! }) : null
    },
    listForDisplay(query: Parameters<typeof list>[0] = {}) {
      const rows = list(query)
      const summaries = readNativeExecutionSummaries(store, rows)
      return snapshot(rows.map(row => ({ ...row, summary: summaries.get(row.id)! })))
    },
    active() { return snapshot(activeRecords()) },
    async cancel(id: string) {
      assertRunning()
      const current = get(id)
      assert(current, 'EXECUTION_NOT_FOUND', 'The execution does not exist.')
      if (terminalExternal.has(current.externalStatus) || current.cancelStatus !== 'not-requested') return current
      signals.get(id)?.abort()
      update(id, value => ({ ...value, status: 'unknown', isolated: true,
        cancelStatus: options.cancel ? 'requesting' : 'unavailable', lastError: 'EXECUTION_CANCEL_REQUESTED' }))
      if (!options.cancel) return get(id)!
      const accept = (status: 'accepted' | 'rejected' | 'unknown') => {
        if (stopped) return
        const next = update(id, value => value.cancelStatus === 'confirmed' ? value : settleIsolation({ ...value,
          cancelStatus: status === 'accepted' && value.externalStatus === 'cancelled' ? 'confirmed' : status }))
        release(next)
      }
      try {
        const result = await withDeadline({ signal: lifetime.signal, timeoutMs: current.policy.cancelTimeoutMs,
          code: 'EXECUTION_CANCEL_UNKNOWN', run: signal => limited(() => options.cancel!({ execution: current,
            idempotencyKey: `execution:${id}:cancel`, signal })), onLate: result => accept(result.status) })
        accept(result.status)
      } catch { accept('unknown') }
      return get(id)!
    },
    forConversation(conversationId: string) {
      const claim = store.read(conversations, digest(conversationId))
      return claim ? get(String(object(claim.value).executionId)) : null
    },
    forTurn(binding: SessionBinding, turnId: string) {
      const claim = store.read(turns, digest([binding, turnId]))
      return claim ? get(String(object(claim.value).executionId)) : null
    },
    submit(id: string, operation: (request: { readonly signal: AbortSignal; readonly execution: NativeExecutionRecord })
      => Promise<{ readonly status: 'accepted' | 'rejected' | 'unknown' }>) {
      return launch((async () => {
        assertRunning()
        expire(id)
        const record = get(id)
        assert(record?.status === 'prepared' && !record.deadlineReached, 'EXECUTION_SUBMIT_BLOCKED', 'This execution cannot start another prompt.')
        assert(object(store.read(conversations, digest(record.binding.conversationId))?.value).executionId === id
          && object(store.read(sessions, digest(record.binding.sessionId))?.value).executionId === id,
        'EXECUTION_SESSION_ISOLATED', 'The execution no longer owns its scope.')
        assert(rawPending < maxPendingOperations, 'EXECUTION_BACKPRESSURE', 'Unsettled external operations have reached their limit.')
        update(id, value => ({ ...value, status: 'submitting', externalStatus: 'submitting' }))
        const accept = (status: 'accepted' | 'rejected' | 'unknown') => {
          if (stopped) return
          if (!['accepted', 'rejected', 'unknown'].includes(status)) status = 'unknown'
          expire(id)
          const next = update(id, current => {
            if (terminalExternal.has(current.externalStatus)) return current
            const statusValue = current.deadlineReached ? current.status
              : status === 'accepted' ? 'running' : status === 'rejected' ? 'rejected' : 'unknown'
            return settleIsolation({ ...current, status: statusValue, externalStatus: status })
          })
          release(next)
        }
        try {
          const signal = AbortSignal.any([lifetime.signal, signals.get(id)!.signal])
          const result = await withDeadline({ signal, timeoutMs: Math.max(1, Math.min(300_000, record.deadlineAt - now())),
            code: 'EXECUTION_SUBMIT_UNKNOWN', run: signal => limited(() => operation({ signal, execution: record })),
            onLate: result => accept(result.status) })
          accept(result.status)
        } catch {
          expire(id)
          accept('unknown')
        }
        return get(id)!
      })())
    },
    userMessage(id: string, evidence: { readonly eventId: string; readonly messageId: string; readonly source: { readonly kind: 'user'; readonly rpcId: string } }) {
      assertRunning()
      const current = get(id)
      assert(current && evidence.source.kind === 'user' && evidence.source.rpcId === current.requestId && reference(evidence.messageId),
        'EXECUTION_INVALID_EVIDENCE', 'Only the exact official user message request receipt is accepted.')
      assert(current.userMessage === null || current.userMessage.messageId === evidence.messageId,
        'EXECUTION_CORRELATION_CONFLICT', 'A request cannot change its accepted user message.')
      if (!receipt(id, evidence.eventId, evidence)) return current
      return update(id, value => ({ ...value, userMessage: { eventId: evidence.eventId, messageId: evidence.messageId } }))
    },
    claimed(id: string, proof: NativeTurnClaimReceipt) {
      assertRunning()
      const current = get(id)
      assert(current && proof.kind === 'dsh.agent-inbox-claimed' && proof.requestId === current.requestId
        && proof.sessionId === current.binding.sessionId && reference(proof.userMessageId)
        && Number.isSafeInteger(proof.turn) && proof.turn >= 0 && reference(proof.evidenceId)
        && reference(proof.issuerEpoch) && Number.isSafeInteger(proof.receiptSeq) && proof.receiptSeq > 0,
      'EXECUTION_CORRELATION_UNPROVEN', 'An actual trusted inbox-claimed receipt is required.')
      assert(current.externalStatus !== 'not-started', 'EXECUTION_UNEXPECTED_CLAIM', 'The host has not submitted this execution.')
      const turnId = String(proof.turn)
      assert(current.turn === null || current.turn.id === turnId, 'EXECUTION_CORRELATION_CONFLICT', 'An execution cannot change external turn.')
      assert(current.userMessage === null || current.userMessage.messageId === proof.userMessageId,
        'EXECUTION_CORRELATION_CONFLICT', 'The claimed message must match the accepted user message.')
      if (!receipt(id, proof.evidenceId, proof) && current.turn !== null) return current
      const turnKey = digest([current.binding, turnId])
      const turnClaim = store.read(turns, turnKey)
      assert(turnClaim === null || object(turnClaim.value).executionId === id,
        'EXECUTION_CORRELATION_CONFLICT', 'An external turn is already bound to another execution.')
      if (!turnClaim) store.write(turns, turnKey, { executionId: id }, { expectedRevision: null })
      return update(id, value => ({ ...value, userMessage: value.userMessage ?? { eventId: proof.evidenceId, messageId: proof.userMessageId },
        turn: { id: turnId, evidenceId: proof.evidenceId } }))
    },
    reconcileCheckpoint(id: string, proof: NativeExecutionCheckpointProof) {
      assertRunning()
      const current = get(id)
      assert(current && digest(current.binding) === digest(proof.binding) && current.requestId === proof.requestId
        && reference(proof.userMessageId) && /^[1-9]\d*$/.test(proof.turnId) && proof.quiescent === true
        && ['completed', 'failed', 'cancelled'].includes(proof.outcome) && reference(proof.evidenceId)
        && /^[a-f0-9]{64}$/.test(proof.checkpointHash) && Number.isSafeInteger(proof.checkpointSequence) && proof.checkpointSequence >= 0,
      'EXECUTION_INVALID_EVIDENCE', 'Recovery requires an exact current binding and verified durable turn checkpoint.')
      assert(current.externalStatus !== 'not-started', 'EXECUTION_UNEXPECTED_CLAIM', 'An unsubmitted execution cannot claim remote completion.')
      assert((current.userMessage === null || current.userMessage.messageId === proof.userMessageId)
        && (current.turn === null || current.turn.id === proof.turnId), 'EXECUTION_CORRELATION_CONFLICT', 'Recovery cannot change the accepted user message or turn.')
      function canRelease(value: NativeExecutionRecord): void {
        assert(!['requesting', 'unknown'].includes(value.cancelStatus)
          && (value.cancelStatus !== 'accepted' || proof.outcome === 'cancelled'),
        'EXECUTION_CANCEL_EVIDENCE_UNKNOWN', 'A late uncorrelated cancellation still owns the old session address.')
        assert(!terminalExternal.has(value.externalStatus) || value.externalStatus === proof.outcome,
          'EXECUTION_CORRELATION_CONFLICT', 'The durable checkpoint contradicts recorded terminal evidence.')
      }
      canRelease(current)
      const turnKey = digest([current.binding, proof.turnId])
      const owner = store.read(turns, turnKey)
      assert(!owner || object(owner.value).executionId === id, 'EXECUTION_CORRELATION_CONFLICT', 'The verified turn belongs to another execution.')
      receipt(id, proof.evidenceId, proof)
      if (!owner) store.write(turns, turnKey, { executionId: id }, { expectedRevision: null })
      const next = update(id, value => {
        canRelease(value)
        return { ...value, status: proof.outcome === 'completed' ? 'completed' : 'failed', externalStatus: proof.outcome,
          isolated: false, cancelStatus: value.cancelStatus === 'accepted' ? 'confirmed' : value.cancelStatus,
          userMessage: value.userMessage ?? { eventId: proof.evidenceId, messageId: proof.userMessageId },
          turn: value.turn ?? { id: proof.turnId, evidenceId: proof.evidenceId }, lastEventId: proof.evidenceId,
          lateOutcome: { eventId: proof.evidenceId, outcome: proof.outcome }, lastError: null }
      })
      release(next)
      return next
    },
    retireToBinding(id: string, proof: { readonly binding: SessionBinding; readonly target: SessionBinding;
      readonly evidenceId: string; readonly checkpointHash: string }) {
      assertRunning()
      const current = get(id)
      assert(current && current.isolated && digest(current.binding) === digest(proof.binding)
        && proof.target.conversationId === current.binding.conversationId && reference(proof.target.sessionId)
        && proof.target.sessionId !== current.binding.sessionId && proof.target.generation === current.binding.generation + 1
        && reference(proof.evidenceId) && /^[a-f0-9]{64}$/.test(proof.checkpointHash),
      'EXECUTION_RETIREMENT_INVALID', 'Recovery must preserve evidence and move to a distinct successor address.')
      const authoritative = object(store.read('host.sessions', current.binding.conversationId)?.value)
      assert(authoritative.state === 'ready' && authoritative.sessionId === proof.target.sessionId
        && authoritative.generation === proof.target.generation, 'EXECUTION_RETIREMENT_INVALID', 'The successor binding is not authoritative.')
      const value = json({ schema: 1, executionId: id, ...proof })
      const prior = store.read(retirements, id)
      assert(!prior || digest(prior.value) === digest(value), 'EXECUTION_RETIREMENT_CONFLICT', 'An execution cannot change its successor.')
      if (!prior) store.write(retirements, id, value, { expectedRevision: null })
      releaseRetired(current)
      return current
    },
    observe(id: string, event: { readonly eventId: string; readonly binding: SessionBinding; readonly turnId: string;
      readonly kind: 'progress' | 'completed' | 'failed' | 'cancelled' }) {
      assertRunning()
      expire(id)
      const current = get(id)
      assert(current, 'EXECUTION_NOT_FOUND', 'The execution does not exist.')
      assert(['progress', 'completed', 'failed', 'cancelled'].includes(event.kind),
        'EXECUTION_INVALID_EVIDENCE', 'A known event kind is required.')
      if (digest(current.binding) !== digest(event.binding) || current.turn?.id !== event.turnId) {
        return snapshot({ decision: 'unattributed' as const, execution: current })
      }
      if (!receipt(id, event.eventId, event)) return snapshot({ decision: 'duplicate' as const, execution: current })
      if (terminalExternal.has(current.externalStatus) && event.kind !== 'cancelled') {
        return snapshot({ decision: 'record-only' as const, execution: current })
      }
      if (event.kind === 'progress') {
        const next = update(id, value => ({ ...value, progressEvents: value.progressEvents + 1, lastEventId: event.eventId }))
        return snapshot({ decision: 'progress' as const, execution: next })
      }
      const outcome = event.kind
      const deliver = !current.deadlineReached && ['submitting', 'running'].includes(current.status) && outcome === 'completed'
      const next = update(id, value => settleIsolation({ ...value,
        status: value.deadlineReached || value.status === 'unknown' ? value.status : outcome === 'completed' ? 'completed' : 'failed',
        externalStatus: outcome, cancelStatus: outcome === 'cancelled' && value.cancelStatus === 'accepted' ? 'confirmed' : value.cancelStatus,
        lastEventId: event.eventId,
        lateOutcome: deliver ? value.lateOutcome : { eventId: event.eventId, outcome } }))
      release(next)
      return snapshot({ decision: deliver ? 'deliver' as const : 'record-only' as const, execution: next })
    },
    lost(id: string) {
      assertRunning()
      return update(id, value => terminalExternal.has(value.externalStatus) ? value
        : { ...value, status: 'unknown', externalStatus: 'unknown', isolated: true, lastError: 'EXECUTION_STREAM_LOST' })
    },
    tick() {
      assertRunning()
      for (const id of timers.keys()) expire(id)
    },
    list,
    metrics() { return { started, stopped, faulted, deadlines: timers.size, pendingActions: pending.size, rawPending, maxPendingOperations } },
    stop() {
      if (stopping) return stopping
      stopped = true
      lifetime.abort()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const controller of signals.values()) controller.abort()
      signals.clear()
      for (const current of started ? activeRecords() : []) {
        if (terminalExternal.has(current.externalStatus) && !unsettledCancel.has(current.cancelStatus)) { release(current); continue }
        const next = update(current.id, value => value.externalStatus === 'not-started'
          ? { ...value, status: 'rejected', externalStatus: 'rejected', isolated: false, lastError: 'EXECUTION_STOPPED_BEFORE_SUBMIT' }
          : { ...value, status: 'unknown', externalStatus: 'unknown', isolated: true,
            cancelStatus: unsettledCancel.has(value.cancelStatus) ? 'unknown' : value.cancelStatus,
            noticeStatus: value.noticeStatus === 'sending' ? 'unknown' : value.noticeStatus, lastError: 'EXECUTION_STOPPED_UNKNOWN' })
        release(next)
      }
      stopping = Promise.allSettled([...pending]).then(() => undefined)
      return stopping
    }
  })
}
