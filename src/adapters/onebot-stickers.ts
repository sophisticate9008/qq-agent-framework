import { createHash } from 'node:crypto';
import { isRecord } from '../core/values.ts';
import type { OneBotReadResult } from './onebot-actions.ts';
import { classifyOneBotResponse } from './onebot-response.ts';

export interface OneBotSticker {
  readonly id: string;
  readonly url: string;
  readonly name?: string;
}
export interface OneBotStickerPort {
  list(request: { readonly limit: number; readonly signal: AbortSignal }): Promise<OneBotReadResult<{
    readonly items: readonly OneBotSticker[]; readonly limited: boolean;
  }>>;
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}
function decode(value: unknown, limit: number): { items: readonly OneBotSticker[]; limited: boolean } | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const items: OneBotSticker[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const url = boundedText(entry.url, 4096);
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return null;
    } catch { return null; }
    const rawId = entry.emoji_id ?? entry.emojiId ?? entry.resId ?? entry.id ?? entry.md5;
    const id = boundedText(typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId, 512)
      ?? createHash('sha256').update(url).digest('hex');
    if (seen.has(id)) continue;
    seen.add(id);
    const name = boundedText(entry.desc ?? entry.name, 255);
    items.push({ id, url, ...(name === null ? {} : { name }) });
  }
  return { items: items.slice(0, limit), limited: value.length >= limit };
}

/** Trusted read-only NapCat/SnowLuma extension. Returned URLs remain host-private protocol facts. */
export function createOneBotStickerPort(options: {
  readonly endpoint: string; readonly accessToken?: string; readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number;
}): OneBotStickerPort {
  const base = new URL(options.endpoint.endsWith('/') ? options.endpoint : `${options.endpoint}/`);
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || /[\s\\?#]/.test(options.endpoint) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || options.accessToken !== undefined && !/^[\x21-\x7e]{1,4096}$/.test(options.accessToken)) {
    throw new TypeError('Invalid OneBot sticker port configuration.');
  }
  return Object.freeze<OneBotStickerPort>({
    async list(request) {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 500)
        return { status: 'rejected', code: 'ONEBOT_STICKER_INVALID_INPUT' };
      if (request.signal.aborted) return { status: 'rejected', code: 'ONEBOT_STICKER_CANCELLED' };
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
      try {
        const response = await (options.fetch ?? globalThis.fetch)(new URL('fetch_custom_face_detail', base), {
          method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json',
            ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}) },
          body: JSON.stringify({ count: request.limit }), signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          return { status: response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown',
            code: response.status === 404 ? 'ONEBOT_STICKER_UNSUPPORTED' : 'ONEBOT_STICKER_HTTP_FAILED' };
        }
        const reader = response.body?.getReader();
        if (!reader) return { status: 'unknown', code: 'ONEBOT_STICKER_INVALID_RESPONSE' };
        let body: unknown;
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 1024 * 1024) return { status: 'unknown', code: 'ONEBOT_STICKER_RESPONSE_TOO_LARGE' };
            chunks.push(part.value);
          }
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        const status = classifyOneBotResponse(body);
        if (status !== 'confirmed') return { status, code: 'ONEBOT_STICKER_NOT_CONFIRMED' };
        const data = decode(isRecord(body) ? body.data : undefined, request.limit);
        return data === null ? { status: 'unknown', code: 'ONEBOT_STICKER_INVALID_RESPONSE' } : { status: 'confirmed', data };
      } catch { return { status: 'unknown', code: signal.aborted ? 'ONEBOT_STICKER_ABORTED_UNKNOWN' : 'ONEBOT_STICKER_TRANSPORT_UNKNOWN' }; }
    },
  });
}
