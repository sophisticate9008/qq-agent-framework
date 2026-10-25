import type { DeliveryReceipt, OutboundScope, TransportAdapter } from '../core/types.ts'
import { normalizeOutboundScope } from '../core/scope.ts'
import { errorCode } from '../core/values.ts'
import { createPersistentPolicy } from '../storage/policy.ts'
import type { NativeExecutionAction } from './native-execution.ts'
import type { AgentAdapter } from './types.ts'

export interface NativeExecutionPolicyActionsOptions {
  readonly policy: Pick<ReturnType<typeof createPersistentPolicy>, 'reserve' | 'begin'>
  readonly transport: TransportAdapter
  readonly persona: OutboundScope['persona']
  readonly cancel?: AgentAdapter['cancel']
  readonly guard: (request: NativeExecutionAction) => Promise<void>
}

export function createNativeExecutionPolicyActions(options: NativeExecutionPolicyActionsOptions) {
  const persona = normalizeOutboundScope({ persona: options.persona }).persona

  async function authorize(request: NativeExecutionAction, capability: string) {
    await options.guard(request)
    request.signal.throwIfAborted()
    const reservation = options.policy.reserve({ ...(request.execution.binding.accountScope ? { accountScope: request.execution.binding.accountScope } : {}), featureId: 'agent-relay',
      conversationId: request.execution.binding.conversationId, capability })
    options.policy.begin(reservation)
  }

  return Object.freeze({
    ...(options.cancel === undefined ? {} : {
      async cancel(request: NativeExecutionAction): Promise<{ readonly status: 'accepted' | 'rejected' | 'unknown' }> {
        try { await authorize(request, 'agent.cancel') } catch { return { status: 'rejected' } }
        try {
          await options.cancel!({ sessionId: request.execution.binding.sessionId, signal: request.signal })
          return { status: 'accepted' }
        } catch (error) { return { status: errorCode(error) === 'DSH_CANCEL_REJECTED' ? 'rejected' : 'unknown' } }
      }
    }),
    async notify(request: NativeExecutionAction): Promise<DeliveryReceipt> {
      const text = request.execution.policy.noticeText
      if (!request.execution.policy.noticeEnabled || text === null || text.trim().length === 0) return { status: 'rejected' }
      try { await authorize(request, 'messaging.send') } catch { return { status: 'rejected' } }
      try {
        return await options.transport.send({ conversationId: request.execution.binding.conversationId,
          content: [{ type: 'text', text }], idempotencyKey: request.idempotencyKey, signal: request.signal,
          scope: { ...(request.execution.binding.accountScope ? { accountScope: request.execution.binding.accountScope } : {}), persona, sessionId: request.execution.binding.sessionId, generation: request.execution.binding.generation } })
      } catch { return { status: 'unknown' } }
    }
  })
}
