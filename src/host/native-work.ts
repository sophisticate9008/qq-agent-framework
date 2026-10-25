import type { NativeWorkBackendResult, NativeWorkResultDelivery, NativeWorkView } from '../contracts/native-work.ts'
export type { NativeWorkBackendResult, NativeWorkResultDelivery, NativeWorkView } from '../contracts/native-work.ts'
import { deliveryMessageId, isFileUploadReceipt, normalizeDeliveryReceipt } from '../core/delivery.ts'
import { randomUUID } from 'node:crypto'
import type { DeliveryReceipt, EffectRequest, EffectScope, JsonObject, JsonValue } from '../core/types.ts'
import { normalizeContent } from '../core/content.ts'
import { assert, errorCode, isRecord, reference, snapshot } from '../core/values.ts'
import { digest, json, object } from './data.ts'
import { withDeadline } from './deadlines.ts'
import type { NativeMessageSource, NativeMessageSourceReader } from './native-message-sources.ts'
import { validateNativeWorkConfiguration, type NativeWorkConfiguration } from './native-work-configuration.ts'
import type { DurableStore, StoredRecord } from './types.ts'
import type { NativeEventInput } from '../contracts/native-events.ts'
import { mapNativeWorkObservation } from './native-event-mapping.ts'

export interface NativeWorkActivation {
  readonly childId: string
  readonly result: Promise<NativeWorkBackendResult>
  dispose(): Promise<void>
}

export interface NativeWorkBackend {
  verify(request: {
    readonly configuration: Readonly<NativeWorkConfiguration>
    readonly parentSessionId: string
    readonly generation?: number
    readonly signal: AbortSignal
  }): Promise<void>
  start(request: {
    readonly id: string
    readonly childId: string
    readonly parentSessionId: string
    readonly generation?: number
    readonly task: string
    readonly context: string
    readonly source: Readonly<NativeMessageSource>
    readonly configuration: Readonly<NativeWorkConfiguration>
    readonly signal: AbortSignal
  }): Promise<NativeWorkActivation>
  inspect?(request: NativeWorkBackendAddress): Promise<{ readonly state: 'starting' | 'running' | 'completed' | 'unknown'; readonly result: NativeWorkBackendResult | null }>
  followup?(request: NativeWorkBackendAddress & { readonly requestId: string; readonly text: string; readonly delivery: 'queue' | 'steer' }): Promise<{ readonly messageId: string }>
  interrupt?(request: NativeWorkBackendAddress): Promise<void>
}

export interface NativeWorkBackendAddress {
  readonly id: string
  readonly childId: string
  readonly parentSessionId: string
  readonly generation: number
  readonly signal: AbortSignal
}

export interface NativeWorkExecutorOptions {
  readonly store: DurableStore
  readonly messageSources: Readonly<NativeMessageSourceReader>
  readonly loadConfiguration: () => Promise<NativeWorkConfiguration>
  readonly authorize: (scope: Readonly<EffectScope>, signal: AbortSignal) => Promise<void>
  readonly backend?: NativeWorkBackend
  readonly maxPending?: number
  readonly onFault?: (code: string) => void
  readonly onObservation?: (event: NativeEventInput) => void
  readonly onResult?: (result: Readonly<NativeWorkResultDelivery>, signal: AbortSignal) => Promise<DeliveryReceipt>
  readonly isCurrentParent?: (binding: { readonly conversationId: string; readonly sessionId: string; readonly generation: number }) => boolean
  readonly maxRecoveryRecords?: number
  readonly registerChild?: (binding: { readonly childId: string; readonly parentSessionId: string; readonly conversationId: string;
    readonly generation: number; readonly ownerId: string; readonly expiresAt: number }) => () => void
}

interface PendingWork {
  record: StoredRecord
  readonly controller: AbortController
  activation?: NativeWorkActivation
  disposal?: Promise<void>
  operation?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  releaseChild?: () => void
}

const namespace = 'native-work.executions'
const states = ['starting', 'running', 'completed', 'failed', 'unknown'] as const
const deliveries = ['not-requested', 'delivering', 'confirmed', 'rejected', 'unknown', 'unavailable'] as const
const controlNamespace = 'native-work.controls'

function validatedResult(input: unknown): Readonly<NativeWorkBackendResult> {
  assert(isRecord(input) && reference(input.stopReason) && Array.isArray(input.output) && input.output.length <= 256
    && Buffer.byteLength(JSON.stringify(input.output), 'utf8') <= 256 * 1024,
  'INVALID_NATIVE_WORK_RESULT', 'The work result cannot be interpreted safely.')
  const output = input.output.flatMap(block => normalizeContent([block]))
  return snapshot({ stopReason: input.stopReason, output })
}

function projection(record: StoredRecord): Readonly<NativeWorkView> {
  receipt(record)
  const value = object(record.value)
  assert(reference(value.parentSessionId) && reference(value.conversationId)
    && Number.isSafeInteger(value.generation) && Number(value.generation) > 0
    && Number.isSafeInteger(value.createdAt) && Number(value.createdAt) >= 0
    && Number.isSafeInteger(value.deadlineAt) && Number(value.deadlineAt) >= Number(value.createdAt)
    && (value.lastError === null || value.lastError === undefined || typeof value.lastError === 'string' && /^[A-Z][A-Z_]{1,63}$/.test(value.lastError)),
  'INVALID_NATIVE_WORK_RECORD', 'The work binding or deadline is invalid.')
  const delivery = value.delivery ?? 'unavailable'
  assert(deliveries.some(state => state === delivery), 'INVALID_NATIVE_WORK_RECORD', 'The work delivery state is invalid.')
  return snapshot({ id: record.key, childId: String(value.childId), parentSessionId: value.parentSessionId,
    conversationId: value.conversationId, generation: Number(value.generation), createdAt: Number(value.createdAt), deadlineAt: Number(value.deadlineAt),
    status: value.status as NativeWorkView['status'], result: value.result == null ? null : validatedResult(value.result),
    lateResult: value.lateResult == null ? null : validatedResult(value.lateResult), delivery: delivery as NativeWorkView['delivery'],
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    resultId: typeof value.resultId === 'string' ? value.resultId : null,
    deliveryId: typeof value.deliveryId === 'string' ? value.deliveryId : null,
    deliveryMessageId: typeof value.deliveryMessageId === 'string' ? value.deliveryMessageId : null,
    deliveryError: typeof value.deliveryError === 'string' ? value.deliveryError : null,
    deliveryFileId: typeof value.deliveryFileId === 'string' ? value.deliveryFileId : null })
}

function workInput(input: JsonValue): { readonly task: string; readonly context: string } {
  assert(isRecord(input) && Object.hasOwn(input, 'task')
    && Object.keys(input).every(key => key === 'task' || key === 'context')
    && typeof input.task === 'string' && input.task.trim().length > 0 && input.task.length <= 16_000
    && (!Object.hasOwn(input, 'context') || typeof input.context === 'string' && input.context.length <= 32_000),
  'INVALID_NATIVE_WORK_INPUT', 'Work needs a bounded task and optional context, not caller-supplied authority.')
  const context = Object.hasOwn(input, 'context') ? input.context as string : ''
  assert(Buffer.byteLength(input.task + context, 'utf8') <= 64 * 1024,
    'INVALID_NATIVE_WORK_INPUT', 'Work input exceeds the text limit.')
  return Object.freeze({ task: input.task, context })
}

function receipt(record: StoredRecord): JsonObject {
  const value = object(record.value)
  assert(value.schema === 1 && value.id === record.key && reference(value.childId)
    && typeof value.status === 'string' && states.some(state => state === value.status),
  'INVALID_NATIVE_WORK_RECORD', 'The work record cannot be interpreted safely.')
  return snapshot({ id: record.key, childId: value.childId, status: value.status,
    automaticReplayAvailable: false, externalToolAuthorizationVerified: false })
}

export function createNativeWorkExecutor(options: NativeWorkExecutorOptions) {
  function observe(record: StoredRecord): void {
    if (!options.onObservation) return
    try {
      const event = mapNativeWorkObservation(projection(record))
      if (event) void Promise.resolve(options.onObservation?.(event)).catch(() => {})
    } catch {}
  }
  const maxPending = options.maxPending ?? 4
  assert(Number.isSafeInteger(maxPending) && maxPending >= 1 && maxPending <= 16,
    'INVALID_NATIVE_WORK_OPTIONS', 'Work requires a bounded pending-operation limit.')
  const lifetime = new AbortController()
  const pending = new Map<string, PendingWork>()
  const activeControls = new Set<string>()
  let admissions = 0
  let closed = false
  const maxRecovery = options.maxRecoveryRecords ?? 10000
  assert(Number.isSafeInteger(maxRecovery) && maxRecovery >= 1 && maxRecovery <= 100000,
    'INVALID_NATIVE_WORK_OPTIONS', 'Work recovery must have a bounded record limit.')
  const childIds = new Map<string, string>()
  if (options.store.createIndex && options.store.lookup) options.store.createIndex({ namespace, field: 'childId', unique: true })
  let recovered = 0
  let after: string | undefined
  for (;;) {
    const batch = options.store.list(namespace, { limit: 100, ...(after === undefined ? {} : { after }) })
    for (const stored of batch) {
      assert(++recovered <= maxRecovery, 'NATIVE_WORK_RECOVERY_LIMIT', 'The work history exceeds the configured recovery bound.')
      const view = projection(stored)
      assert(!childIds.has(view.childId), 'NATIVE_WORK_CHILD_CONFLICT', 'A child session belongs to multiple work records.')
      childIds.set(view.childId, view.id)
      const value = object(stored.value)
      if (view.status === 'starting' || view.status === 'running' || view.delivery === 'delivering') {
        const interrupted = options.store.write(namespace, stored.key, { ...value,
          ...(view.status === 'starting' || view.status === 'running' ? { status: 'unknown', lastError: 'NATIVE_WORK_INTERRUPTED' } : {}),
          ...(view.delivery === 'delivering' ? { delivery: 'unknown', deliveryError: 'NATIVE_WORK_DELIVERY_INTERRUPTED' } : {}) },
        { expectedRevision: stored.revision })
        observe(interrupted)
      }
    }
    if (batch.length < 100) break
    after = batch.at(-1)!.key
  }

  function fault(error: unknown) {
    try { options.onFault?.(errorCode(error, 'NATIVE_WORK_UNKNOWN')) } catch {}
  }

  function update(entry: PendingWork, changes: JsonObject) {
    const previousStatus = object(entry.record.value).status
    entry.record = options.store.write(namespace, entry.record.key,
      { ...object(entry.record.value), ...changes }, { expectedRevision: entry.record.revision })
    if (object(entry.record.value).status !== previousStatus) observe(entry.record)
  }

  function dispose(entry: PendingWork): Promise<void> | undefined {
    if (!entry.activation) return undefined
    entry.disposal ??= Promise.resolve().then(() => entry.activation!.dispose())
    void entry.disposal.catch(fault)
    return entry.disposal
  }

  function releaseChild(entry: PendingWork): void {
    const release = entry.releaseChild
    delete entry.releaseChild
    try { release?.() } catch (error) { fault(error) }
  }

  function registerChild(entry: PendingWork): void {
    if (!options.registerChild || entry.releaseChild) return
    const view = projection(entry.record)
    const ownerId = object(entry.record.value).ownerId
    assert(reference(ownerId), 'INVALID_NATIVE_WORK_RECORD', 'The work child requires its recorded owner.')
    entry.releaseChild = options.registerChild({ childId: view.childId, parentSessionId: view.parentSessionId,
      conversationId: view.conversationId, generation: view.generation, ownerId, expiresAt: view.deadlineAt })
    assert(typeof entry.releaseChild === 'function', 'INVALID_WORK_CHILD_REGISTRATION', 'Child routing requires a disposable scope registration.')
  }

  function isolate(entry: PendingWork, code: string) {
    entry.controller.abort()
    releaseChild(entry)
    try {
      if (!['completed', 'failed'].includes(String(object(entry.record.value).status))) {
        update(entry, { status: 'unknown', lastError: code })
      }
    } catch (error) { fault(error) }
    dispose(entry)
  }

  function currentParent(view: NativeWorkView): boolean {
    return options.isCurrentParent?.({ conversationId: view.conversationId, sessionId: view.parentSessionId, generation: view.generation }) === true
  }

  async function settle(entry: PendingWork, input: NativeWorkBackendResult): Promise<void> {
    const result = validatedResult(input)
    const value = object(entry.record.value)
    const resultId = digest({ id: entry.record.key, runId: value.runId ?? entry.record.key, result })
    if (!options.store.read('native-work.results', resultId)) options.store.write('native-work.results', resultId,
      json({ schema: 1, workId: entry.record.key, resultId, conversationId: value.conversationId,
        parentSessionId: value.parentSessionId, childId: value.childId, generation: value.generation,
        observedAt: Date.now(), result }), { expectedRevision: null })
    if (value.status === 'unknown') {
      update(entry, { lateOutcome: { stopReason: result.stopReason, outputFingerprint: digest(result.output) }, lateResult: json(result) })
      return
    }
    update(entry, { stopReason: result.stopReason, outputFingerprint: digest(result.output), result: json(result), resultId,
      status: result.stopReason === 'completed' ? 'completed' : 'failed',
      delivery: options.onResult ? 'delivering' : 'unavailable', deliveryError: null,
      deliveryId: options.onResult ? `work-result:${resultId}` : null, deliveryMessageId: null, deliveryFileId: null })
    if (!options.onResult) return
    const view = projection(entry.record)
    if (closed || !currentParent(view)) {
      update(entry, { delivery: 'rejected', deliveryError: 'WORK_PARENT_UNAVAILABLE' }); return
    }
    const deliveryId = `work-result:${resultId}`
    try {
      const receipt = normalizeDeliveryReceipt(await withDeadline({ signal: AbortSignal.any([lifetime.signal, entry.controller.signal]),
        timeoutMs: Math.max(1, Math.min(30000, view.deadlineAt - Date.now())), code: 'NATIVE_WORK_DELIVERY_UNKNOWN',
        run: signal => options.onResult!({ ...result, id: view.id, resultId, deliveryId, childId: view.childId,
          parentSessionId: view.parentSessionId, conversationId: view.conversationId, generation: view.generation }, signal) }))
      update(entry, { delivery: receipt.status, deliveryId,
        deliveryMessageId: deliveryMessageId(receipt), deliveryFileId: isFileUploadReceipt(receipt) ? receipt.fileId : null,
        deliveryError: receipt.status === 'confirmed' ? null : 'NATIVE_WORK_DELIVERY_UNCONFIRMED' })
    } catch (error) {
      update(entry, { delivery: 'unknown', deliveryId, deliveryError: errorCode(error, 'NATIVE_WORK_DELIVERY_UNKNOWN') })
      fault(error)
    }
  }

  function finish(entry: PendingWork): void {
    releaseChild(entry)
    clearTimeout(entry.timer)
    if (pending.get(entry.record.key) === entry) pending.delete(entry.record.key)
  }

  function read(id: string): Readonly<NativeWorkView> | null {
    assert(reference(id), 'INVALID_NATIVE_WORK_INPUT', 'A work identifier is required.')
    const stored = options.store.read(namespace, id)
    return stored ? projection(stored) : null
  }

  async function control(request: EffectRequest, operation: 'followup' | 'interrupt'): Promise<JsonValue> {
    assert(!closed, 'NATIVE_WORK_CLOSED', 'The work executor is closed.')
    const input = request.input
    assert(isRecord(input) && reference(input.id) && (operation === 'interrupt'
      ? Object.keys(input).length === 1
      : Object.keys(input).every(key => ['id', 'text', 'delivery'].includes(key)) && typeof input.text === 'string'
        && input.text.trim().length > 0 && input.text.length <= 16000
        && (input.delivery === undefined || input.delivery === 'queue' || input.delivery === 'steer')),
    'INVALID_NATIVE_WORK_INPUT', 'Work control accepts an identifier and bounded follow-up text, never caller authority.')
    const scope = snapshot(request.scope)
    const signal = AbortSignal.any([request.signal, lifetime.signal])
    const source = await options.messageSources.requireOwner(scope, signal)
    await withDeadline({ signal, timeoutMs: 5000, code: 'NATIVE_WORK_AUTHORIZATION_UNAVAILABLE',
      run: activeSignal => options.authorize(scope, activeSignal) })
    const record = options.store.read(namespace, input.id)
    assert(record, 'NATIVE_WORK_NOT_FOUND', 'The addressed work does not exist.')
    const view = projection(record)
    assert(view.conversationId === scope.conversationId && view.parentSessionId === scope.sessionId
      && view.generation === scope.generation && source.userId === object(record.value).ownerId && currentParent(view),
    'NATIVE_WORK_SCOPE_MISMATCH', 'Only the current owner in the original parent conversation may control this work.')
    const backend = options.backend
    assert(backend, 'NATIVE_WORK_BACKEND_UNAVAILABLE', 'The work backend is unavailable.')
    const id = digest({ eventId: scope.eventId, conversationId: scope.conversationId, parentSessionId: scope.sessionId,
      generation: scope.generation, workId: view.id, operation })
    const fingerprint = digest({ input, ownerId: source.userId })
    let existing = options.store.read(controlNamespace, id)
    if (existing) {
      const value = object(existing.value)
      assert(value.fingerprint === fingerprint, 'NATIVE_WORK_CONFLICT', 'This source already identifies different work control.')
      if (value.state === 'requesting' && !activeControls.has(id)) existing = options.store.write(controlNamespace, id,
        { ...value, state: 'unknown', lastError: 'NATIVE_WORK_CONTROL_INTERRUPTED' }, { expectedRevision: existing.revision })
      return snapshot({ id, workId: view.id, state: object(existing.value).state, automaticReplayAvailable: false })
    }
    assert(view.status !== 'unknown', 'NATIVE_WORK_RECONCILIATION_REQUIRED', 'Uncertain work must be inspected before a new control action.')
    assert(operation !== 'followup' || backend.followup && backend.inspect,
      'NATIVE_WORK_CONTINUATION_UNAVAILABLE', 'This backend does not support verifiable follow-up.')
    const active = pending.get(view.id)
    assert(operation !== 'followup' || !active || view.status === 'starting' || view.status === 'running',
      'NATIVE_WORK_BUSY', 'The previous work result is still being recorded or delivered.')
    assert(operation !== 'followup' || active || pending.size < maxPending,
      'NATIVE_WORK_BACKPRESSURE', 'Work observation capacity is occupied.')
    let marker = options.store.write(controlNamespace, id, { schema: 1, id, fingerprint, workId: view.id,
      operation, state: 'requesting', createdAt: Date.now(), lastError: null }, { expectedRevision: null })
    let followup: PendingWork | undefined
    activeControls.add(id)
    try {
      await options.messageSources.requireOwner(scope, signal)
      await options.authorize(scope, signal)
      signal.throwIfAborted()
      assert(currentParent(projection(options.store.read(namespace, view.id)!)), 'NATIVE_WORK_SCOPE_MISMATCH', 'The parent binding changed.')
      if (operation === 'interrupt') {
        assert(backend.interrupt || active?.activation, 'NATIVE_WORK_INTERRUPT_UNAVAILABLE', 'This backend has no verified interrupt control.')
        await withDeadline({ signal, timeoutMs: 5000, code: 'NATIVE_WORK_CONTROL_UNKNOWN', run: activeSignal => backend.interrupt
          ? backend.interrupt({ id: view.id, childId: view.childId, parentSessionId: view.parentSessionId, generation: view.generation, signal: activeSignal })
          : active!.activation!.dispose() })
      } else {
        const configuration = validateNativeWorkConfiguration(await options.loadConfiguration())
        assert(configuration.enabled, 'NATIVE_WORK_DISABLED', 'Independent work is disabled.')
        const entry = active ?? { controller: new AbortController(), record: options.store.read(namespace, view.id)! }
        if (!active) {
          followup = entry
          update(entry, { status: 'starting', runId: id, result: null, lateResult: null, delivery: 'not-requested', stopReason: null,
            deadlineAt: Date.now() + configuration.timeoutMs, lastError: null })
          pending.set(view.id, entry)
          entry.timer = setTimeout(() => isolate(entry, 'NATIVE_WORK_TIMEOUT_UNKNOWN'), configuration.timeoutMs)
        } else assert(Date.now() < view.deadlineAt, 'NATIVE_WORK_RECONCILIATION_REQUIRED', 'The active work deadline has elapsed.')
        registerChild(entry)
        const accepted = await withDeadline({ signal, timeoutMs: 5000, code: 'NATIVE_WORK_CONTROL_UNKNOWN',
          run: activeSignal => backend.followup!({ id: view.id, childId: view.childId, parentSessionId: view.parentSessionId,
            generation: view.generation, signal: activeSignal, requestId: id, text: String(input.text),
            delivery: input.delivery === 'steer' ? 'steer' : 'queue' }) })
        assert(reference(accepted.messageId), 'INVALID_NATIVE_WORK_RECEIPT', 'Follow-up requires an accepted SDK inbox identity.')
        if (followup) {
          update(entry, { status: 'running' })
          entry.operation = withDeadline({ signal: AbortSignal.any([entry.controller.signal, lifetime.signal]),
            timeoutMs: configuration.timeoutMs, code: 'NATIVE_WORK_RESULT_UNKNOWN', run: async activeSignal => {
              for (;;) {
                const observed = await backend.inspect!({ id: view.id, childId: view.childId,
                  parentSessionId: view.parentSessionId, generation: view.generation, signal: activeSignal })
                assert(observed.state !== 'unknown', 'NATIVE_WORK_RESULT_UNKNOWN', 'The continuation result cannot be verified.')
                if (observed.state === 'completed') {
                  assert(observed.result, 'INVALID_NATIVE_WORK_RESULT', 'Completed work needs a captured result.')
                  await settle(entry, observed.result); return
                }
                await new Promise<void>(resolve => {
                  const timer = setTimeout(done, 100)
                  function done() { clearTimeout(timer); activeSignal.removeEventListener('abort', done); resolve() }
                  activeSignal.addEventListener('abort', done, { once: true })
                  if (activeSignal.aborted) done()
                })
                activeSignal.throwIfAborted()
              }
            } }).catch(error => { isolate(entry, errorCode(error, 'NATIVE_WORK_RESULT_UNKNOWN')); fault(error) })
            .finally(() => finish(entry))
        }
        marker = options.store.write(controlNamespace, id, { ...object(marker.value), state: 'accepted', messageId: accepted.messageId },
          { expectedRevision: marker.revision })
        return snapshot({ id, workId: view.id, state: 'accepted', messageId: accepted.messageId, automaticReplayAvailable: false })
      }
      marker = options.store.write(controlNamespace, id, { ...object(marker.value), state: 'accepted' }, { expectedRevision: marker.revision })
      return snapshot({ id, workId: view.id, state: 'accepted', automaticReplayAvailable: false })
    } catch (error) {
      if (followup) { isolate(followup, errorCode(error, 'NATIVE_WORK_CONTROL_UNKNOWN')); finish(followup) }
      options.store.write(controlNamespace, id, { ...object(marker.value), state: 'unknown', lastError: errorCode(error, 'NATIVE_WORK_CONTROL_UNKNOWN') },
        { expectedRevision: marker.revision })
      throw error
    } finally { activeControls.delete(id) }
  }

  async function execute(request: EffectRequest): Promise<JsonValue> {
    assert(!closed, 'NATIVE_WORK_CLOSED', 'The work executor is closed.')
    assert(admissions + pending.size < maxPending, 'NATIVE_WORK_BACKPRESSURE', 'Work capacity is occupied.')
    admissions++
    try {
      const input = workInput(request.input)
      const scope = snapshot(request.scope)
      assert(reference(scope.eventId) && reference(scope.conversationId) && reference(scope.featureId)
        && reference(scope.version) && reference(scope.sessionId)
        && typeof scope.generation === 'number' && Number.isSafeInteger(scope.generation) && scope.generation > 0,
      'NATIVE_WORK_SCOPE_REQUIRED', 'Work requires the trusted current parent-session scope.')
      const signal = AbortSignal.any([request.signal, lifetime.signal])
      const source = await options.messageSources.requireOwner(scope, signal)
      await withDeadline({ signal, timeoutMs: 5_000, code: 'NATIVE_WORK_AUTHORIZATION_UNAVAILABLE',
        run: currentSignal => options.authorize(scope, currentSignal) })
      const configuration = validateNativeWorkConfiguration(await withDeadline({ signal, timeoutMs: 5_000,
        code: 'NATIVE_WORK_CONFIGURATION_UNAVAILABLE', run: () => options.loadConfiguration() }))
      assert(configuration.enabled, 'NATIVE_WORK_DISABLED', 'Independent work is disabled.')
      const backend = options.backend
      assert(backend, 'NATIVE_WORK_BACKEND_UNAVAILABLE', 'No verified DSH subagent backend is connected.')
      const parentSessionId = scope.sessionId
      const id = digest({ scope, sourceMessageId: source.sourceMessageId, ownerId: source.userId })
      const fingerprint = digest({ input, configuration })
      let prior = options.store.read(namespace, id)
      if (prior) {
        const value = object(prior.value)
        receipt(prior)
        assert(value.fingerprint === fingerprint, 'NATIVE_WORK_CONFLICT', 'This source already identifies different work.')
        if (!pending.has(id) && (value.status === 'starting' || value.status === 'running')) {
          prior = options.store.write(namespace, id, { ...value, status: 'unknown', lastError: 'NATIVE_WORK_INTERRUPTED' },
            { expectedRevision: prior.revision })
        }
        return receipt(prior)
      }
      await withDeadline({ signal, timeoutMs: 5_000, code: 'NATIVE_WORK_BACKEND_UNAVAILABLE',
        run: currentSignal => backend.verify({ configuration, parentSessionId, signal: currentSignal }) })
      const liveSource = await options.messageSources.requireOwner(scope, signal)
      assert(digest(liveSource) === digest(source), 'NATIVE_WORK_SOURCE_CHANGED', 'The original owner source changed.')
      signal.throwIfAborted()
      const childId = randomUUID()
      const createdAt = Date.now()
      const deadlineAt = createdAt + configuration.timeoutMs
      const entry: PendingWork = { controller: new AbortController(),
        record: options.store.write(namespace, id, json({ schema: 1, id, fingerprint, childId, status: 'starting',
          conversationId: scope.conversationId, sourceMessageId: source.sourceMessageId, ownerId: source.userId,
          parentSessionId, generation: scope.generation, configuration, createdAt, deadlineAt, runId: id,
          stopReason: null, result: null, lateResult: null, delivery: 'not-requested', lastError: null }), { expectedRevision: null }) }
      childIds.set(childId, id)
      observe(entry.record)
      pending.set(id, entry)
      entry.timer = setTimeout(() => isolate(entry, 'NATIVE_WORK_TIMEOUT_UNKNOWN'), configuration.timeoutMs)
      let publication: Promise<NativeWorkActivation> | undefined
      try {
        await withDeadline({ signal, timeoutMs: Math.max(1, Math.min(configuration.timeoutMs, source.expiresAt - Date.now())),
          code: 'NATIVE_WORK_START_UNKNOWN', run: currentSignal => {
            publication = (async () => {
              const executionSignal = AbortSignal.any([currentSignal, entry.controller.signal])
              await options.messageSources.requireOwner(scope, executionSignal)
              await options.authorize(scope, executionSignal)
              const current = validateNativeWorkConfiguration(await options.loadConfiguration())
              assert(digest(current) === digest(configuration), 'NATIVE_WORK_CONFIGURATION_CHANGED', 'Work configuration changed.')
              executionSignal.throwIfAborted()
              registerChild(entry)
              const activation = await backend.start({ id, childId, parentSessionId, generation: scope.generation, ...input,
                source, configuration, signal: executionSignal })
              entry.activation = activation
              assert(activation.childId === childId && typeof activation.dispose === 'function'
                && activation.result instanceof Promise, 'INVALID_NATIVE_WORK_ACTIVATION', 'The backend returned a different activation.')
              if (executionSignal.aborted) {
                isolate(entry, 'NATIVE_WORK_START_UNKNOWN')
              } else update(entry, { status: 'running' })
              return activation
            })()
            entry.operation = publication.then(async activation => {
              await settle(entry, await activation.result)
            }).catch(error => {
              isolate(entry, errorCode(error, 'NATIVE_WORK_UNKNOWN'))
              fault(error)
            }).finally(async () => {
              clearTimeout(entry.timer)
              if (entry.disposal) {
                try { await entry.disposal } catch (error) { fault(error) }
              }
              finish(entry)
            })
            return publication
          } })
      } catch (error) {
        isolate(entry, errorCode(error, 'NATIVE_WORK_START_UNKNOWN'))
        if (!publication) { clearTimeout(entry.timer); pending.delete(id) }
        throw error
      }
      return receipt(entry.record)
    } finally { admissions-- }
  }

  return Object.freeze({ execute, read,
    list(query: { readonly conversationId?: string; readonly limit?: number; readonly after?: string } = {}) {
      const limit = query.limit ?? 100
      assert(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000
        && (query.conversationId === undefined || reference(query.conversationId))
        && (query.after === undefined || reference(query.after)), 'INVALID_NATIVE_WORK_INPUT', 'Work listing needs bounded pagination.')
      const batch = options.store.list(namespace, { limit, ...(query.after === undefined ? {} : { after: query.after }) })
      return snapshot({ records: batch.map(projection).filter(view => query.conversationId === undefined || view.conversationId === query.conversationId),
        next: batch.length === limit ? batch.at(-1)!.key : null })
    },
    resolveChild(childId: string) {
      if (closed || !reference(childId)) return null
      const indexed = options.store.lookup && options.store.createIndex
        ? options.store.lookup({ namespace, field: 'childId', equals: childId, limit: 2 }) : undefined
      assert(indexed === undefined || indexed.length <= 1, 'NATIVE_WORK_CHILD_CONFLICT', 'A child session has conflicting work ownership.')
      const id = indexed?.[0]?.key ?? childIds.get(childId)
      if (!id) return null
      const record = options.store.read(namespace, id)
      if (!record) return null
      const view = projection(record)
      const ownerId = object(record.value).ownerId
      if (view.childId !== childId || !['starting', 'running'].includes(view.status)
        || Date.now() >= view.deadlineAt || !reference(ownerId) || !currentParent(view)) return null
      return snapshot({ id: view.id, childId: view.childId, parentSessionId: view.parentSessionId,
        conversationId: view.conversationId, generation: view.generation, ownerId, expiresAt: view.deadlineAt })
    },
    followup(request: EffectRequest) { return control(request, 'followup') },
    interrupt(request: EffectRequest) { return control(request, 'interrupt') },
    async reconcile(request: EffectRequest): Promise<Readonly<NativeWorkView>> {
      assert(!closed && isRecord(request.input) && Object.keys(request.input).length === 1 && reference(request.input.id),
        'INVALID_NATIVE_WORK_INPUT', 'Work reconciliation accepts one work identifier.')
      const signal = AbortSignal.any([request.signal, lifetime.signal])
      const source = await options.messageSources.requireOwner(request.scope, signal)
      await options.authorize(request.scope, signal)
      const record = options.store.read(namespace, request.input.id)
      assert(record, 'NATIVE_WORK_NOT_FOUND', 'The addressed work does not exist.')
      const view = projection(record)
      assert(view.conversationId === request.scope.conversationId && view.parentSessionId === request.scope.sessionId
        && view.generation === request.scope.generation && source.userId === object(record.value).ownerId && currentParent(view),
      'NATIVE_WORK_SCOPE_MISMATCH', 'Only the current original parent may inspect this work backend.')
      assert(options.backend?.inspect, 'NATIVE_WORK_INSPECTION_UNAVAILABLE', 'The backend cannot inspect durable work results.')
      if (pending.has(view.id)) return view
      const observed = await withDeadline({ signal, timeoutMs: 5000, code: 'NATIVE_WORK_INSPECTION_UNKNOWN',
        run: activeSignal => options.backend!.inspect!({ id: view.id, childId: view.childId,
          parentSessionId: view.parentSessionId, generation: view.generation, signal: activeSignal }) })
      const evidence: JsonObject = { observedState: observed.state, observedAt: Date.now() }
      if (observed.state === 'completed') {
        assert(observed.result, 'INVALID_NATIVE_WORK_RESULT', 'Completed work requires captured result evidence.')
        const result = validatedResult(observed.result)
        if (view.status === 'unknown' || view.result === null) Object.assign(evidence,
          { result: json(result), stopReason: result.stopReason, status: result.stopReason === 'completed' ? 'completed' : 'failed',
            delivery: 'unknown', deliveryError: 'NATIVE_WORK_RECOVERED_UNDELIVERED', lastError: null })
        else if (digest(view.result) !== digest(result)) Object.assign(evidence,
          { lateResult: json(result), lastError: 'NATIVE_WORK_REMOTE_CHANGED', status: 'unknown' })
      }
      const updated = options.store.write(namespace, view.id, { ...object(record.value), ...evidence }, { expectedRevision: record.revision })
      if (object(updated.value).status !== view.status) observe(updated)
      return projection(updated)
    },
    async close(signal: AbortSignal): Promise<void> {
      closed = true
      lifetime.abort()
      const entries = [...pending.values()]
      for (const entry of entries) isolate(entry, 'NATIVE_WORK_STOP_UNKNOWN')
      await withDeadline({ signal, timeoutMs: 5_000, code: 'NATIVE_WORK_STOP_UNKNOWN',
        run: () => Promise.all(entries.map(entry => entry.operation)).then(() => undefined) })
    }
  })
}
