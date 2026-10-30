export type MediaObservationVersion = 'v1' | 'v2'
export type NativeMediaConfiguration = { readonly schema: 1; readonly observeVideo: boolean; readonly observationVersion: MediaObservationVersion }
export const DEFAULT_NATIVE_MEDIA_CONFIGURATION: NativeMediaConfiguration = Object.freeze({ schema: 1, observeVideo: false, observationVersion: 'v1' })
export function validateNativeMediaConfiguration(value: unknown): NativeMediaConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid media configuration')
  const input = value as Record<string, unknown>
  if (!['observeVideo,schema', 'observationVersion,observeVideo,schema'].includes(Object.keys(input).sort().join(','))
    || input.schema !== 1 || typeof input.observeVideo !== 'boolean'
    || input.observationVersion !== undefined && input.observationVersion !== 'v1' && input.observationVersion !== 'v2')
    throw new TypeError('Invalid media configuration')
  return { schema: 1, observeVideo: input.observeVideo, observationVersion: input.observationVersion ?? 'v1' }
}
