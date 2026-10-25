import { FRAMEWORK_MEDIA_PROTOCOL, parseNativeMediaReadEnvelope, type FrameworkToolProjectedResult } from '../contracts/framework-media.ts'
import type { FrameworkToolDefinition } from '../contracts/framework-tools.ts'
import type { JsonValue } from '../contracts/data.ts'
import { assert } from '../core/values.ts'

/** Only a trusted tool's fixed media-read capability opts into this reserved envelope. */
export function makeFrameworkMediaResultProjector() {
  return (definition: Readonly<FrameworkToolDefinition>, value: JsonValue): FrameworkToolProjectedResult => {
    if (!['native.media.read', 'native.role.read'].includes(definition.capability)) return { value }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== FRAMEWORK_MEDIA_PROTOCOL) return { value }
    const envelope = parseNativeMediaReadEnvelope(value)
    assert(envelope, 'INVALID_FRAMEWORK_MEDIA_RESULT', 'The media read result cannot be interpreted safely.')
    if (!envelope.contentRead) return { value: { ...envelope } }
    if (envelope.kind === 'image') return { value: { schema: envelope.schema, contentRead: true, kind: 'image', mediaType: envelope.mediaType },
      content: [{ type: 'image', mediaType: envelope.mediaType, data: envelope.data }] }
    return { value: { schema: envelope.schema, contentRead: true, kind: 'text', sourceKind: envelope.sourceKind },
      content: [{ type: 'text', text: envelope.text }] }
  }
}
