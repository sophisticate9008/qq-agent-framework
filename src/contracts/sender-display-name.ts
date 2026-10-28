/** Sender-controlled display text. It never proves identity, ownership, or authorization. */
export function normalizeSenderDisplayName(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const value = input.trim()
  if (!value || /[\x00-\x1f\x7f\u2028\u2029]/u.test(value)) return undefined
  let bounded = value.slice(0, 128)
  // Preserve valid Unicode when the bound falls inside an astral character.
  if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1)
  return bounded || undefined
}
