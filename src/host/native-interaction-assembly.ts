import type { DshJsonRpcPort } from '../adapters/dsh-jsonrpc.ts'
import { FrameworkError } from '../core/values.ts'
import type { createBridgeHost } from './bridge.ts'
import { digest } from './data.ts'
import { withDeadline } from './deadlines.ts'
import type { SessionBinding } from './types.ts'
import type { NativeInteractions } from './native-interactions.ts'
import type { createNativeExecutionController } from './native-execution.ts'
import type { createNativeWorkExecutor } from './native-work.ts'
import { createNativeInteractionMessages } from './native-interaction-messages.ts'

/** Live accessors prevent an old callback from retaining a replacement host or owner identity. */
export interface NativeInteractionResources {
  readonly host: ReturnType<typeof createBridgeHost> | undefined
  readonly work: ReturnType<typeof createNativeWorkExecutor> | undefined
  readonly executions: ReturnType<typeof createNativeExecutionController> | undefined
  readonly owner: string | null
}
export function createNativeInteractionAssembly(options: {
  readonly resources: NativeInteractionResources
  readonly port: DshJsonRpcPort
  readonly interactions: NativeInteractions
  readonly signal: AbortSignal
  readonly epoch: string
  readonly persona: { readonly id: string; readonly version: string }
  readonly bindingForSession: (sessionId: string) => SessionBinding | null | undefined
  readonly guard: (conversationId: string, signal: AbortSignal) => Promise<void>
}) {
  const runtime = options.resources
  const messages = createNativeInteractionMessages({ interactions: options.interactions, owner: () => runtime.owner,
    async send(conversationId, text, key, signal) {
      return withDeadline({ signal, timeoutMs: 5_000, code: 'INTERACTION_NOTICE_UNKNOWN', async run(sendSignal) {
        await options.guard(conversationId, sendSignal)
        const host = runtime.host
        const binding = host?.sessions.get(conversationId)
        if (!host || !binding) return { status: 'rejected' as const }
        const reservation = host.policy.reserve({ ...(host.accountScope ? { accountScope: host.accountScope } : {}), featureId: 'agent-relay', conversationId, capability: 'messaging.send' })
        host.policy.begin(reservation)
        return host.outbox.send({ conversationId, content: [{ type: 'text', text }], idempotencyKey: key,
          signal: sendSignal, scope: { ...(host.accountScope ? { accountScope: host.accountScope } : {}), persona: options.persona, sessionId: binding.sessionId, generation: binding.generation } })
      } })
    } })
  const release = options.interactions.mount({ port: options.port, epoch: options.epoch, signal: options.signal,
    resolveSession(sessionId) {
      const child = runtime.work?.resolveChild(sessionId)
      if (child && child.ownerId === runtime.owner) return { conversationId: child.conversationId,
        sessionId, generation: child.generation, expiresAt: child.expiresAt }
      const binding = options.bindingForSession(sessionId)
      if (!binding?.sessionId) return undefined
      const execution = runtime.executions?.forConversation(binding.conversationId)
      if (!execution || execution.deadlineReached || execution.binding.sessionId !== sessionId || execution.binding.generation !== binding.generation) return undefined
      return { ...binding, expiresAt: execution.deadlineAt }
    },
    async guard(binding, signal) {
      await options.guard(binding.conversationId, signal)
      const current = runtime.host?.sessions.get(binding.conversationId)
      const child = runtime.work?.resolveChild(binding.sessionId)
      const parentSessionId = child && child.ownerId === runtime.owner ? child.parentSessionId : binding.sessionId
      if (current?.sessionId !== parentSessionId || current.generation !== binding.generation) throw new FrameworkError('SESSION_STALE', 'The interaction binding changed.')
    } })
  // Register the synchronous release before connecting; a failed connect still has an owned disposer.
  return Object.freeze({ messages, release,
    connect: () => options.port.connectInteractions({ signal: options.signal, async onEvent(event) {
      const before = new Set(options.interactions.snapshot().items.map(entry => entry.id))
      options.interactions.observe(event, options.epoch)
      const added = options.interactions.snapshot().items.find(entry => !before.has(entry.id) && entry.status === 'pending')
      if (added?.kind === 'approval') {
        const child = runtime.work?.resolveChild(added.sessionId)
        const execution = runtime.executions?.forConversation(added.conversationId)
        const source = execution && runtime.host?.history.snapshot(added.conversationId, { afterSequence: 0, limit: 100 }).messages.find(message =>
          digest([added.conversationId, message.id, 'prompt']) === execution.requestId)
        // General external tools can affect the host. Only a real owner request may invoke them.
        const ownerRequest = runtime.owner !== null && (child ? child.ownerId === runtime.owner : source?.actor === runtime.owner)
        await options.interactions.respond({ id: added.id, revision: added.revision, action: ownerRequest ? 'approve' : 'deny' }, options.signal)
      } else if (added) await messages.notify(added, options.signal)
    } }) })
}
