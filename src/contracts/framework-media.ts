import type { JsonValue } from './data.ts'

export const FRAMEWORK_MEDIA_PROTOCOL = 'qq-agent-framework.media-read/1' as const
export const FRAMEWORK_MEDIA_WIRE_BYTES = 512 * 1024
export const FRAMEWORK_MEDIA_IMAGE_BYTES = 384 * 1024 - 1024
export const FRAMEWORK_MEDIA_VIDEO_BYTES = 360 * 1024
export const FRAMEWORK_MEDIA_ANIMATION_BYTES = 360 * 1024
export type FrameworkImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export type FrameworkToolContent = { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: FrameworkImageMediaType; readonly data: string }
export interface FrameworkVideoFrame { readonly timeSeconds: number; readonly mediaType: 'image/jpeg'; readonly data: string }
export interface FrameworkAnimationFrame { readonly timeSeconds: number; readonly mediaType: 'image/jpeg'; readonly data: string }
export type NativeMediaReadEnvelope =
  | { readonly schema: typeof FRAMEWORK_MEDIA_PROTOCOL; readonly contentRead: true; readonly kind: 'animation'; readonly durationSeconds: number;
      readonly frameCount: number; readonly loopCount: number; readonly frames: readonly FrameworkAnimationFrame[]; readonly coverage: 'sampled-frames-only' }
  | { readonly schema: typeof FRAMEWORK_MEDIA_PROTOCOL; readonly contentRead: true; readonly kind: 'video'; readonly durationSeconds: number;
      readonly frames: readonly FrameworkVideoFrame[]; readonly audioObserved: false; readonly hasAudio: boolean; readonly coverage: 'sampled-frames-only' }
  | { readonly schema: typeof FRAMEWORK_MEDIA_PROTOCOL; readonly contentRead: true; readonly kind: 'image'; readonly mediaType: FrameworkImageMediaType; readonly data: string }
  | { readonly schema: typeof FRAMEWORK_MEDIA_PROTOCOL; readonly contentRead: true; readonly kind: 'text'; readonly text: string; readonly sourceKind: 'file' | 'audio' }
  | { readonly schema: typeof FRAMEWORK_MEDIA_PROTOCOL; readonly contentRead: false; readonly kind: 'image' | 'file' | 'audio' | 'video'; readonly reason: string }

export function frameworkImageBytes(value: unknown): number | null {
  if (typeof value !== 'string' || value.length < 4 || value.length > 4 * Math.ceil(FRAMEWORK_MEDIA_IMAGE_BYTES / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  const last = value.at(-1) === '=' ? value.at(-2) === '=' ? 2 : 1 : 0
  const bytes = value.length / 4 * 3 - last
  return bytes > 0 && bytes <= FRAMEWORK_MEDIA_IMAGE_BYTES ? bytes : null
}

export function parseNativeMediaReadEnvelope(value: unknown): NativeMediaReadEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (item.schema !== FRAMEWORK_MEDIA_PROTOCOL) return null
  const keys = Object.keys(item).sort().join(',')
  if (item.contentRead === false && keys === 'contentRead,kind,reason,schema'
    && ['image', 'audio', 'file', 'video'].includes(String(item.kind)) && typeof item.reason === 'string'
    && /^[a-z][a-z0-9_]{0,79}$/.test(item.reason)) return value as NativeMediaReadEnvelope
  if (item.contentRead !== true) return null
  if (item.kind === 'animation' && keys === 'contentRead,coverage,durationSeconds,frameCount,frames,kind,loopCount,schema'
    && typeof item.durationSeconds === 'number' && Number.isFinite(item.durationSeconds) && item.durationSeconds > 0 && item.durationSeconds <= 600
    && typeof item.frameCount === 'number' && Number.isSafeInteger(item.frameCount) && item.frameCount >= 2 && item.frameCount <= 256
    && typeof item.loopCount === 'number' && Number.isSafeInteger(item.loopCount) && item.loopCount >= 0 && item.loopCount <= 65535
    && item.coverage === 'sampled-frames-only' && Array.isArray(item.frames) && item.frames.length > 0 && item.frames.length <= Math.min(6, item.frameCount)) {
    let bytes = 0; let previous = -1
    for (const value of item.frames) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const frame = value as Record<string, unknown>
      const size = frameworkImageBytes(frame.data)
      if (Object.keys(frame).sort().join(',') !== 'data,mediaType,timeSeconds' || frame.mediaType !== 'image/jpeg' || size === null
        || typeof frame.timeSeconds !== 'number' || !Number.isFinite(frame.timeSeconds) || frame.timeSeconds <= previous
        || frame.timeSeconds < 0 || frame.timeSeconds >= item.durationSeconds) return null
      previous = frame.timeSeconds; bytes += size
    }
    if (bytes <= FRAMEWORK_MEDIA_ANIMATION_BYTES && new TextEncoder().encode(JSON.stringify(value)).byteLength <= FRAMEWORK_MEDIA_WIRE_BYTES)
      return value as NativeMediaReadEnvelope
  }
  if (item.kind === 'video' && keys === 'audioObserved,contentRead,coverage,durationSeconds,frames,hasAudio,kind,schema'
    && typeof item.durationSeconds === 'number' && Number.isFinite(item.durationSeconds) && item.durationSeconds > 0 && item.durationSeconds <= 600
    && item.audioObserved === false && typeof item.hasAudio === 'boolean' && item.coverage === 'sampled-frames-only'
    && Array.isArray(item.frames) && item.frames.length > 0 && item.frames.length <= 6) {
    let bytes = 0; let previous = -1
    for (const value of item.frames) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const frame = value as Record<string, unknown>
      const size = frameworkImageBytes(frame.data)
      if (Object.keys(frame).sort().join(',') !== 'data,mediaType,timeSeconds' || frame.mediaType !== 'image/jpeg' || size === null
        || typeof frame.timeSeconds !== 'number' || !Number.isFinite(frame.timeSeconds) || frame.timeSeconds < previous
        || frame.timeSeconds < 0 || frame.timeSeconds > item.durationSeconds) return null
      previous = frame.timeSeconds; bytes += size
    }
    if (bytes <= FRAMEWORK_MEDIA_VIDEO_BYTES && new TextEncoder().encode(JSON.stringify(value)).byteLength <= FRAMEWORK_MEDIA_WIRE_BYTES)
      return value as NativeMediaReadEnvelope
  }
  if (item.kind === 'image' && keys === 'contentRead,data,kind,mediaType,schema'
    && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(item.mediaType))
    && frameworkImageBytes(item.data) !== null) return value as NativeMediaReadEnvelope
  if (item.kind === 'text' && keys === 'contentRead,kind,schema,sourceKind,text'
    && ['file', 'audio'].includes(String(item.sourceKind)) && typeof item.text === 'string' && item.text.length <= 16000)
    return value as NativeMediaReadEnvelope
  return null
}

export interface FrameworkToolProjectedResult { readonly value: JsonValue; readonly content?: readonly FrameworkToolContent[] }
