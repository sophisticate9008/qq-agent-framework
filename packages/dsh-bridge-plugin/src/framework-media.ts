import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
const imageBytes = 384 * 1024 - 1024
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid media result')
  return value as Record<string, unknown>
}

export function validateFrameworkContent(value: unknown): void {
  if (!Array.isArray(value) || value.length > 8 || Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) throw new TypeError('Invalid media result')
  let imageCount = 0
  let textCount = 0
  let totalImageBytes = 0
  for (const raw of value) {
    const item = object(raw)
    if (item.type === 'text' && Object.keys(item).sort().join(',') === 'text,type'
      && typeof item.text === 'string' && item.text.length <= 16000) { textCount++; continue }
    if (item.type !== 'image' || Object.keys(item).sort().join(',') !== 'data,mediaType,type'
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(item.mediaType))
      || typeof item.data !== 'string' || item.data.length > 4 * Math.ceil(imageBytes / 3)
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)) throw new TypeError('Invalid image result')
    const bytes = Buffer.from(item.data, 'base64')
    if (!bytes.length || bytes.length > imageBytes || bytes.toString('base64') !== item.data) throw new TypeError('Invalid image encoding')
    imageCount++; totalImageBytes += bytes.length
  }
  if (imageCount > 1 && (imageCount > 6 || textCount > 1 || totalImageBytes > 360 * 1024)) throw new TypeError('Video frames exceed the aggregate media limit')
}

/** Save encoded owner content as real SDK attachments; never render Base64 as text. */
export async function materializeFrameworkMedia(agent: Agent, value: JsonValue, content: unknown, signal: AbortSignal): Promise<{
  value: JsonValue; rendered: JsonValue[]
}> {
  validateFrameworkContent(content)
  const parts = content as ({type:'text';text:string} | {type:'image';mediaType:'image/png'|'image/jpeg'|'image/webp'|'image/gif';data:string})[]
  const image = parts.some(part => part.type === 'image')
  const attachments = image ? agent.ctx.get('attachments') : undefined
  const latest = [...agent.session.snapshotEvents()].reverse().find(event => event.type === 'request/header')
  const config = latest?.data.header.config
  if (image) {
    const provider = config?.provider
    const model = config?.model
    let available = false
    if (typeof provider === 'string' && typeof model === 'string') {
      try { available = (await agent.ctx.llm.resolveModelInfo(provider, model, signal)).inputModalities?.includes('image') === true } catch {}
    }
    signal.throwIfAborted()
    const now = [...agent.session.snapshotEvents()].reverse().find(event => event.type === 'request/header')
    if (now !== latest || !available || !attachments) {
      const original = value && typeof value === 'object' && !Array.isArray(value) ? value : { value }
      return { value: { ...original, contentRead: false, reason: !available ? 'model_image_input_unavailable' : 'image_admission_unavailable' }, rendered: [] }
    }
  }
  // The SDK validates the complete ordered batch before publishing references.
  const encodedImages = parts.filter(part => part.type === 'image')
  const inputs = encodedImages.map(part => ({ data: Buffer.from(part.data, 'base64'), mediaType: part.mediaType }))
  const imageRefs = attachments && inputs.length ? inputs.length === 1
    ? [await attachments.saveImage(inputs[0]!)] : await attachments.saveImages(inputs) : []
  signal.throwIfAborted()
  let imageIndex = 0
  const rendered: JsonValue[] = []
  for (const part of parts) {
    signal.throwIfAborted()
    if (part.type === 'text') { rendered.push({ type: 'text', text: part.text }); continue }
    // Agent scopes do not inject optional attachment storage. Use the resolved service.
    if (!attachments) throw new TypeError('Image attachment storage is unavailable')
    const attachment = imageRefs[imageIndex++]
    if (!attachment) throw new TypeError('Image attachment batch is incomplete')
    signal.throwIfAborted()
    rendered.push({ type: 'image', attachment: JSON.parse(JSON.stringify(attachment)) as JsonValue })
  }
  return { value, rendered }
}

/** Canonical persisted references are replayable; no lookup or download occurs here. */
export function renderFrameworkMedia(value: unknown): ContentBlock[] {
  const result = object(value)
  const rendered = result.rendered
  if (rendered === undefined) return []
  if (!Array.isArray(rendered) || rendered.length > 8) throw new TypeError('Invalid canonical media')
  const images = rendered.filter(item => item && typeof item === 'object' && 'type' in item && item.type === 'image')
  if (images.length > 1 && (images.length > 6 || rendered.length - images.length > 1
    || images.reduce((sum, raw) => sum + Number(object(object(raw).attachment).bytes), 0) > 360 * 1024)) throw new TypeError('Invalid canonical video frames')
  return rendered.map(raw => {
    const item = object(raw)
    if (item.type === 'text' && typeof item.text === 'string') return { type: 'text' as const, text: item.text }
    const attachment = object(item.attachment)
    if (item.type !== 'image' || typeof attachment.attachmentId !== 'string' || typeof attachment.bytes !== 'number'
      || typeof attachment.width !== 'number' || typeof attachment.height !== 'number'
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(attachment.mediaType))) throw new TypeError('Invalid canonical image')
    return { type: 'image' as const, attachment: { attachmentId: AttachmentId(attachment.attachmentId), bytes: attachment.bytes,
      width: attachment.width, height: attachment.height, mediaType: attachment.mediaType as 'image/png'|'image/jpeg'|'image/webp'|'image/gif' } }
  })
}
