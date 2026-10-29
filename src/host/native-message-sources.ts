import type { EffectScope } from '../core/types.ts'
import type { AccountScope } from '../contracts/account-scope.ts'
import { assertAccountScope, normalizeAccountScope } from '../core/account-scope.ts'
import { assert, reference } from '../core/values.ts'
import { withDeadline } from './deadlines.ts'
import type { InboundMessage } from './types.ts'
import { digest } from './data.ts'

export interface NativeMessageSource {
  readonly accountScope?: AccountScope
  readonly conversationId: string
  readonly sourceMessageId: string
  readonly userId: string
  readonly receivedAt: number
  readonly expiresAt: number
  readonly isOwner: boolean
  readonly assurance: 'normalized-onebot-source-only' | 'task-delegation'
  readonly task?: { readonly id: string; readonly runId: string; readonly originalMessageId: string }
  readonly workIntentVerified: false
  readonly capabilityAuthorizationVerified: false
  readonly externalToolAuthorizationVerified: false
}

export interface NativeMessageSourceReader {
  lookup(scope: Readonly<EffectScope>, signal: AbortSignal): Promise<Readonly<NativeMessageSource>>
  requireOwner(scope: Readonly<EffectScope>, signal: AbortSignal): Promise<Readonly<NativeMessageSource>>
}

export interface NativeMessageSourceExecution {
  readonly requestId: string
  readonly sessionId: string
  readonly generation: number
}

export function createNativeMessageSources(options: {
  readonly accountScope?: AccountScope
  readonly owner: string | null
  readonly signal: AbortSignal
  readonly validate: (scope: Readonly<EffectScope>, signal: AbortSignal) => Promise<void>
  readonly validateExecution?: (execution: Readonly<NativeMessageSourceExecution>, source: Readonly<NativeMessageSource>) => void
}) {
  const accountScope = options.accountScope === undefined ? undefined : normalizeAccountScope(options.accountScope)
  interface Entry {
    source: Readonly<NativeMessageSource>
    signal: AbortSignal
    execution: Readonly<NativeMessageSourceExecution> | null
  }
  const entries = new Map<string, Entry>()
  const key = (conversationId: string, messageId: string) => JSON.stringify([conversationId, messageId])
  options.signal.addEventListener('abort', () => entries.clear(), { once: true })

  function validateExecution(entry: Entry) {
    if (!entry.execution) return
    assert(options.validateExecution, 'NATIVE_MESSAGE_SOURCE_EXECUTION_INVALID', 'A current execution validator is required.')
    options.validateExecution(entry.execution, entry.source)
  }

  function prune() {
    for (const [sourceKey, entry] of entries) {
      try {
        assert(!entry.signal.aborted && Date.now() < entry.source.expiresAt,
          'NATIVE_MESSAGE_SOURCE_EXPIRED', 'The original inbound deadline has expired.')
        validateExecution(entry)
      } catch { entries.delete(sourceKey) }
    }
  }

  async function lookup(scope: Readonly<EffectScope>, signal: AbortSignal): Promise<Readonly<NativeMessageSource>> {
    assertAccountScope(accountScope, scope.accountScope)
    options.signal.throwIfAborted()
    signal.throwIfAborted()
    assert(reference(scope.conversationId) && reference(scope.eventId),
      'NATIVE_MESSAGE_SOURCE_MISSING', 'A trusted effect scope with a current message source is required.')
    const sourceKey = key(scope.conversationId, scope.eventId)
    const entry = entries.get(sourceKey)
    assert(entry, 'NATIVE_MESSAGE_SOURCE_MISSING', 'No live normalized message source exists for this scope.')
    const combined = AbortSignal.any([options.signal, signal, entry.signal])
    function current() {
      combined.throwIfAborted()
      assert(entries.get(sourceKey) === entry, 'NATIVE_MESSAGE_SOURCE_MISSING', 'The message source has ended.')
      assert(Date.now() < entry!.source.expiresAt, 'NATIVE_MESSAGE_SOURCE_EXPIRED', 'The original inbound deadline has expired.')
      if (entry!.execution) {
        assert(scope.sessionId === entry!.execution.sessionId && scope.generation === entry!.execution.generation,
          'SESSION_STALE', 'The retained source belongs to a different execution binding.')
        validateExecution(entry!)
      }
    }
    const trustedScope = Object.freeze({ ...scope })
    try {
      current()
      await withDeadline({ signal: combined, timeoutMs: Math.max(1, entry.source.expiresAt - Date.now()),
        code: 'NATIVE_MESSAGE_SOURCE_EXPIRED', run: validationSignal => options.validate(trustedScope, validationSignal) })
      current()
    } catch (error) {
      if (entries.get(sourceKey) === entry) entries.delete(sourceKey)
      throw error
    }
    return entry.source
  }

  const reader: Readonly<NativeMessageSourceReader> = Object.freeze({ lookup,
    async requireOwner(scope: Readonly<EffectScope>, signal: AbortSignal) {
      const source = await lookup(scope, signal)
      assert(source.isOwner, 'NATIVE_MESSAGE_SOURCE_NOT_OWNER', 'The normalized source user is not the configured owner.')
      return source
    } })

  return Object.freeze({ reader,
    captureTask(input: { readonly conversationId: string; readonly id: string; readonly actorId: string;
      readonly taskId: string; readonly runId: string; readonly originalMessageId: string;
      readonly receivedAt: number; readonly expiresAt: number; readonly signal: AbortSignal }) {
      options.signal.throwIfAborted(); input.signal.throwIfAborted(); prune()
      assert(reference(input.id) && reference(input.actorId) && reference(input.taskId) && reference(input.runId)
        && reference(input.originalMessageId) && input.expiresAt > Date.now() && input.receivedAt <= Date.now(),
      'NATIVE_TASK_SOURCE_INVALID', 'A live host-authorized task activation is required.')
      const sourceKey = key(input.conversationId, input.id)
      assert(!entries.has(sourceKey) && entries.size < 256, 'NATIVE_MESSAGE_SOURCE_CONFLICT', 'The task activation already exists or capacity is full.')
      const entry: Entry = { execution: null, signal: input.signal, source: Object.freeze({
        ...(accountScope ? { accountScope } : {}), conversationId: input.conversationId, sourceMessageId: input.id,
        userId: input.actorId, receivedAt: input.receivedAt, expiresAt: input.expiresAt,
        isOwner: input.actorId === options.owner, assurance: 'task-delegation',
        task: { id: input.taskId, runId: input.runId, originalMessageId: input.originalMessageId },
        workIntentVerified: false, capabilityAuthorizationVerified: false, externalToolAuthorizationVerified: false }) }
      entries.set(sourceKey, entry)
      return () => { for (const [id, candidate] of entries) if (candidate === entry) entries.delete(id) }
    },
    async alias(scope: Readonly<EffectScope>, eventId: string, signal: AbortSignal): Promise<void> {
      assert(reference(eventId), 'NATIVE_MESSAGE_SOURCE_INVALID', 'A bounded trusted event identity is required.')
      await lookup(scope, signal)
      prune()
      const entry = entries.get(key(scope.conversationId, scope.eventId))
      assert(entry && entry.execution, 'NATIVE_MESSAGE_SOURCE_EXECUTION_INVALID', 'Only a retained current execution can supply a tool source.')
      const aliasKey = key(scope.conversationId, eventId)
      assert(!entries.has(aliasKey) || entries.get(aliasKey) === entry,
        'NATIVE_MESSAGE_SOURCE_CONFLICT', 'A tool source cannot replace another normalized message.')
      assert(entries.has(aliasKey) || entries.size < 256, 'NATIVE_MESSAGE_SOURCE_BACKPRESSURE', 'The live message source table is full.')
      entries.set(aliasKey, entry)
    },
    releaseExecution(execution: Readonly<NativeMessageSourceExecution>) {
      for (const [sourceKey, entry] of entries) {
        if (entry.execution && digest(entry.execution) === digest(execution)) entries.delete(sourceKey)
      }
    },
    retain(execution: Readonly<NativeMessageSourceExecution>): boolean {
      options.signal.throwIfAborted()
      prune()
      assert(typeof execution.requestId === 'string' && /^[a-f0-9]{64}$/.test(execution.requestId)
        && reference(execution.sessionId) && Number.isSafeInteger(execution.generation) && execution.generation > 0,
      'NATIVE_MESSAGE_SOURCE_EXECUTION_INVALID', 'An exact execution request and binding are required.')
      const entry = [...entries.values()].find(candidate => digest([
        candidate.source.conversationId, candidate.source.sourceMessageId, 'prompt']) === execution.requestId)
      if (!entry) return false
      const trustedExecution = Object.freeze({ requestId: execution.requestId,
        sessionId: execution.sessionId, generation: execution.generation })
      assert(entry.execution === null || digest(entry.execution) === digest(trustedExecution),
        'NATIVE_MESSAGE_SOURCE_EXECUTION_INVALID', 'A source cannot change its execution binding.')
      assert(options.validateExecution, 'NATIVE_MESSAGE_SOURCE_EXECUTION_INVALID', 'A current execution validator is required.')
      options.validateExecution(trustedExecution, entry.source)
      entry.execution = trustedExecution
      return true
    },
    capture(message: Pick<InboundMessage, 'id' | 'conversationId' | 'userId' | 'accountScope'>,
      admission: { readonly receivedAt: number; readonly expiresAt: number; readonly signal: AbortSignal }): () => void {
      options.signal.throwIfAborted()
      admission.signal.throwIfAborted()
      assertAccountScope(accountScope, message.accountScope)
      prune()
      assert(reference(message.id) && reference(message.conversationId) && reference(message.userId)
        && Number.isSafeInteger(admission.receivedAt) && Number.isSafeInteger(admission.expiresAt)
        && admission.receivedAt <= Date.now() && admission.expiresAt > Date.now(),
      'NATIVE_MESSAGE_SOURCE_INVALID', 'A live normalized message and its original inbound deadline are required.')
      const sourceKey = key(message.conversationId, message.id)
      assert(!entries.has(sourceKey), 'NATIVE_MESSAGE_SOURCE_CONFLICT', 'A message source is already active.')
      assert(entries.size < 256, 'NATIVE_MESSAGE_SOURCE_BACKPRESSURE', 'The live message source table is full.')
      const source: Readonly<NativeMessageSource> = Object.freeze({ ...(accountScope ? { accountScope } : {}), conversationId: message.conversationId,
        sourceMessageId: message.id, userId: message.userId, receivedAt: admission.receivedAt, expiresAt: admission.expiresAt,
        isOwner: typeof options.owner === 'string' && options.owner !== '' && message.userId === options.owner,
        assurance: 'normalized-onebot-source-only',
        workIntentVerified: false, capabilityAuthorizationVerified: false, externalToolAuthorizationVerified: false })
      const entry: Entry = { source, signal: admission.signal, execution: null }
      entries.set(sourceKey, entry)
      return () => { if (entries.get(sourceKey) === entry && entry.execution === null) entries.delete(sourceKey) }
    } })
}
