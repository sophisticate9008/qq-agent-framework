import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export interface WorkMediaReference {
  readonly type: 'media-reference'
  readonly kind: 'image' | 'file'
  readonly attachmentId: string
  readonly bytes: number
  readonly name?: string
  readonly mediaType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly width?: number
  readonly height?: number
}
export type WorkOutput = { readonly type: 'text'; readonly text: string } | WorkMediaReference

export function validWorkOutput(value: unknown): value is WorkOutput {
  if (!value || typeof value !== 'object' || !('type' in value)) return false
  const block = value as Record<string, unknown>
  if (block.type === 'text') return Object.keys(block).sort().join(',') === 'text,type' && typeof block.text === 'string'
  if (block.type !== 'media-reference' || !['image', 'file'].includes(String(block.kind))
    || Object.keys(block).some(key => !['type', 'kind', 'attachmentId', 'bytes', 'name', 'mediaType', 'width', 'height'].includes(key))
    || typeof block.attachmentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(block.attachmentId)
    || !Number.isSafeInteger(block.bytes) || Number(block.bytes) < 1 || Number(block.bytes) > 8 * 1024 * 1024
    || block.name !== undefined && (typeof block.name !== 'string' || block.name.length < 1 || block.name.length > 160 || /[/\\\p{Cc}]/u.test(block.name))) return false
  return block.kind === 'file'
    ? typeof block.name === 'string' && block.mediaType === undefined && block.width === undefined && block.height === undefined
    : ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(block.mediaType))
      && Number.isSafeInteger(block.width) && Number(block.width) >= 1 && Number(block.width) <= 32768
      && Number.isSafeInteger(block.height) && Number(block.height) >= 1 && Number(block.height) <= 32768
}

/** Project only displayable SDK blocks; reasoning stays outside user delivery. */
export function normalizeWorkOutput(output: readonly ContentBlock[]): readonly WorkOutput[] {
  const result: WorkOutput[] = []
  for (const block of output) {
    if (block.type === 'reasoning') continue
    if (block.type === 'text') { result.push({ type: 'text', text: block.text }); continue }
    if (block.type !== 'image' && block.type !== 'file') throw new TypeError('Unsupported work output')
    const attachment = block.attachment
    const media: WorkMediaReference = block.type === 'image'
      ? { type: 'media-reference', kind: 'image', attachmentId: attachment.attachmentId, bytes: attachment.bytes,
        ...('name' in attachment && attachment.name !== undefined ? { name: attachment.name } : {}),
        mediaType: block.attachment.mediaType, width: block.attachment.width, height: block.attachment.height }
      : { type: 'media-reference', kind: 'file', attachmentId: attachment.attachmentId, bytes: attachment.bytes, name: block.attachment.name }
    if (!validWorkOutput(media)) throw new TypeError('Unsupported work attachment')
    result.push(media)
  }
  if (result.length > 256 || Buffer.byteLength(JSON.stringify(result)) > 262144) throw new TypeError('Work output exceeds retention bounds')
  return result
}
