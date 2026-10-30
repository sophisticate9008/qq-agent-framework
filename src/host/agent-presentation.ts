import type { JsonObject } from '../core/types.ts'
import { assert, isRecord, reference } from '../core/values.ts'
import type { DurableStore, SessionBinding } from './types.ts'
import { digest } from './data.ts'

export const AGENT_PRESENTATION_NAMESPACE = 'host.agent-presentations'
export interface AgentPresentation extends JsonObject {
  schema: 1
  id: string
  conversationId: string
  sessionId: string
  generation: number
  fingerprint: string
  submission: 'submitting' | 'accepted' | 'rejected' | 'unknown'
  delivery: 'confirmed' | 'rejected' | 'unknown' | null
  deadlineAt: number
}

/** A trusted host record, never model text, selects final-text presentation for one notification. */
export function readAgentPresentation(store: DurableStore, requestId: string,
  binding: Pick<SessionBinding, 'conversationId' | 'sessionId' | 'generation'>) {
  const record = store.read(AGENT_PRESENTATION_NAMESPACE, requestId)
  if (!record) return null
  const value = record.value
  assert(isRecord(value) && value.schema === 1 && reference(value.id)
    && reference(value.conversationId) && reference(value.sessionId) && Number.isSafeInteger(value.generation)
    && typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)
    && ['submitting', 'accepted', 'rejected', 'unknown'].includes(String(value.submission))
    && (value.delivery === null || ['confirmed', 'rejected', 'unknown'].includes(String(value.delivery)))
    && Number.isSafeInteger(value.deadlineAt)
    && digest([value.conversationId, value.id, 'prompt']) === requestId,
  'INVALID_AGENT_PRESENTATION', 'The host presentation record is invalid.')
  if (value.conversationId !== binding.conversationId || value.sessionId !== binding.sessionId
    || value.generation !== binding.generation) return null
  return { record, value: value as AgentPresentation }
}
