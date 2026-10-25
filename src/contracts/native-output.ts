export type NativeOutputConfiguration = {
  readonly schema: 1
  readonly bubbles: boolean
  readonly longTextAsForward: boolean
  readonly longTextThreshold: number
  readonly media: boolean
}
export const DEFAULT_NATIVE_OUTPUT: NativeOutputConfiguration = Object.freeze({ schema: 1, bubbles: true,
  longTextAsForward: false, longTextThreshold: 3500, media: true })
export function validateNativeOutputConfiguration(value: unknown): NativeOutputConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid output configuration')
  const input = value as Record<string, unknown>
  if (Object.keys(input).sort().join(',') !== 'bubbles,longTextAsForward,longTextThreshold,media,schema'
    || input.schema !== 1 || typeof input.bubbles !== 'boolean' || typeof input.longTextAsForward !== 'boolean'
    || typeof input.media !== 'boolean' || typeof input.longTextThreshold !== 'number' || !Number.isSafeInteger(input.longTextThreshold)
    || input.longTextThreshold < 500 || input.longTextThreshold > 16000) throw new TypeError('Invalid output configuration')
  return { schema: 1, bubbles: input.bubbles, longTextAsForward: input.longTextAsForward,
    longTextThreshold: input.longTextThreshold, media: input.media }
}
