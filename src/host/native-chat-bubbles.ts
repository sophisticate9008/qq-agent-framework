import type { MessageContent } from '../core/types.ts'

export function splitNativeChatBubbles(content: readonly MessageContent[]): readonly (readonly MessageContent[])[] {
  if (content.some(part => part.type !== 'text')) return [content]
  const text = content.map(part => part.type === 'text' ? part.text : '').join('')
  if (text.length > 480 || /[`|]|~~~|!?\[[^\]\n]*\]\(/.test(text)
    || /^(?: {4}|\t)[ \t]*\S/m.test(text)) return [content]
  const body = text.replace(/\r\n?/g, '\n').trim()
  if (/^[ \t]*(?:#{1,6}(?:[ \t]|$)|>|[-+*][ \t]+|\d+[.)][ \t]+|[\[{]|(?:-{3,}|\*{3,}|_{3,})[ \t]*(?:\n|$))/m.test(body)) return [content]
  const paragraphs = body.split(/\n[ \t]*\n(?:[ \t]*\n)*/).map(paragraph => paragraph.trim())
  if (paragraphs.length < 2 || paragraphs.length > 4
    || paragraphs.some(paragraph => paragraph.length === 0 || paragraph.length > 120)) return [content]
  return paragraphs.map(paragraph => [{ type: 'text' as const, text: paragraph }])
}
