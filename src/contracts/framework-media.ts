import type { JsonValue } from './data.ts'

export const FRAMEWORK_MEDIA_PROTOCOL = 'qq-bridge-framework.media-read/1' as const
export const FRAMEWORK_MEDIA_WIRE_BYTES = 3 * 1024 * 1024
export const FRAMEWORK_MEDIA_IMAGE_BYTES = 384 * 1024 - 1024
export const FRAMEWORK_MEDIA_VIDEO_BYTES = 360 * 1024
export const FRAMEWORK_MEDIA_ANIMATION_BYTES = 360 * 1024
export type FrameworkImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export type FrameworkToolContent = { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: FrameworkImageMediaType; readonly data: string }
export const FRAMEWORK_MEDIA_SHEET_BYTES = 256 * 1024
export const FRAMEWORK_MEDIA_SHEETS_BYTES = 6 * FRAMEWORK_MEDIA_SHEET_BYTES
export interface FrameworkFrameGrid { readonly columns: 2; readonly rows: 2; readonly width: number; readonly height: number; readonly times: readonly number[] }
export interface FrameworkVideoFrame { readonly grid?: FrameworkFrameGrid; readonly timeSeconds: number; readonly mediaType: 'image/jpeg'; readonly data: string }
export interface FrameworkAnimationFrame { readonly grid?: FrameworkFrameGrid; readonly timeSeconds: number; readonly mediaType: 'image/jpeg'; readonly data: string }
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

function validGrid(value: unknown, first: number, duration: number): value is FrameworkFrameGrid {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const grid = value as Record<string, unknown>
  return Object.keys(grid).sort().join(',') === 'columns,height,rows,times,width' && grid.columns === 2 && grid.rows === 2
    && typeof grid.width === 'number' && Number.isSafeInteger(grid.width) && grid.width >= 4 && grid.width <= 1920 && grid.width % 2 === 0
    && typeof grid.height === 'number' && Number.isSafeInteger(grid.height) && grid.height >= 4 && grid.height <= 1920 && grid.height % 2 === 0
    && Array.isArray(grid.times) && grid.times.length > 0 && grid.times.length <= 4 && grid.times[0] === first
    && grid.times.every((time, index, times) => typeof time === 'number' && Number.isFinite(time) && time >= 0 && time <= duration
      && (index === 0 || time > times[index - 1]))
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
    let bytes = 0; let previous = -1; let sampled = 0; let gridded: boolean | undefined
    for (const value of item.frames) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const frame = value as Record<string, unknown>
      const size = frameworkImageBytes(frame.data)
      const hasGrid = Object.hasOwn(frame, 'grid')
      if (gridded !== undefined && gridded !== hasGrid) return null
      gridded = hasGrid
      if (Object.keys(frame).sort().join(',') !== (hasGrid ? 'data,grid,mediaType,timeSeconds' : 'data,mediaType,timeSeconds') || frame.mediaType !== 'image/jpeg' || size === null
        || typeof frame.timeSeconds !== 'number' || !Number.isFinite(frame.timeSeconds) || frame.timeSeconds <= previous
        || frame.timeSeconds < 0 || frame.timeSeconds >= item.durationSeconds) return null
      if (hasGrid && (!validGrid(frame.grid, frame.timeSeconds, item.durationSeconds) || size > FRAMEWORK_MEDIA_SHEET_BYTES)) return null
      const times = hasGrid ? (frame.grid as FrameworkFrameGrid).times : [frame.timeSeconds]
      if (times[times.length - 1]! >= item.durationSeconds) return null
      previous = times[times.length - 1]!; sampled += times.length; bytes += size
    }
    if (sampled <= Math.min(gridded ? 24 : 6, Number(item.frameCount)) && bytes <= (gridded ? FRAMEWORK_MEDIA_SHEETS_BYTES : FRAMEWORK_MEDIA_ANIMATION_BYTES) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= FRAMEWORK_MEDIA_WIRE_BYTES)
      return value as NativeMediaReadEnvelope
  }
  if (item.kind === 'video' && keys === 'audioObserved,contentRead,coverage,durationSeconds,frames,hasAudio,kind,schema'
    && typeof item.durationSeconds === 'number' && Number.isFinite(item.durationSeconds) && item.durationSeconds > 0 && item.durationSeconds <= 600
    && item.audioObserved === false && typeof item.hasAudio === 'boolean' && item.coverage === 'sampled-frames-only'
    && Array.isArray(item.frames) && item.frames.length > 0 && item.frames.length <= 6) {
    let bytes = 0; let previous = -1; let sampled = 0; let gridded: boolean | undefined
    for (const value of item.frames) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const frame = value as Record<string, unknown>
      const size = frameworkImageBytes(frame.data)
      const hasGrid = Object.hasOwn(frame, 'grid')
      if (gridded !== undefined && gridded !== hasGrid) return null
      gridded = hasGrid
      if (Object.keys(frame).sort().join(',') !== (hasGrid ? 'data,grid,mediaType,timeSeconds' : 'data,mediaType,timeSeconds') || frame.mediaType !== 'image/jpeg' || size === null
        || typeof frame.timeSeconds !== 'number' || !Number.isFinite(frame.timeSeconds) || frame.timeSeconds < previous
        || frame.timeSeconds < 0 || frame.timeSeconds > item.durationSeconds) return null
      if (hasGrid && (!validGrid(frame.grid, frame.timeSeconds, item.durationSeconds) || size > FRAMEWORK_MEDIA_SHEET_BYTES)) return null
      const times = hasGrid ? (frame.grid as FrameworkFrameGrid).times : [frame.timeSeconds]
      if (hasGrid && frame.timeSeconds <= previous) return null
      previous = times[times.length - 1]!; sampled += times.length; bytes += size
    }
    if (sampled <= (gridded ? 24 : 6) && bytes <= (gridded ? FRAMEWORK_MEDIA_SHEETS_BYTES : FRAMEWORK_MEDIA_VIDEO_BYTES) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= FRAMEWORK_MEDIA_WIRE_BYTES)
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
