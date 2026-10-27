import { normalizeContent } from '../core/content.ts'
import { boundedTextChunks } from '../core/text-chunks.ts'
import { FrameworkError } from '../core/values.ts'
import type { MessageContent } from '../core/types.ts'

/** Preserve final Markdown, code and control-envelope text within the existing message budget. */
export function normalizeDshOutputText(content: readonly { readonly type: 'text'; readonly text: string }[]): readonly MessageContent[] {
  const limit = () => { throw new FrameworkError('DSH_OUTPUT_LIMIT', 'The final model reply exceeds the supported output size.') }
  if (content.length > 256 || content.some(part => part.text.length > 65536)
    || content.reduce((length, part) => length + part.text.length, 0) > 65536) return limit()
  const text = content.map(part => part.text).join('')
  if (Buffer.byteLength(text, 'utf8') > 65536) return limit()
  const blocks: { type: 'text'; text: string }[] = []
  for (const part of content) {
    const chunks = boundedTextChunks(part.text, 8000, 8 - blocks.length)
    if (!chunks) return limit()
    blocks.push(...chunks.map(value => ({ type: 'text' as const, text: value })))
  }
  if (Buffer.byteLength(JSON.stringify(blocks), 'utf8') > 65536) return limit()
  return normalizeContent(blocks)
}
