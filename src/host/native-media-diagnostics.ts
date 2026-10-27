import type { NativeMediaDiagnostics } from '../contracts/native-media-diagnostics.ts'
import type { DurableStore } from './types.ts'
import { assert, isRecord, snapshot } from '../core/values.ts'
import { isNativeAccessScope } from '../contracts/native-access.ts'
import { digest, json, object } from './data.ts'

export const NATIVE_MEDIA_NAMESPACE = 'native-chat.media'
const QUOTE_NAMESPACE = 'native-chat.quote-observations'
type ReadObservation = NonNullable<NativeMediaDiagnostics['items'][number]['lastRead']>
type QuoteObservation = NonNullable<NativeMediaDiagnostics['quote']>
export function mediaObservationCode(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,95}$/.test(value) ? value : null
}
function observation(value: unknown): ReadObservation | null {
  if (value === undefined || value === null) return null
  assert(isRecord(value) && Number.isSafeInteger(value.at) && Number(value.at) >= 0
    && ['confirmed', 'rejected', 'unknown'].includes(String(value.status))
    && (value.code === null || mediaObservationCode(value.code) !== null), 'MEDIA_DIAGNOSTICS_INVALID', 'Invalid read observation.')
  return { at: Number(value.at), status: value.status as ReadObservation['status'], code: value.code as string | null }
}
export function recordNativeMediaRead(store: DurableStore, assetId: string, conversationId: string, value: ReadObservation): void {
  const current = store.read(NATIVE_MEDIA_NAMESPACE, assetId)
  if (!current) return
  const record = object(current.value)
  if (record.conversationId !== conversationId) return
  store.write(NATIVE_MEDIA_NAMESPACE, assetId, { ...record, lastRead: json(value) },
    { expectedRevision: current.revision, expiresAt: Number(record.expiresAt) })
}
export function recordNativeQuoteRead(store: DurableStore, conversationId: string, value: QuoteObservation): void {
  store.write(QUOTE_NAMESPACE, digest(conversationId), json(value), { expiresAt: value.at + 24 * 60 * 60 * 1000 })
}
export function readNativeMediaDiagnostics(store: Pick<DurableStore, 'read' | 'list'>, options: {
  readonly conversationId: string; readonly running: boolean; readonly transcriber: boolean; readonly observeVideo?: boolean; readonly now?: number; readonly limit?: number
}): NativeMediaDiagnostics {
  assert(isNativeAccessScope(options.conversationId), 'INVALID_CONVERSATION', 'A canonical conversation is required.')
  const now = options.now ?? Date.now()
  const limit = options.limit ?? 100
  assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_MEDIA_LIMIT', 'The media list is bounded to 100 records.')
  const rows = store.list(NATIVE_MEDIA_NAMESPACE, { limit: 1000 })
  const beyondScan = rows.length === 1000 && store.list(NATIVE_MEDIA_NAMESPACE, { limit: 1, after: rows[999].key }).length > 0
  const matched = rows.slice(0, 1000).map(row => object(row.value)).filter(value => value.conversationId === options.conversationId)
  const items: NativeMediaDiagnostics['items'][number][] = matched.slice(0, limit).map(value => {
    assert(value.schema === 1 && typeof value.assetId === 'string' && typeof value.messageId === 'string'
      && ['image', 'audio', 'file', 'video', 'forward'].includes(String(value.kind))
      && Number.isSafeInteger(value.registeredAt) && Number.isSafeInteger(value.expiresAt), 'MEDIA_DIAGNOSTICS_INVALID', 'Invalid media registration.')
    const kind = value.kind as NativeMediaDiagnostics['items'][number]['kind']
    const missingReasons = !options.running ? ['native_media_runtime_stopped'] : kind === 'audio' && !options.transcriber
      ? ['native_media_transcriber_not_connected'] : kind === 'video' && !options.observeVideo ? ['native_video_observation_disabled'] : Number(value.expiresAt) <= now ? ['native_media_expired'] : []
    return { assetId: String(value.assetId), kind, messageId: String(value.messageId), registeredAt: Number(value.registeredAt),
      expiresAt: Number(value.expiresAt), contentRead: value.contentRead === true, bytesRead: value.bytesRead === true,
      readingAvailable: missingReasons.length === 0, missingReasons, lastRead: observation(value.lastRead) }
  })
  const quoteRow = store.read(QUOTE_NAMESPACE, digest(options.conversationId))
  let quote: QuoteObservation | null = null
  if (quoteRow) {
    const value = object(quoteRow.value); const result = observation(value)
    assert(result && typeof value.messageId === 'string', 'MEDIA_DIAGNOSTICS_INVALID', 'Invalid quote observation.')
    quote = { ...result, messageId: value.messageId }
  }
  return snapshot({ schema: 1, conversationId: options.conversationId, observedAt: now, running: options.running,
    coverage: beyondScan || matched.length > limit ? 'partial' : 'complete', items, quote,
    capabilities: { video: options.running && options.observeVideo === true, image: options.running, audio: options.running && options.transcriber, file: options.running,
      forward: options.running, quote: options.running } })
}
