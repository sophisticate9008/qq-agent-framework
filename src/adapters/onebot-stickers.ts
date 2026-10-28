import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../core/values.ts';
import type { JsonObject } from '../core/types.ts';
import type { OneBotReadResult } from './onebot-actions.ts';
import { classifyOneBotResponse } from './onebot-response.ts';

export interface OneBotSticker {
  readonly id: string;
  /** Real protocol resource identifier. Missing identifiers cannot be used for writes. */
  readonly stickerId?: string;
  readonly emojiId?: string;
  readonly md5?: string;
  readonly url: string;
  readonly name?: string;
}
type StickerReceipt = OneBotReadResult<{ readonly acknowledged: true }>;
export interface OneBotStickerPort {
  list(request: { readonly limit: number; readonly signal: AbortSignal }): Promise<OneBotReadResult<{
    readonly items: readonly OneBotSticker[]; readonly limited: boolean;
  }>>;
  add?(request: { readonly file: string; readonly signal: AbortSignal }): Promise<StickerReceipt>;
  delete?(request: { readonly stickerId: string; readonly signal: AbortSignal }): Promise<StickerReceipt>;
  describe?(request: { readonly stickerId: string; readonly emojiId: string; readonly md5: string; readonly description: string;
    readonly signal: AbortSignal }): Promise<StickerReceipt>;
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
    const stickerId = boundedText(entry.resId ?? entry.res_id, 512);
    const rawEmojiId = entry.emojiId ?? entry.emoji_id;
    const emojiId = boundedText(typeof rawEmojiId === 'number' && Number.isSafeInteger(rawEmojiId) ? String(rawEmojiId) : rawEmojiId, 32);
    const md5 = typeof entry.md5 === 'string' && /^[a-fA-F0-9]{32}$/.test(entry.md5) ? entry.md5 : undefined;
    const rawId = entry.emoji_id ?? entry.emojiId ?? entry.resId ?? entry.id ?? entry.md5;
    const id = stickerId ?? boundedText(typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId, 512)
      ?? createHash('sha256').update(url).digest('hex');
    if (seen.has(id)) continue;
    seen.add(id);
    const name = boundedText(entry.desc ?? entry.name, 255);
    items.push({ id, url, ...(stickerId === null ? {} : { stickerId }),
      ...(emojiId !== null && /^(0|[1-9]\d{0,15})$/.test(emojiId) && Number.isSafeInteger(Number(emojiId)) ? { emojiId } : {}),
      ...(md5 ? { md5 } : {}), ...(name === null ? {} : { name }) });
  }
  return { items: items.slice(0, limit), limited: value.length >= limit };
}

/** Acknowledgements must not conceal a native operation's explicit failure. */
function acknowledged(value: unknown): { readonly acknowledged: true } | null {
  if (value === false || isRecord(value) && (value.result === false
    || typeof value.result === 'number' && value.result !== 0)) return null;
  return { acknowledged: true };
}

function imageExtension(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/** Fixed QQ collection operations. Only scoped host resolutions may supply image files. */
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
  async function invoke<Value>(action: string, input: JsonObject, signal: AbortSignal,
    decodeData: (value: unknown) => Value | null): Promise<OneBotReadResult<Value>> {
    if (signal.aborted) return { status: 'rejected', code: 'ONEBOT_STICKER_CANCELLED' };
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(new URL(action, base), {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json',
          ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}) },
        body: JSON.stringify(input), signal: combined,
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
      const data = decodeData(isRecord(body) ? body.data : undefined);
      return data === null ? { status: 'unknown', code: 'ONEBOT_STICKER_INVALID_RESPONSE' } : { status: 'confirmed', data };
    } catch { return { status: 'unknown', code: combined.aborted ? 'ONEBOT_STICKER_ABORTED_UNKNOWN' : 'ONEBOT_STICKER_TRANSPORT_UNKNOWN' }; }
  }
  return Object.freeze<OneBotStickerPort>({
    async list(request) {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 500)
        return { status: 'rejected', code: 'ONEBOT_STICKER_INVALID_INPUT' };
      return invoke('fetch_custom_face_detail', { count: request.limit }, request.signal, value => decode(value, request.limit));
    },
    async add(request) {
      // NapCat's add_custom_face calls stat/readFile itself, so the protocol must share this host filesystem.
      if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
        return { status: 'rejected', code: 'ONEBOT_STICKER_ADD_REQUIRES_LOCAL_PROTOCOL' };
      if (request.signal.aborted) return { status: 'rejected', code: 'ONEBOT_STICKER_CANCELLED' };
      const limit = 8 * 1024 * 1024;
      let directory: string | undefined;
      try {
        let bytes: Buffer;
        if (request.file.startsWith('base64://')) {
          const encoded = request.file.slice(9);
          if (encoded.length > Math.ceil(limit / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
            return { status: 'rejected', code: 'ONEBOT_STICKER_INVALID_IMAGE' };
          bytes = Buffer.from(encoded, 'base64');
        } else {
          const path = request.file.startsWith('file:') ? fileURLToPath(request.file) : request.file;
          if (!isAbsolute(path)) return { status: 'rejected', code: 'ONEBOT_STICKER_ADD_SOURCE_UNSUPPORTED' };
          const info = await stat(path);
          if (!info.isFile() || info.size < 1 || info.size > limit) return { status: 'rejected', code: 'ONEBOT_STICKER_INVALID_IMAGE' };
          bytes = await readFile(path, { signal: request.signal });
        }
        if (!bytes.byteLength || bytes.byteLength > limit) return { status: 'rejected', code: 'ONEBOT_STICKER_INVALID_IMAGE' };
        const extension = imageExtension(bytes);
        if (!extension) return { status: 'rejected', code: 'ONEBOT_STICKER_INVALID_IMAGE' };
        request.signal.throwIfAborted();
        directory = await mkdtemp(join(tmpdir(), 'qaf-sticker-'));
        const file = join(directory, `image.${extension}`);
        await writeFile(file, bytes, { mode: 0o600, signal: request.signal });
        return await invoke('add_custom_face', { file, is_origin: true }, request.signal, acknowledged);
      } catch { return { status: 'rejected', code: 'ONEBOT_STICKER_ADD_SOURCE_UNAVAILABLE' }; }
      finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
    },
    async delete(request) {
      if (!boundedText(request.stickerId, 512)) return { status: 'rejected', code: 'ONEBOT_STICKER_INVALID_INPUT' };
      return invoke('delete_custom_face', { res_id: request.stickerId }, request.signal, acknowledged);
    },
    async describe(request) {
      if (!boundedText(request.stickerId, 512) || !/^(0|[1-9]\d{0,15})$/.test(request.emojiId)
        || !Number.isSafeInteger(Number(request.emojiId)) || !/^[a-fA-F0-9]{32}$/.test(request.md5)
        || typeof request.description !== 'string' || request.description.length > 255 || /[\x00-\x1f\x7f]/.test(request.description))
        return { status: 'rejected', code: 'ONEBOT_STICKER_INVALID_INPUT' };
      return invoke('set_custom_face_desc', { res_id: request.stickerId, emoji_id: request.emojiId,
        md5: request.md5, desc: request.description }, request.signal, acknowledged);
    },
  });
}
