export type NativeMediaConfiguration = { readonly schema: 1; readonly observeVideo: boolean }
export const DEFAULT_NATIVE_MEDIA_CONFIGURATION: NativeMediaConfiguration = Object.freeze({ schema: 1, observeVideo: false })
export function validateNativeMediaConfiguration(value: unknown): NativeMediaConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid media configuration')
  const input = value as Record<string, unknown>
  if (Object.keys(input).sort().join(',') !== 'observeVideo,schema' || input.schema !== 1 || typeof input.observeVideo !== 'boolean')
    throw new TypeError('Invalid media configuration')
  return { schema: 1, observeVideo: input.observeVideo }
}
