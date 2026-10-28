import { NATIVE_REVISION_PATTERN } from './native-revisions.ts'
import { isRecord, reference } from '../core/values.ts'

export const NATIVE_USAGE_SESSION_DELETE_PATH = '/api/chat/usage/session/delete'

export interface NativeUsageSessionDeleteRequest {
  readonly conversationId: string
  readonly sessionId: string
  readonly revision: string
}

export function parseNativeUsageSessionDeleteRequest(input: unknown): NativeUsageSessionDeleteRequest | null {
  if (!isRecord(input) || Object.keys(input).length !== 3
    || !reference(input.conversationId) || !reference(input.sessionId)
    || typeof input.revision !== 'string' || !NATIVE_REVISION_PATTERN.test(input.revision)) return null
  return { conversationId: input.conversationId, sessionId: input.sessionId, revision: input.revision }
}
