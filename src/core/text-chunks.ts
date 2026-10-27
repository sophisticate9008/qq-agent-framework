/** Split without losing code units or separating a valid Unicode surrogate pair. */
export function boundedTextChunks(text: string, size: number, maximum: number): readonly string[] | null {
  if (!Number.isSafeInteger(size) || size < 2 || !Number.isSafeInteger(maximum) || maximum < 1
    || text.length > size * maximum) return null
  const chunks: string[] = []
  let offset = 0
  while (offset < text.length) {
    if (chunks.length >= maximum) return null
    let end = Math.min(text.length, offset + size)
    const last = text.charCodeAt(end - 1)
    const next = text.charCodeAt(end)
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
    chunks.push(text.slice(offset, end))
    offset = end
  }
  return chunks
}
