import { isAbsolute } from 'node:path'
import type { DeliveryReceipt } from '../core/types.ts'
import { isFileUploadReceipt } from '../core/delivery.ts'
import { isRecord, reference } from '../core/values.ts'
import { classifyOneBotResponse } from './onebot-response.ts'

export interface OneBotFileUploadRequest {
  readonly file: string
  readonly name: string
  readonly signal: AbortSignal
}
export interface OneBotFileUploadPort {
  uploadPrivate(request: OneBotFileUploadRequest & { readonly userId: string }): Promise<DeliveryReceipt>
  uploadGroup(request: OneBotFileUploadRequest & { readonly groupId: string }): Promise<DeliveryReceipt>
}

export function validOneBotUploadSource(file: unknown): file is string {
  if (typeof file !== 'string' || file.length < 1 || /[\x00-\x1f\x7f]/.test(file)) return false
  if (isAbsolute(file)) return file.length <= 4096
  if (!file.startsWith('base64://')) return false
  const data = file.slice(9)
  return data.length > 0 && data.length <= Math.ceil(8 * 1024 * 1024 / 3) * 4
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    && Buffer.byteLength(data, 'base64') <= 8 * 1024 * 1024 && Buffer.from(data, 'base64').toString('base64') === data
}

function waitFor<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/** The resolver supplies controlled bytes or a server-readable absolute path. */
export function createOneBotFileUploadPort(options: { readonly endpoint: string; readonly accessToken?: string;
  readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number }): OneBotFileUploadPort {
  const base = new URL(options.endpoint)
  if (!['http:', 'https:'].includes(base.protocol)) throw new TypeError('OneBot file uploads require HTTP or HTTPS.')
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  const timeoutMs = options.timeoutMs ?? 15000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('Invalid upload timeout.')
  const fetchImplementation = options.fetch ?? globalThis.fetch
  async function upload(action: 'upload_private_file' | 'upload_group_file', key: 'user_id' | 'group_id', id: string, request: OneBotFileUploadRequest): Promise<DeliveryReceipt> {
    if (!/^[1-9]\d{0,31}$/.test(id) || !Number.isSafeInteger(Number(id)) || !validOneBotUploadSource(request.file)
      || !reference(request.name) || /[/\\]/.test(request.name) || request.signal.aborted) return { status: 'rejected' }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
    const headers = new Headers({ 'content-type': 'application/json' })
    if (options.accessToken) headers.set('authorization', `Bearer ${options.accessToken}`)
    try {
      const response = await waitFor(fetchImplementation(new URL(action, base), { method: 'POST', headers, signal,
        body: JSON.stringify({ [key]: Number(id), file: request.file, name: request.name, upload_file: true }) }), signal)
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return { status: [401, 403].includes(response.status) ? 'rejected' : 'unknown' } }
      if (!response.body) return { status: 'unknown' }
      const reader = response.body.getReader()
      const chunks: Buffer[] = []
      let size = 0
      try {
        for (;;) {
          const part = await waitFor(reader.read(), signal)
          if (part.done) break
          signal.throwIfAborted(); size += part.value.length
          if (size > 65536) { void reader.cancel().catch(() => {}); return { status: 'unknown' } }
          chunks.push(Buffer.from(part.value))
        }
      } catch (error) { void reader.cancel().catch(() => {}); throw error } finally { reader.releaseLock() }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const state = classifyOneBotResponse(value)
      if (state !== 'confirmed') return { status: state }
      const receipt = { status: 'confirmed', kind: 'file-upload', fileId: isRecord(value) && isRecord(value.data) ? value.data.file_id : null, name: request.name }
      return isFileUploadReceipt(receipt) ? receipt : { status: 'unknown' }
    } catch { return { status: 'unknown' } }
  }
  return Object.freeze<OneBotFileUploadPort>({ uploadPrivate: request => upload('upload_private_file', 'user_id', request.userId, request),
    uploadGroup: request => upload('upload_group_file', 'group_id', request.groupId, request) })
}
