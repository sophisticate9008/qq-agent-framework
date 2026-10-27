export type NativeOutputConfiguration = {
  readonly schema: 1
  readonly bubbles: boolean
  readonly longTextAsForward: boolean
  readonly longTextThreshold: number
}
export const DEFAULT_NATIVE_OUTPUT: NativeOutputConfiguration = Object.freeze({ schema: 1, bubbles: true,
  longTextAsForward: false, longTextThreshold: 3500 })
export function validateNativeOutputConfiguration(value: unknown): NativeOutputConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid output configuration')
  const input = value as Record<string, unknown>
  // The former media switch remains readable in schema 1, but is no longer an output restriction.
  if (!['bubbles,longTextAsForward,longTextThreshold,schema', 'bubbles,longTextAsForward,longTextThreshold,media,schema'].includes(Object.keys(input).sort().join(','))
    || input.schema !== 1 || typeof input.bubbles !== 'boolean' || typeof input.longTextAsForward !== 'boolean'
    || Object.hasOwn(input, 'media') && typeof input.media !== 'boolean'
    || typeof input.longTextThreshold !== 'number' || !Number.isSafeInteger(input.longTextThreshold)
    || input.longTextThreshold < 500 || input.longTextThreshold > 16000) throw new TypeError('Invalid output configuration')
  return { schema: 1, bubbles: input.bubbles, longTextAsForward: input.longTextAsForward,
    longTextThreshold: input.longTextThreshold }
}
