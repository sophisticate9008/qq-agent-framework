import { lookup } from 'node:dns/promises'
import { request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'
import { isIP } from 'node:net'
import type { OneBotActionPort } from './onebot-actions.ts'

export type OneBotMediaBytesResult = { readonly status: 'confirmed'; readonly data: Uint8Array; readonly mediaType: string | null; readonly name?: string }
  | { readonly status: 'rejected' | 'unknown'; readonly code: string }
export interface OneBotMediaByteRequest {
  readonly kind: 'image' | 'audio' | 'file'
  readonly conversationId?: string
  readonly source: { readonly file?: string; readonly id?: string; readonly busId?: number; readonly fileHash?: string }
  readonly signal: AbortSignal
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number)
    return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && (b === 0 || b === 168 || b === 88 && c === 99)) && !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
      && !(a === 203 && b === 0 && c === 113)
  }
  const second = Number.parseInt(address.split(':')[1] ?? '0', 16)
  return isIP(address) === 6 && /^[23][a-f0-9]{3}:/i.test(address)
    && !(/^2001:/i.test(address) && (second < 0x200 || second === 0xdb8)) && !/^2002:/i.test(address)
}
function waitFor<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/** Read only URLs returned by fixed OneBot read actions; no caller URL, path or redirect surface. */
export function createOneBotMediaReader(options: { readonly actions: OneBotActionPort; readonly trustedOrigins?: readonly string[];
  readonly timeoutMs?: number; readonly maxBytes?: number }) {
  const timeoutMs = options.timeoutMs ?? 10000
  const maxBytes = options.maxBytes ?? 1024 * 1024
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new TypeError('Invalid OneBot media read bounds.')
  const trusted = new Set(options.trustedOrigins ?? [])
  for (const origin of trusted) {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new TypeError('Invalid trusted media origin.')
  }
  async function download(url: URL, signal: AbortSignal): Promise<{ data: Uint8Array; mediaType: string | null }> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const records = await waitFor(lookup(hostname, { all: true, verbatim: true }), signal)
    if (records.length === 0 || !trusted.has(url.origin) && (records.some(item => !publicAddress(item.address))
      || url.port !== '' && url.port !== (url.protocol === 'https:' ? '443' : '80'))) throw new TypeError('Media origin is outside its permitted network scope.')
    signal.throwIfAborted()
    const selected = records[0]!
    return new Promise((resolve, reject) => {
      const invoke = url.protocol === 'https:' ? requestHttps : requestHttp
      const connection = invoke({ protocol: url.protocol, hostname: selected.address, family: selected.family, port: url.port || undefined,
        servername: hostname, path: `${url.pathname}${url.search}`, method: 'GET', headers: { host: url.host, accept: '*/*', 'accept-encoding': 'identity' }, agent: false, signal }, response => {
        if (response.statusCode !== 200 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity'
          || response.headers['content-length'] !== undefined && (!/^\d+$/.test(response.headers['content-length']) || Number(response.headers['content-length']) > maxBytes)) {
          response.destroy(); reject(new TypeError('Media response is unavailable or exceeds its byte bound.')); return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) { response.destroy(new TypeError('Media exceeds its byte bound.')); return }
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('aborted', () => reject(new TypeError('Media response was interrupted.')))
        response.on('end', () => {
          if (size < 1) { reject(new TypeError('Media is empty.')); return }
          const type = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? null
          resolve({ data: Buffer.concat(chunks), mediaType: type && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : null })
        })
      })
      connection.on('error', reject)
      connection.end()
    })
  }
  return Object.freeze({
    async read(request: OneBotMediaByteRequest): Promise<OneBotMediaBytesResult> {
      if (request.signal.aborted) return { status: 'rejected', code: 'ONEBOT_MEDIA_CANCELLED' }
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
      try {
        const pointer = request.kind === 'file' ? request.source.id : request.source.file
        if (!pointer) return { status: 'rejected', code: 'ONEBOT_MEDIA_SOURCE_UNAVAILABLE' }
        const target = /^(group|private):([1-9]\d{0,31})$/.exec(request.conversationId ?? '')
        const file = target?.[1] === 'group' && options.actions.getGroupFile
          ? () => options.actions.getGroupFile!({ groupId: target[2]!, fileId: pointer, ...(request.source.busId === undefined ? {} : { busId: request.source.busId }), signal })
          : target?.[1] === 'private' && options.actions.getPrivateFile
            ? () => options.actions.getPrivateFile!({ userId: target[2]!, fileId: pointer, ...(request.source.fileHash === undefined ? {} : { fileHash: request.source.fileHash }), signal })
            : () => options.actions.getFile({ fileId: pointer, signal })
        const info = await waitFor(request.kind === 'image' ? options.actions.getImage({ file: pointer, signal })
          : request.kind === 'audio' ? options.actions.getRecord({ file: pointer, signal })
            : file(), signal)
        if (info.status !== 'confirmed') return info
        if (!info.data.url) return { status: 'rejected', code: 'ONEBOT_MEDIA_URL_UNAVAILABLE' }
        const url = new URL(info.data.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return { status: 'rejected', code: 'ONEBOT_MEDIA_URL_REJECTED' }
        const bytes = await download(url, signal)
        return { status: 'confirmed', ...bytes, ...(info.data.name === undefined ? {} : { name: info.data.name }) }
      } catch { return { status: 'unknown', code: signal.aborted ? 'ONEBOT_MEDIA_TIMEOUT_UNKNOWN' : 'ONEBOT_MEDIA_READ_UNKNOWN' } }
    }
  })
}
