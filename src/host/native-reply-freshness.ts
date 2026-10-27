import type { FrameworkEvent } from '../core/types.ts'
import type { DurableStore, SessionBinding, StoredRecord } from './types.ts'
import type { createBridgeHost } from './bridge.ts'
import { digest, object } from './data.ts'

const namespace = 'native-chat.unsent-replies'

/** Defer an unstarted reply only for newer admitted input from its actual sender. */
export function createNativeReplyFreshness(options: {
  readonly host: ReturnType<typeof createBridgeHost>
  readonly store: DurableStore
  readonly hasWaitingFrom: (conversationId: string, userId: string, messageId: string) => boolean | Promise<boolean>
  readonly onDeferred: (conversationId: string) => void
}) {
  const prepared = new Map<string, StoredRecord>()
  const key = (binding: SessionBinding, userId: string) => digest([binding.conversationId, binding.sessionId, binding.generation, userId])
  return Object.freeze({
    async hold(event: FrameworkEvent): Promise<boolean> {
      const requestId = object(event.data.agentData ?? {}).nativeRequestId
      const binding = options.host.sessions.get(event.conversationId)
      if (typeof requestId !== 'string' || !binding || binding.sessionId !== event.sessionId
        || binding.generation !== event.data.generation) return false
      const source = options.host.history.snapshot(event.conversationId, { afterSequence: 0, limit: 100 }).messages
        .find(item => digest([event.conversationId, item.id, 'prompt']) === requestId)
      if (!source || source.actor === 'system' || source.actor === 'assistant'
        || !await options.hasWaitingFrom(event.conversationId, source.actor, source.id)) return false
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
      options.host.replies.suppress(binding, source.id)
      return true
    },
    prepare(binding: SessionBinding, userId: string, messageId: string): readonly string[] | undefined {
      const record = options.store.read(namespace, key(binding, userId))
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
    clear() { prepared.clear() }
  })
}
