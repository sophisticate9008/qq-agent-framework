import type { FrameworkImageMediaType } from '../contracts/framework-media.ts'
import type { DshPromptRequest } from './dsh.ts'

/** DSH SDK PromptContentPart fields; asset handles are resolved by the scoped host. */
export type DshPromptContent = { type: 'text'; text: string }
  | { type: 'image'; mediaType: FrameworkImageMediaType; data: string }

export type DshPromptImageResolver = (request: {
  readonly sessionId: string; readonly assetId: string; readonly signal: AbortSignal
}) => Promise<{ readonly mediaType: FrameworkImageMediaType; readonly data: string } | null>

const maxImageBytes = 160 * 1024
const maxContentBytes = 960 * 1024

function validImage(value: unknown): value is { mediaType: FrameworkImageMediaType; data: string } {
  if (!value || typeof value !== 'object') return false
  const image = value as Record<string, unknown>
  if (typeof image.mediaType !== 'string' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType)
    || typeof image.data !== 'string' || image.data.length < 4 || image.data.length > 4 * Math.ceil(maxImageBytes / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) return false
  const bytes = Buffer.from(image.data, 'base64')
  return bytes.length > 0 && bytes.length <= maxImageBytes && bytes.toString('base64') === image.data
}

async function withSignal<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  let abort: (() => void) | undefined
  try {
    return await new Promise<Value>((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      operation.then(resolve, reject)
      if (signal.aborted) abort()
    })
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
  }
}

/** Prepare before starting the RPC timeout; cancellation and authorization failures propagate. */
export async function prepareDshPromptContent(request: DshPromptRequest,
  resolveImage?: DshPromptImageResolver): Promise<DshPromptContent[] | null> {
  request.signal.throwIfAborted()
  if (!Array.isArray(request.content) || request.content.length === 0 || request.content.length > 12) return null
  const parts: ({ type: 'text'; text: string } | { type: 'image'; assetId: string })[] = []
  const assets = new Set<string>()
  let textCount = 0
  for (const part of request.content) {
    if (!part || typeof part !== 'object') return null
    if (part.type === 'text') {
      if (typeof part.text !== 'string' || part.text.length > 8_000 || part.text.length === 0 || ++textCount > 8) return null
      parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'image') {
      if (typeof part.assetId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(part.assetId)) return null
      if (!assets.has(part.assetId)) {
        assets.add(part.assetId)
        if (assets.size > 4) return null
        parts.push({ type: 'image', assetId: part.assetId })
      }
    } else return null
  }
  if (textCount === 0 || !parts.some(part => part.type === 'text' && part.text.trim().length > 0)) return null
  const resolved = new Map<string, Awaited<ReturnType<DshPromptImageResolver>>>()
  if (resolveImage) {
    const images = await withSignal(Promise.all([...assets].map(async assetId => ({ assetId,
      image: await resolveImage({ sessionId: request.sessionId, assetId, signal: request.signal }) }))), request.signal)
    request.signal.throwIfAborted()
    for (const { assetId, image } of images) {
      if (image !== null && !validImage(image)) return null
      resolved.set(assetId, image)
    }
  }
  const content: DshPromptContent[] = []
  const attached: string[] = []
  for (const part of parts) {
    if (part.type === 'text') content.push(part)
    else {
      const image = resolved.get(part.assetId)
      if (image) {
        content.push({ type: 'image', mediaType: image.mediaType, data: image.data })
        attached.push(part.assetId)
      }
    }
  }
  // Keep every original text part unchanged; one supplemental part labels all attachments.
  if (attached.length > 0) content.push({ type: 'text', text: `图片 ${attached.join('、')} 已作为附件提供，可直接查看。` })
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > maxContentBytes) return null
  request.signal.throwIfAborted()
  return content
}
