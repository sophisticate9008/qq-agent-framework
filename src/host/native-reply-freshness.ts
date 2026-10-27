import type { FrameworkEvent } from '../core/types.ts'
import type { DurableStore, SessionBinding, StoredRecord } from './types.ts'
import type { createBridgeHost } from './bridge.ts'
import { digest, object } from './data.ts'

const namespace = 'native-chat.unsent-replies'

/** Reconsider stale observations once; direct replies retain same-speaker correction semantics. */
export function createNativeReplyFreshness(options: {
  readonly host: ReturnType<typeof createBridgeHost>
  readonly store: DurableStore
  readonly hasWaitingFrom: (conversationId: string, userId: string, messageId: string, mode?: 'same-speaker' | 'group-observation') => boolean | Promise<boolean>
  readonly onDeferred: (conversationId: string) => void
}) {
  const prepared = new Map<string, StoredRecord>()
  const modes = new Map<string, 'same-speaker' | 'group-observation'>()
  const key = (binding: SessionBinding, userId: string) => digest([binding.conversationId, binding.sessionId, binding.generation, binding.conversationId.startsWith('group:') ? 'group' : userId])
  return Object.freeze({
    async hold(event: FrameworkEvent): Promise<boolean> {
      const requestId = object(event.data.agentData ?? {}).nativeRequestId
      const binding = options.host.sessions.get(event.conversationId)
      if (typeof requestId !== 'string' || !binding || binding.sessionId !== event.sessionId
        || binding.generation !== event.data.generation) return false
      const source = options.host.history.snapshot(event.conversationId, { afterSequence: 0, limit: 100 }).messages
        .find(item => digest([event.conversationId, item.id, 'prompt']) === requestId)
      if (!source || source.actor === 'system' || source.actor === 'assistant'
        || !await options.hasWaitingFrom(event.conversationId, source.actor, source.id, modes.get(requestId) ?? 'same-speaker')) return false
      const current = options.host.sessions.get(event.conversationId)
      if (current?.sessionId !== binding.sessionId || current.generation !== binding.generation) return false
      const id = key(binding, source.actor)
      const previous = options.store.read(namespace, id)
      const ids = previous ? object(previous.value).messageIds : []
      const messageIds = Array.isArray(ids) ? ids.filter((value): value is string => typeof value === 'string') : []
      if (!messageIds.includes(source.id)) {
        options.store.write(namespace, id, { schema: 1, messageIds: [...messageIds, source.id].slice(-8) },
          { expectedRevision: previous?.revision ?? null, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 })
        options.onDeferred(event.conversationId)
      }
      const pending = options.host.replies.get(event.conversationId)
      if (pending?.sessionId === binding.sessionId && pending.generation === binding.generation && pending.requestId === source.id)
        options.host.replies.suppress(binding, source.id)
      return true
    },
    prepare(binding: SessionBinding, userId: string, messageId: string, addressed = false): readonly string[] | undefined {
      const record = options.store.read(namespace, key(binding, userId))
      const requestId = digest([binding.conversationId, messageId, 'prompt'])
      if (modes.size >= 256) modes.delete(modes.keys().next().value!)
      // A reconsidered batch may speak despite ongoing unrelated chatter; otherwise
      // a busy group could postpone every attempted reply forever.
      modes.set(requestId, binding.conversationId.startsWith('group:') && !addressed && !record ? 'group-observation' : 'same-speaker')
      if (!record) return undefined
      const ids = object(record.value).messageIds
      if (!Array.isArray(ids) || !ids.length || !ids.every((value): value is string => typeof value === 'string')) return undefined
      if (prepared.size >= 256) prepared.delete(prepared.keys().next().value!)
      prepared.set(digest([binding.conversationId, messageId, 'prompt']), record)
      return ids
    },
    settled(requestId: string, accepted: boolean) {
      const record = prepared.get(requestId)
      prepared.delete(requestId)
      if (accepted && record && options.store.read(namespace, record.key)?.revision === record.revision)
        options.store.delete(namespace, record.key, record.revision)
    },
    clear() { prepared.clear(); modes.clear() }
  })
}
