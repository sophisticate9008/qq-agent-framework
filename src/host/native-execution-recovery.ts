import { randomUUID } from 'node:crypto'
import type { DshBridgePluginPort } from '../adapters/dsh-tool-scope.ts'
import type { DshSessionMigrationPort, DshSessionMigrationRequest, DshSessionMigrationReceipt } from '../adapters/dsh-session-migration.ts'
import type { DshExecutionEvidence } from '../contracts/dsh-execution-evidence.ts'
import { assert, errorCode, isRecord, reference, snapshot } from '../core/values.ts'
import { digest, json, object, records } from './data.ts'
import { withDeadline } from './deadlines.ts'
import type { createNativeExecutionController, NativeExecutionRecord } from './native-execution.ts'
import { reserveSessionId } from './sessions.ts'
import type { DurableStore, SessionBinding, StoredRecord } from './types.ts'

const namespace = 'host.execution-recovery'
export interface NativeExecutionRecoveryPlan {
  readonly schema: 1
  readonly executionId: string
  readonly revision: string
  readonly binding: SessionBinding
  readonly sourceRevision: number
  readonly evidence: DshExecutionEvidence
  readonly request: DshSessionMigrationRequest
  readonly state: 'available' | 'requested' | 'unknown' | 'confirmed' | 'completed'
  readonly childSessionId: string | null
  readonly missingReasons: readonly string[]
  readonly restartRequired: true
  readonly automaticReplayAvailable: false
}

function decode(record: StoredRecord): NativeExecutionRecoveryPlan {
  const value = object(record.value)
  const { checksum, ...plan } = value
  const binding = object(value.binding)
  const request = object(value.request)
  const evidence = object(value.evidence)
  assert(checksum === digest(plan) && value.schema === 1 && value.executionId === record.key
    && /^[a-f0-9]{64}$/.test(record.key) && /^[a-f0-9]{64}$/.test(String(value.revision))
    && reference(binding.conversationId) && reference(binding.sessionId) && Number.isSafeInteger(binding.generation) && Number(binding.generation) > 0
    && Number.isSafeInteger(value.sourceRevision) && Number(value.sourceRevision) > 0
    && ['available','requested','unknown','confirmed','completed'].includes(String(value.state))
    && (value.childSessionId === null || reference(value.childSessionId) && value.childSessionId !== binding.sessionId)
    && (value.state !== 'confirmed' && value.state !== 'completed' || reference(value.childSessionId))
    && request.sourceSessionId === binding.sessionId && request.expectedPreset === request.targetPreset
    && Object.keys(request).sort().join(',') === 'expectedCursor,expectedPreset,expectedSourceDigest,expectedTargetRevision,issuerEpoch,migrationId,sourceSessionId,targetPreset'
    && reference(request.migrationId) && reference(request.expectedPreset) && reference(request.issuerEpoch)
    && Number.isSafeInteger(request.expectedCursor) && Number(request.expectedCursor) >= 0
    && /^[a-f0-9]{64}$/.test(String(request.expectedSourceDigest)) && /^[a-f0-9]{64}$/.test(String(request.expectedTargetRevision))
    && evidence.state === 'settled' && evidence.sessionId === binding.sessionId && evidence.quiescent === true
    && evidence.checkpointSequence === request.expectedCursor && /^[a-f0-9]{64}$/.test(String(evidence.checkpointHash))
    && Array.isArray(value.missingReasons) && value.missingReasons.length <= 16 && value.missingReasons.every(reason => typeof reason === 'string' && /^execution_[a-z_]+$/.test(reason))
    && value.restartRequired === true && value.automaticReplayAvailable === false,
  'EXECUTION_RECOVERY_CORRUPT', 'Stored recovery evidence is invalid.')
  assert(value.revision === digest({id:value.executionId,binding:value.binding,sourceRevision:value.sourceRevision,evidence:value.evidence,request:value.request}),
    'EXECUTION_RECOVERY_CORRUPT', 'Stored recovery plan identity changed.')
  return snapshot(plan) as unknown as NativeExecutionRecoveryPlan
}

export function readNativeExecutionRecovery(store: Pick<DurableStore,'read'>, executionId: string): NativeExecutionRecoveryPlan | null {
  assert(/^[a-f0-9]{64}$/.test(executionId), 'EXECUTION_RECOVERY_INVALID_QUERY', 'A stable execution identity is required.')
  const row = store.read(namespace,executionId)
  return row ? decode(row) : null
}

/** Fork recovery excludes only the addressed execution and its exact old reply; all other work must be settled. */
export function verifyExecutionRecoveryQuiescence(store: DurableStore, execution: NativeExecutionRecord): void {
  assert(!['sending','unknown'].includes(execution.noticeStatus), 'EXECUTION_RECOVERY_UNSETTLED', 'An unknown QQ notice still requires reconciliation.')
  let count = 0
  for (const currentNamespace of ['host.executions','host.replies','outbox','tasks','host.inbox','native-work.executions','native-chat.inbox']) {
    for (const row of records(store, currentNamespace)) {
      assert(++count <= 100_000, 'EXECUTION_RECOVERY_CAPACITY', 'Recovery inspection exceeds its bound.')
      const value = object(row.value)
      const binding = isRecord(value.binding) ? value.binding : {}
      if (![value.conversationId, binding.conversationId, value.scope].includes(execution.binding.conversationId)
        && ![value.sessionId, binding.sessionId, value.parentSessionId].includes(execution.binding.sessionId)) continue
      if (currentNamespace === 'host.executions' && row.key === execution.id) continue
      if (currentNamespace === 'host.replies' && digest([execution.binding.conversationId, value.requestId, 'prompt']) === execution.requestId) continue
      const settled = currentNamespace === 'host.executions' ? value.isolated === false && ['completed','failed','rejected'].includes(String(value.externalStatus))
        : currentNamespace === 'outbox' ? ['confirmed','rejected'].includes(String(value.status))
        : currentNamespace === 'native-work.executions' ? ['completed','failed'].includes(String(value.status)) && !['delivering','unknown'].includes(String(value.delivery))
        : currentNamespace === 'native-chat.inbox' ? Array.isArray(value.entries) && value.entries.length === 0
        : currentNamespace === 'host.inbox' ? ['accepted','rejected'].includes(String(value.status))
        : currentNamespace === 'host.replies' ? ['responded','responded-late','suppressed','timed-out'].includes(String(value.status))
        : !['waiting','running','unknown'].includes(String(value.status))
      assert(settled, 'EXECUTION_RECOVERY_UNSETTLED', 'Other input, delivery, interaction or child work still owns this conversation.')
    }
  }
}

export function createNativeExecutionRecovery(options: {
  readonly store: DurableStore
  readonly evidencePort: DshBridgePluginPort
  readonly migrationPort: DshSessionMigrationPort
  readonly issuerEpoch: string
  readonly executions: ReturnType<typeof createNativeExecutionController>
  readonly signal: AbortSignal
  readonly resolvePreset: (binding: SessionBinding, signal: AbortSignal) => Promise<string>
  /** Caller freezes admission and verifies current configuration, policy and generation throughout this operation. */
  readonly recheck: (binding: SessionBinding, signal: AbortSignal) => Promise<void>
}) {
  const pending = new Set<string>()
  const read = (id: string) => readNativeExecutionRecovery(options.store,id)
  const write = (plan: NativeExecutionRecoveryPlan, expectedRevision: number | null) => {
    options.store.write(namespace, plan.executionId, json({ ...plan, checksum: digest(plan) }), { expectedRevision })
    return snapshot(plan)
  }
  async function exclusive<T>(id: string, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    assert(/^[a-f0-9]{64}$/.test(id) && !pending.has(id) && pending.size < 16, 'EXECUTION_RECOVERY_BUSY', 'Recovery requires an exclusive bounded execution identity.')
    pending.add(id)
    try { return await withDeadline({ signal: AbortSignal.any([options.signal,signal]), timeoutMs: 30_000, code: 'EXECUTION_RECOVERY_UNKNOWN', run }) }
    finally { pending.delete(id) }
  }
  async function check(plan: NativeExecutionRecoveryPlan, signal: AbortSignal, successor = false) {
    const execution = options.executions.get(plan.executionId)
    assert(execution && digest(execution.binding) === digest(plan.binding) && execution.requestId === plan.evidence.requestId,
      'EXECUTION_RECOVERY_CONFLICT', 'Recovery cannot change execution identity.')
    const source = options.store.read('host.sessions', plan.binding.conversationId)
    const value = object(source?.value)
    const alreadyBound = successor && value.state === 'ready' && value.sessionId === plan.childSessionId && value.generation === plan.binding.generation + 1
    assert(source && (alreadyBound || source.revision === plan.sourceRevision && value.state === 'ready'
      && value.sessionId === plan.binding.sessionId && value.generation === plan.binding.generation),
    'EXECUTION_RECOVERY_BINDING_CHANGED', 'The addressed binding changed during recovery.')
    await options.recheck(alreadyBound ? { ...plan.binding, sessionId: plan.childSessionId!, generation: plan.binding.generation + 1 } : plan.binding, signal)
    verifyExecutionRecoveryQuiescence(options.store,execution)
    signal.throwIfAborted()
    return source
  }
  return Object.freeze({
    read,
    preview(id: string, signal: AbortSignal = options.signal) {
      return exclusive(id,signal,async combined => {
        const prior = read(id)
        if (prior) { if (prior.state !== 'completed') await check(prior,combined,prior.state === 'confirmed'); return prior }
        assert(options.store.list(namespace,{limit:257}).length < 256, 'EXECUTION_RECOVERY_CAPACITY', 'Recovery journal reached its bound.')
        const execution = options.executions.get(id)
        assert(execution?.isolated && execution.externalStatus !== 'not-started', 'EXECUTION_RECOVERY_NOT_REQUIRED', 'Only an isolated submitted execution can recover to a new address.')
        await options.recheck(execution.binding,combined)
        verifyExecutionRecoveryQuiescence(options.store,execution)
        assert(options.evidencePort.inspectExecution, 'EXECUTION_RECOVERY_UNAVAILABLE', 'The SDK cannot inspect durable execution evidence.')
        const evidence = await options.evidencePort.inspectExecution({ sessionId: execution.binding.sessionId, requestId: execution.requestId,
          ...(execution.userMessage ? {userMessageId:execution.userMessage.messageId}:{}), ...(execution.turn ? {turn:Number(execution.turn.id)}:{}) },options.issuerEpoch,combined)
        assert(evidence.state === 'settled' && evidence.quiescent && evidence.checkpointHash && evidence.issuerEpoch === options.issuerEpoch
          && evidence.sessionId === execution.binding.sessionId && evidence.requestId === execution.requestId,
        'EXECUTION_RECOVERY_CHECKPOINT_UNAVAILABLE', 'A positively correlated durable settled checkpoint is required before preserving context.')
        const preset = await options.resolvePreset(execution.binding,combined)
        assert(reference(preset), 'EXECUTION_RECOVERY_PRESET_UNAVAILABLE', 'The verified original preset is required.')
        const preview = await options.migrationPort.forkPreview({ migrationId:`execution-recovery-${randomUUID()}`,sourceSessionId:execution.binding.sessionId,
          expectedPreset:preset,targetPreset:preset },combined)
        assert(preview.state === 'available' && preview.issuerEpoch === options.issuerEpoch && preview.sourceCursor === evidence.checkpointSequence,
          'EXECUTION_RECOVERY_CHECKPOINT_CHANGED', 'The source checkpoint must remain unchanged between inspection and fork preview.')
        const source = options.store.read('host.sessions',execution.binding.conversationId)
        assert(source, 'EXECUTION_RECOVERY_BINDING_CHANGED', 'The source binding is unavailable.')
        const request = { migrationId:preview.migrationId,sourceSessionId:execution.binding.sessionId,expectedPreset:preset,targetPreset:preset,
          issuerEpoch:preview.issuerEpoch,expectedCursor:preview.sourceCursor,expectedSourceDigest:preview.sourceDigest,expectedTargetRevision:preview.targetRevision }
        const plan: NativeExecutionRecoveryPlan = {schema:1,executionId:id,binding:execution.binding,sourceRevision:source.revision,evidence,request,
          revision:digest({id,binding:execution.binding,sourceRevision:source.revision,evidence,request}),state:'available',childSessionId:null,
          missingReasons:[],restartRequired:true,automaticReplayAvailable:false}
        await check(plan,combined)
        return write(plan,null)
      })
    },
    commit(id: string, revision: string, signal: AbortSignal = options.signal) {
      return exclusive(id,signal,async combined => {
        let row = options.store.read(namespace,id)
        assert(row, 'EXECUTION_RECOVERY_NOT_FOUND', 'Preview the exact recovery plan first.')
        let plan = decode(row)
        assert(plan.revision === revision, 'EXECUTION_RECOVERY_CONFLICT', 'Confirm the current recovery plan revision.')
        const update = (patch: Partial<NativeExecutionRecoveryPlan>) => { plan = {...plan,...patch}; write(plan,row!.revision); row = options.store.read(namespace,id)! }
        if (plan.state === 'completed') return plan
        await check(plan,combined,plan.state === 'confirmed')
        if (plan.state !== 'confirmed') {
          const first = plan.state === 'available'
          if (first) update({state:'requested'})
          let receipt: DshSessionMigrationReceipt
          try {
            receipt = first ? await options.migrationPort.forkWithPreset(plan.request,combined) : await options.migrationPort.inspectMigration(plan.request,combined)
            assert(receipt.migrationProtocol === 'qaf-session-migration/1' && Object.entries(plan.request).every(([key,value]) => receipt[key as keyof typeof receipt] === value)
              && receipt.state === 'completed' && reference(receipt.childSessionId) && receipt.childSessionId !== plan.binding.sessionId
              && ['created','replayed'].includes(receipt.idempotency) && receipt.missingReasons.length === 0,
            'EXECUTION_RECOVERY_RECEIPT_INVALID', 'Only a verified completed fork can become the successor binding.')
          } catch {
            update({state:'unknown',missingReasons:['execution_recovery_fork_unknown']}); return plan
          }
          update({state:'confirmed',childSessionId:receipt.childSessionId,missingReasons:[]})
        }
        const source = await check(plan,combined,true)
        const target = {...plan.binding,sessionId:plan.childSessionId!,generation:plan.binding.generation+1}
        reserveSessionId(options.store,plan.binding.conversationId,plan.binding.sessionId,plan.binding.generation)
        reserveSessionId(options.store,target.conversationId,target.sessionId,target.generation)
        if (object(source.value).sessionId !== target.sessionId) options.store.write('host.sessions',target.conversationId,
          {schema:1,state:'ready',generation:target.generation,sessionId:target.sessionId,requestId:plan.request.migrationId,updatedAt:Date.now()}, {expectedRevision:plan.sourceRevision})
        options.executions.retireToBinding(id,{binding:plan.binding,target,evidenceId:plan.request.migrationId,checkpointHash:plan.evidence.checkpointHash!})
        update({state:'completed',missingReasons:[]})
        return snapshot(plan)
      }).catch(error => { if (errorCode(error) === 'EXECUTION_RECOVERY_UNKNOWN') return read(id)!; throw error })
    }
  })
}
